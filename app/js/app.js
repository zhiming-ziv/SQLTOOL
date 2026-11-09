/* ============================================================
 * app.js — SQLTool 数据库工作台 主逻辑
 * 前端：SSMS 风格外壳 + 真实 SQL 执行
 * ============================================================ */
(function () {
  'use strict';

  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const S = window.SqlTool;

  /* ==========================================================
   * 0. 全局状态
   * ========================================================== */
  const state = {
    conns: [],            // 连接列表
    activeConnId: null,
    docs: [],
    activeDocId: null,
    docSeq: 0,
    connSeq: 0,
    drivers: []           // 后端可用驱动
  };
  const conn = () => state.conns.find(c => c.id === state.activeConnId) || null;
  const doc = () => state.docs.find(d => d.id === state.activeDocId) || null;
  const eng = () => { const c = conn(); return c && c.engine ? c.engine : null; };

  /* ==========================================================
   * 1. 图标
   * ========================================================== */
  const IC = {
    server: '<ellipse cx="8" cy="4" rx="5.4" ry="2.1" fill="none" stroke="#D2A24C" stroke-width="1.3"/><path d="M2.6 4v8c0 1.2 2.4 2.1 5.4 2.1s5.4-.9 5.4-2.1V4" fill="none" stroke="#D2A24C" stroke-width="1.3"/><path d="M2.6 8c0 1.2 2.4 2.1 5.4 2.1s5.4-.9 5.4-2.1" fill="none" stroke="#D2A24C" stroke-width="1.1"/>',
    db: '<ellipse cx="8" cy="4" rx="5.4" ry="2.1" fill="#3E7CB1"/><path d="M2.6 4v8c0 1.2 2.4 2.1 5.4 2.1s5.4-.9 5.4-2.1V4" fill="#3E7CB1"/><ellipse cx="8" cy="4" rx="5.4" ry="2.1" fill="#5B9BD5"/><path d="M2.6 7.2c0 1.2 2.4 2.1 5.4 2.1s5.4-.9 5.4-2.1" fill="none" stroke="#2A5A82" stroke-width=".8"/><ellipse cx="8" cy="3.2" rx="2.6" ry="1" fill="#A8CBE8"/>',
    folder: '<path d="M1.6 3.4h4.2l1.4 1.7h7.2v7.5H1.6z" fill="#E0B24A" stroke="#B98D2E" stroke-width=".9"/>',
    table: '<rect x="2" y="2.6" width="12" height="10.8" rx="1" fill="#8FBEE0" stroke="#4A86B8" stroke-width="1"/><path d="M2 6h12M6 6v7.4M10 6v7.4M2 9.6h12" stroke="#4A86B8" stroke-width=".9"/>',
    view: '<rect x="2" y="3" width="12" height="10" rx="1" fill="#B7D7EE" stroke="#5B9BD5" stroke-width="1"/><path d="M4.5 6h7M4.5 8.4h7M4.5 10.8h4.5" stroke="#5B9BD5" stroke-width=".9"/>',
    index: '<rect x="2.6" y="2.6" width="10.8" height="10.8" rx="1" fill="#F0DCA8" stroke="#B98D2E" stroke-width="1"/><path d="M5.4 6h5.2M5.4 8h5.2M5.4 10h3" stroke="#B98D2E" stroke-width=".9"/>',
    trigger: '<path d="M8 1.8 3 4v4.2c0 3 2.1 5.4 5 6 2.9-.6 5-3 5-6V4z" fill="#E8C4C4" stroke="#B85C5C" stroke-width="1"/><path d="M6 8.2 7.6 10 10.2 6.4" fill="none" stroke="#8E3B3B" stroke-width="1.2" stroke-linecap="round"/>',
    proc: '<rect x="2.4" y="2.4" width="11.2" height="11.2" rx="2" fill="#D9C7EE" stroke="#7B5CB8" stroke-width="1"/><path d="M5.4 5.8h5.2M5.4 8h5.2M5.4 10.2h3" stroke="#5B3F96" stroke-width=".9"/>',
    func: '<path d="M3.2 13.2c1.5 0 2.4-.8 2.8-2.4l1.7-6.6C8.1 2.6 8.9 1.8 10.4 1.8" fill="none" stroke="#2F8F8F" stroke-width="1.3" stroke-linecap="round"/><path d="M4.6 5.6h5.2" stroke="#2F8F8F" stroke-width="1.3" stroke-linecap="round"/>',
    col: '<circle cx="8" cy="8" r="3" fill="#9AA0A6" stroke="#6E747A" stroke-width="1"/>',
    colpk: '<circle cx="8" cy="8" r="3.4" fill="#F0C86A" stroke="#B98D2E" stroke-width="1"/><path d="M6.6 8h2.8M8 6.6v2.8" stroke="#8A6A1E" stroke-width=".9"/>',
    query: '<path d="M3 1.6h7l3 3v9.8H3z" fill="#EAF2FB" stroke="#5B9BD5" stroke-width="1"/><path d="M10 1.6v3h3" fill="none" stroke="#5B9BD5" stroke-width="1"/><path d="M5.4 8h5.2M5.4 10.4h5.2" stroke="#5B9BD5" stroke-width=".9"/>'
  };
  function ico(name, size) {
    size = size || 15;
    return '<svg class="ico" viewBox="0 0 16 16" width="' + size + '" height="' + size + '">' + (IC[name] || IC.folder) + '</svg>';
  }

  /* ==========================================================
   * 2. Toast / Overlay / Modal
   * ========================================================== */
  let toastTimer = null;
  function toast(msg, isErr) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('err', !!isErr);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), isErr ? 4200 : 2400);
  }
  function busy(show, title, sub) {
    const o = $('#overlay');
    if (show) {
      $('#ovT').textContent = title || '处理中…';
      $('#ovS').textContent = sub || '';
      o.classList.add('show');
    } else o.classList.remove('show');
  }
  function status(msg) { $('#sbStatus').textContent = msg; }

  const modalStack = [];
  function openModal(title, bodyHtml, footHtml, onOk, wide) {
    const m = document.createElement('div');
    m.className = 'mask show';
    m.innerHTML =
      '<div class="modal' + (wide ? ' wide' : '') + '">' +
        '<div class="m-head">' + title + '<span class="m-x">✕</span></div>' +
        '<div class="m-body">' + bodyHtml + '</div>' +
        '<div class="m-foot">' + (footHtml || '<button class="btn primary" data-ok>确定</button><button class="btn" data-cancel>取消</button>') + '</div>' +
      '</div>';
    document.body.appendChild(m);
    modalStack.push(m);
    const close = () => { m.remove(); const i = modalStack.indexOf(m); if (i >= 0) modalStack.splice(i, 1); };
    m.addEventListener('click', e => {
      if (e.target === m || e.target.classList.contains('m-x') || e.target.hasAttribute('data-cancel')) close();
      if (e.target.hasAttribute('data-ok')) {
        // onOk 允许是异步的：返回 true 表示「保留对话框」（例如校验失败或提交出错）
        Promise.resolve(onOk ? onOk(m) : false).then(keep => { if (keep !== true) close(); });
      }
    });
    m._close = close;
    return m;
  }
  function closeTopModal() { const m = modalStack[modalStack.length - 1]; if (m) m._close(); return !!m; }

  /* ==========================================================
   * 3. SQL 语法高亮
   * ========================================================== */
  const KW = new Set(('SELECT FROM WHERE AND OR NOT NULL INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE ALTER DROP INDEX VIEW TRIGGER ' +
    'JOIN LEFT RIGHT INNER OUTER FULL CROSS ON AS GROUP BY ORDER HAVING DISTINCT TOP LIMIT OFFSET UNION ALL EXISTS IN BETWEEN LIKE IS ' +
    'CASE WHEN THEN ELSE END BEGIN COMMIT ROLLBACK TRANSACTION USE GO PRIMARY KEY FOREIGN REFERENCES DEFAULT AUTOINCREMENT ' +
    'INT INTEGER BIGINT SMALLINT TINYINT DECIMAL NUMERIC FLOAT REAL DOUBLE CHAR VARCHAR NVARCHAR NCHAR TEXT BLOB DATE DATETIME TIME TIMESTAMP BIT BOOLEAN ' +
    'ASC DESC WITH OVER PARTITION ATTACH DETACH DATABASE PRAGMA VACUUM ANALYZE EXPLAIN QUERY PLAN REINDEX ' +
    'IF TEMPORARY TEMP UNIQUE CHECK CONSTRAINT WITHOUT ROWID CAST COLLATE RETURNING CONFLICT REPLACE IGNORE ABORT FAIL').split(/\s+/));
  // 注意：整串必须先用括号包起来再 split。
  // 写成 `new Set('a' + 'b'.split(...))` 时，.split 只作用于最后一个字符串字面量，
  // 结果会退化成「单个字符」的集合（函数名高亮与补全全都会失效）。
  const FN = new Set(('COUNT SUM AVG MIN MAX TOTAL GROUP_CONCAT LENGTH LOWER UPPER SUBSTR SUBSTRING REPLACE TRIM LTRIM RTRIM ABS ROUND RANDOM ' +
    'COALESCE IFNULL NULLIF IIF TYPEOF HEX QUOTE DATE TIME DATETIME JULIANDAY STRFTIME UNIXEPOCH PRINTF FORMAT CAST CONVERT ROW_NUMBER RANK DENSE_RANK ' +
    'LAST_INSERT_ROWID CHANGES TOTAL_CHANGES SQLITE_VERSION CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP').split(/\s+/));

  // 同时转义引号：esc 也用于 data-* / title 等属性值，列名、库名里的引号不能逃逸出属性
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function highlight(code) {
    let out = '', i = 0;
    const n = code.length;
    while (i < n) {
      const c = code[i], c2 = code.substr(i, 2);
      if (c2 === '--') { let j = code.indexOf('\n', i); if (j === -1) j = n; out += '<span class="tok-cmt">' + esc(code.slice(i, j)) + '</span>'; i = j; continue; }
      if (c2 === '/*') { let j = code.indexOf('*/', i + 2); j = j === -1 ? n : j + 2; out += '<span class="tok-cmt">' + esc(code.slice(i, j)) + '</span>'; i = j; continue; }
      if (c === "'") { let j = i + 1; while (j < n) { if (code[j] === "'") { if (code[j + 1] === "'") { j += 2; continue; } j++; break; } j++; } out += '<span class="tok-str">' + esc(code.slice(i, j)) + '</span>'; i = j; continue; }
      if (c === '"' || c === '`') { let j = code.indexOf(c, i + 1); j = j === -1 ? n : j + 1; out += '<span class="tok-fn">' + esc(code.slice(i, j)) + '</span>'; i = j; continue; }
      if (c === '[') { let j = code.indexOf(']', i); j = j === -1 ? n : j + 1; out += '<span class="tok-fn">' + esc(code.slice(i, j)) + '</span>'; i = j; continue; }
      if (c === '@' || c === ':' || c === '$') { let j = i + 1; while (j < n && /[A-Za-z0-9_@:$]/.test(code[j])) j++; out += '<span class="tok-var">' + esc(code.slice(i, j)) + '</span>'; i = j; continue; }
      if (/[0-9]/.test(c) && !/[A-Za-z_]/.test(code[i - 1] || '')) { let j = i; while (j < n && /[0-9.]/.test(code[j])) j++; out += '<span class="tok-num">' + esc(code.slice(i, j)) + '</span>'; i = j; continue; }
      if (/[A-Za-z_]/.test(c)) {
        let j = i; while (j < n && /[A-Za-z0-9_]/.test(code[j])) j++;
        const w = code.slice(i, j), up = w.toUpperCase();
        if (KW.has(up)) out += '<span class="tok-kw">' + esc(w) + '</span>';
        else if (FN.has(up)) out += '<span class="tok-fn">' + esc(w) + '</span>';
        else out += esc(w);
        i = j; continue;
      }
      if ('=<>!+-*/%|&'.includes(c)) { out += '<span class="tok-op">' + esc(c) + '</span>'; i++; continue; }
      out += esc(c); i++;
    }
    return out;
  }

  /* 轻量 SQL 格式化：主要关键字前换行 + 统一缩进 */
  const NEWLINE_KW = /\b(FROM|WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|OFFSET|UNION(?:\s+ALL)?|LEFT\s+(?:OUTER\s+)?JOIN|RIGHT\s+(?:OUTER\s+)?JOIN|INNER\s+JOIN|FULL\s+(?:OUTER\s+)?JOIN|CROSS\s+JOIN|JOIN|ON|VALUES|SET|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/gi;
  function formatSql(src) {
    let out = '';
    let depth = 0;
    const lines = String(src).split('\n');
    lines.forEach(raw => {
      let line = raw.replace(/\s+/g, ' ').trim();
      if (!line) { out += '\n'; return; }
      if (line.startsWith('--')) { out += line + '\n'; return; }
      // 主关键字前换行
      line = line.replace(NEWLINE_KW, m => '\n' + m.toUpperCase());
      line.split('\n').forEach((seg, i) => {
        let s = seg.trim();
        if (!s) return;
        if (/^(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE|ALTER|DROP)\b/i.test(s)) depth = 0;
        if (/^(FROM|WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|OFFSET|VALUES|SET|ON|UNION|.*JOIN)\b/i.test(s)) depth = 1;
        const indent = '    '.repeat(depth);
        if (i === 0 && out && !out.endsWith('\n')) out += '\n';
        out += indent + s + '\n';
      });
    });
    return out.replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  /* ==========================================================
   * 4. 连接管理
   * ========================================================== */
  async function createConnection(cfg) {
    const engine = S.create(cfg.engine);
    let data = null;
    if (cfg.loadFromStore) data = await S.Store.getFile(cfg.id);
    await engine.open({ data: data || undefined, name: cfg.name });
    const c = {
      id: cfg.id, name: cfg.name, engineKind: cfg.engine, engine,
      file: cfg.file || null, persist: !!cfg.persist, source: cfg.source || 'new',
      schemas: {}
    };
    await refreshConnSchema(c);
    return c;
  }

  async function refreshConnSchema(c) {
    c.schema = await c.engine.schema();
    c.attached = await c.engine.attached();
    if (!c.schemas) c.schemas = {};
    const key = (c.schema && c.schema.database) || 'main';
    c.schemas[key] = c.schema;
  }

  async function persistConn(c) {
    if (!c.persist) return;
    const bytes = c.engine.exportBinary();
    await S.Store.putFile(c.id, bytes);
    await S.Store.putMeta(c.id, {
      id: c.id, name: c.name, engine: c.engineKind, persist: true, file: c.file
    });
  }

  async function saveAllDirty() {
    for (const c of state.conns) {
      if (c.persist && c.engine) { try { await persistConn(c); } catch (e) { /* ignore */ } }
    }
  }

  async function closeConnection(id, remove) {
    const i = state.conns.findIndex(c => c.id === id);
    if (i < 0) return;
    const c = state.conns[i];
    try { c.engine && c.engine.close(); } catch (e) { /* ignore */ }
    state.conns.splice(i, 1);
    if (remove) { await S.Store.delFile(id); await S.Store.delMeta(id); }
    if (state.activeConnId === id) {
      state.activeConnId = state.conns.length ? state.conns[0].id : null;
    }
    renderTree();
    updateStatus();
    renderResult();
  }

  async function restoreConnections() {
    let keys = [];
    try { keys = await S.Store.metaKeys(); } catch (e) { return; }
    for (const k of keys) {
      try {
        const meta = await S.Store.getMeta(k);
        if (!meta) continue;
        const c = await createConnection({
          id: meta.id, name: meta.name, engine: meta.engine,
          persist: true, file: meta.file, loadFromStore: true, source: 'restored'
        });
        state.conns.push(c);
      } catch (e) {
        console.warn('恢复连接失败', k, e);
      }
    }
    if (state.conns.length && !state.activeConnId) state.activeConnId = state.conns[0].id;
  }

  /* ==========================================================
   * 5. 对象资源管理器
   * ========================================================== */
  const treeEl = $('#tree');
  let nodeSeq = 0;

  function renderTree() {
    treeEl.innerHTML = '';
    nodeSeq = 0;
    if (!state.conns.length) {
      treeEl.innerHTML = '<div class="tree-empty">尚未建立任何连接。<br>点击工具栏 <b>新建连接</b> 或菜单「文件 → 新建连接」开始。<br><br>' +
        '<span style="opacity:.7">引擎在浏览器内以 WebAssembly 运行，无需安装任何数据库服务。</span></div>';
      return;
    }
    const ul = document.createElement('ul');
    ul.className = 'children';
    state.conns.forEach(c => buildConnNode(c, ul));
    treeEl.appendChild(ul);
    applyFilter();
  }

  function buildConnNode(c, parentEl) {
    const li = document.createElement('li');
    const isActive = c.id === state.activeConnId;
    const row = document.createElement('div');
    row.className = 'node' + (isActive ? ' selected' : '');
    row.style.paddingLeft = '6px';
    row.dataset.name = c.name;
    row.dataset.type = 'conn';
    row.innerHTML =
      '<span class="caret open">▶</span>' +
      '<svg class="ico" viewBox="0 0 16 16" width="15" height="15">' + IC.server + '</svg>' +
      '<span class="label">' + esc(c.name) + '</span>' +
      '<span class="badge">' + (c.engineKind === 'duckdb' ? 'DuckDB' : 'SQLite') + '</span>';
    row._connId = c.id;
    li.appendChild(row);

    const ul = document.createElement('ul');
    ul.className = 'children';
    buildSchemaNodes(c, ul);
    li.appendChild(ul);
    row._ul = ul;
    row._caret = row.querySelector('.caret');

    parentEl.appendChild(li);
  }

  function buildSchemaNodes(c, ul) {
    const sc = c.schema || { tables: [], views: [], indexes: [], triggers: [], procedures: [], functions: [] };
    const isRemote = c.engineKind === 'remote';

    /* ---- 远程多库：数据库作为一级节点，展开时懒加载 ---- */
    if (isRemote && sc.databases && sc.databases.length) {
      const cur = sc.database || (c.engine.currentDatabase);
      sc.databases.forEach(db => {
        const li = document.createElement('li');
        const row = document.createElement('div');
        row.className = 'node';
        row.style.paddingLeft = '20px';
        row.dataset.name = db;
        row.dataset.type = 'database';
        row.innerHTML = '<span class="caret">▶</span>' +
          '<svg class="ico" viewBox="0 0 16 16" width="15" height="15">' + IC.db + '</svg>' +
          '<span class="label">' + esc(db) + '</span>' +
          (db === cur ? '<span class="badge">当前</span>' : '');
        row._dbName = db;
        row._connId = c.id;
        row._lazyDb = true;
        li.appendChild(row);
        const sub = document.createElement('ul');
        sub.className = 'children collapsed';
        li.appendChild(sub);
        row._ul = sub;
        row._caret = row.querySelector('.caret');
        ul.appendChild(li);
      });
      return;
    }

    /* ---- 单库：表 / 视图 / 索引 / 触发器 文件夹 ---- */
    if (c.attached && c.attached.length > 1) {
      ul.appendChild(folderNode('数据库 (' + c.attached.length + ')', 'db',
        c.attached.map(a => ({ type: 'leaf', name: a.name, icon: 'db', badge: a.file ? a.file.split(/[\\/]/).pop() : '(内存)' })), true));
    }
    if (sc.tables && sc.tables.length) {
      const dbName = sc.database || (isRemote ? c.engine.currentDatabase : null);
      ul.appendChild(tableFolder('表 (' + sc.tables.length + ')', sc.tables, c, 20, true, dbName));
    }
    if (sc.views && sc.views.length) {
      const dbName = sc.database || (isRemote ? c.engine.currentDatabase : null);
      ul.appendChild(tableFolder('视图 (' + sc.views.length + ')', sc.views, c, 20, false, dbName));
    }
    if (sc.indexes && sc.indexes.length) {
      const kids = sc.indexes.map(x => ({ type: 'index', name: x.name, icon: 'index', badge: x.table, _obj: x }));
      ul.appendChild(folderNode('索引 (' + sc.indexes.length + ')', 'folder', kids, false));
    }
    if (sc.triggers && sc.triggers.length) {
      const kids = sc.triggers.map(x => ({ type: 'trigger', name: x.name, icon: 'trigger', badge: x.table, _obj: x }));
      ul.appendChild(folderNode('触发器 (' + sc.triggers.length + ')', 'folder', kids, false));
    }
    /* ---- 存储过程 / 函数（SQLite 没有这类对象，数组为空即不显示） ---- */
    const rdb = sc.database || (isRemote ? c.engine.currentDatabase : null);
    if (sc.procedures && sc.procedures.length) {
      ul.appendChild(folderNode('存储过程 (' + sc.procedures.length + ')', 'proc',
        sc.procedures.map(x => routineLeaf(x, 'procedure', rdb, 'proc')), false));
    }
    if (sc.functions && sc.functions.length) {
      ul.appendChild(folderNode('函数 (' + sc.functions.length + ')', 'func',
        sc.functions.map(x => routineLeaf(x, 'function', rdb, 'func')), false));
    }
    if (!ul.children.length) {
      const li = document.createElement('li');
      li.innerHTML = '<div class="node" style="padding-left:20px;opacity:.5"><span class="caret leaf">▶</span><span class="label">（空）</span></div>';
      ul.appendChild(li);
    }
  }

  /** 表 / 视图 文件夹 */
  /**
   * 表 / 视图文件夹。
   * database 必须由调用方显式传入 —— 注意 item.schema 是「数据库架构名」
   * （SQL Server 的 dbo、PostgreSQL 的 public），**不是数据库名**，
   * 早期版本误把它当成库名传给 columns()，会去连一个名为 dbo 的库而报「登录失败」。
   */
  function tableFolder(title, items, c, indent, expanded, database) {
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'node';
    row.style.paddingLeft = indent + 'px';
    row.dataset.name = title.replace(/\s*\(.*\)$/, '');
    row.dataset.type = 'folder';
    row.innerHTML = '<span class="caret' + (expanded ? ' open' : '') + '">▶</span>' +
      '<svg class="ico" viewBox="0 0 16 16" width="15" height="15">' + IC.folder + '</svg>' +
      '<span class="label">' + esc(title) + '</span>';
    li.appendChild(row);
    const sub = document.createElement('ul');
    sub.className = 'children' + (expanded ? '' : ' collapsed');
    items.forEach(it => sub.appendChild(tableNode(it, c, indent + 14, database || null)));
    li.appendChild(sub);
    row._ul = sub;
    row._caret = row.querySelector('.caret');
    return li;
  }

  /** 单个表 / 视图节点（列按需加载） */
  function tableNode(item, c, indent, database) {
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'node';
    row.style.paddingLeft = indent + 'px';
    row.dataset.name = item.name;
    row.dataset.type = item.type;
    let badge = '';
    if (item.rowCount !== null && item.rowCount !== undefined) {
      badge = (item.rowCountApprox ? '~' : '') + item.rowCount + ' 行';
    }
    row.innerHTML = '<span class="caret">▶</span>' +
      '<svg class="ico" viewBox="0 0 16 16" width="15" height="15">' + (item.type === 'view' ? IC.view : IC.table) + '</svg>' +
      '<span class="label">' + esc(item.name) + '</span>' +
      (badge ? '<span class="badge">' + badge + '</span>' : '');
    row._k = { type: item.type, name: item.name, _table: item, _db: database };
    row._connId = c.id;
    row._colIndent = indent + 14;
    row._db = database;

    li.appendChild(row);
    const sub = document.createElement('ul');
    sub.className = 'children collapsed';
    li.appendChild(sub);
    row._ul = sub;
    row._caret = row.querySelector('.caret');

    if (item.columns && item.columns.length) {
      fillColumnNodes(sub, item.columns, indent + 14);
      row._colsLoaded = true;
    } else {
      row._colsLazy = true;
    }
    return li;
  }

  function fillColumnNodes(ul, columns, indent) {
    ul.innerHTML = '';
    columns.forEach(col => {
      const cl = document.createElement('li');
      const cr = document.createElement('div');
      cr.className = 'node';
      cr.style.paddingLeft = indent + 'px';
      cr.dataset.name = col.name;
      cr.dataset.type = 'column';
      cr.innerHTML = '<span class="caret leaf">▶</span>' +
        '<svg class="ico" viewBox="0 0 16 16" width="15" height="15">' + (col.pk ? IC.colpk : IC.col) + '</svg>' +
        '<span class="label">' + esc(col.name) + '</span>' +
        (col.pk ? '<span class="pk" style="color:var(--amber);font-size:10px">PK</span>' : '') +
        (col.auto ? '<span class="pk" style="color:var(--accent);font-size:10px">AUTO</span>' : '') +
        '<span class="coltype">' + esc(col.type) + (col.notnull ? ' NOT NULL' : '') + '</span>';
      cl.appendChild(cr);
      ul.appendChild(cl);
    });
    if (!columns.length) {
      ul.innerHTML = '<li><div class="node" style="padding-left:' + indent + 'px;opacity:.5"><span class="caret leaf">▶</span><span class="label">（无列信息）</span></div></li>';
    }
  }

  /** 展开数据库节点时懒加载其表结构 */
  async function loadDatabaseNode(c, row) {
    if (row._loaded) return;
    row._loaded = true;
    row._ul.innerHTML = '<li><div class="node" style="padding-left:34px;opacity:.6"><span class="caret leaf">▶</span><span class="label">加载中…</span></div></li>';
    try {
      const sc = await c.engine.schema(row._dbName);
      if (!c.schemas) c.schemas = {};
      c.schemas[row._dbName] = sc;
      row._ul.innerHTML = '';
      const hasAny = (sc.tables && sc.tables.length) || (sc.views && sc.views.length) ||
        (sc.procedures && sc.procedures.length) || (sc.functions && sc.functions.length);
      if (sc.tables && sc.tables.length) row._ul.appendChild(tableFolder('表 (' + sc.tables.length + ')', sc.tables, c, 34, true, row._dbName));
      if (sc.views && sc.views.length) row._ul.appendChild(tableFolder('视图 (' + sc.views.length + ')', sc.views, c, 34, false, row._dbName));
      if (sc.procedures && sc.procedures.length) {
        row._ul.appendChild(folderNode('存储过程 (' + sc.procedures.length + ')', 'proc',
          sc.procedures.map(x => routineLeaf(x, 'procedure', row._dbName, 'proc')), false, 34));
      }
      if (sc.functions && sc.functions.length) {
        row._ul.appendChild(folderNode('函数 (' + sc.functions.length + ')', 'func',
          sc.functions.map(x => routineLeaf(x, 'function', row._dbName, 'func')), false, 34));
      }
      if (!hasAny) {
        row._ul.innerHTML = '<li><div class="node" style="padding-left:34px;opacity:.5"><span class="caret leaf">▶</span><span class="label">（空库）</span></div></li>';
      }
    } catch (e) {
      row._loaded = false;
      row._ul.innerHTML = '<li><div class="node" style="padding-left:34px"><span class="caret leaf">▶</span><span class="label" style="color:var(--red)">' + esc(e.message) + '</span></div></li>';
    }
  }

  /** 展开表节点时懒加载列 */
  async function loadTableColumns(c, row) {
    if (row._colsLoaded) return;
    row._colsLoaded = true;
    row._ul.innerHTML = '<li><div class="node" style="padding-left:' + row._colIndent + 'px;opacity:.6"><span class="caret leaf">▶</span><span class="label">加载中…</span></div></li>';
    try {
      const cols = await c.engine.columns(row._db, row._k.name);
      row._k._table.columns = cols;
      fillColumnNodes(row._ul, cols, row._colIndent);
    } catch (e) {
      row._colsLoaded = false;
      row._ul.innerHTML = '<li><div class="node" style="padding-left:' + row._colIndent + 'px"><span class="caret leaf">▶</span><span class="label" style="color:var(--red)">' + esc(e.message) + '</span></div></li>';
    }
  }

  function folderNode(title, icon, kids, expanded, indent) {
    indent = indent || 20;
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'node';
    row.style.paddingLeft = indent + 'px';
    row.dataset.name = title.replace(/\s*\(.*\)$/, '');
    row.dataset.type = 'folder';
    row.innerHTML = '<span class="caret' + (expanded ? ' open' : '') + '">▶</span>' +
      '<svg class="ico" viewBox="0 0 16 16" width="15" height="15">' + (IC[icon] || IC.folder) + '</svg>' +
      '<span class="label">' + esc(title) + '</span>';
    li.appendChild(row);

    const sub = document.createElement('ul');
    sub.className = 'children' + (expanded ? '' : ' collapsed');
    kids.forEach(k => sub.appendChild(leafNode(k, indent + 14)));
    li.appendChild(sub);
    row._ul = sub;
    row._caret = row.querySelector('.caret');
    return li;
  }

  function leafNode(k, indent) {
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'node';
    row.style.paddingLeft = indent + 'px';
    row.dataset.name = k.name;
    row.dataset.type = k.type;
    row.innerHTML = '<span class="caret leaf">▶</span>' +
      '<svg class="ico" viewBox="0 0 16 16" width="15" height="15">' + (IC[k.icon] || IC.col) + '</svg>' +
      '<span class="label">' + esc(k.name) + '</span>' +
      (k.badge ? '<span class="badge">' + esc(k.badge) + '</span>' : '');
    row._k = k;
    li.appendChild(row);
    return li;
  }

  /**
   * 存储过程 / 函数的树节点。
   * label 优先 —— PostgreSQL 的同名重载函数靠参数签名区分，
   * 只用 name 的话列表里会出现一串完全相同的条目。
   */
  function routineLeaf(item, kind, database, icon) {
    return {
      type: kind, name: item.label || item.name, icon,
      badge: routineBadge(item), _obj: item, _db: database
    };
  }

  /** 给存储过程 / 函数一个短标签（SQL Server 的 type_desc 太长，不适合塞进树） */
  function routineBadge(item) {
    const t = String((item && item.typeDesc) || '');
    if (/AGGREGATE/i.test(t)) return '聚合函数';
    if (/INLINE/i.test(t)) return '内联表值函数';
    if (/TABLE/i.test(t)) return '表值函数';
    if (/SCALAR/i.test(t)) return '标量函数';
    if (/PROCEDURE/i.test(t)) return '';       // 存储过程不必再标一遍
    const r = String((item && item.ret) || '');
    return r.length > 16 ? r.slice(0, 16) + '…' : r;
  }

  /* 树交互 */
  /* 展开/收起一个节点，并在展开时按需拉取数据 */
  function toggleRow(row) {
    if (!row._ul) return;
    row._caret.classList.toggle('open');
    row._ul.classList.toggle('collapsed');
    if (!row._caret.classList.contains('open')) return;
    const c = state.conns.find(x => x.id === row._connId);
    if (!c) return;
    if (row._lazyDb) loadDatabaseNode(c, row);
    else if (row._colsLazy) loadTableColumns(c, row);
  }

  function selectConnection(row) {
    state.activeConnId = row._connId;
    $$('#tree .node').forEach(n => n.classList.remove('selected'));
    row.classList.add('selected');
    renderDocs(); updateStatus(); renderResult(); updateDbSwitcher();
  }

  treeEl.addEventListener('click', e => {
    const row = e.target.closest('.node');
    if (!row) return;

    // 点击展开箭头
    const caret = e.target.closest('.caret');
    if (caret && !caret.classList.contains('leaf')) { toggleRow(row); return; }

    // 连接节点
    if (row.dataset.type === 'conn') { selectConnection(row); return; }

    // 其余节点：选中
    $$('#tree .node').forEach(n => n.classList.remove('selected'));
    row.classList.add('selected');

    // 数据库节点：单击同时切换当前库
    if (row.dataset.type === 'database') {
      const c = state.conns.find(x => x.id === row._connId);
      if (c && c.engineKind === 'remote' && c.engine.currentDatabase !== row._dbName) {
        c.engine.setDatabase(row._dbName);
        if (c.schema) c.schema.database = row._dbName;
        updateStatus(); updateDbSwitcher();
        status('当前数据库已切换为 ' + row._dbName);
        toast('当前数据库：' + row._dbName);
        renderTree();
        return;
      }
    }
    if (row._ul) toggleRow(row);
  });

  treeEl.addEventListener('dblclick', e => {
    const row = e.target.closest('.node');
    if (!row || !row._k) return;
    const k = row._k;
    // 带上该节点所属的数据库，避免跨库浏览时打开到当前库的同名表
    if (k.type === 'table') openTableQuery(k.name, { database: k._db });
    else if (k.type === 'view') openTableQuery(k.name, { isView: true, database: k._db });
    else if (k.type === 'index' || k.type === 'trigger') showDdl(k._obj.ddl, k.name);
    else if (k.type === 'procedure' || k.type === 'function') openRoutine(k._obj, k._db);
  });

  const filterEl = $('#treeFilter');
  filterEl.addEventListener('input', applyFilter);
  function applyFilter() {
    const q = filterEl.value.trim().toLowerCase();
    const rows = $$('#tree .node');
    if (!q) { rows.forEach(r => r.classList.remove('filtered-out')); return; }
    const rev = rows.slice().reverse();
    const hit = new Map();
    rev.forEach(r => {
      const self = (r.dataset.name || '').toLowerCase().includes(q);
      let childHit = false;
      if (r._ul) r._ul.querySelectorAll(':scope > li > .node').forEach(c => { if (hit.get(c)) childHit = true; });
      const ok = self || childHit;
      hit.set(r, ok);
      r.classList.toggle('filtered-out', !ok);
      if (childHit && r._ul) { r._ul.classList.remove('collapsed'); r._caret && r._caret.classList.add('open'); }
    });
  }

  /* ==========================================================
   * 6. 右键菜单
   * ========================================================== */
  const ctxEl = $('#ctx');
  let ctxData = null;

  treeEl.addEventListener('contextmenu', e => {
    const row = e.target.closest('.node');
    if (!row) return;
    e.preventDefault();
    // 先判断对象节点：表 / 视图节点同样带有 _connId，若先判断 _connId 会一律落到「连接」菜单
    if (!row._k) {
      if (row.dataset.type === 'conn' || row.dataset.type === 'database') {
        ctxData = { kind: 'conn', id: row._connId }; showConnCtx(e.clientX, e.clientY); return;
      }
      ctxData = { kind: 'folder' }; showSimpleCtx(e.clientX, e.clientY); return;
    }
    // 记下节点所属连接，执行菜单操作前切换过去，避免作用到当前活动连接的同名表
    ctxData = Object.assign({}, row._k, { connId: row._connId });
    if (row._k.type === 'table') showTableCtx(e.clientX, e.clientY, row._k.name);
    else if (row._k.type === 'procedure' || row._k.type === 'function') showRoutineCtx(e.clientX, e.clientY, row._k);
    else showSimpleCtx(e.clientX, e.clientY);
  });

  function mi(icon, text, action, extra, dim) {
    return '<div class="c-item' + (dim ? ' dim' : '') + '" data-action="' + action + '">' +
      '<span class="c-ico"><svg viewBox="0 0 16 16" width="14" height="14">' + (IC[icon] || IC.folder) + '</svg></span>' +
      text + (extra || '') + '</div>';
  }
  function showMenu(x, y, html) {
    ctxEl.innerHTML = html;
    ctxEl.classList.add('show');
    const w = ctxEl.offsetWidth, h = ctxEl.offsetHeight;
    ctxEl.style.left = Math.min(x, innerWidth - w - 6) + 'px';
    ctxEl.style.top = Math.min(y, innerHeight - h - 6) + 'px';
  }
  const hideCtx = () => ctxEl.classList.remove('show');
  document.addEventListener('mousedown', e => { if (!ctxEl.contains(e.target)) hideCtx(); });
  window.addEventListener('blur', hideCtx);

  function showConnCtx(x, y) {
    const c = state.conns.find(v => v.id === ctxData.id);
    showMenu(x, y,
      '<div class="c-title">' + esc(c.name) + '</div>' +
      mi('query', '新建查询', 'new-query') +
      mi('table', '刷新', 'refresh') +
      '<div class="c-sep"></div>' +
      mi('db', '导出数据库为 .db 文件', 'export-db') +
      mi('table', '执行 SQL 脚本文件…', 'run-script') +
      '<div class="c-sep"></div>' +
      mi('folder', '关闭连接', 'close-conn') +
      mi('folder', '删除连接及其本地数据', 'drop-conn'));
  }
  function showTableCtx(x, y, name) {
    showMenu(x, y,
      '<div class="c-title">' + esc(name) + '</div>' +
      mi('query', '选择前 1000 行', 'top1000') +
      mi('table', '编辑数据', 'edit-data') +
      '<div class="c-sep"></div>' +
      mi('query', '生成 SELECT 脚本', 'script-select') +
      mi('table', '生成 CREATE 脚本', 'script-create') +
      mi('view', '生成 INSERT 脚本', 'script-insert') +
      '<div class="c-sep"></div>' +
      mi('table', '查看建表 DDL', 'show-ddl') +
      mi('table', '导入 CSV 到此表…', 'import-csv-table') +
      mi('db', '导出表数据为 CSV', 'export-csv-table') +
      '<div class="c-sep"></div>' +
      mi('folder', '清空表 (DELETE)', 'truncate') +
      mi('folder', '删除表 (DROP)', 'drop-table'));
  }
  function showSimpleCtx(x, y) {
    showMenu(x, y,
      '<div class="c-title">' + esc((ctxData && ctxData.name) || '') + '</div>' +
      mi('query', '新建查询', 'new-query') +
      mi('table', '刷新', 'refresh'));
  }
  /** 存储过程 / 函数的右键菜单（双击也能看定义，但双击不可发现） */
  function showRoutineCtx(x, y, k) {
    const it = k._obj || {};
    showMenu(x, y,
      '<div class="c-title">' + esc(it.label || it.name || '') + '</div>' +
      mi(k.type === 'procedure' ? 'proc' : 'func', '查看定义', 'routine-ddl') +
      mi('query', '生成调用脚本', 'routine-call') +
      '<div class="c-sep"></div>' +
      mi('query', '新建查询', 'new-query') +
      mi('table', '刷新', 'refresh'));
  }

  ctxEl.addEventListener('click', async e => {
    const it = e.target.closest('.c-item');
    if (!it || it.classList.contains('dim')) return;
    hideCtx();
    if (it.dataset.db) { await switchDatabase(it.dataset.db); return; }
    await handleAction(it.dataset.action);
  });

  async function switchDatabase(db) {
    const c = conn();
    if (!c || c.engineKind !== 'remote') return;
    if (c.engine.currentDatabase === db) return;
    c.engine.setDatabase(db);
    if (c.schema) c.schema.database = db;
    updateStatus(); updateDbSwitcher();
    try { await doRefresh(true); } catch (e) { /* ignore */ }
    status('当前数据库：' + db);
    toast('已切换到 ' + db);
  }

  /** 按当前连接方言引用标识符 */
  function qid(name, c) { return S.quoteIdentFor(name, dialectOf(c || conn())); }
  /** 按方言生成「取前 n 行」查询：MSSQL 用 TOP，其余用 LIMIT */
  function selectTopSql(name, n, c) {
    return dialectOf(c || conn()) === 'mssql'
      ? 'SELECT TOP ' + n + ' * FROM ' + qid(name, c) + ';'
      : 'SELECT * FROM ' + qid(name, c) + ' LIMIT ' + n + ';';
  }

  /**
   * 右键表操作前的准备：切到该表所属连接与数据库，返回执行用的库名。
   * 树里可能同时展开多个连接 / 多个库，菜单操作必须作用于被点中的那张表。
   */
  function useCtxTable(d) {
    if (d.connId && d.connId !== state.activeConnId && state.conns.some(x => x.id === d.connId)) {
      state.activeConnId = d.connId;
      renderDocs(); updateStatus(); renderResult(); updateDbSwitcher();
    }
    const c = conn();
    if (c && c.engineKind === 'remote' && d._db && c.engine.currentDatabase !== d._db) {
      c.engine.setDatabase(d._db);
      if (c.schema) c.schema.database = d._db;
      updateStatus(); updateDbSwitcher();
    }
    return (c && c.engineKind === 'remote') ? (d._db || currentDbArg(c)) : undefined;
  }

  /** 执行一条写操作，失败时提示错误并返回 false（execSql 本身不抛异常） */
  let lastExecError = '';
  async function execOrToast(sql, label, db) {
    const r = await execSql(sql, db ? { database: db } : undefined);
    if (!r) { lastExecError = label + '失败：没有可用连接'; return false; }
    if (r.error) { lastExecError = label + '失败：' + r.error; toast(lastExecError, true); return false; }
    return true;
  }

  const TABLE_ACTIONS = new Set(['top1000', 'edit-data', 'script-select', 'script-insert',
    'import-csv-table', 'export-csv-table', 'truncate', 'drop-table']);

  async function handleAction(a) {
    const d = ctxData || {};
    const db = TABLE_ACTIONS.has(a) ? useCtxTable(d) : undefined;
    switch (a) {
      case 'new-query': newDoc(); break;
      case 'refresh': await doRefresh(); break;
      case 'top1000': openTableQuery(d.name, { database: d._db }); break;
      case 'edit-data': openTableQuery(d.name, { database: d._db }); break;
      case 'show-ddl': showDdl(d._table && d._table.ddl, d.name); break;
      case 'script-select': insertQuery(selectTopSql(d.name, 100)); break;
      case 'script-create': showDdl(d._table && d._table.ddl || '-- 无 DDL', d.name + ' — CREATE 脚本', true); break;
      case 'script-insert': await scriptInsert(d.name, db); break;
      case 'export-db': await exportDb(); break;
      case 'run-script': pickFile('.sql,.txt', f => runScriptFile(f)); break;
      case 'import-csv-table': pickFile('.csv,.txt', f => importCsvToTable(f, d.name, db)); break;
      case 'export-csv-table': await exportTableCsv(d.name, db); break;
      case 'truncate': await confirmThen('清空表', '将执行 DELETE FROM ' + esc(qid(d.name)) + '，删除所有行（可回滚前请确认）。', async () => {
        // 先刷新再提示：doRefresh 自己会弹「已刷新」，放在后面会盖掉结果提示
        const okDel = await execOrToast('DELETE FROM ' + qid(d.name) + ';', '清空表', db);
        if (okDel) await persistConn(conn());
        await doRefresh();
        if (okDel) toast('已清空 ' + d.name);
        else toast(lastExecError, true);
      }); break;
      case 'drop-table': await confirmThen('删除表', '将执行 DROP TABLE ' + esc(qid(d.name)) + '，该操作不可撤销！', async () => {
        const okDrop = await execOrToast('DROP TABLE ' + qid(d.name) + ';', '删除表', db);
        if (okDrop) await persistConn(conn());
        await doRefresh();
        if (okDrop) toast('已删除 ' + d.name);
        else toast(lastExecError, true);
      }, true); break;
      case 'close-conn': await closeConnection(d.id, false); toast('连接已关闭'); break;
      case 'drop-conn': await confirmThen('删除连接', '将关闭连接并删除其保存在浏览器本地的数据库文件，不可恢复。', async () => {
        await closeConnection(d.id, true); toast('连接已删除');
      }, true); break;
      /* 结果网格上的增 / 删 / 复制（作用于当前查询窗口） */
      case 'row-add': await addRowDialog(); break;
      case 'row-del': await deleteSelectedRows(); break;
      case 'row-copy': copySelectedRows(); break;
      default: toast('操作：' + a);
    }
  }

  /* ==========================================================
   * 7. 文档 / 标签
   * ========================================================== */
  function newDoc(sql, title) {
    state.docSeq++;
    const d = {
      id: 'doc' + state.docSeq,
      title: title || ('SQLQuery' + state.docSeq + '.sql'),
      sql: sql !== undefined ? sql : '',
      dirty: false, result: null, message: null, activeRes: 'grid',
      editTable: null, editCols: null, rowids: null, isView: false
    };
    state.docs.push(d);
    activateDoc(d.id);
    return d;
  }
  function activateDoc(id) {
    const cur = doc();
    if (cur) cur.sql = $('#sql').value;
    state.activeDocId = id;
    const d = doc();
    $('#sql').value = d.sql;
    acClose();
    renderDocs(); updateEditor(); renderResult();
    $('#sql').focus();
  }
  function closeDoc(id) {
    const i = state.docs.findIndex(d => d.id === id);
    if (i < 0) return;
    state.docs.splice(i, 1);
    if (state.activeDocId === id) {
      if (state.docs.length) activateDoc(state.docs[Math.max(0, i - 1)].id);
      else { state.activeDocId = null; $('#sql').value = ''; renderDocs(); updateEditor(); renderResult(); }
    } else renderDocs();
  }
  function renderDocs() {
    const tabs = $('#docTabs');
    tabs.innerHTML = '';
    state.docs.forEach(d => {
      const t = document.createElement('div');
      t.className = 'doc-tab' + (d.id === state.activeDocId ? ' active' : '');
      t.dataset.id = d.id;
      t.innerHTML = '<svg class="t-ico" viewBox="0 0 16 16">' + IC.query + '</svg>' +
        '<span class="t-name">' + esc(d.title) + '</span>' +
        (d.dirty ? '<span class="dirty"></span>' : '') +
        '<span class="t-close">✕</span>';
      tabs.appendChild(t);
    });
  }
  $('#docTabs').addEventListener('click', e => {
    const tab = e.target.closest('.doc-tab');
    if (!tab) return;
    if (e.target.closest('.t-close')) closeDoc(tab.dataset.id);
    else activateDoc(tab.dataset.id);
  });

  function insertQuery(sql) {
    if (!doc()) newDoc(sql);
    else {
      const d = doc();
      // 以编辑框里的最新内容为准追加，并同步写回编辑框——
      // activateDoc 开头会用编辑框文本覆盖 d.sql，只改 d.sql 会让追加的 SQL 丢失
      const cur = $('#sql').value;
      d.sql = cur + (cur && !/\n$/.test(cur) ? '\n\n' : '') + sql;
      $('#sql').value = d.sql;
      activateDoc(d.id);
    }
  }
  function showDdl(ddl, title, wide) {
    const text = ddl || '-- 该对象没有可用的 DDL';
    return showDdlAsync(title, () => text, wide);
  }

  /**
   * 先弹窗、再异步填充内容。
   * 存储过程 / 函数的定义要单独向后端取；若先等结果再弹窗，
   * 遇到慢查询界面会像卡死一样，完全没有反馈。
   */
  function showDdlAsync(title, loader, wide) {
    const m = openModal(esc(title),
      '<pre class="ddl-pre">-- 正在读取定义…</pre>',
      '<button class="btn" data-copy>复制</button><button class="btn" data-insert>插入到查询窗口</button><button class="btn primary" data-cancel>关闭</button>',
      null, wide !== false);
    let text = '';
    const put = t => {
      text = t || '-- 该对象没有可用的定义';
      m.querySelector('.m-body').innerHTML = '<pre class="ddl-pre">' + esc(text) + '</pre>';
    };
    m.querySelector('[data-copy]').addEventListener('click', () => { if (!text) return; copyText(text); toast('已复制到剪贴板'); });
    m.querySelector('[data-insert]').addEventListener('click', () => { if (!text) return; insertQuery(text); m._close(); });
    Promise.resolve().then(loader).then(put)
      .catch(e => put('-- 读取失败：' + (e && e.message ? e.message : e)));
    return m;
  }

  /** 双击存储过程 / 函数节点：按需取回 CREATE 原文 */
  function openRoutine(item, database) {
    const c = conn();
    if (!item) return;
    const label = item.label || item.name;
    if (!c || !c.engine || typeof c.engine.routineDdl !== 'function') {
      toast('当前引擎不支持查看存储过程 / 函数', true);
      return;
    }
    status('正在读取 ' + label + ' 的定义…');
    showDdlAsync(label, async () => {
      try { return await c.engine.routineDdl(item, database); }
      finally { status('就绪'); }
    });
  }

  /** 生成存储过程 / 函数的调用骨架（相当于 SSMS 的「编写 EXECUTE 脚本」） */
  function routineCallScript(item) {
    if (!item) return '';
    const dialect = dialectOf(conn());
    const q = n => S.quoteIdentFor(n, dialect);
    const nm = String(item.name).split('.').map(q).join('.');
    const isProc = (item.kind || item.type) === 'procedure';
    if (dialect === 'mssql') {
      return (isProc ? 'EXEC ' : 'SELECT ') + nm + ';\n-- 按实际参数补全，例如：\n-- EXEC ' + nm + ' @p1 = 1, @p2 = \'x\';';
    }
    if (dialect === 'mysql') {
      return isProc ? ('CALL ' + nm + '();\n-- 按实际参数补全：CALL ' + nm + '(arg1, arg2);')
                    : ('SELECT ' + nm + '();');
    }
    return isProc ? ('CALL ' + nm + '();') : ('SELECT * FROM ' + nm + '();');
  }

  function copyText(t) {
    if (navigator.clipboard) navigator.clipboard.writeText(t).catch(() => { });
    else { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
  }

  /* ==========================================================
   * 8. 编辑器
   * ========================================================== */
  const sqlEl = $('#sql'), hlEl = $('#hl'), gutterEl = $('#gutter'), codeScroll = $('#codeScroll');

  function updateEditor() {
    const code = sqlEl.value;
    hlEl.innerHTML = highlight(code) + '\n';
    const lines = code.split('\n').length;
    let g = '';
    for (let k = 1; k <= lines; k++) g += '<div class="ln">' + k + '</div>';
    gutterEl.innerHTML = g;
    sqlEl.style.height = 'auto';
    sqlEl.style.height = Math.max(sqlEl.scrollHeight, codeScroll.clientHeight) + 'px';
    updatePos();
  }
  function updatePos() {
    const pos = sqlEl.selectionStart;
    const before = sqlEl.value.slice(0, pos);
    const line = before.split('\n').length;
    const col = pos - before.lastIndexOf('\n');
    $('#sbPos').textContent = '行 ' + line + ', 列 ' + col;
    const lines = gutterEl.children;
    for (let k = 0; k < lines.length; k++) lines[k].classList.toggle('cur', k === line - 1);
    updateRunHint();
  }

  /**
   * 有选区时把工具栏「执行」按钮点亮并改提示语。
   * 不做这个提示，用户根本不知道 F5 会只跑选中部分，容易误以为语句没生效。
   */
  function updateRunHint() {
    const btn = document.querySelector('.tb-btn.exec');
    if (!btn) return;
    const a = sqlEl.selectionStart, b = sqlEl.selectionEnd;
    const has = b > a && sqlEl.value.slice(a, b).trim() !== '';
    btn.classList.toggle('sel', has);
    btn.title = has ? '执行选中的 SQL (F5) —— 只运行选中的部分' : '执行全部 SQL (F5)';
    const lb = btn.querySelector('.tb-label');
    if (lb) lb.textContent = has ? '执行选中' : '执行';
  }
  document.addEventListener('selectionchange', () => {
    if (document.activeElement === sqlEl) updateRunHint();
  });
  sqlEl.addEventListener('input', () => {
    const d = doc(); if (d) { d.dirty = true; renderDocs(); }
    updateEditor();
    acTrigger(false);
  });
  codeScroll.addEventListener('scroll', () => { gutterEl.style.transform = 'translateY(' + (-codeScroll.scrollTop) + 'px)'; });
  sqlEl.addEventListener('click', () => { acClose(); updatePos(); });
  sqlEl.addEventListener('keyup', updatePos);
  sqlEl.addEventListener('blur', () => setTimeout(acClose, 120));
  sqlEl.addEventListener('keydown', e => {
    // 补全弹层打开时，方向键 / Enter / Tab / Esc 归它处理
    if (acState) {
      if (e.key === 'ArrowDown') { e.preventDefault(); acMove(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); acMove(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acAccept(); return; }
      if (e.key === 'Escape') { e.preventDefault(); acClose(); return; }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') acClose();
    }
    if (e.ctrlKey && (e.key === ' ' || e.code === 'Space')) { e.preventDefault(); acTrigger(true); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      sqlEl.setRangeText('    ', sqlEl.selectionStart, sqlEl.selectionEnd, 'end');
      const d = doc(); if (d) { d.dirty = true; renderDocs(); }
      updateEditor();
    }
    if (e.key === 'F5') { e.preventDefault(); runQuery(); }
    if (e.ctrlKey && e.key === 'F5') { e.preventDefault(); explainQuery(); }
    if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); runQuery(); }
  });
  window.addEventListener('resize', updateEditor);

  /* ==========================================================
   * 8b. SQL 输入提示（自动补全）
   *   关键字 / 表名 / 列名 / 函数；`表名.` 或 `别名.` 之后只提示该表的列
   * ========================================================== */
  const AC_KEYWORDS = Array.from(KW);
  const AC_FUNCS = Array.from(FN);
  let acState = null;
  let acTimer = null;

  const AC_RESERVED = /^(ON|WHERE|GROUP|ORDER|HAVING|LIMIT|OFFSET|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|UNION|SET|VALUES|AS|AND|OR|NOT|IN|IS|LIKE|BETWEEN|ASC|DESC|THEN|ELSE|END|WHEN|CASE|INTO|FROM|SELECT|UPDATE|DELETE|INSERT)$/i;

  function acClose() {
    clearTimeout(acTimer);
    acState = null;
    const el = $('#ac');
    if (el) { el.classList.remove('show'); el.innerHTML = ''; }
  }

  /** 当前连接可见的表名 / 列名（含各数据库与 schema 缓存） */
  function acSchema() {
    const c = conn();
    const tables = [], colsByTable = {}, colSeen = new Set(), allCols = [];
    if (!c) return { tables, colsByTable, allCols };
    const push = sc => {
      if (!sc) return;
      (sc.tables || []).concat(sc.views || []).forEach(t => {
        if (tables.indexOf(t.name) < 0) tables.push(t.name);
        const cs = (t.columns || []).map(x => x.name);
        if (cs.length) {
          colsByTable[t.name] = cs;
          cs.forEach(n => { if (!colSeen.has(n)) { colSeen.add(n); allCols.push(n); } });
        }
      });
    };
    push(c.schema);
    Object.keys(c.schemas || {}).forEach(k => { if (!c.schema || c.schemas[k] !== c.schema) push(c.schemas[k]); });
    return { tables, colsByTable, allCols };
  }

  /* ---------- 语句解析：把「当前语句引用了哪些表」搞清楚 ---------- */

  // 标识符：支持 [方括号]、`反引号`、"双引号" 以及普通名字
  const AC_IDENT = '(?:\\[[^\\]]*\\]|`[^`]*`|"[^"]*"|[A-Za-z_][\\w$]*)';

  function acUnquote(s) {
    const t = String(s == null ? '' : s).trim();
    if (t.length >= 2) {
      const a = t[0], b = t[t.length - 1];
      if ((a === '[' && b === ']') || (a === '`' && b === '`') || (a === '"' && b === '"')) return t.slice(1, -1);
    }
    return t;
  }

  /**
   * 把字符串字面量与注释抹成等长空格，保留标识符（[x] / `x` / "x"）。
   * 这样后续正则扫描不会被字符串里的 FROM / 分号 / 方括号骗到。
   * 长度与原文严格一致，便于用位置换算。
   */
  function acCodeOnly(text) {
    const n = text.length;
    let out = '', i = 0;
    while (i < n) {
      const c = text[i], c2 = text.substr(i, 2);
      if (c2 === '--' || c === '#') {
        const j = text.indexOf('\n', i), e = j === -1 ? n : j;
        out += ' '.repeat(e - i); i = e; continue;
      }
      if (c2 === '/*') {
        const j = text.indexOf('*/', i + 2), e = j === -1 ? n : j + 2;
        out += ' '.repeat(e - i); i = e; continue;
      }
      if (c === "'") {
        let j = i + 1;
        while (j < n) { if (text[j] === "'") { if (text[j + 1] === "'") { j += 2; continue; } j++; break; } j++; }
        out += ' '.repeat(j - i); i = j; continue;
      }
      if (c === '[' || c === '`' || c === '"') {
        const close = c === '[' ? ']' : c;
        let j = i + 1;
        while (j < n) { if (text[j] === close) { j++; break; } j++; }
        out += text.slice(i, j); i = j; continue;
      }
      out += c; i++;
    }
    return out;
  }

  /** 光标所在的单条语句（按分号切分；字符串 / 注释里的分号已被抹掉，不会误切） */
  function acStatementRange(text, pos) {
    const code = acCodeOnly(text);
    let start = 0, end = text.length;
    for (let i = 0; i < code.length; i++) {
      if (code[i] !== ';') continue;
      if (i < pos) start = i + 1;
      else { end = i; break; }
    }
    return { start, end };
  }

  /**
   * 解析语句里被引用的表：FROM / JOIN / UPDATE / INTO，含逗号分隔的多表。
   * 返回 { tables: [表名], aliasMap: { 小写别名或表名 → 真实表名 } }。
   * 这是「列提示只给本语句用到的表」的关键。
   */
  function acScope(stmt) {
    const code = acCodeOnly(stmt);
    const tables = [], aliasMap = {};
    const one = '(' + AC_IDENT + '(?:\\s*\\.\\s*' + AC_IDENT + ')*)';
    const add = (raw, alias) => {
      const segs = String(raw).split('.').map(acUnquote).filter(Boolean);
      const name = segs[segs.length - 1];
      if (!name || /^(SELECT|VALUES|SET|ON|WHERE|TABLE|AS)$/i.test(name)) return;
      if (tables.indexOf(name) < 0) tables.push(name);
      aliasMap[name.toLowerCase()] = name;
      const al = alias ? acUnquote(alias) : '';
      if (al && !AC_RESERVED.test(al)) aliasMap[al.toLowerCase()] = name;
    };
    const re = new RegExp('\\b(?:FROM|JOIN|UPDATE|INTO)\\s+' + one + '(?:\\s+(?:AS\\s+)?(' + AC_IDENT + '))?', 'gi');
    let m;
    while ((m = re.exec(code))) {
      add(m[1], m[2]);
      // 逗号分隔的多表：FROM a, b, c
      let tail = code.slice(m.index + m[0].length);
      const more = new RegExp('^\\s*,\\s*' + one, 'i');
      let mm;
      while ((mm = more.exec(tail))) { add(mm[1], null); tail = tail.slice(mm[0].length); }
    }
    return { tables, aliasMap };
  }

  /** 计算光标在编辑区内的像素位置（借助高亮层镜像测量） */
  function acCaret() {
    const inner = document.querySelector('.code-inner');
    if (!inner) return { top: 0, left: 0 };
    const before = sqlEl.value.slice(0, sqlEl.selectionStart);
    hlEl.innerHTML = highlight(before) + '<span class="ac-mark"></span>';
    const mark = hlEl.querySelector('.ac-mark');
    let out = { top: 0, left: 0 };
    if (mark) {
      const a = mark.getBoundingClientRect(), b = inner.getBoundingClientRect();
      out = { top: a.top - b.top, left: a.left - b.left };
    }
    hlEl.innerHTML = highlight(sqlEl.value) + '\n';
    return out;
  }

  function acCompute(force) {
    const val = sqlEl.value;
    const pos = sqlEl.selectionStart;
    if (pos !== sqlEl.selectionEnd) return null;
    const before = val.slice(0, pos);
    const beforeCode = acCodeOnly(before);

    // 光标前的标识符片段。支持「未闭合」的 [ / ` / " 前缀：
    // SQL Server 用户习惯写 [fI，此时应当补成 [fID1]
    let word = '', quote = '';
    const qm = /([\[`"])([^\]`"]*)$/.exec(beforeCode);
    if (qm) { quote = qm[1]; word = qm[2]; }
    else { const wm = /([A-Za-z_][\w$]*)$/.exec(beforeCode); word = wm ? wm[1] : ''; }
    const cut = word.length + (quote ? 1 : 0);
    const head = beforeCode.slice(0, beforeCode.length - cut);

    // 是否紧跟 `x.`（表名或别名）
    const dotM = new RegExp('(' + AC_IDENT + ')\\s*\\.\\s*$').exec(head);
    const dot = dotM ? acUnquote(dotM[1]) : '';

    // 何时自动弹出：
    //  · 正在输入一个词
    //  · 刚打完「x.」→ 只提示该表的列
    //  · 刚在 FROM / JOIN / INTO / UPDATE / TABLE 之后敲了空格 → 只提示表名
    //  · 手动 Ctrl+Space → 提示候选
    let onlyTables = false;
    if (!word && !dot && !force) {
      if (!/(?:^|[\s(,])(?:FROM|JOIN|INTO|UPDATE|TABLE|DESC|DESCRIBE|TRUNCATE(?:\s+TABLE)?)\s+$/i.test(head)) return null;
      onlyTables = true;
    }

    const sc = acSchema();
    const rng = acStatementRange(val, pos);
    const scope = acScope(val.slice(rng.start, rng.end));
    const low = word.toLowerCase();
    const startsWith = s => String(s).toLowerCase().startsWith(low);

    let items = [], kind = '关键字 / 对象';

    if (dot) {
      // 「x.」：只给这张表的列。解析不到就什么都不给（宁可空，也不要拿别的表的列凑数）
      const owner = sc.colsByTable[dot] ? dot : (scope.aliasMap[dot.toLowerCase()] || '');
      const list = (owner && sc.colsByTable[owner]) || [];
      if (!list.length) return null;
      items = list.filter(startsWith).map(n => ({ text: n, type: 'column' }));
      kind = owner + ' 的列';
    } else if (onlyTables) {
      items = sc.tables.filter(startsWith).map(n => ({ text: n, type: 'table' }));
      kind = '表 / 视图';
    } else {
      // 语句里已经有 FROM / JOIN 时，列只从这些表里取 ——
      // 否则 WHERE 里会冒出库里任意一张表的列，非常干扰。
      const scopedCols = [];
      scope.tables.forEach(t => {
        (sc.colsByTable[t] || []).forEach(c => { if (scopedCols.indexOf(c) < 0) scopedCols.push(c); });
      });
      const fn = AC_FUNCS.filter(startsWith).map(n => ({ text: n, type: 'function' }));
      const kw = AC_KEYWORDS.filter(startsWith).map(n => ({ text: n, type: 'keyword' }));
      if (scopedCols.length) {
        items = scopedCols.filter(startsWith).map(n => ({ text: n, type: 'column' })).concat(fn, kw);
        kind = '本语句表列 · ' + scope.tables.slice(0, 3).join(', ') +
          (scope.tables.length > 3 ? ' 等 ' + scope.tables.length + ' 张表' : '');
      } else {
        // 还没有 FROM（比如刚写 SELECT）时，才放宽到全库对象
        const tb = sc.tables.filter(startsWith).map(n => ({ text: n, type: 'table' }));
        const cl = sc.allCols.filter(startsWith).map(n => ({ text: n, type: 'column' }));
        items = tb.concat(cl, fn, kw);
        kind = '关键字 / 对象';
      }
    }

    const seen = new Set();
    items = items.filter(x => {
      const k = x.type + ':' + x.text.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    // 完全一致且只有一个候选时不再打扰
    if (items.length === 1 && items[0].text.toLowerCase() === word.toLowerCase()) return null;
    if (!items.length) return null;
    return { items: items.slice(0, 40), word, quote, from: pos - cut, to: pos, kind };
  }

  function acRender(st) {
    const el = $('#ac');
    if (!el) return;
    acState = { items: st.items, idx: 0, from: st.from, to: st.to, quote: st.quote || '' };
    const tag = t => t === 'table' ? ['表', 't'] : t === 'column' ? ['列', 'c'] : t === 'function' ? ['函', 'f'] : ['K', 'k'];
    el.innerHTML = '<div class="ac-head">' + esc(st.kind) + ' · ' + st.items.length + ' 项（↑↓ 选择，Enter 补全）</div>' +
      st.items.map((it, i) => {
        const [ch, cls] = tag(it.type);
        return '<div class="ac-item' + (i === 0 ? ' sel' : '') + '" data-i="' + i + '">' +
          '<span class="ac-t ' + cls + '">' + ch + '</span>' +
          '<span class="ac-n">' + esc(it.text) + '</span>' +
          '<span class="ac-dim">' + esc(it.type === 'table' ? '表' : it.type === 'column' ? '列' : it.type === 'function' ? '函数' : '关键字') + '</span>' +
          '</div>';
      }).join('');
    const p = acCaret();
    const lineH = 19;
    const boxH = Math.min(232, 26 + st.items.length * 21);
    const maxTop = codeScroll.scrollTop + codeScroll.clientHeight - boxH - 4;
    const top = (p.top + lineH + 2 <= maxTop) ? p.top + lineH + 2 : Math.max(codeScroll.scrollTop, p.top - boxH - 2);
    el.style.left = Math.max(0, Math.min(p.left, codeScroll.clientWidth - 220)) + 'px';
    el.style.top = Math.max(codeScroll.scrollTop, top) + 'px';
    el.classList.add('show');
    const sel = el.querySelector('.ac-item.sel');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  function acMove(delta) {
    if (!acState) return;
    const n = acState.items.length;
    acState.idx = (acState.idx + delta + n) % n;
    const el = $('#ac');
    el.querySelectorAll('.ac-item').forEach((x, i) => x.classList.toggle('sel', i === acState.idx));
    const sel = el.querySelector('.ac-item.sel');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  function acAccept() {
    if (!acState) return;
    const it = acState.items[acState.idx];
    if (!it) { acClose(); return; }
    const val = sqlEl.value;
    const head = val.slice(0, acState.from);
    const tail = val.slice(acState.to);
    // 关键字统一大写；标识符保持原样（可能区分大小写）
    let text = it.type === 'keyword' ? it.text.toUpperCase() : it.text;
    // 用户敲了未闭合的 [ / ` / " → 补全时把引号补全（[fI → [fID1]）
    const q = acState.quote;
    if (q) text = q + text + (q === '[' ? ']' : q);
    sqlEl.value = head + text + tail;
    const caret = head.length + text.length;
    sqlEl.setSelectionRange(caret, caret);
    acClose();
    const d = doc(); if (d) { d.dirty = true; renderDocs(); }
    updateEditor();
  }

  function acTrigger(force) {
    clearTimeout(acTimer);
    if (!doc()) return;
    acTimer = setTimeout(() => {
      const st = acCompute(force);
      if (!st) acClose(); else acRender(st);
    }, force ? 0 : 90);
  }

  // 鼠标点选补全项
  $('#ac').addEventListener('mousedown', e => {
    const it = e.target.closest('.ac-item');
    if (!it || !acState) return;
    e.preventDefault();
    acState.idx = +it.dataset.i;
    acAccept();
  });
  $('#ac').addEventListener('mouseover', e => {
    const it = e.target.closest('.ac-item');
    if (!it || !acState) return;
    acState.idx = +it.dataset.i;
    $('#ac').querySelectorAll('.ac-item').forEach((x, i) => x.classList.toggle('sel', i === acState.idx));
  });

  /* ==========================================================
   * 9. 查询执行
   * ========================================================== */
  /**
   * 远程连接执行 SQL 时必须显式带上当前库。
   * 服务端会话的默认库（连接时填的那个）与界面上显示的当前库可能不同 ——
   * 用户在界面上切库只改了前端状态，不带库名就会打到旧库上，
   * 表现为「表明明在树里，执行却报 Invalid object name」。
   */
  function currentDbArg(c) {
    return (c && c.engineKind === 'remote' && c.engine.currentDatabase) ? c.engine.currentDatabase : undefined;
  }

  async function execSql(sql, opts) {
    const e = eng();
    if (!e) { toast('请先建立并选择一个连接', true); return null; }
    const t0 = performance.now();
    try {
      const dbArg = (opts && opts.database) || currentDbArg(conn());
      const r = await e.exec(sql, dbArg);
      r.ms = Math.round(performance.now() - t0);
      return r;
    } catch (err) {
      return { error: err && err.message ? err.message : String(err), ms: Math.round(performance.now() - t0) };
    }
  }

  /**
   * 取出「这次要执行的 SQL」。
   * SSMS 的行为：编辑器里有非空选区时只执行选区，没有选区才执行整篇 ——
   * 调试长脚本时不必把不想要的语句删掉，选一段按 F5 即可。
   * 返回 { sql, selection, lines }，selection 为 true 表示这次只跑了选区。
   */
  function currentSql() {
    const full = sqlEl.value;
    const a = sqlEl.selectionStart, b = sqlEl.selectionEnd;
    if (b > a) {
      const picked = full.slice(a, b);
      if (picked.trim()) {
        return { sql: picked.trim(), selection: true, lines: picked.split('\n').length };
      }
    }
    return { sql: full.trim(), selection: false, lines: full.split('\n').length };
  }

  async function runQuery() {
    const d = doc();
    if (!d) { toast('没有活动的查询窗口', true); return; }
    if (!eng()) { toast('请先在左侧选择一个连接', true); return; }
    d.sql = sqlEl.value;                 // 文档内容始终是整篇
    const cur = currentSql();
    const sql = cur.sql;                 // 实际执行的是选区或整篇
    if (!sql) { toast('请输入 SQL 语句', true); return; }

    const bar = $('#progBar');
    bar.style.width = '0%';
    requestAnimationFrame(() => { bar.style.width = '60%'; });
    status(cur.selection ? '正在执行选中部分…' : '正在执行…');

    const r = await execSql(sql);
    bar.style.width = '100%';
    setTimeout(() => { bar.style.width = '0%'; }, 200);

    if (!r || r.error) {
      d.result = null;
      d.message = '<span class="err">✗ 执行失败</span>' +
        (cur.selection ? '\n<span class="dim">（只执行了选中的 ' + cur.lines + ' 行）</span>' : '') +
        '\n\n<span class="err">' + esc((r && r.error) || '未知错误') + '</span>';
      d.activeRes = 'msg';
      renderResult();
      status('执行失败');
      toast('SQL 执行失败', true);
      return;
    }

    const sets = r.sets || [];
    if (sets.length) {
      const set = sets[sets.length - 1];
      d.result = { columns: set.columns, values: set.values };
      d.connId = state.activeConnId;   // 结果与产生它的连接绑定
      d.editTable = null; d.editCols = null; d.rowKeys = null; d.editKeyType = null;
      d.editNote = ''; d.editKeyCols = null;
      // 只跑选区时不要消费 pendingEdit —— 那是「双击表打开」的流程，与选区无关
      const pe = cur.selection ? null : d.pendingEdit;
      if (pe && pe.rowid && set.columns[0] === '__rid') {
        // SQLite：用隐藏的 rowid 列精确定位行
        d.editTable = pe.table; d.editDb = pe.database; d.editKeyType = 'rowid';
        d.rowKeys = set.values.map(v => ({ rowid: v[0] }));
        d.result = { columns: set.columns.slice(1), values: set.values.map(v => v.slice(1)) };
        d.editCols = d.result.columns;
      } else if (pe && pe.pkCols && pe.pkCols.length) {
        // 远程库：用主键列定位行
        const idx = pe.pkCols.map(c => set.columns.indexOf(c));
        if (idx.every(i => i >= 0)) {
          d.editTable = pe.table; d.editDb = pe.database; d.editKeyType = 'pk';
          d.editKeyCols = pe.pkCols;
          d.rowKeys = set.values.map(v => {
            const k = {};
            pe.pkCols.forEach((c, n) => { k[c] = v[idx[n]]; });
            return k;
          });
          d.editCols = set.columns;
          d.editNote = '';
        }
      } else if (pe && pe.allCols && pe.allCols.length) {
        // 无主键表：按全部列的原值定位行（SSMS 对无主键表也是这么做的）
        const idx = pe.allCols.map(c => set.columns.indexOf(c));
        if (idx.every(i => i >= 0)) {
          d.editTable = pe.table; d.editDb = pe.database; d.editKeyType = 'cols';
          d.editKeyCols = pe.allCols.slice();
          d.rowKeys = set.values.map(v => {
            const k = {};
            pe.allCols.forEach((c, n) => { k[c] = v[idx[n]]; });
            return k;
          });
          d.editCols = set.columns;
          d.editNote = '无主键，按全部列原值匹配';
        }
      }
      d.pendingEdit = null;
      d.message =
        '<span class="ok">✓ 查询成功</span>' +
        (cur.selection ? '\n<span class="dim">（只执行了选中的 ' + cur.lines + ' 行，其余未执行）</span>' : '') +
        '\n\n' +
        '<b>(' + d.result.values.length + ' 行返回)</b>\n' +
        '<span class="dim">结果集 ' + sets.length + ' 个  ·  用时 ' + r.ms + ' ms</span>';
      d.activeRes = 'grid';
      status(cur.selection ? '查询成功（选区）' : '查询成功');
    } else {
      d.result = null;
      d.message =
        '<span class="ok">✓ 命令已成功完成</span>' +
        (cur.selection ? '\n<span class="dim">（只执行了选中的 ' + cur.lines + ' 行，其余未执行）</span>' : '') +
        '\n\n' +
        '<b>(' + (r.rowsAffected || 0) + ' 行受影响)</b>\n' +
        '<span class="dim">用时 ' + r.ms + ' ms</span>';
      d.activeRes = 'msg';
      status(cur.selection ? '命令已成功完成（选区）' : '命令已成功完成');
      // 结构可能变化
      await doRefresh(true);
    }
    renderResult();
  }

  async function explainQuery() {
    const d = doc();
    if (!d || !eng()) return;
    d.sql = sqlEl.value;
    const isDuck = conn().engineKind === 'duckdb';
    const cur = currentSql();
    if (!cur.sql) { toast('请输入 SQL 语句', true); return; }
    const sql = (isDuck ? 'EXPLAIN ' : 'EXPLAIN QUERY PLAN ') + cur.sql;
    const r = await execSql(sql);
    if (!r || r.error) {
      d.result = null;
      d.message = '<span class="err">✗ 无法生成执行计划</span>\n\n<span class="err">' + esc((r && r.error) || '') + '</span>';
    } else if (r.sets && r.sets.length) {
      const set = r.sets[r.sets.length - 1];
      d.result = { columns: set.columns, values: set.values };
      d.message = '<span class="ok">✓ 执行计划已生成</span>\n<span class="dim">引擎：' + (isDuck ? 'DuckDB EXPLAIN' : 'SQLite EXPLAIN QUERY PLAN') + '</span>';
    } else {
      d.result = null;
      d.message = '<span class="warn">引擎未返回执行计划</span>';
    }
    d.activeRes = 'grid';
    d.editTable = null; d.editCols = null; d.rowids = null;
    renderResult();
    status('执行计划');
  }

  async function openTableQuery(name, opts) {
    opts = opts || {};
    const c = conn();
    if (!c) { toast('请先选择一个连接', true); return; }
    const isView = !!opts.isView;
    const db = opts.database || (c.engineKind === 'remote' ? c.engine.currentDatabase : null);
    // 跨库打开表时把连接的当前库切过去，让工具栏、树高亮、执行库三者保持一致
    if (c.engineKind === 'remote' && db && c.engine.currentDatabase !== db) {
      c.engine.setDatabase(db);
      if (c.schema) c.schema.database = db;
      updateStatus(); updateDbSwitcher();
    }
    const dialect = dialectOf(c);
    const q = n => S.quoteIdentFor(n, dialect);

    let tbl = findTable(name, db);
    let cols = tbl && tbl.columns;
    if (!cols && c.engine.columns) {
      try { cols = await c.engine.columns(db, name); if (tbl) tbl.columns = cols; }
      catch (e) { cols = null; }
    }

    const useRowid = !isView && c.engineKind === 'sqlite' && tbl && tbl.hasRowid !== false;
    const head = dialect === 'mssql' ? 'SELECT TOP 1000 ' : 'SELECT ';
    const tail = dialect === 'mssql' ? ';' : ' LIMIT 1000;';
    const sql = useRowid
      ? 'SELECT rowid AS __rid, * FROM ' + q(name) + ' LIMIT 1000;'
      : head + '* FROM ' + q(name) + tail;

    const d = newDoc(sql, name + '.sql');
    d.isView = isView;
    // 行定位策略（优先级）：rowid → 主键 → 全部列原值
    // 无主键的表在真实业务库里非常常见（尤其 ERP），只认主键会导致「整张表都改不了」，
    // 所以退化成按全部列的原值拼 WHERE，与 SSMS 编辑无主键表的行为一致。
    const pkCols = (!useRowid && !isView && cols) ? cols.filter(x => x.pk).map(x => x.name) : [];
    const allCols = (!useRowid && !isView && cols && !pkCols.length) ? cols.map(x => x.name) : [];
    d.pendingEdit = {
      table: name, database: db, rowid: useRowid, pkCols, allCols
    };
    setTimeout(runQuery, 60);
  }

  function dialectOf(c) {
    if (!c) return 'sqlite';
    if (c.engineKind === 'remote') return c.engine.dialect || 'mysql';
    if (c.engineKind === 'duckdb') return 'duckdb';
    return 'sqlite';
  }

  function findTable(name, db) {
    const c = conn();
    if (!c) return null;
    if (db && c.schemas && c.schemas[db]) {
      const t = (c.schemas[db].tables || []).find(x => x.name === name);
      if (t) return t;
    }
    if (c.schema && c.schema.tables) {
      const t = c.schema.tables.find(x => x.name === name);
      if (t) return t;
    }
    if (c.schemas) {
      for (const s of Object.values(c.schemas)) {
        const t = (s.tables || []).find(x => x.name === name);
        if (t) return t;
      }
    }
    return null;
  }

  /* ==========================================================
   * 10. 结果网格
   * ========================================================== */
  let sortState = { col: -1, dir: 1 };

  function switchRes(which) {
    const d = doc(); if (d) d.activeRes = which;
    $$('.res-tab').forEach(t => t.classList.toggle('active', t.dataset.res === which));
    renderResult();
  }
  $$('.res-tab').forEach(t => t.addEventListener('click', () => switchRes(t.dataset.res)));

  function renderResult() {
    const body = $('#resBody');
    const d = doc();
    body.innerHTML = '';
    if (!d) {
      $('#rowCnt').style.display = 'none';
      updateRowActions(null);
      body.innerHTML = '<div class="empty-state">' + bigGridIcon() + '<div>没有活动的查询窗口</div><div style="font-size:11px">按 <span class="k">Ctrl+N</span> 新建查询</div></div>';
      return;
    }
    $$('.res-tab').forEach(t => t.classList.toggle('active', t.dataset.res === d.activeRes));

    if (d.activeRes === 'msg') {
      $('#rowCnt').style.display = 'none';
      updateRowActions(null);
      body.innerHTML = '<div class="messages">' + (d.message || '<span class="dim">尚无消息。</span>') + '</div>';
      return;
    }
    if (!d.result) {
      $('#rowCnt').style.display = 'none';
      updateRowActions(null);
      body.innerHTML = '<div class="empty-state">' + bigGridIcon() +
        '<div>尚无查询结果</div><div style="font-size:11px">按 <span class="k">F5</span> 执行当前 SQL</div></div>';
      return;
    }
    // 结果来自另一个连接时给出明确提示，避免误读
    if (d.connId && d.connId !== state.activeConnId) {
      $('#rowCnt').style.display = 'none';
      updateRowActions(null);
      const other = state.conns.find(x => x.id === d.connId);
      const cur = conn();
      body.innerHTML = '<div class="empty-state">' + bigGridIcon() +
        '<div>该结果来自连接「' + esc(other ? other.name : '已关闭的连接') + '」</div>' +
        '<div style="font-size:11px">当前连接为「' + esc(cur ? cur.name : '未连接') +
        '」，按 <span class="k">F5</span> 在目标连接上重新执行</div></div>';
      return;
    }
    $('#rowCnt').style.display = '';
    $('#rowCnt').textContent = d.result.values.length;
    updateRowActions(d);

    const cols = d.result.columns;
    const table = findTable(d.editTable || '', d.editDb);
    const colMeta = table ? table.columns : [];

    const tbl = document.createElement('table');
    tbl.className = 'grid';
    const thead = document.createElement('thead');
    let htr = '<tr><th class="th-rowno"><div class="th-in">#</div></th>';
    cols.forEach((c, ci) => {
      const meta = colMeta.find(m => m.name === c);
      const sorted = sortState.col === ci ? (sortState.dir > 0 ? '▲' : '▼') : '';
      htr += '<th data-col="' + ci + '"><div class="th-in">' + esc(c) +
        (meta ? '<span class="pk">' + (meta.pk ? 'PK ' : '') + '</span><span class="col-type">' + esc(meta.type) + '</span>' : '') +
        '<span class="sort">' + sorted + '</span></div></th>';
    });
    htr += '</tr>';
    thead.innerHTML = htr;
    tbl.appendChild(thead);

    const tbody = document.createElement('tbody');
    let order = d.result.values.map((v, i) => ({ v, i }));
    if (sortState.col >= 0) {
      const ci = sortState.col, dir = sortState.dir;
      order.sort((a, b) => {
        const x = a.v[ci], y = b.v[ci];
        if (x === y) return a.i - b.i;
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
        return String(x).localeCompare(String(y), 'zh') * dir;
      });
    }

    order.forEach(({ v, i }) => {
      const tr = document.createElement('tr');
      const rn = document.createElement('td');
      rn.className = 'rowno';
      rn.textContent = '';
      tr.appendChild(rn);
      v.forEach((val, ci) => {
        const td = document.createElement('td');
        td.dataset.col = ci;
        td.dataset.row = i;
        if (val === null || val === undefined) { td.className = 'null'; td.textContent = 'NULL'; }
        else if (typeof val === 'number') { td.className = 'num'; td.textContent = Number.isInteger(val) ? val.toLocaleString() : String(val); }
        else if (val instanceof Uint8Array) { td.className = 'blob'; td.textContent = 'BLOB (' + val.length + ' 字节)'; }
        else { td.textContent = String(val); }
        // 只要是「从表打开」的结果集就可编辑；列元信息（PK/类型）缺失不影响编辑，
        // 否则 schema 缓存一旦丢失，整张表就变成不可编辑且没有任何提示。
        if (d.editTable && !d.isView) {
          td.classList.add('editable');
          td.title = '双击编辑（右键可新增/删除行）';
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    body.appendChild(tbl);
    Array.from(tbody.children).forEach((tr, idx) => { tr.firstChild.textContent = idx + 1; });

    thead.querySelectorAll('th[data-col]').forEach(th => th.addEventListener('click', () => {
      const ci = +th.dataset.col;
      if (sortState.col === ci) sortState.dir *= -1; else { sortState.col = ci; sortState.dir = 1; }
      renderResult();
    }));
    // 行选择：单击单选，Ctrl/Cmd 加选，Shift 连选
    let lastTr = null;
    tbody.addEventListener('click', e => {
      const tr = e.target.closest('tr'); if (!tr) return;
      const all = Array.from(tbody.querySelectorAll('tr'));
      if ((e.ctrlKey || e.metaKey)) {
        tr.classList.toggle('selected');
      } else if (e.shiftKey && lastTr && all.indexOf(lastTr) >= 0) {
        const a = all.indexOf(lastTr), b = all.indexOf(tr);
        tbody.querySelectorAll('tr.selected').forEach(x => x.classList.remove('selected'));
        all.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(x => x.classList.add('selected'));
      } else {
        tbody.querySelectorAll('tr.selected').forEach(x => x.classList.remove('selected'));
        tr.classList.add('selected');
      }
      lastTr = tr;
    });
    if (d.editTable && !d.isView) {
      tbody.addEventListener('dblclick', e => {
        const td = e.target.closest('td.editable');
        if (td) startEdit(td, d, cols[+td.dataset.col], +td.dataset.row);
      });
      // 结果网格右键：新增行 / 删除行 / 复制
      tbody.addEventListener('contextmenu', e => {
        e.preventDefault();
        const tr = e.target.closest('tr');
        if (tr) {
          tbody.querySelectorAll('tr.selected').forEach(x => x.classList.remove('selected'));
          tr.classList.add('selected');
        }
        const sel = tbody.querySelectorAll('tr.selected').length;
        showMenu(e.clientX, e.clientY,
          '<div class="c-title">' + esc(d.editTable) + '</div>' +
          mi('table', '新增行…', 'row-add') +
          mi('folder', '删除选中行' + (sel ? '（' + sel + '）' : ''), 'row-del', '', !sel) +
          '<div class="c-sep"></div>' +
          mi('query', '复制选中行（制表符分隔）', 'row-copy', '', !sel));
      });
    }
  }

  function bigGridIcon() {
    return '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1"/><path d="M2 6h12M6 6v7M10 6v7" stroke="currentColor" stroke-width="1"/></svg>';
  }

  /**
   * 拼出定位某一行的 WHERE 子句。
   * - rowid ：SQLite 的隐藏行号，最精确
   * - pk    ：主键列
   * - cols  ：无主键表，用全部列的原值匹配；NULL 列用 IS NULL（不能用 = NULL）
   */
  function rowWhere(d, rowIdx, q) {
    if (d.editKeyType === 'rowid') {
      const rk = d.rowKeys[rowIdx] || {};
      return { where: 'rowid = ?', params: [rk.rowid] };
    }
    const key = d.rowKeys[rowIdx] || {};
    const parts = [], params = [];
    (d.editKeyCols || []).forEach(k => {
      const v = key[k];
      if (v === null || v === undefined) parts.push(q(k) + ' IS NULL');
      else { parts.push(q(k) + ' = ?'); params.push(v); }
    });
    if (!parts.length) throw new Error('无法定位该行（缺少行标识）');
    return { where: parts.join(' AND '), params };
  }

  function startEdit(td, d, colName, rowIdx) {
    if (td.querySelector('input')) return;
    const old = td.classList.contains('null') ? null : td.textContent;
    td.classList.add('editing');
    const inp = document.createElement('input');
    inp.value = old === null ? '' : old;
    inp.spellcheck = false;
    td.textContent = '';
    td.appendChild(inp);
    inp.focus();
    inp.select();

    let done = false;
    const finish = async (commit) => {
      if (done) return; done = true;
      const nv = inp.value;
      td.classList.remove('editing');
      if (!commit || nv === (old === null ? '' : String(old))) { renderResult(); return; }
      const c = conn();
      if (!c) { toast('连接已失效', true); return; }
      const q = n => S.quoteIdentFor(n, dialectOf(c));
      const e = eng();
      if (!e) { toast('连接已失效', true); return; }
      const val = nv === '' ? null : nv;
      try {
        const w = rowWhere(d, rowIdx, q);
        const sql = 'UPDATE ' + q(d.editTable) + ' SET ' + q(colName) + ' = ? WHERE ' + w.where;
        const res = await e.run(sql, [val].concat(w.params), d.editDb || currentDbArg(c) || null);
        // 0 行受影响：行定位条件没匹配到任何行（行已被删除 / 改动，或按全部列原值匹配时
        // BLOB、日期精度、浮点数等原值无法精确比较）。此时不能假装成功改掉本地单元格。
        if (!res || !(res.rowsAffected > 0)) {
          toast('更新失败：没有行被修改（该行可能已被删除或修改，或无法按原值精确定位），已恢复原值', true);
          renderResult();
          return;
        }
        const cur = doc();
        if (cur && cur.result) {
          const ci = cur.result.columns.indexOf(colName);
          if (ci >= 0) cur.result.values[rowIdx][ci] = val;
        }
        if (d.editKeyType === 'cols' && res && res.rowsAffected > 1) {
          toast('已更新 ' + res.rowsAffected + ' 行：该表无主键，存在完全重复的行，全部被一并修改', true);
          await reloadTableData(d);
        } else {
          toast('已更新 ' + d.editTable + '.' + colName);
        }
        await persistConn(c);
        renderResult();
      } catch (err) {
        toast('更新失败：' + (err && err.message ? err.message : err), true);
        renderResult();
      }
    };
    inp.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    });
    inp.addEventListener('blur', () => finish(true));
  }

  /* ----------------------------------------------------------
   * 增 / 删：结果网格的写操作
   * -------------------------------------------------------- */
  /** 重新执行打开这张表时用的查询，刷新网格与行定位信息 */
  async function reloadTableData(d) {
    if (!d || !d.editTable) return;
    d.pendingEdit = {
      table: d.editTable, database: d.editDb,
      rowid: d.editKeyType === 'rowid',
      pkCols: d.editKeyType === 'pk' ? (d.editKeyCols || []) : [],
      allCols: d.editKeyType === 'cols' ? (d.editKeyCols || []) : []
    };
    await runQuery();
  }

  /** 取出表结构（列定义），用于新增行表单 */
  async function tableColumnsFor(d, c) {
    const tbl = findTable(d.editTable, d.editDb);
    let cols = (tbl && tbl.columns) || [];
    if (!cols.length && c.engine.columns) {
      try { cols = await c.engine.columns(d.editDb || null, d.editTable); if (tbl) tbl.columns = cols; }
      catch (e) { cols = []; }
    }
    return cols;
  }

  /** 新增一行：按列生成表单 → 参数化 INSERT */
  async function addRowDialog() {
    const d = doc();
    const c = conn();
    if (!d || !d.editTable || !c) { toast('请先双击一张表打开数据', true); return; }
    if (d.isView) { toast('视图不能直接插入数据', true); return; }
    const cols = await tableColumnsFor(d, c);
    if (!cols.length) { toast('无法获取表结构，不能新增行', true); return; }
    const q = n => S.quoteIdentFor(n, dialectOf(c));
    const ddl = (findTable(d.editTable, d.editDb) || {}).ddl || '';

    const rows = cols.map(col => {
      const auto = col.auto === true ||
        /auto_increment|identity|serial/i.test(String(col.type || '')) ||
        new RegExp('\\b' + String(col.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b[^,)]*AUTOINCREMENT', 'i').test(ddl);
      const tags = (col.pk ? '<span class="tag pk-tag">PK</span>' : '') +
        (auto ? '<span class="tag auto-tag">自增</span>' : '') +
        (col.notnull ? '<span class="tag">必填</span>' : '');
      const ph = auto ? '留空自动生成'
        : (col.dflt !== null && col.dflt !== undefined ? '默认 ' + String(col.dflt).slice(0, 22)
          : (col.notnull ? '必填' : 'NULL'));
      return '<div class="add-row" data-col="' + esc(col.name) + '">' +
        '<label title="' + esc(col.name) + '">' + esc(col.name) + '</label>' +
        '<input type="text" class="add-val" spellcheck="false" placeholder="' + esc(ph) + '">' +
        '<label class="add-null" title="勾选后写入 NULL"><input type="checkbox" class="add-isnull">NULL</label>' +
        '<span class="add-meta">' + tags + '<span class="col-type">' + esc(String(col.type || '')) + '</span></span>' +
        '</div>';
    }).join('');

    const m = openModal('向 ' + esc(d.editTable) + ' 新增一行',
      '<div class="add-form">' + rows + '</div>' +
      '<div class="add-note">' +
      '留空且勾选 <b>NULL</b> → 写入 NULL；留空但未勾选 → 交给数据库默认值（自增列请留空）。' +
      (d.editKeyType === 'cols' ? '<br>该表<b>没有主键</b>，插入后按全部列原值定位行。' : '') +
      '</div>',
      '<button class="btn primary" data-ok>插入</button><button class="btn" data-cancel>取消</button>',
      async (mm) => {
        const names = [], ph = [], params = [];
        let bad = null;
        mm.querySelectorAll('.add-row').forEach(r => {
          const name = r.dataset.col;
          const isnull = r.querySelector('.add-isnull').checked;
          const raw = r.querySelector('.add-val').value;
          const meta = cols.find(x => x.name === name) || {};
          if (isnull) {
            if (meta.notnull) { bad = name + ' 是必填列，不能为 NULL'; return; }
            names.push(name); ph.push('?'); params.push(null); return;
          }
          if (raw === '') return;             // 交给数据库默认值
          names.push(name); ph.push('?'); params.push(raw);
        });
        if (bad) { toast(bad, true); return true; }   // 保持对话框
        if (!names.length) { toast('至少需要填写一列', true); return true; }
        busy(true, '插入中…');
        try {
          const sql = 'INSERT INTO ' + q(d.editTable) +
            ' (' + names.map(q).join(', ') + ') VALUES (' + ph.join(', ') + ')';
          const r = await eng().run(sql, params, d.editDb || currentDbArg(c) || null);
          toast('已插入 ' + ((r && r.rowsAffected) || 1) + ' 行');
          busy(false);
          await reloadTableData(d);
          return false;                        // 关闭对话框
        } catch (e) {
          busy(false);
          toast('插入失败：' + (e && e.message ? e.message : e), true);
          return true;                         // 保持对话框，方便改
        }
      }, true);
    const first = m.querySelector('.add-val');
    if (first) setTimeout(() => first.focus(), 60);
  }

  /** 删除结果网格中选中的行 */
  async function deleteSelectedRows() {
    const d = doc();
    const c = conn();
    if (!d || !d.editTable || !c) { toast('请先双击一张表打开数据', true); return; }
    const tbody = document.querySelector('#resBody table.grid tbody');
    if (!tbody) { toast('没有可删除的数据', true); return; }
    const trs = Array.from(tbody.querySelectorAll('tr.selected'));
    if (!trs.length) { toast('请先选中要删除的行（Ctrl / Shift 可多选）', true); return; }
    const idxs = trs.map(tr => {
      const td = tr.querySelector('td[data-row]');
      return td ? +td.dataset.row : -1;
    }).filter(i => i >= 0);
    if (!idxs.length) { toast('未取到行标识，无法删除', true); return; }
    const q = n => S.quoteIdentFor(n, dialectOf(c));
    const extra = d.editKeyType === 'cols'
      ? '<br><span style="color:var(--amber)">该表没有主键，按全部列原值匹配：若存在完全重复的行，会被一并删除。</span>' : '';
    await confirmThen('删除行',
      '将从 <b>' + esc(d.editTable) + '</b> 删除 <b>' + idxs.length + '</b> 行，该操作不可撤销。' + extra,
      async () => {
        let n = 0;
        for (const i of idxs) {
          const w = rowWhere(d, i, q);
          const r = await eng().run('DELETE FROM ' + q(d.editTable) + ' WHERE ' + w.where,
            w.params, d.editDb || currentDbArg(c) || null);
          n += (r && r.rowsAffected) || 0;
        }
        toast('已删除 ' + n + ' 行');
        await persistConn(c);
        await reloadTableData(d);
      }, true);
  }

  /** 结果面板上的编辑态提示与「增/删」按钮显隐 */
  function updateRowActions(d) {
    const add = $('#btnRowAdd'), del = $('#btnRowDel'), hint = $('#editHint');
    if (!add || !del || !hint) return;
    const editable = !!(d && d.editTable && d.result && !d.isView);
    add.style.display = editable ? '' : 'none';
    del.style.display = editable ? '' : 'none';
    if (!editable) { hint.style.display = 'none'; hint.textContent = ''; return; }
    hint.style.display = '';
    hint.innerHTML = '✎ 可编辑 <b>' + esc(d.editTable) + '</b>' +
      (d.editNote ? ' <span class="warn">· ' + esc(d.editNote) + '</span>' : ' · 双击单元格修改');
    hint.title = d.editKeyType === 'rowid' ? '使用 SQLite rowid 精确定位行'
      : d.editKeyType === 'pk' ? '使用主键定位行'
        : '该表没有主键：按全部列的原值定位行，存在完全重复的行时会同时被修改';
  }

  /** 复制选中的行（制表符分隔，可直接粘进 Excel） */
  function copySelectedRows() {
    const d = doc();
    const tbody = document.querySelector('#resBody table.grid tbody');
    if (!tbody || !d || !d.result) { toast('没有可复制的数据', true); return; }
    const trs = Array.from(tbody.querySelectorAll('tr.selected'));
    if (!trs.length) { toast('请先选中要复制的行', true); return; }
    const lines = trs.map(tr => Array.from(tr.querySelectorAll('td')).slice(1)
      .map(td => td.classList.contains('null') ? '' : td.textContent).join('\t'));
    copyText(lines.join('\n'));
    toast('已复制 ' + lines.length + ' 行');
  }

  $('#btnRowAdd').addEventListener('click', () => addRowDialog());
  $('#btnRowDel').addEventListener('click', () => deleteSelectedRows());

  /* 结果导出 */
  function resultToCsv(d) {
    const q = s => {
      s = s === null || s === undefined ? '' : String(s);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [d.result.columns.map(q).join(',')];
    d.result.values.forEach(r => lines.push(r.map(q).join(',')));
    return lines.join('\r\n');
  }
  function download(name, content, mime) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }
  $('#btnResCsv').addEventListener('click', () => {
    const d = doc();
    if (!d || !d.result) { toast('没有可导出的结果', true); return; }
    download('result.csv', '\ufeff' + resultToCsv(d), 'text/csv;charset=utf-8');
    toast('已导出 CSV');
  });
  $('#btnResJson').addEventListener('click', () => {
    const d = doc();
    if (!d || !d.result) { toast('没有可导出的结果', true); return; }
    const arr = d.result.values.map(r => {
      const o = {};
      d.result.columns.forEach((c, i) => o[c] = r[i]);
      return o;
    });
    download('result.json', JSON.stringify(arr, null, 2), 'application/json');
    toast('已导出 JSON');
  });
  $('#btnResCopy').addEventListener('click', () => {
    const d = doc();
    if (!d || !d.result) { toast('没有可复制的结果', true); return; }
    copyText(resultToCsv(d));
    toast('已复制结果到剪贴板');
  });

  /* ==========================================================
   * 11. 导入 / 导出
   * ========================================================== */
  function pickFile(accept, cb) {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.addEventListener('change', () => { if (inp.files && inp.files[0]) cb(inp.files[0]); });
    inp.click();
  }
  function readFile(file, asText) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => rej(fr.error);
      if (asText) fr.readAsText(file, 'utf-8');
      else fr.readAsArrayBuffer(file);
    });
  }

  async function exportDb() {
    const c = conn();
    if (!c) { toast('请先选择连接', true); return; }
    try {
      const bytes = await c.engine.exportBinary();
      download(c.name.replace(/[^\w\u4e00-\u9fa5.-]+/g, '_') + '.db', new Blob([bytes], { type: 'application/octet-stream' }));
      toast('已导出数据库文件');
    } catch (e) { toast('导出失败：' + e.message, true); }
  }

  async function exportTableCsv(name, db) {
    const r = await execSql('SELECT * FROM ' + qid(name) + ';', db ? { database: db } : undefined);
    if (!r || r.error) { toast('导出失败：' + ((r && r.error) || ''), true); return; }
    if (!r.sets.length) { toast('表为空', true); return; }
    const set = r.sets[r.sets.length - 1];
    const q = s => { s = s === null || s === undefined ? '' : String(s); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [set.columns.map(q).join(',')];
    set.values.forEach(row => lines.push(row.map(q).join(',')));
    download(name + '.csv', '\ufeff' + lines.join('\r\n'), 'text/csv;charset=utf-8');
    toast('已导出 ' + name + '.csv');
  }

  function parseCsv(text) {
    text = text.replace(/^\ufeff/, '');
    const rows = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += ch;
      } else {
        if (ch === '"') inQ = true;
        else if (ch === ',') { row.push(field); field = ''; }
        else if (ch === '\r') { /* skip */ }
        else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else field += ch;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  async function importCsvToTable(file, tableName, db) {
    const text = await readFile(file, true);
    const rows = parseCsv(text).filter(r => r.length && !(r.length === 1 && r[0] === ''));
    if (!rows.length) { toast('CSV 为空', true); return; }
    const header = rows[0], data = rows.slice(1);
    const e = eng();
    if (!e) { toast('请先选择连接', true); return; }
    const c0 = conn();
    const tbl = findTable(tableName, db);
    // 远程表的列是懒加载的，未展开过时 tbl.columns 为空，需要先读取
    let colInfo = tbl && tbl.columns;
    if (!colInfo && e.columns) {
      try { colInfo = await e.columns(db, tableName); if (tbl) tbl.columns = colInfo; }
      catch (err) { colInfo = null; }
    }
    const tableCols = colInfo ? colInfo.map(x => x.name) : [];
    if (!tableCols.length) { toast('无法读取表 ' + tableName + ' 的列信息', true); return; }
    const cols = header.map(h => h.trim()).filter(Boolean);
    const useCols = cols.length && cols.every(c => tableCols.includes(c)) ? cols : tableCols;

    await confirmThen('导入 CSV 到 ' + tableName,
      '共 <b>' + data.length + '</b> 行数据，将使用列：<br><span style="font-family:var(--font-mono);font-size:11px">' + esc(useCols.join(', ')) + '</span><br><br>数据将追加到现有表中。',
      async () => {
        const ph = useCols.map(() => '?').join(', ');
        const sql = 'INSERT INTO ' + qid(tableName, c0) + ' (' + useCols.map(x => qid(x, c0)).join(', ') + ') VALUES (' + ph + ')';
        const idxs = useCols.map(c => cols.indexOf(c));
        let ok = 0, fail = 0, firstErr = '';
        // 只有浏览器内 SQLite（有 e.db）才包一层本地事务；远程引擎每条语句独立执行
        const localTx = !!(e.db && e.db.run);
        busy(true, '正在导入…', '0 / ' + data.length);
        try {
          if (localTx) e.db.run('BEGIN');
          for (let i = 0; i < data.length; i++) {
            const vals = idxs.map(ix => {
              const v = ix >= 0 ? data[i][ix] : null;
              return v === '' || v === undefined ? null : v;
            });
            // 必须 await：远程引擎的 run 是异步的，不等待会并发发出全部请求且错误无法捕获
            try { await e.run(sql, vals, db || null); ok++; }
            catch (err) { fail++; if (!firstErr) firstErr = err && err.message ? err.message : String(err); }
            if (i % 200 === 0) { busy(true, '正在导入…', i + ' / ' + data.length); await new Promise(r => setTimeout(r, 0)); }
          }
          if (localTx) e.db.run('COMMIT');
        } catch (err) {
          try { if (localTx) e.db.run('ROLLBACK'); } catch (x) { /* ignore */ }
          ok = 0; fail = data.length; firstErr = firstErr || (err && err.message) || String(err);
        }
        busy(false);
        await persistConn(conn());
        await doRefresh();
        toast('导入完成：成功 ' + ok + ' 行' + (fail ? '，失败 ' + fail + ' 行（首个错误：' + firstErr + '）' : ''), fail > 0);
      });
  }

  async function importDbFile(file) {
    const buf = await readFile(file, false);
    const bytes = new Uint8Array(buf);
    // 校验是否为 SQLite 文件
    const magic = String.fromCharCode.apply(null, bytes.slice(0, 15));
    if (magic !== 'SQLite format 3') {
      toast('不是有效的 SQLite 数据库文件', true);
      return;
    }
    state.connSeq++;
    const name = file.name.replace(/\.(db|sqlite|sqlite3)$/i, '');
    busy(true, '正在打开数据库…', file.name);
    try {
      const c = await createConnection({
        id: 'conn_' + Date.now() + '_' + state.connSeq,
        name: name, engine: 'sqlite', persist: true, file: file.name, source: 'import'
      });
      // 用导入的字节覆盖内存库
      c.engine.close();
      await c.engine.open({ data: bytes, name });
      await refreshConnSchema(c);
      await persistConn(c);
      state.conns.push(c);
      state.activeConnId = c.id;
      renderTree(); updateStatus();
      toast('已打开数据库 ' + name + '（' + c.schema.tables.length + ' 张表）');
    } catch (e) {
      toast('打开失败：' + e.message, true);
    }
    busy(false);
  }

  async function runScriptFile(file) {
    const text = await readFile(file, true);
    if (!text.trim()) { toast('脚本为空', true); return; }
    insertQuery(text);
    await runQuery();
  }

  async function scriptInsert(name, db) {
    const r = await execSql(selectTopSql(name, 200), db ? { database: db } : undefined);
    if (!r || r.error || !r.sets.length) { toast('无法生成脚本', true); return; }
    const set = r.sets[r.sets.length - 1];
    const q = v => v === null || v === undefined ? 'NULL'
      : typeof v === 'number' ? String(v)
        : "'" + String(v).replace(/'/g, "''") + "'";
    let out = '-- INSERT 脚本：' + name + '（前 ' + set.values.length + ' 行）\n';
    set.values.forEach(row => {
      out += 'INSERT INTO ' + qid(name) + ' (' + set.columns.map(x => qid(x)).join(', ') + ') VALUES (' + row.map(q).join(', ') + ');\n';
    });
    showDdl(out, name + ' — INSERT 脚本', true);
  }

  /* ==========================================================
   * 12. 新建连接对话框
   * ========================================================== */
  const DRIVER_INFO = {
    'sqlite-local': {
      title: 'SQLite', tag: '浏览器内', remote: false,
      desc: '本地内置引擎，离线可用。数据持久化到浏览器，可导入导出 .db 文件。'
    },
    sqlite: {
      title: 'SQLite', tag: '服务器文件', remote: false,
      desc: '打开运行 server.js 那台机器上的 .db 文件，无需上传，适合大文件。'
    },
    mysql: {
      title: 'MySQL / MariaDB', tag: '远程', remote: true, port: 3306,
      desc: '通过 mysql2 驱动连接远程 MySQL 服务器，支持多库浏览与跨库查询。'
    },
    postgres: {
      title: 'PostgreSQL', tag: '远程', remote: true, port: 5432, database: 'postgres',
      desc: '通过 pg 驱动连接远程 PostgreSQL，支持多库与 schema 层级。'
    },
    mssql: {
      title: 'SQL Server', tag: '远程', remote: true, port: 1433, database: 'master',
      desc: '通过 mssql (tedious) 驱动连接远程 SQL Server，支持多库浏览。'
    }
  };

  function fRow(label, inner) {
    return '<div class="m-row"><label>' + label + '</label>' + inner + '</div>';
  }
  function fHint(text) { return '<div class="m-hint">' + text + '</div>'; }
  function fVal(m, sel) { const e = m.querySelector(sel); return e ? e.value.trim() : ''; }

  function renderConnFields(container, driverId) {
    const info = DRIVER_INFO[driverId] || {};
    let h = '';
    if (driverId === 'sqlite-local') {
      h += fRow('连接名称', '<input type="text" id="fName" value="我的数据库">');
      h += fRow('打开文件', '<button class="btn" id="fPick" style="flex:1">选择 .db / .sqlite 文件…</button>');
      h += fHint('不选文件则创建一个空数据库。文件只在你本机读取，不会上传。');
      h += fRow('持久化', '<select id="fPersist"><option value="1">保存到浏览器（刷新后数据仍在）</option><option value="0">仅本次会话</option></select>');
    } else if (driverId === 'sqlite') {
      h += fRow('连接名称', '<input type="text" id="fName" value="服务器数据库">');
      h += fRow('文件路径', '<input type="text" id="fFile" placeholder="D:\\data\\mydb.db  或  /var/data/mydb.db">');
      h += fHint('填写运行 server.js 那台机器上的绝对路径；留空则使用内存数据库 :memory:。');
    } else {
      h += fRow('连接名称', '<input type="text" id="fName" value="' + info.title + '">');
      h += fRow('主机', '<input type="text" id="fHost" placeholder="127.0.0.1 或 db.example.com">');
      h += fRow('端口', '<input type="text" id="fPort" value="' + (info.port || '') + '">');
      h += fRow('用户名', '<input type="text" id="fUser" placeholder="root">');
      h += fRow('密码', '<input type="password" id="fPass" placeholder="留空表示无密码">');
      h += fRow('数据库', '<input type="text" id="fDb" value="' + (info.database || '') + '" placeholder="可留空">');
      if (driverId === 'mssql') {
        h += fRow('加密', '<select id="fEncrypt"><option value="1">强制加密（推荐）</option><option value="0">不加密</option></select>');
      }
      h += fRow('保存密码', '<select id="fSavePw"><option value="0">不保存（更安全）</option><option value="1">保存到 connections.json</option></select>');
      h += fHint('连接由本地后端进程代理。保存密码会以明文写入项目目录下的 connections.json，请勿提交到版本库。');
    }
    container.innerHTML = h;

    if (driverId === 'sqlite-local') {
      const btn = container.querySelector('#fPick');
      btn.addEventListener('click', () => {
        pickFile('.db,.sqlite,.sqlite3', f => {
          container._pickedFile = f;
          btn.textContent = f.name;
          container.querySelector('#fName').value = f.name.replace(/\.(db|sqlite|sqlite3)$/i, '');
        });
      });
    }
  }

  function connDialog() {
    const avail = Object.fromEntries((state.drivers || []).map(d => [d.id, d]));
    const order = ['sqlite-local', 'sqlite', 'mysql', 'postgres', 'mssql'];
    const cards = order.map(id => {
      const info = DRIVER_INFO[id];
      const backend = avail[id];
      const missing = id !== 'sqlite-local' && backend && backend.available === false;
      return '<div class="engine-card' + (id === 'sqlite-local' ? ' sel' : '') + (missing ? ' disabled' : '') +
        '" data-driver="' + id + '"' + (missing ? ' title="' + esc(backend.reason || '驱动未安装') + '"' : '') + '>' +
        '<div class="ec-t">' + info.title + (missing ? ' <span style="color:var(--red);font-size:10px">未安装</span>' : '') + '</div>' +
        '<div class="ec-d"><span class="tag" style="margin-right:6px">' + info.tag + '</span>' + info.desc + '</div>' +
        '</div>';
    }).join('');

    const html =
      '<div id="savedBox"></div>' +
      '<div class="engine-pick" id="driverPick" style="flex-wrap:wrap;gap:8px">' + cards + '</div>' +
      '<div id="connFields"></div>';

    const m = openModal('新建连接', html,
      '<button class="btn" data-test>测试连接</button>' +
      '<button class="btn primary" data-ok>连接</button>' +
      '<button class="btn" data-cancel>取消</button>',
      (mm) => {
        const cfg = collectConnConfig(mm);
        if (!cfg) return true;   // 校验失败，保持对话框
        doCreateConnection(cfg);
        return false;
      }, true);

    m._driverId = 'sqlite-local';
    const fields = m.querySelector('#connFields');
    renderConnFields(fields, 'sqlite-local');

    m.querySelectorAll('.engine-card').forEach(card => {
      card.addEventListener('click', () => {
        if (card.classList.contains('disabled')) {
          const b = avail[card.dataset.driver];
          toast(b && b.reason ? b.reason : '该驱动未安装', true);
          return;
        }
        m.querySelectorAll('.engine-card').forEach(x => x.classList.remove('sel'));
        card.classList.add('sel');
        m._driverId = card.dataset.driver;
        fields._pickedFile = null;
        renderConnFields(fields, m._driverId);
      });
    });

    m.querySelector('[data-test]').addEventListener('click', () => testConn(m));
    loadSavedInto(m);
  }

  /** 对话框顶部的「最近连接」，点击即可直接重连（密码由服务端补齐） */
  async function loadSavedInto(m) {
    const box = m.querySelector('#savedBox');
    let list = [];
    try {
      const r = await S.api('/api/saved');
      list = (r.connections || []).slice().reverse().slice(0, 8);
    } catch (e) { box.innerHTML = ''; return; }
    if (!list.length) { box.innerHTML = ''; return; }

    box.innerHTML = '<div class="saved-title">最近连接（点击直接连接）</div>' +
      '<div class="saved-list">' + list.map(s =>
        '<div class="saved-item" data-saved="' + esc(s.id) + '" title="' +
        esc([s.driver, s.host ? (s.host + (s.port ? ':' + s.port : '')) : s.file].filter(Boolean).join(' · ')) + '">' +
        '<span class="si-name">' + esc(s.name) + '</span>' +
        '<span class="si-kind">' + esc(s.driver) + '</span>' +
        (s.hasPassword ? '<span class="si-lock" title="已保存密码">🔒</span>' : '') +
        '<span class="si-x" data-del="' + esc(s.id) + '" title="删除这条记录">✕</span>' +
        '</div>').join('') + '</div>';

    box.querySelectorAll('.saved-item').forEach(el => {
      el.addEventListener('click', async e => {
        const delId = e.target.getAttribute && e.target.getAttribute('data-del');
        if (delId) {
          e.stopPropagation();
          try { await S.api('/api/saved/delete', { id: delId }); toast('已删除该连接记录'); }
          catch (err) { toast('删除失败：' + err.message, true); }
          loadSavedInto(m);
          return;
        }
        const s = list.find(x => x.id === el.dataset.saved);
        if (!s) return;
        m._close();
        await doCreateConnection({ savedId: s.id, name: s.name });
      });
    });
  }

  function collectConnConfig(m) {
    const driverId = m._driverId;
    const fields = m.querySelector('#connFields');
    const name = fVal(m, '#fName') || (DRIVER_INFO[driverId] || {}).title || '未命名连接';

    if (driverId === 'sqlite-local') {
      return { driver: 'sqlite-local', name, persist: fVal(m, '#fPersist') === '1', file: fields._pickedFile || null };
    }
    if (driverId === 'sqlite') {
      return { driver: 'sqlite', name, file: fVal(m, '#fFile') || ':memory:' };
    }
    const host = fVal(m, '#fHost');
    const user = fVal(m, '#fUser');
    if (!host) { toast('请填写主机地址', true); return null; }
    if (!user) { toast('请填写用户名', true); return null; }
    return {
      driver: driverId, name, host, user,
      port: parseInt(fVal(m, '#fPort'), 10) || DRIVER_INFO[driverId].port,
      password: fVal(m, '#fPass'),
      database: fVal(m, '#fDb') || undefined,
      encrypt: driverId === 'mssql' ? fVal(m, '#fEncrypt') === '1' : undefined,
      savePassword: fVal(m, '#fSavePw') === '1'
    };
  }

  async function testConn(m) {
    const cfg = collectConnConfig(m);
    if (!cfg) return;
    busy(true, '正在测试连接…', (cfg.host ? cfg.host + ':' + cfg.port : cfg.file) || '');
    try {
      if (cfg.driver === 'sqlite-local') {
        const e = S.create('sqlite');
        let data = null;
        if (cfg.file) data = new Uint8Array(await readFile(cfg.file, false));
        await e.open({ data: data || undefined, name: cfg.name });
        const sc = await e.schema();
        e.close();
        busy(false);
        toast('连接成功：SQLite（' + sc.tables.length + ' 张表）');
        return;
      }
      const meta = await S.api('/api/connect', cfg);
      await S.api('/api/disconnect', { connId: meta.connId });
      busy(false);
      toast('连接成功：' + meta.label + ' ' + (meta.serverVersion || '') +
        '，共 ' + (meta.databases || []).length + ' 个数据库');
    } catch (e) {
      busy(false);
      toast('测试失败：' + e.message, true);
    }
  }

  async function doCreateConnection(cfg) {
    /* ---- 浏览器内 SQLite ---- */
    if (cfg.driver === 'sqlite-local') {
      busy(true, '正在创建连接…', '初始化 SQLite 引擎');
      try {
        state.connSeq++;
        const id = 'conn_' + Date.now() + '_' + state.connSeq;
        let data = null;
        if (cfg.file) {
          data = new Uint8Array(await readFile(cfg.file, false));
          const magic = String.fromCharCode.apply(null, data.slice(0, 15));
          if (magic !== 'SQLite format 3') throw new Error('不是有效的 SQLite 数据库文件');
        }
        const engine = S.create('sqlite');
        await engine.open({ data: data || undefined, name: cfg.name });
        const c = {
          id, name: cfg.name, engineKind: 'sqlite', engine,
          file: cfg.file ? cfg.file.name : null, persist: cfg.persist, schemas: {}
        };
        await refreshConnSchema(c);
        if (cfg.persist) await persistConn(c);
        state.conns.push(c);
        state.activeConnId = c.id;
        renderTree(); updateStatus(); renderResult();
        busy(false);
        toast('已连接：' + cfg.name + '（' + c.schema.tables.length + ' 张表）');
        if (!state.docs.length) newDoc(welcomeSql(c));
      } catch (e) {
        busy(false);
        toast('创建连接失败：' + e.message, true);
      }
      return;
    }

    /* ---- 远程服务器 / 服务端文件 ---- */
    busy(true, '正在连接…', (cfg.host ? cfg.host + ':' + cfg.port : cfg.file) || '');
    try {
      state.connSeq++;
      const engine = S.create('remote');
      await engine.open(cfg);
      const c = {
        id: 'conn_' + Date.now() + '_' + state.connSeq,
        name: cfg.name,
        engineKind: 'remote',
        engine,
        driver: cfg.driver,
        host: cfg.host || null,
        port: cfg.port || null,
        file: cfg.file || null,
        persist: false,
        schemas: {}
      };
      await refreshConnSchema(c);
      state.conns.push(c);
      state.activeConnId = c.id;
      renderTree(); updateStatus(); renderResult();
      busy(false);

      const dbCount = (engine.databases || []).length;
      toast('已连接：' + cfg.name + ' · ' + engine.label + ' ' + (engine.serverVersion || '') +
        (dbCount ? ' · ' + dbCount + ' 个数据库' : ''));

      if (cfg.driver) {
        try { await S.api('/api/saved', cfg); } catch (e) { /* 保存失败不影响使用 */ }
      }
      if (!state.docs.length) newDoc(welcomeSql(c));
    } catch (e) {
      busy(false);
      toast('连接失败：' + e.message, true);
    }
  }

  function welcomeSql(c) {
    const remote = c.engineKind === 'remote';
    let head = '-- 连接：' + c.name + '（' + (remote ? (c.engine.label || c.driver) : 'SQLite') + '）\n';
    if (remote) {
      head += '-- 服务端版本：' + (c.engine.serverVersion || '未知') + '\n';
      head += '-- 当前数据库：' + (c.engine.currentDatabase || '未指定') + '\n';
    }
    head += '-- 双击左侧表名查看数据；双击单元格可直接编辑并写回数据库。\n\n';

    if (remote) {
      const d = dialectOf(c);
      const sql = d === 'mssql'
        ? "SELECT TOP 50 s.name AS 架构, t.name AS 表名, t.type_desc AS 类型\nFROM sys.tables t\nJOIN sys.schemas s ON s.schema_id = t.schema_id\nORDER BY s.name, t.name;\n"
        : "SELECT table_schema AS 架构, table_name AS 表名, table_type AS 类型\nFROM information_schema.tables\nWHERE table_schema NOT IN ('information_schema','pg_catalog','mysql','performance_schema','sys')\nORDER BY table_schema, table_name;\n";
      return head + '-- 已连接远程数据库，下面列出当前库中的对象：\n\n' + sql;
    }

    return head +
      '-- 示例：创建一张表并插入数据\n' +
      'CREATE TABLE IF NOT EXISTS demo (\n' +
      '    id      INTEGER PRIMARY KEY AUTOINCREMENT,\n' +
      '    name    TEXT    NOT NULL,\n' +
      '    amount  REAL,\n' +
      '    created TEXT    DEFAULT (datetime(\'now\',\'localtime\'))\n' +
      ');\n\n' +
      'INSERT INTO demo (name, amount) VALUES\n' +
      '    (\'示例记录 A\', 128.50),\n' +
      '    (\'示例记录 B\', 3420.00),\n' +
      '    (\'示例记录 C\', 78.90);\n\n' +
      'SELECT * FROM demo ORDER BY amount DESC;\n';
  }

  /* ==========================================================
   * 13. 刷新 / 状态栏
   * ========================================================== */
  async function doRefresh(silent) {
    const c = conn();
    if (!c) { if (!silent) toast('请先选择连接', true); return; }
    try {
      await refreshConnSchema(c);
      renderTree();
      updateStatus();
      if (!silent) toast('已刷新 ' + c.name);
    } catch (e) { if (!silent) toast('刷新失败：' + e.message, true); }
  }
  function updateStatus() {
    const c = conn();
    const dot = $('#sbDot'), txt = $('#sbConn');
    if (c) {
      dot.classList.remove('off');
      txt.textContent = c.name;
      let engineLabel = 'SQLite';
      if (c.engineKind === 'remote') engineLabel = c.engine.label || c.driver || '远程';
      else if (c.engineKind === 'duckdb') engineLabel = 'DuckDB';
      $('#sbEngine').textContent = engineLabel;

      const sc = c.schema;
      if (sc && sc.tables) {
        let objTxt = sc.tables.length + ' 表 / ' + ((sc.views || []).length) + ' 视图';
        const nr = ((sc.procedures || []).length) + ((sc.functions || []).length);
        if (nr) objTxt += ' / ' + nr + ' 过程·函数';
        $('#sbObjects').textContent = objTxt;
      } else {
        $('#sbObjects').textContent = '';
      }

      if (c.engineKind === 'remote') {
        const v = c.engine.serverVersion || '';
        const host = c.host ? (c.host + (c.port ? ':' + c.port : '')) : (c.file || '');
        $('#sbPersist').textContent = host + (v ? '  ·  v' + v.split(' ')[0].slice(0, 18) : '');
      } else {
        $('#sbPersist').textContent = c.persist ? '已持久化' : '会话级';
      }
    } else {
      dot.classList.add('off');
      txt.textContent = '未连接';
      $('#sbEngine').textContent = '—';
      $('#sbObjects').textContent = '';
      $('#sbPersist').textContent = '';
    }
    updateDbSwitcher();
  }

  /* 工具栏：当前数据库切换 */
  function updateDbSwitcher() {
    const el = document.getElementById('curDb');
    const btn = document.getElementById('btnDb');
    if (!el) return;
    const c = conn();
    if (!c) { el.textContent = '—'; if (btn) btn.classList.add('disabled'); return; }
    if (btn) btn.classList.remove('disabled');
    if (c.engineKind === 'remote') el.textContent = c.engine.currentDatabase || '—';
    else el.textContent = c.name;
  }

  function showDbMenu(x, y) {
    const c = conn();
    if (!c) { toast('请先选择一个连接', true); return; }
    if (c.engineKind !== 'remote') { toast('当前连接只有一个数据库'); return; }
    const dbs = c.engine.databases || [];
    if (!dbs.length) { toast('未获取到数据库列表'); return; }
    const cur = c.engine.currentDatabase;
    const html = '<div class="c-title">切换数据库（共 ' + dbs.length + ' 个）</div>' +
      dbs.map(db => '<div class="c-item" data-db="' + esc(db) + '">' +
        '<span class="c-ico">' + (db === cur ? '✓' : '') + '</span>' + esc(db) + '</div>').join('');
    showMenu(x, y, html);
  }

  function confirmThen(title, msg, onOk, danger) {
    return new Promise(res => {
      const m = openModal(esc(title), '<div style="line-height:1.8">' + msg + '</div>',
        '<button class="btn ' + (danger ? 'danger' : 'primary') + '" data-ok>确定</button><button class="btn" data-cancel>取消</button>',
        async (mm) => {
          busy(true, '执行中…');
          try { await onOk(); } finally { busy(false); }
          res(true);
        });
    });
  }

  /* ==========================================================
   * 14. 工具栏 / 菜单
   * ========================================================== */
  const ACTIONS = {
    'new-conn': connDialog,
    'pick-db': () => {
      const btn = document.getElementById('btnDb');
      const r = btn.getBoundingClientRect();
      showDbMenu(r.left, r.bottom + 2);
    },
    'new-query': () => newDoc(),
    'open-db': () => pickFile('.db,.sqlite,.sqlite3', importDbFile),
    'import-csv': () => pickFile('.csv,.txt', f => importCsvToTable(f, currentTableName())),
    'run-script': () => pickFile('.sql,.txt', runScriptFile),
    'export-db': exportDb,
    'save': async () => { await saveAllDirty(); const d = doc(); if (d) { d.dirty = false; renderDocs(); } toast('已保存到浏览器本地'); },
    'execute': runQuery,
    'explain': explainQuery,
    'routine-ddl': () => { if (ctxData) openRoutine(ctxData._obj, ctxData._db); },
    'routine-call': () => { if (ctxData) insertQuery(routineCallScript(ctxData._obj)); },
    'cancel': () => { $('#progBar').style.width = '0%'; status('已取消'); toast('已请求取消'); },
    'refresh': () => doRefresh(),
    'theme': () => {
      const r = document.documentElement;
      const next = r.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      r.setAttribute('data-theme', next);
      localStorage.setItem('sqltool.theme', next);
      toast('已切换到' + (next === 'dark' ? '深色' : '浅色（SSMS 经典）') + '主题');
    },
    'collapse': () => {
      treeEl.querySelectorAll('.children').forEach(u => u.classList.add('collapsed'));
      treeEl.querySelectorAll('.caret').forEach(c => c.classList.remove('open'));
      toast('已折叠全部节点');
    },
    'about': () => openModal('关于 SQLTool',
      '<div style="line-height:1.9">' +
      '<b>SQLTool — 数据库工作台</b><br>' +
      '<span style="opacity:.7">参照 SQL Server Management Studio 界面构建</span><br><br>' +
      '两种引擎接入方式：<br>' +
      '· <b>浏览器内</b>：<b>SQLite</b>（sql.js / WebAssembly）— 本地内置，离线可用，数据存 IndexedDB<br>' +
      '· <b>服务器代理</b>：<b>MySQL / PostgreSQL / SQL Server</b> 与服务器端 SQLite 文件<br>' +
      '&nbsp;&nbsp;由 <code>server.js</code>（仅监听 127.0.0.1）代为连接，密码不回传前端<br><br>' +
      '<span style="opacity:.7">浏览器内数据不上传任何服务器，可随时导出为 .db 文件。</span>' +
      '</div>', null, null, true),
    'copy-sel': () => {
      const s = sqlEl.value.substring(sqlEl.selectionStart, sqlEl.selectionEnd);
      if (!s) { toast('请先选中要复制的内容', true); return; }
      copyText(s); toast('已复制 ' + s.length + ' 个字符');
    },
    'paste-sel': async () => {
      try {
        const t = await navigator.clipboard.readText();
        if (!t) { toast('剪贴板为空', true); return; }
        sqlEl.setRangeText(t, sqlEl.selectionStart, sqlEl.selectionEnd, 'end');
        const d = doc(); if (d) { d.dirty = true; renderDocs(); }
        updateEditor();
      } catch (e) { toast('浏览器拒绝访问剪贴板，请使用 Ctrl+V', true); }
    },
    'select-all': () => { sqlEl.focus(); sqlEl.select(); },
    'format': () => {
      const d = doc(); if (!d) return;
      sqlEl.value = formatSql(sqlEl.value);
      d.sql = sqlEl.value; d.dirty = true;
      renderDocs(); updateEditor();
      toast('已格式化 SQL');
    },
    'toggle-explorer': () => {
      const ex = $('#explorer'), sp = $('#splitV');
      const hid = ex.style.display === 'none';
      ex.style.display = hid ? '' : 'none';
      sp.style.display = hid ? '' : 'none';
    },
    'shortcuts': () => openModal('键盘快捷键',
      '<div style="line-height:2">' +
      '<b>F5</b> — 执行当前 SQL<br>' +
      '<b>Ctrl + F5</b> — 显示执行计划<br>' +
      '<b>Ctrl + Enter</b> — 执行当前 SQL<br>' +
      '<b>Ctrl + N</b> — 新建查询窗口<br>' +
      '<b>Ctrl + O</b> — 打开数据库文件<br>' +
      '<b>Ctrl + S</b> — 保存到浏览器本地<br>' +
      '<b>Ctrl + W</b> — 关闭当前查询窗口<br>' +
      '<b>F8</b> — 显示/隐藏对象资源管理器<br>' +
      '<b>Tab</b> — 编辑器内插入 4 个空格<br>' +
      '<b>Ctrl + Space</b> — 手动唤出输入提示<br>' +
      '<b>↑ / ↓</b> — 在提示列表中移动，<b>Enter</b> 补全，<b>Esc</b> 关闭<br>' +
      '<b>双击表名</b> — 打开该表数据<br>' +
      '<b>双击单元格</b> — 直接编辑并写回数据库<br>' +
      '<b>Ctrl / Shift + 单击行</b> — 多选行，便于批量删除<br>' +
      '</div>', null, null, true),
    'complete': () => { sqlEl.focus(); acTrigger(true); },
    'clear-db': () => {
      const c = conn();
      if (c && c.engineKind === 'remote') {
        toast('远程数据库已禁用「清空数据库」，请手动执行 DROP 语句', true);
        return;
      }
      return confirmThen('清空当前数据库',
      '将删除当前连接中的<b>所有表、视图、索引</b>，此操作不可撤销。建议先导出备份。',
      async () => {
        const c = conn();
        if (!c) return;
        const names = (c.schema.tables || []).map(t => t.name);
        for (const n of names) {
          try { c.engine.exec('DROP TABLE IF EXISTS ' + S.quoteIdent(n) + ';'); } catch (e) { /* ignore */ }
        }
        for (const v of (c.schema.views || [])) {
          try { c.engine.exec('DROP VIEW IF EXISTS ' + S.quoteIdent(v.name) + ';'); } catch (e) { /* ignore */ }
        }
        await persistConn(c);
        await doRefresh();
        toast('已清空数据库');
      }, true);
    }
  };

  function currentTableName() {
    const sel = $('#tree .node.selected');
    return sel && sel._k && sel._k.type === 'table' ? sel._k.name : null;
  }

  document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    if (el.closest('.dropdown')) return;
    if (el.classList.contains('c-item')) return;
    const a = el.dataset.action;
    if (ACTIONS[a]) { e.preventDefault(); ACTIONS[a](); }
  });

  // 菜单下拉
  $$('.m-item').forEach(mi => mi.addEventListener('click', e => {
    const was = mi.classList.contains('open');
    $$('.m-item').forEach(x => x.classList.remove('open'));
    if (!was) mi.classList.add('open');
    e.stopPropagation();
  }));
  document.addEventListener('click', () => $$('.m-item').forEach(x => x.classList.remove('open')));
  $$('.dropdown .d-item').forEach(di => di.addEventListener('click', e => {
    e.stopPropagation();
    $$('.m-item').forEach(x => x.classList.remove('open'));
    if (di.classList.contains('disabled')) return;
    if (di.dataset.action && ACTIONS[di.dataset.action]) ACTIONS[di.dataset.action]();
  }));

  /* 分隔条 */
  let drag = null;
  $('#splitV').addEventListener('mousedown', e => { drag = 'v'; document.body.classList.add('resizing-v'); e.preventDefault(); });
  $('#splitH').addEventListener('mousedown', e => { drag = 'h'; document.body.classList.add('resizing-h'); e.preventDefault(); });
  document.addEventListener('mousemove', e => {
    if (!drag) return;
    if (drag === 'v') {
      const left = $('#main').getBoundingClientRect().left;
      const w = Math.max(190, Math.min(680, e.clientX - left));
      $('#explorer').style.flexBasis = w + 'px';
      $('#explorer').style.width = w + 'px';
    } else {
      const host = $('#editorHost').getBoundingClientRect();
      const h = Math.max(70, Math.min(host.height - 80, host.bottom - e.clientY));
      $('#results').style.flexBasis = h + 'px';
    }
  });
  document.addEventListener('mouseup', () => { drag = null; document.body.classList.remove('resizing-v', 'resizing-h'); });

  /* 快捷键 */
  document.addEventListener('keydown', e => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'n') { e.preventDefault(); newDoc(); }
    else if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); ACTIONS.save(); }
    else if (ctrl && e.key.toLowerCase() === 'o') { e.preventDefault(); ACTIONS['open-db'](); }
    else if (ctrl && e.key.toLowerCase() === 'w') { e.preventDefault(); if (state.activeDocId) closeDoc(state.activeDocId); }
    else if (e.key === 'F8') { e.preventDefault(); const ex = $('#explorer'), sp = $('#splitV'); const hid = ex.style.display === 'none'; ex.style.display = hid ? '' : 'none'; sp.style.display = hid ? '' : 'none'; }
    else if (e.key === 'Escape') { if (!closeTopModal()) hideCtx(); }
  });

  /* 离开前保存 */
  window.addEventListener('beforeunload', () => { saveAllDirty(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveAllDirty(); });

  /* ==========================================================
   * 15. 启动
   * ========================================================== */
  async function boot() {
    const saved = localStorage.getItem('sqltool.theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);

    busy(true, '正在初始化…', '加载 SQLite 引擎');
    try {
      await S.engines.sqlite.ensureLib();
    } catch (e) {
      busy(false);
      toast('引擎加载失败：' + e.message + '（请确认通过 HTTP 服务器访问，而非直接双击打开文件）', true);
      return;
    }

    // 探测后端驱动；后端不可用时仍可正常使用浏览器内 SQLite
    try {
      const r = await S.api('/api/drivers');
      state.drivers = r.drivers || [];
    } catch (e) {
      state.drivers = [];
      state.backendDown = true;
    }
    busy(false);

    await restoreConnections();
    renderTree();
    updateStatus();

    if (state.conns.length) {
      newDoc('-- 已恢复 ' + state.conns.length + ' 个本地连接\n-- 在左侧双击表名即可查看数据\n\nSELECT name, type FROM sqlite_master WHERE type IN (\'table\',\'view\') ORDER BY type, name;\n');
      setTimeout(runQuery, 120);
    } else {
      newDoc(welcomeSql({ name: '未连接', engineKind: 'sqlite' }));
      renderResult();
    }
    status('就绪');
    if (state.backendDown) {
      toast('未检测到本地后端服务，MySQL / PostgreSQL / SQL Server 不可用；浏览器内 SQLite 仍可正常使用。', true);
    }
    // 启动完成标志。注意 #sbStatus 的静态初值本身就是「就绪」，
    // 所以外部（自动化测试）不能靠它判断初始化是否结束，必须用这个标志。
    window.__booted = true;
  }

  boot();
})();
