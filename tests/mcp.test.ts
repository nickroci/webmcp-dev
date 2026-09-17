import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { bridgeConfig } from './bridge-fixtures';
import { startRelay } from '../src/mcp/relay';
import { RelayClient } from '../src/mcp/client';
import { createMcpServer } from '../src/mcp/server';
import type { BridgeConfig } from '../src/mcp/config';
import type { RemoteTab, SharedTab } from '../src/mcp/protocol';

async function browser(config: BridgeConfig) {
  const socket = new WebSocket(`ws://127.0.0.1:${config.port}/browser`, { origin: `chrome-extension://${'a'.repeat(32)}` });
  await once(socket, 'open');
  const ready = once(socket, 'message');
  socket.send(JSON.stringify({ type: 'hello', version: 1, token: config.browserToken, browserId: randomUUID() }));
  assert.equal(JSON.parse((await ready)[0].toString()).type, 'ready');
  return socket;
}
const sample: SharedTab = { tabId: 9, documentId: 'document-one', url: 'https://example.test/', title: 'Fixture', tools: [{ name: 'fixture_echo', description: 'Echo array input', pluginId: 'fixture', pluginName: 'Fixture', inputSchema: { type: 'array', items: { $ref: '#/$defs/item' }, $defs: { item: { type: ['string', 'null'] } } }, outputSchema: { type: 'array', items: { $ref: '#/$defs/item' }, $defs: { item: { type: ['string', 'null'] } } }, annotations: { readOnlyHint: true, consequentialHint: false, untrustedContentHint: true } }] };
async function waitTabs(relay: RelayClient, count = 1) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await relay.request('tabs');
    if (response.ok && (response.data as RemoteTab[]).length === count) return response.data as RemoteTab[];
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Expected shared tabs');
}

test('MCP dynamically exposes site schemas, wraps root values, and keeps independent tab selections', async () => {
  const config = await bridgeConfig(); const relay = await startRelay(config);
  const chrome = await browser(config); const connection = await RelayClient.connect(config);
  const server = createMcpServer(connection); const client = new Client({ name: 'test-agent', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  let changed = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { changed++; });
  try {
    await server.connect(a); await client.connect(b);
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['webmcp_request_connection', 'webmcp_list_tabs', 'webmcp_select_tab', 'webmcp_refresh_tools', 'webmcp_call_tool']);
    chrome.send(JSON.stringify({ type: 'snapshot', tabs: [sample] }));
    const [tab] = await waitTabs(connection);
    await client.callTool({ name: 'webmcp_select_tab', arguments: { tab: tab.key } });
    const listed = await client.listTools();
    assert.equal(listed.tools.find(tool => tool.name === 'fixture_echo')?.inputSchema.properties?.value !== undefined, true);
    chrome.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'call') chrome.send(JSON.stringify({ type: 'result', id: message.id, result: { ok: true, data: message.call.input } }));
    });
    const called = await client.callTool({ name: 'fixture_echo', arguments: { value: ['hello', null] } });
    assert.deepEqual(called.structuredContent, { ok: true, data: ['hello', null] });
    const fallback = await client.callTool({ name: 'webmcp_call_tool', arguments: { tool: 'fixture_echo', input: ['fallback', null] } });
    assert.deepEqual(fallback.structuredContent, { ok: true, data: ['fallback', null] });
    const secondConnection = await RelayClient.connect(config);
    const secondServer = createMcpServer(secondConnection); const second = new Client({ name: 'second', version: '1' });
    const [c, d] = InMemoryTransport.createLinkedPair();
    await secondServer.connect(c); await second.connect(d);
    assert.equal((await second.listTools()).tools.length, 5);
    await second.close(); await secondServer.close(); secondConnection.close();
    chrome.send(JSON.stringify({ type: 'snapshot', tabs: [] }));
    await waitTabs(connection, 0);
    assert.equal((await client.listTools()).tools.length, 5);
    assert.ok(changed > 0);
  } finally { await client.close(); await server.close(); connection.close(); chrome.close(); await relay.close(); }
});

test('relay rejects stale documents, serializes calls, forwards cancellation and reports uncertain disconnects', async () => {
  const config = await bridgeConfig(); const relay = await startRelay(config);
  const chrome = await browser(config); const connection = await RelayClient.connect(config);
  try {
    chrome.send(JSON.stringify({ type: 'snapshot', tabs: [sample] }));
    const [tab] = await waitTabs(connection);
    const call = { browserId: tab.browserId, tabId: tab.tabId, documentId: tab.documentId, url: tab.url, name: 'fixture_echo', input: [] };
    assert.deepEqual(await connection.request('call', { ...call, documentId: 'old-document' }), { ok: false, error: { code: 'STALE_TAB', message: 'The shared page changed or disconnected. Refresh tools before trying again.' } });
    const sent = once(chrome, 'message');
    const controller = new AbortController();
    const pending = connection.request('call', call, controller.signal);
    const pendingRejected = assert.rejects(pending, /cancelled/);
    const message = JSON.parse((await sent)[0].toString());
    assert.equal(message.type, 'call');
    const busy = await connection.request('call', call);
    assert.equal(!busy.ok && busy.error.code, 'TAB_BUSY');
    const cancelled = once(chrome, 'message'); controller.abort();
    assert.equal(JSON.parse((await cancelled)[0].toString()).type, 'cancel');
    await pendingRejected;
    chrome.send(JSON.stringify({ type: 'result', id: message.id, result: { ok: false, error: { code: 'ABORTED', message: 'Cancelled' } } }));
    await connection.request('tabs');
    await new Promise(resolve => setTimeout(resolve, 10));
    const next = once(chrome, 'message');
    const uncertain = connection.request('call', call); await next; chrome.close();
    const outcome = await uncertain;
    assert.equal(!outcome.ok && outcome.error.code, 'OUTCOME_UNKNOWN');
  } finally { connection.close(); chrome.close(); await relay.close(); }
});

test('relay requires role-specific credentials and rejects website origins', async () => {
  const config = await bridgeConfig(); const relay = await startRelay(config);
  try {
    await assert.rejects(RelayClient.connect({ ...config, agentToken: config.browserToken }), /authentication/);
    const website = new WebSocket(`ws://127.0.0.1:${config.port}/browser`, { origin: 'https://example.test' });
    await once(website, 'error');
    const unauthenticated = new WebSocket(`ws://127.0.0.1:${config.port}/agent`);
    await once(unauthenticated, 'open');
    unauthenticated.send(JSON.stringify({ type: 'hello', version: 1, token: 'é'.repeat(64) }));
    assert.equal((await once(unauthenticated, 'close'))[0], 1008);
  } finally { await relay.close(); }
});
