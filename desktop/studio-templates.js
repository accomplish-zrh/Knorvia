'use strict';

// Personal prompt templates for the creation studio. Plain durable JSON in
// the studio config area; revisions are append-only history and edits never
// touch sequences that already accepted a template version.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const P = require('./studio-providers');
const { tryLock } = require('./media-lock');

const MAX_TEMPLATES = 200;
const MAX_REVISIONS = 20;
const MAX_PUBLIC_BYTES = 3 * 1024 * 1024;
const VARIABLE = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

const METHODS = ['studio/template/list', 'studio/template/read', 'studio/template/save', 'studio/template/remove', 'studio/template/render', 'studio/template/import'];

function createTemplateStore({ home }) {
  const root = path.join(home, 'config', 'studio');
  const file = path.join(root, 'templates.json');
  let store = { version: 1, templates: [] };
  let warning;
  function reload() { try {
    warning = undefined;
    store = { version: 1, templates: [] };
    if (fs.existsSync(file)) {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (stored.version !== 1 || !Array.isArray(stored.templates)) throw new Error();
      store = stored;
    }
  } catch { warning = '提示词模板文件无法读取，原件已保留；请恢复文件后再编辑。'; } }
  reload();
  const persist = () => {
    // Windows readers/indexers can briefly deny replacement of an otherwise
    // writable destination. Keep ownership and retry only the local commit;
    // this never repeats a model request or relaxes revision checks.
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    for (let attempt = 0; ; attempt++) {
      try { return P.atomic(file, store); }
      catch (error) {
        if (attempt >= 8 || !['EACCES', 'EPERM', 'EBUSY'].includes(error.code)) throw error;
        Atomics.wait(sleeper, 0, 0, 10 * (attempt + 1));
      }
    }
  };
  const conflict = () => { const error = new Error('模板已被另一个窗口修改，请刷新后重试'); error.rpc = { code: -32005, message: error.message }; throw error; };
  const mutate = action => {
    const lock = tryLock(path.join(root, 'templates.lock'));
    if (!lock) conflict();
    try { reload(); if (warning) P.fail(warning); return action(); } finally { lock.release(); }
  };
  const checkRevision = (params, existing) => {
    if (params?.expectedRevision !== undefined && (!Number.isInteger(params.expectedRevision) || params.expectedRevision !== existing?.revision)) conflict();
  };
  const find = id => store.templates.find(template => template.id === id);
  const variablesOf = prompt => {
    const names = new Set();
    for (const match of prompt.matchAll(VARIABLE)) names.add(match[1]);
    return [...names];
  };
  function normalize(input, existing) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) P.fail('Invalid prompt template');
    const name = P.text(input.name, 100);
    const prompt = P.text(input.prompt, 12000);
    if (!name || !prompt) P.fail('模板需要名称和提示词');
    const kind = input.kind === undefined ? 'any' : P.text(input.kind, 20);
    if (!['any', 'image', 'video'].includes(kind)) P.fail('Invalid template kind');
    const variables = variablesOf(prompt);
    // Defaults for variables the edit removed are obsolete; drop them and
    // keep the ones that still belong.
    const defaults = {};
    for (const [key, value] of Object.entries(P.safeObject(input.defaults ?? existing?.defaults ?? {}))) {
      if (variables.includes(key)) defaults[key] = value;
    }
    return { name, kind, prompt, variables, defaults };
  }
  const publicTemplate = template => ({ id: template.id, revision: template.revision, name: template.name, kind: template.kind, prompt: template.prompt, variables: template.variables, defaults: template.defaults, createdAt: template.createdAt, updatedAt: template.updatedAt, historyCount: template.history?.length ?? 0 });
  const boundedTemplates = templates => {
    if (Buffer.byteLength(JSON.stringify({ templates }), 'utf8') > MAX_PUBLIC_BYTES) P.fail('模板库总内容超出 3 MiB 上限，请减少内容或按名称搜索读取；未保存本次更改');
    return templates;
  };
  const templateAt = (id, revision) => {
    reload();
    const template = find(P.id(id));
    if (!template) P.fail('Template not found');
    if (revision === undefined || revision === template.revision) return template;
    if (!Number.isInteger(revision) || revision < 1) P.fail('Invalid template revision');
    const historical = (template.history || []).find(item => item.revision === revision);
    if (!historical) P.fail(`模板「${template.name}」的版本 ${revision} 已不存在`);
    return { ...template, ...historical, variables: variablesOf(historical.prompt), defaults: historical.defaults || {} };
  };
  // Restricted substitution: {{name}} only, single pass, replaced values are
  // never re-scanned, and nothing here evaluates expressions.
  const render = (template, params = {}) => {
    const safe = P.safeObject(params);
    for (const name of template.variables) if (safe[name] === undefined) {
      if (template.defaults?.[name] !== undefined) safe[name] = template.defaults[name];
      else P.fail(`模板变量 {{${name}}} 未提供`);
    }
    return template.prompt.replace(VARIABLE, (_, name) => String(safe[name]));
  };
  const handlers = {
    'studio/template/list': params => {
      reload();
      const query = typeof params?.query === 'string' ? params.query.trim().toLowerCase() : '';
      const templates = store.templates
        .filter(template => !query || template.name.toLowerCase().includes(query) || template.prompt.toLowerCase().includes(query))
        .slice(0, MAX_TEMPLATES)
        .map(publicTemplate);
      return { templates: boundedTemplates(templates), ...(warning ? { warning } : {}) };
    },
    'studio/template/read': params => publicTemplate(templateAt(params?.id, params?.revision)),
    'studio/template/save': params => mutate(() => {
      const existing = params?.id ? find(P.id(params.id)) : undefined;
      checkRevision(params, existing);
      const input = normalize(params, existing);
      if (params?.id && !existing) P.fail('Template not found');
      if (!existing && store.templates.length >= MAX_TEMPLATES) P.fail(`最多保存 ${MAX_TEMPLATES} 个模板`);
      const now = new Date().toISOString();
      let saved;
      if (existing) {
        const history = [{ revision: existing.revision, name: existing.name, kind: existing.kind, prompt: existing.prompt, defaults: existing.defaults, updatedAt: existing.updatedAt }, ...(existing.history || [])].slice(0, MAX_REVISIONS);
        Object.assign(existing, input, { revision: existing.revision + 1, updatedAt: now, history });
        saved = existing;
      } else {
        saved = { id: crypto.randomUUID(), revision: 1, createdAt: now, updatedAt: now, history: [], ...input };
        store.templates.unshift(saved);
      }
      boundedTemplates(store.templates.map(publicTemplate));
      try { persist(); warning = undefined; } catch (error) { if (!warning) P.fail('Could not save the template'); throw error; }
      return publicTemplate(saved);
    }),
    'studio/template/remove': params => mutate(() => {
      const id = P.id(params?.id);
      checkRevision(params, find(id));
      const next = store.templates.filter(template => template.id !== id);
      if (next.length === store.templates.length) P.fail('Template not found');
      store.templates = next; persist();
      return { removed: true };
    }),
    'studio/template/render': params => {
      const template = templateAt(params?.id, params?.revision);
      return { text: render(template, params?.params), revision: template.revision, name: template.name };
    },
    // Import accepts an exported array (or {templates:[...]}); entries are
    // always imported as NEW templates so a shared file cannot overwrite or
    // erase anyone's existing library.
    'studio/template/import': params => mutate(() => {
      const raw = Array.isArray(params?.templates) ? params.templates : Array.isArray(params) ? params : P.fail('Invalid template import');
      if (!raw.length || raw.length > MAX_TEMPLATES) P.fail(`Import accepts 1–${MAX_TEMPLATES} templates`);
      if (store.templates.length + raw.length > MAX_TEMPLATES) P.fail(`最多保存 ${MAX_TEMPLATES} 个模板`);
      const now = new Date().toISOString();
      const imported = [];
      // Validate the entire import before changing the in-memory or disk store.
      const normalized = raw.map(item => normalize(item));
      for (const input of normalized) {
        const template = { id: crypto.randomUUID(), revision: 1, createdAt: now, updatedAt: now, history: [], ...input };
        store.templates.unshift(template);
        imported.push(publicTemplate(template));
      }
      boundedTemplates(store.templates.map(publicTemplate));
      persist();
      return { imported: imported.length, templates: imported };
    }),
  };
  return { handlers, render, get: id => { reload(); return find(P.id(id)) ? publicTemplate(find(P.id(id))) : P.fail('Template not found'); }, root,
    // Sequences pin a template revision when a shot is added; rendering a
    // pinned revision must keep working after newer revisions appear. The
    // variable list belongs to the rendered prompt, not the current revision.
    renderRevision(id, revision, params) {
      return render(templateAt(id, revision), params);
    } };
}

module.exports = { createTemplateStore, METHODS };
