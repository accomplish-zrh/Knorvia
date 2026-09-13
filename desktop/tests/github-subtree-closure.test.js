'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createExtensionManager } = require('../extension-manager');
const { createGitHubSubtreeFetcher, gitBlobSha1 } = require('../github-extension-source');
const F = require('../extension-files');
const COMMIT = 'a'.repeat(40), SUBTREE = 'b'.repeat(40), UNRELATED = 'c'.repeat(40);
const SOURCE = { type: 'github', repository: 'owner/repo', commit: COMMIT, subdirectory: 'pkg' };
const skill = body => `---\nname: closure-fixture\ndescription: local resource closure acceptance\n---\n${body}\n`;

async function fixture(t, initial) {
  let files;
  const replace = entries => { files = Object.entries(entries).map(([name, text]) => {
    const content = Buffer.from(text);
    return { path: name, mode: '100644', type: 'blob', sha: gitBlobSha1(content), size: content.length, content };
  }); };
  replace(initial);
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    let result;
    if (req.url === `/repos/owner/repo/git/trees/${COMMIT}`) result = { truncated: false, tree: [
      { path: 'pkg', mode: '040000', type: 'tree', sha: SUBTREE },
      { path: 'unrelated.bin', mode: '100644', type: 'blob', sha: UNRELATED, size: 200 * 1024 * 1024 },
    ] };
    if (req.url === `/repos/owner/repo/git/trees/${SUBTREE}`) result = { truncated: false, tree: files.map(({ content, ...entry }) => entry) };
    const blob = files.find(file => req.url === `/repos/owner/repo/git/blobs/${file.sha}`);
    if (blob) result = { sha: blob.sha, encoding: 'base64', size: blob.size, content: blob.content.toString('base64') };
    res.writeHead(result ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result || {}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-closure-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(home)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('knorvia-closure-'));
    fs.rmSync(home, { recursive: true, force: true });
  });
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  const manager = createExtensionManager({ home, fetchImpl: (url, options) => fetch(url.replace('https://api.github.com', apiBase), options), rpc: async () => { throw new Error('No extension activation is expected'); } });
  return { home, apiBase, manager, requests, replace };
}

const invalid = [
  ['reference-style Markdown', '[outside][resource]\n\n[resource]: ../shared.md'],
  ['angle-bracket Markdown', '[outside](<../shared.md>)'],
  ['URI encoded parent segment', '[outside](%2e%2e/shared.md)'],
  ['URI encoded separator', '[outside](..%2fshared.md)'],
  ['Markdown escaped parent segment', '[outside](\\.\\./shared.md)'],
  ['HTML entity parent segment', '<img src="&#46;&#46;/shared.png">'],
  ['file URI outside selected tree', '[outside](file:///repo/shared.md)'],
  ['missing in-tree resource', '[missing](references/missing.md)'],
  ['missing reference-style target', '[missing][resource]\n\n[resource]: <references/missing.md>'],
];
for (const [name, body] of invalid) {
  test(`${name} is refused by both inspection and installation`, async t => {
    const { home, manager } = await fixture(t, { 'SKILL.md': skill(body) });
    await assert.rejects(manager.handlers['extension/inspect']({ source: SOURCE }), error => error.rpc?.code === -32093);
    // An arbitrary expected hash must not bypass materialization validation.
    await assert.rejects(manager.handlers['extension/install']({ source: SOURCE, expectedSha256: '0'.repeat(64) }), error => error.rpc?.code === -32093);
    assert.equal((await manager.handlers['extension/list']()).entries.length, 0);
    assert.deepEqual(fs.readdirSync(path.join(home, 'extensions', 'staging')), []);
  });
}

for (const [name, filename, content] of [
  ['YAML path', 'config.yaml', 'path: ../shared.md\n'],
  ['nested YAML path', 'config.yaml', 'resource:\n  path: ../shared.md\n'],
  ['YAML alias path', 'config.yaml', 'resource: &ref ../shared.md\npath: *ref\n'],
  ['JSON escaped path', 'config.json', '{"path":"\\u002e\\u002e/shared.md"}'],
  ['side-effect import', 'script.mjs', "import '../shared.mjs';\n"],
  ['dynamic static-string import', 'script.mjs', "await import('../shared.mjs');\n"],
  ['escaped static import', 'script.mjs', "import '\\x2e\\x2e/shared.mjs';\n"],
  ['multiline re-export', 'script.mjs', "export {\n helper\n} from '../shared.mjs';\n"],
  ['missing module', 'script.mjs', "import './missing.mjs';\n"],
]) {
  test(`${name} cannot install an incomplete subtree`, async t => {
    const { manager } = await fixture(t, { 'SKILL.md': skill('Read the bundled resource.'), [filename]: content });
    await assert.rejects(manager.handlers['extension/inspect']({ source: SOURCE }), error => error.rpc?.code === -32093);
    await assert.rejects(manager.handlers['extension/install']({ source: SOURCE, expectedSha256: '0'.repeat(64) }), error => error.rpc?.code === -32093);
    assert.equal((await manager.handlers['extension/list']()).entries.length, 0);
  });
}

test('valid reference syntax, dot-prefixed names and static module resolution retain exact package bytes', async t => {
  const files = {
    'SKILL.md': skill([
      '[notes](..notes.md)', '[resource][doc]', '[space](<docs/a b.md>)', '[paren](docs/a(b).md)',
      '[notes again](docs/note.md#heading)', '[directory](docs/)',
      '[external](https://example.com/outside.md)', '[mail](mailto:example@example.com)',
      '[doc]: docs/note.md', '```markdown', '[example](../not-a-dependency.md)', '```',
      '`[inline example](../not-a-dependency.md)`',
    ].join('\n')),
    '..notes.md': '# Notes', 'docs/a b.md': 'Space', 'docs/a(b).md': 'Parentheses', 'docs/note.md': 'Note',
    'config.yaml': 'path: docs/note.md\n',
    'script.mjs': "import './helper';\nimport './modules';\n// import '../example.mjs';\nconst example = \"import '../example.mjs'\";\n",
    'helper.js': 'export const value = 1;', 'modules/index.js': 'export const value = 2;',
  };
  const { home, manager, requests } = await fixture(t, files);
  const inspected = await manager.handlers['extension/inspect']({ source: SOURCE });
  const installed = await manager.handlers['extension/install']({ source: SOURCE, expectedSha256: inspected.sha256 });
  assert.equal(installed.enabled, false);
  const installedDir = path.join(home, 'extensions', 'marketplaces', installed.id, 'packages', installed.activeVersion, 'plugin');
  assert.equal(F.scan(installedDir).sha256, inspected.sha256);
  for (const [name, text] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(installedDir, name), 'utf8'), text);
  assert.ok(!requests.some(url => url.includes(UNRELATED) || url.includes('codeload')));
});

test('inspect/install CAS still rejects a changed package after resource validation', async t => {
  const { manager, replace } = await fixture(t, { 'SKILL.md': skill('[notes](notes.md)'), 'notes.md': 'First' });
  const inspected = await manager.handlers['extension/inspect']({ source: SOURCE });
  replace({ 'SKILL.md': skill('[notes](notes.md)'), 'notes.md': 'Changed' });
  await assert.rejects(manager.handlers['extension/install']({ source: SOURCE, expectedSha256: inspected.sha256 }), error => error.rpc?.code === -32005);
  assert.equal((await manager.handlers['extension/list']()).entries.length, 0);
});

test('exported helper rejects a nonempty destination without changing existing contents', async t => {
  const { home, apiBase } = await fixture(t, { 'SKILL.md': skill('[outside](../shared.md)') });
  const destination = path.join(home, 'existing');
  fs.mkdirSync(destination);
  const sentinel = path.join(destination, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'Preserve caller data');
  await assert.rejects(createGitHubSubtreeFetcher({ apiBase }).fetchSubtree({ ...SOURCE, destination }), error => error.rpc?.code === -32093);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'Preserve caller data');
  assert.deepEqual(fs.readdirSync(destination), ['sentinel.txt']);
});

test('200 KiB subtree still downloads only selected objects from a large fixture repository', async t => {
  const { home, apiBase, requests } = await fixture(t, { 'SKILL.md': skill('x'.repeat(200 * 1024)) });
  const outcome = await createGitHubSubtreeFetcher({ apiBase }).fetchSubtree({ ...SOURCE, destination: path.join(home, 'download') });
  assert.equal(outcome.files, 1);
  assert.ok(outcome.bytes >= 200 * 1024);
  assert.equal(requests.length, 3);
  assert.ok(!requests.some(url => url.includes(UNRELATED) || url.includes('codeload')));
});
