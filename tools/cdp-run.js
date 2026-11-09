/**
 * cdp-run.js — 用 Chrome DevTools Protocol 真实驱动页面并取回结果
 * 不使用 --virtual-time-budget，因此 IndexedDB / Worker / WASM 等异步 IO 可正常完成。
 *
 * 用法: node tools/cdp-run.js <url> [等待的全局变量名]
 */
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const TARGET_URL = process.argv[2];
const WAIT_GLOBAL = process.argv[3] || '__selftest';
const PORT = 9333 + Math.floor(Math.random() * 200);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function httpGet(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

(async () => {
  if (!TARGET_URL) { console.error('缺少 URL'); process.exit(2); }

  const profile = path.join(os.tmpdir(), 'cdp-profile-' + Date.now());
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--disable-background-networking',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    TARGET_URL
  ], { stdio: 'ignore' });

  let page = null;
  for (let i = 0; i < 80; i++) {
    try {
      const list = await httpGet('/json');
      page = (list || []).find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) break;
    } catch (e) { /* 尚未就绪 */ }
    await sleep(250);
  }
  if (!page) { console.error('无法连接到 DevTools'); chrome.kill(); process.exit(3); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  const consoleErrors = [];

  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push((m.params.args || []).map(a => a.value || a.description || '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    }
  });

  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });

  function send(method, params) {
    return new Promise(res => {
      const id = ++msgId;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  await send('Runtime.enable');
  await send('Page.enable');

  async function evaluate(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return { error: r.result.exceptionDetails.text };
    return { value: r.result && r.result.result ? r.result.result.value : undefined };
  }

  // 轮询等待目标全局变量出现
  let result = null;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const r = await evaluate('(typeof window.' + WAIT_GLOBAL + ' !== "undefined" && window.' + WAIT_GLOBAL + ') ? JSON.stringify(window.' + WAIT_GLOBAL + ') : null');
    if (r.value) { result = JSON.parse(r.value); break; }
    await sleep(400);
  }

  // 取回页面文本输出
  const outR = await evaluate('(document.getElementById("out")||{}).textContent || document.body.innerText || ""');
  console.log(outR.value || '(无输出)');

  if (consoleErrors.length) {
    console.log('\n--- 控制台错误 ---');
    consoleErrors.slice(0, 20).forEach(e => console.log('  ' + e));
  }

  if (!result) {
    console.log('\n[警告] 未在 90 秒内等到 window.' + WAIT_GLOBAL);
  } else {
    console.log('\n[结果] ' + JSON.stringify(result));
  }

  ws.close();
  chrome.kill();
  setTimeout(() => process.exit(result && result.fail === 0 ? 0 : 1), 300);
})().catch(e => { console.error(e); process.exit(1); });
