/* 自有错误携带稳定词条键；数据库驱动的原始错误文本保持不变。 */
'use strict';
const messages = require('../app/js/locales/zh-CN');

function packet(error) {
  if (error && error.errorKey) return {
    error: error.message || error.error,
    errorKey: error.errorKey,
    errorParams: error.errorParams
  };
  return { error: String(error && error.message ? error.message : error) };
}

function make(key, params = {}) {
  const values = Object.fromEntries(Object.entries(params).map(([name, value]) =>
    [name, value instanceof Error ? packet(value) : value]));
  const error = new Error(messages[key].replace(/\{(\w+)\}/g, (match, name) => {
    const value = values[name];
    return value && typeof value === 'object' && 'error' in value ? value.error : String(value ?? match);
  }));
  error.errorKey = key;
  error.errorParams = values;
  return error;
}

module.exports = { make, packet };
