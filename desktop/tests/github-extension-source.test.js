'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { createGitHubSubtreeFetcher, gitBlobSha1 } = require('../github-extension-source');
const F = require('../extension-files');

const COMMIT = 'a'.repeat(40);
const REPO = 'owner/repo';
const SKILL_BODY = `---\nname: subtree-skill\ndescription: a small skill in a huge repo\n---\n${'body text '.repeat(400)}`;

// A tiny model of git objects for the fixture server. The repository is
// "200 MB": the fixture simply never serves a whole-repo ZIP endpoint, so a
// whole-repo download would fail outright — only subtree objects exist here.
function gitFixture({ rootTree, blobs }) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/repos/owner/repo/git/trees/')) {
      const sha = url.pathname.split('/').pop();
      const tree = rootTree[sha];
      if (!tree) { res.writeHead(404); res.end('{}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sha, truncated: false, tree }));
      return;
    }
    if (url.pathname.startsWith('/repos/owner/repo/git/blobs/')) {
      const sha = url.pathname.split('/').pop();
      const blob = blobs[sha];
      if (!blob) { res.writeHead(404); res.end('{}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sha, encoding: 'base64', content: blob.content.toString('base64'), size: blob.content.length }));
      return;
    }
    res.writeHead(404);
    res.end('{}');
  };
}

function blobEntry(name, content) {
  const bytes = Buffer.from(content);
  const sha = gitBlobSha1(bytes);
  return { entry: { path: name, mode: '100644', type: 'blob', sha, size: bytes.length }, sha, content: bytes };
}

async function serverFixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const destination = await fsp.mkdtemp(path.join(os.tmpdir(), 'knorvia-github-subtree-'));
  t.after(() => fsp.rm(destination, { recursive: true, force: true }));
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  return { destination, apiBase };
}

function makeFetcher(apiBase) {
  return createGitHubSubtreeFetcher({ apiBase });
}

test('a small subdirectory of a huge repository is fetched by objects, not by whole-repo ZIP', async t => {
  const skill = blobEntry('SKILL.md', SKILL_BODY);
  const reference = blobEntry('references/note.md', '# ref\n');
  const hugeIsh = blobEntry('data/blob.bin', Buffer.alloc(64));
  const trees = {
    [COMMIT]: [
      { path: 'skills', mode: '040000', type: 'tree', sha: 't-skills' },
      { path: 'data', mode: '040000', type: 'tree', sha: 't-data' },
      { path: 'README.md', mode: '100644', type: 'blob', sha: hugeIsh.sha, size: hugeIsh.content.length },
    ],
    't-skills': [{ path: 'demo', mode: '040000', type: 'tree', sha: 't-demo' }],
    't-demo': [skill.entry, reference.entry],
  };
  const { destination, apiBase } = await serverFixture(t, gitFixture({
    rootTree: trees,
    blobs: { [skill.sha]: skill, [reference.sha]: reference, [hugeIsh.sha]: hugeIsh },
  }));
  const fetcher = makeFetcher(apiBase);
  const outcome = await fetcher.fetchSubtree({ repository: REPO, commit: COMMIT, subdirectory: 'skills/demo', destination });
  assert.equal(outcome.files, 2);
  assert.equal(outcome.sha256, F.scan(destination).sha256, 'final package hash comes from the same scan the installer uses');
  assert.equal(await fsp.readFile(path.join(destination, 'SKILL.md'), 'utf8'), SKILL_BODY);
  // Network log: only the subtree's trees and blobs — never the sibling
  // directory, the README blob, or a whole-repo ZIP endpoint.
  const requested = fetcher.requests.map((url) => url.replace(apiBase, ''));
  assert.ok(requested.every((url) => url.includes('/git/trees/') || url.includes('/git/blobs/')));
  assert.ok(!requested.some((url) => url.includes('codeload')), 'no whole-repo ZIP download');
  assert.ok(!requested.some((url) => url.includes(hugeIsh.sha)), 'unrelated blobs are not fetched');
  assert.ok(requested.some((url) => url.endsWith(`/git/trees/${COMMIT}`)));
  assert.ok(requested.some((url) => url.endsWith('/git/blobs/' + skill.sha)));
});

test('a tree entry escaping the destination is rejected before any write (06:18 counterexample)', async t => {
  // Root counterexample reproduction: a hostile tree entry whose path
  // escapes the selected subtree must not write the blob outside.
  const skill = blobEntry('SKILL.md', SKILL_BODY);
  const markerDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'knorvia-escape-marker-'));
  t.after(() => fsp.rm(markerDir, { recursive: true, force: true }));
  const escaped = { path: `../${path.basename(markerDir)}/escaped-marker.txt`, mode: '100644', type: 'blob', sha: gitBlobSha1(Buffer.from('escaped')), size: 7 };
  const { destination, apiBase } = await serverFixture(t, gitFixture({
    rootTree: { [COMMIT]: [{ path: 'pkg', mode: '040000', type: 'tree', sha: 't-pkg' }], 't-pkg': [escaped, { path: 'SKILL.md', mode: '100644', type: 'blob', sha: skill.sha, size: skill.content.length }] },
    blobs: { [skill.sha]: { content: Buffer.from('escaped') } },
  }));
  const fetcher = makeFetcher(apiBase);
  await assert.rejects(
    fetcher.fetchSubtree({ repository: REPO, commit: COMMIT, subdirectory: 'pkg', destination }),
    error => /路径|穿越|Unsafe extension filename/.test(error.message) || error.rpc?.code === -32004,
  );
  assert.equal(fs.existsSync(path.join(destination, 'escaped-marker.txt')), false, 'the escaped marker file must not appear');
  assert.equal(fs.readdirSync(path.join(markerDir)).length, 0, 'nothing written outside the destination');
});

test('the file-count budget uses the real shared constant (not an undefined no-op)', async t => {
  const blobs = {};
  const { destination, apiBase } = await serverFixture(t, async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.endsWith(`/git/trees/${COMMIT}`)) {
      res.writeHead(200); res.end(JSON.stringify({ sha: COMMIT, truncated: false, tree: [{ path: 'pkg', mode: '040000', type: 'tree', sha: 't-pkg' }] }));
      return;
    }
    if (url.pathname.endsWith('/git/trees/t-pkg')) {
      const entries = [];
      for (let i = 0; i < 10; i += 1) {
        const content = Buffer.from(`file-${i}`);
        const sha = gitBlobSha1(content);
        blobs[sha] = { content };
        entries.push({ path: `f${i}.txt`, mode: '100644', type: 'blob', sha, size: content.length });
      }
      res.writeHead(200); res.end(JSON.stringify({ sha: 't-pkg', truncated: false, tree: entries }));
      return;
    }
    if (url.pathname.startsWith('/repos/') && url.pathname.includes('/git/blobs/')) {
      const sha = url.pathname.split('/').pop();
      const blob = blobs[sha];
      if (!blob) { res.writeHead(404); res.end('{}'); return; }
      res.writeHead(200); res.end(JSON.stringify({ sha, encoding: 'base64', content: blob.content.toString('base64'), size: blob.content.length }));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  const fetcher = createGitHubSubtreeFetcher({ apiBase, maxFiles: 5, maxBytes: F.MAX_BYTES });
  await assert.rejects(
    fetcher.fetchSubtree({ repository: REPO, commit: COMMIT, subdirectory: 'pkg', destination }),
    error => /预算/.test(error.message) || error.rpc?.code === -32082,
  );
});

test('a truncated tree is rejected, never treated as a complete result', async t => {
  const { destination, apiBase } = await serverFixture(t, async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.endsWith(`/git/trees/${COMMIT}`)) {
      res.writeHead(200); res.end(JSON.stringify({ sha: COMMIT, truncated: true, tree: [{ path: 'skills', mode: '040000', type: 'tree', sha: 't-x' }] }));
      return;
    }
    if (url.pathname.endsWith('/git/trees/t-x')) {
      res.writeHead(200); res.end(JSON.stringify({ sha: 't-x', truncated: true, tree: [] }));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  await assert.rejects(makeFetcher(apiBase).fetchSubtree({ repository: REPO, commit: COMMIT, subdirectory: 'skills', destination }), error => /截断/.test(error.message));
  assert.deepEqual(await fsp.readdir(destination).catch(() => []), [], 'nothing is installed from a truncated tree');
});

test('a tampered blob, a missing commit, rate limiting and symlink/submodule entries are all refused', async t => {
  // Blob content does not match its object id.
  const skill = blobEntry('SKILL.md', SKILL_BODY);
  const tampered = { [skill.sha]: { content: Buffer.from('x'.repeat(SKILL_BODY.length)) } };
  {
    const { destination, apiBase } = await serverFixture(t, gitFixture({
      rootTree: { [COMMIT]: [{ path: 'pkg', mode: '040000', type: 'tree', sha: 't-pkg' }], 't-pkg': [skill.entry] },
      blobs: tampered,
    }));
    await assert.rejects(makeFetcher(apiBase).fetchSubtree({ repository: REPO, commit: COMMIT, subdirectory: 'pkg', destination }), error => /对象 ID 不符/.test(error.message));
    void destination;
  }
  // Unknown fixed commit.
  {
    const { destination, apiBase } = await serverFixture(t, gitFixture({ rootTree: {}, blobs: {} }));
    await assert.rejects(makeFetcher(apiBase).fetchSubtree({ repository: REPO, commit: 'b'.repeat(40), subdirectory: 'skills', destination }), error => /找不到|404/.test(error.message) || error.rpc?.code === -32092);
  }
  // Rate limit.
  {
    const { destination, apiBase } = await serverFixture(t, async (req, res) => { res.writeHead(403); res.end('{}'); });
    await assert.rejects(makeFetcher(apiBase).fetchSubtree({ repository: REPO, commit: COMMIT, subdirectory: 'skills', destination }), error => /限流/.test(error.message));
  }
  // Symlink entry.
  {
    const { destination, apiBase } = await serverFixture(t, gitFixture({
      rootTree: { [COMMIT]: [{ path: 'pkg', mode: '040000', type: 'tree', sha: 't-pkg' }], 't-pkg': [{ path: 'link', mode: '120000', type: 'blob', sha: '0'.repeat(40), size: 10 }] },
      blobs: {},
    }));
    await assert.rejects(makeFetcher(apiBase).fetchSubtree({ repository: REPO, commit: COMMIT, subdirectory: 'pkg', destination }), error => /符号链接/.test(error.message));
  }
  // Submodule entry.
  {
    const { destination, apiBase } = await serverFixture(t, gitFixture({
      rootTree: { [COMMIT]: [{ path: 'pkg', mode: '040000', type: 'tree', sha: 't-pkg' }], 't-pkg': [{ path: 'sub', mode: '160000', type: 'commit', sha: 'c'.repeat(40) }] },
      blobs: {},
    }));
    await assert.rejects(makeFetcher(apiBase).fetchSubtree({ repository: REPO, commit: COMMIT, subdirectory: 'pkg', destination }), error => /子模块/.test(error.message));
  }
});

test('size and file-count budgets reject oversized subtrees before installation', async t => {
  const big = blobEntry('big.bin', Buffer.alloc(256 * 1024));
  const { destination, apiBase } = await serverFixture(t, gitFixture({
    rootTree: { [COMMIT]: [{ path: 'pkg', mode: '040000', type: 'tree', sha: 't-pkg' }], 't-pkg': [big.entry] },
    blobs: { [big.sha]: big },
  }));
  const fetcher = createGitHubSubtreeFetcher({ apiBase, maxBytes: 64 * 1024 });
  await assert.rejects(fetcher.fetchSubtree({ repository: REPO, commit: COMMIT, subdirectory: 'pkg', destination }), error => /预算/.test(error.message));
  const remaining = await fsp.readdir(destination);
  assert.deepEqual(remaining, [], 'an over-budget subtree installs nothing');
});

test('subtree installs integrate with the existing inspect -> install chain and start disabled', async t => {
  const skill = blobEntry('SKILL.md', SKILL_BODY);
  const trees = {
    [COMMIT]: [{ path: 'skills', mode: '040000', type: 'tree', sha: 't-skills' }],
    't-skills': [{ path: 'demo', mode: '040000', type: 'tree', sha: 't-demo' }],
    't-demo': [skill.entry],
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-subtree-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const server = http.createServer(gitFixture({ rootTree: trees, blobs: { [skill.sha]: skill } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  const sourceDir = path.join(home, 'unused');
  fs.mkdirSync(sourceDir);
  const { createExtensionManager } = require('../extension-manager');
  const rpc = async (method, p) => {
    if (method === 'skills/list') return { data: [{ skills: [] }] };
    if (method.startsWith('extension/kernel/')) return { ok: true };
    if (method === 'workspace/path/resolve') throw new Error('not used for github sources');
    throw new Error(`Unexpected RPC ${method}`);
  };
  const manager = createExtensionManager({ home, rpc, fetchImpl: (url, options) => fetch(url.replace('https://api.github.com', apiBase), options) });
  const source = { type: 'github', repository: REPO, commit: COMMIT, subdirectory: 'skills/demo' };
  const inspected = await manager.handlers['extension/inspect']({ source });
  assert.ok(inspected.report.components.some((c) => c.format === 'agent-skill'), 'the fetched subtree inspects as an extension');
  const entry = await manager.handlers['extension/install']({ source, expectedSha256: inspected.sha256 });
  assert.equal(entry.enabled, false, 'install chain keeps the default-disabled contract');
  const packageDir = path.join(home, 'extensions', 'marketplaces', entry.id, 'packages', entry.activeVersion, 'plugin');
  assert.equal(await fsp.readFile(path.join(packageDir, 'SKILL.md'), 'utf8'), SKILL_BODY);
  assert.equal(fs.existsSync(path.join(home, 'unused')), true);
});

// X (07:34 review): root's real-HTTP reproduction — a blob inside a subtree
// plus a blob at the parent level. The plan pass alone reads stale state, so
// the live shared budget must be checked before each actual write.
test('cross-level budget: maxFiles=1 with one nested blob and one level blob is rejected', async t => {
  const nested = blobEntry('nested.txt', '12345678');
  const own = blobEntry('root.txt', '12345');
  const { destination, apiBase } = await serverFixture(t, gitFixture({
    rootTree: {
      [COMMIT]: [{ path: 'pkg', mode: '040000', type: 'tree', sha: 't-pkg' }],
      't-pkg': [{ path: 'child', mode: '040000', type: 'tree', sha: 't-child' }, own.entry],
      't-child': [nested.entry],
    },
    blobs: { [nested.sha]: nested, [own.sha]: own },
  }));
  const fetcher = createGitHubSubtreeFetcher({ apiBase, maxFiles: 1, maxBytes: F.MAX_BYTES });
  await assert.rejects(
    fetcher.fetchSubtree({ repository: REPO, commit: COMMIT, subdirectory: 'pkg', destination }),
    error => error.rpc?.code === -32082 && /预算/.test(error.message),
  );
  assert.equal(fs.existsSync(path.join(destination, 'root.txt')), false, 'the parent-level blob that busts the budget is never written');
});

test('cross-level budget: maxBytes=10 with 13 bytes across two levels is rejected', async t => {
  const nested = blobEntry('nested.txt', '12345678');
  const own = blobEntry('root.txt', '12345');
  const { destination, apiBase } = await serverFixture(t, gitFixture({
    rootTree: {
      [COMMIT]: [{ path: 'pkg', mode: '040000', type: 'tree', sha: 't-pkg' }],
      't-pkg': [{ path: 'child', mode: '040000', type: 'tree', sha: 't-child' }, own.entry],
      't-child': [nested.entry],
    },
    blobs: { [nested.sha]: nested, [own.sha]: own },
  }));
  const fetcher = createGitHubSubtreeFetcher({ apiBase, maxFiles: F.MAX_FILES, maxBytes: 10 });
  await assert.rejects(
    fetcher.fetchSubtree({ repository: REPO, commit: COMMIT, subdirectory: 'pkg', destination }),
    error => error.rpc?.code === -32082 && /预算/.test(error.message),
  );
  assert.equal(fs.existsSync(path.join(destination, 'root.txt')), false, 'the parent-level blob that busts the byte budget is never written');
});

// X (07:34 review): real-HTTP slow body — headers arrive but the JSON body
// trickles; the request timeout must stay armed THROUGH the body read.
test('a slow response body is cut off by the request timeout', async t => {
  const { destination, apiBase } = await serverFixture(t, async (req, res) => {
    if (req.url.endsWith(`/git/trees/${COMMIT}`)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"sha":"' + COMMIT + '","truncated":false,"tree":');
      // Drip the remainder past the fetcher's request timeout.
      const drip = setInterval(() => { try { res.write(' '); } catch { clearInterval(drip); } }, 50);
      res.on('close', () => clearInterval(drip));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  const fetcher = createGitHubSubtreeFetcher({ apiBase, requestTimeoutMs: 400 });
  await assert.rejects(
    fetcher.fetchSubtree({ repository: REPO, commit: COMMIT, subdirectory: 'pkg', destination }),
    error => error.rpc?.code === -32092 && /超时/.test(error.message),
  );
});

// X (07:34 review): real-HTTP large body with NO Content-Length — the cap
// must apply while streaming, not only via the declared header.
test('a body without Content-Length that exceeds the cap is cut off mid-stream', async t => {
  const { destination, apiBase } = await serverFixture(t, async (req, res) => {
    if (req.url.endsWith(`/git/trees/${COMMIT}`)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"sha":"' + COMMIT + '","truncated":false,"tree":[');
      const padding = Buffer.alloc(64 * 1024, 0x20);
      let served = 0;
      const flood = setInterval(() => {
        served += padding.length;
        res.write(padding);
        if (served > 20 * 1024 * 1024) { clearInterval(flood); res.end(']}'); }
      }, 1);
      res.on('close', () => clearInterval(flood));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  const fetcher = makeFetcher(apiBase);
  await assert.rejects(
    fetcher.fetchSubtree({ repository: REPO, commit: COMMIT, subdirectory: 'pkg', destination }),
    error => error.rpc?.code === -32092 && /安全上限/.test(error.message),
  );
});

// Network failure must clear the real request timer too; body-finally alone misses this path.
test('network failure clears its request timer', async t => {
  const { destination, apiBase } = await serverFixture(t, (req) => req.socket.destroy());
  const set = global.setTimeout, clear = global.clearTimeout;
  const owned = new Set();
  global.setTimeout = (fn, ms, ...args) => { const timer = set(fn, ms, ...args); if (ms === 23456) owned.add(timer); return timer; };
  global.clearTimeout = timer => { owned.delete(timer); return clear(timer); };
  try {
    await assert.rejects(createGitHubSubtreeFetcher({ apiBase, requestTimeoutMs: 23456 }).fetchSubtree({ repository: REPO, commit: COMMIT, subdirectory: 'pkg', destination }), e => e.rpc?.code === -32092);
    assert.equal(owned.size, 0, 'network failure retained a 23-second request timeout');
  } finally { for (const timer of owned) clear(timer); global.setTimeout = set; global.clearTimeout = clear; }
});

test('out-of-tree / cross-directory resource references fail closure check and refuse installation', async t => {
  // Test escaping markdown reference
  const badSkill = blobEntry('SKILL.md', `---\nname: bad-skill\ndescription: escapes subtree\n---\nSee [outside](../../docs/outside.md) for details.`);
  const { destination, apiBase } = await serverFixture(t, gitFixture({
    rootTree: {
      [COMMIT]: [{ path: 'pkg', mode: '040000', type: 'tree', sha: 't-pkg' }],
      't-pkg': [badSkill.entry],
    },
    blobs: { [badSkill.sha]: badSkill },
  }));
  const fetcher = makeFetcher(apiBase);
  await assert.rejects(
    fetcher.fetchSubtree({ repository: REPO, commit: COMMIT, subdirectory: 'pkg', destination }),
    error => error.rpc?.code === -32093 && /跨目录资源引用|闭包/.test(error.message),
  );
  assert.deepEqual(await fsp.readdir(destination), [], 'failed closure check leaves nothing installed');
});

test('root-relative / and script escaping require references fail closure check', async t => {
  const rootRel = blobEntry('SKILL.md', `---\nname: root-rel\ndescription: uses root path\n---\n![Logo](/assets/logo.png)`);
  {
    const { destination, apiBase } = await serverFixture(t, gitFixture({
      rootTree: {
        [COMMIT]: [{ path: 'pkg', mode: '040000', type: 'tree', sha: 't-pkg' }],
        't-pkg': [rootRel.entry],
      },
      blobs: { [rootRel.sha]: rootRel },
    }));
    await assert.rejects(
      makeFetcher(apiBase).fetchSubtree({ repository: REPO, commit: COMMIT, subdirectory: 'pkg', destination }),
      error => error.rpc?.code === -32093 && /跨目录资源引用|闭包/.test(error.message),
    );
  }

  // Script with escaping require
  const escapingScript = blobEntry('index.js', `const ext = require('../../../external.js');\n`);
  {
    const { destination, apiBase } = await serverFixture(t, gitFixture({
      rootTree: {
        [COMMIT]: [{ path: 'pkg', mode: '040000', type: 'tree', sha: 't-pkg' }],
        't-pkg': [escapingScript.entry],
      },
      blobs: { [escapingScript.sha]: escapingScript },
    }));
    await assert.rejects(
      makeFetcher(apiBase).fetchSubtree({ repository: REPO, commit: COMMIT, subdirectory: 'pkg', destination }),
      error => error.rpc?.code === -32093 && /跨目录资源引用|闭包/.test(error.message),
    );
  }
});

test('valid in-tree relative references within the subtree pass closure check', async t => {
  const mainSkill = blobEntry('SKILL.md', `---\nname: valid-skill\ndescription: valid refs\n---\nSee [notes](references/note.md) for details.`);
  const note = blobEntry('note.md', `# Notes\nBack to [Skill](../SKILL.md) or [Sibling](sub.md)`);
  const sibling = blobEntry('sub.md', `# Sub\nContent`);
  const { destination, apiBase } = await serverFixture(t, gitFixture({
    rootTree: {
      [COMMIT]: [{ path: 'pkg', mode: '040000', type: 'tree', sha: 't-pkg' }],
      't-pkg': [mainSkill.entry, { path: 'references', mode: '040000', type: 'tree', sha: 't-ref' }],
      't-ref': [note.entry, sibling.entry],
    },
    blobs: { [mainSkill.sha]: mainSkill, [note.sha]: note, [sibling.sha]: sibling },
  }));
  const outcome = await makeFetcher(apiBase).fetchSubtree({ repository: REPO, commit: COMMIT, subdirectory: 'pkg', destination });
  assert.equal(outcome.files, 3);
  assert.equal(fs.existsSync(path.join(destination, 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(destination, 'references', 'note.md')), true);
});
