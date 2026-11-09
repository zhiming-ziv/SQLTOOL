/* ============================================================
 * server/api.js — 后端 HTTP API
 *
 * 仅监听 127.0.0.1，并校验 Host 头，避免 DNS Rebinding。
 * 所有响应统一为 { ok: true, data } 或 { ok: false, error }
 * ============================================================ */
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const D = require('./drivers');

const IDLE_MS = 30 * 60 * 1000;       // 会话空闲 30 分钟回收
const SWEEP_MS = 5 * 60 * 1000;
const SAVED_FILE = path.join(__dirname, '..', 'connections.json');
const MAX_BODY = 8 * 1024 * 1024;

/** connId -> { driver, driverId, session, cfg, lastUsed, info } */
const SESSIONS = new Map();

/** 连接 ID 使用密码学随机 UUID，避免被跨站页面按时间窗口猜中后操作已建立的会话 */
function newId() { return 'c' + crypto.randomUUID().replace(/-/g, ''); }

/** Host 头必须是回环地址（防 DNS Rebinding） */
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
function isLoopbackHost(host) { return LOOPBACK_HOST.test(String(host || '')); }

/**
 * 跨源请求防护（防 CSRF）。返回错误信息字符串，通过则返回 null。
 *  1. Host 必须是回环地址；
 *  2. 带 Origin 时必须与本服务同源（http://<Host>）；
 *  3. 带 Sec-Fetch-Site 时只接受 same-origin / none；
 *  4. POST / PUT 必须声明 Content-Type: application/json ——
 *     跨站页面无法在不触发 CORS 预检的情况下发送该类型，而本服务不响应预检。
 */
function checkRequest(req) {
  const host = String(req.headers.host || '');
  if (!isLoopbackHost(host)) return { code: 403, error: '仅允许通过 127.0.0.1 访问' };
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== 'http://' + host) {
    return { code: 403, error: '拒绝跨源请求' };
  }
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    return { code: 403, error: '拒绝跨源请求' };
  }
  if (req.method === 'POST' || req.method === 'PUT') {
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/json') return { code: 415, error: '请求必须使用 Content-Type: application/json' };
  }
  return null;
}

/* ----------------------------------------------------------
 * 各驱动的服务器信息查询
 * -------------------------------------------------------- */
const INFO_SQL = {
  mysql: "SELECT VERSION() AS v, DATABASE() AS d, CURRENT_USER() AS u",
  postgres: "SELECT version() AS v, current_database() AS d, current_user AS u",
  mssql: "SELECT CAST(SERVERPROPERTY('ProductVersion') AS varchar(50)) AS v, DB_NAME() AS d, SUSER_NAME() AS u",
  sqlite: "SELECT sqlite_version() AS v, '' AS d, '' AS u"
};

async function fetchServerInfo(driverId, driver, session) {
  const out = { version: '', database: null, user: '' };
  try {
    const r = await driver.query(session, INFO_SQL[driverId], []);
    const set = r.sets && r.sets[0];
    if (set && set.values && set.values[0]) {
      out.version = String(set.values[0][0] || '');
      out.database = set.values[0][1] ? String(set.values[0][1]) : null;
      out.user = set.values[0][2] ? String(set.values[0][2]) : '';
    }
  } catch (e) { /* 信息查询失败不影响连接 */ }
  return out;
}

/* ----------------------------------------------------------
 * 会话回收
 * -------------------------------------------------------- */
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of SESSIONS) {
    if (now - s.lastUsed > IDLE_MS) {
      try { s.driver.close(s.session); } catch (e) { /* ignore */ }
      SESSIONS.delete(id);
    }
  }
}, SWEEP_MS).unref();

async function closeAllSessions() {
  for (const [, s] of SESSIONS) {
    try { await s.driver.close(s.session); } catch (e) { /* ignore */ }
  }
  SESSIONS.clear();
}
process.on('SIGINT', async () => { await closeAllSessions(); process.exit(0); });
process.on('SIGTERM', async () => { await closeAllSessions(); process.exit(0); });

/* ----------------------------------------------------------
 * 已保存的连接配置
 * -------------------------------------------------------- */
function readSaved() {
  try {
    if (!fs.existsSync(SAVED_FILE)) return [];
    const txt = fs.readFileSync(SAVED_FILE, 'utf8');
    const arr = JSON.parse(txt);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function writeSaved(list) {
  const tmp = SAVED_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, SAVED_FILE);
}

/* ----------------------------------------------------------
 * 路由
 * -------------------------------------------------------- */
function ok(res, data) { sendJson(res, 200, { ok: true, data }); }
function fail(res, msg, code) { sendJson(res, code || 400, { ok: false, error: String(msg) }); }
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sessionOf(res, connId) {
  const s = SESSIONS.get(connId);
  if (!s) { fail(res, '连接不存在或已超时，请重新连接', 410); return null; }
  s.lastUsed = Date.now();
  return s;
}

/** 主入口：返回 true 表示已处理 */
async function handle(req, res, pathname, body) {
  // Host / Origin / Content-Type 校验（server.js 读取请求体前已校验一次，这里兜底）
  const bad = checkRequest(req);
  if (bad) { fail(res, bad.error, bad.code); return true; }

  try {
    /* ---------- 驱动列表 ---------- */
    if (pathname === '/api/drivers' && req.method === 'GET') {
      return ok(res, { drivers: D.driverStatus() }), true;
    }

    /* ---------- 建立连接 ---------- */
    if (pathname === '/api/connect' && req.method === 'POST') {
      let cfg = body || {};

      // 通过已保存连接发起：由服务端补齐密码，密码不回传前端
      if (cfg.savedId) {
        const s = readSaved().find(x => x.id === cfg.savedId);
        if (!s) return fail(res, '未找到该已保存连接，可能已被删除'), true;
        cfg = {
          driver: s.driver, host: s.host, port: s.port,
          user: s.user, password: s.password || '',
          database: s.database, file: s.file,
          name: cfg.name || s.name
        };
      }

      const driver = D.DRIVERS[cfg.driver];
      if (!driver) return fail(res, '未知的驱动：' + cfg.driver), true;

      if (driver.needsHost && !cfg.host) return fail(res, '请填写主机地址'), true;
      if (driver.needsHost && !cfg.user) return fail(res, '请填写用户名'), true;

      let session;
      try {
        session = await driver.connect(cfg);
      } catch (e) {
        return fail(res, '连接失败：' + (e && e.message ? e.message : e)), true;
      }

      const info = await fetchServerInfo(cfg.driver, driver, session);
      let databases = [];
      try { databases = await driver.databases(session); } catch (e) { /* ignore */ }

      const id = newId();
      SESSIONS.set(id, {
        driver, driverId: cfg.driver, session, cfg,
        lastUsed: Date.now(), info
      });

      return ok(res, {
        connId: id,
        driver: cfg.driver,
        dialect: cfg.driver,
        label: driver.label,
        name: cfg.name || (cfg.host || cfg.file || driver.label),
        serverVersion: info.version,
        currentDatabase: info.database || cfg.database || (databases[0] || null),
        user: info.user,
        databases,
        multiDatabase: databases.length > 0,
        host: cfg.host || null,
        port: cfg.port || null,
        file: cfg.file || null
      }), true;
    }

    /* ---------- 断开连接 ---------- */
    if (pathname === '/api/disconnect' && req.method === 'POST') {
      const id = (body || {}).connId;
      const s = SESSIONS.get(id);
      if (s) {
        try { await s.driver.close(s.session); } catch (e) { /* ignore */ }
        SESSIONS.delete(id);
      }
      return ok(res, { closed: true }), true;
    }

    /* ---------- 执行 SQL ---------- */
    if (pathname === '/api/query' && req.method === 'POST') {
      const b = body || {};
      const s = sessionOf(res, b.connId);
      if (!s) return true;
      const sql = String(b.sql || '');
      if (!sql.trim()) return fail(res, 'SQL 不能为空'), true;

      const t0 = Date.now();
      try {
        const r = await s.driver.query(s.session, sql, b.params || [], b.database || null);
        return ok(res, {
          sets: r.sets || [],
          rowsAffected: r.rowsAffected || 0,
          ms: Date.now() - t0
        }), true;
      } catch (e) {
        return sendJson(res, 200, {
          ok: false,
          error: (e && e.message ? e.message : String(e)),
          sqlError: true,
          ms: Date.now() - t0
        }), true;
      }
    }

    /* ---------- 读取 schema ---------- */
    if (pathname === '/api/schema' && req.method === 'POST') {
      const b = body || {};
      const s = sessionOf(res, b.connId);
      if (!s) return true;
      const database = b.database || s.info.database || (s.cfg.database || null);
      let procedures = [], functions = [];
      try {
        const r = await s.driver.schema(s.session, database);
        // 存储过程 / 函数列表属于「锦上添花」：某些账号没有权限读系统表，
        // 这时不能让整个结构读取失败，表 / 视图照常返回，过程函数留空即可。
        if (typeof s.driver.routines === 'function') {
          try {
            const rt = await s.driver.routines(s.session, database);
            procedures = rt.procedures || [];
            functions = rt.functions || [];
          } catch (e) { /* 无权限：忽略 */ }
        }
        return ok(res, {
          database,
          tables: r.tables || [],
          views: r.views || [],
          procedures,
          functions
        }), true;
      } catch (e) {
        return fail(res, '读取结构失败：' + (e && e.message ? e.message : e)), true;
      }
    }

    /* ---------- 读取单个存储过程 / 函数的定义 ---------- */
    if (pathname === '/api/routine-ddl' && req.method === 'POST') {
      const b = body || {};
      const s = sessionOf(res, b.connId);
      if (!s) return true;
      const database = b.database || s.info.database || (s.cfg.database || null);
      if (!b.name) return fail(res, '缺少对象名'), true;
      try {
        if (typeof s.driver.routineDdl !== 'function') {
          return fail(res, '当前引擎不支持读取存储过程 / 函数定义'), true;
        }
        const ddl = await s.driver.routineDdl(s.session, database, {
          name: b.name, schema: b.schema, kind: b.kind, oid: b.oid
        });
        return ok(res, { ddl: ddl || '' }), true;
      } catch (e) {
        return fail(res, '读取定义失败：' + (e && e.message ? e.message : e)), true;
      }
    }

    /* ---------- 读取某张表的列 ---------- */
    if (pathname === '/api/columns' && req.method === 'POST') {
      const b = body || {};
      const s = sessionOf(res, b.connId);
      if (!s) return true;
      try {
        const cols = await s.driver.columns(s.session, b.database || null, b.table);
        return ok(res, { columns: cols }), true;
      } catch (e) {
        return fail(res, '读取列定义失败：' + (e && e.message ? e.message : e)), true;
      }
    }

    /* ---------- 列出数据库 ---------- */
    if (pathname === '/api/databases' && req.method === 'POST') {
      const s = sessionOf(res, (body || {}).connId);
      if (!s) return true;
      try { return ok(res, { databases: await s.driver.databases(s.session) }), true; }
      catch (e) { return fail(res, e.message), true; }
    }

    /* ---------- 已保存的连接 ---------- */
    if (pathname === '/api/saved' && req.method === 'GET') {
      const list = readSaved().map(x => ({ ...x, password: x.password ? '••••••' : undefined, hasPassword: !!x.password }));
      return ok(res, { connections: list }), true;
    }

    if (pathname === '/api/saved' && req.method === 'POST') {
      const cfg = body || {};
      if (!cfg.driver) return fail(res, '缺少驱动类型'), true;
      const list = readSaved();

      // 按「驱动 + 主机 + 端口 + 用户 + 库 + 文件」去重，避免每次连接都新增一条
      const keyOf = x => [x.driver, x.host || '', x.port || '', x.user || '', x.database || '', x.file || ''].join('\u0001');
      const key = keyOf(cfg);
      const dup = list.find(x => keyOf(x) === key);

      const id = (dup && dup.id) || cfg.id || ('s_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
      const prev = list.find(x => x.id === id) || {};
      const item = {
        id,
        name: cfg.name || dup && dup.name || cfg.host || cfg.file || cfg.driver,
        driver: cfg.driver,
        host: cfg.host || '',
        port: cfg.port || null,
        user: cfg.user || '',
        database: cfg.database || '',
        file: cfg.file || '',
        savePassword: !!cfg.savePassword,
        // 未勾选保存密码时，沿用上一次已保存的密码，避免去重时把密码抹掉
        password: cfg.savePassword ? (cfg.password || '') : (prev.password || ''),
        createdAt: (prev && prev.createdAt) || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      const i = list.findIndex(x => x.id === id);
      if (i >= 0) list[i] = item; else list.push(item);
      writeSaved(list);
      return ok(res, { saved: { ...item, password: undefined, hasPassword: !!item.password } }), true;
    }

    if (pathname === '/api/saved/delete' && req.method === 'POST') {
      const id = (body || {}).id;
      writeSaved(readSaved().filter(x => x.id !== id));
      return ok(res, { deleted: true }), true;
    }

    /* ---------- 健康检查 ---------- */
    if (pathname === '/api/health' && req.method === 'GET') {
      return ok(res, {
        sessions: SESSIONS.size,
        drivers: D.driverStatus().map(d => ({ id: d.id, available: d.available }))
      }), true;
    }

    return false;
  } catch (e) {
    fail(res, '服务器内部错误：' + (e && e.message ? e.message : e), 500);
    return true;
  }
}

module.exports = { handle, MAX_BODY, closeAllSessions, checkRequest, isLoopbackHost };
