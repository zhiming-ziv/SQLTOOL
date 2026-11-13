// 串行运行 多语言功能测试：node tools/i18n-test.js；可用 CHROME_BIN 指定 Chrome。
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
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sqltool-i18n-ui-'));
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
    const change = locale => ev(`(()=>{const el=document.querySelector('.mask.show [data-language-select]')||document.querySelector('[data-language-select]');el.value=${JSON.stringify(locale)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    const close = () => ev(`Array.from(document.querySelectorAll('.mask.show')).pop().querySelector('[data-cancel]').click()`);
    async function setSql(value, start = 0, end = start) {
      await ev(`(()=>{const e=document.getElementById('sql');e.value=${JSON.stringify(value)};e.setSelectionRange(${start},${end});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    }
    async function query(value, failed = false) {
      await setSql(value); await ev(`document.getElementById('sbStatus').dataset.queryState=''`); await action('execute');
      await wait(`['success','error'].includes(document.getElementById('sbStatus').dataset.queryState)`, '查询返回');
      check('SQL 执行状态与预期一致', await ev(`document.getElementById('sbStatus').dataset.queryState`) === (failed ? 'error' : 'success'));
    }
    async function createConnection(name, remote = false) {
      await action('new-conn');
      if (remote) await ev(`document.querySelector('[data-driver="sqlite"]').click()`);
      await ev(`document.getElementById('fName').value=${JSON.stringify(name)};if(document.getElementById('fPersist'))document.getElementById('fPersist').value='1';document.querySelector('.mask.show [data-ok]').click()`);
      await wait(`document.getElementById('sbConn').textContent===${JSON.stringify(name)} && !document.getElementById('overlay').classList.contains('show')`, '创建连接');
    }
    const dictionaries = ['zh-CN','zh-TW','en'].map(l => require('../app/js/locales/'+l));
    const keys = Object.keys(dictionaries[0]).sort();
    check('三个语言包的词条键完全一致', dictionaries.every(d=>JSON.stringify(Object.keys(d).sort())===JSON.stringify(keys)), {keys:keys.length});
    const placeholders = text => (text.match(/\{[a-zA-Z]\w*\}/g)||[]).sort().join('|');
    check('全部词条的参数数量与名称一致', keys.every(k=>dictionaries.every(d=>placeholders(d[k])===placeholders(dictionaries[0][k]))));
    const missing = [];
    for (const file of ['app/js/app.js','app/js/templates.js','app/js/engine.js']) {
      for (const match of fs.readFileSync(path.join(ROOT,file),'utf8').matchAll(/\bI\.t\(["']([^"']+)["']/g)) if (!(match[1] in dictionaries[0])) missing.push(match[1]);
    }
    check('运行时代码引用的词条全部存在', missing.length===0,missing);
    check('英文包没有漏译的中文文案', !Object.values(dictionaries[2]).some(s=>/\p{Script=Han}/u.test(s)));
    check('繁体包保留图标与特殊符号', keys.every(k=>(dictionaries[0][k].match(/[▶✓✗✎🔒]/gu)||[]).join('')===(dictionaries[1][k].match(/[▶✓✗✎🔒]/gu)||[]).join('')));
    const structures = await ev(`(()=>{const ds=SqlToolI18n.dictionaries;const shape=s=>{const t=document.createElement('template');t.innerHTML=s;return Array.from(t.content.querySelectorAll('*')).map(e=>[e.tagName,Array.from(e.attributes).filter(a=>!['title','placeholder','aria-label'].includes(a.name)&&!(e.tagName==='INPUT'&&a.name==='value')).map(a=>a.name+'='+a.value).join('|')]);};return Object.keys(ds['zh-CN']).filter(k=>['zh-TW','en'].some(l=>JSON.stringify(shape(ds[l][k]))!==JSON.stringify(shape(ds['zh-CN'][k]))));})()`);
    check('HTML 词条的元素及行为属性结构一致',structures.length===0,structures);
    check('默认语言为简体中文',await ev(`SqlToolI18n.locale==='zh-CN' && document.documentElement.lang==='zh-CN'`));
    await ev(`window.__execCount=0;const exec=SqlTool.engines.sqlite.prototype.exec;SqlTool.engines.sqlite.prototype.exec=function(){window.__execCount++;return exec.apply(this,arguments);}`);
    const locales=['zh-CN','zh-TW','en'], labels=['模板库','範本庫','Templates'];
    for(let index=0;index<locales.length;index++){
      const locale=locales[index], next=locales[(index+1)%3];
      await change(locale);
      check(locale+' 静态文案、页面 lang 和选择器同步',await ev(`document.querySelector('[data-action="templates"].tpl-entry').textContent===${JSON.stringify(labels[index])} && document.documentElement.lang===${JSON.stringify(locale)} && Array.from(document.querySelectorAll('[data-language-select]')).every(e=>e.value===${JSON.stringify(locale)})`));
      await action('new-conn');
      await ev(`window.__field=document.getElementById('fName');__field.value='用户数据库 <保留>';__field.focus();__field.setSelectionRange(1,4);window.__fieldSelection=[__field.selectionStart,__field.selectionEnd];`);
      await change(next);
      check(locale+' 连接弹窗切换保留 DOM、输入及选区',await ev(`document.getElementById('fName')===__field && __field.value==='用户数据库 <保留>' && JSON.stringify([__field.selectionStart,__field.selectionEnd])===JSON.stringify(__fieldSelection)`));
      check(locale+' 连接弹窗按钮即时翻译',await ev(`document.querySelector('.mask [data-test]').textContent`)==={'zh-CN':'测试连接','zh-TW':'測試連線',en:'Test connection'}[next]);
      await close();await change(locale);
      await createConnection('测试连接-'+locale);
      await query(`CREATE TABLE items(id INTEGER PRIMARY KEY, label TEXT NOT NULL, amount INTEGER); INSERT INTO items VALUES(1, '数据库 模板 连接', 12345); SELECT * FROM items;`);
      const editor=await ev(`document.getElementById('sql').value`),grid=await ev(`document.querySelector('#resBody tbody').textContent`);
      await ev(`window.__grid=document.querySelector('#resBody table');window.__count=__execCount;document.getElementById('sql').setSelectionRange(3,11);`);
      await change(next);
      check(locale+' 切换不执行查询、不重建结果网格、不修改 SQL',await ev(`__count===__execCount && __grid===document.querySelector('#resBody table') && document.getElementById('sql').value===${JSON.stringify(editor)} && document.getElementById('sql').selectionStart===3 && document.querySelector('#resBody tbody').textContent===${JSON.stringify(grid)}`));
      await ev(`document.querySelector('[data-res="msg"]').click()`);
      check(locale+' 已有结果说明随语言变化',await ev(`document.getElementById('resBody').textContent.includes(${JSON.stringify({'zh-CN':'查询成功','zh-TW':'查詢成功',en:'Query succeeded'}[next])})`));
      await change(locale);
      await query('SELECT * FROM missing_i18n_table;',true);
      const rawError=await ev(`document.querySelector('#resBody .err:last-child').textContent`);
      await change(next);
      check(locale+' 数据库原始错误保留且外层提示翻译',await ev(`document.getElementById('resBody').textContent.includes(${JSON.stringify(rawError)}) && document.getElementById('resBody').textContent.includes(${JSON.stringify({'zh-CN':'执行失败','zh-TW':'執行失敗',en:'Execution failed'}[next])})`));
      await change(locale);
      await setSql("-- 未保存 中文 SQL\nSELECT '00123' AS code;",4,10);await action('save-template');
      await ev(`window.__form=document.querySelector('.template-editor');__form.querySelector('[data-tpl-name]').value='自定义模板-${locale}';__form.querySelector('[data-tpl-description]').value='用户说明保持不变';__form.querySelector('[data-tpl-sql]').value="SELECT '数据库' AS label;";`);
      await change(next);
      check(locale+' 模板表单切换保留未保存内容',await ev(`__form===document.querySelector('.template-editor') && __form.querySelector('[data-tpl-description]').value==='用户说明保持不变' && __form.querySelector('[data-tpl-sql]').value==="SELECT '数据库' AS label;"`));
      await ev(`document.querySelector('.template-editor [data-ok]').click()`);await wait(`!document.querySelector('.template-editor')`,'保存模板');
      await action('templates');await wait(`!!document.querySelector('.tpl-item')`,'打开模板库');
      await ev(`Array.from(document.querySelectorAll('.tpl-item')).find(e=>e.querySelector('strong').textContent==='自定义模板-${locale}').click();window.__preview=document.querySelector('[data-tpl-preview]').textContent;window.__time=document.querySelector('[data-tpl-meta]').textContent;document.querySelector('[data-tpl-search]').value='自定义';document.querySelector('[data-tpl-search]').dispatchEvent(new Event('input'));`);
      await change(locale);
      check(locale+' 模板正文、名称和筛选条件原样保留',await ev(`document.querySelector('[data-tpl-preview]').textContent===__preview && document.querySelector('[data-tpl-search]').value==='自定义' && document.querySelector('[data-tpl-title]').textContent==='自定义模板-${locale}'`));
      check(locale+' 模板方言与更新时间实时翻译',await ev(`document.querySelector('[data-tpl-filter] option').textContent===${JSON.stringify(locale==='en'?'All dialects':'全部方言')} && document.querySelector('[data-tpl-meta]').textContent!==__time`));
      await ev(`document.querySelector('[data-tpl-export]').click()`);
      check(locale+' 导出的模板正文未翻译',await ev(`(async()=>{const d=__downloads[__downloads.length-1];const j=JSON.parse(await d.blob.text());return JSON.stringify(j).includes('数据库')&&JSON.stringify(j).includes('自定义模板-${locale}');})()`));
      await close();
      await action('refresh');await wait(`!!document.querySelector('#tree .node[data-name="items"]')`,'刷新对象树');
      await ev(`document.getElementById('sbStatus').dataset.queryState='';document.querySelector('#tree .node[data-name="items"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
      await wait(`document.getElementById('sbStatus').dataset.queryState==='success'`,'打开表数据');
      check(locale+' 空过程与函数不会产生错误计数',await ev(`document.getElementById('sbObjects').textContent`)==={'zh-CN':'1 表 / 0 视图','zh-TW':'1 資料表 / 0 檢視表',en:'Tables: 1 / Views: 0'}[locale]);
      await ev(`document.querySelector('#resBody tbody td[data-col="1"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));window.__cellInput=document.querySelector('#resBody input');__cellInput.value='正在编辑 尚未提交';__cellInput.setSelectionRange(1,5);`);
      // 直接调用语言层，避免点击选择器触发原有的单元格失焦提交。
      await ev(`SqlToolI18n.setLocale(${JSON.stringify(next)})`);
      check(locale+' 切换语言保留正在编辑的单元格',await ev(`__cellInput===document.querySelector('#resBody input') && __cellInput.value==='正在编辑 尚未提交' && __cellInput.selectionStart===1 && document.activeElement===__cellInput`));
      await ev(`__cellInput.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
      await change(locale);
      await ev(`document.getElementById('btnRowAdd').click()`);await wait(`!!document.querySelector('.add-form')`,'新增行表单');
      await ev(`window.__add=document.querySelector('.add-form');__add.querySelector('[data-col="label"] .add-val').value='未保存的新行';`);
      await change(next);
      check(locale+' 新增行弹窗保留输入并翻译必填标签',await ev(`__add===document.querySelector('.add-form') && __add.querySelector('[data-col="label"] .add-val').value==='未保存的新行' && __add.textContent.includes(${JSON.stringify({'zh-CN':'必填','zh-TW':'必填',en:'Required'}[next])})`));
      await close();await change(locale);
      await action('about');
      for(const theme of ['dark','light']){
        await ev(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
        check(locale+' / '+theme+' 弹窗及语言选择器无横向溢出',await ev(`(()=>{const m=document.querySelector('.mask .modal');const s=m.querySelector('[data-language-select]').getBoundingClientRect();return m.scrollWidth<=m.clientWidth+2 && s.right<=m.getBoundingClientRect().right;})()`));
      }
      await close();
    }
    await change('en');
    const apiError=await ev(`(async()=>{try{await SqlTool.api('/api/query',{connId:'missing',sql:'SELECT 1'});}catch(e){window.__apiError=e;return e.message;}})()`);
    check('服务端会话错误显示英文',apiError==='Connection missing or expired. Reconnect to continue.');
    await change('zh-TW');check('已获取的服务端错误保留可翻译信息',await ev(`__apiError.message.includes('連線') && !__apiError.message.includes('连接')`));
    await change('en');await createConnection('服务端连接',true);await query('SELECT 42 AS answer;');
    check('服务端 SQLite 引擎名称翻译',await ev(`document.getElementById('sbEngine').textContent.includes('server file')`));
    await query('SELECT * FROM native_missing_table;',true);
    check('真实服务端 SQLite 错误原样显示',await ev(`document.getElementById('resBody').textContent.includes('no such table: native_missing_table')`));
    const fake=require('../server/messages');
    const nested=fake.packet(fake.make('api.schemaFailed',{detail:fake.make('driver.databaseFailed',{database:'测试库',detail:new Error('native error 保留')})}));
    check('嵌套自有错误翻译且保留库名和原始错误',await ev(`String(SqlToolI18n.fromError(${JSON.stringify(nested)}))`)==='Failed to read schema: Cannot connect to database “测试库”: native error 保留');
    check('未知错误键回退原文',await ev(`SqlToolI18n.fromError({errorKey:'future.unknown',error:'original 中文'})==='original 中文'`));
    await action('templates');await wait(`!!document.querySelector('.tpl-item')`,'截图前模板库');
    for(const width of [1280,1600]){
      await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
      for(const locale of locales){await change(locale);
        check(locale+' / '+width+' 模板窗口无横向溢出',await ev(`(()=>{const m=document.querySelector('.template-library .modal');return m.scrollWidth<=m.clientWidth+2;})()`));
        const shot=await send('Page.captureScreenshot',{format:'png'});fs.mkdirSync(path.join(ROOT,'shots'),{recursive:true});fs.writeFileSync(path.join(ROOT,'shots','i18n-'+locale+'-'+width+'.png'),Buffer.from(shot.result.data,'base64'));
      }
    }
    await close();await change('en');
    const saved=await ev(`(async()=>JSON.stringify(await SqlTool.Templates.store.list()))()`);
    await ev('window.__staleDoc=1');await send('Page.reload');await wait('!window.__staleDoc && window.__booted === true','语言偏好刷新恢复');
    check('刷新保留英文偏好与全部模板',await ev(`(async()=>SqlToolI18n.locale==='en' && document.documentElement.lang==='en' && JSON.stringify(await SqlTool.Templates.store.list())===${JSON.stringify(saved)})()`));
    await ev('window.__staleDoc=1');await send('Page.navigate',{url:base+'/'});await wait(`!window.__staleDoc && !!window.SqlToolI18n`,'入口页');
    check('入口页沿用同源语言偏好',await ev(`document.title==='SQLTool — Browser Database Workbench'`));
    await change('zh-TW');check('入口页可即时切换繁体中文',await ev(`document.title.includes('資料庫')`));
    await ev(`localStorage.setItem('sqltool.language','invalid')`);await ev('window.__staleDoc=1');await send('Page.reload');await wait(`!window.__staleDoc && !!window.SqlToolI18n`,'非法偏好回退');
    check('未知语言偏好回退简体中文',await ev(`SqlToolI18n.locale==='zh-CN' && SqlToolI18n.setLocale('fr')===false`));
    await send('Page.addScriptToEvaluateOnNewDocument',{source:`Storage.prototype.getItem=function(){throw new Error('blocked')};Storage.prototype.setItem=function(){throw new Error('blocked')};`});
    await ev('window.__staleDoc=1');await send('Page.reload');await wait('!window.__staleDoc && !!window.SqlToolI18n','禁用本地存储后初始化');
    await change('en');check('禁用本地存储仍可切换语言',await ev(`document.documentElement.lang==='en' && document.title==='SQLTool — Browser Database Workbench'`));
    check('缺失译文回退简体中文',await ev(`(()=>{const key='app.language',value=SqlToolI18n.dictionaries.en[key];delete SqlToolI18n.dictionaries.en[key];const text=String(SqlToolI18n.t(key));SqlToolI18n.dictionaries.en[key]=value;return text==='界面语言';})()`));
    check('多语言完整流程无未捕获异常',errors.length===0,errors);

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
      if (resolved.startsWith(root) && path.basename(resolved).startsWith('sqltool-i18n-ui-')) {
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
    fs.writeFileSync(path.join(reportDir, 'i18n-results.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify({ passed:report.passed,failed:report.failed,serverStopped:report.serverStopped,chromeStopped:report.chromeStopped,profileRemoved:report.profileRemoved,fatalError:report.fatalError },null,2));
  }
})();
