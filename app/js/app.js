/* ============================================================
 * app.js — SQLTool 数据库工作台 主逻辑
 * 前端：SSMS 风格外壳 + 真实 SQL 执行
 * ============================================================ */
(function () {
  'use strict';
  const I = window.SqlToolI18n;

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
    return I.join(['<svg class="ico" viewBox="0 0 16 16" width="', size, '" height="', size, '">', IC[name] || IC.folder, '</svg>']);
  }

  /* ==========================================================
   * 2. Toast / Overlay / Modal
   * ========================================================== */
  let toastTimer = null;
  function toast(msg, isErr) {
    const el = $('#toast');
    I.text(el, msg);
    el.classList.toggle('err', !!isErr);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), isErr ? 4200 : 2400);
  }
  function busy(show, title, sub) {
    const o = $('#overlay');
    if (show) {
      I.text($('#ovT'), title || I.t("app.working_d3d211"));
      I.text($('#ovS'), sub || '');
      o.classList.add('show');
    } else o.classList.remove('show');
  }
  function status(msg) { I.text($('#sbStatus'), msg); }

  const modalStack = [];
  function openModal(title, bodyHtml, footHtml, onOk, wide) {
    const m = document.createElement('div');
    m.className = 'mask show';
    I.html(m, I.join(['<div class="modal', wide ? ' wide' : '', '">', '<div class="m-head">', title, '<span class="m-x">✕</span></div>', '<div class="m-body">', bodyHtml, '</div>', '<div class="m-foot">', footHtml || I.t("app.ok_cancel_c42010"), '</div>', '</div>']));
    document.body.appendChild(m);
    const language = document.querySelector('[data-language-select]').cloneNode(true);
    language.value = I.locale;
    I.attr(language, 'aria-label', I.t('app.language'));
    language.addEventListener('change', () => I.setLocale(language.value));
    m.querySelector('.m-head').insertBefore(language, m.querySelector('.m-x'));
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
  const esc = I.escape;

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

  /* ==========================================================
   * SQL 分词：格式化与执行计划共用。
   * 字符串、引号标识符、$$ 字符串与注释作为整体 token 原样保留，
   * 后续处理只动「代码」部分，绝不改写其中的内容。
   * ========================================================== */
  function sqlTokens(src, dialect) {
    const s = String(src), n = s.length, out = [];
    let i = 0;
    const push = (type, j) => { j = Math.min(Math.max(j, i + 1), n); out.push({ type, text: s.slice(i, j) }); i = j; };
    while (i < n) {
      const c = s[i], c2 = s.substr(i, 2);
      if (/\s/.test(c)) { let j = i + 1; while (j < n && /\s/.test(s[j])) j++; push('ws', j); continue; }
      // # 只在 MySQL 里是注释；SQL Server 的 #临时表 不能当注释
      if (c2 === '--' || (c === '#' && dialect === 'mysql')) { const k = s.indexOf('\n', i); push('comment', k < 0 ? n : k); continue; }
      if (c2 === '/*') { const k = s.indexOf('*/', i + 2); push('comment', k < 0 ? n : k + 2); continue; }
      if (c === "'" || c === '"' || c === '`') {
        let j = i + 1;
        while (j < n) {
          if (c === "'" && dialect === 'mysql' && s[j] === '\\') { j += 2; continue; }   // MySQL 反斜杠转义
          if (s[j] === c) { if (s[j + 1] === c) { j += 2; continue; } j++; break; }
          j++;
        }
        push(c === "'" ? 'string' : 'ident', j); continue;
      }
      // [方括号标识符]：MySQL / PG 里 [ 不是引号（PG 用作数组下标）
      if (c === '[' && dialect !== 'mysql' && dialect !== 'postgres') {
        let j = i + 1;
        while (j < n) { if (s[j] === ']') { if (s[j + 1] === ']') { j += 2; continue; } j++; break; } j++; }
        push('ident', j); continue;
      }
      // PostgreSQL 美元引号：$$...$$ / $tag$...$tag$
      if (c === '$') {
        const m = /^\$([A-Za-z_][\w]*)?\$/.exec(s.slice(i, i + 64));
        if (m) { const k = s.indexOf(m[0], i + m[0].length); push('string', k < 0 ? n : k + m[0].length); continue; }
      }
      if (/[\w$\u00C0-\uFFFF]/.test(c)) { let j = i + 1; while (j < n && /[\w$\u00C0-\uFFFF]/.test(s[j])) j++; push('word', j); continue; }
      push('punct', i + 1);
    }
    return out;
  }

  /** 按分号切分语句（字符串 / 注释 / 引号标识符里的分号不切），丢弃只有注释或空白的片段 */
  function splitSqlStatements(src, dialect) {
    const stmts = [];
    let cur = [];
    const flush = () => {
      if (cur.some(t => t.type !== 'ws' && t.type !== 'comment')) stmts.push(cur.map(t => t.text).join('').trim());
      cur = [];
    };
    sqlTokens(src, dialect).forEach(t => { if (t.type === 'punct' && t.text === ';') flush(); else cur.push(t); });
    flush();
    return stmts;
  }

  /* 轻量 SQL 格式化：主要子句关键字前换行 + 统一缩进；只调整代码部分的空白 */
  const FMT_CLAUSES = [
    ['LEFT', 'OUTER', 'JOIN'], ['RIGHT', 'OUTER', 'JOIN'], ['FULL', 'OUTER', 'JOIN'],
    ['GROUP', 'BY'], ['ORDER', 'BY'], ['UNION', 'ALL'], ['LEFT', 'JOIN'], ['RIGHT', 'JOIN'], ['INNER', 'JOIN'],
    ['FULL', 'JOIN'], ['CROSS', 'JOIN'], ['INSERT', 'INTO'], ['DELETE', 'FROM'],
    ['FROM'], ['WHERE'], ['HAVING'], ['LIMIT'], ['OFFSET'], ['UNION'], ['JOIN'], ['ON'], ['VALUES'], ['SET'], ['UPDATE']
  ];
  const FMT_STMT_START = /^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH)$/i;
  const FMT_CLAUSE_START = /^(FROM|WHERE|GROUP|ORDER|HAVING|LIMIT|OFFSET|VALUES|SET|ON|UNION|JOIN|LEFT|RIGHT|INNER|FULL|CROSS)$/i;

  function formatSql(src, dialect) {
    const toks = sqlTokens(src, dialect);
    const lines = [[]];
    const cur = () => lines[lines.length - 1];
    const hasCode = parts => parts.some(p => p !== ' ');
    const prevCode = t => { for (let k = t - 1; k >= 0; k--) if (toks[k].type !== 'ws' && toks[k].type !== 'comment') return toks[k]; return null; };
    /** 从第 t 个 token 起匹配多词子句（词之间只允许空白），返回 { text, end } */
    const matchClause = t => {
      for (const words of FMT_CLAUSES) {
        let k = t, ok = true;
        for (let w = 0; w < words.length; w++) {
          if (w > 0) { if (!toks[k + 1] || toks[k + 1].type !== 'ws') { ok = false; break; } k += 2; }
          if (!toks[k] || toks[k].type !== 'word' || toks[k].text.toUpperCase() !== words[w]) { ok = false; break; }
        }
        if (ok) return { text: words.join(' '), end: k };
      }
      return null;
    };
    let paren = 0;
    for (let t = 0; t < toks.length; t++) {
      const tk = toks[t];
      if (tk.type === 'ws') {
        // 保留原有换行（最多一个空行）；行内空白压成一个空格
        const nl = (tk.text.match(/\n/g) || []).length;
        if (nl) { for (let k = 0; k < Math.min(nl, 2); k++) lines.push([]); }
        else if (cur().length) cur().push(' ');
        continue;
      }
      if (tk.type === 'punct') {
        if (tk.text === '(') paren++;
        else if (tk.text === ')') paren = Math.max(0, paren - 1);
      }
      // 只在括号外断行：EXTRACT(YEAR FROM d)、子查询等保持原样；t.from 这类限定名不当关键字
      if (tk.type === 'word' && paren === 0) {
        const p = prevCode(t);
        const m = (!p || p.text !== '.') ? matchClause(t) : null;
        if (m) {
          if (hasCode(cur())) lines.push([]);
          cur().push(m.text);
          t = m.end;
          continue;
        }
      }
      cur().push(tk.text);
    }
    const out = [];
    let depth = 0;
    for (const parts of lines) {
      while (parts.length && parts[0] === ' ') parts.shift();
      while (parts.length && parts[parts.length - 1] === ' ') parts.pop();
      if (!parts.length) { if (out.length && out[out.length - 1] !== '') out.push(''); continue; }
      const fw = /^[A-Za-z]+$/.test(parts[0]) || /^[A-Za-z]+ /.test(parts[0]) ? parts[0].split(' ')[0] : '';
      if (FMT_STMT_START.test(fw)) depth = 0;
      else if (FMT_CLAUSE_START.test(fw)) depth = 1;
      out.push('    '.repeat(depth) + parts.join(''));
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return out.join('\n') + '\n';
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

  async function refreshConnSchema(c, database) {
    const schema = await c.engine.schema(database);
    c.attached = await c.engine.attached();
    if (!c.schemas) c.schemas = {};
    const key = (schema && schema.database) || 'main';
    c.schemas[key] = schema;
    if (!database || c.engineKind !== 'remote' || c.engine.currentDatabase === database) c.schema = schema;
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
        console.warn(I.t("app.failed_to_restore_connections_cd3fd4"), k, e);
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
    I.html(treeEl, '');
    nodeSeq = 0;
    if (!state.conns.length) {
      I.html(treeEl, I.t("app.no_connections_yet_click_new_connection_742228"));
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
    I.html(row, I.join(['<span class="caret open">▶</span>', '<svg class="ico" viewBox="0 0 16 16" width="15" height="15">', IC.server, '</svg>', '<span class="label">', esc(c.name), '</span>', '<span class="badge">', c.engineKind === 'duckdb' ? 'DuckDB' : 'SQLite', '</span>']));
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
        I.html(row, I.join(['<span class="caret">▶</span>', '<svg class="ico" viewBox="0 0 16 16" width="15" height="15">', IC.db, '</svg>', '<span class="label">', esc(db), '</span>', db === cur ? I.t("app.current_caf22d") : '']));
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
      ul.appendChild(folderNode(I.t("app.databases_51610f", { p0: c.attached.length }), 'db',
        c.attached.map(a => ({ type: 'leaf', name: a.name, icon: 'db', badge: a.file ? a.file.split(/[\\/]/).pop() : I.t("app.memory_a7b37d") })), true));
    }
    if (sc.tables && sc.tables.length) {
      const dbName = sc.database || (isRemote ? c.engine.currentDatabase : null);
      ul.appendChild(tableFolder(I.t("app.tables_dcf714", { p0: sc.tables.length }), sc.tables, c, 20, true, dbName));
    }
    if (sc.views && sc.views.length) {
      const dbName = sc.database || (isRemote ? c.engine.currentDatabase : null);
      ul.appendChild(tableFolder(I.t("app.views_dffe69", { p0: sc.views.length }), sc.views, c, 20, false, dbName));
    }
    if (sc.indexes && sc.indexes.length) {
      const kids = sc.indexes.map(x => ({ type: 'index', name: x.name, icon: 'index', badge: x.table, _obj: x }));
      ul.appendChild(folderNode(I.t("app.indexes_79290d", { p0: sc.indexes.length }), 'folder', kids, false));
    }
    if (sc.triggers && sc.triggers.length) {
      const kids = sc.triggers.map(x => ({ type: 'trigger', name: x.name, icon: 'trigger', badge: x.table, _obj: x }));
      ul.appendChild(folderNode(I.t("app.triggers_35bd5c", { p0: sc.triggers.length }), 'folder', kids, false));
    }
    /* ---- 存储过程 / 函数（SQLite 没有这类对象，数组为空即不显示） ---- */
    const rdb = sc.database || (isRemote ? c.engine.currentDatabase : null);
    if (sc.procedures && sc.procedures.length) {
      ul.appendChild(folderNode(I.t("app.procedures_4361e9", { p0: sc.procedures.length }), 'proc',
        sc.procedures.map(x => routineLeaf(x, 'procedure', rdb, 'proc')), false));
    }
    if (sc.functions && sc.functions.length) {
      ul.appendChild(folderNode(I.t("app.functions_878522", { p0: sc.functions.length }), 'func',
        sc.functions.map(x => routineLeaf(x, 'function', rdb, 'func')), false));
    }
    if (!ul.children.length) {
      const li = document.createElement('li');
      I.html(li, I.t("app.empty_fca66c"));
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
    I.attr(row, 'data-name', () => String(title).replace(/\s*\(.*\)$/, ''));
    row.dataset.type = 'folder';
    I.html(row, I.join(['<span class="caret', expanded ? ' open' : '', '">▶</span>', '<svg class="ico" viewBox="0 0 16 16" width="15" height="15">', IC.folder, '</svg>', '<span class="label">', esc(title), '</span>']));
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
      badge = I.t("app.rows_b1cbf1", { p0: item.rowCountApprox ? '~' : '', p1: item.rowCount });
    }
    I.html(row, I.join(['<span class="caret">▶</span>', '<svg class="ico" viewBox="0 0 16 16" width="15" height="15">', item.type === 'view' ? IC.view : IC.table, '</svg>', '<span class="label">', esc(item.name), '</span>', badge ? I.join(['<span class="badge">', badge, '</span>']) : '']));
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
    I.html(ul, '');
    columns.forEach(col => {
      const cl = document.createElement('li');
      const cr = document.createElement('div');
      cr.className = 'node';
      cr.style.paddingLeft = indent + 'px';
      cr.dataset.name = col.name;
      cr.dataset.type = 'column';
      I.html(cr, I.join(['<span class="caret leaf">▶</span>', '<svg class="ico" viewBox="0 0 16 16" width="15" height="15">', col.pk ? IC.colpk : IC.col, '</svg>', '<span class="label">', esc(col.name), '</span>', col.pk ? '<span class="pk" style="color:var(--amber);font-size:10px">PK</span>' : '', col.auto ? '<span class="pk" style="color:var(--accent);font-size:10px">AUTO</span>' : '', '<span class="coltype">', esc(col.type), col.notnull ? ' NOT NULL' : '', '</span>']));
      cl.appendChild(cr);
      ul.appendChild(cl);
    });
    if (!columns.length) {
      I.html(ul, I.t("app.no_column_information_c23174", { p0: indent }));
    }
  }

  /** 展开数据库节点时懒加载其表结构 */
  async function loadDatabaseNode(c, row) {
    if (row._loaded) return;
    row._loaded = true;
    I.html(row._ul, I.t("app.loading_20d15a"));
    try {
      const sc = await c.engine.schema(row._dbName);
      if (!c.schemas) c.schemas = {};
      c.schemas[row._dbName] = sc;
      I.html(row._ul, '');
      const hasAny = (sc.tables && sc.tables.length) || (sc.views && sc.views.length) ||
        (sc.procedures && sc.procedures.length) || (sc.functions && sc.functions.length);
      if (sc.tables && sc.tables.length) row._ul.appendChild(tableFolder(I.t("app.tables_dcf714", { p0: sc.tables.length }), sc.tables, c, 34, true, row._dbName));
      if (sc.views && sc.views.length) row._ul.appendChild(tableFolder(I.t("app.views_dffe69", { p0: sc.views.length }), sc.views, c, 34, false, row._dbName));
      if (sc.procedures && sc.procedures.length) {
        row._ul.appendChild(folderNode(I.t("app.procedures_4361e9", { p0: sc.procedures.length }), 'proc',
          sc.procedures.map(x => routineLeaf(x, 'procedure', row._dbName, 'proc')), false, 34));
      }
      if (sc.functions && sc.functions.length) {
        row._ul.appendChild(folderNode(I.t("app.functions_878522", { p0: sc.functions.length }), 'func',
          sc.functions.map(x => routineLeaf(x, 'function', row._dbName, 'func')), false, 34));
      }
      if (!hasAny) {
        I.html(row._ul, I.t("app.empty_database_12752b"));
      }
    } catch (e) {
      row._loaded = false;
      I.html(row._ul, I.join(['<li><div class="node" style="padding-left:34px"><span class="caret leaf">▶</span><span class="label" style="color:var(--red)">', esc(I.detail(e)), '</span></div></li>']));
    }
  }

  /** 展开表节点时懒加载列 */
  async function loadTableColumns(c, row) {
    if (row._colsLoaded) return;
    row._colsLoaded = true;
    I.html(row._ul, I.t("app.loading_8a8efa", { p0: row._colIndent }));
    try {
      const cols = await c.engine.columns(row._db, row._k.name);
      row._k._table.columns = cols;
      fillColumnNodes(row._ul, cols, row._colIndent);
    } catch (e) {
      row._colsLoaded = false;
      I.html(row._ul, I.join(['<li><div class="node" style="padding-left:', row._colIndent, 'px"><span class="caret leaf">▶</span><span class="label" style="color:var(--red)">', esc(I.detail(e)), '</span></div></li>']));
    }
  }

  function folderNode(title, icon, kids, expanded, indent) {
    indent = indent || 20;
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'node';
    row.style.paddingLeft = indent + 'px';
    I.attr(row, 'data-name', () => String(title).replace(/\s*\(.*\)$/, ''));
    row.dataset.type = 'folder';
    I.html(row, I.join(['<span class="caret', expanded ? ' open' : '', '">▶</span>', '<svg class="ico" viewBox="0 0 16 16" width="15" height="15">', IC[icon] || IC.folder, '</svg>', '<span class="label">', esc(title), '</span>']));
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
    I.html(row, I.join(['<span class="caret leaf">▶</span>', '<svg class="ico" viewBox="0 0 16 16" width="15" height="15">', IC[k.icon] || IC.col, '</svg>', '<span class="label">', esc(k.name), '</span>', k.badge ? I.join(['<span class="badge">', esc(k.badge), '</span>']) : '']));
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
    if (/AGGREGATE/i.test(t)) return I.t("app.aggregate_function_3d9018");
    if (/INLINE/i.test(t)) return I.t("app.inline_table_valued_function_df5d0f");
    if (/TABLE/i.test(t)) return I.t("app.table_valued_function_34145c");
    if (/SCALAR/i.test(t)) return I.t("app.scalar_function_61bb4c");
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
        status(I.t("app.current_database_changed_to_d98dcb", { p0: row._dbName }));
        toast(I.t("app.current_database_6bfe06", { p0: row._dbName }));
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
    return I.join(['<div class="c-item', dim ? ' dim' : '', '" data-action="', action, '">', '<span class="c-ico"><svg viewBox="0 0 16 16" width="14" height="14">', IC[icon] || IC.folder, '</svg></span>', text, extra || '', '</div>']);
  }
  function showMenu(x, y, html) {
    I.html(ctxEl, html);
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
      I.join(['<div class="c-title">', esc(c.name), '</div>', mi('query', I.t("app.new_query_342c24"), 'new-query'), mi('table', I.t("app.refresh_aee887"), 'refresh'), '<div class="c-sep"></div>', mi('db', I.t("app.export_database_as_db_26aac5"), 'export-db'), mi('table', I.t("app.run_sql_script_file_0314c4"), 'run-script'), '<div class="c-sep"></div>', mi('folder', I.t("app.close_connection_62d018"), 'close-conn'), mi('folder', I.t("app.delete_connection_and_local_data_92ad99"), 'drop-conn')]));
  }
  function showTableCtx(x, y, name) {
    showMenu(x, y,
      I.join(['<div class="c-title">', esc(name), '</div>', mi('query', I.t("app.select_top_rows_573f9e"), 'top1000'), mi('query', I.t("app.count_exact_rows_cb3e18"), 'count-rows'), mi('table', I.t("app.edit_data_6fa7a4"), 'edit-data'), '<div class="c-sep"></div>', mi('query', I.t("app.generate_select_script_9c5f86"), 'script-select'), mi('table', I.t("app.generate_create_script_bc7982"), 'script-create'), mi('view', I.t("app.generate_insert_script_5205be"), 'script-insert'), '<div class="c-sep"></div>', mi('table', I.t("app.view_table_ddl_6643c7"), 'show-ddl'), mi('table', I.t("app.import_csv_into_this_table_72adb9"), 'import-csv-table'), mi('db', I.t("app.export_table_as_csv_c0b427"), 'export-csv-table'), '<div class="c-sep"></div>', mi('folder', I.t("app.clear_table_delete_883b80"), 'truncate'), mi('folder', I.t("app.drop_table_drop_1e6602"), 'drop-table')]));
  }
  function showSimpleCtx(x, y) {
    showMenu(x, y,
      I.join(['<div class="c-title">', esc((ctxData && ctxData.name) || ''), '</div>', mi('query', I.t("app.new_query_342c24"), 'new-query'), mi('table', I.t("app.refresh_aee887"), 'refresh')]));
  }
  /** 存储过程 / 函数的右键菜单（双击也能看定义，但双击不可发现） */
  function showRoutineCtx(x, y, k) {
    const it = k._obj || {};
    showMenu(x, y,
      I.join(['<div class="c-title">', esc(it.label || it.name || ''), '</div>', mi(k.type === 'procedure' ? 'proc' : 'func', I.t("app.view_definition_23710f"), 'routine-ddl'), mi('query', I.t("app.generate_call_script_fa97d6"), 'routine-call'), '<div class="c-sep"></div>', mi('query', I.t("app.new_query_342c24"), 'new-query'), mi('table', I.t("app.refresh_aee887"), 'refresh')]));
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
    status(I.t("app.current_database_6bfe06", { p0: db }));
    toast(I.t("app.switched_to_a1b61d", { p0: db }));
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
    if (!r) { lastExecError = I.t("app.failed_no_connection_available_131a73", { p0: label }); return false; }
    if (r.error) { lastExecError = I.t("app.failed_afd956", { p0: label, p1: r.error }); toast(lastExecError, true); return false; }
    return true;
  }

  const TABLE_ACTIONS = new Set(['count-rows', 'top1000', 'edit-data', 'script-select', 'script-insert',
    'import-csv-table', 'export-csv-table', 'truncate', 'drop-table']);

  async function handleAction(a) {
    const d = ctxData || {};
    const db = TABLE_ACTIONS.has(a) ? useCtxTable(d) : undefined;
    switch (a) {
      case 'new-query': newDoc(); break;
      case 'refresh': await doRefresh(); break;
      case 'top1000': openTableQuery(d.name, { database: d._db }); break;
      case 'count-rows': {
        const result = await execSql('SELECT COUNT(*) AS row_count FROM ' + qid(d.name) + ';', { database: db });
        if (!result || result.error) toast((result && result.error) || I.t("app.row_count_failed_bf92c7"), true);
        else toast(I.t("app.rows_18da38", { p0: d.name, p1: result.sets[0].values[0][0] }));
        break;
      }
      case 'edit-data': openTableQuery(d.name, { database: d._db }); break;
      case 'show-ddl': showDdl(d._table && d._table.ddl, d.name); break;
      case 'script-select': insertQuery(selectTopSql(d.name, 100)); break;
      case 'script-create': showDdl(d._table && d._table.ddl || '-- 无 DDL', I.t("app.create_script_a8a3c2", { p0: d.name }), true); break;
      case 'script-insert': await scriptInsert(d.name, db); break;
      case 'export-db': await exportDb(d.kind === 'conn' ? state.conns.find(c => c.id === d.id) || null : conn()); break;
      case 'run-script': pickScriptFile(d.kind === 'conn' ? state.conns.find(c => c.id === d.id) || null : conn()); break;
      case 'import-csv-table': pickCsvFile(d.name, db); break;
      case 'export-csv-table': await exportTableCsv(d.name, db); break;
      case 'truncate': await confirmThen(I.t("app.clear_table_0a1b2b"), I.t("app.delete_from_will_delete_all_rows_2f0232", { p0: esc(qid(d.name)) }), async () => {
        // 先刷新再提示：doRefresh 自己会弹「已刷新」，放在后面会盖掉结果提示
        const okDel = await execOrToast('DELETE FROM ' + qid(d.name) + ';', I.t("app.clear_table_0a1b2b"), db);
        if (okDel) await persistConn(conn());
        await doRefresh();
        if (okDel) toast(I.t("app.cleared_e5092f", { p0: d.name }));
        else toast(lastExecError, true);
      }); break;
      case 'drop-table': await confirmThen(I.t("app.drop_table_d54572"), I.t("app.drop_table_will_be_executed_this_1adebb", { p0: esc(qid(d.name)) }), async () => {
        const okDrop = await execOrToast('DROP TABLE ' + qid(d.name) + ';', I.t("app.drop_table_d54572"), db);
        if (okDrop) await persistConn(conn());
        await doRefresh();
        if (okDrop) toast(I.t("app.deleted_0bafa8", { p0: d.name }));
        else toast(lastExecError, true);
      }, true); break;
      case 'close-conn': await closeConnection(d.id, false); toast(I.t("app.connection_closed_30f12a")); break;
      case 'drop-conn': await confirmThen(I.t("app.delete_connection_92e113"), I.t("app.this_closes_the_connection_and_deletes_1fbde0"), async () => {
        await closeConnection(d.id, true); toast(I.t("app.connection_deleted_bcb4b0"));
      }, true); break;
      /* 结果网格上的增 / 删 / 复制（作用于当前查询窗口） */
      case 'row-add': await addRowDialog(); break;
      case 'row-del': await deleteSelectedRows(); break;
      case 'row-copy': copySelectedRows(); break;
      default: toast(I.t("app.action_b1772b", { p0: a }));
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
    I.html(tabs, '');
    state.docs.forEach(d => {
      const t = document.createElement('div');
      t.className = 'doc-tab' + (d.id === state.activeDocId ? ' active' : '');
      t.dataset.id = d.id;
      I.html(t, I.join(['<svg class="t-ico" viewBox="0 0 16 16">', IC.query, '</svg>', '<span class="t-name">', esc(d.title), '</span>', d.dirty ? '<span class="dirty"></span>' : '', '<span class="t-close">✕</span>']));
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

  function templateBridge() {
    const originalDoc = doc(), originalSql = sqlEl.value;
    const start = sqlEl.selectionStart, end = sqlEl.selectionEnd;
    return {
      openModal, toast, download,
      canInsert: !!originalDoc,
      selection: end > start,
      target: () => {
        const c = conn(), database = currentDbArg(c);
        return { label: c ? c.name + (database ? ' / ' + database : '') : I.t("app.not_connected_3d5257"), dialect: c ? c.engine.dialect : 'all' };
      },
      open: template => {
        const d = newDoc(template.sql, template.name + '.sql');
        d.dirty = true; renderDocs();
        toast(I.t("app.template_opened_in_a_new_tab_394994"));
      },
      insert: template => {
        if (!originalDoc || !state.docs.includes(originalDoc) || doc() !== originalDoc || sqlEl.value !== originalSql) {
          throw I.error(I.t("app.the_query_tab_or_its_content_859725"));
        }
        sqlEl.setRangeText(template.sql, start, end, 'end');
        originalDoc.sql = sqlEl.value; originalDoc.dirty = true; originalDoc.pendingEdit = null;
        acClose(); renderDocs(); updateEditor(); sqlEl.focus();
        toast(end > start ? I.t("app.selected_sql_replaced_6d1f09") : I.t("app.template_inserted_at_cursor_fd0f74"));
      }
    };
  }

  function saveSqlTemplate() {
    const d = doc();
    if (!d) { toast(I.t("app.no_query_tab_to_save_6eb90d"), true); return; }
    const start = sqlEl.selectionStart, end = sqlEl.selectionEnd;
    const sql = end > start ? sqlEl.value.slice(start, end) : sqlEl.value;
    if (!sql.trim()) { toast(I.t("app.select_or_enter_the_sql_to_3631bd"), true); return; }
    const bridge = templateBridge();
    S.Templates.saveEditor(bridge, { name: String(d.title).replace(/\.sql$/i, '').slice(0, 120), sql, dialect: bridge.target().dialect });
  }

  function showDdl(ddl, title, wide) {
    const text = ddl || I.t('app.noDdl');
    return showDdlAsync(title, () => text, wide);
  }

  /**
   * 先弹窗、再异步填充内容。
   * 存储过程 / 函数的定义要单独向后端取；若先等结果再弹窗，
   * 遇到慢查询界面会像卡死一样，完全没有反馈。
   */
  function showDdlAsync(title, loader, wide) {
    const m = openModal(esc(title),
      I.t("app.loading_definition_05c067"),
      I.t("app.copy_insert_into_query_close_5f3b12"),
      null, wide !== false);
    let text = '';
    const put = t => {
      text = t || I.t('app.noDefinition');
      I.html(m.querySelector('.m-body'), I.join(['<pre class="ddl-pre">', esc(text), '</pre>']));
    };
    m.querySelector('[data-copy]').addEventListener('click', () => { if (!text) return; copyText(I.resolve(text)); toast(I.t("app.copied_to_clipboard_cce28d")); });
    m.querySelector('[data-insert]').addEventListener('click', () => { if (!text) return; insertQuery(I.resolve(text)); m._close(); });
    Promise.resolve().then(loader).then(put)
      .catch(e => put(I.t('app.definitionError', { detail: I.detail(e) })));
    return m;
  }

  /** 双击存储过程 / 函数节点：按需取回 CREATE 原文 */
  function openRoutine(item, database) {
    const c = conn();
    if (!item) return;
    const label = item.label || item.name;
    if (!c || !c.engine || typeof c.engine.routineDdl !== 'function') {
      toast(I.t("app.this_engine_does_not_support_viewing_5cd590"), true);
      return;
    }
    status(I.t("app.loading_the_definition_of_c8b14f", { p0: label }));
    showDdlAsync(label, async () => {
      try { return await c.engine.routineDdl(item, database); }
      finally { status(I.t("app.ready_b073db")); }
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
    I.html(hlEl, highlight(code) + '\n');
    const lines = code.split('\n').length;
    let g = '';
    for (let k = 1; k <= lines; k++) g += I.join(['<div class="ln">', k, '</div>']);
    I.html(gutterEl, g);
    sqlEl.style.height = 'auto';
    sqlEl.style.height = Math.max(sqlEl.scrollHeight, codeScroll.clientHeight) + 'px';
    updatePos();
  }
  function updatePos() {
    const pos = sqlEl.selectionStart;
    const before = sqlEl.value.slice(0, pos);
    const line = before.split('\n').length;
    const col = pos - before.lastIndexOf('\n');
    I.text($('#sbPos'), I.t("app.ln_col_7ed988", { p0: line, p1: col }));
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
    I.attr(btn, 'title', has ? I.t("app.run_selected_sql_f5_only_the_f2a875") : I.t("app.run_all_sql_f5_e269f6"));
    const lb = btn.querySelector('.tb-label');
    if (lb) I.text(lb, has ? I.t("app.run_selection_6344d0") : I.t("app.run_32c8d3"));
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
    // Ctrl+F5 只出执行计划：F5 分支必须排除 Ctrl，否则会先把语句真正执行一遍
    if (e.key === 'F5' && !e.ctrlKey) { e.preventDefault(); runQuery(); }
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
    if (el) { el.classList.remove('show'); I.html(el, ''); }
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
    I.html(hlEl, I.join([highlight(before), '<span class="ac-mark"></span>']));
    const mark = hlEl.querySelector('.ac-mark');
    let out = { top: 0, left: 0 };
    if (mark) {
      const a = mark.getBoundingClientRect(), b = inner.getBoundingClientRect();
      out = { top: a.top - b.top, left: a.left - b.left };
    }
    I.html(hlEl, highlight(sqlEl.value) + '\n');
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

    let items = [], kind = I.t("app.keywords_objects_2c171d");

    if (dot) {
      // 「x.」：只给这张表的列。解析不到就什么都不给（宁可空，也不要拿别的表的列凑数）
      const owner = sc.colsByTable[dot] ? dot : (scope.aliasMap[dot.toLowerCase()] || '');
      const list = (owner && sc.colsByTable[owner]) || [];
      if (!list.length) return null;
      items = list.filter(startsWith).map(n => ({ text: n, type: 'column' }));
      kind = I.t("app.columns_of_e10aba", { p0: owner });
    } else if (onlyTables) {
      items = sc.tables.filter(startsWith).map(n => ({ text: n, type: 'table' }));
      kind = I.t("app.tables_views_437c9b");
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
        kind = I.t("app.columns_in_this_statement_114b82", { p0: scope.tables.slice(0, 3).join(', '), p1: scope.tables.length > 3 ? I.t("app.and_others_tables_total_6df37e", { p0: scope.tables.length }) : '' });
      } else {
        // 还没有 FROM（比如刚写 SELECT）时，才放宽到全库对象
        const tb = sc.tables.filter(startsWith).map(n => ({ text: n, type: 'table' }));
        const cl = sc.allCols.filter(startsWith).map(n => ({ text: n, type: 'column' }));
        items = tb.concat(cl, fn, kw);
        kind = I.t("app.keywords_objects_2c171d");
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
    const tag = t => t === 'table' ? [I.t("app.table_c35f80"), 't'] : t === 'column' ? [I.t("app.column_c06d21"), 'c'] : t === 'function' ? [I.t("app.fn_72832f"), 'f'] : ['K', 'k'];
    I.html(el, I.t("app.suggestions_select_enter_complete_584ee7", { p0: esc(st.kind), p1: st.items.length, p2: I.join(st.items.map((it, i) => {
        const [ch, cls] = tag(it.type);
        return I.join(['<div class="ac-item', i === 0 ? ' sel' : '', '" data-i="', i, '">', '<span class="ac-t ', cls, '">', ch, '</span>', '<span class="ac-n">', esc(it.text), '</span>', '<span class="ac-dim">', esc(it.type === 'table' ? I.t("app.table_c35f80") : it.type === 'column' ? I.t("app.column_c06d21") : it.type === 'function' ? I.t("app.function_183299") : I.t("app.keyword_884e46")), '</span>', '</div>']);
      })) }));
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

  // 异步操作始终携带发起时的连接、引擎和数据库，不再跟随界面切换。
  function queryContext(c, database) {
    return c && c.engine ? { connection: c, engine: c.engine, connId: c.id,
      database: database === undefined ? (currentDbArg(c) || null) : database } : null;
  }
  function contextOpen(context) {
    return !!context && state.conns.includes(context.connection) && context.connection.engine === context.engine;
  }
  function contextActive(context) {
    return contextOpen(context) && context.connId === state.activeConnId &&
      (context.connection.engineKind !== 'remote' || context.database === (currentDbArg(context.connection) || null));
  }

  async function execSql(sql, opts) {
    const context = (opts && opts.context) || queryContext(conn(), opts && opts.database);
    if (!contextOpen(context)) return { error: I.t("app.connection_closed_or_unavailable_aff9ee"), ms: 0 };
    const t0 = performance.now();
    try {
      const r = await context.engine.exec(sql, context.database);
      r.ms = Math.round(performance.now() - t0);
      return r;
    } catch (err) {
      return { error: err && I.detail(err) ? I.detail(err) : String(err), ms: Math.round(performance.now() - t0) };
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

  async function runQuery(opts) {
    opts = opts || {};
    const d = opts.document || doc();
    if (!d) { toast(I.t("app.no_active_query_tab_eb854d"), true); return; }
    const context = opts.context || queryContext(conn());
    if (!contextOpen(context) || !state.docs.includes(d)) { toast(I.t("app.connection_or_query_tab_closed_2dacd3"), true); return; }
    if (!opts.document) d.sql = sqlEl.value; // 文档内容始终是整篇
    const cur = opts.sql === undefined ? currentSql() : { sql: opts.sql, selection: false };
    const sql = cur.sql;                 // 实际执行的是选区或整篇
    if (!sql) { toast(I.t("app.enter_a_sql_statement_36960f"), true); return; }
    const version = d.queryVersion = (d.queryVersion || 0) + 1;
    const pe = cur.selection ? null : (opts.pendingEdit || d.pendingEdit);
    if (!cur.selection) d.pendingEdit = null;
    d.queryRunning = true;
    if (doc() === d) $('#sbStatus').dataset.queryState = 'running';
    const visible = () => doc() === d && contextActive(context);
    if (doc() === d) renderResult();

    const bar = $('#progBar');
    if (visible()) {
      bar.style.width = '0%';
      requestAnimationFrame(() => { if (visible() && d.queryVersion === version && d.queryRunning) bar.style.width = '60%'; });
      status(cur.selection ? I.t("app.running_selection_5c159f") : I.t("app.running_85a6ab"));
    }

    let r = await execSql(sql, { context });
    if (!state.docs.includes(d) || d.queryVersion !== version) return;
    d.queryRunning = false;
    if (doc() === d) $('#sbStatus').dataset.queryState = r && !r.error && contextOpen(context) ? 'success' : 'error';
    if (!contextOpen(context)) r = { error: I.t("app.the_query_s_connection_has_been_5056bc") };
    d.connId = context.connId;
    d.resultContext = context;
    d.resultSql = sql;
    if (visible()) {
      bar.style.width = '100%';
      setTimeout(() => { if (visible() && d.queryVersion === version) bar.style.width = '0%'; }, 200);
    }

    if (!r || r.error) {
      d.result = null;
      d.message = I.t("app.execution_failed_0fd7fa", { p0: cur.selection ? I.t("app.only_the_selection_was_executed_lines_f1b656", { p0: cur.lines }) : '', p1: esc((r && r.error) || I.t("app.unknown_error_13a466")) });
      d.activeRes = 'msg';
      if (doc() === d) renderResult();
      if (visible()) { status(I.t("app.execution_failed_934459")); toast(I.t("app.sql_execution_failed_d24c3b"), true); }
      return;
    }

    const sets = r.sets || [];
    if (sets.length) {
      const set = sets[sets.length - 1];
      d.result = { columns: set.columns, values: set.values };
      d.editTable = null; d.editCols = null; d.rowKeys = null; d.editKeyType = null;
      d.editNote = ''; d.editKeyCols = null; d.editDb = context.database;
      if (pe && pe.rowid && set.columns[0] === '__rid') {
        // SQLite：用隐藏的 rowid 列精确定位行
        d.editTable = pe.table; d.editKeyType = 'rowid';
        d.rowKeys = set.values.map(v => ({ rowid: v[0] }));
        d.result = { columns: set.columns.slice(1), values: set.values.map(v => v.slice(1)) };
        d.editCols = d.result.columns;
      } else if (pe && pe.pkCols && pe.pkCols.length) {
        // 远程库：用主键列定位行
        const idx = pe.pkCols.map(c => set.columns.indexOf(c));
        if (idx.every(i => i >= 0)) {
          d.editTable = pe.table; d.editKeyType = 'pk';
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
          d.editTable = pe.table; d.editKeyType = 'cols';
          d.editKeyCols = pe.allCols.slice();
          d.rowKeys = set.values.map(v => {
            const k = {};
            pe.allCols.forEach((c, n) => { k[c] = v[idx[n]]; });
            return k;
          });
          d.editCols = set.columns;
          d.editNote = I.t("app.no_primary_key_matching_original_values_1ecab3");
        }
      }
      d.message =
        I.t("app.query_succeeded_rows_returned_result_sets_11fe69", { p0: cur.selection ? I.t("app.only_the_selection_was_executed_lines_017419", { p0: cur.lines }) : '', p1: d.result.values.length, p2: sets.length, p3: r.ms });
      d.activeRes = 'grid';
      if (visible()) status(cur.selection ? I.t("app.query_succeeded_selection_363540") : I.t("app.query_succeeded_9d03b2"));
    } else {
      d.result = null;
      d.message =
        I.t("app.command_completed_successfully_rows_affected_time_437541", { p0: cur.selection ? I.t("app.only_the_selection_was_executed_lines_017419", { p0: cur.lines }) : '', p1: r.rowsAffected || 0, p2: r.ms });
      d.activeRes = 'msg';
      if (visible()) status(cur.selection ? I.t("app.command_completed_successfully_selection_38fbd8") : I.t("app.command_completed_successfully_b475bb"));
      // 结构变化只刷新产生它的连接，不刷新用户后来选中的连接。
      try { await refreshConnSchema(context.connection, context.database); } catch (e) { /* 刷新失败不影响执行结果 */ }
      renderTree(); updateStatus();
    }
    if (doc() === d) renderResult();
  }

  async function explainQuery() {
    const d = doc();
    const context = queryContext(conn());
    if (!d || !contextOpen(context)) return;
    d.sql = sqlEl.value;
    const dialect = dialectOf(context.connection);
    const cur = currentSql();
    if (!cur.sql) { toast(I.t("app.enter_a_sql_statement_36960f"), true); return; }
    // 按方言选 EXPLAIN 前缀；这些形式都只生成计划、不执行语句。
    // SQL Server 需要单独批次 SET SHOWPLAN_TEXT ON，这里不支持（未经真库验证）
    const PREFIX = { sqlite: 'EXPLAIN QUERY PLAN ', duckdb: 'EXPLAIN ', mysql: 'EXPLAIN ', postgres: 'EXPLAIN ' };
    const prefix = PREFIX[dialect];
    const engineLabel = dialect === 'sqlite' ? 'SQLite EXPLAIN QUERY PLAN' : (dialect === 'duckdb' ? 'DuckDB' : dialect === 'mysql' ? 'MySQL' : 'PostgreSQL') + ' EXPLAIN';
    // 必须逐条加前缀：只给第一条加 EXPLAIN 时，后面的语句会被真正执行（INSERT 会写进库）
    const stmts = splitSqlStatements(cur.sql, dialect);
    let refuse = null;
    if (!prefix) refuse = I.t("app.explain_not_supported_dialect_7c1e4a", { p0: dialect });
    // EXPLAIN + ANALYZE… 在 MySQL / PG 里会变成 EXPLAIN ANALYZE（真实执行），直接拒绝
    else if (stmts.some(st => /^ANALY[SZ]E\b/i.test(sqlTokens(st, dialect).filter(t => t.type !== 'ws' && t.type !== 'comment').map(t => t.text).join(' ')))) {
      refuse = I.t("app.explain_analyze_refused_3b9d21");
    }
    if (refuse) {
      d.connId = context.connId; d.resultContext = context;
      d.result = null; d.activeRes = 'msg';
      d.message = I.t("app.could_not_generate_execution_plan_6647c3", { p0: I.escape(refuse) });
      d.editTable = null; d.editCols = null; d.rowids = null;
      renderResult();
      return;
    }
    const version = d.queryVersion = (d.queryVersion || 0) + 1;
    d.queryRunning = true;
    renderResult();
    // 逐条生成计划：引擎对「计划为空」的语句不返回结果集，整段执行时结果集与语句对不上
    const parts = [];
    let r = null;
    for (let n = 0; n < stmts.length; n++) {
      const one = await execSql(prefix + stmts[n] + ';', { context });
      if (!state.docs.includes(d) || d.queryVersion !== version) return;
      if (!one || one.error) {
        const msg = (one && one.error) || '';
        r = { error: stmts.length > 1 ? I.t("app.explain_statement_failed_8e1f3c", { p0: n + 1, p1: msg }) : msg };
        break;
      }
      (one.sets || []).forEach(set => parts.push({ no: n + 1, set }));
    }
    if (!r) r = { sets: parts.map(p => p.set) };
    d.queryRunning = false;
    if (!contextOpen(context)) r = { error: I.t("app.the_query_s_connection_has_been_5056bc") };
    d.connId = context.connId; d.resultContext = context;
    d.activeRes = 'grid';
    if (!r || r.error) {
      d.result = null;
      d.message = I.t("app.could_not_generate_execution_plan_6647c3", { p0: I.escape((r && r.error) || '') });
      d.activeRes = 'msg';      // 出错时切到消息页，否则用户只看到空网格
    } else if (r.sets && r.sets.length) {
      const sets = r.sets;
      const same = sets.every(s => JSON.stringify(s.columns) === JSON.stringify(sets[0].columns));
      if (stmts.length > 1 && same) {
        // 多条语句的计划合并到一张表，首列标出语句序号（不用 #，避免和网格自带的行号列混淆）
        d.result = {
          columns: [String(I.t("app.explain_statement_column_4d2b8e"))].concat(sets[0].columns),
          values: [].concat(...parts.map(p => p.set.values.map(v => [p.no].concat(v))))
        };
      } else {
        const set = sets[sets.length - 1];
        d.result = { columns: set.columns, values: set.values };
      }
      const label = stmts.length > 1 ? I.join([engineLabel, ' · ', I.t("app.explain_statements_count_9a4c17", { p0: stmts.length })]) : engineLabel;
      d.message = I.t("app.execution_plan_generated_engine_12b827", { p0: label });
    } else {
      d.result = null;
      d.message = I.t("app.the_engine_returned_no_execution_plan_061222");
      d.activeRes = 'msg';
    }
    d.editTable = null; d.editCols = null; d.rowids = null;
    if (doc() === d) renderResult();
    if (doc() === d && contextActive(context)) status(I.t("app.execution_plan_2619dd"));
  }

  async function openTableQuery(name, opts) {
    opts = opts || {};
    const c = conn();
    if (!c) { toast(I.t("app.select_a_connection_first_4b5240"), true); return; }
    const isView = !!opts.isView;
    const db = opts.database || (c.engineKind === 'remote' ? c.engine.currentDatabase : null);
    const context = queryContext(c, db);
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
    if (!contextOpen(context)) { toast(I.t("app.connection_closed_30f12a"), true); return; }

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
    await runQuery({ document: d, context, sql });
  }

  function dialectOf(c) {
    if (!c) return 'sqlite';
    if (c.engineKind === 'remote') return c.engine.dialect || 'mysql';
    if (c.engineKind === 'duckdb') return 'duckdb';
    return 'sqlite';
  }

  function findTable(name, db, c = conn()) {
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
    I.html(body, '');
    if (!d) {
      $('#rowCnt').style.display = 'none';
      updateRowActions(null);
      I.html(body, I.t("app.no_active_query_tab_press_ctrl_29c203", { p0: bigGridIcon() }));
      return;
    }
    $$('.res-tab').forEach(t => t.classList.toggle('active', t.dataset.res === d.activeRes));

    if (d.activeRes === 'msg') {
      $('#rowCnt').style.display = 'none';
      updateRowActions(null);
      I.html(body, I.join(['<div class="messages">', d.message || I.t("app.no_messages_yet_4ef619"), '</div>']));
      return;
    }
    if (!d.result) {
      $('#rowCnt').style.display = 'none';
      updateRowActions(null);
      I.html(body, I.t("app.no_query_results_yet_press_f5_e1c3af", { p0: bigGridIcon() }));
      return;
    }
    // 结果来自另一个连接时给出明确提示，避免误读
    if (d.resultContext && !contextActive(d.resultContext)) {
      $('#rowCnt').style.display = 'none';
      updateRowActions(null);
      const other = state.conns.find(x => x.id === d.connId);
      const cur = conn();
      I.html(body, I.t("app.this_result_belongs_to_connection_current_f3dfc2", { p0: bigGridIcon(), p1: esc(other ? other.name : I.t("app.closed_connection_c5d13e")), p2: d.resultContext.database ? I.t("app.database_55df70", { p0: esc(d.resultContext.database) }) : '', p3: esc(cur ? cur.name : I.t("app.not_connected_3d5257")) }));
      return;
    }
    $('#rowCnt').style.display = '';
    I.text($('#rowCnt'), d.result.values.length);
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
      htr += I.join(['<th data-col="', ci, '"><div class="th-in">', esc(c), meta ? I.join(['<span class="pk">', meta.pk ? 'PK ' : '', '</span><span class="col-type">', esc(meta.type), '</span>']) : '', '<span class="sort">', sorted, '</span></div></th>']);
    });
    htr += '</tr>';
    I.html(thead, htr);
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
        return I.compare(String(x), String(y)) * dir;
      });
    }

    order.forEach(({ v, i }) => {
      const tr = document.createElement('tr');
      const rn = document.createElement('td');
      rn.className = 'rowno';
      I.text(rn, '');
      tr.appendChild(rn);
      v.forEach((val, ci) => {
        const td = document.createElement('td');
        td.dataset.col = ci;
        td.dataset.row = i;
        if (val === null || val === undefined) { td.className = 'null'; I.text(td, 'NULL'); }
        else if (typeof val === 'number') { td.className = 'num'; I.text(td, Number.isInteger(val) ? I.number(val) : String(val)); }
        else if (val instanceof Uint8Array) { td.className = 'blob'; I.text(td, I.t("app.blob_bytes_603be7", { p0: val.length })); }
        else { I.text(td, String(val)); }
        // 只要是「从表打开」的结果集就可编辑；列元信息（PK/类型）缺失不影响编辑，
        // 否则 schema 缓存一旦丢失，整张表就变成不可编辑且没有任何提示。
        if (d.editTable && !d.isView && !d.queryRunning) {
          td.classList.add('editable');
          I.attr(td, 'title', I.t("app.double_click_to_edit_right_click_0ebc09"));
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    body.appendChild(tbl);
    Array.from(tbody.children).forEach((tr, idx) => { I.text(tr.firstChild, idx + 1); });

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
    if (d.editTable && !d.isView && !d.queryRunning) {
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
          I.join(['<div class="c-title">', esc(d.editTable), '</div>', mi('table', I.t("app.add_row_c91cea"), 'row-add'), mi('folder', I.t("app.delete_selected_rows_fa8e7d", { p0: sel ? '（' + sel + '）' : '' }), 'row-del', '', !sel), '<div class="c-sep"></div>', mi('query', I.t("app.copy_selected_rows_tab_separated_c04dd4"), 'row-copy', '', !sel)]));
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
    if (!parts.length) throw I.error(I.t("app.cannot_locate_this_row_missing_row_c06c76"));
    return { where: parts.join(' AND '), params };
  }

  // 写操作保存结果快照，确认框/输入框等待期间不得借用其他文档或连接。
  function editTarget(d) {
    if (!d || !d.result || !d.editTable || d.isView || d.queryRunning ||
        !state.docs.includes(d) || !contextActive(d.resultContext)) {
      toast(I.t("app.switch_back_to_the_result_s_8fab18"), true);
      return null;
    }
    return { document: d, result: d.result, version: d.queryVersion, context: d.resultContext,
      data: Object.assign({}, d, { rowKeys: (d.rowKeys || []).map(key => Object.assign({}, key)) }) };
  }
  function editTargetCurrent(target) {
    const d = target.document;
    return state.docs.includes(d) && contextOpen(target.context) && !d.queryRunning &&
      d.queryVersion === target.version && d.result === target.result;
  }

  function startEdit(td, d, colName, rowIdx) {
    if (td.querySelector('input')) return;
    const target = editTarget(d);
    if (!target) return;
    d = target.data;
    const old = td.classList.contains('null') ? null : td.textContent;
    td.classList.add('editing');
    const inp = document.createElement('input');
    inp.value = old === null ? '' : old;
    inp.spellcheck = false;
    I.text(td, '');
    td.appendChild(inp);
    inp.focus();
    inp.select();

    let done = false;
    const finish = async (commit) => {
      if (done) return; done = true;
      const nv = inp.value;
      td.classList.remove('editing');
      if (!commit || nv === (old === null ? '' : String(old))) { renderResult(); return; }
      if (!editTargetCurrent(target)) { toast(I.t("app.the_result_changed_or_the_connection_50c370"), true); renderResult(); return; }
      const c = target.context.connection;
      const q = n => S.quoteIdentFor(n, dialectOf(c));
      const e = target.context.engine;
      const val = nv === '' ? null : nv;
      try {
        const w = rowWhere(d, rowIdx, q);
        const sql = 'UPDATE ' + q(d.editTable) + ' SET ' + q(colName) + ' = ? WHERE ' + w.where;
        const res = await e.run(sql, [val].concat(w.params), target.context.database);
        // 0 行受影响：行定位条件没匹配到任何行（行已被删除 / 改动，或按全部列原值匹配时
        // BLOB、日期精度、浮点数等原值无法精确比较）。此时不能假装成功改掉本地单元格。
        if (!res || !(res.rowsAffected > 0)) {
          toast(I.t("app.update_failed_no_rows_changed_the_037052"), true);
          renderResult();
          return;
        }
        const cur = target.document;
        if (editTargetCurrent(target)) {
          const ci = cur.result.columns.indexOf(colName);
          if (ci >= 0) cur.result.values[rowIdx][ci] = val;
        }
        if (d.editKeyType === 'cols' && res && res.rowsAffected > 1) {
          toast(I.t("app.updated_rows_this_table_has_no_4721c4", { p0: res.rowsAffected }), true);
          await reloadTableData(target);
        } else {
          toast(I.t("app.updated_07eb8e", { p0: d.editTable, p1: colName }));
        }
        if (contextOpen(target.context)) await persistConn(c);
        renderResult();
      } catch (err) {
        toast(I.t("app.update_failed_3a4eb3", { p0: err && I.detail(err) ? I.detail(err) : err }), true);
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
  async function reloadTableData(target) {
    if (!editTargetCurrent(target)) return;
    const d = target.data;
    const pendingEdit = {
      table: d.editTable, database: d.editDb,
      rowid: d.editKeyType === 'rowid',
      pkCols: d.editKeyType === 'pk' ? (d.editKeyCols || []) : [],
      allCols: d.editKeyType === 'cols' ? (d.editKeyCols || []) : []
    };
    await runQuery({ document: target.document, context: target.context, sql: d.resultSql, pendingEdit });
  }

  /** 取出表结构（列定义），用于新增行表单 */
  async function tableColumnsFor(d, c) {
    const tbl = findTable(d.editTable, d.editDb, c);
    let cols = (tbl && tbl.columns) || [];
    if (!cols.length && c.engine.columns) {
      try { cols = await c.engine.columns(d.editDb || null, d.editTable); if (tbl) tbl.columns = cols; }
      catch (e) { cols = []; }
    }
    return cols;
  }

  /** 新增一行：按列生成表单 → 参数化 INSERT */
  async function addRowDialog() {
    const target = editTarget(doc());
    if (!target) return;
    const d = target.data, c = target.context.connection;
    const cols = await tableColumnsFor(d, c);
    if (!editTargetCurrent(target)) { toast(I.t("app.the_result_changed_or_the_connection_fa9f69"), true); return; }
    if (!cols.length) { toast(I.t("app.cannot_add_a_row_without_the_efa438"), true); return; }
    const q = n => S.quoteIdentFor(n, dialectOf(c));
    const ddl = (findTable(d.editTable, d.editDb, c) || {}).ddl || '';

    const rows = I.join(cols.map(col => {
      const auto = col.auto === true ||
        /auto_increment|identity|serial/i.test(String(col.type || '')) ||
        new RegExp('\\b' + String(col.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b[^,)]*AUTOINCREMENT', 'i').test(ddl);
      const tags = I.join([col.pk ? '<span class="tag pk-tag">PK</span>' : '',
        auto ? I.t("app.auto_3ffee6") : '',
        col.notnull ? I.t("app.required_24da94") : '']);
      const ph = auto ? I.t("app.leave_blank_to_generate_47d950")
        : (col.dflt !== null && col.dflt !== undefined ? I.t("app.default_6b8542", { p0: String(col.dflt).slice(0, 22) })
          : (col.notnull ? I.t("app.required_11da9d") : 'NULL'));
      return I.t("app.null_4105be", { p0: esc(col.name), p1: esc(col.name), p2: esc(col.name), p3: esc(ph), p4: tags, p5: esc(String(col.type || '')) });
    }));

    const m = openModal(I.t("app.add_a_row_to_fafaa0", { p0: esc(d.editTable) }),
      I.t("app.blank_with_null_checked_insert_null_d9fff8", { p0: rows, p1: d.editKeyType === 'cols' ? I.t("app.this_table_has_no_primary_key_ee3960") : '' }),
      I.t("app.insert_cancel_00d291"),
      async (mm) => {
        if (!editTargetCurrent(target)) { toast(I.t("app.the_result_changed_or_the_connection_ebe5c2"), true); return false; }
        const names = [], ph = [], params = [];
        let bad = null;
        mm.querySelectorAll('.add-row').forEach(r => {
          const name = r.dataset.col;
          const isnull = r.querySelector('.add-isnull').checked;
          const raw = r.querySelector('.add-val').value;
          const meta = cols.find(x => x.name === name) || {};
          if (isnull) {
            if (meta.notnull) { bad = I.t("app.is_required_and_cannot_be_null_7d8279", { p0: name }); return; }
            names.push(name); ph.push('?'); params.push(null); return;
          }
          if (raw === '') return;             // 交给数据库默认值
          names.push(name); ph.push('?'); params.push(raw);
        });
        if (bad) { toast(bad, true); return true; }   // 保持对话框
        if (!names.length) { toast(I.t("app.fill_in_at_least_one_column_a4977a"), true); return true; }
        busy(true, I.t("app.inserting_2a9ad4"));
        try {
          const sql = 'INSERT INTO ' + q(d.editTable) +
            ' (' + names.map(q).join(', ') + ') VALUES (' + ph.join(', ') + ')';
          const r = await target.context.engine.run(sql, params, target.context.database);
          toast(I.t("app.rows_inserted_bbc58f", { p0: (r && r.rowsAffected) || 1 }));
          busy(false);
          if (contextOpen(target.context)) await persistConn(c);
          await reloadTableData(target);
          return false;                        // 关闭对话框
        } catch (e) {
          busy(false);
          toast(I.t("app.insert_failed_28cb78", { p0: e && I.detail(e) ? I.detail(e) : e }), true);
          return true;                         // 保持对话框，方便改
        }
      }, true);
    const first = m.querySelector('.add-val');
    if (first) setTimeout(() => first.focus(), 60);
  }

  /** 删除结果网格中选中的行 */
  async function deleteSelectedRows() {
    const target = editTarget(doc());
    if (!target) return;
    const d = target.data, c = target.context.connection;
    const tbody = document.querySelector('#resBody table.grid tbody');
    if (!tbody) { toast(I.t("app.no_data_to_delete_ce0e20"), true); return; }
    const trs = Array.from(tbody.querySelectorAll('tr.selected'));
    if (!trs.length) { toast(I.t("app.select_the_rows_to_delete_first_6a8d2c"), true); return; }
    const idxs = trs.map(tr => {
      const td = tr.querySelector('td[data-row]');
      return td ? +td.dataset.row : -1;
    }).filter(i => i >= 0);
    if (!idxs.length) { toast(I.t("app.cannot_delete_without_row_identifiers_9d1cdc"), true); return; }
    const q = n => S.quoteIdentFor(n, dialectOf(c));
    const extra = d.editKeyType === 'cols'
      ? I.t("app.this_table_has_no_primary_key_149a3a") : '';
    await confirmThen(I.t("app.delete_rows_8ed1bd"),
      I.t("app.delete_rows_from_this_cannot_be_a0c106", { p0: esc(d.editTable), p1: idxs.length, p2: extra }),
      async () => {
        if (!editTargetCurrent(target)) { toast(I.t("app.the_result_changed_or_the_connection_0e68fc"), true); return; }
        let n = 0;
        for (const i of idxs) {
          if (!contextOpen(target.context)) { toast(I.t("app.connection_closed_deletion_stopped_d368b3"), true); return; }
          const w = rowWhere(d, i, q);
          const r = await target.context.engine.run('DELETE FROM ' + q(d.editTable) + ' WHERE ' + w.where,
            w.params, target.context.database);
          n += (r && r.rowsAffected) || 0;
        }
        toast(I.t("app.rows_deleted_5303fe", { p0: n }));
        if (contextOpen(target.context)) await persistConn(c);
        await reloadTableData(target);
      }, true);
  }

  /** 结果面板上的编辑态提示与「增/删」按钮显隐 */
  function updateRowActions(d) {
    const add = $('#btnRowAdd'), del = $('#btnRowDel'), hint = $('#editHint');
    if (!add || !del || !hint) return;
    const editable = !!(d && d.editTable && d.result && !d.isView && !d.queryRunning && contextActive(d.resultContext));
    add.style.display = editable ? '' : 'none';
    del.style.display = editable ? '' : 'none';
    if (!editable) { hint.style.display = 'none'; I.text(hint, ''); return; }
    hint.style.display = '';
    I.html(hint, I.t("app.editable_ab4d79", { p0: esc(d.editTable), p1: d.editNote ? I.join([' <span class="warn">· ', esc(d.editNote), '</span>']) : I.t("app.double_click_a_cell_to_edit_573959") }));
    I.attr(hint, 'title', d.editKeyType === 'rowid' ? I.t("app.rows_are_matched_by_sqlite_rowid_06486e")
      : d.editKeyType === 'pk' ? I.t("app.rows_are_matched_by_primary_key_78a9f1")
        : I.t("app.this_table_has_no_primary_key_a24d48"));
  }

  /** 复制选中的行（制表符分隔，可直接粘进 Excel） */
  function copySelectedRows() {
    const d = doc();
    const tbody = document.querySelector('#resBody table.grid tbody');
    if (!tbody || !d || !d.result) { toast(I.t("app.no_data_to_copy_251384"), true); return; }
    const trs = Array.from(tbody.querySelectorAll('tr.selected'));
    if (!trs.length) { toast(I.t("app.select_the_rows_to_copy_first_a863c7"), true); return; }
    const lines = trs.map(tr => Array.from(tr.querySelectorAll('td')).slice(1)
      .map(td => td.classList.contains('null') ? '' : td.textContent).join('\t'));
    copyText(lines.join('\n'));
    toast(I.t("app.rows_copied_5ef708", { p0: lines.length }));
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
    if (!d || !d.result) { toast(I.t("app.no_results_to_export_95cbfc"), true); return; }
    download('result.csv', '\ufeff' + resultToCsv(d), 'text/csv;charset=utf-8');
    toast(I.t("app.csv_exported_3b0e6a"));
  });
  $('#btnResJson').addEventListener('click', () => {
    const d = doc();
    if (!d || !d.result) { toast(I.t("app.no_results_to_export_95cbfc"), true); return; }
    const arr = d.result.values.map(r => {
      const o = {};
      d.result.columns.forEach((c, i) => o[c] = r[i]);
      return o;
    });
    download('result.json', JSON.stringify(arr, null, 2), 'application/json');
    toast(I.t("app.json_exported_6cfe08"));
  });
  $('#btnResCopy').addEventListener('click', () => {
    const d = doc();
    if (!d || !d.result) { toast(I.t("app.no_results_to_copy_44dcab"), true); return; }
    copyText(resultToCsv(d));
    toast(I.t("app.results_copied_to_clipboard_ce57d5"));
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

  // 打开文件选择器前就固定目标；用户选文件或读取文件时切换界面不能改变目标。
  function pickScriptFile(c = conn()) {
    const context = queryContext(c);
    if (!contextOpen(context)) { toast(I.t("app.select_an_available_connection_first_8797b9"), true); return; }
    pickFile('.sql,.txt', file => runScriptFile(file, context));
  }
  function pickCsvFile(tableName, database, c = conn()) {
    const context = queryContext(c, database);
    if (!contextOpen(context) || !tableName) { toast(I.t("app.select_the_table_to_import_into_b0ce49"), true); return; }
    pickFile('.csv,.txt', file => importCsvToTable(file, tableName, context.database, context));
  }
  function pickSelectedCsvFile() {
    const row = $('#tree .node.selected');
    const item = row && row._k;
    const c = row && state.conns.find(value => value.id === row._connId);
    pickCsvFile(item && item.type === 'table' ? item.name : null, item && item._db, c || null);
  }

  async function exportDb(c = conn()) {
    if (!c || !state.conns.includes(c)) { toast(I.t("app.connection_closed_or_unavailable_aff9ee"), true); return; }
    try {
      const bytes = await c.engine.exportBinary();
      download(c.name.replace(/[^\w\u4e00-\u9fa5.-]+/g, '_') + '.db', new Blob([bytes], { type: 'application/octet-stream' }));
      toast(I.t("app.database_file_exported_4c6656"));
    } catch (e) { toast(I.t("app.export_failed_a53238", { p0: I.detail(e) }), true); }
  }

  async function exportTableCsv(name, db) {
    const r = await execSql('SELECT * FROM ' + qid(name) + ';', db ? { database: db } : undefined);
    if (!r || r.error) { toast(I.t("app.export_failed_a53238", { p0: (r && r.error) || '' }), true); return; }
    if (!r.sets.length) { toast(I.t("app.table_is_empty_83c62b"), true); return; }
    const set = r.sets[r.sets.length - 1];
    const q = s => { s = s === null || s === undefined ? '' : String(s); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [set.columns.map(q).join(',')];
    set.values.forEach(row => lines.push(row.map(q).join(',')));
    download(name + '.csv', '\ufeff' + lines.join('\r\n'), 'text/csv;charset=utf-8');
    toast(I.t("app.exported_csv_129af1", { p0: name }));
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

  async function importCsvToTable(file, tableName, db, context = queryContext(conn(), db)) {
    if (!contextOpen(context)) { toast(I.t("app.the_import_connection_is_closed_or_12c69b"), true); return; }
    let text;
    try { text = await readFile(file, true); }
    catch (e) { toast(I.t("app.failed_to_read_csv_e5644e", { p0: I.detail(e) }), true); return; }
    if (!contextOpen(context)) { toast(I.t("app.the_import_connection_is_closed_732486"), true); return; }
    const rows = parseCsv(text).filter(r => r.length && !(r.length === 1 && r[0] === ''));
    if (!rows.length) { toast(I.t("app.csv_is_empty_eb79e7"), true); return; }
    const header = rows[0], data = rows.slice(1);
    const e = context.engine, c0 = context.connection;
    const tbl = findTable(tableName, context.database, c0);
    // 远程表的列是懒加载的，未展开过时 tbl.columns 为空，需要先读取
    let colInfo = tbl && tbl.columns;
    if (!colInfo && e.columns) {
      try { colInfo = await e.columns(context.database, tableName); if (tbl) tbl.columns = colInfo; }
      catch (err) { colInfo = null; }
    }
    if (!contextOpen(context)) { toast(I.t("app.the_import_connection_is_closed_732486"), true); return; }
    const tableCols = colInfo ? colInfo.map(x => x.name) : [];
    if (!tableCols.length) { toast(I.t("app.cannot_read_column_information_for_table_0c29eb", { p0: tableName }), true); return; }
    // 保留表头在文件中的原始位置，忽略空表头时不能把后续数据列向前移动。
    const mapping = header.map((name, index) => ({ name: name.trim(), index })).filter(col => col.name);
    const useCols = mapping.map(col => col.name);
    if (!useCols.length) { toast(I.t("app.csv_has_no_valid_column_names_13e9fb"), true); return; }
    if (new Set(useCols).size !== useCols.length) { toast(I.t("app.csv_header_contains_duplicate_column_names_48697f"), true); return; }
    const unknown = useCols.filter(name => !tableCols.includes(name));
    if (unknown.length) { toast(I.t("app.csv_contains_unknown_columns_5dbf2a", { p0: unknown.join(', ') }), true); return; }
    if (!data.length) { toast(I.t("app.csv_has_no_data_rows_854b6f"), true); return; }

    await confirmThen(I.t("app.import_csv_into_6d066e", { p0: c0.name, p1: context.database ? ' / ' + context.database : '', p2: tableName }),
      I.t("app.rows_will_be_imported_using_these_bd1ed9", { p0: data.length, p1: esc(useCols.join(', ')) }),
      async () => {
        if (!contextOpen(context)) { toast(I.t("app.the_import_connection_is_closed_732486"), true); return; }
        const ph = useCols.map(() => '?').join(', ');
        const sql = 'INSERT INTO ' + qid(tableName, c0) + ' (' + useCols.map(x => qid(x, c0)).join(', ') + ') VALUES (' + ph + ')';
        const idxs = mapping.map(col => col.index);
        let ok = 0, fail = 0, firstErr = '';
        // 只有浏览器内 SQLite（有 e.db）才包一层本地事务；远程引擎每条语句独立执行
        const localTx = !!(e.db && e.db.run);
        busy(true, I.t("app.importing_f6dc1b"), '0 / ' + data.length);
        try {
          if (localTx) e.db.run('BEGIN');
          for (let i = 0; i < data.length; i++) {
            if (!contextOpen(context)) throw I.error(I.t("app.target_connection_closed_import_stopped_6cb524"));
            const vals = idxs.map(ix => {
              const v = ix >= 0 ? data[i][ix] : null;
              return v === '' || v === undefined ? null : v;
            });
            // 必须 await：远程引擎的 run 是异步的，不等待会并发发出全部请求且错误无法捕获
            try { await e.run(sql, vals, context.database); ok++; }
            catch (err) { fail++; if (!firstErr) firstErr = err && I.detail(err) ? I.detail(err) : String(err); }
            if (i % 200 === 0) { busy(true, I.t("app.importing_f6dc1b"), i + ' / ' + data.length); await new Promise(r => setTimeout(r, 0)); }
          }
          if (localTx) e.db.run('COMMIT');
        } catch (err) {
          try { if (localTx) e.db.run('ROLLBACK'); } catch (x) { /* ignore */ }
          if (localTx) ok = 0;
          fail = data.length - ok;
          firstErr = firstErr || (err && I.detail(err)) || String(err);
        }
        busy(false);
        let followupError = '';
        if (contextOpen(context)) {
          try {
            await persistConn(c0);
            await refreshConnSchema(c0, context.database);
            renderTree(); updateStatus();
          } catch (err) { followupError = I.t("app.save_or_refresh_failed_33bbf8", { p0: I.detail(err) }); }
        }
        toast(I.t("app.import_complete_rows_succeeded_f267db", { p0: ok, p1: fail ? I.t("app.rows_failed_first_error_ceae89", { p0: fail, p1: firstErr }) : '', p2: followupError }), fail > 0 || !!followupError);
      });
  }

  async function importDbFile(file) {
    const buf = await readFile(file, false);
    const bytes = new Uint8Array(buf);
    // 校验是否为 SQLite 文件
    const magic = String.fromCharCode.apply(null, bytes.slice(0, 15));
    if (magic !== 'SQLite format 3') {
      toast(I.t("app.not_a_valid_sqlite_database_file_4ce2a0"), true);
      return;
    }
    state.connSeq++;
    const name = file.name.replace(/\.(db|sqlite|sqlite3)$/i, '');
    busy(true, I.t("app.opening_database_bda6b0"), file.name);
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
      toast(I.t("app.opened_database_tables_bedfc5", { p0: name, p1: c.schema.tables.length }));
    } catch (e) {
      toast(I.t("app.open_failed_0ed1e1", { p0: I.detail(e) }), true);
    }
    busy(false);
  }

  async function runScriptFile(file, context = queryContext(conn())) {
    if (!contextOpen(context)) { toast(I.t("app.the_script_s_target_connection_is_024ea8"), true); return; }
    let text;
    try { text = await readFile(file, true); }
    catch (e) { toast(I.t("app.failed_to_read_sql_file_740c6e", { p0: I.detail(e) }), true); return; }
    if (!contextOpen(context)) { toast(I.t("app.the_script_s_target_connection_is_a155c4"), true); return; }
    if (!text.trim()) { toast(I.t("app.script_is_empty_713320"), true); return; }
    // 文件在独立标签页执行，既不拼接已有 SQL，也不沿用旧编辑器的选区。
    const d = newDoc(text, file.name || I.t("app.imported_script_sql_235e99"));
    await runQuery({ document: d, context, sql: text });
  }

  async function scriptInsert(name, db) {
    const r = await execSql(selectTopSql(name, 200), db ? { database: db } : undefined);
    if (!r || r.error || !r.sets.length) { toast(I.t('app.scriptFailed'), true); return; }
    const set = r.sets[r.sets.length - 1];
    const q = v => v === null || v === undefined ? 'NULL'
      : typeof v === 'number' ? String(v)
        : "'" + String(v).replace(/'/g, "''") + "'";
    let out = '-- INSERT 脚本：' + name + '（前 ' + set.values.length + ' 行）\n';
    set.values.forEach(row => {
      out += 'INSERT INTO ' + qid(name) + ' (' + set.columns.map(x => qid(x)).join(', ') + ') VALUES (' + row.map(q).join(', ') + ');\n';
    });
    showDdl(out, I.t('app.insertScript', { name }), true);
  }

  /* ==========================================================
   * 12. 新建连接对话框
   * ========================================================== */
  const DRIVER_INFO = {
    'sqlite-local': {
      title: 'SQLite', tag: I.t("app.in_browser_76f92c"), remote: false,
      desc: I.t("app.built_in_local_engine_available_offline_9c5689")
    },
    sqlite: {
      title: 'SQLite', tag: I.t("app.server_file_e00110"), remote: false,
      desc: I.t("app.open_a_db_file_on_the_8b1680")
    },
    mysql: {
      title: 'MySQL / MariaDB', tag: I.t("app.remote_7ba009"), remote: true, port: 3306,
      desc: I.t("app.connect_to_a_remote_mysql_server_8b5a9c")
    },
    postgres: {
      title: 'PostgreSQL', tag: I.t("app.remote_7ba009"), remote: true, port: 5432, database: 'postgres',
      desc: I.t("app.connect_to_remote_postgresql_through_pg_3b72bc")
    },
    mssql: {
      title: 'SQL Server', tag: I.t("app.remote_7ba009"), remote: true, port: 1433, database: 'master',
      desc: I.t("app.connect_to_remote_sql_server_through_ddbfcc")
    }
  };

  function fRow(label, inner) {
    return I.join(['<div class="m-row"><label>', label, '</label>', inner, '</div>']);
  }
  function fHint(text) { return I.join(['<div class="m-hint">', text, '</div>']); }
  function fVal(m, sel) { const e = m.querySelector(sel); return e ? e.value.trim() : ''; }

  function renderConnFields(container, driverId) {
    const info = DRIVER_INFO[driverId] || {};
    let h = '';
    if (driverId === 'sqlite-local') {
      h = I.join([h, fRow(I.t("app.connection_name_228c3a"), I.t("app.message_bb795d"))]);
      h = I.join([h, fRow(I.t("app.open_file_4c8a4e"), I.t("app.choose_a_db_sqlite_file_c4e277"))]);
      h = I.join([h, fHint(I.t("app.leave_unselected_to_create_an_empty_2f4578"))]);
      h = I.join([h, fRow(I.t("app.persistence_97ed1a"), I.t("app.save_in_browser_kept_after_reload_46fb88"))]);
    } else if (driverId === 'sqlite') {
      h = I.join([h, fRow(I.t("app.connection_name_228c3a"), I.t("app.message_930801"))]);
      h = I.join([h, fRow(I.t("app.file_path_c71200"), I.t("app.message_c3b6ae"))]);
      h = I.join([h, fHint(I.t("app.enter_an_absolute_path_on_the_d1764a"))]);
    } else {
      h = I.join([h, fRow(I.t("app.connection_name_228c3a"), I.join(['<input type="text" id="fName" value="', info.title, '">']))]);
      h = I.join([h, fRow(I.t("app.host_e87d9f"), I.t("app.message_ef740e"))]);
      h = I.join([h, fRow(I.t("app.port_e71ac3"), I.join(['<input type="text" id="fPort" value="', info.port || '', '">']))]);
      h = I.join([h, fRow(I.t("app.username_1a3f06"), '<input type="text" id="fUser" placeholder="root">')]);
      h = I.join([h, fRow(I.t("app.password_a621ab"), I.t("app.message_076d6d"))]);
      h = I.join([h, fRow(I.t("app.database_263200"), I.t("app.message_9a1723", { p0: info.database || '' }))]);
      if (driverId === 'mssql') {
        h = I.join([h, fRow(I.t("app.encryption_320c25"), I.t("app.require_encryption_recommended_no_encryption_f72c81"))]);
      }
      h = I.join([h, fRow(I.t("app.save_password_2e9f48"), I.t("app.do_not_save_safer_save_in_327c17"))]);
      h = I.join([h, fHint(I.t("app.connections_go_through_the_local_backend_af81af"))]);
    }
    I.html(container, h);

    if (driverId === 'sqlite-local') {
      const btn = container.querySelector('#fPick');
      btn.addEventListener('click', () => {
        pickFile('.db,.sqlite,.sqlite3', f => {
          container._pickedFile = f;
          I.text(btn, f.name);
          container.querySelector('#fName').value = f.name.replace(/\.(db|sqlite|sqlite3)$/i, '');
        });
      });
    }
  }

  function connDialog() {
    const avail = Object.fromEntries((state.drivers || []).map(d => [d.id, d]));
    const order = ['sqlite-local', 'sqlite', 'mysql', 'postgres', 'mssql'];
    const cards = I.join(order.map(id => {
      const info = DRIVER_INFO[id];
      const backend = avail[id];
      const missing = id !== 'sqlite-local' && backend && backend.available === false;
      const reason = backend?.reasonKey ? I.t(backend.reasonKey) : backend?.reason || I.t("app.driver_not_installed_143ec2");
      return I.join(['<div class="engine-card', id === 'sqlite-local' ? ' sel' : '', missing ? ' disabled' : '', '" data-driver="', id, '"', missing ? I.join([' title="', esc(reason), '"']) : '', '>', '<div class="ec-t">', info.title, missing ? I.t("app.not_installed_dd0a98") : '', '</div>', '<div class="ec-d"><span class="tag" style="margin-right:6px">', info.tag, '</span>', info.desc, '</div>', '</div>']);
    }));

    const html =
      I.join(['<div id="savedBox"></div>', '<div class="engine-pick" id="driverPick" style="flex-wrap:wrap;gap:8px">', cards, '</div>', '<div id="connFields"></div>']);

    const m = openModal(I.t("app.new_connection_2cb204"), html,
      I.t("app.test_connection_connect_cancel_b11dea"),
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
          toast(b?.reasonKey ? I.t(b.reasonKey) : b?.reason || I.t("app.this_driver_is_not_installed_1ecc89"), true);
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
    } catch (e) { I.html(box, ''); return; }
    if (!list.length) { I.html(box, ''); return; }

    I.html(box, I.t("app.recent_connections_click_to_connect_9c5549", { p0: I.join(list.map(s =>
        I.t("app.message_748deb", { p0: esc(s.id), p1: esc([s.driver, s.host ? (s.host + (s.port ? ':' + s.port : '')) : s.file].filter(Boolean).join(' · ')), p2: esc(s.name), p3: esc(s.driver), p4: s.hasPassword ? I.t("app.message_e9efe7") : '', p5: esc(s.id) }))) }));

    box.querySelectorAll('.saved-item').forEach(el => {
      el.addEventListener('click', async e => {
        const delId = e.target.getAttribute && e.target.getAttribute('data-del');
        if (delId) {
          e.stopPropagation();
          try { await S.api('/api/saved/delete', { id: delId }); toast(I.t("app.connection_entry_deleted_ce9eb5")); }
          catch (err) { toast(I.t("app.delete_failed_9619d7", { p0: I.detail(err) }), true); }
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
    const name = fVal(m, '#fName') || (DRIVER_INFO[driverId] || {}).title || I.resolve(I.t("app.unnamed_connection_e484c1"));

    if (driverId === 'sqlite-local') {
      return { driver: 'sqlite-local', name, persist: fVal(m, '#fPersist') === '1', file: fields._pickedFile || null };
    }
    if (driverId === 'sqlite') {
      return { driver: 'sqlite', name, file: fVal(m, '#fFile') || ':memory:' };
    }
    const host = fVal(m, '#fHost');
    const user = fVal(m, '#fUser');
    if (!host) { toast(I.t("app.enter_a_host_address_4b2767"), true); return null; }
    if (!user) { toast(I.t("app.enter_a_username_9b305a"), true); return null; }
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
    busy(true, I.t("app.testing_connection_01a675"), (cfg.host ? cfg.host + ':' + cfg.port : cfg.file) || '');
    try {
      if (cfg.driver === 'sqlite-local') {
        const e = S.create('sqlite');
        let data = null;
        if (cfg.file) data = new Uint8Array(await readFile(cfg.file, false));
        await e.open({ data: data || undefined, name: cfg.name });
        const sc = await e.schema();
        e.close();
        busy(false);
        toast(I.t("app.connected_sqlite_tables_af3c3e", { p0: sc.tables.length }));
        return;
      }
      const meta = await S.api('/api/connect', cfg);
      await S.api('/api/disconnect', { connId: meta.connId });
      busy(false);
      toast(I.t("app.connected_databases_194d79", { p0: meta.dialect === 'sqlite' ? I.t('driver.sqliteLabel') : meta.label, p1: meta.serverVersion || '', p2: (meta.databases || []).length }));
    } catch (e) {
      busy(false);
      toast(I.t("app.test_failed_2c6417", { p0: I.detail(e) }), true);
    }
  }

  async function doCreateConnection(cfg) {
    /* ---- 浏览器内 SQLite ---- */
    if (cfg.driver === 'sqlite-local') {
      busy(true, I.t("app.creating_connection_f98e7b"), I.t("app.initializing_sqlite_engine_ca5d39"));
      try {
        state.connSeq++;
        const id = 'conn_' + Date.now() + '_' + state.connSeq;
        let data = null;
        if (cfg.file) {
          data = new Uint8Array(await readFile(cfg.file, false));
          const magic = String.fromCharCode.apply(null, data.slice(0, 15));
          if (magic !== 'SQLite format 3') throw I.error(I.t("app.not_a_valid_sqlite_database_file_4ce2a0"));
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
        toast(I.t("app.connected_tables_62d4be", { p0: cfg.name, p1: c.schema.tables.length }));
        if (!state.docs.length) newDoc(welcomeSql(c));
      } catch (e) {
        busy(false);
        toast(I.t("app.failed_to_create_connection_df0501", { p0: I.detail(e) }), true);
      }
      return;
    }

    /* ---- 远程服务器 / 服务端文件 ---- */
    busy(true, I.t("app.connecting_8be0ea"), (cfg.host ? cfg.host + ':' + cfg.port : cfg.file) || '');
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
      toast(I.t("app.connected_2ffdfc", { p0: cfg.name, p1: engine.label, p2: engine.serverVersion || '', p3: dbCount ? I.t("app.databases_86aef9", { p0: dbCount }) : '' }));

      if (cfg.driver) {
        try { await S.api('/api/saved', cfg); } catch (e) { /* 保存失败不影响使用 */ }
      }
      if (!state.docs.length) newDoc(welcomeSql(c));
    } catch (e) {
      busy(false);
      toast(I.t("app.connection_failed_82200f", { p0: I.detail(e) }), true);
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
    if (!c) { if (!silent) toast(I.t("app.select_a_connection_first_b6e444"), true); return; }
    try {
      await refreshConnSchema(c);
      renderTree();
      updateStatus();
      if (!silent) toast(I.t("app.refreshed_69488d", { p0: c.name }));
    } catch (e) { if (!silent) toast(I.t("app.refresh_failed_64464d", { p0: I.detail(e) }), true); }
  }
  function updateStatus() {
    const c = conn();
    const dot = $('#sbDot'), txt = $('#sbConn');
    if (c) {
      dot.classList.remove('off');
      I.text(txt, c.name);
      let engineLabel = 'SQLite';
      if (c.engineKind === 'remote') engineLabel = c.engine.label || c.driver || I.t("app.remote_7ba009");
      else if (c.engineKind === 'duckdb') engineLabel = 'DuckDB';
      I.text($('#sbEngine'), engineLabel);

      const sc = c.schema;
      if (sc && sc.tables) {
        let objTxt = I.t("app.tables_views_7b8fbe", { p0: sc.tables.length, p1: (sc.views || []).length });
        const nr = (sc.procedures || []).length + (sc.functions || []).length;
        if (nr) objTxt = I.join([objTxt, I.t("app.routines_892fc9", { p0: nr })]);
        I.text($('#sbObjects'), objTxt);
      } else {
        I.text($('#sbObjects'), '');
      }

      if (c.engineKind === 'remote') {
        const v = c.engine.serverVersion || '';
        const host = c.host ? (I.join([c.host, c.port ? I.join([':', c.port]) : ''])) : (c.file || '');
        I.text($('#sbPersist'), I.join([host, v ? I.join(['  ·  v', v.split(' ')[0].slice(0, 18)]) : '']));
      } else {
        I.text($('#sbPersist'), c.persist ? I.t("app.persisted_7a5830") : I.t("app.session_only_0b4596"));
      }
    } else {
      dot.classList.add('off');
      I.text(txt, I.t("app.not_connected_3d5257"));
      I.text($('#sbEngine'), '—');
      I.text($('#sbObjects'), '');
      I.text($('#sbPersist'), '');
    }
    updateDbSwitcher();
  }

  /* 工具栏：当前数据库切换 */
  function updateDbSwitcher() {
    const el = document.getElementById('curDb');
    const btn = document.getElementById('btnDb');
    if (!el) return;
    const c = conn();
    if (!c) { I.text(el, '—'); if (btn) btn.classList.add('disabled'); return; }
    if (btn) btn.classList.remove('disabled');
    if (c.engineKind === 'remote') I.text(el, c.engine.currentDatabase || '—');
    else I.text(el, c.name);
  }

  function showDbMenu(x, y) {
    const c = conn();
    if (!c) { toast(I.t("app.select_a_connection_first_4b5240"), true); return; }
    if (c.engineKind !== 'remote') { toast(I.t("app.this_connection_has_only_one_database_ae8dd0")); return; }
    const dbs = c.engine.databases || [];
    if (!dbs.length) { toast(I.t("app.no_database_list_available_446888")); return; }
    const cur = c.engine.currentDatabase;
    const html = I.t("app.switch_database_be1c65", { p0: dbs.length, p1: I.join(dbs.map(db => I.join(['<div class="c-item" data-db="', esc(db), '">', '<span class="c-ico">', db === cur ? '✓' : '', '</span>', esc(db), '</div>']))) });
    showMenu(x, y, html);
  }

  function confirmThen(title, msg, onOk, danger) {
    return new Promise(res => {
      const m = openModal(esc(title), I.join(['<div style="line-height:1.8">', msg, '</div>']),
        I.t("app.ok_cancel_7bf9e8", { p0: danger ? 'danger' : 'primary' }),
        async (mm) => {
          busy(true, I.t("app.executing_195f0f"));
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
    'templates': () => S.Templates.openLibrary(templateBridge()),
    'save-template': saveSqlTemplate,
    'open-db': () => pickFile('.db,.sqlite,.sqlite3', importDbFile),
    'import-csv': () => pickSelectedCsvFile(),
    'run-script': () => pickScriptFile(),
    'export-db': exportDb,
    'save': async () => { await saveAllDirty(); const d = doc(); if (d) { d.dirty = false; renderDocs(); } toast(I.t("app.saved_in_this_browser_cc5a30")); },
    'execute': runQuery,
    'explain': explainQuery,
    'routine-ddl': () => { if (ctxData) openRoutine(ctxData._obj, ctxData._db); },
    'routine-call': () => { if (ctxData) insertQuery(routineCallScript(ctxData._obj)); },
    'cancel': () => { $('#progBar').style.width = '0%'; status(I.t("app.cancelled_a37778")); toast(I.t("app.cancellation_requested_0a8b91")); },
    'refresh': () => doRefresh(),
    'theme': () => {
      const r = document.documentElement;
      const next = r.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      r.setAttribute('data-theme', next);
      localStorage.setItem('sqltool.theme', next);
      toast(I.t("app.switched_to_theme_8a1aa0", { p0: next === 'dark' ? I.t("app.dark_a6b75d") : I.t("app.light_ssms_classic_267b3b") }));
    },
    'collapse': () => {
      treeEl.querySelectorAll('.children').forEach(u => u.classList.add('collapsed'));
      treeEl.querySelectorAll('.caret').forEach(c => c.classList.remove('open'));
      toast(I.t("app.all_nodes_collapsed_07ad7e"));
    },
    'about': () => openModal(I.t("app.about_sqltool_0d5dbb"),
      I.t("app.sqltool_database_workbench_interface_inspired_by_9de5b4"), null, null, true),
    'copy-sel': () => {
      const s = sqlEl.value.substring(sqlEl.selectionStart, sqlEl.selectionEnd);
      if (!s) { toast(I.t("app.select_content_to_copy_first_fe7a2f"), true); return; }
      copyText(s); toast(I.t("app.characters_copied_2e3d7e", { p0: s.length }));
    },
    'paste-sel': async () => {
      try {
        const t = await navigator.clipboard.readText();
        if (!t) { toast(I.t("app.clipboard_is_empty_62b92f"), true); return; }
        sqlEl.setRangeText(t, sqlEl.selectionStart, sqlEl.selectionEnd, 'end');
        const d = doc(); if (d) { d.dirty = true; renderDocs(); }
        updateEditor();
      } catch (e) { toast(I.t("app.clipboard_access_was_denied_use_ctrl_686623"), true); }
    },
    'select-all': () => { sqlEl.focus(); sqlEl.select(); },
    'format': () => {
      const d = doc(); if (!d) return;
      sqlEl.value = formatSql(sqlEl.value, dialectOf(conn()));
      d.sql = sqlEl.value; d.dirty = true;
      renderDocs(); updateEditor();
      toast(I.t("app.sql_formatted_2b2630"));
    },
    'toggle-explorer': () => {
      const ex = $('#explorer'), sp = $('#splitV');
      const hid = ex.style.display === 'none';
      ex.style.display = hid ? '' : 'none';
      sp.style.display = hid ? '' : 'none';
    },
    'shortcuts': () => openModal(I.t("app.keyboard_shortcuts_89ce48"),
      I.t("app.f5_run_current_sql_ctrl_f5_fd72ea"), null, null, true),
    'complete': () => { sqlEl.focus(); acTrigger(true); },
    'clear-db': () => {
      const c = conn();
      if (c && c.engineKind === 'remote') {
        toast(I.t("app.clear_database_is_disabled_for_remote_1168dd"), true);
        return;
      }
      return confirmThen(I.t("app.clear_current_database_67f204"),
      I.t("app.this_deletes_all_tables_views_and_5d07a9"),
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
        toast(I.t("app.database_cleared_782c75"));
      }, true);
    }
  };

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

    busy(true, I.t("app.initializing_9866f8"), I.t("app.loading_sqlite_engine_e48ff6"));
    try {
      await S.engines.sqlite.ensureLib();
    } catch (e) {
      busy(false);
      toast(I.t("app.engine_failed_to_load_open_through_74f75d", { p0: I.detail(e) }), true);
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
      newDoc(welcomeSql({ name: I.t("app.not_connected_3d5257"), engineKind: 'sqlite' }));
      renderResult();
    }
    status(I.t("app.ready_b073db"));
    if (state.backendDown) {
      toast(I.t("app.local_backend_not_detected_mysql_postgresql_52cff8"), true);
    }
    // 启动完成标志。注意 #sbStatus 的静态初值本身就是「就绪」，
    // 所以外部（自动化测试）不能靠它判断初始化是否结束，必须用这个标志。
    window.__booted = true;
  }

  boot();
})();
