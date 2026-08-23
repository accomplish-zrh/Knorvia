import test from 'node:test'
import assert from 'node:assert/strict'

import { hashFileSha256, IncrementalSha256 } from '../lib/video-studio/sha256'

const encoder = new TextEncoder()

test('incremental SHA-256 matches standard vectors across chunk boundaries', () => {
  assert.equal(
    new IncrementalSha256().update(encoder.encode('abc')).hex(),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  )
  const hash = new IncrementalSha256()
  hash.update(encoder.encode('a'.repeat(63)))
  hash.update(encoder.encode('b'.repeat(80)))
  assert.equal(hash.hex(), '0c6ff2ec21b7e9117bfc2507e7509604e37341f35b8471e8a8eb8970adcb5ec3')
})

test('file hashing is abortable and does not require one giant ArrayBuffer', async () => {
  const progress: number[] = []
  assert.equal(
    await hashFileSha256(new Blob([encoder.encode('abc')]), undefined, value => progress.push(value)),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  )
  assert.equal(progress.at(-1), 1)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(hashFileSha256(new Blob(['blocked']), controller.signal), /cancelled/)
})
