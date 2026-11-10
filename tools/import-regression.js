/** 导入边界回归：真实前端函数、文件/界面桩和三个独立内存 SQLite 库；不启动浏览器或 HTTP 服务。 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const { DRIVERS } = require('../server/drivers');
const source = fs.readFileSync(path.join(__dirname, '../app/js/app.js'), 'utf8').replace(/\r\n/g, '\n');
const names = ['currentDbArg', 'queryContext', 'contextOpen', 'parseCsv', 'pickCsvFile', 'pickSelectedCsvFile', 'pickScriptFile', 'importCsvToTable', 'runScriptFile'];
function extract(name) {
  const start = source.search(new RegExp('  (?:async )?function ' + name + '\\('));
  assert(start >= 0, '找不到函数：' + name);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}
const code = names.map(extract).join('\n');
const noop = () => {};
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
let passed = 0;

async function fixture(fn) {
  const databases = {};
  for (const key of ['A/main', 'A/other', 'B/main']) {
    const db = databases[key] = await DRIVERS.sqlite.connect({ file: ':memory:' });
    await DRIVERS.sqlite.query(db, 'CREATE TABLE items(id INTEGER PRIMARY KEY, label TEXT)', []);
  }
  try {
    const state = { conns: [], docs: [], activeConnId: 'A', activeDocId: 'old' };
    const editor = { value: 'DELETE FROM items', selectionStart: 0, selectionEnd: 6 };
    state.docs.push({ id: 'old', sql: editor.value });
    const writes = [], persisted = [], refreshed = [], queries = [], messages = [];
    const columns = [{ name: 'id', type: 'INTEGER', pk: true }, { name: 'label', type: 'TEXT' }];
    let confirmCallback, fileCallback, selectedRow, columnsCached = true;
    for (const id of ['A', 'B']) {
      const c = { id, name: id, engineKind: 'remote' };
      c.engine = {
        currentDatabase: 'main', dialect: 'sqlite',
        async run(sql, params, db) {
          writes.push({ connection: id, database: db, sql, params });
          return DRIVERS.sqlite.query(databases[id + '/' + db], sql, params);
        },
        async exec(sql, db) { return DRIVERS.sqlite.query(databases[id + '/' + db], sql, []); },
        async columns() { return columns; }
      };
      state.conns.push(c);
    }
    const context = {
      state, sqlEl: editor, setTimeout,
      $: selector => selector === '#tree .node.selected' ? selectedRow : null,
      conn: () => state.conns.find(c => c.id === state.activeConnId),
      eng: () => context.conn()?.engine,
      doc: () => state.docs.find(d => d.id === state.activeDocId),
      newDoc(sql, title) {
        const d = { id: 'd' + state.docs.length, sql, title };
        state.docs.push(d); state.activeDocId = d.id;
        editor.value = sql; editor.selectionStart = editor.selectionEnd = 0;
        return d;
      },
      readFile: async file => file.text,
      pickFile: (accept, callback) => { fileCallback = callback; },
      findTable: (name, db, c) => ({ columns: columnsCached ? columns : null }),
      toast: message => messages.push(message), esc: String, busy: noop,
      qid: name => '"' + name.replace(/"/g, '""') + '"',
      confirmThen: async (title, body, callback) => { confirmCallback = callback; },
      persistConn: async c => persisted.push(c.id),
      refreshConnSchema: async (c, db) => refreshed.push({ connection: c.id, database: db }),
      renderTree: noop, updateStatus: noop, renderResult: noop,
      runQuery: async opts => {
        assert(opts && opts.document && opts.context && typeof opts.sql === 'string', '文件执行必须传入文档、连接上下文与完整 SQL');
        queries.push({ connection: opts.context.connId, database: opts.context.database, sql: opts.sql, document: opts.document.id });
        opts.document.result = await opts.context.engine.exec(opts.sql, opts.context.database);
      }
    };
    vm.createContext(context); vm.runInContext(code, context);
    const a = state.conns[0], b = state.conns[1];
    const rows = async key => (await DRIVERS.sqlite.query(databases[key], 'SELECT * FROM items ORDER BY id', [])).sets[0].values;
    await fn({ context, state, editor, a, b, writes, persisted, refreshed, queries, messages, rows,
      confirm: async () => { assert(confirmCallback, '未显示导入确认'); await confirmCallback(); },
      chooseFile: async file => { assert(fileCallback, '未打开文件选择器'); await fileCallback(file); },
      hasConfirm: () => !!confirmCallback,
      cancelConfirm: () => { confirmCallback = null; },
      selectTable: (connId, database) => { selectedRow = { _connId: connId, _k: { type: 'table', name: 'items', _db: database } }; },
      enableLocalTransaction: () => { a.engine.db = { run: sql => databases['A/main'].db.exec(sql) }; },
      clearColumns: () => { columnsCached = false; },
      switchToB: () => { state.activeConnId = 'B'; a.engine.currentDatabase = 'other'; }
    });
  } finally { for (const db of Object.values(databases)) await DRIVERS.sqlite.close(db); }
}
async function test(name, fn) { await fixture(fn); passed++; console.log('通过：' + name); }

(async () => {
  await test('CSV 表头重排及前导零按原值导入', async x => {
    await x.context.importCsvToTable({ text: 'label,id\n00123,1' }, 'items'); await x.confirm();
    assert.deepEqual(await x.rows('A/main'), [[1, '00123']]);
  });
  await test('CSV 忽略空表头但保留原始列位置', async x => {
    await x.context.importCsvToTable({ text: ',id,,label,\n忽略前,1,忽略中,正确标签,忽略后' }, 'items'); await x.confirm();
    assert.deepEqual(await x.rows('A/main'), [[1, '正确标签']]);
  });
  await test('CSV 读取期间切连接和数据库，仍只导入 A/main', async x => {
    const gate = deferred(); x.context.readFile = async () => gate.promise;
    const pending = x.context.importCsvToTable({}, 'items'); x.switchToB(); gate.resolve('id,label\n1,原目标');
    await pending; await x.confirm();
    assert.deepEqual(await x.rows('A/main'), [[1, '原目标']]);
    assert.deepEqual(await x.rows('A/other'), []); assert.deepEqual(await x.rows('B/main'), []);
    assert.deepEqual(x.persisted, ['A']); assert.deepEqual(x.refreshed, [{ connection: 'A', database: 'main' }]);
  });
  await test('CSV 确认期间切换目标，写入保存刷新均使用原连接', async x => {
    await x.context.importCsvToTable({ text: 'id,label\n1,确认后导入' }, 'items'); x.switchToB(); await x.confirm();
    assert.deepEqual(await x.rows('A/main'), [[1, '确认后导入']]);
    assert.deepEqual(await x.rows('B/main'), []); assert.deepEqual(await x.rows('A/other'), []);
    assert.deepEqual(x.persisted, ['A']); assert.deepEqual(x.refreshed, [{ connection: 'A', database: 'main' }]);
  });
  await test('CSV 列定义加载期间切连接仍使用原数据库', async x => {
    const gate = deferred(), original = x.a.engine.columns;
    x.clearColumns(); x.a.engine.columns = async () => { await gate.promise; return original(); };
    const pending = x.context.importCsvToTable({ text: 'id,label\n1,懒加载' }, 'items');
    await Promise.resolve(); x.switchToB(); gate.resolve(); await pending; await x.confirm();
    assert.deepEqual(await x.rows('A/main'), [[1, '懒加载']]); assert.deepEqual(await x.rows('B/main'), []);
  });
  await test('CSV 显式选择时的上下文优先于当前连接', async x => {
    const context = x.context.queryContext(x.a, 'main'); x.switchToB();
    await x.context.importCsvToTable({ text: 'id,label\n1,选择时的连接' }, 'items', 'main', context); await x.confirm();
    assert.deepEqual(await x.rows('A/main'), [[1, '选择时的连接']]); assert.deepEqual(await x.rows('B/main'), []);
  });
  await test('CSV 打开选择器后切连接和库仍使用打开前的目标', async x => {
    x.context.pickCsvFile('items', 'main'); x.switchToB();
    await x.chooseFile({ text: 'id,label\n1,文件选择器原目标' }); await x.confirm();
    assert.deepEqual(await x.rows('A/main'), [[1, '文件选择器原目标']]);
    assert.deepEqual(await x.rows('A/other'), []); assert.deepEqual(await x.rows('B/main'), []);
  });
  await test('CSV 工具栏使用选中表所属连接，忽略不同的当前连接', async x => {
    x.selectTable('B', 'main'); x.context.pickSelectedCsvFile();
    await x.chooseFile({ text: 'id,label\n1,选中的 B 表' }); await x.confirm();
    assert.deepEqual(await x.rows('B/main'), [[1, '选中的 B 表']]); assert.deepEqual(await x.rows('A/main'), []);
    assert.deepEqual(x.persisted, ['B']); assert.deepEqual(x.refreshed, [{ connection: 'B', database: 'main' }]);
  });
  await test('CSV 取消确认不会写入或保存数据库', async x => {
    await x.context.importCsvToTable({ text: 'id,label\n1,已取消' }, 'items'); x.cancelConfirm();
    assert.deepEqual(x.writes, []); assert.deepEqual(x.persisted, []); assert.deepEqual(await x.rows('A/main'), []);
  });
  await test('CSV 保存等待期间切连接后仍刷新原连接与数据库', async x => {
    const entered = deferred(), gate = deferred();
    x.context.persistConn = async c => { x.persisted.push(c.id); entered.resolve(); await gate.promise; };
    await x.context.importCsvToTable({ text: 'id,label\n1,保存等待' }, 'items');
    const pending = x.confirm(); await entered.promise; x.switchToB(); gate.resolve(); await pending;
    assert.deepEqual(x.persisted, ['A']); assert.deepEqual(x.refreshed, [{ connection: 'A', database: 'main' }]);
    assert.deepEqual(await x.rows('A/main'), [[1, '保存等待']]); assert.deepEqual(await x.rows('A/other'), []);
  });
  for (const [name, csv] of [
    ['空文件', ''], ['全部为空的表头', ',,\n1,2,3'],
    ['重复表头', 'id,id,label\n1,2,重复'], ['未知表头', 'id,unknown\n1,未知']
  ]) await test('CSV 拒绝' + name + '且不写库', async x => {
    await x.context.importCsvToTable({ text: csv }, 'items');
    assert.equal(x.hasConfirm(), false); assert.equal(x.writes.length, 0); assert(x.messages.length > 0);
  });
  await test('CSV 约束失败保留成功行并准确统计', async x => {
    await x.context.importCsvToTable({ text: 'id,label\n1,第一行\n1,重复\n2,第二行' }, 'items'); await x.confirm();
    assert.deepEqual(await x.rows('A/main'), [[1, '第一行'], [2, '第二行']]);
    assert.match(x.messages.at(-1), /成功 2 行.*失败 1 行/);
  });
  await test('CSV 读取期间关闭原连接，不回退到其他连接', async x => {
    const gate = deferred(); x.context.readFile = async () => gate.promise;
    const pending = x.context.importCsvToTable({}, 'items'); x.state.conns.splice(0, 1); x.state.activeConnId = 'B';
    gate.resolve('id,label\n1,不应写入'); await pending;
    assert.equal(x.hasConfirm(), false); assert.equal(x.writes.length, 0);
  });
  await test('CSV 确认前关闭原连接，不执行写入或保存其他连接', async x => {
    await x.context.importCsvToTable({ text: 'id,label\n1,不应写入' }, 'items');
    x.state.conns.splice(0, 1); x.state.activeConnId = 'B'; await x.confirm();
    assert.equal(x.writes.length, 0); assert.deepEqual(x.persisted, []);
  });
  await test('CSV 多行导入期间连接关闭后停止后续写入', async x => {
    const run = x.a.engine.run;
    x.a.engine.run = async (...args) => { const r = await run(...args); x.state.conns.splice(0, 1); x.state.activeConnId = 'B'; return r; };
    await x.context.importCsvToTable({ text: 'id,label\n1,第一行\n2,不应继续\n3,不应继续' }, 'items'); await x.confirm();
    assert.equal(x.writes.length, 1); assert.deepEqual(await x.rows('B/main'), []); assert(!x.persisted.includes('B'));
    assert.deepEqual(await x.rows('A/main'), [[1, '第一行']]); assert.match(x.messages.at(-1), /成功 1 行.*失败 2 行/);
  });
  await test('CSV 本地事务中关闭连接会回滚已写入行且成功数归零', async x => {
    x.enableLocalTransaction(); const run = x.a.engine.run;
    x.a.engine.run = async (...args) => { const r = await run(...args); x.state.conns.splice(0, 1); x.state.activeConnId = 'B'; return r; };
    await x.context.importCsvToTable({ text: 'id,label\n1,应回滚\n2,不应继续' }, 'items'); await x.confirm();
    assert.equal(x.writes.length, 1); assert.deepEqual(await x.rows('A/main'), []); assert.deepEqual(x.persisted, []);
    assert.match(x.messages.at(-1), /成功 0 行.*失败 2 行/);
  });
  await test('SQL 文件读取期间切连接和库仍在原库执行', async x => {
    const gate = deferred(); x.context.readFile = async () => gate.promise;
    const pending = x.context.runScriptFile({ name: '目标.sql' }); x.switchToB();
    gate.resolve("INSERT INTO items VALUES(1,'脚本 A'); SELECT * FROM items;"); await pending;
    assert.deepEqual(await x.rows('A/main'), [[1, '脚本 A']]); assert.deepEqual(await x.rows('A/other'), []); assert.deepEqual(await x.rows('B/main'), []);
    assert.equal(x.queries[0].connection, 'A'); assert.equal(x.queries[0].database, 'main');
  });
  await test('SQL 文件在独立标签页执行，不拼接原语句或沿用选区', async x => {
    x.editor.value = 'SELECT 1 AS marker'; x.state.docs[0].sql = x.editor.value;
    x.editor.selectionStart = 0; x.editor.selectionEnd = 6;
    await x.context.runScriptFile({ name: '独立.sql', text: 'SELECT 2 AS marker;' });
    assert.equal(x.state.docs.length, 2); assert.equal(x.state.docs[0].sql, 'SELECT 1 AS marker');
    assert.equal(x.queries[0].sql, 'SELECT 2 AS marker;'); assert.notEqual(x.queries[0].document, 'old');
    assert.equal(x.state.docs[1].result.sets[0].values[0][0], 2);
  });
  await test('SQL 文件显式上下文优先于选择文件后的当前连接', async x => {
    const context = x.context.queryContext(x.a, 'main'); x.switchToB();
    await x.context.runScriptFile({ name: '显式.sql', text: "INSERT INTO items VALUES(1,'显式 A');" }, context);
    assert.deepEqual(await x.rows('A/main'), [[1, '显式 A']]); assert.deepEqual(await x.rows('B/main'), []);
  });
  await test('SQL 指定连接打开选择器后切换仍使用指定连接和库', async x => {
    x.state.activeConnId = 'B'; x.context.pickScriptFile(x.a); x.a.engine.currentDatabase = 'other';
    await x.chooseFile({ name: '选择器.sql', text: "INSERT INTO items VALUES(1,'选择器 A');" });
    assert.deepEqual(await x.rows('A/main'), [[1, '选择器 A']]);
    assert.deepEqual(await x.rows('A/other'), []); assert.deepEqual(await x.rows('B/main'), []);
  });
  await test('SQL 读取期间关闭原连接，不创建新标签页或执行', async x => {
    const gate = deferred(); x.context.readFile = async () => gate.promise;
    const pending = x.context.runScriptFile({ name: '关闭.sql' }); x.state.conns.splice(0, 1); x.state.activeConnId = 'B';
    gate.resolve('SELECT 2'); await pending;
    assert.equal(x.state.docs.length, 1); assert.equal(x.queries.length, 0);
  });
  await test('空 SQL 文件不会执行编辑器原有内容', async x => {
    await x.context.runScriptFile({ name: '空.sql', text: '  \n' });
    assert.equal(x.queries.length, 0); assert.equal(x.state.docs.length, 1);
  });
  console.log('导入边界回归完成：' + passed + ' 项通过');
})().catch(error => { console.error(error); process.exitCode = 1; });
