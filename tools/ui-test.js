/**
 * ui-test.js — 端到端驱动真实 UI：建连接 → 执行 SQL → 打开表 → 编辑单元格 → 截图
 * 用法: node tools/ui-test.js
 */
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.argv[2] || 'http://127.0.0.1:8777';
const PORT = 9500 + Math.floor(Math.random() * 300);
const OUT_DIR = path.resolve(__dirname, '..', 'shots');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; log('  PASS ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
}

function httpGet(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const profile = path.join(os.tmpdir(), 'cdp-ui-' + Date.now());
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--hide-scrollbars', '--window-size=1600,900',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    BASE + '/app/index.html'
  ], { stdio: 'ignore' });

  let page = null;
  for (let i = 0; i < 80; i++) {
    try { const l = await httpGet('/json'); page = (l || []).find(t => t.type === 'page' && t.webSocketDebuggerUrl); if (page) break; } catch (e) { }
    await sleep(250);
  }
  if (!page) { console.error('DevTools 连接失败'); chrome.kill(); process.exit(3); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const errs = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push((m.params.args || []).map(a => a.value || a.description || '').join(' '));
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });

  const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  await send('Runtime.enable'); await send('Page.enable');

  async function ev(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return { err: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text };
    return { v: r.result?.result?.value };
  }
  async function shot(name) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (r.result && r.result.data) {
      fs.writeFileSync(path.join(OUT_DIR, name), Buffer.from(r.result.data, 'base64'));
      log('  · 截图 ' + name);
    }
  }
  async function waitFor(expr, ms, label) {
    const end = Date.now() + (ms || 15000);
    while (Date.now() < end) {
      const r = await ev(expr);
      if (r.v) return true;
      await sleep(250);
    }
    log('  ! 等待超时: ' + (label || expr));
    return false;
  }

  log('\n=== SQLTool 端到端 UI 测试 ===\n');

  /* --- 1. 页面启动 --- */
  log('[1] 页面启动');
  // 用 window.__booted 判断初始化结束：#sbStatus 的静态初值就是「就绪」，
  // 靠它判断会在冷启动（首次运行、WASM 无缓存）时抢跑。
  const booted = await waitFor('window.__booted === true', 40000, 'boot');
  check('页面完成初始化', booted);
  check('引擎已加载（overlay 已隐藏）', (await ev('!document.getElementById("overlay").classList.contains("show")')).v === true);
  const emptyTreeTxt = String((await ev('(document.getElementById("tree")||{}).textContent || ""')).v || '');
  check('未连接时显示引导文案', emptyTreeTxt.includes('尚未建立任何连接'),
    '树内容=' + JSON.stringify(emptyTreeTxt.slice(0, 120)));
  await shot('01-初始状态.png');

  /* --- 2. 通过对话框新建连接 --- */
  log('\n[2] 新建连接（走真实对话框）');
  await ev('document.querySelector(\'[data-action="new-conn"]\').click()');
  check('连接对话框已弹出', (await ev('!!document.querySelector(".mask.show")')).v === true);
  await shot('02-新建连接对话框.png');
  await ev('document.getElementById("fName").value = "业务数据库"');
  await ev('document.querySelector(".mask.show [data-ok]").click()');
  const connected = await waitFor('document.querySelectorAll("#tree .node").length > 0', 20000, 'connection');
  check('连接创建成功', connected);
  check('状态栏显示连接名', (await ev('document.getElementById("sbConn").textContent')).v === '业务数据库');
  check('状态栏显示引擎', (await ev('document.getElementById("sbEngine").textContent')).v === 'SQLite');
  const toastTxt = (await ev('document.getElementById("toast").textContent')).v;
  const toastErr = (await ev('document.getElementById("toast").classList.contains("err")')).v;
  check('空数据库建连无报错提示', toastErr === false, '提示=' + toastTxt);
  check('对象树正确渲染空库', (await ev('document.getElementById("tree").textContent.includes("（空）")')).v === true);

  /* --- 3. 执行建表 + 插入 + 查询 --- */
  log('\n[3] 执行真实 SQL（DDL + DML + SELECT）');
  const SQL = `CREATE TABLE employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  dept TEXT,
  salary REAL,
  hired TEXT
);
INSERT INTO employees (name, dept, salary, hired) VALUES
 ('张伟','研发',28000,'2021-03-15'),
 ('李娜','市场',19500,'2022-07-01'),
 ('王强','研发',34200,'2020-11-20'),
 ('赵敏','财务',16800,'2023-01-09'),
 ('陈磊','研发',25600,'2022-05-18');
CREATE INDEX idx_emp_dept ON employees(dept);
SELECT dept, COUNT(*) AS 人数, ROUND(AVG(salary),2) AS 平均薪资, MAX(salary) AS 最高薪资
FROM employees GROUP BY dept ORDER BY 平均薪资 DESC;`;
  await ev('document.getElementById("sql").value = ' + JSON.stringify(SQL));
  await ev('document.getElementById("sql").dispatchEvent(new Event("input",{bubbles:true}))');
  await ev('document.querySelector(\'[data-action="execute"]\').click()');
  const hasGrid = await waitFor('!!document.querySelector("#resBody table.grid tbody tr")', 15000, 'grid');
  check('结果网格已渲染', hasGrid);

  const grid = (await ev(`(()=>{
    const t = document.querySelector('#resBody table.grid');
    if(!t) return null;
    const head = Array.from(t.querySelectorAll('thead th')).map(x=>x.textContent.trim());
    const rows = Array.from(t.querySelectorAll('tbody tr')).map(tr=>Array.from(tr.querySelectorAll('td')).slice(1).map(td=>td.textContent.trim()));
    return JSON.stringify({head, rows, msg: document.querySelector('#resBody')? '' : ''});
  })()`)).v;
  const g = JSON.parse(grid);
  log('    表头: ' + JSON.stringify(g.head));
  log('    数据: ' + JSON.stringify(g.rows));
  check('聚合列名正确', g.head.join('|').includes('dept') && g.head.join('|').includes('人数') && g.head.join('|').includes('平均薪资'));
  check('聚合行数 = 3 个部门', g.rows.length === 3, '实际 ' + g.rows.length);
  check('研发部平均薪资正确', g.rows.some(r => r[0] === '研发' && r[2] === '29266.67'), JSON.stringify(g.rows.find(r => r[0] === '研发')));
  check('行数徽章正确', (await ev('document.getElementById("rowCnt").textContent')).v === '3');
  await shot('03-查询结果.png');

  /* --- 4. 刷新后对象树出现真实表 --- */
  log('\n[4] 对象资源管理器读取真实 schema');
  await ev('document.querySelector(\'[data-action="refresh"]\').click()');
  await sleep(600);
  const treeTxt = (await ev('document.getElementById("tree").textContent')).v;
  check('对象树出现 employees 表', treeTxt.includes('employees'));
  check('对象树出现索引节点', treeTxt.includes('idx_emp_dept'));
  check('对象树统计到 1 张表', treeTxt.includes('表 (1)'), '');

  /* --- 5. 双击表名打开数据 --- */
  log('\n[5] 双击表名 → 打开表数据');
  await ev(`(()=>{
    const nodes = Array.from(document.querySelectorAll('#tree .node'));
    const n = nodes.find(x => (x.dataset.name||'') === 'employees');
    if(!n) return 'notfound';
    n.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
    return 'ok';
  })()`);
  const tableGrid = await waitFor('(()=>{const t=document.querySelector("#resBody table.grid"); return t && t.querySelectorAll("tbody tr").length===5})()', 15000, 'table data');
  check('表数据加载 5 行', tableGrid);
  const hasRowidCol = (await ev('document.querySelector("#resBody table.grid thead").textContent.includes("__rid")')).v;
  check('隐藏的 rowid 列未显示在表头', hasRowidCol === false);
  await shot('04-表数据.png');

  /* --- 6. 双击单元格编辑并写回数据库 --- */
  log('\n[6] 双击单元格 → 编辑 → 写回数据库');
  const editRes = (await ev(`(async ()=>{
    const tr = document.querySelectorAll('#resBody table.grid tbody tr')[0];
    if(!tr) return 'no-row';
    const tds = Array.from(tr.querySelectorAll('td')).slice(1);
    const nameTd = tds[1];              // name 列
    nameTd.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
    await new Promise(r=>setTimeout(r,80));
    const inp = nameTd.querySelector('input');
    if(!inp) return 'no-input';
    inp.value = '张伟(已改)';
    inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    await new Promise(r=>setTimeout(r,500));
    return 'done';
  })()`)).v;
  check('单元格进入编辑态并提交', editRes === 'done', editRes);
  await sleep(400);

  // 直接查库确认写入
  await ev(`document.getElementById("sql").value = "SELECT name FROM employees WHERE id = 1;"`);
  await ev('document.querySelector(\'[data-action="execute"]\').click()');
  await waitFor('!!document.querySelector("#resBody table.grid tbody tr")', 10000);
  const dbVal = (await ev('document.querySelector("#resBody table.grid tbody tr td:nth-child(2)").textContent')).v;
  check('数据库中的值已真实更新', dbVal === '张伟(已改)', '实际=' + dbVal);

  /* --- 6b. 结果网格的「增 / 删」 --- */
  log('\n[6b] 结果网格：新增行 / 删除行');
  const openEmployees = async (expectRows) => {
    await ev(`(()=>{
      const n = Array.from(document.querySelectorAll('#tree .node')).find(x=>(x.dataset.name||'')==='employees');
      if(n) n.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
    })()`);
    return waitFor(
      `(()=>{const t=document.querySelector("#resBody table.grid"); return t && t.querySelectorAll("tbody tr").length===${expectRows}})()`,
      15000, 'table rows=' + expectRows);
  };

  await openEmployees(5);
  check('重新打开表后出现「新增行」入口',
    (await ev('getComputedStyle(document.getElementById("btnRowAdd")).display')).v !== 'none');
  check('出现「删除行」入口',
    (await ev('getComputedStyle(document.getElementById("btnRowDel")).display')).v !== 'none');
  const hintTxt = String((await ev('document.getElementById("editHint").textContent')).v || '');
  check('结果面板显示「可编辑」提示', /可编辑/.test(hintTxt) && /employees/.test(hintTxt), hintTxt);
  await shot('08-表编辑模式.png');

  await ev('document.getElementById("btnRowAdd").click()');
  const addDlg = await waitFor('!!document.querySelector(".mask.show .add-form")', 8000, 'add row dialog');
  check('新增行对话框弹出', addDlg);
  const addCols = String((await ev(
    'JSON.stringify(Array.from(document.querySelectorAll(".mask.show .add-row")).map(r=>r.dataset.col))')).v);
  check('对话框按真实表结构列出列',
    /id/.test(addCols) && /name/.test(addCols) && /salary/.test(addCols), addCols);
  // 校验：必填列勾选 NULL 应被拦住，并保留对话框（onOk 返回 true 时不关闭）
  await ev(`(()=>{
    const r = Array.from(document.querySelectorAll('.mask.show .add-row')).find(x=>x.dataset.col==='name');
    if(r) r.querySelector('.add-isnull').checked = true;
  })()`);
  await ev('document.querySelector(".mask.show [data-ok]").click()');
  await sleep(450);
  check('必填列填 NULL 被拦截且对话框保留',
    (await ev('!!document.querySelector(".mask.show .add-form")')).v === true);
  await ev(`(()=>{
    const r = Array.from(document.querySelectorAll('.mask.show .add-row')).find(x=>x.dataset.col==='name');
    if(r) r.querySelector('.add-isnull').checked = false;
  })()`);
  // 填写并截图（自增列 id 留空，交给数据库生成）
  await ev(`(()=>{
    const rows = Array.from(document.querySelectorAll('.mask.show .add-row'));
    const set = (n,v)=>{const r=rows.find(x=>x.dataset.col===n); if(r) r.querySelector('.add-val').value=v;};
    set('name','新人'); set('dept','测试'); set('salary','12345');
  })()`);
  await shot('09-新增行对话框.png');
  await ev('document.querySelector(".mask.show [data-ok]").click()');
  const added = await waitFor(
    '(()=>{const t=document.querySelector("#resBody table.grid"); return t && t.querySelectorAll("tbody tr").length===6})()',
    15000, 'row added');
  check('新增行后网格自动刷新为 6 行', added);
  await ev('document.getElementById("sql").value = "SELECT COUNT(*) AS c FROM employees;"');
  await ev('document.querySelector(\'[data-action="execute"]\').click()');
  await waitFor('!!document.querySelector("#resBody table.grid tbody tr")', 10000);
  const cntAdd = (await ev('document.querySelector("#resBody table.grid tbody tr td:nth-child(2)").textContent')).v;
  check('新增行已真实写入数据库（COUNT=6）', cntAdd === '6', 'COUNT=' + cntAdd);

  await openEmployees(6);
  await ev(`(()=>{
    const trs = document.querySelectorAll('#resBody table.grid tbody tr');
    trs[trs.length-1].dispatchEvent(new MouseEvent('click',{bubbles:true}));
  })()`);
  await sleep(200);
  check('行可被选中', (await ev('document.querySelectorAll("#resBody table.grid tbody tr.selected").length')).v === 1);
  await ev('document.getElementById("btnRowDel").click()');
  await waitFor('!!document.querySelector(".mask.show")', 6000, 'confirm delete');
  await ev('document.querySelector(".mask.show [data-ok]").click()');
  const deleted = await waitFor(
    '(()=>{const t=document.querySelector("#resBody table.grid"); return t && t.querySelectorAll("tbody tr").length===5})()',
    15000, 'row deleted');
  check('删除行后网格自动刷新为 5 行', deleted);
  await ev('document.getElementById("sql").value = "SELECT COUNT(*) AS c FROM employees WHERE name = \'新人\';"');
  await ev('document.querySelector(\'[data-action="execute"]\').click()');
  await waitFor('!!document.querySelector("#resBody table.grid tbody tr")', 10000);
  const cntDel = (await ev('document.querySelector("#resBody table.grid tbody tr td:nth-child(2)").textContent')).v;
  check('删除行已真实作用到数据库（新人已消失）', cntDel === '0', 'COUNT(新人)=' + cntDel);

  /* --- 6c. SQL 输入提示（自动补全） --- */
  log('\n[6c] SQL 输入提示');
  const typeIn = async (text, caret) => {
    await ev(`(()=>{
      const ta = document.getElementById('sql');
      ta.focus();
      ta.value = ${JSON.stringify(text)};
      ta.setSelectionRange(${caret}, ${caret});
      ta.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    await sleep(340);
  };
  const acOpen = () => ev('document.getElementById("ac").classList.contains("show")');
  const acText = async () => String((await ev('document.getElementById("ac").textContent')).v || '');
  const acEnter = async () => {
    await ev('document.getElementById("sql").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');
    await sleep(220);
  };

  await typeIn('SEL', 3);
  check('输入关键字前缀时弹出补全', (await acOpen()).v === true);
  const kwList = await acText();
  check('补全列表包含 SELECT 关键字', /SELECT/.test(kwList), kwList.slice(0, 70));
  await acEnter();
  check('回车接受补全为 SELECT', (await ev('document.getElementById("sql").value')).v === 'SELECT');
  check('接受补全后弹层自动收起', (await acOpen()).v === false);

  // 回归：FN 集合曾因为漏了括号而退化成「单字符集合」，导致函数名高亮与补全全失效
  await typeIn('COU', 3);
  const fnList = await acText();
  check('补全列表包含完整函数名 COUNT', /\bCOUNT\b/.test(fnList), fnList.slice(0, 90));
  await ev('document.getElementById("sql").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  await sleep(150);
  await typeIn('SELECT COUNT(*) FROM employees', 29);
  const fnHi = String((await ev(`(()=>{
    const s = Array.from(document.querySelectorAll('#hl .tok-fn')).map(x=>x.textContent);
    return JSON.stringify(s);
  })()`)).v || '[]');
  check('函数名在编辑器中被高亮为函数色', /COUNT/.test(fnHi), fnHi.slice(0, 90));

  await typeIn('SELECT * FROM ', 14);
  const tbList = await acText();
  check('FROM 之后提示表名', /employees/.test(tbList), tbList.slice(0, 110));
  await acEnter();
  check('表名补全写入编辑器',
    /SELECT \* FROM employees/.test(String((await ev('document.getElementById("sql").value')).v || '')));

  await typeIn('SELECT employees.', 17);
  const colList = await acText();
  check('「表名.」之后提示该表的列',
    /salary/.test(colList) && /dept/.test(colList), colList.slice(0, 150));
  await ev('document.getElementById("sql").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  await sleep(160);
  check('Esc 可关闭补全弹层', (await acOpen()).v === false);
  // Ctrl+Space 手动唤出（光标后没有任何前缀时也应给出候选）
  await typeIn('', 0);
  await ev('document.getElementById("sql").dispatchEvent(new KeyboardEvent("keydown",{key:" ",ctrlKey:true,bubbles:true}))');
  await sleep(280);
  check('Ctrl+Space 可手动唤出输入提示', (await acOpen()).v === true);
  const manualList = await acText();
  check('手动唤出时优先列出库内对象（表名）',
    /employees/.test(manualList), manualList.slice(0, 130));
  check('手动唤出的列表标明候选类型', /关键字 \/ 对象/.test(manualList), manualList.slice(0, 60));
  await ev('document.getElementById("sql").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  await sleep(150);
  // 别名解析：FROM 后带别名时，用别名也能补出列
  await typeIn('SELECT e. FROM employees e', 9);
  const aliasList = await acText();
  check('别名（e.）也能解析出所属表的列', /salary/.test(aliasList), aliasList.slice(0, 150));
  await shot('10-输入提示.png');
  await ev('document.getElementById("sql").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  await sleep(150);

  /* --- 6d. 列提示必须被限定在「本语句用到的表」（回归） --- */
  log('\n[6d] 列提示的作用域限定');
  // 造第二张表，同时提供两个「干扰项」，复现用户截图里的场景：
  //   · 表名 sal_history —— 不该在 WHERE 里作为表名冒出来
  //   · 列 sales_rep    —— 属于别的表，不该出现在 employees 的条件提示里
  await ev('document.getElementById("sql").value = "CREATE TABLE sal_history (sales_rep TEXT, amount REAL);"');
  await ev('document.querySelector(\'[data-action="execute"]\').click()');
  await sleep(1000);
  await ev('document.querySelector(\'[data-action="refresh"]\').click()');
  await sleep(800);

  const scopedSql = 'SELECT * FROM employees WHERE sal';
  await typeIn(scopedSql, scopedSql.length);
  const scopedList = await acText();
  check('有 FROM 时只提示该表的列', /salary/.test(scopedList), scopedList.slice(0, 170));
  check('有 FROM 时不串入其他表的列', !/sales_rep/.test(scopedList), scopedList.slice(0, 170));
  check('有 FROM 时不混入表名', !/sal_history/.test(scopedList), scopedList.slice(0, 170));
  check('提示头标明作用域', /本语句表列/.test(scopedList), scopedList.slice(0, 70));
  await shot('11-列提示限定作用域.png');

  // 别名限定：sal_history 的别名 h，也应只给这张表的列
  const aliasScopedSql = 'SELECT * FROM sal_history h WHERE h.sal';
  await typeIn(aliasScopedSql, aliasScopedSql.length);
  const aliasScoped = await acText();
  check('别名限定到该表：h.sal 只给 sales_rep',
    /sales_rep/.test(aliasScoped) && !/salary/.test(aliasScoped), aliasScoped.slice(0, 170));

  // 没有 FROM 时才放宽到全库对象
  await typeIn('SELECT sales', 12);
  const unscopedList = await acText();
  check('没有 FROM 时放宽到全库对象', /sales_rep/.test(unscopedList), unscopedList.slice(0, 150));
  await ev('document.getElementById("sql").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  await sleep(150);

  // SQL Server 风格的方括号前缀（正是用户遇到的 [fI 场景）
  const brSql = 'SELECT * FROM [employees] WHERE [na';
  await typeIn(brSql, brSql.length);
  const brList = await acText();
  check('方括号前缀也能提示该表的列',
    /name/.test(brList) && !/sales_rep/.test(brList), brList.slice(0, 170));
  await acEnter();
  check('方括号前缀补全后自动闭合',
    /\[name\]/.test(String((await ev('document.getElementById("sql").value')).v || '')),
    String((await ev('document.getElementById("sql").value')).v || '').slice(-40));
  await ev('document.getElementById("sql").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  await sleep(150);
  // 清掉临时表，避免影响后续断言
  await ev('document.getElementById("sql").value = "DROP TABLE sal_history;"');
  await ev('document.querySelector(\'[data-action="execute"]\').click()');
  await sleep(900);

  /* --- 6e. 选取执行：编辑器里有选区时只跑选区 --- */
  log('\n[6e] 选取执行（有选区只执行选区，无选区执行整篇）');

  // 设置编辑器内容并指定选区。SQL 用 JSON.stringify 注入，
  // 免得换行 / 引号在模板字符串里再手工转义一遍。
  async function setEditorSelect(sql, from, to) {
    return (await ev(`(()=>{
      const el=document.getElementById('sql');
      el.value=${JSON.stringify(sql)};
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      el.focus();
      el.setSelectionRange(${from},${to});
      document.dispatchEvent(new Event('selectionchange'));
      return el.value.substring(el.selectionStart,el.selectionEnd);
    })()`)).v;
  }

  // 探针脚本：第一条建表、第二条插数据。
  // 只选第一条执行时，第二条绝不能生效 —— 这是「选取执行」最硬的证据。
  const PROBE_SQL = 'CREATE TABLE sel_probe(id INTEGER, tag TEXT);\n' +
    "INSERT INTO sel_probe VALUES (1,'should-not-run');";
  const CUT = PROBE_SQL.indexOf('\n');

  const picked1 = await setEditorSelect(PROBE_SQL, 0, CUT);
  check('编辑器选区就是第一条语句', picked1 === PROBE_SQL.slice(0, CUT), JSON.stringify(picked1));
  check('有选区时执行按钮被点亮',
    (await ev('document.querySelector(".tb-btn.exec").classList.contains("sel")')).v === true);
  check('有选区时按钮文案变为「执行选中」',
    (await ev('(document.querySelector(".tb-btn.exec .tb-label")||{}).textContent')).v === '执行选中',
    String((await ev('(document.querySelector(".tb-btn.exec .tb-label")||{}).textContent')).v));
  await shot('12-选取执行.png');

  await ev('document.querySelector(\'[data-action="execute"]\').click()');
  const selRan = await waitFor(
    'document.getElementById("sbStatus").textContent === "命令已成功完成（选区）"', 15000, 'selection exec');
  check('有选区时只执行选区（状态栏标明「选区」）', selRan,
    String((await ev('document.getElementById("sbStatus").textContent')).v));
  const selMsg = String((await ev('document.getElementById("resBody").textContent')).v || '');
  check('结果面板说明只执行了选中的行', /只执行了选中/.test(selMsg), selMsg.slice(0, 130));

  // 关键证据：未选中的 INSERT 不能生效
  await setEditorSelect('SELECT COUNT(*) AS c FROM sel_probe;', 0, 0);
  await ev('document.querySelector(\'[data-action="execute"]\').click()');
  const zeroRows = await waitFor(
    '(()=>{const t=document.querySelector("#resBody table.grid");if(!t)return false;const tr=t.querySelector("tbody tr");if(!tr)return false;const td=tr.querySelectorAll("td")[1];return td && td.textContent==="0";})()',
    15000, 'probe 0 rows');
  check('未选中的 INSERT 确实没有执行（表存在但 0 行）', zeroRows);

  // 反过来只选第二条，验证选区执行真的会执行
  const picked2 = await setEditorSelect(PROBE_SQL, CUT + 1, PROBE_SQL.length);
  check('选区切换为第二条语句', /^INSERT/.test(String(picked2)), JSON.stringify(picked2));
  await ev('document.querySelector(\'[data-action="execute"]\').click()');
  await waitFor('document.getElementById("sbStatus").textContent === "命令已成功完成（选区）"',
    15000, 'selection exec 2');
  await setEditorSelect('SELECT COUNT(*) AS c FROM sel_probe;', 0, 0);
  await ev('document.querySelector(\'[data-action="execute"]\').click()');
  const oneRow = await waitFor(
    '(()=>{const t=document.querySelector("#resBody table.grid");if(!t)return false;const tr=t.querySelector("tbody tr");if(!tr)return false;const td=tr.querySelectorAll("td")[1];return td && td.textContent==="1";})()',
    15000, 'probe 1 row');
  check('选中的 INSERT 确实执行了（1 行）', oneRow);

  // 无选区 → 执行整篇（两条 SELECT，取最后一个结果集）
  await setEditorSelect("SELECT 'A' AS tag;\nSELECT 'B' AS tag;", 0, 0);
  check('无选区时按钮恢复为「执行」',
    (await ev('(document.querySelector(".tb-btn.exec .tb-label")||{}).textContent')).v === '执行');
  check('无选区时按钮不再点亮',
    (await ev('document.querySelector(".tb-btn.exec").classList.contains("sel")')).v === false);
  await ev('document.querySelector(\'[data-action="execute"]\').click()');
  const wholeRan = await waitFor(
    '(()=>{const t=document.querySelector("#resBody table.grid");if(!t)return false;const tr=t.querySelector("tbody tr");if(!tr)return false;const td=tr.querySelectorAll("td")[1];return td && td.textContent==="B";})()',
    15000, 'whole script');
  check('无选区时执行整篇（取最后一个结果集 B）', wholeRan);

  await ev('document.getElementById("sql").value = "DROP TABLE sel_probe;"');
  await ev('document.querySelector(\'[data-action="execute"]\').click()');
  await sleep(800);

  /* --- 7. 执行计划 --- */
  log('\n[7] 执行计划');
  await ev(`document.getElementById("sql").value = "SELECT * FROM employees WHERE dept = '研发';"`);
  await ev('document.querySelector(\'[data-action="explain"]\').click()');
  await waitFor('document.getElementById("sbStatus").textContent === "执行计划"', 10000, 'explain');
  const planTxt = (await ev('document.getElementById("resBody").textContent')).v;
  check('返回执行计划', /SCAN|SEARCH|USING/i.test(planTxt), planTxt.slice(0, 80));

  /* --- 8. 错误处理 --- */
  log('\n[8] 错误处理');
  await ev(`document.getElementById("sql").value = "SELECT * FROM 不存在的表;"`);
  await ev('document.querySelector(\'[data-action="execute"]\').click()');
  await waitFor('document.querySelector("#resBody").textContent.includes("执行失败")', 10000, 'error');
  const errTxt = (await ev('document.getElementById("resBody").textContent')).v;
  check('错误消息展示给用户', /no such table/i.test(errTxt), errTxt.slice(0, 80));

  /* --- 9. 浅色主题 --- */
  log('\n[9] 主题切换');
  await ev('document.querySelector(\'[data-action="theme"]\').click()');
  await sleep(400);
  check('已切换到浅色主题', (await ev('document.documentElement.getAttribute("data-theme")')).v === 'light');
  await ev(`document.getElementById("sql").value = "SELECT * FROM employees ORDER BY salary DESC;"`);
  await ev('document.querySelector(\'[data-action="execute"]\').click()');
  await waitFor('!!document.querySelector("#resBody table.grid tbody tr")', 10000);
  await shot('05-浅色主题.png');
  await ev('document.querySelector(\'[data-action="theme"]\').click()');
  await sleep(300);

  /* --- 10. 远程连接（服务端 SQLite 文件，走完整后端链路） --- */
  log('\n[10] 远程连接：服务端 SQLite 文件');
  // 使用固定文件名：一是保证每次运行都是干净的空库，二是让「最近连接」的去重键稳定，
  // 不会因为每次跑测试都换一个随机文件名而不断累积记录。
  const remoteDb = path.join(os.tmpdir(), 'sqltool-ui-remote.db');
  try { fs.unlinkSync(remoteDb); } catch (e) { /* 不存在则忽略 */ }
  await ev('document.querySelector(\'[data-action="new-conn"]\').click()');
  await sleep(200);
  const cards = (await ev('Array.from(document.querySelectorAll(".mask.show .engine-card")).map(c=>c.dataset.driver).join(",")')).v;
  log('    可用连接类型: ' + cards);
  check('连接对话框提供 5 种类型', cards === 'sqlite-local,sqlite,mysql,postgres,mssql', cards);

  await ev('document.querySelector(\'.mask.show .engine-card[data-driver="sqlite"]\').click()');
  await sleep(150);
  check('切换到服务端文件模式后出现路径输入框', (await ev('!!document.querySelector(".mask.show #fFile")')).v === true);
  await ev('document.getElementById("fName").value = "远程测试库"');
  await ev('document.getElementById("fFile").value = ' + JSON.stringify(remoteDb));

  // 先测连接
  await ev('document.querySelector(".mask.show [data-test]").click()');
  await waitFor('document.getElementById("toast").textContent.includes("连接成功")', 15000, 'test conn');
  const testMsg = (await ev('document.getElementById("toast").textContent')).v;
  check('测试连接成功', /连接成功/.test(testMsg), testMsg);

  await ev('document.querySelector(".mask.show [data-ok]").click()');
  const remoteOk = await waitFor('document.getElementById("sbConn").textContent === "远程测试库"', 20000, 'remote conn');
  check('远程连接建立成功', remoteOk);
  check('状态栏显示远程引擎', (await ev('document.getElementById("sbEngine").textContent')).v.indexOf('SQLite') >= 0,
    (await ev('document.getElementById("sbEngine").textContent')).v);

  // 「最近连接」快捷重连：建连后应自动落盘，再打开对话框就能看到这条记录
  await ev('document.querySelector(\'[data-action="new-conn"]\').click()');
  const hasChip = await waitFor(
    '!!document.querySelector(".mask.show #savedBox .saved-item .si-name")', 8000, 'saved chip');
  const chipText = hasChip ? String((await ev('document.querySelector(".mask.show #savedBox").textContent')).v) : '';
  check('连接对话框显示「最近连接」记录', hasChip, chipText.slice(0, 60));
  check('最近连接记录名称正确', /远程测试库/.test(chipText));
  await shot('07-最近连接.png');
  await ev('document.querySelector(".mask.show [data-cancel]").click()');
  await sleep(200);
  check('连接对话框可关闭', (await ev('!!document.querySelector(".mask.show")')).v === false);

  // 在远程连接上执行 SQL
  const REMOTE_SQL = `DROP TABLE IF EXISTS servers;
DROP TABLE IF EXISTS logs;
CREATE TABLE servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hostname TEXT NOT NULL,
  ip TEXT,
  cpu_cores INTEGER,
  memory_gb REAL,
  online INTEGER DEFAULT 1
);
INSERT INTO servers (hostname, ip, cpu_cores, memory_gb, online) VALUES
 ('web-01','10.0.1.11',8,32.0,1),
 ('web-02','10.0.1.12',8,32.0,1),
 ('db-01','10.0.2.11',32,256.0,1),
 ('db-02','10.0.2.12',32,256.0,0),
 ('cache-01','10.0.3.11',4,16.0,1);
CREATE TABLE logs (
  level TEXT,
  msg TEXT,
  at TEXT
);
INSERT INTO logs VALUES
 ('info','启动完成','2026-01-01 09:00:00'),
 ('warn','磁盘接近上限','2026-01-01 09:05:00');
SELECT online, COUNT(*) AS 数量, SUM(cpu_cores) AS 总核数, ROUND(AVG(memory_gb),1) AS 平均内存
FROM servers GROUP BY online ORDER BY online DESC;`;
  await ev('document.getElementById("sql").value = ' + JSON.stringify(REMOTE_SQL));
  await ev('document.querySelector(\'[data-action="execute"]\').click()');
  const remoteGrid = await waitFor(
    '(()=>{const t=document.querySelector("#resBody table.grid");return !!t && t.querySelector("thead").textContent.indexOf("数量")>=0;})()',
    20000, 'remote grid');
  check('远程执行 SQL 并返回结果', remoteGrid);
  const rgRaw = (await ev(`(()=>{
    const t = document.querySelector('#resBody table.grid');
    if(!t) return 'null';
    const head = Array.from(t.querySelectorAll('thead th')).map(x=>x.textContent.trim());
    const rows = Array.from(t.querySelectorAll('tbody tr')).map(tr=>Array.from(tr.querySelectorAll('td')).slice(1).map(td=>td.textContent.trim()));
    return JSON.stringify({head, rows});
  })()`)).v;
  // 结果网格可能在这一瞬间被重绘，读不到就退化为空对象，让断言失败而不是让脚本崩掉
  const rg = (() => { try { return JSON.parse(rgRaw) || { head: [], rows: [] }; } catch (e) { return { head: [], rows: [] }; } })();
  log('    表头: ' + JSON.stringify(rg.head));
  log('    数据: ' + JSON.stringify(rg.rows));
  check('远程聚合列名正确', rg.head.join('|').includes('数量') && rg.head.join('|').includes('总核数'));
  check('在线机器 4 台 / 离线 1 台',
    rg.rows.some(r => r[0] === '1' && r[1] === '4') && rg.rows.some(r => r[0] === '0' && r[1] === '1'),
    JSON.stringify(rg.rows));
  await shot('06-远程连接.png');

  // 对象树懒加载
  await ev('document.querySelector(\'[data-action="refresh"]\').click()');
  await sleep(800);
  const remoteTree = (await ev('document.getElementById("tree").textContent')).v;
  check('远程对象树显示 servers 表', remoteTree.indexOf('servers') >= 0);
  await ev(`(() => {
    const node = Array.from(document.querySelectorAll('#tree .node')).find(n => n.dataset.name === 'servers');
    node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 200 }));
  })()`);
  check('表菜单提供按需统计入口', (await ev('!!document.querySelector(\'#ctx [data-action="count-rows"]\')')).v);
  await ev('document.querySelector(\'#ctx [data-action="count-rows"]\').click()');
  check('服务端表按需返回精确行数', await waitFor('document.getElementById("toast").textContent === "servers：5 行"', 10000, '精确行数'));
  // 记录发往 /api/columns 的请求体，用于校验传过去的是「数据库名」而不是「架构名」
  await ev(`window.__colsCalls = [];
    (function(){ const f = window.fetch;
      window.fetch = function(u, o){
        try { if (String(u).indexOf('/api/columns') >= 0 && o && o.body) window.__colsCalls.push(JSON.parse(o.body)); } catch(e){}
        return f.apply(this, arguments);
      };
    })();`);
  // 展开表节点触发列懒加载
  const expanded = (await ev(`(async ()=>{
    const n = Array.from(document.querySelectorAll('#tree .node')).find(x=>(x.dataset.name||'')==='servers');
    if(!n) return 'notfound';
    const caret = n.querySelector('.caret');
    if(caret) caret.click();
    await new Promise(r=>setTimeout(r,1200));
    return document.getElementById('tree').textContent;
  })()`)).v;
  check('展开表节点后懒加载出列定义', /hostname/.test(expanded) && /cpu_cores/.test(expanded),
    String(expanded).slice(0, 120));

  // 回归：曾经把 item.schema（SQL Server 的 dbo / PostgreSQL 的 public / SQLite 的 main）
  // 当成数据库名传给 columns()，导致后端去连一个名为 dbo 的库并报「用户登录失败」。
  const colsRaw = (await ev('JSON.stringify(window.__colsCalls || [])')).v;
  const colReqs = (() => { try { return JSON.parse(colsRaw) || []; } catch (e) { return []; } })();
  check('展开表节点确实请求了列定义', colReqs.length > 0, 'calls=' + colReqs.length);
  check('传给 /api/columns 的是数据库名而非架构名',
    colReqs.length > 0 && colReqs.every(c => !['main', 'dbo', 'public', 'information_schema'].includes(c.database)),
    JSON.stringify(colReqs.map(c => ({ table: c.table, database: c.database }))));

  // 远程单元格编辑（走主键 UPDATE）
  const editRemote = (await ev(`(async ()=>{
    const nodes = Array.from(document.querySelectorAll('#tree .node'));
    const n = nodes.find(x=>(x.dataset.name||'')==='servers');
    if(!n) return 'notfound';
    n.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
    await new Promise(r=>setTimeout(r,1500));
    const tr = document.querySelectorAll('#resBody table.grid tbody tr')[0];
    if(!tr) return 'no-row';
    const tds = Array.from(tr.querySelectorAll('td')).slice(1);
    const hostTd = tds[1];
    if(!hostTd || !hostTd.classList.contains('editable')) return 'not-editable';
    hostTd.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
    await new Promise(r=>setTimeout(r,150));
    const inp = hostTd.querySelector('input');
    if(!inp) return 'no-input';
    inp.value = 'web-01-renamed';
    inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    await new Promise(r=>setTimeout(r,900));
    return 'done';
  })()`)).v;
  check('远程单元格可编辑并提交', editRemote === 'done', editRemote);

  await ev('document.getElementById("sql").value = "SELECT hostname FROM servers WHERE id = 1;"');
  await ev('document.querySelector(\'[data-action="execute"]\').click()');
  const remoteUpdated = await waitFor(
    '(()=>{const t=document.querySelector("#resBody table.grid");if(!t)return false;const tr=t.querySelector("tbody tr");if(!tr)return false;const tds=tr.querySelectorAll("td");return tds.length===2 && tds[1].textContent==="web-01-renamed";})()',
    15000, 'remote updated');
  check('远程数据库中的值已真实更新', remoteUpdated);

  /* --- 10b. 远程「无主键表」也能编辑（回归：以前整张表都不可编辑） --- */
  log('\n[10b] 远程无主键表：退化为全列匹配定位');
  const noPkOpen = (await ev(`(async ()=>{
    const n = Array.from(document.querySelectorAll('#tree .node')).find(x=>(x.dataset.name||'')==='logs');
    if(!n) return 'notfound';
    n.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
    await new Promise(r=>setTimeout(r,1600));
    const g = document.querySelector('#resBody table.grid');
    if(!g) return 'no-grid';
    return JSON.stringify({ rows: g.querySelectorAll('tbody tr').length, editable: g.querySelectorAll('td.editable').length });
  })()`)).v;
  const noPkInfo = (() => { try { return JSON.parse(noPkOpen) || {}; } catch (e) { return {}; } })();
  log('    ' + noPkOpen);
  check('无主键表打开后存在可编辑单元格', noPkInfo.editable > 0, 'editable=' + noPkInfo.editable);
  const noPkHint = String((await ev('document.getElementById("editHint").textContent')).v || '');
  check('面板明确提示该表没有主键', /无主键/.test(noPkHint), noPkHint);

  const noPkEdit = (await ev(`(async ()=>{
    const tr = document.querySelectorAll('#resBody table.grid tbody tr')[0];
    if(!tr) return 'no-row';
    const td = Array.from(tr.querySelectorAll('td')).slice(1)[1];   // msg 列
    if(!td || !td.classList.contains('editable')) return 'not-editable';
    td.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
    await new Promise(r=>setTimeout(r,160));
    const inp = td.querySelector('input');
    if(!inp) return 'no-input';
    inp.value = '磁盘已满';
    inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    await new Promise(r=>setTimeout(r,1400));
    return 'done';
  })()`)).v;
  check('无主键表的单元格可编辑并提交', noPkEdit === 'done', noPkEdit);

  await ev('document.getElementById("sql").value = "SELECT COUNT(*) AS c FROM logs WHERE msg = \'磁盘已满\';"');
  await ev('document.querySelector(\'[data-action="execute"]\').click()');
  const noPkSaved = await waitFor(
    '(()=>{const t=document.querySelector("#resBody table.grid");if(!t)return false;const tr=t.querySelector("tbody tr");if(!tr)return false;const tds=tr.querySelectorAll("td");return tds.length===2 && tds[1].textContent==="1";})()',
    15000, 'no-pk updated');
  check('无主键表的修改已真实写入数据库', noPkSaved);

  // 无主键表也能新增行
  await ev(`(()=>{
    const n = Array.from(document.querySelectorAll('#tree .node')).find(x=>(x.dataset.name||'')==='logs');
    if(n) n.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
  })()`);
  await waitFor('(()=>{const t=document.querySelector("#resBody table.grid");return t && t.querySelectorAll("tbody tr").length===2})()', 15000, 'reopen logs');
  await ev('document.getElementById("btnRowAdd").click()');
  await waitFor('!!document.querySelector(".mask.show .add-form")', 8000, 'add dialog logs');
  await ev(`(()=>{
    const rows = Array.from(document.querySelectorAll('.mask.show .add-row'));
    const set=(n,v)=>{const r=rows.find(x=>x.dataset.col===n); if(r) r.querySelector('.add-val').value=v;};
    set('level','error'); set('msg','连接超时'); set('at','2026-01-01 10:00:00');
  })()`);
  await ev('document.querySelector(".mask.show [data-ok]").click()');
  const noPkAdded = await waitFor(
    '(()=>{const t=document.querySelector("#resBody table.grid");return t && t.querySelectorAll("tbody tr").length===3})()',
    15000, 'logs row added');
  check('无主键表可新增行', noPkAdded);

  /* --- 10c. 存储过程 / 函数：列表渲染 + 双击取定义 --- */
  log('\n[10c] 存储过程 / 函数（列表 + 定义）');

  // 本机没有真实的 MySQL / PG / SQL Server，无法真读过程定义。
  // 这里拦截 /api/schema 与 /api/routine-ddl 的响应注入假元数据，
  // 把「API 响应 → RemoteEngine.schema → 树渲染 → 双击 → 取定义 → 弹窗」整条前端链路跑通。
  const FAKE_DDL = 'CREATE PROCEDURE dbo.usp_Reindex\nAS\nBEGIN\n  SELECT 1 AS ok;\nEND';
  const patchRes = (await ev(`(()=>{
    if (window.__rtPatched) return 'already';
    window.__rtPatched = true;
    const orig = window.fetch;
    window.fetch = async function(u){
      const r = await orig.apply(this, arguments);
      try {
        const s = String(u);
        if (s.indexOf('/api/schema') >= 0) {
          const j = await r.clone().json();
          if (j && j.data) {
            j.data.procedures = [{name:'usp_Reindex', schema:'dbo', kind:'procedure', type:'procedure'}];
            j.data.functions = [
              {name:'fn_Total', schema:'dbo', kind:'function', type:'function', ret:'decimal(18,2)'},
              {name:'fn_Split', schema:'dbo', kind:'function', type:'function', ret:'table', typeDesc:'SQL_INLINE_TABLE_VALUED_FUNCTION'}
            ];
          }
          return new Response(JSON.stringify(j), {status:r.status, headers:{'Content-Type':'application/json'}});
        }
        if (s.indexOf('/api/routine-ddl') >= 0) {
          window.__rtDdlAsked = true;
          return new Response(JSON.stringify({ok:true, data:{ddl:${JSON.stringify(FAKE_DDL)}}}),
            {status:200, headers:{'Content-Type':'application/json'}});
        }
      } catch(e){}
      return r;
    };
    return 'patched';
  })()`)).v;
  check('已注入存储过程 / 函数元数据', patchRes === 'patched' || patchRes === 'already', String(patchRes));

  await ev('document.querySelector(\'[data-action="refresh"]\').click()');
  await sleep(2000);
  const rtTxt = String((await ev('document.getElementById("tree").textContent')).v || '');
  check('对象树出现「存储过程」文件夹', /存储过程 \(1\)/.test(rtTxt), rtTxt.slice(0, 220));
  check('对象树出现「函数」文件夹', /函数 \(2\)/.test(rtTxt), rtTxt.slice(0, 220));
  check('存储过程节点名正确', /usp_Reindex/.test(rtTxt));
  check('函数节点全部列出', /fn_Total/.test(rtTxt) && /fn_Split/.test(rtTxt));
  const sbObj = String((await ev('document.getElementById("sbObjects").textContent')).v || '');
  check('状态栏统计包含过程·函数', /过程·函数/.test(sbObj), sbObj);
  await shot('13-存储过程与函数.png');

  // 展开「存储过程」文件夹 → 双击节点 → 弹窗应显示定义原文
  const ddlShown = String((await ev(`(async ()=>{
    const folder = Array.from(document.querySelectorAll('#tree .node')).find(x => (x.dataset.name||'') === '存储过程');
    if (!folder) return 'no-folder';
    folder.dispatchEvent(new MouseEvent('click',{bubbles:true}));
    await new Promise(r=>setTimeout(r,300));
    const proc = Array.from(document.querySelectorAll('#tree .node')).find(x => (x.dataset.name||'') === 'usp_Reindex');
    if (!proc) return 'no-node';
    proc.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
    await new Promise(r=>setTimeout(r,1200));
    const body = document.querySelector('.mask.show .m-body');
    return body ? body.textContent : 'no-modal';
  })()`)).v || '');
  check('双击存储过程弹出定义窗口', /CREATE PROCEDURE/.test(ddlShown), ddlShown.slice(0, 130));
  check('定义内容与后端返回一致',
    ddlShown.indexOf('usp_Reindex') >= 0 && ddlShown.indexOf('SELECT 1 AS ok') >= 0, ddlShown.slice(0, 130));
  check('确实向后端请求了定义', (await ev('window.__rtDdlAsked === true')).v === true);
  await shot('14-存储过程定义.png');
  await ev('const x=document.querySelector(".mask.show [data-cancel]"); if(x) x.click();');
  await sleep(250);

  /* --- 10d. 真实页面中的连接切换与响应乱序 --- */
  log('\n[10d] 查询结果归属与响应乱序');
  await ev(`(() => {
    window.__bindingFetch = window.fetch;
    window.fetch = async function(url, opts) {
      const response = await window.__bindingFetch.apply(this, arguments);
      let body = {};
      try { body = JSON.parse(opts && opts.body || '{}'); } catch(e) {}
      if (String(url).includes('/api/query') && String(body.sql).includes('binding_hold')) {
        await new Promise(resolve => { window.__releaseBinding = resolve; });
      }
      return response;
    };
    document.querySelector('[data-action="new-query"]').click();
    const editor = document.getElementById('sql');
    editor.value = 'SELECT 901 AS marker /* binding_hold */';
    editor.setSelectionRange(0, 0);
    document.querySelector('[data-action="execute"]').click();
  })()`);
  if (!await waitFor('typeof window.__releaseBinding === "function"', 10000, '延迟查询')) throw new Error('未捕获延迟查询');
  await ev(`(() => {
    const local = Array.from(document.querySelectorAll('#tree .node')).find(n => n.dataset.type === 'conn' && n.textContent.includes('业务数据库'));
    local.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    window.__releaseBinding();
  })()`);
  check('慢查询返回后不在另一连接展示可编辑结果', await waitFor('document.getElementById("resBody").textContent.includes("该结果来自连接") && !document.querySelector("#resBody td.editable")', 10000));
  await ev(`(() => {
    const remote = Array.from(document.querySelectorAll('#tree .node')).find(n => n.dataset.type === 'conn' && n.textContent.includes('远程测试库'));
    remote.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()`);
  check('切回原连接可见原查询结果', await waitFor('document.querySelector("#resBody tbody td:nth-child(2)")?.textContent === "901"', 10000));
  await ev(`(() => {
    window.__releaseBinding = null;
    const editor = document.getElementById('sql');
    editor.value = 'SELECT 903 AS marker /* binding_hold */'; editor.setSelectionRange(0, 0);
    document.querySelector('[data-action="execute"]').click();
  })()`);
  if (!await waitFor('typeof window.__releaseBinding === "function"', 10000, '旧查询延迟')) throw new Error('未捕获旧查询');
  await ev(`(() => {
    const editor = document.getElementById('sql');
    editor.value = 'SELECT 902 AS marker'; editor.setSelectionRange(0, 0);
    document.querySelector('[data-action="execute"]').click();
  })()`);
  check('较新查询可以先完成', await waitFor('document.querySelector("#resBody tbody td:nth-child(2)")?.textContent === "902"', 10000));
  await ev('window.__releaseBinding()');
  await sleep(300);
  check('较旧查询迟到不会覆盖新结果', (await ev('document.querySelector("#resBody tbody td:nth-child(2)")?.textContent')).v === '902');
  await ev('window.fetch = window.__bindingFetch; delete window.__bindingFetch; delete window.__releaseBinding;');

  // 清理：删掉本次测试写入的「最近连接」记录，避免污染用户界面
  try {
    const lr = await (await fetch(BASE + '/api/saved')).json();
    const mine = (lr.data.connections || []).filter(x => x.name === '远程测试库');
    for (const m of mine) {
      await fetch(BASE + '/api/saved/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: m.id })
      });
    }
  } catch (e) { /* 清理失败不影响测试结论 */ }
  // 服务器可能仍持有该文件句柄（Windows 上会删不掉），删不掉就留给系统临时目录回收
  try { fs.unlinkSync(remoteDb); } catch (e) { /* ignore */ }

  /* --- 11. 控制台错误 --- */
  log('\n[11] 控制台健康检查');
  check('无未捕获异常', errs.length === 0, errs.length ? errs.slice(0, 3).join(' | ') : '');

  log('\n===== UI 测试完成：通过 ' + pass + ' 项，失败 ' + fail + ' 项 =====');
  ws.close(); chrome.kill();
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 300);
})().catch(e => { console.error(e); process.exit(1); });
