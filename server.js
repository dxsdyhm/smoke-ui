#!/usr/bin/env node
/**
 * smoke-ui 服务器（零依赖，Node 原生 http）
 *
 * 功能：
 *   - 静态文件服务（index.html 等，与 server.js 同目录）
 *   - GET  /api/cases          读取全部用例（cases.json 不存在时返回空数据）
 *   - POST /api/cases          全量保存用例（原子写入 + 自动 .bak 备份 + 冲突检测）
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

const PORT = Number(process.env.PORT) || 8899;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'cases.json');
const BAK_FILE = DATA_FILE + '.bak';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

function readCases() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { version: 1, cases: [], updatedAt: 0 };
  }
}

function writeCases(data) {
  // 备份上一份（保留最近一次写入前的数据）
  if (fs.existsSync(DATA_FILE)) {
    try { fs.copyFileSync(DATA_FILE, BAK_FILE); } catch (e) { /* 备份失败不阻断写入 */ }
  }
  // 原子写入：先写临时文件再 rename，避免写一半崩溃损坏数据
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  /* ---------- 用例 API ---------- */
  if (p === '/api/cases') {
    if (req.method === 'GET') {
      sendJson(res, 200, readCases());
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 20 * 1024 * 1024) req.destroy(); });
      req.on('end', () => {
        let incoming;
        try { incoming = JSON.parse(body); }
        catch { sendJson(res, 400, { error: 'bad json' }); return; }
        if (!Array.isArray(incoming.cases)) { sendJson(res, 400, { error: 'cases must be array' }); return; }

        const cur = readCases();
        // 冲突检测：服务器已有版本时，客户端必须携带与其一致的 baseUpdatedAt（缺失视为 0）
        if (cur.updatedAt && (incoming.baseUpdatedAt || 0) !== cur.updatedAt) {
          sendJson(res, 409, { error: 'conflict', serverUpdatedAt: cur.updatedAt });
          return;
        }
        const data = { version: 1, cases: incoming.cases, updatedAt: Date.now() };
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

  /* ---------- 静态文件 ---------- */
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); res.end();
    return;
  }
  let fp = path.normalize(path.join(ROOT, p === '/' ? 'index.html' : p));
  if (!fp.startsWith(ROOT + path.sep) && fp !== path.join(ROOT, 'index.html')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  fs.readFile(fp, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(fp).toLowerCase();
    // no-cache：避免浏览器缓存旧版页面（工具页面量小，每次校验）
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[smoke-ui] server: http://0.0.0.0:${PORT}`);
  console.log(`[smoke-ui] data:   ${DATA_FILE}`);
});
