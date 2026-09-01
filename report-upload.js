#!/usr/bin/env node
/**
 * 冒烟测试报告上传脚本（零依赖，Node 原生 http/https）
 *
 * 用途：run-smoke-test 执行结束后，把本次运行目录 out/<时间戳>/ 下的
 *       汇总报告 + 模块报告 + 证据（截图/录屏/日志）上传到 smoke-ui 服务器，
 *       并回写每条用例的最近测试结果。
 *
 * 用法：
 *   node report-upload.js <runDir> [--url http://host:port] [--no-writeback] [--dry-run]
 *
 * 参数：
 *   <runDir>       本次运行目录，如 out/20260812_153000/（runId 取目录名）
 *   --url          服务器地址，默认取环境变量 SMOKE_UI_URL，再退到 http://127.0.0.1:8899
 *   --no-writeback 只上传报告，不回写用例测试结果
 *   --dry-run      只打印将执行的动作，不真正上传/回写
 *
 * 依赖 runDir/summary.json（run-smoke-test 第七步产出，见 SKILL.md）：
 *   {
 *     "schemaVersion": 1,
 *     "runId": "20260812_153000",
 *     "executedAt": "2026-08-12T15:30:00+08:00",
 *     "module": "朋友圈",
 *     "project": "718",
 *     "device": "...", "agentDeviceVersion": "...",
 *     "total": 10, "passed": 3, "failed": 1, "interrupted": 0,
 *     "partial": 3, "notExecuted": 3, "passRate": 0.3,
 *     "results": [ { "no":"01","caseNo":"001","moduleCode":"CNT_FRIEND",
 *                    "project":"718","title":"浏览朋友圈列表","result":"PASS" }, ... ]
 *   }
 *
 * 若缺少 summary.json，会退化为扫描 runDir 下 *-report.md 的结果表生成
 * 精简摘要（仅含 no/title/result，用于列表与图表；回写按标题匹配）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

/* ---------- 参数解析 ---------- */
const argv = process.argv.slice(2);
let runDir = null, url = null, noWriteback = false, dryRun = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--url') { url = argv[++i]; }
  else if (a === '--no-writeback') { noWriteback = true; }
  else if (a === '--dry-run') { dryRun = true; }
  else if (!runDir) { runDir = a; }
}
if (!runDir) {
  console.error('用法: node report-upload.js <runDir> [--url http://host:port] [--no-writeback] [--dry-run]');
  process.exit(1);
}
runDir = path.resolve(runDir);
if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) {
  console.error('[!] 运行目录不存在：' + runDir);
  process.exit(1);
}
const runId = path.basename(runDir);
const baseUrl = (url || process.env.SMOKE_UI_URL || 'http://127.0.0.1:8899').replace(/\/+$/, '');

/* ---------- HTTP 工具 ---------- */
function request(method, pathname, body, contentType, isBinary) {
  return new Promise((resolve, reject) => {
    const target = new URL(baseUrl + pathname);
    const lib = target.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': contentType || 'application/octet-stream' };
    if (Buffer.isBuffer(body)) headers['Content-Length'] = body.length;
    const req = lib.request(target, { method, headers }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (body) {
      if (Buffer.isBuffer(body) || typeof body === 'string') req.end(body);
      else body.pipe(req); // stream
    } else {
      req.end();
    }
  });
}

/* ---------- 摘要读取 ---------- */
function readSummary() {
  const sp = path.join(runDir, 'summary.json');
  if (fs.existsSync(sp)) {
    try { return JSON.parse(fs.readFileSync(sp, 'utf8')); } catch (e) {
      console.warn('[!] summary.json 解析失败，改用报告表兜底');
    }
  }
  return buildSummaryFromReports();
}

/* 从 *-report.md 结果表兜底生成摘要 */
function buildSummaryFromReports() {
  const results = [];
  let module = null;
  let files = [];
  try { files = fs.readdirSync(runDir).filter(f => /-report\.md$/i.test(f)); } catch (e) { files = []; }
  for (const f of files) {
    const text = fs.readFileSync(path.join(runDir, f), 'utf8');
    const titleMatch = text.match(/^#\s*(.+?)\s*冒烟测试执行报告/m);
    if (titleMatch && !module) module = titleMatch[1].trim();
    let resultCol = -1, caseNoCol = 0, titleCol = 1, inTable = false;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line.startsWith('|')) continue;
      const cells = line.split('|').map(s => s.trim());
      if (cells.length && cells[0] === '') cells.shift();
      if (cells.length && cells[cells.length - 1] === '') cells.pop();
      if (/---/.test(line)) continue;
      if (cells.includes('结果') && cells.includes('用例编号')) {
        resultCol = cells.indexOf('结果');
        caseNoCol = cells.indexOf('用例编号');
        titleCol = cells.indexOf('用例名称'); if (titleCol < 0) titleCol = 1;
        inTable = true;
        continue;
      }
      if (!inTable || resultCol < 0) continue;
      const resultRaw = (cells[resultCol] || '').replace(/\[[^\]]*\]\([^)]*\)/g, '').trim();
      const no = (cells[caseNoCol] || '').trim();
      const title = (cells[titleCol] || '').trim();
      if (!resultRaw || resultRaw === '结果') continue;
      results.push({ no, title, result: resultRaw });
    }
  }
  if (!results.length) return null;
  const total = results.length;
  const passed = results.filter(r => /^PASS/i.test(r.result) && !/部分|PARTIAL/i.test(r.result)).length;
  return {
    schemaVersion: 1, runId, executedAt: null, module,
    total, passed, partial: 0, failed: 0, interrupted: 0, notExecuted: 0,
    passRate: total ? passed / total : null, results
  };
}

/* ---------- 收集文件 ---------- */
function collectFiles(dir, base) {
  let out = [];
  for (const name of fs.readdirSync(dir)) {
    const fp = path.join(dir, name);
    const rel = base ? base + '/' + name : name;
    const st = fs.statSync(fp);
    if (st.isDirectory()) out = out.concat(collectFiles(fp, rel));
    else out.push({ abs: fp, rel });
  }
  return out;
}

/* ---------- 主流程 ---------- */
async function main() {
  const summary = readSummary();
  const files = collectFiles(runDir, '');
  console.log(`[report-upload] runId = ${runId}`);
  console.log(`[report-upload] server = ${baseUrl}`);
  console.log(`[report-upload] files = ${files.length}${summary ? `，通过率 = ${summary.passRate == null ? '—' : Math.round(summary.passRate * 100) + '%'}` : ''}`);

  // 证据自检：已执行用例数 vs result.png 终态截图数（缺失会导致报告证据图裂图）
  if (summary && Array.isArray(summary.results) && summary.results.length) {
    const executed = summary.results.filter(r => !/NOT[_ ]?EXECUTED|NOT[_ ]?RUN|SKIP|跳过/i.test(String(r.result || ''))).length;
    const pngCount = files.filter(f => /screenshots\/result\.png$/i.test(f.rel.replace(/\\/g, '/'))).length;
    if (executed > 0 && pngCount < executed) {
      console.warn(`[report-upload] ⚠ 证据自检：已执行 ${executed} 条用例，仅发现 ${pngCount} 张 result.png 终态截图，报告证据图可能裂图。`);
    }
  }

  if (dryRun) {
    files.forEach(f => console.log('  PUT /api/reports/' + runId + '/' + f.rel));
    if (summary && summary.results && !noWriteback) {
      console.log(`  POST /api/results（${summary.results.length} 条结果回写）`);
    }
    return;
  }

  let ok = 0, fail = 0;
  for (const f of files) {
    try {
      const r = await request('PUT', `/api/reports/${runId}/${f.rel.split(path.sep).join('/')}`, fs.createReadStream(f.abs), 'application/octet-stream');
      if (r.status >= 200 && r.status < 300) { ok++; }
      else { fail++; console.error(`  ✕ ${f.rel} → HTTP ${r.status}`); }
    } catch (e) {
      fail++;
      console.error(`  ✕ ${f.rel} → ${e.message}`);
    }
    if ((ok + fail) % 25 === 0) console.log(`  … 已处理 ${ok + fail}/${files.length}`);
  }
  console.log(`[report-upload] 上传完成：成功 ${ok}，失败 ${fail}`);

  if (summary && summary.results && !noWriteback) {
    try {
      const r = await request('POST', '/api/results', JSON.stringify({ runId, results: summary.results }), 'application/json');
      if (r.status >= 200 && r.status < 300) {
        console.log(`[report-upload] 结果回写：更新 ${r.body.updated} 条${(r.body.unmatched && r.body.unmatched.length) ? '，未匹配 ' + r.body.unmatched.length + ' 条' : ''}`);
      } else {
        console.error(`[report-upload] 结果回写失败：HTTP ${r.status} ${JSON.stringify(r.body)}`);
      }
    } catch (e) {
      console.error(`[report-upload] 结果回写失败：${e.message}`);
    }
  }

  if (fail) process.exitCode = 1;
}

main().catch(e => { console.error('[report-upload] 错误：' + e.message); process.exit(1); });
