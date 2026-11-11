/* SQL 模板库：独立本地存储、文件交换及管理界面。 */
(function (global) {
  'use strict';

  const DIALECTS = { all: '通用 SQL', sqlite: 'SQLite', mysql: 'MySQL / MariaDB', postgres: 'PostgreSQL', mssql: 'SQL Server' };
  const MAX_ITEMS = 1000, MAX_SQL = 500000, MAX_FILE = 10 * 1024 * 1024;
  let dbPromise = null;

  function openStore() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open('sqltool-templates', 1);
      let failed = false;
      const fail = error => { failed = true; dbPromise = null; reject(error); };
      request.onupgradeneeded = () => request.result.createObjectStore('templates', { keyPath: 'id' });
      request.onerror = () => fail(new Error('无法打开模板库：' + request.error.message));
      request.onblocked = () => fail(new Error('模板库被其他页面占用，请关闭其他页面后重试'));
      request.onsuccess = () => {
        const db = request.result;
        if (failed) { db.close(); return; }
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
    });
    // 打开失败后允许重试，包括浏览器直接拒绝 indexedDB.open 的情况。
    dbPromise = dbPromise.catch(error => { dbPromise = null; throw error; });
    return dbPromise;
  }

  async function transaction(mode, work) {
    const db = await openStore();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('templates', mode);
      let result, failure;
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(failure || tx.error || new Error('模板库操作失败'));
      const abort = error => { failure = error; tx.abort(); };
      try { work(tx.objectStore('templates'), value => { result = value; }, abort); }
      catch (error) { abort(error); }
    });
  }

  function normalize(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模板必须是对象');
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 120) throw new Error('模板名称须为 1–120 个字符');
    if (typeof value.sql !== 'string' || !value.sql.trim() || value.sql.length > MAX_SQL) throw new Error('SQL 正文不能为空，且不能超过 500,000 个字符');
    const dialect = value.dialect === undefined ? 'all' : value.dialect;
    if (typeof dialect !== 'string' || !Object.prototype.hasOwnProperty.call(DIALECTS, dialect)) throw new Error('不支持的数据库方言');
    const description = value.description === undefined ? '' : value.description;
    if (typeof description !== 'string' || description.length > 2000) throw new Error('说明不能超过 2,000 个字符');
    const tags = value.tags === undefined ? [] : value.tags;
    if (!Array.isArray(tags) || tags.length > 20 || tags.some(t => typeof t !== 'string' || t.trim().length > 40)) throw new Error('最多 20 个标签，每个标签不超过 40 个字符');
    if (tags.some(t => /[,，]/.test(t))) throw new Error('单个标签不能包含逗号，请拆分为多个标签');
    return { name: value.name.trim(), sql: value.sql, dialect, description,
      tags: Array.from(new Set(tags.map(t => t.trim()).filter(Boolean))) };
  }

  const fingerprint = item => JSON.stringify([item.name, item.sql, item.dialect, item.description, item.tags.slice().sort()]);
  const fresh = value => ({ ...value, id: crypto.randomUUID(), revision: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

  const store = {
    list: () => transaction('readonly', (s, done) => { s.getAll().onsuccess = e => done(e.target.result); }),
    save(value, original) {
      const item = normalize(value);
      return transaction('readwrite', (s, done, abort) => {
        if (original) {
          s.get(original.id).onsuccess = e => {
            const current = e.target.result;
            if (!current || current.revision !== original.revision) return abort(new Error('模板已被其他页面修改或删除，请重新打开后编辑'));
            const updated = { ...current, ...item, revision: current.revision + 1, updatedAt: new Date().toISOString() };
            s.put(updated); done(updated);
          };
        } else {
          s.count().onsuccess = e => {
            if (e.target.result >= MAX_ITEMS) return abort(new Error('模板库最多保存 1,000 项，请先整理或导出备份'));
            const created = fresh(item); s.add(created); done(created);
          };
        }
      });
    },
    remove(original) {
      return transaction('readwrite', (s, done, abort) => {
        s.get(original.id).onsuccess = e => {
          const current = e.target.result;
          if (!current || current.revision !== original.revision) return abort(new Error('模板已被其他页面修改或删除，请刷新后重试'));
          s.delete(original.id); done();
        };
      });
    },
    importItems(items) {
      // 在开启事务前完成所有校验；事务中的请求同步发出，不插入 await。
      if (!Array.isArray(items) || !items.length || items.length > MAX_ITEMS) throw new Error('导入文件须包含 1–1,000 个模板');
      const clean = items.map((value, index) => {
        try { return normalize(value); } catch (error) { throw new Error('第 ' + (index + 1) + ' 项：' + error.message); }
      });
      return transaction('readwrite', (s, done, abort) => {
        s.getAll().onsuccess = e => {
          const existing = e.target.result, seen = new Set(existing.map(fingerprint)), added = [];
          clean.forEach(item => { const key = fingerprint(item); if (!seen.has(key)) { seen.add(key); added.push(fresh(item)); } });
          if (existing.length + added.length > MAX_ITEMS) return abort(new Error('导入后将超过 1,000 项，未写入任何模板'));
          added.forEach(item => s.add(item));
          done({ added: added.length, skipped: clean.length - added.length });
        };
      });
    }
  };

  function parseImport(text) {
    if (new Blob([text]).size > MAX_FILE) throw new Error('模板文件不能超过 10 MB');
    let value;
    try { value = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (error) { throw new Error('文件不是有效的 JSON'); }
    if (!value || value.format !== 'sqltool-templates' || value.version !== 1 || !Array.isArray(value.templates)) {
      throw new Error('文件格式不支持，请选择 SQLTool 导出的模板 JSON（版本 1）');
    }
    if (!value.templates.length || value.templates.length > MAX_ITEMS) throw new Error('导入文件须包含 1–1,000 个模板');
    return value.templates.map((item, index) => {
      try { return normalize(item); } catch (error) { throw new Error('第 ' + (index + 1) + ' 项：' + error.message); }
    });
  }

  function exportText(items) {
    const text = JSON.stringify({ format: 'sqltool-templates', version: 1, templates: items }, null, 2);
    if (new Blob([text]).size > MAX_FILE) throw new Error('导出内容超过 10 MB，请按搜索或方言筛选后分批导出');
    return text;
  }

  function filterItems(items, query, dialect) {
    const term = query.trim().toLocaleLowerCase();
    return items.filter(item => (!dialect || item.dialect === dialect) && (!term ||
      [item.name, item.sql, item.description, ...item.tags].join('\n').toLocaleLowerCase().includes(term)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name));
  }

  function options(all) {
    return (all ? '<option value="">全部方言</option>' : '') +
      Object.entries(DIALECTS).map(([value, name]) => '<option value="' + value + '">' + name + '</option>').join('');
  }

  function edit(bridge, value, original, onSaved) {
    let saving = false;
    const m = bridge.openModal(original ? '编辑 SQL 模板' : '保存 SQL 模板',
      '<div class="tpl-form">' +
      '<label>名称<input data-tpl-name type="text" maxlength="120" autocomplete="off"></label>' +
      '<div class="tpl-fields"><label>适用方言<select data-tpl-dialect>' + options(false) + '</select></label>' +
      '<label>标签（用逗号分隔）<input data-tpl-tags type="text" autocomplete="off"></label></div>' +
      '<label>说明<textarea data-tpl-description rows="2" maxlength="2000"></textarea></label>' +
      '<label>SQL 正文<textarea data-tpl-sql rows="11" spellcheck="false" maxlength="500000"></textarea></label>' +
      '<div class="tpl-error" data-tpl-error role="alert"></div></div>',
      '<button class="btn primary" data-ok>保存模板</button><button class="btn" data-cancel>取消</button>',
      async () => {
        if (saving) return true;
        saving = true; const button = m.querySelector('[data-ok]'); button.disabled = true;
        try {
          const saved = await store.save({ name: m.querySelector('[data-tpl-name]').value,
            dialect: m.querySelector('[data-tpl-dialect]').value, sql: m.querySelector('[data-tpl-sql]').value,
            description: m.querySelector('[data-tpl-description]').value,
            tags: m.querySelector('[data-tpl-tags]').value.split(/[,，]/).map(t => t.trim()).filter(Boolean) }, original);
          bridge.toast('模板已保存');
          if (onSaved) await onSaved(saved);
          return false;
        } catch (error) { m.querySelector('[data-tpl-error]').textContent = error.message; return true; }
        finally { saving = false; button.disabled = false; }
      }, true);
    m.classList.add('template-editor');
    m.querySelector('[data-tpl-name]').value = value.name || '';
    m.querySelector('[data-tpl-dialect]').value = value.dialect || 'all';
    m.querySelector('[data-tpl-tags]').value = (value.tags || []).join(', ');
    m.querySelector('[data-tpl-description]').value = value.description || '';
    m.querySelector('[data-tpl-sql]').value = value.sql || '';
    m.querySelector('[data-tpl-name]').focus();
    m.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); m.querySelector('[data-ok]').click(); }
    });
    return m;
  }

  function openLibrary(bridge) {
    let items = [], filtered = [], selectedId = null, loading = false, loadVersion = 0;
    const m = bridge.openModal('SQL 模板库',
      '<div class="tpl-toolbar"><input data-tpl-search type="search" placeholder="搜索名称、标签或 SQL…" aria-label="搜索模板">' +
      '<select data-tpl-filter aria-label="筛选数据库方言">' + options(true) + '</select>' +
      '<button class="btn" data-tpl-new>新建</button><button class="btn" data-tpl-import>导入 JSON</button><button class="btn" data-tpl-export>导出筛选结果</button>' +
      '<button class="btn" data-tpl-refresh>刷新</button></div>' +
      '<div class="tpl-target" data-tpl-target></div><div class="tpl-layout">' +
      '<div class="tpl-list" data-tpl-list aria-label="模板列表"></div><div class="tpl-detail">' +
      '<div class="tpl-detail-head"><h3 data-tpl-title>选择一个模板</h3><span class="tag" data-tpl-kind></span></div>' +
      '<div class="tpl-meta" data-tpl-meta></div><p class="tpl-description" data-tpl-note></p>' +
      '<pre class="tpl-preview" data-tpl-preview></pre></div></div>' +
      '<div class="tpl-bottom"><span data-tpl-count></span><span class="tpl-error" data-tpl-error role="alert"></span></div>',
      '<button class="btn" data-tpl-edit>编辑</button><button class="btn" data-tpl-copy>复制模板</button><button class="btn danger" data-tpl-delete>删除</button>' +
      '<span class="spacer"></span><button class="btn" data-tpl-insert></button><button class="btn primary" data-tpl-open>在新标签页打开</button><button class="btn" data-cancel>关闭</button>',
      null, true);
    m.classList.add('template-library');
    const el = name => m.querySelector('[data-tpl-' + name + ']');
    el('insert').textContent = bridge.selection ? '替换选中 SQL' : '插入光标处';
    const selected = () => items.find(item => item.id === selectedId);
    const error = message => { el('error').textContent = message || ''; };
    const targetText = () => '当前连接：' + bridge.target().label + ' · 打开或插入后，在编辑器执行；执行时使用工作台当前连接。';

    function renderDetail() {
      const item = selected();
      el('target').textContent = targetText();
      el('title').textContent = item ? item.name : '选择一个模板';
      el('kind').textContent = item ? DIALECTS[item.dialect] : '';
      el('note').textContent = item ? item.description : '';
      el('preview').textContent = item ? item.sql : '保存常用查询后，可以在这里搜索和复用。';
      el('meta').textContent = item ? (item.tags.length ? item.tags.join(' · ') + ' · ' : '') + '更新于 ' + new Date(item.updatedAt).toLocaleString() : '';
      ['edit', 'copy', 'delete', 'open', 'insert'].forEach(name => { el(name).disabled = !item || loading || (name === 'insert' && !bridge.canInsert); });
      el('export').disabled = !filtered.length || loading;
    }

    function render() {
      filtered = filterItems(items, el('search').value, el('filter').value);
      if (!filtered.some(item => item.id === selectedId)) selectedId = filtered.length ? filtered[0].id : null;
      el('list').replaceChildren();
      filtered.forEach(item => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'tpl-item';
        button.dataset.templateId = item.id; button.classList.toggle('active', item.id === selectedId);
        button.setAttribute('aria-pressed', String(item.id === selectedId));
        const title = document.createElement('strong'); title.textContent = item.name;
        const sub = document.createElement('span'); sub.textContent = DIALECTS[item.dialect] + (item.tags.length ? ' · ' + item.tags.join(', ') : '');
        button.append(title, sub); button.addEventListener('click', () => { selectedId = item.id; render(); }); el('list').appendChild(button);
      });
      if (!filtered.length) { const empty = document.createElement('p'); empty.className = 'tpl-empty'; empty.textContent = items.length ? '没有匹配的模板' : '暂无模板，点击“新建”或从编辑器保存。'; el('list').appendChild(empty); }
      el('count').textContent = '显示 ' + filtered.length + ' / ' + items.length + ' 个模板';
      renderDetail();
    }

    async function reload(preferredId) {
      const version = ++loadVersion;
      try {
        const result = await store.list();
        if (!m.isConnected || version !== loadVersion) return;
        items = result; if (preferredId) selectedId = preferredId; error(''); render();
      } catch (e) { if (m.isConnected && version === loadVersion) error(e.message); }
    }
    function showSaved(saved) {
      el('search').value = ''; el('filter').value = '';
      return reload(saved.id);
    }
    el('search').addEventListener('input', render); el('filter').addEventListener('change', render);
    el('refresh').addEventListener('click', () => reload());
    el('new').addEventListener('click', () => edit(bridge, { dialect: bridge.target().dialect || 'all' }, null, showSaved));
    el('edit').addEventListener('click', () => { const item = selected(); if (item) edit(bridge, item, item, showSaved); });
    el('copy').addEventListener('click', () => { const item = selected(); if (item) edit(bridge, { ...item, name: item.name.slice(0, 115) + ' 副本' }, null, showSaved); });
    el('delete').addEventListener('click', () => {
      const item = selected(); if (!item) return;
      let deleting = false;
      const confirmation = bridge.openModal('删除 SQL 模板', '<p data-delete-name></p>',
        '<button class="btn danger" data-ok>删除</button><button class="btn" data-cancel>取消</button>', async () => {
          if (deleting) return true;
          deleting = true; confirmation.querySelector('[data-ok]').disabled = true;
          try { await store.remove(item); bridge.toast('模板已删除'); await reload(); return false; }
          catch (e) { bridge.toast(e.message, true); return true; }
          finally { deleting = false; confirmation.querySelector('[data-ok]').disabled = false; }
        });
      confirmation.querySelector('[data-delete-name]').textContent = '确定删除模板“' + item.name + '”？';
    });
    for (const name of ['open', 'insert']) el(name).addEventListener('click', () => {
      const item = selected(); if (!item) return;
      try {
        if (name === 'open') bridge.open(item); else bridge.insert(item);
        m._close();
      } catch (e) { error(e.message); }
    });
    el('export').addEventListener('click', () => {
      try { bridge.download('sqltool-templates.json', exportText(filtered), 'application/json;charset=utf-8'); }
      catch (e) { error(e.message); }
    });
    el('import').addEventListener('click', () => {
      const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json';
      input.addEventListener('change', async () => {
        const file = input.files[0]; if (!file || loading || !m.isConnected) return;
        loading = true; renderDetail(); el('import').disabled = true; error('正在导入…');
        try {
          if (file.size > MAX_FILE) throw new Error('模板文件不能超过 10 MB');
          const parsed = parseImport(await file.text());
          if (!m.isConnected) return;
          const result = await store.importItems(parsed);
          bridge.toast('导入完成：新增 ' + result.added + ' 个，跳过相同模板 ' + result.skipped + ' 个');
          await reload();
        } catch (e) { if (m.isConnected) error(e.message); }
        finally { loading = false; el('import').disabled = false; renderDetail(); }
      });
      input.click();
    });
    render(); reload(); el('search').focus();
    return m;
  }

  global.SqlTool.Templates = { store, normalize, parseImport, exportText, filterItems, openLibrary,
    saveEditor(bridge, value) { return edit(bridge, value); } };
})(window);
