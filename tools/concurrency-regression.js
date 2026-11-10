/** 并发生命周期回归：模拟网络资源，未经远程真库验证。 */
'use strict';
const assert = require('node:assert/strict');
const { DRIVERS } = require('../server/drivers');
const delay = () => new Promise(resolve => setTimeout(resolve, 10));

(async () => {
  for (const id of ['postgres', 'mssql']) {
    const driver = Object.create(DRIVERS[id]);
    let opened = 0, closed = 0, fail = true;
    const create = async () => {
      await delay();
      if (fail) throw new Error('模拟建连失败');
      opened++;
      return { __state: {}, end: async () => { closed++; }, close: async () => { closed++; } };
    };
    driver._openClient = create;
    driver._newPool = create;
    const session = { database: 'main', cfg: {}, extra: new Map(), pools: new Map(), client: { end: async () => {} } };
    const get = () => id === 'postgres' ? driver._clientFor(session, 'other') : driver._poolFor(session, 'other');
    const failures = await Promise.allSettled(Array.from({ length: 16 }, get));
    assert(failures.every(x => x.status === 'rejected'));
    assert.equal(session.pending.size, 0);
    fail = false;
    const tasks = Array.from({ length: 16 }, get);
    const closing = driver.close(session);
    await assert.rejects(get(), /关闭/);
    const resources = await Promise.all(tasks);
    await closing;
    await driver.close(session);
    assert.equal(new Set(resources).size, 1);
    assert.equal(opened, 1);
    assert.equal(closed, 1);
    console.log('通过：' + id + ' 失败重试、并发去重、建连期间关闭、重复关闭');
  }

  let database = 'main', closed = 0;
  const session = { database, broken: null, conn: {
    async query(command) {
      await delay();
      const sql = typeof command === 'string' ? command : command.sql;
      if (sql === 'FAIL') throw new Error('模拟查询失败');
      if (sql.startsWith('USE ')) { database = sql.slice(5, -1); return [[], []]; }
      return [[[database]], [{ name: 'db' }]];
    },
    async end() { closed++; }
  } };
  const mysql = DRIVERS.mysql;
  await assert.rejects(mysql.query(session, 'FAIL', [], 'a'));
  const tasks = ['a', 'b'].map(db => mysql.query(session, 'SELECT DATABASE()', [], db));
  const closing = mysql.close(session);
  await assert.rejects(mysql.query(session, 'SELECT 1', []), /关闭/);
  const results = await Promise.all(tasks);
  await closing;
  await mysql.close(session);
  assert.deepEqual(results.map(x => x.sets[0].values[0][0]), ['a', 'b']);
  assert.equal(closed, 1);
  console.log('通过：MySQL 失败后队列恢复、跨库隔离、关闭等待排队查询');

  const sqlite = DRIVERS.sqlite;
  const s = await sqlite.connect({ file: ':memory:' });
  try {
    await sqlite.query(s, 'CREATE TABLE items (id INTEGER); INSERT INTO items VALUES (1), (2);', []);
    const prepare = s.db.prepare.bind(s.db);
    s.db.prepare = sql => {
      assert(!/COUNT\s*\(/i.test(sql), '结构读取不应扫描行数');
      return prepare(sql);
    };
    const schema = await sqlite.schema(s);
    assert.equal(schema.tables[0].rowCount, null);
    s.db.prepare = prepare;
    assert.equal((await sqlite.query(s, 'SELECT COUNT(*) FROM items', [])).sets[0].values[0][0], 2);
    console.log('通过：SQLite 结构读取不扫描行数，显式统计正确');
  } finally { await sqlite.close(s); }
})().catch(error => { console.error(error); process.exitCode = 1; });
