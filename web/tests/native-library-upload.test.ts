import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { saveLibraryFile, type LibraryRequest } from '../lib/native-library';

const desktopRequire = createRequire(path.resolve(process.cwd(), 'package.json'));
const { validateNativeRequest } = desktopRequire('../desktop/native-rpc-router.js');

test('new and versioned reference uploads survive the actual desktop JSON gate without a WebSocket serialization step', async () => {
  for (const expectedSha256 of [undefined, 'a'.repeat(64)]) {
    const chunks: Uint8Array[] = [];
    const request: LibraryRequest = async <T>(method: string, params?: Record<string, unknown>) => {
      const message = structuredClone({ jsonrpc: '2.0', id: 'library-upload', method, params });
      const validated = validateNativeRequest(message);
      assert.equal(validated.error, undefined, JSON.stringify(validated.error));
      if (method === 'library/upload/start') {
        assert.equal(Object.hasOwn(params!, 'expectedSha256'), expectedSha256 !== undefined);
        assert.equal(params!.expectedSha256, expectedSha256);
        return { id: 'upload-1', chunkBytes: 3 } as T;
      }
      if (method === 'library/upload/chunk') {
        chunks.push(Uint8Array.from(Buffer.from(String(params!.base64), 'base64')));
        return {} as T;
      }
      assert.equal(method, 'library/upload/finish');
      return { id: 'image-1' } as T;
    };
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const result = await saveLibraryFile(request, '画布素材/参考.png', bytes, expectedSha256);
    assert.equal(result.id, 'image-1');
    assert.deepEqual(Buffer.concat(chunks), Buffer.from(bytes));
  }
});
