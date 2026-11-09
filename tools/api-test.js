/**
 * api-test.js — 后端 HTTP API 端到端测试
 * 用 node:sqlite 驱动真实跑通 connect → query → schema → columns → 编辑 → 断开
 * 并验证 mysql / postgres / mssql 驱动可正常加载与给出可读错误
 *
 * 用法: node tools/api-test.js [baseUrl]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const BASE = process.argv[2] || 'http://127.0.0.1:8777';
let pass = 0, fail = 0;
const log = (...a) => console.log(...a);
function check(name, cond, extra) {
  if (cond) { pass++; log('  PASS ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
}

async function api(pathname, body, method) {
  const res = await fetch(BASE + pathname, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* ignore */ }
  return { status: res.status, json };
}

(async () => {
  log('\n=== SQLTool 后端 API 测试 ===');
  log('目标: ' + BASE + '\n');

  // 记录测试开始前的会话基线：本套件只开 1 个会话，结束时应当回到基线。
  // 不能硬编码为 0 —— 服务进程可能被之前的 UI 测试留下会话。
  let baselineSessions = 0;
  try {
    const h0 = await api('/api/health');
    baselineSessions = (h0.json && h0.json.data && h0.json.data.sessions) || 0;
  } catch (e) { /* 服务未启动时后续断言自然会失败 */ }

  /* ---------- 1. 驱动列表 ---------- */
  log('[1] 驱动探测');
  const drv = await api('/api/drivers');
  check('GET /api/drivers 返回成功', drv.json && drv.json.ok === true);
  const drivers = (drv.json.data.drivers || []);
  const byId = Object.fromEntries(drivers.map(d => [d.id, d]));
  log('    ' + drivers.map(d => d.id + '=' + (d.available ? '可用' : '缺失')).join('  '));
  check('包含 mysql 驱动', !!byId.mysql);
  check('包含 postgres 驱动', !!byId.postgres);
  check('包含 mssql 驱动', !!byId.mssql);
  check('mysql 驱动可用', byId.mysql.available === true, byId.mysql.reason);
  check('postgres 驱动可用', byId.postgres.available === true, byId.postgres.reason);
  check('mssql 驱动可用', byId.mssql.available === true, byId.mssql.reason);
  check('默认端口正确 (3306/5432/1433)',
    byId.mysql.defaultPort === 3306 && byId.postgres.defaultPort === 5432 && byId.mssql.defaultPort === 1433);

  /* ---------- 2. 参数校验 ---------- */
  log('\n[2] 连接参数校验');
  const noHost = await api('/api/connect', { driver: 'mysql' });
  check('缺少主机时拒绝连接', noHost.json.ok === false && /主机/.test(noHost.json.error), noHost.json.error);
  const noUser = await api('/api/connect', { driver: 'postgres', host: '127.0.0.1' });
  check('缺少用户名时拒绝连接', noUser.json.ok === false && /用户名/.test(noUser.json.error), noUser.json.error);
  const badDrv = await api('/api/connect', { driver: 'oracle' });
  check('未知驱动被拒绝', badDrv.json.ok === false && /未知/.test(badDrv.json.error), badDrv.json.error);

  /* ---------- 3. 远程驱动错误可读性 ---------- */
  log('\n[3] 远程驱动连接错误（不可达主机）');
  for (const [drvId, port] of [['mysql', 13306], ['postgres', 15432], ['mssql', 11433]]) {
    const r = await api('/api/connect', {
      driver: drvId, host: '127.0.0.1', port, user: 'nobody', password: 'x', database: 'test'
    });
    const msg = (r.json && r.json.error) || '';
    check(drvId + ' 返回可读错误而非崩溃', r.json && r.json.ok === false && msg.length > 0, msg.slice(0, 90));
  }

  /* ---------- 4. SQLite 会话全链路 ---------- */
  log('\n[4] SQLite 会话全链路');
  const tmpDb = path.join(os.tmpdir(), 'sqltool-api-test-' + Date.now() + '.db');
  const conn = await api('/api/connect', { driver: 'sqlite', file: tmpDb, name: 'API测试库' });
  check('建立 SQLite 连接', conn.json && conn.json.ok === true, conn.json && conn.json.error);
  const connId = conn.json.data.connId;
  check('返回 serverVersion', /^\d+\.\d+/.test(conn.json.data.serverVersion), conn.json.data.serverVersion);
  check('返回 dialect=sqlite', conn.json.data.dialect === 'sqlite');

  /* 建表 + 插入 + 查询 */
  const ddl = await api('/api/query', {
    connId,
    sql: `CREATE TABLE products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT,
      price REAL,
      stock INTEGER DEFAULT 0
    );
    CREATE INDEX idx_products_cat ON products(category);`
  });
  check('执行 DDL 成功', ddl.json.ok === true, ddl.json.error);

  const ins = await api('/api/query', {
    connId,
    sql: `INSERT INTO products (name, category, price, stock) VALUES
      ('机械键盘','外设',499.00,120),
      ('人体工学椅','家具',1899.00,30),
      ('显示器','外设',2299.00,45),
      ('USB 扩展坞','外设',349.00,200),
      ('升降桌','家具',2599.00,15);`
  });
  check('INSERT 返回受影响行数 5', ins.json.ok === true && ins.json.data.rowsAffected === 5,
    'rowsAffected=' + (ins.json.data && ins.json.data.rowsAffected));

  const sel = await api('/api/query', {
    connId,
    sql: 'SELECT category, COUNT(*) AS 数量, ROUND(SUM(price*stock),2) AS 库存金额 FROM products GROUP BY category ORDER BY 库存金额 DESC;'
  });
  check('聚合查询返回结果集', sel.json.ok === true && sel.json.data.sets.length === 1, sel.json.error);
  const set = sel.json.data.sets[0];
  log('    列: ' + JSON.stringify(set.columns));
  log('    数据: ' + JSON.stringify(set.values));
  check('列名正确', set.columns.join(',') === 'category,数量,库存金额');
  check('分组行数为 2', set.values.length === 2);
  const furniture = set.values.find(r => r[0] === '家具');
  const peripherals = set.values.find(r => r[0] === '外设');
  // 家具 = 1899*30 + 2599*15 = 56970 + 38985 = 95955
  // 外设 = 499*120 + 2299*45 + 349*200 = 59880 + 103455 + 69800 = 233135
  check('家具库存金额 = 95955', furniture && Math.abs(furniture[2] - 95955) < 0.01, JSON.stringify(furniture));
  check('外设库存金额 = 233135', peripherals && Math.abs(peripherals[2] - 233135) < 0.01, JSON.stringify(peripherals));

  /* 读取 schema */
  const sch = await api('/api/schema', { connId });
  check('读取 schema 成功', sch.json.ok === true, sch.json.error);
  const tables = sch.json.data.tables || [];
  check('schema 返回 1 张表', tables.length === 1, '实际 ' + tables.length);
  check('表名与行数正确', tables[0].name === 'products' && tables[0].rowCount === 5,
    tables[0].name + '/' + tables[0].rowCount);
  check('schema 标记 lazy（列按需加载）', tables[0].lazy === true);

  /* 读取列 */
  const cols = await api('/api/columns', { connId, table: 'products' });
  check('读取列定义成功', cols.json.ok === true, cols.json.error);
  const colDefs = cols.json.data.columns;
  log('    列: ' + colDefs.map(c => c.name + ':' + c.type + (c.pk ? ' PK' : '') + (c.notnull ? ' NN' : '')).join(', '));
  check('列数为 5', colDefs.length === 5);
  check('id 为主键且自增', colDefs[0].pk === true && colDefs[0].type === 'INTEGER');
  check('name 为 NOT NULL', colDefs[1].notnull === true && colDefs[1].name === 'name');

  /* 存储过程 / 函数：SQLite 没有这类对象，但接口必须存在、字段类型正确且不报错 */
  check('schema 返回 procedures 数组', Array.isArray(sch.json.data.procedures),
    typeof sch.json.data.procedures);
  check('schema 返回 functions 数组', Array.isArray(sch.json.data.functions),
    typeof sch.json.data.functions);
  check('SQLite 的存储过程 / 函数列表为空',
    sch.json.data.procedures.length === 0 && sch.json.data.functions.length === 0);

  const rddl = await api('/api/routine-ddl', { connId, name: 'anything', kind: 'procedure' });
  check('SQLite 读取过程定义给出可读提示',
    rddl.json.ok === false && /不支持/.test(rddl.json.error || ''), rddl.json.error);

  const rddlNoName = await api('/api/routine-ddl', { connId });
  check('读取过程定义缺少对象名时被拒绝',
    rddlNoName.json.ok === false && /缺少对象名/.test(rddlNoName.json.error || ''), rddlNoName.json.error);

  const rddlGhost = await api('/api/routine-ddl', { connId: 'not-exist', name: 'x' });
  check('读取过程定义时无效会话返回 410', rddlGhost.status === 410, String(rddlGhost.status));

  /* 参数化更新（模拟单元格编辑） */
  const upd = await api('/api/query', {
    connId,
    sql: 'UPDATE products SET price = ? WHERE id = ?;',
    params: [559.00, 1]
  });
  check('参数化 UPDATE 成功', upd.json.ok === true && upd.json.data.rowsAffected === 1,
    'rowsAffected=' + (upd.json.data && upd.json.data.rowsAffected));
  const after = await api('/api/query', { connId, sql: 'SELECT price FROM products WHERE id = 1;' });
  check('更新后的值可读回', Math.abs(after.json.data.sets[0].values[0][0] - 559) < 0.001,
    String(after.json.data.sets[0].values[0][0]));

  /* 事务回滚 */
  const rollback = await api('/api/query', {
    connId,
    sql: "BEGIN; INSERT INTO products (name) VALUES ('临时'); ROLLBACK;"
  });
  check('事务回滚语句执行成功', rollback.json.ok === true, rollback.json.error);
  const cnt = await api('/api/query', { connId, sql: 'SELECT COUNT(*) FROM products;' });
  check('回滚后行数仍为 5', cnt.json.data.sets[0].values[0][0] === 5, String(cnt.json.data.sets[0].values[0][0]));

  /* 错误处理 */
  const bad = await api('/api/query', { connId, sql: 'SELEC * FROM products;' });
  check('语法错误被识别为 SQL 错误', bad.json.ok === false && bad.json.sqlError === true);
  check('错误消息可读', /syntax error/i.test(bad.json.error), bad.json.error.slice(0, 70));

  const noTable = await api('/api/query', { connId, sql: 'SELECT * FROM 不存在的表;' });
  check('表不存在给出可读错误', /no such table/i.test(noTable.json.error || ''), (noTable.json.error || '').slice(0, 70));

  /* 空 SQL */
  const empty = await api('/api/query', { connId, sql: '   ' });
  check('空 SQL 被拒绝', empty.json.ok === false && /不能为空/.test(empty.json.error));

  /* 无效会话 */
  const ghost = await api('/api/query', { connId: 'not-exist', sql: 'SELECT 1;' });
  check('无效会话返回 410', ghost.status === 410 && /不存在|超时/.test(ghost.json.error), ghost.json.error);

  /* ---------- 5. 持久化验证 ---------- */
  log('\n[5] 文件持久化（断开后重连）');
  await api('/api/disconnect', { connId });
  check('数据库文件已写入磁盘', fs.existsSync(tmpDb), tmpDb);
  const conn2 = await api('/api/connect', { driver: 'sqlite', file: tmpDb, name: '重连' });
  check('重新打开数据库', conn2.json.ok === true, conn2.json.error);
  const cnt2 = await api('/api/query', { connId: conn2.json.data.connId, sql: 'SELECT COUNT(*) AS c FROM products;' });
  check('重连后数据仍在（5 行）', cnt2.json.data.sets[0].values[0][0] === 5,
    String(cnt2.json.data.sets[0].values[0][0]));
  await api('/api/disconnect', { connId: conn2.json.data.connId });
  try { fs.unlinkSync(tmpDb); } catch (e) { /* ignore */ }

  /* ---------- 6. 已保存连接 ---------- */
  log('\n[6] 已保存连接 CRUD');
  // 用本次运行唯一的主机名，保证去重键不会和磁盘上遗留的记录撞车
  const uniqHost = '10.9.' + (Date.now() % 200) + '.' + ((Date.now() >> 8) % 200);
  const wantId = 's_test_' + Date.now();
  const saveRes = await api('/api/saved', {
    id: wantId, name: '生产库', driver: 'mysql', host: uniqHost, port: 3306,
    user: 'readonly', database: 'biz', savePassword: true, password: 'secret123'
  });
  check('保存连接成功', saveRes.json.ok === true, saveRes.json.error);
  const savedId = (saveRes.json.data.saved || {}).id;   // 实际落库 id
  const listRes = await api('/api/saved');
  const saved = (listRes.json.data.connections || []).find(x => x.id === savedId);
  check('列表中能查到该连接', !!saved && saved.name === '生产库');
  check('密码不会明文回传前端', saved.password === '••••••', String(saved.password));
  check('标记存在密码', saved.hasPassword === true);

  // 去重：同一组「驱动+主机+端口+用户+库+文件」再次保存，应当原地更新而不是新增
  const cntBefore = (listRes.json.data.connections || []).length;
  const saveAgain = await api('/api/saved', {
    name: '生产库(改名)', driver: 'mysql', host: uniqHost, port: 3306,
    user: 'readonly', database: 'biz', savePassword: false   // 注意：这次不保存密码
  });
  check('重复保存同一连接不报错', saveAgain.json.ok === true, saveAgain.json.error);
  const listRes3 = await api('/api/saved');
  const afterList = listRes3.json.data.connections || [];
  check('重复保存不新增记录（去重生效）', afterList.length === cntBefore,
    'before=' + cntBefore + ' after=' + afterList.length);
  const again = afterList.find(x => x.id === savedId);
  check('去重后复用同一条记录', !!again && again.id === savedId);
  check('名称已就地更新', !!again && again.name === '生产库(改名)', again && again.name);
  check('未勾选保存密码时沿用旧密码', !!again && again.hasPassword === true);
  check('createdAt 保持不变', !!again && again.createdAt === saved.createdAt);

  const delRes = await api('/api/saved/delete', { id: savedId });
  check('删除连接成功', delRes.json.ok === true);
  const listRes2 = await api('/api/saved');
  check('删除后列表中不再存在', !(listRes2.json.data.connections || []).some(x => x.id === savedId));

  /* ---------- 7. 安全 ---------- */
  log('\n[7] 安全校验');
  const rebindStatus = await new Promise(resolve => {
    const u = new URL(BASE);
    const req = http.request({
      host: u.hostname, port: u.port, path: '/api/drivers', method: 'GET',
      headers: { Host: 'evil.example.com' }
    }, r => { r.resume(); resolve(r.statusCode); });
    req.on('error', () => resolve(0));
    req.end();
  });
  check('非本地 Host 头被拒绝 (403)', rebindStatus === 403, 'status=' + rebindStatus);
  const health = await api('/api/health');
  check('健康检查可用', health.json.ok === true);
  check('断开后会话数回到基线', health.json.data.sessions === baselineSessions,
    'sessions=' + health.json.data.sessions + ' baseline=' + baselineSessions);

  log('\n===== API 测试完成：通过 ' + pass + ' 项，失败 ' + fail + ' 项 =====');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
