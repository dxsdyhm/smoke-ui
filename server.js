#!/usr/bin/env node
/**
 * smoke-ui 服务器（零依赖，Node 原生 http）
 *
 * 功能：
 *   - 静态文件服务（index.html、reports/ 测试报告等，与 server.js 同目录）
 *   - 用例数据 API（供网页 + AI / run-smoke-test 使用）
 *   - 测试报告上传 / 列表 / 浏览
 *   - 测试结果回写（run-smoke-test 运行后更新用例状态）
 *
 * 用例 API：
 *   GET    /api/cases            读取全部用例（含 config、updatedAt）
 *   POST   /api/cases            全量保存用例（原子写入 + .bak 备份 + 冲突检测）
 *   GET    /api/cases/export     下载全部用例：?format=json(默认) 或 md(冒烟 Markdown)
 *   POST   /api/cases/import     批量上传/合并用例（AI 上传）：{ cases:[...], mode? }
 *   GET    /api/cases/:id        读取单条用例（AI 下载单条）
 *   PUT    /api/cases/:id        修改单条用例（AI 修改）：body 为字段集合
 *   DELETE /api/cases/:id        删除单条用例
 *
 * 结果回写 API：
 *   POST   /api/results          回写测试结果：{ runId, results:[{moduleCode,caseNo,project,title,result}] }
 *
 * 报告 API（run-smoke-test 上传 + 网站浏览）：
 *   PUT    /api/reports/:runId/...  上传一个报告文件（原始 body，自动建目录，防路径穿越）
 *   GET    /api/reports          列出全部测试报告（时间文件夹 + 通过率等汇总）
 *   GET    /api/reports/:runId   读取某次运行的 summary.json
 *   静态   /reports/<runId>/index.html  汇总报告（由静态文件服务直接提供）
 *
 * 启动：
 *   node server.js              # 默认端口 8899
 *   PORT=9000 node server.js    # 指定端口
 *
 * Linux 常驻（systemd 示例见 README.md）；Windows 可用 nssm 包装。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8899;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'cases.json');
const BAK_FILE = DATA_FILE + '.bak';
const REPORTS_DIR = path.join(ROOT, 'reports');
const MAX_BODY = 20 * 1024 * 1024;          // JSON 接口体上限
const MAX_UPLOAD = 1024 * 1024 * 1024;       // 报告文件上传上限（1GB，含录屏）

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.ad': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
  '.csv': 'text/csv; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

const DEFAULT_CONFIG = { projects: [], modules: [], types: [] };

/* ---------- 用例数据 ---------- */
function readCases() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!data.config || typeof data.config !== 'object') data.config = DEFAULT_CONFIG;
    if (!Array.isArray(data.cases)) data.cases = [];
    return data;
  } catch {
    return { version: 2, config: DEFAULT_CONFIG, cases: [], updatedAt: 0 };
  }
}

function writeCases(data) {
  if (fs.existsSync(DATA_FILE)) {
    try { fs.copyFileSync(DATA_FILE, BAK_FILE); } catch (e) { /* 备份失败不阻断 */ }
  }
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

function uid() {
  try { return crypto.randomUUID(); }
  catch { return 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10); }
}

/* 用例结果状态归一：PASS/PARTIAL/FAIL/INTERRUPTED/NOT_EXECUTED → pass/partial/fail/blocked/skip */
function normalizeResult(r) {
  const s = String(r || '').toUpperCase().trim();
  if (!s) return '';
  if (/PARTIAL|部分/.test(s)) return 'partial';
  if (/INTERRUPT|中断/.test(s)) return 'blocked';
  if (/BLOCK|阻塞/.test(s)) return 'blocked';
  if (/NOT[_ ]?EXECUTED|NOT[_ ]?RUN|SKIP|跳过/.test(s)) return 'skip';
  if (/PASS|通过|成功/.test(s)) return 'pass';
  if (/FAIL|失败|缺陷|BUG|ERROR/.test(s)) return 'fail';
  return '';
}

/* 模块内最大序号 + 1，用于导入时补齐 caseNo */
function nextCaseNo(cases, project, moduleCode, excludeId) {
  const p = project || '';
  const m = moduleCode || '';
  const used = cases
    .filter(c => c.id !== excludeId && c.project === p && c.moduleCode === m)
    .map(c => parseInt(c.caseNo, 10)).filter(Number.isFinite);
  return String((used.length ? Math.max(...used) : 0) + 1).padStart(3, '0');
}

/* 用例字段白名单（导入/单条修改时只合并这些字段，避免污染数据） */
const CASE_FIELDS = [
  'title', 'module', 'project', 'moduleCode', 'type', 'caseNo', 'priority',
  'preconditions', 'steps', 'stepTypes', 'expected', 'inSmoke',
  'smokePkg', 'smokeActivity', 'smokeSrc', 'lastResult', 'resultRunId', 'resultNote'
];

function pickCaseFields(src) {
  const out = {};
  CASE_FIELDS.forEach(k => { if (src[k] !== undefined) out[k] = src[k]; });
  return out;
}

/* ---------- 测试报告 ---------- */
function sanitizeRunId(id) {
  return /^[A-Za-z0-9._-]{1,64}$/.test(String(id || '')) ? String(id) : null;
}
function sanitizeRelPath(p) {
  const segs = String(p || '').replace(/\\/g, '/').split('/').filter(s => s !== '' && s !== '.');
  if (!segs.length) return null;
  for (const s of segs) {
    if (s === '..' || /[<>:"|?*\x00-\x1f]/.test(s)) return null;
  }
  return segs;
}
/* 从 runId（YYYYMMDD_HHMMSS）推导时间戳（本地时区） */
function runIdToMs(runId) {
  const m = String(runId || '').match(/^(\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}
function runSummary(runId, file) {
  const dir = path.join(REPORTS_DIR, runId);
  const summaryPath = file ? path.join(dir, file) : path.join(dir, 'summary.json');
  let s = null;
  try { s = JSON.parse(fs.readFileSync(summaryPath, 'utf8')); } catch (e) { s = null; }
  let t = (s && (s.executedAt || s.time)) ? Date.parse(s.executedAt || s.time) : NaN;
  if (!Number.isFinite(t)) t = runIdToMs(runId);
  const total = Number.isFinite(s && s.total) ? s.total : (s && s.results ? s.results.length : null);
  const passed = Number.isFinite(s && s.passed) ? s.passed : (s && s.results ? s.results.filter(r => normalizeResult(r.result) === 'pass').length : 0);
  let passRate = (s && Number.isFinite(s.passRate)) ? s.passRate : (total > 0 ? passed / total : null);
  return {
    runId,
    time: Number.isFinite(t) ? t : null,
    executedAt: s && (s.executedAt || s.time) || null,
    module: (s && s.module) || null,
    project: (s && s.project) || null,
    device: (s && s.device) || null,
    agentDeviceVersion: (s && s.agentDeviceVersion) || null,
    total: total,
    passed: passed,
    failed: (s && Number.isFinite(s.failed)) ? s.failed : 0,
    interrupted: (s && Number.isFinite(s.interrupted)) ? s.interrupted : 0,
    partial: (s && Number.isFinite(s.partial)) ? s.partial : 0,
    notExecuted: (s && Number.isFinite(s.notExecuted)) ? s.notExecuted : 0,
    passRate: passRate,
    url: '/reports/' + encodeURIComponent(runId) + '/index.html',
    summary: s || {}
  };
}
function listReports() {
  let runs = [];
  let dirs = [];
  try { dirs = fs.readdirSync(REPORTS_DIR, { withFileTypes: true }); } catch (e) { dirs = []; }
  dirs.forEach(d => {
    if (!d.isDirectory()) return;
    const rid = sanitizeRunId(d.name);
    if (!rid) return;
    const dir = path.join(REPORTS_DIR, rid);
    // 至少要有 summary.json 或 index.html 才视为一次有效运行
    const hasSummary = fs.existsSync(path.join(dir, 'summary.json'));
    const hasIndex = fs.existsSync(path.join(dir, 'index.html'));
    if (!hasSummary && !hasIndex) return;
    runs.push(runSummary(rid, hasSummary ? 'summary.json' : null));
  });
  runs.sort((a, b) => (b.time || 0) - (a.time || 0));
  return runs;
}

/* ---------- HTTP 工具 ---------- */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(body);
}
function readJsonBody(req, limit, cb) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > limit) req.destroy(); });
  req.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch (e) { return cb(null); }
    cb(parsed);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const method = req.method;

  /* ================= 用例 API ================= */
  if (p === '/api/cases') {
    if (method === 'GET') {
      sendJson(res, 200, readCases());
      return;
    }
    if (method === 'POST') {
      readJsonBody(req, MAX_BODY, incoming => {
        if (!incoming || !Array.isArray(incoming.cases)) { sendJson(res, 400, { error: 'cases must be array' }); return; }
        const cur = readCases();
        if (cur.updatedAt && (incoming.baseUpdatedAt || 0) !== cur.updatedAt) {
          sendJson(res, 409, { error: 'conflict', serverUpdatedAt: cur.updatedAt });
          return;
        }
        const config = (incoming.config && typeof incoming.config === 'object')
          ? {
              projects: Array.isArray(incoming.config.projects) ? incoming.config.projects : [],
              modules: Array.isArray(incoming.config.modules) ? incoming.config.modules : [],
              types: Array.isArray(incoming.config.types) ? incoming.config.types : []
            }
          : DEFAULT_CONFIG;
        const data = { version: 2, config, cases: incoming.cases, updatedAt: Date.now() };
        try {
          writeCases(data);
          sendJson(res, 200, { ok: true, updatedAt: data.updatedAt });
        } catch (e) {
          sendJson(res, 500, { error: 'write failed: ' + e.message });
        }
      });
      return;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  if (p === '/api/cases/export') {
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return; }
    const data = readCases();
    const fmt = (url.searchParams.get('format') || 'json').toLowerCase();
    if (fmt === 'md') {
      const md = buildCasesMarkdown(data.cases);
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': 'attachment; filename="smoke-cases.md"',
        'Cache-Control': 'no-cache'
      });
      res.end(md);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="cases.json"',
      'Cache-Control': 'no-cache'
    });
    res.end(JSON.stringify(data, null, 2));
    return;
  }

  if (p === '/api/cases/import') {
    if (method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return; }
    readJsonBody(req, MAX_BODY, incoming => {
      if (!incoming || !Array.isArray(incoming.cases)) { sendJson(res, 400, { error: 'cases must be array' }); return; }
      const cur = readCases();
      const mode = (incoming.mode || 'upsert').toLowerCase(); // upsert | append
      let updated = 0, added = 0;
      const cases = cur.cases.slice();
      const byId = new Map(cases.map(c => [c.id, c]));
      incoming.cases.forEach(src => {
        const now = Date.now();
        let target = null;
        // 1) 按 id 匹配
        if (src.id && byId.has(src.id)) target = byId.get(src.id);
        // 2) 按 (moduleCode + caseNo) 唯一匹配
        else if (src.moduleCode && src.caseNo) {
          const hits = cases.filter(c => c.moduleCode === src.moduleCode && c.caseNo === src.caseNo);
          if (hits.length === 1) target = hits[0];
        }
        const fields = pickCaseFields(src);
        if (target) {
          Object.assign(target, fields, { updatedAt: now });
          updated++;
        } else if (mode !== 'upsert' || true) {
          const c = Object.assign({
            id: src.id || uid(),
            title: '', module: '', project: '', moduleCode: '', type: '', caseNo: '',
            priority: 'P0-High', preconditions: '', steps: '', stepTypes: [], expected: '',
            inSmoke: false, smokePkg: '', smokeActivity: '', smokeSrc: '',
            lastResult: '', resultRunId: '', resultNote: '',
            createdAt: now, updatedAt: now
          }, fields);
          if (!c.caseNo) c.caseNo = nextCaseNo(cases, c.project, c.moduleCode);
          cases.unshift(c);
          added++;
        }
      });
      cur.cases = cases;
      cur.updatedAt = Date.now();
      try {
        writeCases(cur);
        sendJson(res, 200, { ok: true, updated, added, total: cases.length, updatedAt: cur.updatedAt });
      } catch (e) {
        sendJson(res, 500, { error: 'write failed: ' + e.message });
      }
    });
    return;
  }

  if (p.startsWith('/api/cases/')) {
    const id = decodeURIComponent(p.slice('/api/cases/'.length));
    if (!id) { sendJson(res, 400, { error: 'bad id' }); return; }
    const cur = readCases();
    const idx = cur.cases.findIndex(c => c.id === id);
    if (method === 'GET') {
      if (idx < 0) { sendJson(res, 404, { error: 'not found' }); return; }
      sendJson(res, 200, cur.cases[idx]);
      return;
    }
    if (method === 'PUT') {
      readJsonBody(req, MAX_BODY, incoming => {
        if (!incoming) { sendJson(res, 400, { error: 'bad json' }); return; }
        if (idx < 0) { sendJson(res, 404, { error: 'not found' }); return; }
        // 单条修改默认 last-write-wins；仅在显式携带 baseUpdatedAt 且不匹配时返回 409
        if (incoming.baseUpdatedAt != null && cur.updatedAt && Number(incoming.baseUpdatedAt) !== cur.updatedAt) {
          sendJson(res, 409, { error: 'conflict', serverUpdatedAt: cur.updatedAt });
          return;
        }
        const fields = pickCaseFields(incoming);
        Object.assign(cur.cases[idx], fields, { updatedAt: Date.now() });
        cur.updatedAt = Date.now();
        try {
          writeCases(cur);
          sendJson(res, 200, { ok: true, case: cur.cases[idx], updatedAt: cur.updatedAt });
        } catch (e) {
          sendJson(res, 500, { error: 'write failed: ' + e.message });
        }
      });
      return;
    }
    if (method === 'DELETE') {
      if (idx < 0) { sendJson(res, 404, { error: 'not found' }); return; }
      cur.cases.splice(idx, 1);
      cur.updatedAt = Date.now();
      try {
        writeCases(cur);
        sendJson(res, 200, { ok: true, updatedAt: cur.updatedAt });
      } catch (e) {
        sendJson(res, 500, { error: 'write failed: ' + e.message });
      }
      return;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  /* ================= 结果回写 ================= */
  if (p === '/api/results') {
    if (method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return; }
    readJsonBody(req, MAX_BODY, incoming => {
      if (!incoming || !Array.isArray(incoming.results)) { sendJson(res, 400, { error: 'results must be array' }); return; }
      const cur = readCases();
      const runId = String(incoming.runId || '');
      let updated = 0;
      const matched = [], unmatched = [];
      incoming.results.forEach(r => {
        const nresult = normalizeResult(r.result);
        let target = null;
        // 1) 直接 id
        if (r.id) target = cur.cases.find(c => c.id === r.id);
        // 2) moduleCode + caseNo
        if (!target && r.moduleCode && r.caseNo) {
          const hits = cur.cases.filter(c => c.moduleCode === r.moduleCode && c.caseNo === r.caseNo);
          if (hits.length === 1) target = hits[0];
          else if (hits.length > 1 && r.project) target = hits.find(c => c.project === r.project) || hits[0];
        }
        // 3) 标题 + 项目回退
        if (!target && r.title) {
          const hits = cur.cases.filter(c => (c.title || '').trim() === String(r.title).trim());
          if (hits.length === 1) target = hits[0];
          else if (hits.length > 1 && r.project) target = hits.find(c => c.project === r.project) || hits[0];
        }
        if (target) {
          target.lastResult = nresult;
          if (runId) target.resultRunId = runId;
          if (r.note) target.resultNote = String(r.note);
          target.updatedAt = Date.now();
          updated++;
          matched.push({ id: target.id, caseNo: target.caseNo, moduleCode: target.moduleCode, title: target.title, result: nresult });
        } else {
          unmatched.push({ moduleCode: r.moduleCode, caseNo: r.caseNo, title: r.title, result: r.result });
        }
      });
      cur.updatedAt = Date.now();
      try {
        writeCases(cur);
        sendJson(res, 200, { ok: true, updated, matched, unmatched, updatedAt: cur.updatedAt });
      } catch (e) {
        sendJson(res, 500, { error: 'write failed: ' + e.message });
      }
    });
    return;
  }

  /* ================= 报告 API ================= */
  if (p === '/api/reports') {
    if (method === 'GET') {
      const days = url.searchParams.get('days');
      let runs = listReports();
      if (days) {
        const n = Number(days);
        if (Number.isFinite(n) && n > 0) {
          const cutoff = Date.now() - n * 24 * 3600 * 1000;
          runs = runs.filter(r => r.time == null || r.time >= cutoff);
        }
      }
      sendJson(res, 200, { runs });
      return;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  if (p.startsWith('/api/reports/')) {
    const rest = decodeURIComponent(p.slice('/api/reports/'.length)).split('/').filter(Boolean);
    if (!rest.length) { sendJson(res, 400, { error: 'bad path' }); return; }
    const runId = sanitizeRunId(rest[0]);
    if (!runId) { sendJson(res, 400, { error: 'bad run id' }); return; }
    const runDir = path.join(REPORTS_DIR, runId);

    if (method === 'GET') {
      // GET /api/reports/:runId → 返回该次运行 summary
      const summaryPath = path.join(runDir, 'summary.json');
      if (!fs.existsSync(summaryPath)) { sendJson(res, 404, { error: 'not found' }); return; }
      sendJson(res, 200, runSummary(runId));
      return;
    }

    if (method === 'PUT') {
      // PUT /api/reports/:runId/<relative path> → 上传一个文件（原始 body）
      const rel = sanitizeRelPath(rest.slice(1).join('/'));
      if (rel === null) { sendJson(res, 400, { error: 'bad path' }); return; }
      const dest = path.join(runDir, ...rel);
      if (!dest.startsWith(runDir + path.sep) && dest !== runDir) { sendJson(res, 403, { error: 'forbidden' }); return; }
      try { fs.mkdirSync(path.dirname(dest), { recursive: true }); }
      catch (e) { sendJson(res, 500, { error: 'mkdir failed: ' + e.message }); return; }
      const ws = fs.createWriteStream(dest);
      let size = 0, aborted = false;
      req.on('data', c => {
        size += c.length;
        if (size > MAX_UPLOAD) { aborted = true; req.destroy(); try { ws.destroy(); } catch (_) {} }
        else ws.write(c);
      });
      req.on('end', () => { if (aborted) return; ws.end(() => sendJson(res, 200, { ok: true, path: rest.slice(1).join('/'), size })); });
      req.on('error', () => { try { ws.destroy(); } catch (_) {} });
      ws.on('error', () => { try { res.destroy(); } catch (_) {} });
      return;
    }

    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  /* ================= 静态文件 ================= */
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }
  let rel = p === '/' ? 'index.html' : p;
  try { rel = decodeURIComponent(rel); } catch (e) { /* 保留原样 */ }
  let fp = path.normalize(path.join(ROOT, rel));
  if (!fp.startsWith(ROOT + path.sep) && fp !== path.join(ROOT, 'index.html')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  fs.stat(fp, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(fp).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size
    };
    // 报告资产（截图/录屏）可缓存；页面与数据 no-cache
    const isReportAsset = fp.startsWith(REPORTS_DIR + path.sep) && !/\.(html?|json|md)$/i.test(ext);
    headers['Cache-Control'] = isReportAsset ? 'public, max-age=3600' : 'no-cache';
    if (method === 'HEAD') { res.writeHead(200, headers); res.end(); return; }
    res.writeHead(200, headers);
    fs.createReadStream(fp).pipe(res);
  });
});

/* ---------- 用例 → 冒烟 Markdown（供 AI 下载后喂给 run-smoke-test） ---------- */
function mdEscape(s) { return String(s ?? ''); }
function buildCasesMarkdown(cases) {
  // 按模块码分组，组内按序号排序，编号 01、02…
  const groups = new Map();
  cases.forEach(c => {
    const key = (c.moduleCode || '(未分组)') + '|' + (c.project || '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  });
  const parts = [];
  groups.forEach((list) => {
    list.sort((a, b) => (parseInt(a.caseNo, 10) || 0) - (parseInt(b.caseNo, 10) || 0));
    const modName = list[0].module || list[0].moduleCode || '未分类';
    list.forEach((c, i) => {
      const num = String(i + 1).padStart(2, '0');
      const mod = c.module || modName;
      const lines = [];
      lines.push(`<!--smoke-test module="${mod}" project="${c.project || ''}" no="${c.caseNo || ''}" package="${c.smokePkg || '-'}" activity="${c.smokeActivity || '-'}" src="${c.smokeSrc || '-'}"-->`);
      lines.push('');
      lines.push(`# ${num}、${c.title}`);
      lines.push('');
      lines.push(`**模块**：${mod}`);
      lines.push(`**编号**：${(c.moduleCode && c.caseNo) ? c.moduleCode + '-' + c.caseNo : '—'}`);
      lines.push(`**优先级**：${c.priority}`);
      lines.push(`**前置条件**：${c.preconditions || '无'}`);
      lines.push('');
      lines.push('## 测试步骤');
      const steps = String(c.steps || '').split('\n').map(s => s.replace(/^\s*\d+[、.．]\s*/, '')).filter(s => s.trim());
      if (steps.length) steps.forEach((s, j) => lines.push(`${j + 1}. **${s}** — action`));
      else lines.push('1. **（待补充）** — action');
      lines.push('');
      lines.push('## 预期结果');
      const exps = String(c.expected || '').split('\n').filter(s => s.trim());
      if (exps.length) exps.forEach((s, j) => lines.push(`${j + 1}. ${s}`));
      else lines.push('1. （待补充）');
      parts.push(lines.join('\n'));
    });
  });
  return parts.join('\n\n') + '\n';
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[smoke-ui] server: http://0.0.0.0:${PORT}`);
  console.log(`[smoke-ui] data:   ${DATA_FILE}`);
  console.log(`[smoke-ui] reports: ${REPORTS_DIR}`);
});
