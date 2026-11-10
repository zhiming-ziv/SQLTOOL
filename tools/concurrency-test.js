/**
 * 并发压测：自动启动隔离服务，使用临时 SQLite 库，不读取或修改已保存连接。
 * 用法：node tools/concurrency-test.js [--duration=3] [--rounds=2] [--levels=1,8,32,64,128]
 * 原始结果默认写入 shots/concurrency-时间戳.json。只测试本机 HTTP 与服务端 SQLite，
 * 不代表远程真库、浏览器渲染或开放到达率下的容量；远程驱动竞态使用模拟连接复现。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { fork, execFileSync } = require('child_process');
const { performance, monitorEventLoopDelay } = require('perf_hooks');
const ROOT = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 在独立进程内采样，不改动生产代码；端口 0 由系统分配，避免占用现有服务。
if (process.argv[2] === '--server-child') {
  const listen = http.Server.prototype.listen;
  http.Server.prototype.listen = function () {
    this.once('listening', () => process.send({ ready: true, port: this.address().port }));
    return listen.call(this, 0, '127.0.0.1');
  };
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  let started, cpu, peakRss;
  const reset = () => {
    started = performance.now();
    cpu = process.cpuUsage();
    peakRss = process.memoryUsage().rss;
    lag.reset();
  };
  reset();
  setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 50).unref();
  process.on('message', message => {
    if (message.action === 'reset') reset();
    const used = process.cpuUsage(cpu);
    process.send({ id: message.id, metrics: {
      cpuOneCorePct: (used.user + used.system) / ((performance.now() - started) * 10),
      peakRssMiB: Math.max(peakRss, process.memoryUsage().rss) / 2 ** 20,
      eventLoopP99Ms: lag.percentile(99) / 1e6,
      eventLoopMaxMs: lag.max / 1e6
    } });
  });
  require('../server');
} else {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

function percentile(sorted, p) {
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : 0;
}

async function main() {
  const options = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')));
  const duration = Number(options.duration || 3);
  const rounds = Number(options.rounds || 2);
  const levels = (options.levels || '1,8,32,64,128').split(',').map(Number);
  if (!(duration >= 0.2 && duration <= 60) || !Number.isInteger(rounds) || rounds < 1 || rounds > 10 ||
      !levels.length || levels.some(n => !Number.isInteger(n) || n < 1 || n > 512)) {
    throw new Error('参数无效：duration 为 0.2～60 秒，rounds 为 1～10，levels 为 1～512 的整数列表');
  }
  const output = path.resolve(ROOT, options.output || 'shots/concurrency-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqltool-concurrency-'));
  const database = path.join(tempDir, 'load.db');
  const report = {
    startedAt: new Date().toISOString(),
    environment: {
      node: process.version, os: os.platform() + ' ' + os.release(),
      cpu: os.cpus()[0].model, logicalCpus: os.cpus().length,
      totalRamGiB: os.totalmem() / 2 ** 30, freeRamGiB: os.freemem() / 2 ** 30,
      commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
    },
    methodology: {
      durationSeconds: duration, rounds, levels, warmupSeconds: 0.3,
      model: '闭环：每个工作者同时最多一个请求，无等待思考时间，HTTP keep-alive；延迟包含传输、排队、完整响应读取和校验',
      throughput: '成功请求数 / 实际耗时（包含排空在途请求）；预热不计入',
      scope: '同机独立 Node 进程与回环网络，服务端 SQLite 临时文件；MySQL/PG/MSSQL 未经真库验证',
      metrics: 'CPU 以单核 100% 计，RSS 每 50ms 采样，事件循环监测分辨率 10ms；压测端 CPU 同时记录',
      data: '100000 行、主键索引、每行 96 字节文本；默认 DELETE 日志、FULL 同步；写入每请求自动提交一次'
    },
    results: [], checks: [], races: []
  };
  const child = fork(__filename, ['--server-child'], {
    cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-12000); });
  child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-12000); });
  const agent = new http.Agent({ keepAlive: true, maxSockets: Math.max(...levels) + 16, maxFreeSockets: Math.max(...levels) + 16 });
  const sessions = new Set();
  let port, rpcId = 0;
  const pending = new Map();
  child.on('message', message => {
    if (pending.has(message.id)) { pending.get(message.id)(message.metrics); pending.delete(message.id); }
  });
  const rpc = action => new Promise((resolve, reject) => {
    const id = ++rpcId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('采样进程响应超时')); }, 15000);
    pending.set(id, result => { clearTimeout(timer); resolve(result); });
    child.send({ id, action });
  });
  function request(route, body, validate) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({
        hostname: '127.0.0.1', port, path: route, agent, method: payload ? 'POST' : 'GET',
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
      }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) throw new Error('HTTP ' + res.statusCode);
            const data = Buffer.concat(chunks);
            let json;
            if (route.startsWith('/api/')) {
              json = JSON.parse(data);
              if (json.ok !== true) throw new Error(json.error || 'API 返回失败');
            }
            if (validate) validate(json ? json.data : data);
            resolve(json ? json.data : data);
          } catch (error) { reject(error); }
        });
      });
      const deadline = setTimeout(() => req.destroy(new Error('请求超过 15 秒')), 15000);
      req.on('close', () => clearTimeout(deadline));
      req.on('error', reject);
      req.end(payload);
    });
  }
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const query = (connId, sql, params, validate) => request('/api/query', { connId, sql, params }, validate);
  async function connect(file) {
    const data = await request('/api/connect', { driver: 'sqlite', file });
    sessions.add(data.connId);
    return data.connId;
  }
  async function disconnect(connId) {
    await request('/api/disconnect', { connId });
    sessions.delete(connId);
  }
  function check(name, actual, expected) {
    const passed = actual === expected;
    report.checks.push({ name, passed, actual, expected });
    console.log((passed ? '通过：' : '失败：') + name + '，实际=' + actual);
  }
  async function phase(scenario, concurrency, seconds) {
    const latencies = [], errors = {};
    let successful = 0, failed = 0, sequence = 0;
    const started = performance.now();
    const cpu = process.cpuUsage();
    const until = started + seconds * 1000;
    await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
      while (performance.now() < until) {
        const t0 = performance.now();
        try { await scenario.run(worker, sequence++); successful++; }
        catch (error) { failed++; errors[error.message] = (errors[error.message] || 0) + 1; }
        latencies.push(performance.now() - t0);
      }
    }));
    const elapsedMs = performance.now() - started;
    const used = process.cpuUsage(cpu);
    latencies.sort((a, b) => a - b);
    return {
      elapsedMs, successful, failed, errorRate: failed / (successful + failed), errors,
      requestsPerSecond: successful / (elapsedMs / 1000),
      p50Ms: percentile(latencies, 0.5), p95Ms: percentile(latencies, 0.95),
      p99Ms: percentile(latencies, 0.99), maxMs: latencies[latencies.length - 1] || 0,
      clientCpuOneCorePct: (used.user + used.system) / (elapsedMs * 10)
    };
  }

  try {
    port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('启动服务超时：' + logs)), 15000);
      child.once('exit', code => { clearTimeout(timer); reject(new Error('服务提前退出：' + code + '\n' + logs)); });
      child.on('message', message => { if (message.ready) { clearTimeout(timer); resolve(message.port); } });
    });
    report.port = port;
    console.log('独立压测服务：http://127.0.0.1:' + port + '；原始结果：' + output);
    check('初始会话数', (await request('/api/health')).sessions, 0);
    const shared = await connect(database);
    await query(shared, `CREATE TABLE bench (id INTEGER PRIMARY KEY, value INTEGER NOT NULL, payload TEXT NOT NULL);
      BEGIN;
      INSERT INTO bench SELECT value, value % 100, printf('%096d', value)
      FROM (WITH RECURSIVE seq(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM seq WHERE value<100000) SELECT value FROM seq);
      CREATE TABLE counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO counter VALUES (1, 0);
      COMMIT;`);
    const metadata = await query(shared, 'SELECT COUNT(*) FROM bench; PRAGMA journal_mode; PRAGMA synchronous; SELECT sqlite_version();');
    report.database = metadata.sets.map(set => ({ columns: set.columns, values: set.values }));
    const peers = [];
    for (let i = 0; i < Math.max(...levels); i++) peers.push(await connect(database));
    let writeCount = 0;
    const scenarios = [
      { id: 'health', name: '健康接口', run: () => request('/api/health', undefined, data => assert(data.sessions === peers.length + 1, '会话数异常')) },
      { id: 'static', name: '工作台 HTML', run: () => request('/app/index.html', undefined, data => assert(data.includes(Buffer.from('</html>')), 'HTML 内容不完整')) },
      { id: 'shared-read', name: '单会话主键查询', run: (_, n) => {
        const id = n % 100000 + 1;
        return query(shared, 'SELECT id, value, payload FROM bench WHERE id = ?', [id], data => {
          const rows = data.sets[0].values;
          assert(rows.length === 1 && rows[0][0] === id && rows[0][1] === id % 100 && rows[0][2].length === 96, '主键查询结果错误');
        });
      } },
      { id: 'multi-read', name: '多会话主键查询', run: (worker, n) => {
        const id = n % 100000 + 1;
        return query(peers[worker], 'SELECT id, value FROM bench WHERE id = ?', [id], data => {
          assert(data.sets[0].values.length === 1 && data.sets[0].values[0][0] === id && data.sets[0].values[0][1] === id % 100, '多会话查询结果错误');
        });
      } },
      { id: 'large-read', name: '返回 1000 行', run: worker => query(peers[worker], 'SELECT id, value, payload FROM bench ORDER BY id LIMIT 1000', [], data => {
        const rows = data.sets[0].values;
        assert(rows.length === 1000 && rows[0][0] === 1 && rows[999][0] === 1000 && rows[999][2].length === 96, '大结果集不完整');
      }) },
      { id: 'write', name: '多会话持久化写入', run: async worker => {
        await query(peers[worker], 'UPDATE counter SET value = value + 1 WHERE id = 1', [], data => assert(data.rowsAffected === 1, '更新行数错误'));
        writeCount++;
      } },
      { id: 'schema', name: '读取表结构及行数', run: worker => request('/api/schema', { connId: peers[worker] }, data => {
        assert(data.tables.some(table => table.name === 'bench' && table.rowCount === null), '表结构应按需统计行数');
      }) }
    ];
    for (const scenario of scenarios) {
      for (const concurrency of levels) {
        const warmup = await phase(scenario, concurrency, 0.3);
        if (warmup.failed) report.checks.push({ name: scenario.name + '预热', passed: false, errors: warmup.errors });
        for (let round = 1; round <= rounds; round++) {
          await rpc('reset');
          const result = await phase(scenario, concurrency, duration);
          result.server = await rpc('snapshot');
          Object.assign(result, { scenario: scenario.id, name: scenario.name, concurrency, round });
          report.results.push(result);
          console.log(`${scenario.name} 并发=${concurrency} 轮次=${round} 请求/秒=${result.requestsPerSecond.toFixed(0)} P95=${result.p95Ms.toFixed(1)}ms 失败=${result.failed} 服务端CPU=${result.server.cpuOneCorePct.toFixed(0)}%`);
          fs.writeFileSync(output, JSON.stringify(report, null, 2), 'utf8');
        }
      }
    }
    check('原子写入无丢失（包含预热）', (await query(shared, 'SELECT value FROM counter')).sets[0].values[0][0], writeCount);
    for (const peer of peers) await disconnect(peer);

    // 并发建立独立内存数据库，确认相同表名不会读到其他会话的数据。
    const isolationCount = Math.max(...levels);
    const lifecycleStart = performance.now();
    const isolated = await Promise.all(Array.from({ length: isolationCount }, () => connect(':memory:')));
    const connectMs = performance.now() - lifecycleStart;
    await Promise.all(isolated.map((id, index) => query(id, `CREATE TABLE marker (value INTEGER); INSERT INTO marker VALUES (${index});`)));
    let isolationPassed = 0;
    await Promise.all(isolated.map(async (id, index) => {
      for (let i = 0; i < 10; i++) {
        const value = (await query(id, 'SELECT value FROM marker')).sets[0].values[0][0];
        if (value === index) isolationPassed++;
      }
    }));
    check('独立会话结果隔离', isolationPassed, isolationCount * 10);
    await Promise.all(isolated.map(disconnect));
    report.lifecycle = { concurrency: isolationCount, connectBurstMs: connectMs, totalMs: performance.now() - lifecycleStart };

    // 慢 SQL 与健康探针分别使用独立 HTTP 请求，验证主线程阻塞是否波及其他接口。
    const slowSql = 'WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<3000000) SELECT SUM(n) FROM seq';
    const baseline = [];
    for (let i = 0; i < 10; i++) {
      const started = performance.now();
      await request('/api/health');
      baseline.push(performance.now() - started);
    }
    report.blocking = { baselineHealthMs: baseline, samples: [] };
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      const slow = query(shared, slowSql, [], data => assert(data.sets[0].values[0][0] === 4500001500000, '慢查询结果错误'));
      await delay(30);
      const probeStart = performance.now();
      const probe = request('/api/health').then(() => performance.now() - probeStart);
      await slow;
      const queryMs = performance.now() - started;
      const healthMs = await probe;
      report.blocking.samples.push({ queryMs, healthMs, probeDelayMs: probeStart - started });
      console.log(`慢查询干扰：查询=${queryMs.toFixed(1)}ms，同时健康探针=${healthMs.toFixed(1)}ms`);
    }
    await disconnect(shared);
    check('结束后会话完全回收', (await request('/api/health')).sessions, 0);
    report.races = await inspectDriverRaces();
    if (report.races.some(item => item.reproduced)) process.exitCode = 1;
    report.completedAt = new Date().toISOString();
  } catch (error) {
    report.fatalError = error.stack;
    console.error(error);
    process.exitCode = 1;
  } finally {
    for (const id of sessions) {
      try { await disconnect(id); } catch (error) { report.cleanupError = error.message; }
    }
    agent.destroy();
    await new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', resolve);
      child.kill();
    });
    // 只删除本次创建目录中已知的临时数据库文件，保留报告。
    try {
      for (const suffix of ['', '-journal', '-wal', '-shm']) {
        if (fs.existsSync(database + suffix)) fs.unlinkSync(database + suffix);
      }
      fs.rmdirSync(tempDir);
      report.temporaryDatabaseRemoved = true;
    } catch (error) { report.cleanupError = error.message; }
    report.serverLog = logs;
    fs.writeFileSync(output, JSON.stringify(report, null, 2), 'utf8');
    if (report.results.some(result => result.failed) || report.checks.some(item => !item.passed) || report.cleanupError) process.exitCode = 1;
    console.log('测试结束，原始结果：' + output);
  }
}

async function inspectDriverRaces() {
  const { DRIVERS } = require('../server/drivers');
  const findings = [];
  // 模拟 MySQL 单连接的 FIFO 命令队列，只替换网络层，执行真实 query 实现。
  let currentDatabase = 'initial', queue = Promise.resolve();
  const trace = [];
  const conn = {
    query(command) {
      const sql = typeof command === 'string' ? command : command.sql;
      const result = queue.then(async () => {
        await delay(2);
        if (sql.startsWith('USE ')) {
          currentDatabase = sql.slice(5, -1);
          trace.push(sql);
          return [[], []];
        }
        trace.push(sql + ' -> ' + currentDatabase);
        return [[[currentDatabase]], [{ name: 'database' }]];
      });
      queue = result.catch(() => {});
      return result;
    }
  };
  const session = { conn, database: 'initial', broken: null };
  const requested = ['db_a', 'db_b'];
  const results = await Promise.all(requested.map(database => DRIVERS.mysql.query(session, 'SELECT DATABASE()', [], database)));
  const actual = results.map(result => result.sets[0].values[0][0]);
  findings.push({ driver: 'mysql', test: '同会话并发切库', evidence: '模拟连接，未经真库验证', requested, actual, trace, reproduced: actual.some((value, i) => value !== requested[i]) });

  // 同时首次访问同一目标库，观察是否重复建连，以及 close 能否回收全部资源。
  for (const id of ['postgres', 'mssql']) {
    const driver = Object.create(DRIVERS[id]);
    const opened = [], closed = [];
    let s, get;
    if (id === 'postgres') {
      driver._openClient = async () => {
        const n = opened.length;
        const resource = { __state: { broken: null }, end: async () => { closed.push(n); } };
        opened.push(resource);
        await delay(5);
        return resource;
      };
      s = { database: 'initial', cfg: {}, client: { end: async () => {} }, extra: new Map() };
      get = () => driver._clientFor(s, 'other');
    } else {
      driver._newPool = async () => {
        const n = opened.length;
        const resource = { close: async () => { closed.push(n); } };
        opened.push(resource);
        await delay(5);
        return resource;
      };
      s = { database: 'initial', cfg: {}, sqlmod: {}, pools: new Map() };
      get = () => driver._poolFor(s, 'other');
    }
    await Promise.all(Array.from({ length: 16 }, get));
    await driver.close(s);
    findings.push({ driver: id, test: '16 个请求同时首次访问同一库', evidence: '模拟连接，未经真库验证', created: opened.length, closed: closed.length, untracked: opened.length - closed.length, reproduced: opened.length > 1 });
  }
  for (const finding of findings) console.log('驱动竞态检查：' + JSON.stringify(finding));
  return findings;
}
