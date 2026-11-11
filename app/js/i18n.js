/* 三语词条和局部界面绑定：切换语言不重建表单、编辑器或查询结果。 */
(function (global) {
  'use strict';
  const languages = ['zh-CN', 'zh-TW', 'en'];
  const dictionaries = global.SqlToolLocales || {};
  let locale = 'zh-CN';
  try { const saved = global.localStorage.getItem('sqltool.language'); if (languages.includes(saved)) locale = saved; } catch (e) { /* 禁用本地存储时仍可切换语言 */ }
  const bindings = new Set(), byNode = new WeakMap();
  let cleanTimer;
  const resolve = value => value instanceof Message ? value.render() : String(value == null ? '' : value);

  // 文案保留词条和参数，直到显示时才解析，避免切换语言后已有消息停留在旧语言。
  class Message {
    constructor(key, params, parts, compute) { this.key = key; this.params = params || {}; this.parts = parts; this.compute = compute; }
    render() {
      if (this.compute) return this.compute();
      if (this.parts) return this.parts.map(resolve).join('');
      const source = dictionaries[locale]?.[this.key] ?? dictionaries['zh-CN']?.[this.key] ?? this.key;
      return source.replace(/\{([a-zA-Z][\w]*)\}/g, (all, key) => Object.prototype.hasOwnProperty.call(this.params, key) ? resolve(this.params[key]) : all);
    }
    toString() { return this.render(); }
    valueOf() { return this.render(); }
    toJSON() { return this.render(); }
    [Symbol.toPrimitive]() { return this.render(); }
  }
  function t(key, params) { return new Message(key, params); }
  function join(parts) { return parts.some(value => value instanceof Message) ? new Message(null, null, parts) : parts.join(''); }
  function escape(value) {
    const encode = s => resolve(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    return value instanceof Message ? new Message(null, null, null, () => encode(value)) : encode(value);
  }
  function error(message) {
    const e = new Error(resolve(message));
    if (message instanceof Message) { e.localized = message; Object.defineProperty(e, 'message', { get: () => message.render(), configurable: true }); }
    return e;
  }
  const detail = e => e?.localized || e?.message || String(e);
  function fromError(packet) {
    if (!packet || !packet.errorKey || !Object.prototype.hasOwnProperty.call(dictionaries['zh-CN'] || {}, packet.errorKey)) return packet?.error || '';
    const params = Object.fromEntries(Object.entries(packet.errorParams || {}).map(([key, value]) =>
      [key, value && typeof value === 'object' && typeof value.error === 'string' ? fromError(value) : value]));
    return t(packet.errorKey, params);
  }

  function track(node, kind, update) {
    let slots = byNode.get(node); if (!slots) { slots = new Map(); byNode.set(node, slots); }
    if (slots.has(kind)) bindings.delete(slots.get(kind));
    const binding = { node, update }; slots.set(kind, binding); bindings.add(binding);
    if (!cleanTimer) cleanTimer = setTimeout(() => { cleanTimer = null; for (const b of bindings) if (!b.node.isConnected) bindings.delete(b); }, 0);
  }
  function clearBinding(node, kind) {
    const slots = byNode.get(node);
    if (slots) { bindings.delete(slots.get(kind)); slots.delete(kind); }
  }
  function text(node, value) {
    if (!node) return;
    const render = typeof value === 'function' ? value : () => value;
    let last = resolve(render()); node.textContent = last;
    if (!(value instanceof Message) && typeof value !== 'function') { clearBinding(node, 'text'); return; }
    track(node, 'text', () => { if (node.childElementCount || node.textContent !== last) return; last = resolve(render()); node.textContent = last; });
  }
  function attr(node, name, value) {
    if (!node) return;
    const render = typeof value === 'function' ? value : () => value;
    let last = resolve(render()); node.setAttribute(name, last);
    if (!(value instanceof Message) && typeof value !== 'function') { clearBinding(node, name); return; }
    track(node, name, () => { if (node.getAttribute(name) !== last) return; last = resolve(render()); node.setAttribute(name, last); });
  }
  function html(node, value) {
    const render = typeof value === 'function' ? value : () => value;
    node.innerHTML = resolve(render());
    if (!(value instanceof Message) && typeof value !== 'function') { clearBinding(node, 'html'); return; }
    // 记录已生成的节点引用，随后只改文字和可翻译属性，不替换节点或输入值。
    const records = [];
    function collect(current, path) {
      if (current.nodeType === 3) { records.push({ node: current, path, last: current.nodeValue }); return; }
      if (current.nodeType !== 1 || /^(SCRIPT|STYLE|TEXTAREA|INPUT)$/.test(current.tagName)) {
        if (current.nodeType === 1) for (const name of ['title', 'placeholder', 'aria-label']) if (current.hasAttribute(name)) records.push({ node: current, path, name, last: current.getAttribute(name) });
        return;
      }
      for (const name of ['title', 'placeholder', 'aria-label']) if (current.hasAttribute(name)) records.push({ node: current, path, name, last: current.getAttribute(name) });
      Array.from(current.childNodes).forEach((child, index) => collect(child, path.concat(index)));
    }
    Array.from(node.childNodes).forEach((child, index) => collect(child, [index]));
    track(node, 'html', () => {
      const template = document.createElement('template'); template.innerHTML = resolve(render());
      for (const r of records) {
        if (!node.contains(r.node)) continue;
        let other = template.content;
        for (const index of r.path) { other = other?.childNodes[index]; if (!other) break; }
        if (!other || other.nodeType !== r.node.nodeType || (r.name && other.tagName !== r.node.tagName)) continue;
        if (r.name) {
          if (r.node.getAttribute(r.name) !== r.last) continue;
          const next = other.getAttribute(r.name); if (next === null) continue;
          r.last = next; r.node.setAttribute(r.name, next);
        } else if (r.node.nodeValue === r.last) { r.last = other.nodeValue; r.node.nodeValue = r.last; }
      }
    });
  }
  function bind(root) {
    root.querySelectorAll('[data-i18n]').forEach(node => text(node, t(node.dataset.i18n)));
    for (const name of ['title', 'placeholder', 'aria-label']) root.querySelectorAll('[data-i18n-' + name + ']').forEach(node => attr(node, name, t(node.getAttribute('data-i18n-' + name))));
  }
  function setLocale(next) {
    if (!languages.includes(next)) return false;
    locale = next;
    try { global.localStorage.setItem('sqltool.language', locale); } catch (e) { /* 本次页面仍然生效 */ }
    if (global.document) {
      document.documentElement.lang = locale;
      for (const binding of bindings) { if (binding.node.isConnected) binding.update(); else bindings.delete(binding); }
      document.querySelectorAll('[data-language-select]').forEach(select => { select.value = locale; });
      document.dispatchEvent(new CustomEvent('sqltool:language', { detail: { locale } }));
    }
    return true;
  }
  // 排序和大结果集会反复调用格式化器，按语言复用实例。
  const formatters = new Map();
  function formats() {
    if (!formatters.has(locale)) formatters.set(locale, {
      number: new Intl.NumberFormat(locale),
      date: new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'medium' }),
      collator: new Intl.Collator(locale)
    });
    return formatters.get(locale);
  }
  const api = { t, join, text, html, attr, error, detail, fromError, resolve, escape, bind, setLocale, languages, dictionaries,
    get locale() { return locale; },
    number: value => new Message(null, null, null, () => formats().number.format(value)),
    date: value => new Message(null, null, null, () => formats().date.format(new Date(value))),
    compare: (a, b) => formats().collator.compare(a, b) };
  global.SqlToolI18n = api;
  if (global.document?.documentElement) {
    document.documentElement.lang = locale;
    const start = () => {
      bind(document);
      document.querySelectorAll('[data-language-select]').forEach(select => { select.value = locale; select.addEventListener('change', () => setLocale(select.value)); });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
  }
})(typeof window === 'undefined' ? globalThis : window);
