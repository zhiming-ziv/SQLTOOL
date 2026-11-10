// 串行运行真实文件流程：node tools/file-ui-test.js；可用 CHROME_BIN 指定 Chrome。
// 自行启动随机端口服务及独占临时浏览器，仅使用内存 SQLite，并拦截已保存连接接口。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [], errors = [];
const report = { startedAt: new Date().toISOString(), scope: '真实 Chrome、真实 FileReader/File/DataTransfer、sql.js；下载通过 Blob 捕获验证', results };
let server, chrome, ws, profile;
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
  });
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
}
function check(name, condition, detail) {
  results.push({ name, passed: !!condition, detail });
  console.log((condition ? '通过：' : '失败：') + name + (detail ? ' ' + JSON.stringify(detail) : ''));
}
(async () => {
  try {
    const port = await freePort(), debugPort = await freePort();
    report.port = port; report.debugPort = debugPort;
    server = spawn(process.execPath, ['server.js', String(port)], { cwd: ROOT, windowsHide: true, stdio: 'ignore' });
    const base = 'http://127.0.0.1:' + port;
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try { const r = await fetch(base + '/api/health'); if (r.ok) { ready = true; break; } } catch (e) {}
      await sleep(100);
    }
    if (!ready) throw new Error('测试服务启动失败');
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sqltool-file-ui-'));
    chrome = spawn(process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions',
      '--window-size=1600,1000', '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile,
      'about:blank'
    ], { windowsHide: true, stdio: 'ignore' });
    let page;
    for (let i = 0; i < 80; i++) {
      try { page = (await (await fetch('http://127.0.0.1:' + debugPort + '/json')).json()).find(x => x.type === 'page'); if (page) break; } catch (e) {}
      await sleep(150);
    }
    if (!page) throw new Error('Chrome 调试接口启动失败');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
    const pending = new Map(); let seq = 0;
    ws.addEventListener('message', event => {
      const m = JSON.parse(event.data);
      if (m.id && pending.has(m.id)) {
        const request = pending.get(m.id); pending.delete(m.id); clearTimeout(request.timer);
        if (m.error) request.reject(new Error('CDP ' + request.method + ' 失败：' + m.error.message));
        else request.resolve(m);
      }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP 命令超时：' + method)); }, 20000);
      pending.set(id, { method, resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
    });
    await send('Runtime.enable');
    await send('Page.enable');
    async function ev(expression) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
      return r.result?.result?.value;
    }
    async function wait(expression, label) {
      for (let i = 0; i < 160; i++) { if (await ev(expression)) return; await sleep(100); }
      throw new Error('等待超时：' + label);
    }
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const realFetch = window.fetch;
      window.__savedWrites = 0;
      window.fetch = function(url, opts) {
        if (String(url).includes('/api/saved')) {
          if (opts && opts.method && opts.method !== 'GET') window.__savedWrites++;
          return Promise.resolve(new Response(JSON.stringify({ok:true,data:{connections:[]}}), {headers:{'Content-Type':'application/json'}}));
        }
        return realFetch.apply(this, arguments);
      };
      window.__downloads = []; window.__blobs = new Map();
      const create = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => { const url = create(blob); window.__blobs.set(url, blob); return url; };
      HTMLAnchorElement.prototype.click = function() { window.__downloads.push({name:this.download,blob:window.__blobs.get(this.href)}); };
      const click = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function() { if (this.type === 'file') window.__fileInput = this; else click.call(this); };
    })()` });
    await send('Page.navigate', { url: base + '/app/index.html' });
    await wait('window.__booted === true', '页面初始化');
    if (!await ev('Array.isArray(window.__downloads) && window.__savedWrites === 0')) throw new Error('页面初始化前的文件测试拦截器未安装');
    const action = name => ev(`document.querySelector('[data-action="${name}"]').click()`);
    async function newConn(name) {
      await action('new-conn');
      await ev(`document.getElementById('fName').value=${JSON.stringify(name)};document.getElementById('fPersist').value='0';document.querySelector('.mask.show [data-ok]').click()`);
      await wait(`document.getElementById('sbConn').textContent===${JSON.stringify(name)} && !document.getElementById('overlay').classList.contains('show')`, '建立连接');
    }
    async function sql(text) {
      await ev(`(() => { const e=document.getElementById('sql');e.value=${JSON.stringify(text)};e.setSelectionRange(0,0);document.getElementById('sbStatus').textContent='等待测试';document.querySelector('[data-action="execute"]').click(); })()`);
      await wait(`['查询成功','命令已成功完成','执行失败'].includes(document.getElementById('sbStatus').textContent)`, 'SQL 返回');
      const status = await ev('document.getElementById("sbStatus").textContent');
      if (status === '执行失败') throw new Error(await ev('document.getElementById("resBody").textContent'));
    }
    async function jsonRows() {
      await ev('document.getElementById("btnResJson").click()');
      return JSON.parse(await ev('window.__downloads.at(-1).blob.text()'));
    }
    async function chooseFile(name, text, fromDownload) {
      await ev(`(() => {
        const content = ${fromDownload ? 'window.__dbExport.blob' : JSON.stringify(text)};
        const file = new File([content], ${JSON.stringify(name)}, {type:'application/octet-stream'});
        const dt=new DataTransfer();dt.items.add(file);window.__fileInput.files=dt.files;
        window.__fileInput.dispatchEvent(new Event('change',{bubbles:true}));
      })()`);
    }
    async function selectConn(name) {
      await ev(`(() => { const n=Array.from(document.querySelectorAll('#tree .node')).find(n=>n.dataset.type==='conn' && n.dataset.name===${JSON.stringify(name)});if(!n)throw new Error('没有指定连接');n.click(); })()`);
      await wait(`document.getElementById('sbConn').textContent===${JSON.stringify(name)}`, '切换连接');
    }
    async function tableMenu(actionName) {
      await ev(`(() => { const nodes=Array.from(document.querySelectorAll('#tree .node'));const c=nodes.find(n=>n.dataset.type==='conn' && n.dataset.name===document.getElementById('sbConn').textContent);const n=nodes.find(n=>n.dataset.name==='items' && n._connId===c._connId);if(!n)throw new Error('没有 items 节点');n.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:250}));document.querySelector('#ctx [data-action="${actionName}"]').click(); })()`);
    }
    await newConn('文件库A');
    const special = '中文,含"引号"\n第二行';
    await sql(`CREATE TABLE items(id INTEGER PRIMARY KEY,label TEXT NOT NULL,note TEXT,code TEXT);INSERT INTO items VALUES(1,'${special}',NULL,'00123');SELECT * FROM items ORDER BY id;`);
    await ev('document.getElementById("btnResCsv").click()');
    const csv = await ev('window.__downloads.at(-1).blob.text()');
    // Blob.text() 的 UTF-8 解码会去除 BOM，须分别检查原始字节和解码内容。
    const csvExpected = 'id,label,note,code\r\n1,"中文,含""引号""\n第二行",,00123';
    const bom = await ev('(async()=>Array.from(new Uint8Array(await window.__downloads.at(-1).blob.arrayBuffer()).slice(0,3)))()');
    check('真实 CSV 下载保留 BOM、中文、逗号、引号、换行和前导零', csv === csvExpected && JSON.stringify(bom) === '[239,187,191]', { csv, bom });
    const json = await jsonRows();
    check('真实 JSON 下载保留 NULL 与字符串类型', JSON.stringify(json) === JSON.stringify([{ id:1,label:special,note:null,code:'00123' }]), { json });
    await action('refresh'); await wait('document.getElementById("tree").textContent.includes("items")', '表节点');

    await tableMenu('import-csv-table');
    await chooseFile('合法.csv', 'label,id,code,note\r\n"新增,中文",2,00002,');
    await wait('!!document.querySelector(".mask.show [data-ok]")', 'CSV 确认框');
    await ev('document.querySelector(".mask.show [data-ok]").click()');
    await wait('document.getElementById("toast").textContent.includes("导入完成")', 'CSV 完成');
    const importMessage = await ev('document.getElementById("toast").textContent');
    await sql('SELECT * FROM items WHERE id=2'); const imported = await jsonRows();
    check('合法 CSV 通过 FileReader 导入、列重排及空值正确', JSON.stringify(imported) === JSON.stringify([{id:2,label:'新增,中文',note:null,code:'00002'}]), { importMessage, imported });

    await tableMenu('import-csv-table');
    await chooseFile('约束.csv', 'id,label,note,code\n2,重复,,00002\n3,约束后成功,,00003');
    await wait('!!document.querySelector(".mask.show [data-ok]")', '约束确认框');
    await ev('document.querySelector(".mask.show [data-ok]").click()');
    await wait('document.getElementById("toast").textContent.includes("失败 1 行")', '约束统计');
    const constraintMessage = await ev('document.getElementById("toast").textContent');
    await sql('SELECT COUNT(*) AS c FROM items'); const count = await jsonRows();
    check('CSV 约束失败有提示且后续合法行成功', /成功 1 行.*失败 1 行/.test(constraintMessage) && count[0].c === 3, { constraintMessage, count });

    await action('new-query');
    await action('run-script');
    await chooseFile('测试脚本.sql', "INSERT INTO items VALUES (4,'来自 SQL 文件',NULL,'00004');SELECT COUNT(*) AS c FROM items;");
    await wait('document.querySelector("#resBody tbody td:nth-child(2)")?.textContent === "4"', 'SQL 文件执行');
    check('SQL 文件经 FileReader 读入并执行', (await jsonRows())[0].c === 4);

    await sql('SELECT 1 AS marker');
    const oldDocId = await ev('document.querySelector("#docTabs .active").dataset.id');
    const oldDocCount = await ev('document.querySelectorAll("#docTabs .doc-tab").length');
    await ev('document.getElementById("sql").setSelectionRange(0,6)');
    await action('run-script'); await chooseFile('追加测试.sql', 'SELECT 2 AS marker;');
    await wait('document.getElementById("sbStatus").textContent === "执行失败" || document.querySelector("#resBody tbody td:nth-child(2)")?.textContent === "2"', '已有 SQL 时执行文件');
    const scriptAppend = await ev('({status:document.getElementById("sbStatus").textContent,editor:document.getElementById("sql").value,message:document.getElementById("resBody").textContent})');
    const newDocId = await ev('document.querySelector("#docTabs .active").dataset.id');
    const newDocCount = await ev('document.querySelectorAll("#docTabs .doc-tab").length');
    check('已有无分号 SQL 与旧选区时在新标签页只执行文件正文', scriptAppend.status !== '执行失败' && scriptAppend.editor === 'SELECT 2 AS marker;' && newDocId !== oldDocId && newDocCount === oldDocCount + 1 && (await jsonRows())[0].marker === 2, scriptAppend);
    await ev(`document.querySelector('#docTabs [data-id="${oldDocId}"]').click()`);
    check('执行 SQL 文件后原标签页文本保持完整', await ev('document.getElementById("sql").value === "SELECT 1 AS marker"'));

    await action('export-db');
    await wait('window.__downloads.at(-1)?.name === "文件库A.db"', '数据库导出');
    await ev('window.__dbExport = window.__downloads.at(-1)');
    const binary = await ev('(async()=>{const b=new Uint8Array(await window.__dbExport.blob.arrayBuffer());return {size:b.length,magic:String.fromCharCode(...b.slice(0,15))};})()');
    check('数据库下载为真实 SQLite 文件', binary.size > 100 && binary.magic === 'SQLite format 3', binary);

    await newConn('文件库B');
    await sql("CREATE TABLE other(marker TEXT);CREATE TABLE items(id INTEGER PRIMARY KEY,label TEXT NOT NULL,note TEXT,code TEXT);INSERT INTO other VALUES('B');SELECT * FROM other;");
    await ev(`(() => { const n=Array.from(document.querySelectorAll('#tree .node')).find(n=>n.dataset.type==='conn' && n.textContent.includes('文件库A'));n.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:200}));document.querySelector('#ctx [data-action="export-db"]').click(); })()`);
    await wait('window.__downloads.at(-1)?.name === "文件库A.db"', '右键指定库导出');
    check('B 为当前连接时右键导出 A 的文件', await ev('document.getElementById("sbConn").textContent === "文件库B" && window.__downloads.at(-1).name === "文件库A.db"'));
    await ev('window.__dbExport = window.__downloads.at(-1)');

    await action('open-db'); await chooseFile('恢复库.db', '', true);
    await wait('document.getElementById("sbConn").textContent === "恢复库" && document.getElementById("toast").textContent.includes("已打开数据库")', '重新导入数据库');
    await sql('SELECT id,label,note,code FROM items ORDER BY id'); const restored = await jsonRows();
    check('导出的 A 库重新导入后表、四行数据及 NULL 完整', restored.length === 4 && restored[0].label === special && restored[0].note === null && restored[3].label === '来自 SQL 文件', { restored });
    const beforeInvalid = await ev('document.querySelectorAll(\'#tree .node[data-type="conn"]\').length');
    await action('open-db'); await chooseFile('无效.db', '这不是 SQLite 文件');
    await wait('document.getElementById("toast").textContent.includes("不是有效的 SQLite")', '拒绝无效文件');
    const afterInvalid = await ev('document.querySelectorAll(\'#tree .node[data-type="conn"]\').length');
    check('无效数据库文件被拒绝且不新增连接', beforeInvalid === afterInvalid && await ev('document.getElementById("sbConn").textContent === "恢复库"'));

    await selectConn('文件库A');
    await tableMenu('import-csv-table');
    await selectConn('文件库B');
    await chooseFile('空列表头.csv', ',id,,label,code,\n忽略前,5,忽略中,选择器原连接,00005,忽略后');
    await wait('!!document.querySelector(".mask.show [data-ok]")', '切换连接后的 CSV 确认');
    await ev('document.querySelector(".mask.show [data-ok]").click()');
    await wait('document.getElementById("toast").textContent.includes("导入完成")', '切换连接后的 CSV 导入');
    await sql('SELECT COUNT(*) AS c FROM items'); const bCount = await jsonRows();
    await selectConn('文件库A');
    await sql('SELECT * FROM items WHERE id=5'); const pinnedCsv = await jsonRows();
    check('CSV 选择文件前切连接仍导入原库，空表头不造成列错位', bCount[0].c === 0 && JSON.stringify(pinnedCsv) === JSON.stringify([{ id:5,label:'选择器原连接',note:null,code:'00005' }]), { bCount, pinnedCsv });

    for (const [fileName, csvText, expected] of [
      ['重复表头.csv', 'id,label,label\n6,值一,值二', '重复'],
      ['未知表头.csv', 'id,unknown\n6,错误字段', '未知列']
    ]) {
      await ev('document.getElementById("toast").textContent=""');
      await tableMenu('import-csv-table'); await chooseFile(fileName, csvText);
      await wait(`document.getElementById('toast').textContent.includes(${JSON.stringify(expected)})`, '拒绝无效表头');
      check('拒绝' + fileName + '且未打开写入确认', await ev('!document.querySelector(".mask.show [data-ok]")'), await ev('document.getElementById("toast").textContent'));
    }
    await sql('SELECT COUNT(*) AS c FROM items');
    check('拒绝无效 CSV 表头后原表数据保持不变', (await jsonRows())[0].c === 5);

    await selectConn('文件库B');
    await ev(`(() => { const n=Array.from(document.querySelectorAll('#tree .node')).find(n=>n.dataset.type==='conn' && n.dataset.name==='文件库A');n.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:200}));document.querySelector('#ctx [data-action="run-script"]').click(); })()`);
    await ev('document.getElementById("sbStatus").textContent="等待测试"');
    await chooseFile('指定连接.sql', "INSERT INTO items VALUES(6,'右键指定连接',NULL,'00006');SELECT COUNT(*) AS c FROM items;");
    await wait('document.querySelector("#docTabs .active .t-name")?.textContent === "指定连接.sql" && (document.getElementById("resBody").textContent.includes("该结果来自连接") || document.querySelector("#resBody table") || document.getElementById("resBody").textContent.includes("执行失败"))', '右键指定连接执行 SQL 文件');
    await selectConn('文件库A'); await sql('SELECT * FROM items WHERE id=6'); const pinnedSql = await jsonRows();
    await selectConn('文件库B'); await sql('SELECT COUNT(*) AS c FROM items'); const bAfterScript = await jsonRows();
    check('B 为当前连接时右键 SQL 文件在指定 A 库执行', pinnedSql[0]?.label === '右键指定连接' && bAfterScript[0].c === 0, { pinnedSql, bAfterScript });
    check('未写入服务端已保存连接', await ev('window.__savedWrites === 0'));
    check('真实文件流程没有未捕获异常', errors.length === 0, errors);
    report.completedAt = new Date().toISOString();
  } catch (error) {
    report.fatalError = error.stack;
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (ws) ws.close();
    await stop(chrome); await stop(server);
    report.chromeStopped = !chrome || chrome.exitCode !== null || chrome.signalCode !== null;
    report.serverStopped = !server || server.exitCode !== null || server.signalCode !== null;
    // 只清理本次创建且位于系统临时目录中的 profile。
    if (profile) {
      const resolved = path.resolve(profile), root = path.resolve(os.tmpdir()) + path.sep;
      if (resolved.startsWith(root) && path.basename(resolved).startsWith('sqltool-file-ui-')) {
        for (let i = 0; i < 5; i++) {
          try { fs.rmSync(resolved, { recursive: true, force: true }); report.profileRemoved = true; break; }
          catch (error) { report.profileCleanupError = error.message; await sleep(300); }
        }
        if (report.profileRemoved) delete report.profileCleanupError;
      }
    }
    report.passed = results.filter(x => x.passed).length;
    report.failed = results.filter(x => !x.passed).length;
    if (report.failed) process.exitCode = 1;
    const reportDir = path.join(ROOT, 'shots');
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, 'file-ui-results.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify({ passed:report.passed,failed:report.failed,serverStopped:report.serverStopped,chromeStopped:report.chromeStopped,profileRemoved:report.profileRemoved,fatalError:report.fatalError },null,2));
  }
})();
