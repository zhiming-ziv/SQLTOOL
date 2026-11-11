/* ============================================================
 * engine.js — 数据库引擎适配层
 * 真实引擎运行在浏览器内（WebAssembly）：
 *   - SQLite  : sql.js（本地内置，离线可用）
 *   - DuckDB  : duckdb-wasm（按需从 CDN 加载，分析型）
 * 统一接口：open / close / exec / run / schema / exportBinary
 * ============================================================ */
(function (global) {
  'use strict';
  const I = window.SqlToolI18n;

  const VENDOR = new URL('../vendor/', document.currentScript.src).href;

  /* ----------------------------------------------------------
   * IndexedDB —— 数据库文件持久化
   * -------------------------------------------------------- */
  const Store = (function () {
    const DB_NAME = 'sqltool';
    const VERSION = 1;
    const FILES = 'files';
    const META = 'meta';
    let _dbp = null;

    function open() {
      if (_dbp) return _dbp;
      _dbp = new Promise((res, rej) => {
        let req;
        try { req = indexedDB.open(DB_NAME, VERSION); }
        catch (e) { rej(e); return; }
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains(FILES)) d.createObjectStore(FILES);
          if (!d.objectStoreNames.contains(META)) d.createObjectStore(META);
        };
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error || I.error(I.t("engine.cannot_open_indexeddb_0d94d5")));
        req.onblocked = () => rej(I.error(I.t("engine.indexeddb_is_blocked_by_another_tab_186c1e")));
      });
      return _dbp;
    }

    /**
     * 关键：事务与请求必须在同一个任务内创建。
     * 中间若插入 await，IndexedDB 事务会自动提交并失活，导致 TransactionInactiveError。
     */
    function tx(name, mode, fn) {
      return open().then(d => new Promise((res, rej) => {
        let t;
        try { t = d.transaction(name, mode); } catch (e) { rej(e); return; }
        let req;
        try { req = fn(t.objectStore(name)); } catch (e) { rej(e); return; }
        t.oncomplete = () => res(req ? req.result : undefined);
        t.onerror = () => rej(t.error || I.error(I.t("engine.indexeddb_transaction_failed_4668f7")));
        t.onabort = () => rej(t.error || I.error(I.t("engine.indexeddb_transaction_aborted_8556d5")));
      }));
    }

    return {
      putFile: (k, v) => tx(FILES, 'readwrite', s => s.put(v, k)),
      getFile: (k) => tx(FILES, 'readonly', s => s.get(k)),
      delFile: (k) => tx(FILES, 'readwrite', s => s.delete(k)),
      fileKeys: () => tx(FILES, 'readonly', s => s.getAllKeys()),
      putMeta: (k, v) => tx(META, 'readwrite', s => s.put(v, k)),
      getMeta: (k) => tx(META, 'readonly', s => s.get(k)),
      delMeta: (k) => tx(META, 'readwrite', s => s.delete(k)),
      metaKeys: () => tx(META, 'readonly', s => s.getAllKeys())
    };
  })();

  /* ----------------------------------------------------------
   * 工具函数
   * -------------------------------------------------------- */
  function loadScript(src) {
    return new Promise((res, rej) => {
      if (document.querySelector('script[data-src="' + src + '"]')) return res();
      const s = document.createElement('script');
      s.src = src;
      s.dataset.src = src;
      s.onload = res;
      s.onerror = () => rej(I.error(I.t("engine.script_failed_to_load_d8ffcb", { p0: src })));
      document.head.appendChild(s);
    });
  }

  function quoteIdent(name) {
    return '"' + String(name).replace(/"/g, '""') + '"';
  }

  function decodeUtf8(bytes) {
    return new TextDecoder('utf-8').decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  }

  /* ==========================================================
   * SQLite 引擎（sql.js）
   * ========================================================== */
  class SqliteEngine {
    constructor() {
      this.kind = 'sqlite';
      this.label = 'SQLite';
      this.db = null;
      this._dirty = false;
    }

    static async ensureLib() {
      if (global.initSqlJs) return;
      await loadScript(VENDOR + 'sql-wasm.js');
      if (!global.initSqlJs) throw I.error(I.t("engine.sql_js_initialization_failed_d0170e"));
    }

    async open(opts) {
      opts = opts || {};
      await SqliteEngine.ensureLib();
      if (!SqliteEngine._SQL) {
        SqliteEngine._SQL = await global.initSqlJs({ locateFile: f => VENDOR + f });
      }
      const SQL = SqliteEngine._SQL;
      this.db = opts.data ? new SQL.Database(opts.data) : new SQL.Database();
      // 外键约束默认关闭，与 SQLite 默认行为一致；显式开启更接近真实体验
      try { this.db.run('PRAGMA foreign_keys = ON;'); } catch (e) { /* ignore */ }
      return this;
    }

    /** 执行任意 SQL（可多语句），返回所有结果集 */
    exec(sql) {
      const t0 = performance.now();
      const sets = this.db.exec(sql);
      const affected = this.db.getRowsModified();
      this._dirty = true;
      return {
        sets: sets.map(s => ({ columns: s.columns, values: s.values })),
        rowsAffected: affected,
        ms: Math.round(performance.now() - t0)
      };
    }

    /** 带参数执行单条语句（用于安全的 UPDATE/INSERT） */
    run(sql, params) {
      const st = this.db.prepare(sql);
      try {
        st.bind(params || []);
        st.step();
      } finally {
        st.free();
      }
      this._dirty = true;
      return { rowsAffected: this.db.getRowsModified() };
    }

    /** 读取完整 schema：表 / 视图 / 索引 / 触发器 + 列信息 */
    schema() {
      const tables = [], views = [], indexes = [], triggers = [];
      const result = { tables, views, indexes, triggers };
      const master = this.db.exec(
        "SELECT type, name, tbl_name, sql FROM sqlite_master " +
        "WHERE type IN ('table','view','index','trigger') " +
        "AND name NOT LIKE 'sqlite_%' ORDER BY name"
      );
      if (!master.length) return result;   // 空库：返回空结构，而非数组
      const rows = master[0].values;

      for (const [type, name, tblName, ddl] of rows) {
        if (type === 'table') {
          const cols = [];
          try {
            const ci = this.db.exec('PRAGMA table_info(' + quoteIdent(name) + ')');
            if (ci.length) {
              for (const c of ci[0].values) {
                cols.push({
                  name: c[1], type: c[2] || 'BLOB', notnull: !!c[3],
                  dflt: c[4] === null ? null : String(c[4]), pk: c[5] > 0, pkOrder: c[5]
                });
              }
            }
          } catch (e) { /* ignore */ }
          let count = 0;
          try {
            const cr = this.db.exec('SELECT COUNT(*) FROM ' + quoteIdent(name));
            if (cr.length) count = cr[0].values[0][0];
          } catch (e) { /* ignore */ }
          let rowid = true;
          try { this.db.exec('SELECT rowid FROM ' + quoteIdent(name) + ' LIMIT 1'); }
          catch (e) { rowid = false; }
          tables.push({ type: 'table', name, columns: cols, ddl: ddl || '', rowCount: count, hasRowid: rowid });
        } else if (type === 'view') {
          views.push({ type: 'view', name, ddl: ddl || '' });
        } else if (type === 'index') {
          indexes.push({ type: 'index', name, table: tblName, ddl: ddl || '' });
        } else if (type === 'trigger') {
          triggers.push({ type: 'trigger', name, table: tblName, ddl: ddl || '' });
        }
      }
      return { tables, views, indexes, triggers, procedures: [], functions: [] };
    }

    /** 列出已挂载的数据库（main / ATTACH 的库） */
    attached() {
      try {
        const r = this.db.exec('PRAGMA database_list');
        return r.length ? r[0].values.map(v => ({ seq: v[0], name: v[1], file: v[2] })) : [];
      } catch (e) { return []; }
    }

    exportBinary() { return this.db.export(); }

    close() {
      try { this.db && this.db.close(); } catch (e) { /* ignore */ }
      this.db = null;
    }
  }

  /* ==========================================================
   * DuckDB 引擎（duckdb-wasm，CDN 按需加载）
   * ========================================================== */
  class DuckDbEngine {
    constructor() {
      this.kind = 'duckdb';
      this.label = 'DuckDB';
      this.db = null;
      this.conn = null;
      this._dirty = false;
    }

    static async ensureLib() {
      if (DuckDbEngine._mod) return DuckDbEngine._mod;
      // 依次尝试多个 CDN，任一成功即可
      const sources = [
        'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm',
        'https://esm.sh/@duckdb/duckdb-wasm@1.29.0'
      ];
      let lastErr;
      for (const src of sources) {
        try {
          DuckDbEngine._mod = await import(/* webpackIgnore: true */ src);
          if (DuckDbEngine._mod && DuckDbEngine._mod.AsyncDuckDB) return DuckDbEngine._mod;
        } catch (e) { lastErr = e; }
      }
      throw I.error(I.t("engine.duckdb_engine_failed_to_load_internet_19f878", { p0: lastErr ? I.detail(lastErr) : I.t("engine.unknown_error_13a466") }));
    }

    async open() {
      const duckdb = await DuckDbEngine.ensureLib();
      const bundles = duckdb.getJsDelivrBundles();
      const bundle = await duckdb.selectBundle(bundles);
      const workerSrc = 'importScripts("' + bundle.mainWorker + '");';
      const workerUrl = URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }));
      const worker = new Worker(workerUrl);
      this.db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger('WARNING'), worker);
      await this.db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      URL.revokeObjectURL(workerUrl);
      this.conn = await this.db.connect();
      return this;
    }

    _toSet(table) {
      const columns = table.schema.fields.map(f => f.name);
      const values = [];
      for (const row of table.toArray()) {
        const o = row.toJSON();
        values.push(columns.map(c => {
          const v = o[c];
          if (v === null || v === undefined) return null;
          if (typeof v === 'bigint') return Number(v);
          if (v instanceof Date) return v.toISOString().slice(0, 19).replace('T', ' ');
          if (typeof v === 'object') return JSON.stringify(v);
          return v;
        }));
      }
      return { columns, values };
    }

    async exec(sql) {
      const t0 = performance.now();
      const table = await this.conn.query(sql);
      const set = this._toSet(table);
      this._dirty = true;
      return { sets: set.columns.length ? [set] : [], rowsAffected: table.numRows, ms: Math.round(performance.now() - t0) };
    }

    async run(sql) {
      const t0 = performance.now();
      const table = await this.conn.query(sql);
      this._dirty = true;
      return { rowsAffected: table.numRows, ms: Math.round(performance.now() - t0) };
    }

    async schema() {
      const tables = [], views = [];
      const t = await this.conn.query(
        "SELECT table_name, table_type FROM information_schema.tables " +
        "WHERE table_schema = 'main' ORDER BY table_name"
      );
      for (const row of t.toArray()) {
        const o = row.toJSON();
        const name = o.table_name;
        const isView = /VIEW/i.test(o.table_type || '');
        let columns = [];
        try {
          const c = await this.conn.query(
            "SELECT column_name, data_type, is_nullable, column_default " +
            "FROM information_schema.columns WHERE table_name = '" + name.replace(/'/g, "''") + "' " +
            "ORDER BY ordinal_position"
          );
          columns = c.toArray().map(r => {
            const x = r.toJSON();
            return { name: x.column_name, type: x.data_type, notnull: x.is_nullable === 'NO', dflt: x.column_default, pk: false };
          });
        } catch (e) { /* ignore */ }
        let count = 0;
        try {
          const cr = await this.conn.query('SELECT COUNT(*) AS c FROM ' + quoteIdent(name));
          count = Number(cr.toArray()[0].toJSON().c);
        } catch (e) { /* ignore */ }
        (isView ? views : tables).push({
          type: isView ? 'view' : 'table', name, columns,
          ddl: '', rowCount: count, hasRowid: false
        });
      }
      return { tables, views, indexes: [], triggers: [], procedures: [], functions: [] };
    }

    attached() { return [{ seq: 0, name: 'main', file: '(memory)' }]; }

    async exportBinary() {
      const buf = await this.db.copyFileToBuffer('main');
      return new Uint8Array(buf);
    }

    close() {
      try { this.conn && this.conn.close(); } catch (e) { /* ignore */ }
      try { this.db && this.db.terminate(); } catch (e) { /* ignore */ }
      this.db = null; this.conn = null;
    }
  }

  /* ==========================================================
   * 远程引擎（MySQL / PostgreSQL / SQL Server / 服务端 SQLite）
   * 通过本地后端 HTTP API 代理 —— 浏览器无法直接开 TCP 连数据库
   * ========================================================== */
  async function apiCall(pathname, body, method) {
    let res;
    try {
      res = await fetch(pathname, {
        method: method || (body ? 'POST' : 'GET'),
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (e) {
      throw I.error(I.t("engine.cannot_connect_to_the_local_backend_bd72a5"));
    }
    let json;
    try { json = await res.json(); }
    catch (e) { throw I.error(I.t("engine.backend_returned_a_non_json_response_37a501", { p0: res.status })); }
    if (!json.ok) throw I.error(I.fromError(json) || I.t("engine.request_failed_http_f21a09", { p0: res.status }));
    return json.data;
  }

  class RemoteEngine {
    constructor() {
      this.kind = 'remote';
      this.dialect = null;
      this.label = I.t("engine.remote_database_a3fe50");
      this.meta = null;
    }

    async open(cfg) {
      const data = await apiCall('/api/connect', {
        driver: cfg.driver,
        savedId: cfg.savedId,
        host: cfg.host, port: cfg.port,
        user: cfg.user, password: cfg.password,
        database: cfg.database, file: cfg.file,
        name: cfg.name
      });
      this.meta = data;
      this.dialect = data.dialect;
      this.label = data.dialect === 'sqlite' ? I.t('driver.sqliteLabel') : data.label;
      return this;
    }

    get connId() { return this.meta.connId; }
    get currentDatabase() { return this.meta.currentDatabase; }
    get databases() { return this.meta.databases || []; }
    get serverVersion() { return this.meta.serverVersion; }
    get multiDatabase() { return !!this.meta.multiDatabase; }
    setDatabase(db) { this.meta.currentDatabase = db; }

    async exec(sql, database) {
      const r = await apiCall('/api/query', {
        connId: this.connId, sql, database: database || null
      });
      return { sets: r.sets || [], rowsAffected: r.rowsAffected || 0, ms: r.ms };
    }

    async run(sql, params, database) {
      const r = await apiCall('/api/query', {
        connId: this.connId, sql, params: params || [], database: database || null
      });
      return { rowsAffected: r.rowsAffected || 0, ms: r.ms };
    }

    async schema(database) {
      const db = database || this.currentDatabase;
      const r = await apiCall('/api/schema', { connId: this.connId, database: db });
      return {
        databases: this.databases,
        database: r.database,
        tables: r.tables || [], views: r.views || [],
        procedures: r.procedures || [], functions: r.functions || [],
        indexes: [], triggers: []
      };
    }

    /** 按需读取单个存储过程 / 函数的 CREATE 原文 */
    async routineDdl(item, database) {
      const r = await apiCall('/api/routine-ddl', {
        connId: this.connId,
        database: database || this.currentDatabase,
        name: item && item.name, schema: item && item.schema,
        kind: item && (item.kind || item.type), oid: item && item.oid
      });
      return r.ddl || '';
    }

    async columns(database, table) {
      const r = await apiCall('/api/columns', {
        connId: this.connId, database: database || null, table
      });
      return r.columns || [];
    }

    async attached() { return []; }

    async exportBinary() {
      throw I.error(I.t("engine.remote_databases_cannot_be_exported_as_34c841"));
    }

    async close() {
      try { await apiCall('/api/disconnect', { connId: this.connId }); } catch (e) { /* ignore */ }
      this.meta = null;
    }
  }

  /** 按方言引用标识符 */
  function quoteIdentFor(name, dialect) {
    const s = String(name);
    if (dialect === 'mysql') return '`' + s.replace(/`/g, '``') + '`';
    if (dialect === 'mssql') return '[' + s.replace(/]/g, ']]') + ']';
    return '"' + s.replace(/"/g, '""') + '"';
  }

  /* ==========================================================
   * 对外接口
   * ========================================================== */
  global.SqlTool = {
    Store,
    VENDOR,
    quoteIdent,
    quoteIdentFor,
    decodeUtf8,
    api: apiCall,
    engines: { sqlite: SqliteEngine, duckdb: DuckDbEngine, remote: RemoteEngine },
    create(kind) {
      const C = global.SqlTool.engines[kind];
      if (!C) throw I.error(I.t("engine.unknown_engine_6b2c82", { p0: kind }));
      return new C();
    }
  };
})(window);
