import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendWorkerMessage, WorkerUnavailableError } from '../extension/messages';

test('missing worker replies give a recoverable error instead of dereferencing undefined.ok', async () => {
  const previous = globalThis.chrome;
  try {
    for (const reply of [undefined, null, {}, { ok: 'true' }]) {
      globalThis.chrome = { runtime: { sendMessage: async () => reply } } as unknown as typeof chrome;
      await assert.rejects(sendWorkerMessage({ type: 'agent:share', tabId: 1 }), error => error instanceof WorkerUnavailableError && /Reload the extension/.test(error.message));
    }
    globalThis.chrome = { runtime: { sendMessage: async () => { throw new Error('Receiving end does not exist'); } } } as unknown as typeof chrome;
    await assert.rejects(sendWorkerMessage({ type: 'agent:status' }), WorkerUnavailableError);
    globalThis.chrome = { runtime: { sendMessage: async () => ({ ok: false, error: 'A useful worker error' }) } } as unknown as typeof chrome;
    assert.deepEqual(await sendWorkerMessage({ type: 'agent:share' }), { ok: false, error: 'A useful worker error' });
  } finally { globalThis.chrome = previous; }
});
