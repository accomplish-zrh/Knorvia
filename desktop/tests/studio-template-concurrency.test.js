'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createTemplateStore } = require('../studio-templates');

test('template revision CAS rejects concurrent processes and refreshes other hosts', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kn-template-cas-'));
  const a = createTemplateStore({ home }), b = createTemplateStore({ home });
  const saved = a.handlers['studio/template/save']({ name: '原版', prompt: '{{who}}', defaults: { who: '猫' } });
  assert.equal(b.handlers['studio/template/list']({}).templates[0].id, saved.id);
  const source = `const {createTemplateStore}=require(${JSON.stringify(require.resolve('../studio-templates'))});const t=createTemplateStore({home:process.argv[1]});try{t.handlers['studio/template/save']({id:process.argv[2],expectedRevision:1,name:'新版',prompt:'狗'});console.log('SAVED')}catch(e){console.log(e.rpc?.code===-32005?'CONFLICT':'ERROR:'+e.message)}`;
  const results = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source, home, saved.id], { windowsHide: true });
    let output = ''; child.stdout.on('data', data => output += data);
    // close waits for stdout drainage; exit can precede the final data event.
    child.once('error', reject); child.once('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(output)));
  })));
  assert.equal(results.filter(v => v === 'SAVED').length, 1);
  assert.equal(results.filter(v => v === 'CONFLICT').length, 5, JSON.stringify(results));
  assert.equal(b.handlers['studio/template/read']({ id: saved.id }).revision, 2);
  const original = b.handlers['studio/template/read']({ id: saved.id, revision: 1 });
  assert.equal(original.name, '原版'); assert.equal(original.defaults.who, '猫');
  assert.equal(b.handlers['studio/template/render']({ id: saved.id, revision: 1 }).text, '猫');
  assert.throws(() => a.handlers['studio/template/remove']({ id: saved.id, expectedRevision: 1 }), e => e.rpc.code === -32005);
  a.handlers['studio/template/remove']({ id: saved.id, expectedRevision: 2 });
  assert.equal(b.handlers['studio/template/list']({}).templates.length, 0);
});

test('template corrupt storage is preserved and invalid import changes nothing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kn-template-integrity-'));
  const store = createTemplateStore({ home });
  assert.throws(() => store.handlers['studio/template/import']({ templates: [{ name: '有效', prompt: 'test' }, { name: '' }] }));
  assert.equal(store.handlers['studio/template/list']({}).templates.length, 0);
  const file = path.join(store.root, 'templates.json'); fs.writeFileSync(file, '{damaged');
  assert.throws(() => store.handlers['studio/template/save']({ name: '新', prompt: 'new' }), /原件/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{damaged');
});

test('a full 200-template export can be imported intact into another personal home', () => {
  const first = createTemplateStore({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'kn-template-export-')) });
  const second = createTemplateStore({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'kn-template-import-')) });
  first.handlers['studio/template/import']({ templates: Array.from({ length: 200 }, (_, index) => ({ name: `模板 ${index}`, prompt: `{{who}} ${index}`, defaults: { who: '猫' } })) });
  const original = first.handlers['studio/template/list']({}).templates;
  // Same payload projection as the toolbar export: no identity from another
  // personal store is allowed to overwrite existing template ids.
  const exported = original.map(({ name, kind, prompt, defaults }) => ({ name, kind, prompt, defaults }));
  const imported = second.handlers['studio/template/import']({ templates: exported });
  assert.equal(imported.imported, 200);
  assert.equal(new Set(imported.templates.map(item => item.id)).size, 200);
  assert.ok(imported.templates.every(item => !original.some(old => old.id === item.id)));
  assert.deepEqual(imported.templates.map(({ name, kind, prompt, defaults }) => ({ name, kind, prompt, defaults })), exported);
  assert.throws(() => second.handlers['studio/template/save']({ name: 'overflow', prompt: 'no room' }), /200/);
});

test('transient Windows replacement contention retries the same template commit without extra revision', t => {
  const store = createTemplateStore({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'kn-template-busy-')) });
  const file = path.join(store.root, 'templates.json'), rename = fs.renameSync;
  let attempts = 0;
  fs.renameSync = (from, to) => {
    if (to === file && ++attempts <= 2) throw Object.assign(new Error('fixture sharing violation'), { code: 'EPERM' });
    return rename(from, to);
  };
  t.after(() => { fs.renameSync = rename; });
  const saved = store.handlers['studio/template/save']({ name: 'retry', prompt: 'same commit' });
  assert.equal(attempts, 3); assert.equal(saved.revision, 1);
  assert.equal(store.handlers['studio/template/list']({}).templates.length, 1);
  assert.deepEqual(fs.readdirSync(store.root), ['templates.json']);
});
