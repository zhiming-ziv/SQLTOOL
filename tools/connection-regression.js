/** 连接归属回归：执行真实前端函数，使用最小 DOM 桩和独立内存 SQLite 数据库。 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const { DRIVERS } = require('../server/drivers');
const source = fs.readFileSync(path.join(__dirname, '../app/js/app.js'), 'utf8').replace(/\r\n/g, '\n');
const names = ['queryContext', 'contextOpen', 'contextActive', 'currentDbArg', 'execSql', 'currentSql',
  'runQuery', 'explainQuery', 'openTableQuery', 'dialectOf', 'findTable', 'rowWhere', 'editTarget',
  'editTargetCurrent', 'startEdit', 'reloadTableData', 'tableColumnsFor', 'addRowDialog',
  'deleteSelectedRows', 'exportDb', 'handleAction'];
const code = names.map(name => {
  const start = source.search(new RegExp('  (?:async )?function ' + name + '\\('));
  assert(start >= 0, '找不到函数：' + name);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}).join('\n');
const noop = () => {};
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
let passed = 0;

async function fixture(test) {
  const sqlite = DRIVERS.sqlite;
  const databases = {};
  for (const name of ['A/main', 'A/other', 'B/main']) {
    const db = databases[name] = await sqlite.connect({ file: ':memory:' });
    await sqlite.query(db, 'CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)', []);
    await sqlite.query(db, 'INSERT INTO items VALUES (?, ?)', [1, name]);
  }
  try {
    const state = { activeConnId: 'A', activeDocId: 'd1', docs: [], conns: [] };
    let input, modalCallback, confirmCallback;
    const writes = [], downloads = [], messages = [];
    const columns = [{ name: 'id', type: 'INTEGER', pk: true }, { name: 'label', type: 'TEXT' }];
    for (const id of ['A', 'B']) {
      const c = { id, name: id, engineKind: 'remote', schema: { tables: [{ name: 'items', columns }] }, schemas: {} };
      c.engine = {
        currentDatabase: 'main', dialect: 'sqlite',
        setDatabase(db) { this.currentDatabase = db; },
        exec(sql, db) { return sqlite.query(databases[id + '/' + db], sql, []); },
        async run(sql, params, db) {
          writes.push({ id, db, sql });
          return sqlite.query(databases[id + '/' + db], sql, params);
        },
        async columns() { return columns; },
        async exportBinary() { return new Uint8Array([id.charCodeAt(0)]); }
      };
      state.conns.push(c);
    }
    const editor = { value: 'SELECT * FROM items', selectionStart: 0, selectionEnd: 0 };
    const context = {
      state, sqlEl: editor, performance, Blob,
      conn: () => state.conns.find(c => c.id === state.activeConnId),
      eng: () => context.conn()?.engine,
      doc: () => state.docs.find(d => d.id === state.activeDocId),
      newDoc(sql) {
        const d = { id: 'd' + (state.docs.length + 1), sql };
        state.docs.push(d); state.activeDocId = d.id; editor.value = sql; return d;
      },
      $: () => ({ style: {} }), requestAnimationFrame: f => f(), setTimeout: noop,
      toast: text => messages.push(text), status: noop, renderResult: noop, renderTree: noop,
      updateStatus: noop, updateDbSwitcher: noop, esc: String, busy: noop,
      refreshConnSchema: async () => {}, persistConn: async () => {},
      S: { quoteIdentFor: n => '"' + n.replace(/"/g, '""') + '"' },
      openModal(title, body, footer, callback) { modalCallback = callback; return { querySelector: () => null }; },
      confirmThen: async (title, body, callback) => { confirmCallback = callback; },
      download: (name, blob) => downloads.push({ name, blob }),
      TABLE_ACTIONS: new Set(), ctxData: {},
      document: {
        createElement() {
          input = { handlers: {}, focus: noop, select: noop, addEventListener(name, handler) { this.handlers[name] = handler; } };
          return input;
        },
        querySelector: () => ({ querySelectorAll: () => [{ querySelector: () => ({ dataset: { row: '0' } }) }] })
      }
    };
    context.newDoc(editor.value);
    vm.createContext(context);
    vm.runInContext(code, context);
    const d = context.doc(), a = state.conns[0], b = state.conns[1];
    function prepare() { d.pendingEdit = { table: 'items', pkCols: ['id'] }; }
    const read = async key => (await sqlite.query(databases[key], 'SELECT id, label FROM items ORDER BY id', [])).sets[0].values;
    const edit = () => {
      const td = { querySelector: () => null, textContent: d.result.values[0][1], appendChild: noop,
        classList: { contains: () => false, add: noop, remove: noop } };
      context.startEdit(td, d, 'label', 0);
      return value => { input.value = value; input.handlers.keydown({ key: 'Enter', preventDefault: noop }); };
    };
    await test({ context, state, d, a, b, editor, prepare, read, edit, writes, downloads, messages,
      submit: async () => modalCallback({ querySelectorAll: () => [
        { dataset: { col: 'id' }, querySelector: s => s === '.add-isnull' ? { checked: false } : { value: '2' } },
        { dataset: { col: 'label' }, querySelector: s => s === '.add-isnull' ? { checked: false } : { value: '新增' } }
      ] }),
      confirm: async () => confirmCallback()
    });
  } finally { for (const db of Object.values(databases)) await sqlite.close(db); }
}
async function test(name, fn) { await fixture(fn); passed++; console.log('通过：' + name); }

(async () => {
  await test('慢查询切换连接后仍绑定 A，禁止从 B 编辑', async x => {
    const gate = deferred(), exec = x.a.engine.exec.bind(x.a.engine);
    x.a.engine.exec = async (...args) => { await gate.promise; return exec(...args); };
    x.prepare(); const pending = x.context.runQuery(); x.state.activeConnId = 'B';
    gate.resolve(); await pending;
    assert.equal(x.d.connId, 'A'); assert.equal(x.d.result.values[0][1], 'A/main');
    assert.equal(x.context.editTarget(x.d), null); assert.equal(x.writes.length, 0);
  });
  await test('编辑期间切连接、切库，更新只写原库', async x => {
    x.prepare(); await x.context.runQuery(); const commit = x.edit();
    x.state.activeConnId = 'B'; x.a.engine.currentDatabase = 'other';
    commit('正确更新 A'); await tick();
    assert.equal((await x.read('A/main'))[0][1], '正确更新 A');
    assert.equal((await x.read('A/other'))[0][1], 'A/other');
    assert.equal((await x.read('B/main'))[0][1], 'B/main');
  });
  await test('更新返回后只修改原文档，不污染当前标签页', async x => {
    x.prepare(); await x.context.runQuery(); const gate = deferred(), run = x.a.engine.run;
    x.a.engine.run = async (...args) => { await gate.promise; return run(...args); };
    x.edit()('更新原文档'); x.state.activeConnId = 'B';
    const other = x.context.newDoc('SELECT * FROM items'); await x.context.runQuery();
    gate.resolve(); await tick();
    assert.equal(other.result.values[0][1], 'B/main'); assert.equal(x.d.result.values[0][1], '更新原文档');
  });
  await test('新增确认及刷新使用原连接、原文档和原 SQL', async x => {
    x.prepare(); await x.context.runQuery(); await x.context.addRowDialog();
    x.state.activeConnId = 'B'; const other = x.context.newDoc('SELECT 99 AS marker');
    await x.context.runQuery(); await x.submit();
    assert.equal((await x.read('A/main')).length, 2); assert.equal((await x.read('B/main')).length, 1);
    assert.equal(x.d.result.values.length, 2); assert.equal(other.result.values[0][0], 99);
  });
  await test('删除确认期间切连接，删除与刷新只作用于 A', async x => {
    x.prepare(); await x.context.runQuery(); await x.context.deleteSelectedRows();
    x.state.activeConnId = 'B'; await x.confirm();
    assert.equal((await x.read('A/main')).length, 0); assert.equal((await x.read('B/main')).length, 1);
    assert.equal(x.d.connId, 'A'); assert.equal(x.d.result.values.length, 0);
  });
  await test('旧响应不能覆盖新查询（含旧查询失败）', async x => {
    for (const fail of [false, true]) {
      const gate = deferred(), exec = x.a.engine.exec.bind(x.a.engine);
      x.a.engine.exec = async (...args) => { await gate.promise; if (fail) throw new Error('旧查询失败'); return exec(...args); };
      x.state.activeConnId = 'A'; const old = x.context.runQuery();
      x.state.activeConnId = 'B'; await x.context.runQuery(); gate.resolve(); await old;
      assert.equal(x.d.connId, 'B'); assert.equal(x.d.result.values[0][1], 'B/main');
      x.a.engine.exec = exec;
    }
  });
  await test('连接或文档关闭后丢弃延迟结果，旧编辑不得回退到其他连接', async x => {
    x.prepare(); await x.context.runQuery(); const commit = x.edit();
    x.state.conns.splice(0, 1); x.state.activeConnId = 'B'; commit('不应写入'); await tick();
    assert.equal(x.writes.length, 0);
    const gate = deferred(), exec = x.b.engine.exec.bind(x.b.engine);
    x.b.engine.exec = async (...args) => { await gate.promise; return exec(...args); };
    const oldResult = x.d.result; const pending = x.context.runQuery(); x.state.docs.length = 0;
    gate.resolve(); await pending; assert.equal(x.d.result, oldResult);
    x.state.docs.push(x.d);
    const closedGate = deferred();
    x.b.engine.exec = async (...args) => { await closedGate.promise; return exec(...args); };
    const closingQuery = x.context.runQuery(); x.state.conns.length = 0;
    closedGate.resolve(); await closingQuery;
    assert.equal(x.d.result, null); assert.match(x.d.message, /连接已关闭/);
  });
  await test('确认框打开后结果变化，拒绝旧删除请求', async x => {
    x.prepare(); await x.context.runQuery(); await x.context.deleteSelectedRows();
    await x.context.runQuery(); await x.confirm(); assert.equal(x.writes.length, 0);
  });
  await test('列定义加载期间切换连接，打开的表仍查询 A', async x => {
    x.a.schema.tables[0].columns = null;
    const gate = deferred(), columns = x.a.engine.columns;
    x.a.engine.columns = async () => { await gate.promise; return columns(); };
    const pending = x.context.openTableQuery('items'); x.state.activeConnId = 'B';
    gate.resolve(); await pending;
    assert.equal(x.context.doc().connId, 'A'); assert.equal(x.context.doc().result.values[0][1], 'A/main');
  });
  await test('执行计划也绑定原连接，并使旧查询响应失效', async x => {
    const gate = deferred(), exec = x.a.engine.exec.bind(x.a.engine);
    x.a.engine.exec = async (...args) => { await gate.promise; return exec(...args); };
    const old = x.context.runQuery(); x.state.activeConnId = 'B'; await x.context.explainQuery();
    gate.resolve(); await old; assert.equal(x.d.connId, 'B'); assert.equal(x.d.result.columns[0], 'id');
    assert.equal(x.d.editTable, null);
  });
  await test('右键导出非当前连接，使用菜单指定的连接', async x => {
    x.state.activeConnId = 'B'; x.context.ctxData = { kind: 'conn', id: 'A' };
    await x.context.handleAction('export-db'); assert.equal(x.downloads[0].name, 'A.db');
    assert.equal(new Uint8Array(await x.downloads[0].blob.arrayBuffer())[0], 65);
  });
  console.log('连接归属回归完成：' + passed + ' 项通过');
})().catch(error => { console.error(error); process.exitCode = 1; });
