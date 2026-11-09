/* ============================================================
 * server/drivers.js — 后端数据库驱动适配层
 *
 * 每个驱动实现统一接口：
 *   load()                        加载驱动模块，失败抛可读错误
 *   connect(cfg)                  建立会话
 *   query(session, sql, params)   执行 SQL，返回 { sets, rowsAffected }
 *   databases(session)            列出数据库名
 *   schema(session, database)     返回 { tables, views }（不含列，列按需拉取）
 *   columns(session, database, table, schema)  返回列定义
 *   close(session)
 *
 * 支持：mysql / postgres / mssql / sqlite(node:sqlite，本地文件)
 * ============================================================ */
'use strict';

/* ----------------------------------------------------------
 * 通用工具
 * -------------------------------------------------------- */
function normVal(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (v instanceof Date) {
    const pad = n => String(n).padStart(2, '0');
    const s = v.getFullYear() + '-' + pad(v.getMonth() + 1) + '-' + pad(v.getDate()) +
      ' ' + pad(v.getHours()) + ':' + pad(v.getMinutes()) + ':' + pad(v.getSeconds());
    return s;
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) return '<BLOB ' + v.length + ' bytes>';
  if (v instanceof Uint8Array) return '<BLOB ' + v.length + ' bytes>';
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch (e) { return String(v); } }
  return String(v);
}

function normRow(row) { return row.map(normVal); }

/** 把 `?` 占位符依次替换为 $1,$2... (PostgreSQL) */
function toDollar(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + (++i));
}
/** 把 `?` 占位符依次替换为 @p0,@p1... (SQL Server) */
function toAt(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '@p' + (i++));
}

/** 判断语句是否会产生结果集 */
function isResultStatement(sql) {
  return /^\s*(WITH|SELECT|SHOW|DESC|DESCRIBE|EXPLAIN|PRAGMA|VALUES|TABLE)\b/i.test(sql);
}

/** 按分号切分多语句（尊重字符串、注释、引号标识符） */
function splitStatements(sql) {
  const out = [];
  let cur = '', i = 0;
  let inS = false, inD = false, inB = false, inLine = false, inBlock = false;
  while (i < sql.length) {
    const c = sql[i], c2 = sql.substr(i, 2);
    if (inLine) { cur += c; if (c === '\n') inLine = false; i++; continue; }
    if (inBlock) { if (c2 === '*/') { cur += c2; i += 2; inBlock = false; continue; } cur += c; i++; continue; }
    if (inS) { cur += c; if (c === "'") { if (sql[i + 1] === "'") { cur += "'"; i += 2; continue; } inS = false; } i++; continue; }
    if (inD) { cur += c; if (c === '"') { if (sql[i + 1] === '"') { cur += '"'; i += 2; continue; } inD = false; } i++; continue; }
    if (inB) { cur += c; if (c === ']') inB = false; i++; continue; }
    if (c2 === '--') { inLine = true; cur += c2; i += 2; continue; }
    if (c === '#') { inLine = true; cur += c; i++; continue; }
    if (c2 === '/*') { inBlock = true; cur += c2; i += 2; continue; }
    if (c === "'") { inS = true; cur += c; i++; continue; }
    if (c === '"') { inD = true; cur += c; i++; continue; }
    if (c === '[') { inB = true; cur += c; i++; continue; }
    if (c === ';') { out.push(cur); cur = ''; i++; continue; }
    cur += c; i++;
  }
  out.push(cur);
  return out
    .map(s => s.trim())
    .filter(s => s && !/^(--|#|\/\*)/.test(s));
}

/** 去掉语句开头的注释，用于判断类型 */
function stripLeadingComments(s) {
  return s.replace(/^(\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/|#[^\n]*\n))+/g, '').trim();
}

/* ==========================================================
 * MySQL / MariaDB
 * ========================================================== */
const mysql = {
  id: 'mysql',
  label: 'MySQL / MariaDB',
  defaultPort: 3306,
  defaultDatabase: '',
  needsHost: true,
  hint: '需要安装依赖：npm install mysql2',

  _mod: null,
  async load() {
    if (this._mod) return this._mod;
    try { this._mod = require('mysql2/promise'); }
    catch (e) { throw new Error('未安装 mysql2 驱动，请在项目目录执行：npm install'); }
    return this._mod;
  },

  async connect(cfg) {
    const mysql2 = await this.load();
    const conn = await mysql2.createConnection({
      host: cfg.host,
      port: cfg.port || 3306,
      user: cfg.user,
      password: cfg.password || '',
      database: cfg.database || undefined,
      multipleStatements: true,
      rowsAsArray: true,
      dateStrings: true,
      connectTimeout: 10000,
      supportBigNumbers: true,
      bigNumberStrings: false
    });
    return { conn, database: cfg.database || null };
  },

  async query(session, sql, params, database) {
    const conn = session.conn;
    // MySQL 用 USE 切换当前库（连接级状态）
    if (database && database !== session.database) {
      await conn.query('USE ' + '`' + String(database).replace(/`/g, '``') + '`');
      session.database = database;
    }
    let rows, fields;
    if (params && params.length) {
      [rows, fields] = await conn.query({ sql, values: params, rowsAsArray: true });
    } else {
      [rows, fields] = await conn.query({ sql, rowsAsArray: true });
    }
    const sets = [];
    let affected = 0;

    const pushSet = (r, f) => {
      if (!Array.isArray(f)) return;
      const columns = f.map(x => x.name);
      if (!columns.length) return;
      sets.push({ columns, values: Array.isArray(r) ? r.map(normRow) : [] });
    };

    const multi = Array.isArray(rows) && Array.isArray(fields) && Array.isArray(fields[0]);
    if (multi) {
      rows.forEach((r, i) => {
        const f = fields[i];
        if (Array.isArray(f)) pushSet(r, f);
        else if (r && typeof r === 'object' && !Array.isArray(r)) affected += (r.affectedRows || 0);
      });
    } else if (Array.isArray(fields) && fields.length && fields[0] && fields[0].name) {
      pushSet(rows, fields);
    } else if (rows && typeof rows === 'object' && !Array.isArray(rows)) {
      affected += (rows.affectedRows || 0);
    } else if (Array.isArray(rows)) {
      affected += 0;
    }
    return { sets, rowsAffected: affected };
  },

  async databases(session) {
    const [rows] = await session.conn.query({
      sql: 'SHOW DATABASES', rowsAsArray: true
    });
    return rows.map(r => r[0]);
  },

  async schema(session, database) {
    const [tabs] = await session.conn.query({
      sql: `SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS
            FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = ?
            ORDER BY TABLE_TYPE, TABLE_NAME`,
      values: [database], rowsAsArray: true
    });
    const tables = [], views = [];
    for (const r of tabs) {
      const isView = /VIEW/i.test(r[1]);
      const item = {
        name: r[0], schema: database, type: isView ? 'view' : 'table',
        rowCount: r[2] === null ? null : Number(r[2]), rowCountApprox: true, lazy: true
      };
      (isView ? views : tables).push(item);
    }
    return { tables, views };
  },

  async columns(session, database, table) {
    const [cols] = await session.conn.query({
      sql: `SELECT c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT, c.COLUMN_KEY, c.EXTRA
            FROM information_schema.COLUMNS c
            WHERE c.TABLE_SCHEMA = ? AND c.TABLE_NAME = ?
            ORDER BY c.ORDINAL_POSITION`,
      values: [database, table], rowsAsArray: true
    });
    return cols.map(c => ({
      name: c[0],
      type: c[1] || '',
      notnull: c[2] === 'NO',
      dflt: c[3] === null || c[3] === undefined ? null : String(c[3]),
      pk: c[4] === 'PRI',
      auto: /auto_increment/i.test(c[5] || '')
    }));
  },

  /**
   * 存储过程 / 函数列表。
   * 只返回元信息（名称、类型、返回类型），定义按需再取 ——
   * 一个库里几百个存储过程很常见，一次性把 CREATE 原文全拉回来既慢又占内存。
   */
  async routines(session, database) {
    const [rows] = await session.conn.query({
      sql: `SELECT ROUTINE_NAME, ROUTINE_TYPE, DTD_IDENTIFIER
            FROM information_schema.ROUTINES
            WHERE ROUTINE_SCHEMA = ?
            ORDER BY ROUTINE_TYPE, ROUTINE_NAME`,
      values: [database], rowsAsArray: true
    });
    const procedures = [], functions = [];
    for (const r of rows) {
      const isProc = /PROCEDURE/i.test(r[1] || '');
      const item = {
        name: r[0], schema: database, kind: isProc ? 'procedure' : 'function',
        type: isProc ? 'procedure' : 'function', ret: r[2] || '', lazy: true
      };
      (isProc ? procedures : functions).push(item);
    }
    return { procedures, functions };
  },

  async routineDdl(session, database, item) {
    const name = item && item.name;
    if (!name) throw new Error('缺少对象名');
    const isProc = (item.kind || item.type) === 'procedure';
    const qi = s => '`' + String(s).replace(/`/g, '``') + '`';
    // 限定库名，避免依赖连接当前的 USE 状态
    const target = database ? qi(database) + '.' + qi(name) : qi(name);
    try {
      const [rows, fields] = await session.conn.query({
        sql: 'SHOW CREATE ' + (isProc ? 'PROCEDURE' : 'FUNCTION') + ' ' + target,
        rowsAsArray: true
      });
      if (rows && rows.length) {
        // 列名是 Create Procedure / Create Function。
        // ⚠️ 这里**不能取最后一列** —— SHOW CREATE PROCEDURE 后面还跟着
        // character_set_client / collation_connection / Database Collation，
        // 取最后一列会拿到「Database Collation」而不是过程正文。
        // （SHOW CREATE TABLE 才是「最后一列即原文」，两者规则不同。）
        let idx = -1;
        if (Array.isArray(fields)) {
          idx = fields.findIndex(f => /^Create\s+(Procedure|Function)$/i.test((f && f.name) || ''));
        }
        if (idx < 0) idx = 2;                    // 兜底：按 MySQL 固定的列顺序
        const txt = rows[0][idx];
        if (txt) return String(txt);
      }
    } catch (e) { /* 无权限时回退 information_schema */ }
    const [r2] = await session.conn.query({
      sql: `SELECT ROUTINE_DEFINITION FROM information_schema.ROUTINES
            WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ? AND ROUTINE_TYPE = ?`,
      values: [database, name, isProc ? 'PROCEDURE' : 'FUNCTION'], rowsAsArray: true
    });
    const def = r2 && r2[0] && r2[0][0];
    return def ? String(def) : '';
  },

  async close(session) { try { await session.conn.end(); } catch (e) { /* ignore */ } }
};

/* ==========================================================
 * PostgreSQL
 * ========================================================== */
const postgres = {
  id: 'postgres',
  label: 'PostgreSQL',
  defaultPort: 5432,
  defaultDatabase: 'postgres',
  needsHost: true,
  hint: '需要安装依赖：npm install pg',

  _mod: null,
  async load() {
    if (this._mod) return this._mod;
    try { this._mod = require('pg'); }
    catch (e) { throw new Error('未安装 pg 驱动，请在项目目录执行：npm install'); }
    return this._mod;
  },

  _client(cfg, database) {
    const { Client } = this._mod;
    return new Client({
      host: cfg.host, port: cfg.port || 5432,
      user: cfg.user, password: cfg.password || '',
      database: database || cfg.database || 'postgres',
      connectionTimeoutMillis: 10000,
      statement_timeout: 120000,
      application_name: 'SQLTool'
    });
  },

  async connect(cfg) {
    await this.load();
    const database = cfg.database || 'postgres';
    const client = this._client(cfg, database);
    await client.connect();
    return { client, cfg, database, extra: new Map() };
  },

  /** 跨库需要独立连接（PG 不支持跨库查询） */
  async _clientFor(session, database) {
    if (!database || database === session.database) return session.client;
    if (session.extra.has(database)) return session.extra.get(database);
    const c = this._client(session.cfg, database);
    try {
      await c.connect();
    } catch (e) {
      try { await c.end(); } catch (x) { /* ignore */ }
      throw new Error('无法连接数据库「' + database + '」：' + (e && e.message ? e.message : e));
    }
    session.extra.set(database, c);
    return c;
  },

  async query(session, sql, params, database) {
    const client = await this._clientFor(session, database);
    const text = (params && params.length) ? toDollar(sql) : sql;
    const res = await client.query(text, params && params.length ? params : undefined);
    const results = Array.isArray(res) ? res : [res];
    const sets = [];
    let affected = 0;
    for (const r of results) {
      if (r && Array.isArray(r.fields) && r.fields.length) {
        const columns = r.fields.map(f => f.name);
        const values = (r.rows || []).map(row => columns.map(c => normVal(row[c])));
        sets.push({ columns, values });
      } else if (r && typeof r.rowCount === 'number') {
        affected += r.rowCount;
      }
    }
    return { sets, rowsAffected: affected };
  },

  async databases(session) {
    const r = await session.client.query(
      'SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname');
    return r.rows.map(x => x.datname);
  },

  async schema(session, database) {
    const client = await this._clientFor(session, database);
    const r = await client.query(`
      SELECT n.nspname AS sch, c.relname AS name,
             CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'table'
                            WHEN 'v' THEN 'view'  WHEN 'm' THEN 'view' ELSE 'other' END AS kind,
             GREATEST(c.reltuples, 0)::bigint AS approx_rows
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r','p','v','m')
        AND n.nspname NOT IN ('pg_catalog','information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
      ORDER BY kind, n.nspname, c.relname`);
    const tables = [], views = [];
    for (const x of r.rows) {
      if (x.kind === 'other') continue;
      const item = {
        name: x.sch === 'public' ? x.name : x.sch + '.' + x.name,
        schema: x.sch, type: x.kind === 'view' ? 'view' : 'table',
        rowCount: Number(x.approx_rows), rowCountApprox: true, lazy: true
      };
      (x.kind === 'view' ? views : tables).push(item);
    }
    return { tables, views };
  },

  async columns(session, database, table) {
    const client = await this._clientFor(session, database);
    let sch = 'public', tbl = table;
    if (table.includes('.')) { const p = table.split('.'); sch = p[0]; tbl = p[1]; }
    const r = await client.query(`
      SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
             COALESCE(pk.is_pk, false) AS is_pk
      FROM information_schema.columns c
      LEFT JOIN (
        SELECT kcu.column_name, true AS is_pk
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2
      ) pk ON pk.column_name = c.column_name
      WHERE c.table_schema = $1 AND c.table_name = $2
      ORDER BY c.ordinal_position`, [sch, tbl]);
    return r.rows.map(c => ({
      name: c.column_name, type: c.data_type,
      notnull: c.is_nullable === 'NO',
      dflt: c.column_default === null ? null : String(c.column_default),
      pk: c.is_pk === true
    }));
  },

  async routines(session, database) {
    const client = await this._clientFor(session, database);
    let rows;
    try {
      // PG 11+ 有 prokind，能区分 procedure / function / aggregate / window
      const r = await client.query(`
        SELECT p.oid::bigint AS oid, n.nspname AS sch, p.proname AS name,
               CASE p.prokind WHEN 'p' THEN 'procedure' WHEN 'a' THEN 'aggregate'
                              WHEN 'w' THEN 'window' ELSE 'function' END AS kind,
               pg_get_function_identity_arguments(p.oid) AS args,
               pg_get_function_result(p.oid) AS ret
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname NOT IN ('pg_catalog','information_schema')
          AND n.nspname NOT LIKE 'pg_toast%'
        ORDER BY kind, n.nspname, p.proname`);
      rows = r.rows;
    } catch (e) {
      // PG 10 及更早：没有 prokind，只有 proisagg / proiswindow
      const r = await client.query(`
        SELECT p.oid::bigint AS oid, n.nspname AS sch, p.proname AS name,
               CASE WHEN p.proisagg THEN 'aggregate'
                    WHEN p.proiswindow THEN 'window' ELSE 'function' END AS kind,
               pg_get_function_identity_arguments(p.oid) AS args,
               pg_get_function_result(p.oid) AS ret
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname NOT IN ('pg_catalog','information_schema')
          AND n.nspname NOT LIKE 'pg_toast%'
        ORDER BY kind, n.nspname, p.proname`);
      rows = r.rows;
    }
    const procedures = [], functions = [];
    for (const x of rows) {
      const isProc = x.kind === 'procedure';
      // 同名重载函数必须带参数签名才区分得开，否则列表里会出现一串看不出差别的同名项
      const sig = '(' + (x.args || '') + ')';
      const item = {
        name: x.name, schema: x.sch, oid: String(x.oid),
        kind: isProc ? 'procedure' : 'function',
        type: isProc ? 'procedure' : 'function',
        args: x.args || '', ret: x.ret || '',
        label: x.name + sig,
        lazy: true
      };
      (isProc ? procedures : functions).push(item);
    }
    return { procedures, functions };
  },

  async routineDdl(session, database, item) {
    const client = await this._clientFor(session, database);
    let oid = item && item.oid;
    if (!oid) {
      const r = await client.query(
        `SELECT p.oid::bigint AS oid FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.proname = $1 AND n.nspname = $2 LIMIT 1`,
        [item && item.name, (item && item.schema) || 'public']);
      oid = r.rows[0] && r.rows[0].oid;
    }
    if (!oid) throw new Error('找不到该对象');
    try {
      const r = await client.query('SELECT pg_get_functiondef($1::oid) AS ddl', [String(oid)]);
      const ddl = r.rows[0] && r.rows[0].ddl;
      if (ddl) return ddl;
    } catch (e) { /* 聚合函数等没有函数体，pg_get_functiondef 会报错 */ }
    // 回退：至少把签名与源码正文给出来
    const r2 = await client.query(
      `SELECT p.prosrc, l.lanname, pg_get_function_identity_arguments(p.oid) AS args,
              pg_get_function_result(p.oid) AS ret
       FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
       WHERE p.oid = $1::oid`, [String(oid)]);
    const x = r2.rows[0];
    if (!x) throw new Error('找不到该对象');
    return '-- ' + (item && item.name) + '(' + (x.args || '') + ') RETURNS ' + (x.ret || '') +
      '  LANGUAGE ' + (x.lanname || '') + '\n-- （pg_get_functiondef 未能返回完整定义，以下为源码正文）\n\n' +
      (x.prosrc || '');
  },

  async close(session) {
    for (const c of session.extra.values()) { try { await c.end(); } catch (e) { /* ignore */ } }
    try { await session.client.end(); } catch (e) { /* ignore */ }
  }
};

/* ==========================================================
 * SQL Server
 * ========================================================== */
const mssql = {
  id: 'mssql',
  label: 'SQL Server',
  defaultPort: 1433,
  defaultDatabase: 'master',
  needsHost: true,
  hint: '需要安装依赖：npm install mssql',

  _mod: null,
  async load() {
    if (this._mod) return this._mod;
    try { this._mod = require('mssql'); }
    catch (e) { throw new Error('未安装 mssql 驱动，请在项目目录执行：npm install'); }
    return this._mod;
  },

  async connect(cfg) {
    const sqlmod = await this.load();
    const database = cfg.database || 'master';
    const pool = await this._newPool(sqlmod, cfg, database);
    return { sqlmod, cfg, database, pools: new Map([[database, pool]]) };
  },

  async _newPool(sqlmod, cfg, database) {
    const pool = new sqlmod.ConnectionPool({
      server: cfg.host,
      port: cfg.port || 1433,
      user: cfg.user,
      password: cfg.password || '',
      database: database,
      options: {
        encrypt: cfg.encrypt !== false,
        trustServerCertificate: true,
        enableArithAbort: true,
        useUTC: false
      },
      connectionTimeout: 15000,
      requestTimeout: 120000,
      pool: { max: 4, min: 0, idleTimeoutMillis: 30000 }
    });
    try {
      await pool.connect();
    } catch (e) {
      try { await pool.close(); } catch (x) { /* ignore */ }
      // 带上库名，否则用户只看到「用户 'xxx' 登录失败」，无法判断是账号问题还是库权限问题
      throw new Error('无法连接数据库「' + database + '」：' + (e && e.message ? e.message : e));
    }
    return pool;
  },

  /** SQL Server 无法跨库共享会话，按目标库维护连接池 */
  async _poolFor(session, database) {
    const db = database || session.database;
    if (session.pools.has(db)) return session.pools.get(db);
    const p = await this._newPool(session.sqlmod, session.cfg, db);
    session.pools.set(db, p);
    return p;
  },

  async query(session, sql, params, database) {
    const pool = await this._poolFor(session, database);
    const req = pool.request();
    let text = sql;
    if (params && params.length) {
      text = toAt(sql);
      params.forEach((v, i) => {
        // 字符串按原样绑定，其余尝试还原为数字
        const val = (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) ? Number(v) : v;
        req.input('p' + i, val);
      });
    }
    const res = await req.query(text);
    const sets = [];
    let affected = 0;
    const recordsets = res.recordsets && res.recordsets.length ? res.recordsets : (res.recordset ? [res.recordset] : []);
    if (recordsets.length) {
      for (const rs of recordsets) {
        if (!rs.length) continue;
        const columns = Object.keys(rs[0]);
        sets.push({ columns, values: rs.map(row => columns.map(c => normVal(row[c]))) });
      }
    }
    if (Array.isArray(res.rowsAffected)) affected = res.rowsAffected.reduce((a, b) => a + b, 0);
    else if (typeof res.rowsAffected === 'number') affected = res.rowsAffected;
    return { sets, rowsAffected: affected };
  },

  async databases(session) {
    const pool = await this._poolFor(session, null);
    const res = await pool.request()
      .query('SELECT name FROM sys.databases WHERE state = 0 ORDER BY name');
    return res.recordset.map(r => r.name);
  },

  async schema(session, database) {
    const pool = await this._poolFor(session, database);
    const db = '[' + String(database).replace(/]/g, ']]') + ']';
    const res = await pool.request().query(`
      SELECT s.name AS sch, t.name AS name, 'table' AS kind,
             (SELECT SUM(p.rows) FROM ${db}.sys.partitions p
               WHERE p.object_id = t.object_id AND p.index_id IN (0,1)) AS approx_rows
      FROM ${db}.sys.tables t JOIN ${db}.sys.schemas s ON s.schema_id = t.schema_id
      UNION ALL
      SELECT s.name AS sch, v.name AS name, 'view' AS kind, NULL AS approx_rows
      FROM ${db}.sys.views v JOIN ${db}.sys.schemas s ON s.schema_id = v.schema_id
      ORDER BY kind, sch, name`);
    const tables = [], views = [];
    for (const r of res.recordset) {
      const item = {
        name: r.sch === 'dbo' ? r.name : r.sch + '.' + r.name,
        schema: r.sch, type: r.kind === 'view' ? 'view' : 'table',
        rowCount: r.approx_rows === null ? null : Number(r.approx_rows),
        rowCountApprox: true, lazy: true
      };
      (r.kind === 'view' ? views : tables).push(item);
    }
    return { tables, views };
  },

  async columns(session, database, table) {
    const pool = await this._poolFor(session, database);
    const db = '[' + String(database).replace(/]/g, ']]') + ']';
    let sch = 'dbo', tbl = table;
    if (table.includes('.')) { const p = table.split('.'); sch = p[0]; tbl = p[1]; }
    const req = pool.request();
    req.input('sch', sch);
    req.input('tbl', tbl);
    const res = await req.query(`
      SELECT c.name, ty.name AS type_name, c.max_length, c.precision, c.scale,
             c.is_nullable, c.is_identity, dc.definition AS dflt,
             CASE WHEN pk.column_id IS NULL THEN 0 ELSE 1 END AS is_pk
      FROM ${db}.sys.columns c
      JOIN ${db}.sys.types ty ON ty.user_type_id = c.user_type_id
      JOIN ${db}.sys.tables t ON t.object_id = c.object_id
      JOIN ${db}.sys.schemas s ON s.schema_id = t.schema_id
      LEFT JOIN ${db}.sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
      LEFT JOIN (
        SELECT ic.object_id, ic.column_id
        FROM ${db}.sys.index_columns ic
        JOIN ${db}.sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
        WHERE i.is_primary_key = 1
      ) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
      WHERE s.name = @sch AND t.name = @tbl
      ORDER BY c.column_id`);
    const fmt = r => {
      let t = r.type_name;
      const n = r.max_length;
      if (/^(varchar|char|varbinary|binary)$/i.test(t)) t += '(' + (n === -1 ? 'max' : n) + ')';
      else if (/^(nvarchar|nchar)$/i.test(t)) t += '(' + (n === -1 ? 'max' : n / 2) + ')';
      else if (/^(decimal|numeric)$/i.test(t)) t += '(' + r.precision + ',' + r.scale + ')';
      return t;
    };
    return res.recordset.map(r => ({
      name: r.name, type: fmt(r),
      notnull: r.is_nullable === false,
      dflt: r.dflt === null ? null : String(r.dflt),
      pk: r.is_pk === 1,
      auto: r.is_identity === true
    }));
  },

  async routines(session, database) {
    const pool = await this._poolFor(session, database);
    const db = '[' + String(database).replace(/]/g, ']]') + ']';
    // P/PC = 存储过程；FN/IF/TF/FS/FT = 各类函数；AF = 聚合函数
    const res = await pool.request().query(`
      SELECT s.name AS sch, o.name AS name, o.type AS t, o.type_desc AS type_desc,
             CONVERT(varchar(19), o.modify_date, 120) AS modified
      FROM ${db}.sys.objects o
      JOIN ${db}.sys.schemas s ON s.schema_id = o.schema_id
      WHERE o.type IN ('P','PC','FN','IF','TF','FS','FT','AF')
      ORDER BY o.type, s.name, o.name`);
    const procedures = [], functions = [];
    for (const r of res.recordset) {
      const isProc = r.t === 'P' || r.t === 'PC';
      const item = {
        name: r.sch === 'dbo' ? r.name : r.sch + '.' + r.name,
        schema: r.sch, kind: isProc ? 'procedure' : 'function',
        type: isProc ? 'procedure' : 'function',
        typeDesc: r.type_desc || '', modified: r.modified || '', lazy: true
      };
      (isProc ? procedures : functions).push(item);
    }
    return { procedures, functions };
  },

  async routineDdl(session, database, item) {
    const pool = await this._poolFor(session, database);
    const db = '[' + String(database).replace(/]/g, ']]') + ']';
    let sch = (item && item.schema) || 'dbo';
    let name = (item && item.name) || '';
    // name 可能已带 schema 前缀（dbo.xxx）
    if (name.includes('.')) { const p = name.split('.'); sch = p[0]; name = p[1]; }
    if (!name) throw new Error('缺少对象名');
    const req = pool.request();
    req.input('sch', sch);
    req.input('name', name);
    const res = await req.query(`
      SELECT m.definition AS ddl
      FROM ${db}.sys.sql_modules m
      JOIN ${db}.sys.objects o ON o.object_id = m.object_id
      JOIN ${db}.sys.schemas s ON s.schema_id = o.schema_id
      WHERE s.name = @sch AND o.name = @name`);
    const ddl = res.recordset[0] && res.recordset[0].ddl;
    return ddl || '';
  },

  async close(session) {
    for (const p of session.pools.values()) { try { await p.close(); } catch (e) { /* ignore */ } }
  }
};

/* ==========================================================
 * SQLite（服务端本地文件，node:sqlite 内置模块）
 * ========================================================== */
const sqlite = {
  id: 'sqlite',
  label: 'SQLite（服务器本地文件）',
  defaultPort: 0,
  defaultDatabase: '',
  needsHost: false,
  hint: 'Node.js 内置模块，无需安装依赖',

  _mod: null,
  async load() {
    if (this._mod) return this._mod;
    try { this._mod = require('node:sqlite'); }
    catch (e) { throw new Error('当前 Node.js 版本不支持 node:sqlite（需要 Node 22.5+）'); }
    return this._mod;
  },

  async connect(cfg) {
    const { DatabaseSync } = await this.load();
    const file = cfg.file || cfg.database || ':memory:';
    const db = new DatabaseSync(file);
    try { db.exec('PRAGMA foreign_keys = ON;'); } catch (e) { /* ignore */ }
    return { db, file, database: file };
  },

  async query(session, sql, params) {
    const db = session.db;
    const stmts = splitStatements(sql);
    const sets = [];
    let affected = 0;

    // 单语句且带参数：直接走参数绑定
    if (stmts.length === 1 && params && params.length) {
      const st = db.prepare(stmts[0]);
      if (isResultStatement(stripLeadingComments(stmts[0]))) {
        const rows = st.all(...params);
        if (rows.length) {
          const columns = Object.keys(rows[0]);
          sets.push({ columns, values: rows.map(r => columns.map(c => normVal(r[c]))) });
        } else {
          sets.push({ columns: st.columns ? st.columns().map(c => c.name) : [], values: [] });
        }
      } else {
        const r = st.run(...params);
        affected += Number(r.changes || 0);
      }
      return { sets, rowsAffected: affected };
    }

    for (const raw of stmts) {
      const s = stripLeadingComments(raw);
      if (!s) continue;
      if (isResultStatement(s)) {
        const st = db.prepare(s);
        const rows = st.all();
        if (rows.length) {
          const columns = Object.keys(rows[0]);
          sets.push({ columns, values: rows.map(r => columns.map(c => normVal(r[c]))) });
        } else {
          let cols = [];
          try { cols = st.columns().map(c => c.name); } catch (e) { /* ignore */ }
          sets.push({ columns: cols, values: [] });
        }
      } else {
        const r = db.prepare(s).run();
        affected += Number(r.changes || 0);
      }
    }
    return { sets, rowsAffected: affected };
  },

  async databases() { return []; },

  async schema(session) {
    const db = session.db;
    const master = db.prepare(
      "SELECT type, name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name"
    ).all();
    const tables = [], views = [];
    for (const r of master) {
      const isView = r.type === 'view';
      let count = null;
      try { count = Number(db.prepare('SELECT COUNT(*) AS c FROM "' + r.name.replace(/"/g, '""') + '"').get().c); }
      catch (e) { /* ignore */ }
      const item = { name: r.name, schema: 'main', type: isView ? 'view' : 'table', rowCount: count, rowCountApprox: false, lazy: true };
      (isView ? views : tables).push(item);
    }
    return { tables, views };
  },

  async columns(session, database, table) {
    const db = session.db;
    const info = db.prepare('PRAGMA table_info("' + table.replace(/"/g, '""') + '")').all();
    return info.map(c => ({
      name: c.name, type: c.type || 'BLOB',
      notnull: c.notnull === 1, dflt: c.dflt_value === null ? null : String(c.dflt_value),
      pk: c.pk > 0
    }));
  },

  // SQLite 没有存储过程 / 函数这类服务端对象，返回空数组而不是报错
  async routines() { return { procedures: [], functions: [] }; },

  async routineDdl() { throw new Error('SQLite 不支持存储过程与函数'); },

  async close(session) { try { session.db.close(); } catch (e) { /* ignore */ } }
};

/* ==========================================================
 * 注册表
 * ========================================================== */
const DRIVERS = { mysql, postgres, mssql, sqlite };

const REMOTE_DRIVERS = ['mysql', 'postgres', 'mssql'];   // 需要网络连接
const ALL_IDS = Object.keys(DRIVERS);

/** 探测每个驱动的可用性（不建立连接） */
function driverStatus() {
  return ALL_IDS.map(id => {
    const d = DRIVERS[id];
    let available = true, reason = '';
    try {
      // eslint-disable-next-line global-require
      if (id === 'mysql') require.resolve('mysql2/promise');
      else if (id === 'postgres') require.resolve('pg');
      else if (id === 'mssql') require.resolve('mssql');
      else if (id === 'sqlite') require.resolve('node:sqlite');
    } catch (e) {
      available = false;
      reason = d.hint;
    }
    return {
      id, label: d.label, defaultPort: d.defaultPort,
      defaultDatabase: d.defaultDatabase, needsHost: d.needsHost,
      remote: REMOTE_DRIVERS.includes(id),
      available, reason
    };
  });
}

module.exports = {
  DRIVERS, REMOTE_DRIVERS, ALL_IDS,
  driverStatus,
  normVal, splitStatements, isResultStatement, stripLeadingComments
};
