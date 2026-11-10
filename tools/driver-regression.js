// 独立驱动边界测试：无 HTTP 服务、无浏览器，不访问保存连接文件。
'use strict';
const { isDeepStrictEqual } = require('node:util');
const { DRIVERS: D, splitStatements, stripLeadingComments } = require('../server/drivers');
const api = require('../server/api');
const results = [];
const delay = () => new Promise(resolve => setTimeout(resolve, 5));
function check(name, expected, actual, kind = '模拟网络资源') {
  const pass = isDeepStrictEqual(expected, actual);
  results.push({ name, pass, expected, actual, kind });
  console.log((pass ? '通过：' : '失败：') + name);
  if (!pass) console.dir({ expected, actual }, { depth: null });
}
function mysqlResult(rows, fields) {
  return D.mysql.query({ conn: { query: async () => [rows, fields] }, broken: null }, '测试 SQL', []);
}
function pgProbe() {
  const driver = Object.create(D.postgres);
  const sent = [];
  driver._clientFor = async () => ({ query: async (sql, params) => {
    sent.push({ sql, params }); return { rows: [], fields: [{ name: 'value' }] };
  } });
  return { driver, sent };
}
function msProbe(recordsets = []) {
  const driver = Object.create(D.mssql), sent = [], inputs = [];
  driver._poolFor = async () => ({ request: () => ({
    input(name, value) { inputs.push({ name, value }); },
    async query(sql) { sent.push(sql); return { recordsets, rowsAffected: [0] }; }
  }) });
  return { driver, sent, inputs };
}

(async () => {
  for (const sql of ["SELECT '?' AS literal, ? AS value -- ?", 'SELECT ? AS value /* ? */', 'SELECT "?" AS label, ? AS value']) {
    const pg = pgProbe(); await pg.driver.query({}, sql, [42]);
    const expected = sql.replace('? AS value', '$1 AS value');
    check('PG 占位符跳过字面量/注释：' + sql, expected, pg.sent[0].sql);
    const ms = msProbe(); await ms.driver.query({}, sql, [42]);
    check('MSSQL 占位符跳过字面量/注释：' + sql, sql.replace('? AS value', '@p0 AS value'), ms.sent[0]);
  }
  const pgNormal = pgProbe(); await pgNormal.driver.query({}, 'SELECT ? AS value, ? AS other', [1, 2]);
  check('PG 普通参数编号', 'SELECT $1 AS value, $2 AS other', pgNormal.sent[0].sql);
  const msNormal = msProbe(); await msNormal.driver.query({}, 'SELECT ? AS value, ? AS other', [1, 2]);
  check('MSSQL 普通参数编号', 'SELECT @p0 AS value, @p1 AS other', msNormal.sent[0]);
  for (const [name, sql, expected, params] of [
    ['美元引用', "SELECT $$ ?; ' $$ AS literal, ? AS value", "SELECT $$ ?; ' $$ AS literal, $1 AS value", [1]],
    ['带标签的美元引用', 'SELECT $body_1$ ?; $$ $body_1$ AS literal, ? AS value', 'SELECT $body_1$ ?; $$ $body_1$ AS literal, $1 AS value', [1]],
    ['E 字符串反斜杠转义', String.raw`SELECT E'it\'s ?' AS literal, ? AS value`, String.raw`SELECT E'it\'s ?' AS literal, $1 AS value`, [1]],
    ['普通字符串的反斜杠不转义引号', String.raw`SELECT '\' AS literal, ? AS value`, String.raw`SELECT '\' AS literal, $1 AS value`, [1]],
    ['嵌套块注释', 'SELECT /* 外层 /* ? */ 仍在注释 ? */ ? AS value', 'SELECT /* 外层 /* ? */ 仍在注释 ? */ $1 AS value', [1]],
    ['双写引号', 'SELECT \'it\'\'s ?\', "a""?b", ? AS value', 'SELECT \'it\'\'s ?\', "a""?b", $1 AS value', [1]],
    ['数组内占位符', 'SELECT ARRAY[?, ?], (?)[?]', 'SELECT ARRAY[$1, $2], ($3)[$4]', [1, 2, [3], 1]],
    ['JSON 路径运算符', 'SELECT doc #>> ? FROM items WHERE id = ?', 'SELECT doc #>> $1 FROM items WHERE id = $2', ['{name}', 1]],
    ['JSON 复合问号运算符', 'SELECT doc ?| ARRAY[?, ?], doc ?& ARRAY[?], doc @? ?::jsonpath FROM items', 'SELECT doc ?| ARRAY[$1, $2], doc ?& ARRAY[$3], doc @? $4::jsonpath FROM items', ['a', 'b', 'c', '$.a']],
    ['标识符中的美元符号', 'SELECT foo$tag$ + ? AS value', 'SELECT foo$tag$ + $1 AS value', [1]],
    ['回车结束行注释', 'SELECT 1 -- ?\r, ? AS value', 'SELECT 1 -- ?\r, $1 AS value', [1]]
  ]) {
    const pgCase = pgProbe(); await pgCase.driver.query({}, sql, params);
    check('PG 词法边界：' + name, { sql: expected, params }, pgCase.sent[0]);
  }
  for (const [name, sql, expected] of [
    ['方括号转义', 'SELECT [a]]?b], ? AS value', 'SELECT [a]]?b], @p0 AS value'],
    ['Unicode 字符串和双写引号', 'SELECT N\'it\'\'s ?\', "a""?b", ? AS value', 'SELECT N\'it\'\'s ?\', "a""?b", @p0 AS value'],
    ['嵌套块注释', 'SELECT /* 外层 /* ? */ 仍在注释 ? */ ? AS value', 'SELECT /* 外层 /* ? */ 仍在注释 ? */ @p0 AS value'],
    ['临时表名', 'SELECT ? AS value FROM #items WHERE id = ?', 'SELECT @p0 AS value FROM #items WHERE id = @p1'],
    ['反斜杠不转义引号', String.raw`SELECT '\' AS literal, ? AS value`, String.raw`SELECT '\' AS literal, @p0 AS value`],
    ['回车结束行注释', 'SELECT 1 -- ?\r, ? AS value', 'SELECT 1 -- ?\r, @p0 AS value']
  ]) {
    const msCase = msProbe(); await msCase.driver.query({}, sql, [1, 2]);
    check('MSSQL 词法边界：' + name, expected, msCase.sent[0]);
  }
  const pgNative = pgProbe();
  await pgNative.driver.query({}, "SELECT doc ? 'key' FROM items", []);
  check('PG 无参数查询原样保留单问号运算符', "SELECT doc ? 'key' FROM items", pgNative.sent[0].sql);
  for (const value of ['00123', '9007199254740993', '-0.50']) {
    const ms = msProbe(); await ms.driver.query({}, 'SELECT ? AS value', [value]);
    check('MSSQL 保留字符串参数 ' + value, value, ms.inputs[0].value);
  }
  for (const value of [0, -12.5, false, null, '', '1e10', ' 42 ', '0.12345678901234567890']) {
    const msValue = msProbe(); await msValue.driver.query({}, 'SELECT ? AS value', [value]);
    check('MSSQL 保留参数值及类型：' + JSON.stringify(value), { name: 'p0', value }, msValue.inputs[0]);
  }
  const empty = [];
  empty.columns = { id: { name: 'id' }, name: { name: 'name' } };
  const msEmpty = msProbe([empty]); const emptyResult = await msEmpty.driver.query({}, 'SELECT id,name FROM items WHERE 1=0', []);
  check('MSSQL 空结果集保留列头', [{ columns: ['id', 'name'], values: [] }], emptyResult.sets);
  const orderedEmpty = [];
  orderedEmpty.columns = { last: { index: 2 }, first: { index: 0 }, middle: { index: 1 } };
  const msMixed = msProbe([orderedEmpty, [{ value: 42 }], []]);
  check('MSSQL 空结果列顺序和后续结果集', [
    { columns: ['first', 'middle', 'last'], values: [] }, { columns: ['value'], values: [[42]] }
  ], (await msMixed.driver.query({}, '测试 SQL', [])).sets);
  const pgEmpty = pgProbe(); const pgEmptyResult = await pgEmpty.driver.query({}, 'SELECT value FROM items WHERE 1=0', []);
  check('PG 空结果集保留列头', [{ columns: ['value'], values: [] }], pgEmptyResult.sets);
  check('MySQL 普通查询结果', { sets: [{ columns: ['answer'], values: [[42]] }], rowsAffected: 0 },
    await mysqlResult([[42]], [{ name: 'answer' }]));
  check('MySQL DML 开头的多语句保留查询结果和影响行数', { sets: [{ columns: ['answer'], values: [[42]] }], rowsAffected: 1 },
    await mysqlResult([{ affectedRows: 1 }, [[42]]], [undefined, [{ name: 'answer' }]]));
  check('MySQL SELECT 开头的多语句结果', { sets: [{ columns: ['answer'], values: [[42]] }], rowsAffected: 1 },
    await mysqlResult([[[42]], { affectedRows: 1 }], [[{ name: 'answer' }], undefined]));
  check('MySQL 纯 DML 多语句累计影响行数', { sets: [], rowsAffected: 5 },
    await mysqlResult([{ affectedRows: 2 }, { affectedRows: 0 }, { affectedRows: 3 }], [undefined, undefined, undefined]));
  check('MySQL 纯 DML 缺少列元数据时仍累计行数', { sets: [], rowsAffected: 5 },
    await mysqlResult([{ affectedRows: 2 }, { affectedRows: 3 }], undefined));
  check('MySQL DML 中间的空 SELECT 仍保留列头', { sets: [{ columns: ['id'], values: [] }], rowsAffected: 3 },
    await mysqlResult([{ affectedRows: 1 }, [], { affectedRows: 2 }], [undefined, [{ name: 'id' }], undefined]));
  check('MySQL 单条空 SELECT 保留列头', { sets: [{ columns: ['id'], values: [] }], rowsAffected: 0 },
    await mysqlResult([], [{ name: 'id' }]));
  check('MySQL 单条 DML 保留影响行数', { sets: [], rowsAffected: 3 },
    await mysqlResult({ affectedRows: 3 }, undefined));
  for (const [sql, wanted] of [
    ["SELECT 'a;b'; SELECT 2;", 2],
    ['SELECT "a;b"; SELECT 2;', 2],
    ['SELECT 1 /* ; */; -- ;\nSELECT 2;', 2],
    ['SELECT 1 AS [a;b]; SELECT 2;', 2],
    ['CREATE TABLE `a;b` (id INTEGER); SELECT 1;', 2],
    ['SELECT 1 AS [a]];b]; SELECT 2;', 2]
  ]) check('SQL 分句：' + sql, wanted, splitStatements(sql).length, '真实分句函数');
  for (const [name, sql, dialect, wanted] of [
    ['反引号内双写转义', 'SELECT `a``;b`; SELECT 2;', 'sqlite', ['SELECT `a``;b`', 'SELECT 2']],
    ['单引号内双写转义', "SELECT 'a'';b'; SELECT 2;", 'sqlite', ["SELECT 'a'';b'", 'SELECT 2']],
    ['双引号内双写转义', 'SELECT "a"";b"; SELECT 2;', 'sqlite', ['SELECT "a"";b"', 'SELECT 2']],
    ['跳过空片段及尾部纯注释', '; -- 说明\nSELECT 1;; /* 尾注释 ; */', 'sqlite', ['-- 说明\nSELECT 1']],
    ['纯注释无语句', '-- 说明 ;\r/* 更多说明 ; */', 'sqlite', []],
    ['方括号内双写转义', 'SELECT [a]];b]; SELECT 2;', 'mssql', ['SELECT [a]];b]', 'SELECT 2']],
    ['PG 美元引用', "SELECT $$ begin; ' $$; SELECT $x$ a;b $x$;", 'postgres', ["SELECT $$ begin; ' $$", 'SELECT $x$ a;b $x$']],
    ['PG 嵌套注释', '/* 外层 /* ; */ 仍在注释 ; */ SELECT 1; SELECT 2;', 'postgres', ['/* 外层 /* ; */ 仍在注释 ; */ SELECT 1', 'SELECT 2']],
    ['MySQL 井号注释', '# 说明 ;\nSELECT 1; # 尾注释 ;', 'mysql', ['# 说明 ;\nSELECT 1']],
    ['MySQL 字符串反斜杠转义', String.raw`SELECT 'a\';b'; SELECT 2;`, 'mysql', [String.raw`SELECT 'a\';b'`, 'SELECT 2']],
    ['PG E 字符串反斜杠转义', String.raw`SELECT E'a\';b'; SELECT 2;`, 'postgres', [String.raw`SELECT E'a\';b'`, 'SELECT 2']]
  ]) check('SQL 分句边界：' + name, wanted, splitStatements(sql, dialect), '真实分句函数');
  check('PG 前导嵌套注释完整剥离', 'SELECT 1', stripLeadingComments(' /* 外层 /* 内层 */ 仍在注释 */ SELECT 1', 'postgres'), '真实分句函数');
  check('SQLite 井号不会误判为注释', '#items', stripLeadingComments('#items'), '真实分句函数');
  const sqlite = await D.sqlite.connect({ file: ':memory:' });
  try {
    sqlite.db.exec('CREATE TABLE `a;b` (id INTEGER); INSERT INTO `a;b` VALUES (1);');
    let result;
    try { result = (await D.sqlite.query(sqlite, 'SELECT * FROM `a;b`;', [])).sets[0].values; }
    catch (error) { result = error.message; }
    check('SQLite 合法反引号表名经驱动可查询', [[1]], result, '真实内存 SQLite');
    check('SQLite 无参数空结果保留列头', ['id'], (await D.sqlite.query(sqlite, 'SELECT 1 AS id WHERE 1=0', [])).sets[0].columns, '真实内存 SQLite');
    check('SQLite 转义反引号名称的建表、写入及查询', { sets: [{ columns: ['值;'], values: [[7]] }], rowsAffected: 1 },
      await D.sqlite.query(sqlite, 'CREATE TABLE `a``;b` (`值;` INTEGER); INSERT INTO `a``;b` VALUES (7); SELECT * FROM `a``;b`;', []), '真实内存 SQLite');
    check('SQLite DDL 不沿用上一条 DML 行数', { sets: [], rowsAffected: 0 },
      await D.sqlite.query(sqlite, 'CREATE TABLE counter(id INTEGER); DROP TABLE counter;', []), '真实内存 SQLite');
    check('SQLite 事务指令不沿用上一条 DML 行数', { sets: [], rowsAffected: 0 },
      await D.sqlite.query(sqlite, 'BEGIN; SAVEPOINT one; RELEASE one; COMMIT; BEGIN; ROLLBACK;', []), '真实内存 SQLite');
    check('SQLite WITH DML 计算直接影响行数', { sets: [], rowsAffected: 1 },
      await D.sqlite.query(sqlite, 'WITH item(id) AS (SELECT 2) INSERT INTO `a;b` SELECT id FROM item;', []), '真实内存 SQLite');
    check('SQLite 带参数 WITH DML 计算直接影响行数', { sets: [], rowsAffected: 1 },
      await D.sqlite.query(sqlite, 'WITH item(id) AS (SELECT ?) UPDATE `a;b` SET id = 3 WHERE id IN (SELECT id FROM item);', [2]), '真实内存 SQLite');
    check('SQLite RETURNING 同时返回结果和影响行数', { sets: [{ columns: ['id'], values: [[4]] }], rowsAffected: 1 },
      await D.sqlite.query(sqlite, 'INSERT INTO `a;b` VALUES (?) RETURNING id;', [4]), '真实内存 SQLite');
    check('SQLite 零行 DML 不沿用之前行数', { sets: [], rowsAffected: 0 },
      await D.sqlite.query(sqlite, 'UPDATE `a;b` SET id = 8 WHERE id = 999;', []), '真实内存 SQLite');
    sqlite.db.exec('CREATE TABLE audit(id INTEGER); CREATE TRIGGER audited AFTER INSERT ON `a;b` BEGIN INSERT INTO audit VALUES(new.id); INSERT INTO audit VALUES(new.id); END;');
    check('SQLite 触发器不额外累计间接行数', { sets: [], rowsAffected: 1 },
      await D.sqlite.query(sqlite, 'INSERT INTO `a;b` VALUES (5);', []), '真实内存 SQLite');
    check('SQLite 触发器实际执行写入', 2, sqlite.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n, '真实内存 SQLite');
    sqlite.db.exec('CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER REFERENCES parent(id) ON DELETE CASCADE); INSERT INTO parent VALUES(1); INSERT INTO child VALUES(1),(1);');
    check('SQLite 外键级联不额外累计间接行数', { sets: [], rowsAffected: 1 },
      await D.sqlite.query(sqlite, 'DELETE FROM parent WHERE id = 1;', []), '真实内存 SQLite');
  } finally { await D.sqlite.close(sqlite); }

  const mysql = Object.create(D.mysql);
  let attempts = 0, mysqlClosed = 0;
  mysql._open = async () => {
    attempts++; await delay(); if (attempts === 1) throw new Error('模拟首次重连失败');
    return { query: async () => [[[1]], [{ name: 'v' }]], end: async () => { mysqlClosed++; }, destroy() {} };
  };
  const mysqlSession = { cfg: {}, conn: { destroy() {} }, broken: new Error('模拟断线') };
  const retries = await Promise.allSettled(Array.from({ length: 16 }, () => mysql.query(mysqlSession, 'SELECT 1', [])));
  await mysql.close(mysqlSession); await mysql.close(mysqlSession);
  check('MySQL 重连失败可重试且排队恢复', { attempts: 2, fulfilled: 15, rejected: 1, closed: 1 },
    { attempts, fulfilled: retries.filter(r => r.status === 'fulfilled').length, rejected: retries.filter(r => r.status === 'rejected').length, closed: mysqlClosed });

  for (const id of ['postgres', 'mssql']) {
    const driver = Object.create(D[id]);
    let fail = true, opened = 0, closed = 0;
    const create = async () => { await delay(); if (fail) throw new Error('模拟建连失败'); opened++; return { __state: {}, end: async () => { closed++; }, close: async () => { closed++; } }; };
    driver._openClient = create; driver._newPool = create;
    const session = { database: 'main', cfg: {}, client: { end: async () => {} }, extra: new Map(), pools: new Map() };
    const acquire = () => id === 'postgres' ? driver._clientFor(session, 'target') : driver._poolFor(session, 'target');
    const failed = await Promise.allSettled(Array.from({ length: 16 }, acquire));
    check(id + ' 并发失败后清理待建连缓存', { rejected: 16, pending: 0 }, { rejected: failed.filter(r => r.status === 'rejected').length, pending: session.pending.size });
    fail = false; const pending = Array.from({ length: 16 }, acquire); const closing = driver.close(session);
    const resources = await Promise.all(pending); await closing; await driver.close(session);
    let rejection = false; try { await acquire(); } catch (e) { rejection = true; }
    check(id + ' 去重、建连中关闭、重复关闭和关闭后拒绝新连接', { opened: 1, closed: 1, distinct: 1, rejection: true },
      { opened, closed, distinct: new Set(resources).size, rejection });
  }
  const pg = Object.create(D.postgres); let reopens = 0, ends = 0;
  pg._openClient = async () => { reopens++; await delay(); return { __state: {}, end: async () => { ends++; } }; };
  const pgSession = { database: 'main', cfg: {}, client: { __state: { broken: true }, end: async () => { ends++; } }, extra: new Map() };
  await Promise.all(Array.from({ length: 16 }, () => pg._clientFor(pgSession, 'main'))); await pg.close(pgSession);
  check('PG 主库并发重连只建一次且资源回收', { reopens: 1, ends: 2 }, { reopens, ends });

  for (const [name, headers, expected] of [
    ['回环 Host', { host: '127.0.0.1:8777' }, null],
    ['恶意 Host', { host: 'attacker.test' }, 403],
    ['伪回环域名', { host: '127.0.0.1.attacker.test:8777' }, 403],
    ['同源 Origin', { host: 'localhost:8777', origin: 'http://localhost:8777' }, null],
    ['跨源 Origin', { host: '127.0.0.1:8777', origin: 'https://attacker.test' }, 403],
    ['null Origin', { host: '127.0.0.1:8777', origin: 'null' }, 403],
    ['跨站 Fetch-Site', { host: '127.0.0.1:8777', 'sec-fetch-site': 'cross-site' }, 403]
  ]) check('请求防护：' + name, expected, api.checkRequest({ method: 'GET', headers })?.code || null, '真实请求校验函数');
  for (const [ct, expected] of [['application/json; charset=utf-8', null], ['text/plain', 415], ['', 415]])
    check('请求防护：POST ' + ct, expected, api.checkRequest({ method: 'POST', headers: { host: '127.0.0.1:8777', 'content-type': ct } })?.code || null, '真实请求校验函数');

  const passed = results.filter(r => r.pass).length, failed = results.length - passed;
  console.log(`驱动回归：${passed} 项通过，${failed} 项失败。远程驱动使用模拟资源，未经真库验证。`);
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 2; });
