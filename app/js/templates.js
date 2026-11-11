/* SQL 模板库：独立本地存储、文件交换及管理界面。 */
(function (global) {
  'use strict';
  const I = window.SqlToolI18n;

  const DIALECTS = { all: I.t("templates.generic_sql_c15301"), sqlite: 'SQLite', mysql: 'MySQL / MariaDB', postgres: 'PostgreSQL', mssql: 'SQL Server' };
  const MAX_ITEMS = 1000, MAX_SQL = 500000, MAX_FILE = 10 * 1024 * 1024;
  let dbPromise = null;

  function openStore() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open('sqltool-templates', 1);
      let failed = false;
      const fail = error => { failed = true; dbPromise = null; reject(error); };
      request.onupgradeneeded = () => request.result.createObjectStore('templates', { keyPath: 'id' });
      request.onerror = () => fail(I.error(I.t("templates.cannot_open_template_library_d6dc83", { p0: I.detail(request.error) })));
      request.onblocked = () => fail(I.error(I.t("templates.the_template_library_is_blocked_by_e08c93")));
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
      tx.onabort = tx.onerror = () => reject(failure || tx.error || I.error(I.t("templates.template_library_operation_failed_8b1672")));
      const abort = error => { failure = error; tx.abort(); };
      try { work(tx.objectStore('templates'), value => { result = value; }, abort); }
      catch (error) { abort(error); }
    });
  }

  function normalize(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw I.error(I.t("templates.template_must_be_an_object_61c538"));
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 120) throw I.error(I.t("templates.template_name_must_contain_characters_8f6141"));
    if (typeof value.sql !== 'string' || !value.sql.trim() || value.sql.length > MAX_SQL) throw I.error(I.t("templates.sql_must_contain_characters_and_cannot_4ef29e"));
    const dialect = value.dialect === undefined ? 'all' : value.dialect;
    if (typeof dialect !== 'string' || !Object.prototype.hasOwnProperty.call(DIALECTS, dialect)) throw I.error(I.t("templates.unsupported_database_dialect_9309d3"));
    const description = value.description === undefined ? '' : value.description;
    if (typeof description !== 'string' || description.length > 2000) throw I.error(I.t("templates.description_cannot_exceed_characters_d4646e"));
    const tags = value.tags === undefined ? [] : value.tags;
    if (!Array.isArray(tags) || tags.length > 20 || tags.some(t => typeof t !== 'string' || t.trim().length > 40)) throw I.error(I.t("templates.use_at_most_tags_with_at_af2c84"));
    if (tags.some(t => /[,，]/.test(t))) throw I.error(I.t("templates.a_tag_cannot_contain_commas_split_a677bf"));
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
            if (!current || current.revision !== original.revision) return abort(I.error(I.t("templates.this_template_was_changed_or_deleted_fefb31")));
            const updated = { ...current, ...item, revision: current.revision + 1, updatedAt: new Date().toISOString() };
            s.put(updated); done(updated);
          };
        } else {
          s.count().onsuccess = e => {
            if (e.target.result >= MAX_ITEMS) return abort(I.error(I.t("templates.the_library_holds_up_to_templates_72fcdf")));
            const created = fresh(item); s.add(created); done(created);
          };
        }
      });
    },
    remove(original) {
      return transaction('readwrite', (s, done, abort) => {
        s.get(original.id).onsuccess = e => {
          const current = e.target.result;
          if (!current || current.revision !== original.revision) return abort(I.error(I.t("templates.this_template_was_changed_or_deleted_93786a")));
          s.delete(original.id); done();
        };
      });
    },
    importItems(items) {
      // 在开启事务前完成所有校验；事务中的请求同步发出，不插入 await。
      if (!Array.isArray(items) || !items.length || items.length > MAX_ITEMS) throw I.error(I.t("templates.import_file_must_contain_templates_9837aa"));
      const clean = items.map((value, index) => {
        try { return normalize(value); } catch (error) { throw I.error(I.t("templates.item_6498ab", { p0: index + 1, p1: I.detail(error) })); }
      });
      return transaction('readwrite', (s, done, abort) => {
        s.getAll().onsuccess = e => {
          const existing = e.target.result, seen = new Set(existing.map(fingerprint)), added = [];
          clean.forEach(item => { const key = fingerprint(item); if (!seen.has(key)) { seen.add(key); added.push(fresh(item)); } });
          if (existing.length + added.length > MAX_ITEMS) return abort(I.error(I.t("templates.import_would_exceed_templates_nothing_was_babf94")));
          added.forEach(item => s.add(item));
          done({ added: added.length, skipped: clean.length - added.length });
        };
      });
    }
  };

  function parseImport(text) {
    if (new Blob([text]).size > MAX_FILE) throw I.error(I.t("templates.template_file_cannot_exceed_mb_df3f09"));
    let value;
    try { value = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (error) { throw I.error(I.t("templates.file_is_not_valid_json_3827b8")); }
    if (!value || value.format !== 'sqltool-templates' || value.version !== 1 || !Array.isArray(value.templates)) {
      throw I.error(I.t("templates.unsupported_file_format_select_a_sqltool_5818a7"));
    }
    if (!value.templates.length || value.templates.length > MAX_ITEMS) throw I.error(I.t("templates.import_file_must_contain_templates_9837aa"));
    return value.templates.map((item, index) => {
      try { return normalize(item); } catch (error) { throw I.error(I.t("templates.item_6498ab", { p0: index + 1, p1: I.detail(error) })); }
    });
  }

  function exportText(items) {
    const text = JSON.stringify({ format: 'sqltool-templates', version: 1, templates: items }, null, 2);
    if (new Blob([text]).size > MAX_FILE) throw I.error(I.t("templates.export_exceeds_mb_filter_by_search_559e30"));
    return text;
  }

  function filterItems(items, query, dialect) {
    const term = query.trim().toLocaleLowerCase();
    return items.filter(item => (!dialect || item.dialect === dialect) && (!term ||
      [item.name, item.sql, item.description, ...item.tags].join('\n').toLocaleLowerCase().includes(term)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || I.compare(a.name, b.name));
  }

  function options(all) {
    return I.join([all ? I.t("templates.all_dialects_50131f") : '',
      I.join(Object.entries(DIALECTS).map(([value, name]) => I.join(['<option value="', value, '">', name, '</option>'])))]);
  }

  function edit(bridge, value, original, onSaved) {
    let saving = false;
    const m = bridge.openModal(original ? I.t("templates.edit_sql_template_3c20d5") : I.t("templates.save_sql_template_de0ee3"),
      I.t("templates.name_dialect_tags_comma_separated_description_d9c99a", { p0: options(false) }),
      I.t("templates.save_template_cancel_aac51e"),
      async () => {
        if (saving) return true;
        saving = true; const button = m.querySelector('[data-ok]'); button.disabled = true;
        try {
          const saved = await store.save({ name: m.querySelector('[data-tpl-name]').value,
            dialect: m.querySelector('[data-tpl-dialect]').value, sql: m.querySelector('[data-tpl-sql]').value,
            description: m.querySelector('[data-tpl-description]').value,
            tags: m.querySelector('[data-tpl-tags]').value.split(/[,，]/).map(t => t.trim()).filter(Boolean) }, original);
          bridge.toast(I.t("templates.template_saved_11cd7a"));
          if (onSaved) await onSaved(saved);
          return false;
        } catch (error) { I.text(m.querySelector('[data-tpl-error]'), I.detail(error)); return true; }
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
    const m = bridge.openModal(I.t("templates.sql_template_library_1689fc"),
      I.t("templates.new_import_json_export_filtered_refresh_296597", { p0: options(true) }),
      I.t("templates.edit_duplicate_delete_open_in_new_813068"),
      null, true);
    m.classList.add('template-library');
    const el = name => m.querySelector('[data-tpl-' + name + ']');
    I.text(el('insert'), bridge.selection ? I.t("templates.replace_selected_sql_3fc043") : I.t("templates.insert_at_cursor_a06a99"));
    const selected = () => items.find(item => item.id === selectedId);
    const error = message => { I.text(el('error'), message || ''); };
    const targetText = () => I.t("templates.current_connection_open_or_insert_then_7a5ad9", { p0: bridge.target().label });

    function renderDetail() {
      const item = selected();
      I.text(el('target'), targetText());
      I.text(el('title'), item ? item.name : I.t("templates.select_a_template_05c470"));
      I.text(el('kind'), item ? DIALECTS[item.dialect] : '');
      I.text(el('note'), item ? item.description : '');
      I.text(el('preview'), item ? item.sql : I.t("templates.save_frequently_used_queries_to_find_502662"));
      I.text(el('meta'), item ? I.t("templates.updated_6ba545", { p0: item.tags.length ? item.tags.join(' · ') + ' · ' : '', p1: I.date(item.updatedAt) }) : '');
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
        const title = document.createElement('strong'); I.text(title, item.name);
        const sub = document.createElement('span'); I.text(sub, I.join([DIALECTS[item.dialect], item.tags.length ? I.join([' · ', item.tags.join(', ')]) : '']));
        button.append(title, sub); button.addEventListener('click', () => { selectedId = item.id; render(); }); el('list').appendChild(button);
      });
      if (!filtered.length) { const empty = document.createElement('p'); empty.className = 'tpl-empty'; I.text(empty, items.length ? I.t("templates.no_matching_templates_0f5e1c") : I.t("templates.no_templates_yet_click_new_or_b5d18f")); el('list').appendChild(empty); }
      I.text(el('count'), I.t("templates.showing_templates_429b93", { p0: filtered.length, p1: items.length }));
      renderDetail();
    }

    async function reload(preferredId) {
      const version = ++loadVersion;
      try {
        const result = await store.list();
        if (!m.isConnected || version !== loadVersion) return;
        items = result; if (preferredId) selectedId = preferredId; error(''); render();
      } catch (e) { if (m.isConnected && version === loadVersion) error(I.detail(e)); }
    }
    function showSaved(saved) {
      el('search').value = ''; el('filter').value = '';
      return reload(saved.id);
    }
    el('search').addEventListener('input', render); el('filter').addEventListener('change', render);
    el('refresh').addEventListener('click', () => reload());
    el('new').addEventListener('click', () => edit(bridge, { dialect: bridge.target().dialect || 'all' }, null, showSaved));
    el('edit').addEventListener('click', () => { const item = selected(); if (item) edit(bridge, item, item, showSaved); });
    el('copy').addEventListener('click', () => { const item = selected(); if (item) edit(bridge, { ...item, name: I.t("templates.copy_ef5e52", { p0: item.name.slice(0, 115) }) }, null, showSaved); });
    el('delete').addEventListener('click', () => {
      const item = selected(); if (!item) return;
      let deleting = false;
      const confirmation = bridge.openModal(I.t("templates.delete_sql_template_af2394"), '<p data-delete-name></p>',
        I.t("templates.delete_cancel_1a64c3"), async () => {
          if (deleting) return true;
          deleting = true; confirmation.querySelector('[data-ok]').disabled = true;
          try { await store.remove(item); bridge.toast(I.t("templates.template_deleted_b487b4")); await reload(); return false; }
          catch (e) { bridge.toast(I.detail(e), true); return true; }
          finally { deleting = false; confirmation.querySelector('[data-ok]').disabled = false; }
        });
      I.text(confirmation.querySelector('[data-delete-name]'), I.t("templates.delete_template_1e3f73", { p0: item.name }));
    });
    for (const name of ['open', 'insert']) el(name).addEventListener('click', () => {
      const item = selected(); if (!item) return;
      try {
        if (name === 'open') bridge.open(item); else bridge.insert(item);
        m._close();
      } catch (e) { error(I.detail(e)); }
    });
    el('export').addEventListener('click', () => {
      try { bridge.download('sqltool-templates.json', exportText(filtered), 'application/json;charset=utf-8'); }
      catch (e) { error(I.detail(e)); }
    });
    el('import').addEventListener('click', () => {
      const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json';
      input.addEventListener('change', async () => {
        const file = input.files[0]; if (!file || loading || !m.isConnected) return;
        loading = true; renderDetail(); el('import').disabled = true; error(I.t("templates.importing_f6dc1b"));
        try {
          if (file.size > MAX_FILE) throw I.error(I.t("templates.template_file_cannot_exceed_mb_df3f09"));
          const parsed = parseImport(await file.text());
          if (!m.isConnected) return;
          const result = await store.importItems(parsed);
          bridge.toast(I.t("templates.import_complete_added_skipped_identical_templates_084f95", { p0: result.added, p1: result.skipped }));
          await reload();
        } catch (e) { if (m.isConnected) error(I.detail(e)); }
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
