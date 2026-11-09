/**
 * server.js — SQLTool 本地静态服务器（零依赖）
 * 用法: node server.js [端口]
 *
 * 为什么需要它：浏览器要求 WASM、IndexedDB、动态 import 等能力必须运行在
 * http(s) 协议下，直接双击打开 file:// 会被安全策略拦截。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const api = require('./server/api');

const ROOT = __dirname;
const PORT = parseInt(process.argv[2], 10) || 8777;
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.db': 'application/octet-stream',
  '.sqlite': 'application/octet-stream',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

/**
 * 可公开访问的静态资源白名单：根目录 index.html 及 app/、demo/ 目录。
 * 任一路径段以「.」开头（隐藏文件 / 目录）也一律拒绝。
 */
const PUBLIC_FILES = new Set(['/index.html']);
const PUBLIC_DIRS = ['/app/', '/demo/'];
function isPublicPath(p) {
  if (p.includes('\0') || p.includes('\\')) return false;
  const segs = p.split('/');
  if (segs.some(x => x === '..' || x.startsWith('.'))) return false;
  if (PUBLIC_FILES.has(p)) return true;
  return PUBLIC_DIRS.some(d => p.startsWith(d));
}

/** 读取并解析 JSON 请求体 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > api.MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const txt = Buffer.concat(chunks).toString('utf8');
      try { resolve(txt ? JSON.parse(txt) : {}); }
      catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(url.parse(req.url).pathname); }
  catch (e) { res.writeHead(400); return res.end('Bad Request'); }

  /* ---------- API 路由 ---------- */
  if (pathname.startsWith('/api/')) {
    // 读取请求体前先做跨源 / Host / Content-Type 校验
    const bad = api.checkRequest(req);
    if (bad) {
      res.writeHead(bad.code, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: bad.error }));
    }
    let body = {};
    if (req.method === 'POST' || req.method === 'PUT') {
      try { body = await readBody(req); }
      catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }
    const handled = await api.handle(req, res, pathname, body);
    if (!handled) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '未知接口: ' + pathname }));
    }
    return;
  }

  // 静态资源同样校验 Host 头，防止 DNS Rebinding 页面读取本机文件
  if (!api.isLoopbackHost(req.headers.host)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }

  if (pathname === '/') pathname = '/index.html';

  // 只开放白名单内的前端资源；connections.json、.git、server/ 等一律不可访问
  if (!isPublicPath(pathname)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found: ' + pathname);
  }

  // 防目录穿越：必须以「根目录 + 分隔符」开头，避免同级目录（如 SQLTOOL-bak）被前缀误放行
  const target = path.normalize(path.join(ROOT, pathname));
  if (!target.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found: ' + pathname);
    }
    const ext = path.extname(target).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache' };
    // 跨源隔离，便于未来启用多线程 WASM
    headers['Cross-Origin-Opener-Policy'] = 'same-origin';
    headers['Cross-Origin-Embedder-Policy'] = 'credentialless';
    res.writeHead(200, headers);
    fs.createReadStream(target).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  const link = 'http://' + HOST + ':' + PORT + '/app/index.html';
  let status = [];
  try { status = require('./server/drivers').driverStatus(); } catch (e) { /* ignore */ }
  const avail = status.filter(d => d.available).map(d => d.label);
  const miss = status.filter(d => !d.available).map(d => d.label);

  console.log('');
  console.log('  SQLTool — 数据库工作台');
  console.log('  ───────────────────────────────────────────');
  console.log('  工作台   ' + link);
  console.log('  引擎自检 http://' + HOST + ':' + PORT + '/app/selftest.html');
  console.log('  界面演示 http://' + HOST + ':' + PORT + '/demo/index.html');
  console.log('');
  console.log('  可用驱动 ' + (avail.length ? avail.join(' / ') : '（无）'));
  if (miss.length) console.log('  缺少驱动 ' + miss.join(' / ') + '   → 执行 npm install');
  console.log('');
  console.log('  服务仅监听 ' + HOST + '，数据库连接由本进程代理。');
  console.log('  按 Ctrl+C 停止服务');
  console.log('');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('\n  端口 ' + PORT + ' 已被占用。换个端口：node server.js 8888\n');
  } else {
    console.error(e);
  }
  process.exit(1);
});
