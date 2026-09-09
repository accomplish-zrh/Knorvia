'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { spawn } = require('node:child_process'); const { tryLock } = require('../media-lock');
const delay = ms => new Promise(r => setTimeout(r, ms));
function worker(file, hold) {
  const source = `const {tryLock}=require(${JSON.stringify(require.resolve('../media-lock'))});const l=tryLock(process.argv[1],{staleMs:25});console.log(l?'OWNED':'BUSY');if(l)setTimeout(()=>{l.release();process.exit(0)},Number(process.argv[2]));`;
  const child = spawn(process.execPath, ['-e', source, file, String(hold)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const done = new Promise(resolve => child.once('exit', resolve));
  const ready = new Promise((resolve, reject) => { child.once('error', reject); child.stdout.once('data', data => resolve(String(data).trim())); });
  return { child, ready, done };
}
test('real competing processes cannot take a live long-wait owner; process exit recovers', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kn-media-mutex-')); const file = path.join(root, 'dispatch.json');
  const a = worker(file, 60000); t.after(() => a.child.kill()); assert.equal(await a.ready, 'OWNED');
  await delay(100);
  const rivals = Array.from({ length: 8 }, () => worker(file, 1));
  assert.deepEqual(await Promise.all(rivals.map(v => v.ready)), Array(8).fill('BUSY')); await Promise.all(rivals.map(v => v.done));
  a.child.kill(); await a.done;
  const b = worker(file, 60000); t.after(() => b.child.kill()); assert.equal(await b.ready, 'OWNED');
  assert.equal(tryLock(file), null); b.child.kill(); await b.done;
  const owned = tryLock(file); assert.ok(owned); const token = JSON.parse(fs.readFileSync(file, 'utf8')).token;
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token: 'another-owner' }));
  owned.release(); assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'another-owner');
  assert.notEqual(token, 'another-owner');
});

test('process death while owning the reclaim guard remains recoverable', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kn-media-reclaim-')), file = path.join(root, 'dispatch.json');
  const owner = worker(file, 60000); t.after(() => owner.child.kill()); assert.equal(await owner.ready, 'OWNED');
  owner.child.kill(); await owner.done;
  const guard = worker(`${file}.reclaim`, 60000); t.after(() => guard.child.kill()); assert.equal(await guard.ready, 'OWNED');
  assert.equal(tryLock(file), null, 'live recovery guard cannot be stolen');
  guard.child.kill(); await guard.done;
  const reclaimed = tryLock(file); assert.ok(reclaimed); assert.ok(reclaimed.owns()); reclaimed.release();
  assert.deepEqual(fs.readdirSync(root), [], 'all orphan and temporary guards cleaned after recovery');
});
