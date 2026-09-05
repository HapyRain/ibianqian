/**
 * 集成测试公共脚手架 —— 5 个起服务的测试（validation-guards / image-lifecycle /
 * note-image / note-ownership / archive-guards）共享；test-template-guard.js 是纯静态
 * 检查、不起服务，不用本模块。
 *
 * ⚠️ 关键：本模块在 **require 时** 即以副作用创建临时数据目录并设置
 * `process.env.BUGLIST_DATA_ROOT`。server.js 在 require 时就计算 DATA_ROOT，因此
 * 调用方必须「先 require('./helpers')、后 require('../server')」，顺序不能反。
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'buglist-test-'));
process.env.BUGLIST_DATA_ROOT = DATA_ROOT; // 必须在 require('../server') 之前
const DATA_FILE = path.join(DATA_ROOT, 'data.json');
const UPLOADS_DIR = path.join(DATA_ROOT, 'uploads');

// --- 计数断言（模块级状态；每个测试文件是独立进程，互不串扰） ---
let passed = 0;
let failed = 0;
function assert(condition, name) {
  if (condition) { console.log(`  [PASS] ${name}`); passed++; }
  else { console.log(`  [FAIL] ${name}`); failed++; }
}
const getCounts = () => ({ passed, failed });
const exitCode = () => (failed > 0 ? 1 : 0);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readData = () => JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
function listUploads() {
  try { return fs.readdirSync(UPLOADS_DIR); } catch (e) { return []; }
}
const countBroadcasts = (client) => client.messages.filter((m) => m.type === 'broadcast').length;

// 1x1 透明 PNG（合法 PNG 魔数 89504E47，可过服务端魔数校验）
const PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

/** 建立 WS 连接，自动收集收到的消息；附带 count(pred) 便捷计数（各测试按需取用） */
function connectWS(port, label) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const messages = [];
  ws.on('message', (raw) => {
    try { messages.push(JSON.parse(raw.toString())); } catch (e) { /* 忽略非 JSON */ }
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} WS 连接超时`)), 5000);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve({
        ws,
        messages,
        send(obj) { ws.send(JSON.stringify(obj)); },
        close() { try { ws.close(); } catch (e) { /* 忽略 */ } },
        count(pred) { return messages.filter(pred).length; },
      });
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

/** 手工构造 multipart/form-data 并 POST /api/upload；headers 自定义（X-Bug-Id / X-Note-Id 等），declaredMime 为 part 内 Content-Type */
function httpUpload(port, headers, fileBuffer, filename, declaredMime) {
  return new Promise((resolve, reject) => {
    const boundary = '----BuglistTestBoundary' + Date.now() + Math.random().toString(36).slice(2);
    const partHeader =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${declaredMime || 'image/png'}\r\n\r\n`;
    const header = Buffer.from(partHeader, 'utf-8');
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
    const body = Buffer.concat([header, fileBuffer, footer]);

    const req = http.request({
      host: 'localhost', port, path: '/api/upload', method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (e) { /* 非 JSON 响应 */ }
        resolve({ statusCode: res.statusCode, body: parsed, raw: text });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** 直接 DELETE /api/upload/:filename */
function httpDeleteUpload(port, filename) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: 'localhost', port,
      path: `/api/upload/${encodeURIComponent(filename)}`,
      method: 'DELETE',
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (e) { /* 非 JSON 响应 */ }
        resolve({ statusCode: res.statusCode, body: parsed, raw: text });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const rmDataRoot = () => { try { fs.rmSync(DATA_ROOT, { recursive: true, force: true }); } catch (e) { /* 忽略清理失败 */ } };

/** 统一收尾：关客户端 → 关服务 → 等待收尾 → 删临时目录 */
async function teardown(httpServer, ...clients) {
  for (const c of clients) { if (c) c.close(); }
  if (httpServer) httpServer.close();
  await sleep(200);
  rmDataRoot();
}

/** 顶层 .catch 兜底：打印异常 → 清临时目录 → 非零退出 */
function onFatal(err) {
  console.error('测试脚本异常:', err);
  rmDataRoot();
  process.exit(1);
}

module.exports = {
  DATA_ROOT, DATA_FILE, UPLOADS_DIR,
  assert, sleep, readData, listUploads, countBroadcasts, PNG_BUFFER,
  connectWS, httpUpload, httpDeleteUpload,
  teardown, rmDataRoot, onFatal, getCounts, exitCode,
};
