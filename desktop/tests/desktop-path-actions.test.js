'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDesktopPathActions } = require('../desktop-path-actions');

function fixtureScope() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-path-action-'));
  const file = path.join(root, 'notes.txt');
  fs.writeFileSync(file, 'fixture', 'utf8');
  return { root: fs.realpathSync.native(root), file: fs.realpathSync.native(file) };
}

test('opening default task folders works on a fresh Home and rejects an outside target', async t => {
  const fixture = fixtureScope();
  t.after(() => fs.rmSync(fixture.root, {recursive:true,force:true}));
  let destination = path.join(fixture.root, 'workspaces');
  let opened;
  const actions = createDesktopPathActions({rpc:async () => ({home:fixture.root,defaultTaskLocation:destination}), dialog:{showOpenDialog:async()=>({canceled:true,filePaths:[]})}, shell:{openPath:async value => {opened=value;return '';},showItemInFolder:()=>{}}});
  await actions.handlers['desktop/open-location']({location:'defaultTaskLocation'});
  assert.equal(opened,destination);
  assert.equal(fs.statSync(destination).isDirectory(),true);
  destination = path.join(os.tmpdir(), 'knorvia-outside-' + Date.now());
  await assert.rejects(actions.handlers['desktop/open-location']({location:'defaultTaskLocation'}), /outside/);
  assert.equal(fs.existsSync(destination),false);
});

test('desktop open and reveal only hand a daemon-scoped canonical workspace file to Electron shell', async () => {
  const fixture = fixtureScope();
  const shellCalls = [];
  const rpcCalls = [];
  const actions = createDesktopPathActions({
    rpc: async (method, params) => {
      rpcCalls.push({ method, params });
      return {
        workspace: { id: 'ws_fixture', cwd: fixture.root },
        absolutePath: fixture.file,
        path: 'notes.txt',
        kind: 'file',
      };
    },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: {
      openPath: async (target) => { shellCalls.push(['open', target]); return ''; },
      showItemInFolder: (target) => shellCalls.push(['reveal', target]),
    },
  });
  try {
    assert.deepEqual(await actions.openPath({ workspaceId: 'ws_fixture', path: 'notes.txt' }), { opened: true, kind: 'file' });
    assert.deepEqual(await actions.revealPath({ threadId: 'th_fixture', path: 'notes.txt' }), { revealed: true, kind: 'file' });
    assert.deepEqual(shellCalls, [['open', fixture.file], ['reveal', fixture.file]]);
    assert.deepEqual(rpcCalls.map((call) => call.method), ['workspace/path/resolve', 'workspace/path/resolve']);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('desktop path actions allow the daemon-defined empty relative path for the workspace root', async () => {
  const fixture = fixtureScope();
  const rpcCalls = [];
  const actions = createDesktopPathActions({
    rpc: async (method, params) => {
      rpcCalls.push({ method, params });
      return {
        workspace: { id: 'ws_fixture', cwd: fixture.root },
        absolutePath: fixture.root,
        path: '',
        kind: 'directory',
      };
    },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openPath: async () => '', showItemInFolder: () => {} },
  });
  try {
    assert.deepEqual(await actions.openPath({ workspaceId: 'ws_fixture', path: '' }), { opened: true, kind: 'directory' });
    assert.deepEqual(rpcCalls, [{ method: 'workspace/path/resolve', params: { workspaceId: 'ws_fixture', path: '' } }]);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('desktop path actions accept an in-scope resolver symlink only through its canonical target', async () => {
  const fixture = fixtureScope();
  const shellCalls = [];
  const actions = createDesktopPathActions({
    rpc: async () => ({
      workspace: { id: 'ws_fixture', cwd: fixture.root },
      // A valid daemon result may identify the renderer path as a symlink,
      // while handing Electron its canonical in-scope target.
      absolutePath: fixture.file,
      path: 'link-to-notes.txt',
      kind: 'symlink',
    }),
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openPath: async (target) => { shellCalls.push(target); return ''; }, showItemInFolder: () => {} },
  });
  try {
    assert.deepEqual(await actions.openPath({ workspaceId: 'ws_fixture', path: 'link-to-notes.txt' }), { opened: true, kind: 'file' });
    assert.deepEqual(shellCalls, [fixture.file]);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('desktop path actions reject a renderer path escape before daemon or shell access', async () => {
  const actions = createDesktopPathActions({
    rpc: async () => assert.fail('path escape reached daemon'),
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openPath: async () => assert.fail('path escape reached shell'), showItemInFolder: () => assert.fail('path escape reached shell') },
  });
  await assert.rejects(actions.openPath({ workspaceId: 'ws_fixture', path: '../outside.txt' }), (error) => {
    assert.equal(error.rpc?.code, -32602);
    return true;
  });
  await assert.rejects(actions.openPath({ workspaceId: 'ws_fixture', path: 'C:outside.txt' }), (error) => {
    assert.equal(error.rpc?.code, -32602);
    return true;
  });
});

test('desktop folder selection returns only a native dialog choice and accepts a stale default path harmlessly', async () => {
  const fixture = fixtureScope();
  let options;
  const actions = createDesktopPathActions({
    rpc: async () => assert.fail('folder selection must not call scope resolver'),
    dialog: {
      showOpenDialog: async (received) => {
        options = received;
        return { canceled: false, filePaths: [fixture.root] };
      },
    },
    shell: { openPath: async () => '', showItemInFolder: () => {} },
  });
  try {
    const selected = await actions.selectFolder({ defaultPath: path.join(fixture.root, 'stale') });
    assert.deepEqual(selected, { cancelled: false, path: fixture.root });
    assert.equal(Object.hasOwn(options, 'defaultPath'), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('desktop folder selection rejects a non-directory result even if a mocked dialog returns it', async () => {
  const fixture = fixtureScope();
  const actions = createDesktopPathActions({
    rpc: async () => assert.fail('folder selection must not call scope resolver'),
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [fixture.file] }) },
    shell: { openPath: async () => '', showItemInFolder: () => {} },
  });
  try {
    await assert.rejects(actions.selectFolder(), (error) => {
      assert.equal(error.rpc?.code, -32042);
      return true;
    });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
