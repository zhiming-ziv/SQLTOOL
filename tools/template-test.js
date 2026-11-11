// 串行运行 SQL 模板库测试：node tools/template-test.js；可用 CHROME_BIN 指定 Chrome。
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
const report = { startedAt: new Date().toISOString(), scope: '真实 Chrome、IndexedDB、文件导入导出、编辑器及浏览器内 SQLite', results };
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
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sqltool-template-ui-'));
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

    const lib = '.template-library', form = '.template-editor';
    const list = () => ev('SqlTool.Templates.store.list()');
    const close = selector => ev(`document.querySelector(${JSON.stringify(selector)}+' [data-cancel]').click()`);
    async function setEditor(text, start = 0, end = start) {
      await ev(`(() => { const e=document.getElementById('sql');e.value=${JSON.stringify(text)};e.setSelectionRange(${start},${end});e.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    }
    async function fields(value) {
      await ev(`(() => { const values=${JSON.stringify(value)};for(const [key,value] of Object.entries(values))document.querySelector('.template-editor [data-tpl-'+key+']').value=value; })()`);
    }
    async function openLibrary() {
      await action('templates');
      await wait('!!document.querySelector(".template-library [data-template-id]")', '模板列表');
    }
    async function clickTpl(name) { await ev(`document.querySelector('.template-library [data-tpl-${name}]').click()`); }
    async function selectTemplate(name) {
      await ev(`(() => { const b=Array.from(document.querySelectorAll('.tpl-item')).find(b=>b.querySelector('strong').textContent===${JSON.stringify(name)});if(!b)throw new Error('找不到模板');b.click(); })()`);
    }
    async function importFile(text, name = '模板.json') {
      await clickTpl('import');
      await ev(`(() => { const dt=new DataTransfer();dt.items.add(new File([${JSON.stringify(text)}],${JSON.stringify(name)},{type:'application/json'}));window.__fileInput.files=dt.files;window.__fileInput.dispatchEvent(new Event('change')); })()`);
      await wait('!document.querySelector(".template-library [data-tpl-import]").disabled', '文件导入完成');
    }
    async function rejected(expression) {
      return ev(`(async()=>{try{await (${expression});return false;}catch(e){return e.message;}})()`);
    }
    const raw = '  -- 中文模板\nSELECT \'00123\' AS code;\n\n';
    await setEditor(raw); await action('save-template');
    check('保存整篇 SQL 时保留空白、中文、引号和换行', await ev('document.querySelector(".template-editor [data-tpl-sql]").value') === raw);
    await fields({ name: '编码查询', dialect: 'sqlite', tags: '常用, 财务,常用', description: '保留前导零\n第二行说明' });
    await ev('document.querySelector(".template-editor [data-ok]").click()');
    await wait('!document.querySelector(".template-editor")', '保存整篇');
    let records = await list();
    check('完整模板持久化且标签去重', records.length === 1 && records[0].sql === raw && records[0].tags.join(',') === '常用,财务' && !!records[0].createdAt && records[0].revision === 1);
    check('保存模板不修改原 SQL', await ev('document.getElementById("sql").value') === raw);
    const picked = "SELECT '选区' AS value;", whole = 'SELECT 1;\n' + picked + '\nSELECT 3;';
    await setEditor(whole, 10, 10 + picked.length); await action('save-template');
    check('有选区时仅保存选中 SQL', await ev('document.querySelector(".template-editor [data-tpl-sql]").value') === picked);
    await fields({ name: '选区模板', dialect: 'mysql' });
    await ev('document.querySelector(".template-editor [data-ok]").click()'); await wait('!document.querySelector(".template-editor")', '保存选区');
    await setEditor('   '); await action('save-template');
    check('空白 SQL 被拒绝', !await ev('!!document.querySelector(".template-editor")'));
    check('模板不会混入数据库连接存储', (await ev('SqlTool.Store.metaKeys()')).length === 0);

    await send('Page.reload'); await wait('window.__booted === true', '刷新恢复');
    check('刷新页面后模板仍完整保留', (await list()).length === 2 && (await list()).some(t => t.sql === raw));
    check('恢复模板不会创建额外数据库连接', await ev('document.querySelectorAll("#tree .node[data-type=conn]").length') === 0);
    await openLibrary();
    await ev('document.querySelector("[data-tpl-search]").value="财务";document.querySelector("[data-tpl-search]").dispatchEvent(new Event("input"))');
    check('按标签搜索模板', await ev('document.querySelectorAll(".tpl-item").length') === 1);
    await ev('document.querySelector("[data-tpl-search]").value="00123";document.querySelector("[data-tpl-search]").dispatchEvent(new Event("input"))');
    check('按 SQL 正文搜索模板', await ev('document.querySelectorAll(".tpl-item").length') === 1);
    await ev('document.querySelector("[data-tpl-search]").value="";document.querySelector("[data-tpl-filter]").value="mysql";document.querySelector("[data-tpl-filter]").dispatchEvent(new Event("change"))');
    check('按方言筛选模板', await ev('document.querySelector(".tpl-item strong").textContent') === '选区模板');
    await clickTpl('export');
    const subset = JSON.parse(await ev('window.__downloads.at(-1).blob.text()'));
    check('导出范围遵循当前筛选且包含版本信息', subset.format === 'sqltool-templates' && subset.version === 1 && subset.templates.length === 1 && subset.templates[0].name === '选区模板');
    await ev('document.querySelector("[data-tpl-filter]").value="";document.querySelector("[data-tpl-filter]").dispatchEvent(new Event("change"))');
    await selectTemplate('编码查询'); await clickTpl('copy');
    await fields({ name: '查询副本' }); await ev('document.querySelector(".template-editor [data-ok]").click()');
    await wait('document.querySelectorAll(".tpl-item").length===3 && !document.querySelector(".template-editor")', '复制模板');
    check('复制模板创建独立记录并保留正文', (await list()).find(t => t.name === '查询副本').sql === raw);
    await selectTemplate('查询副本'); await clickTpl('edit'); await fields({ name: '查询副本已编辑', sql: 'SELECT 42 AS answer;' });
    await ev('document.querySelector(".template-editor [data-ok]").click()');
    await wait('!document.querySelector(".template-editor") && document.querySelector("[data-tpl-title]").textContent==="查询副本已编辑"', '编辑模板');
    check('编辑模板更新原记录且不覆盖其他模板', (await list()).length === 3 && (await list()).find(t => t.name === '查询副本已编辑').revision === 2 && (await list()).find(t => t.name === '编码查询').sql === raw);
    await clickTpl('delete'); await ev('Array.from(document.querySelectorAll(".mask.show")).at(-1).querySelector("[data-cancel]").click()');
    check('取消删除保留模板', (await list()).length === 3);
    await clickTpl('delete'); await ev('Array.from(document.querySelectorAll(".mask.show")).at(-1).querySelector("[data-ok]").click()');
    await wait('document.querySelectorAll(".tpl-item").length===2', '删除模板');
    check('确认删除只移除指定模板', (await list()).length === 2 && !(await list()).some(t => t.name === '查询副本已编辑'));

    await selectTemplate('编码查询'); await clickTpl('edit');
    await fields({ name: '' }); await ev('document.querySelector(".template-editor [data-ok]").click()');
    await wait('document.querySelector(".template-editor [data-tpl-error]").textContent.includes("名称")', '表单校验');
    check('表单校验失败保留编辑窗口', (await list()).length === 2);
    await close(form);
    await clickTpl('edit');
    await ev('(async()=>{const t=(await SqlTool.Templates.store.list()).find(t=>t.name==="编码查询");await SqlTool.Templates.store.save({...t,description:"另一页面的修改"},t);})()');
    await fields({ description: '过期窗口的修改' }); await ev('document.querySelector(".template-editor [data-ok]").click()');
    await wait('document.querySelector(".template-editor [data-tpl-error]").textContent.includes("其他页面")', '并发编辑冲突');
    check('旧编辑窗口不能覆盖较新的模板', (await list()).find(t => t.name === '编码查询').description === '另一页面的修改');
    await close(form); await clickTpl('refresh');

    const imported = { format: 'sqltool-templates', version: 1, templates: [
      { name: '<img src=x onerror="window.__xss=1">', sql: "SELECT '<script>window.__xss=1</script>';", dialect: 'all', tags: ['导入'], description: '<b>纯文本说明</b>' },
      { name: '导入中文', sql: 'SELECT 你好;', dialect: 'postgres', tags: [] }
    ] };
    await importFile('\ufeff' + JSON.stringify(imported));
    check('真实 JSON 文件支持 BOM 和中文并追加导入', (await list()).length === 4);
    await selectTemplate(imported.templates[0].name);
    check('模板名称、说明及 SQL 作为文本显示', await ev('document.querySelector("[data-tpl-title]").textContent') === imported.templates[0].name && !await ev('!!window.__xss || !!document.querySelector(".template-library .tpl-detail img")'));
    await importFile(JSON.stringify(imported));
    check('重复导入跳过完全相同模板', (await list()).length === 4);
    await importFile(JSON.stringify({ ...imported, templates: [{ ...imported.templates[1], sql: 'SELECT 2;' }] }));
    check('同名但内容不同的模板作为新记录保留', (await list()).filter(t => t.name === '导入中文').length === 2);
    const beforeInvalid = (await list()).length;
    for (const [label, text] of [
      ['非法 JSON', '{broken'], ['错误文件类型', JSON.stringify({ connections: [] })],
      ['未知版本', JSON.stringify({ ...imported, version: 2 })],
      ['整个批次校验', JSON.stringify({ ...imported, templates: [{name:'不应部分写入',sql:'SELECT 1;'}, {name:'坏数据',sql:12}] })],
      ['非法方言', JSON.stringify({ ...imported, templates: [{name:'非法方言',sql:'SELECT 1;',dialect:'__proto__'}] })]
    ]) {
      await importFile(text);
      check('拒绝' + label + '且无部分写入', (await list()).length === beforeInvalid && !!await ev('document.querySelector("[data-tpl-error]").textContent'));
    }
    check('模板数量上限校验', !!await rejected('SqlTool.Templates.store.importItems(Array.from({length:1001},()=>({name:"超限",sql:"SELECT 1;"})))'));
    check('SQL 长度上限校验', !!await rejected('SqlTool.Templates.store.save({name:"超长",sql:"a".repeat(500001)})'));
    check('标签类型校验', !!await rejected('SqlTool.Templates.store.save({name:"错误标签",sql:"SELECT 1;",tags:[123]})'));
    check('拒绝含分隔逗号的单个标签，避免编辑后改变标签含义', !!await rejected('SqlTool.Templates.store.save({name:"逗号标签",sql:"SELECT 1;",tags:["财务,订单"]})'));
    check('文件大小上限校验', !!await rejected('SqlTool.Templates.parseImport(" ".repeat(10*1024*1024+1))'));
    await clickTpl('export'); const backup = await ev('window.__downloads.at(-1).blob.text()');
    check('导出 JSON 包含完整 SQL 原文', JSON.parse(backup).templates.some(t => t.sql === raw));
    await importFile(backup); check('备份文件重新导入不会制造重复记录', (await list()).length === beforeInvalid);

    await clickTpl('new'); await fields({ name: '取消的新模板', sql: 'SELECT 1;' }); await close(form);
    check('取消新建不会写入模板', (await list()).length === beforeInvalid);
    await ev('document.querySelector("[data-tpl-filter]").value="mysql";document.querySelector("[data-tpl-filter]").dispatchEvent(new Event("change"))');
    await clickTpl('new'); await fields({ name: '手动新建模板', sql: 'SELECT 88 AS manual;', dialect: 'sqlite' });
    fs.mkdirSync(path.join(ROOT, 'shots'), { recursive: true });
    const formShot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ROOT, 'shots', 'templates-editor.png'), Buffer.from(formShot.result.data, 'base64'));
    await ev('document.querySelector(".template-editor [data-tpl-sql]").dispatchEvent(new KeyboardEvent("keydown",{key:"s",ctrlKey:true,bubbles:true,cancelable:true}))');
    await wait('!document.querySelector(".template-editor") && document.querySelector("[data-tpl-title]").textContent==="手动新建模板"', '新建后显示模板');
    check('模板库直接新建及 Ctrl+S 保存', (await list()).some(t => t.name === '手动新建模板' && t.sql === 'SELECT 88 AS manual;'));
    check('新建后显示保存的模板，不被旧筛选隐藏', await ev('document.querySelector("[data-tpl-filter]").value') === '');
    const conflict = await ev(`(async()=>{
      const s=SqlTool.Templates.store,original=(await s.list()).find(t=>t.name==='手动新建模板');
      const results=await Promise.allSettled([s.save({...original,description:'并发一'},original),s.save({...original,description:'并发二'},original)]);
      let deleted=false;try{await s.remove(original);deleted=true;}catch(e){}
      return {passed:results.filter(r=>r.status==='fulfilled').length,failed:results.filter(r=>r.status==='rejected').length,deleted};
    })()`);
    check('同时保存同一模板仅接受一个版本', conflict.passed === 1 && conflict.failed === 1);
    check('旧版本删除请求不能删除已更新模板', !conflict.deleted && (await list()).some(t => t.name === '手动新建模板'));
    await clickTpl('refresh');

    await selectTemplate('编码查询');
    fs.mkdirSync(path.join(ROOT, 'shots'), { recursive: true });
    for (const theme of ['dark', 'light']) {
      await ev(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(ROOT, 'shots', 'templates-' + theme + '.png'), Buffer.from(shot.result.data, 'base64'));
      check(theme + ' 主题模板窗口无水平溢出', await ev('(()=>{const m=document.querySelector(".template-library .modal");return m.scrollWidth<=m.clientWidth+2})()'));
    }
    await close(lib);
    await setEditor('SELECT 1;\nSELECT 2;', 9);
    await openLibrary(); await selectTemplate('编码查询'); await clickTpl('insert');
    check('在原光标处插入且保留前后 SQL', await ev('document.getElementById("sql").value') === 'SELECT 1;' + raw + '\nSELECT 2;');
    await setEditor('AAA SELECT 0; BBB', 4, 13);
    await openLibrary(); await selectTemplate('编码查询');
    check('存在选区时明确显示替换操作', await ev('document.querySelector("[data-tpl-insert]").textContent') === '替换选中 SQL');
    await clickTpl('insert');
    check('替换选区保留其余正文', await ev('document.getElementById("sql").value') === 'AAA ' + raw + ' BBB');
    await openLibrary(); await selectTemplate('编码查询'); await setEditor('新编辑内容'); await clickTpl('insert');
    check('编辑器变化后拒绝过期插入', await ev('document.getElementById("sql").value') === '新编辑内容' && await ev('document.querySelector("[data-tpl-error]").textContent.includes("已变化")'));
    await close(lib);
    await openLibrary(); await selectTemplate('编码查询'); await action('new-query'); await clickTpl('insert');
    check('切换查询标签后拒绝写入错误文档', await ev('document.getElementById("sql").value') === '' && await ev('document.querySelector("[data-tpl-error]").textContent.includes("已变化")'));
    await close(lib);

    await newConn('模板库A'); await sql('CREATE TABLE marker(value TEXT);');
    await newConn('模板库B'); await sql('CREATE TABLE marker(value TEXT);');
    await ev('Array.from(document.querySelectorAll("#tree .node")).find(n=>n.dataset.type==="conn"&&n.dataset.name==="模板库A").click()');
    await setEditor('SELECT 77 AS original;');
    const oldDoc = await ev('document.querySelector("#docTabs .active").dataset.id');
    await ev('SqlTool.Templates.store.save({name:"执行目标测试",sql:"INSERT INTO marker VALUES (\'来自模板\');",dialect:"sqlite"})');
    await openLibrary(); await selectTemplate('执行目标测试');
    check('模板库显示当前连接', await ev('document.querySelector("[data-tpl-target]").textContent.includes("模板库A")'));
    await clickTpl('open');
    check('新标签页打开模板并保留旧页', await ev('document.querySelector("#docTabs .active .t-name").textContent') === '执行目标测试.sql' && await ev('document.getElementById("sql").value') === "INSERT INTO marker VALUES ('来自模板');");
    await ev(`document.querySelector('#docTabs [data-id="${oldDoc}"]').click()`);
    check('原标签页 SQL 未被修改', await ev('document.getElementById("sql").value') === 'SELECT 77 AS original;');
    await sql('SELECT COUNT(*) AS c FROM marker;');
    check('打开模板不会自动执行 SQL', await ev('document.querySelector("#resBody tbody td:nth-child(2)").textContent') === '0');
    await ev('Array.from(document.querySelectorAll("#tree .node")).find(n=>n.dataset.type==="conn"&&n.dataset.name==="模板库B").click()');
    await ev('Array.from(document.querySelectorAll("#docTabs .doc-tab")).find(n=>n.querySelector(".t-name").textContent==="执行目标测试.sql").click()');
    await sql(await ev('document.getElementById("sql").value'));
    await sql('SELECT COUNT(*) AS c FROM marker;');
    check('手动执行使用工作台当前 B 连接', await ev('document.querySelector("#resBody tbody td:nth-child(2)").textContent') === '1');
    await ev('Array.from(document.querySelectorAll("#tree .node")).find(n=>n.dataset.type==="conn"&&n.dataset.name==="模板库A").click()');
    await sql('SELECT COUNT(*) AS c FROM marker;');
    check('切换执行目标不会写入 A 连接', await ev('document.querySelector("#resBody tbody td:nth-child(2)").textContent') === '0');
    check('模板操作不写服务端连接配置', await ev('window.__savedWrites === 0'));
    const capacity = await ev(`(async()=>{
      const s=SqlTool.Templates.store,count=(await s.list()).length;
      await s.importItems(Array.from({length:1000-count},(_,i)=>({name:'容量模板'+i,sql:'SELECT '+i+';'})));
      let rejected=false;try{await s.importItems([{name:'不能部分导入一',sql:'SELECT 1;'}, {name:'不能部分导入二',sql:'SELECT 2;'}]);}catch(e){rejected=true;}
      const rows=await s.list();return {rejected,count:rows.length,partial:rows.some(r=>r.name.startsWith('不能部分导入'))};
    })()`);
    check('库总容量超限时整批导入回滚', capacity.rejected && capacity.count === 1000 && !capacity.partial);
    check('库满时拒绝新建且保留已有记录', !!await rejected('SqlTool.Templates.store.save({name:"库满后新建",sql:"SELECT 1;"})') && (await list()).length === 1000);
    check('模板完整流程无未捕获异常', errors.length === 0, errors);
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
      if (resolved.startsWith(root) && path.basename(resolved).startsWith('sqltool-template-ui-')) {
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
    fs.writeFileSync(path.join(reportDir, 'template-results.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify({ passed:report.passed,failed:report.failed,serverStopped:report.serverStopped,chromeStopped:report.chromeStopped,profileRemoved:report.profileRemoved,fatalError:report.fatalError },null,2));
  }
})();
