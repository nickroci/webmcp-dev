import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { bridgeConfig } from './bridge-fixtures';
import { startRelay } from '../src/mcp/relay';
import { RelayClient } from '../src/mcp/client';

async function discovery(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/pairing`, { origin: `chrome-extension://${'b'.repeat(32)}` });
  const first = JSON.parse((await once(socket, 'message'))[0].toString());
  return { socket, first };
}
function message(socket: WebSocket, type: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('message', handler); reject(new Error(`No ${type} message`)); }, 2000);
    const handler = (raw: unknown) => {
      const value = JSON.parse(String(raw));
      if (value.type === type) { clearTimeout(timer); socket.off('message', handler); resolve(value); }
    };
    socket.on('message', handler);
  });
}

test('agent requests need an extension decision; credentials only go to the approving connection', async () => {
  const config = await bridgeConfig(); const relay = await startRelay(config);
  const agent = await RelayClient.connect(config); const otherAgent = await RelayClient.connect(config);
  const { socket, first } = await discovery(config.port); const other = await discovery(config.port);
  try {
    assert.deepEqual(first, { type: 'requests', requests: [] });
    const pending = message(socket, 'requests');
    const requested = await agent.request('pairing:request', { clientName: 'Codex' });
    assert.equal(requested.ok, true);
    const request = (requested as any).data;
    assert.equal(request.status, 'pending');
    assert.equal((await pending).requests[0].code, request.code);
    assert.ok(!JSON.stringify(requested).includes(config.browserToken));
    assert.deepEqual(await agent.request('tabs'), { ok: true, data: [] });
    const forbidden = await otherAgent.request('pairing:request', { clientName: 'Other', request_id: request.id });
    assert.equal(!forbidden.ok && forbidden.error.code, 'REQUEST_NOT_FOUND');
    const granted = message(socket, 'paired'); const cleared = message(other.socket, 'requests');
    const browserId = randomUUID();
    socket.send(JSON.stringify({ type: 'approve', id: request.id, browserId }));
    assert.equal((await granted).pairing.token, config.browserToken);
    assert.deepEqual(await cleared, { type: 'requests', requests: [] });
    const status = await agent.request('pairing:request', { clientName: 'Codex', request_id: request.id });
    assert.equal((status as any).data.status, 'approved'); assert.equal((status as any).data.browserId, browserId);
    assert.deepEqual(await agent.request('tabs'), { ok: true, data: [] });
    const replay = message(socket, 'pairing-error');
    socket.send(JSON.stringify({ type: 'approve', id: request.id, browserId }));
    assert.match((await replay).message, /no longer pending/);
  } finally { agent.close(); otherAgent.close(); socket.close(); other.socket.close(); await relay.close(); }
});

test('declined and expired requests cannot pair; disconnect withdraws pending requests', async () => {
  const config = await bridgeConfig(); const relay = await startRelay(config, { pairingTimeoutMs: 150 });
  const agent = await RelayClient.connect(config); const { socket } = await discovery(config.port);
  try {
    const request = (await agent.request('pairing:request', { clientName: 'Agent' }) as any).data;
    const declined = message(socket, 'declined'); socket.send(JSON.stringify({ type: 'decline', id: request.id })); await declined;
    assert.equal((await agent.request('pairing:request', { clientName: 'Agent', request_id: request.id }) as any).data.status, 'declined');
    const rejected = message(socket, 'pairing-error'); socket.send(JSON.stringify({ type: 'approve', id: request.id, browserId: randomUUID() })); await rejected;
    const expiring = (await agent.request('pairing:request', { clientName: 'Agent' }) as any).data;
    await new Promise(resolve => setTimeout(resolve, 170));
    assert.equal((await agent.request('pairing:request', { clientName: 'Agent', request_id: expiring.id }) as any).data.status, 'expired');
    const pending = message(socket, 'requests'); await agent.request('pairing:request', { clientName: 'Agent' }); await pending;
    const withdrawn = message(socket, 'requests'); agent.close(); assert.deepEqual((await withdrawn).requests, []);
  } finally { agent.close(); socket.close(); await relay.close(); }
});

test('websites cannot subscribe to pairing requests', async () => {
  const config = await bridgeConfig(); const relay = await startRelay(config);
  try {
    const website = new WebSocket(`ws://127.0.0.1:${config.port}/pairing`, { origin: 'https://www.reddit.com' });
    await once(website, 'error');
  } finally { await relay.close(); }
});
