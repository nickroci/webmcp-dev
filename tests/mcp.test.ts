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
import { PluginStore } from '../src/mcp/plugins';
import { demoFiles } from './plugins.test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const MANAGEMENT_TOOLS = ['webmcp_request_connection', 'webmcp_list_tabs', 'webmcp_select_tab', 'webmcp_refresh_tools', 'webmcp_doctor', 'webmcp_call_tool', 'webmcp_list_plugins', 'webmcp_read_plugin', 'webmcp_install_plugin', 'webmcp_remove_plugin', 'webmcp_evaluate'];

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
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), MANAGEMENT_TOOLS);
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
    assert.equal((await second.listTools()).tools.length, MANAGEMENT_TOOLS.length);
    await second.close(); await secondServer.close(); secondConnection.close();
    chrome.send(JSON.stringify({ type: 'snapshot', tabs: [] }));
    await waitTabs(connection, 0);
    assert.equal((await client.listTools()).tools.length, MANAGEMENT_TOOLS.length);
    assert.ok(changed > 0);
  } finally { await client.close(); await server.close(); connection.close(); chrome.close(); await relay.close(); }
});

test('doctor names a stale document and the only remedy for it', async () => {
  const config = await bridgeConfig(); const relay = await startRelay(config);
  const chrome = await browser(config); const connection = await RelayClient.connect(config);
  const server = createMcpServer(connection); const client = new Client({ name: 'test-agent', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const report = async () => {
    const response = await client.callTool({ name: 'webmcp_doctor', arguments: {} });
    return JSON.parse((response.content as Array<{ text: string }>)[0].text).data;
  };
  try {
    await server.connect(a); await client.connect(b);
    assert.match((await report()).problems.join(' '), /No tab is shared/);

    const stale: SharedTab = { ...sample, runtimeVersion: '0.3.0', plugins: [{ id: 'fixture', name: 'Fixture', version: '0.4.0', expected: '0.5.0', stale: true }] };
    chrome.send(JSON.stringify({ type: 'snapshot', tabs: [stale] }));
    await waitTabs(connection);
    const bad = await report();
    assert.equal(bad.healthy, false);
    assert.equal(bad.tabs[0].stale, true);
    assert.deepEqual(bad.tabs[0].plugins, [{ id: 'fixture', name: 'Fixture', source: null, running: '0.4.0', installed: '0.5.0', stale: true }]);
    // The extension re-runs the installed bundle itself; the remedy is to check again, not to open a new tab.
    assert.match(bad.problems.join(' '), /re-injects the installed revision/);

    const fresh: SharedTab = { ...sample, runtimeVersion: '0.3.0', plugins: [{ id: 'fixture', name: 'Fixture', version: '0.5.0', expected: '0.5.0', stale: false }] };
    chrome.send(JSON.stringify({ type: 'snapshot', tabs: [] }));
    await waitTabs(connection, 0);
    chrome.send(JSON.stringify({ type: 'snapshot', tabs: [fresh], capabilities: { devMode: true, userScripts: true, extensionVersion: '0.6.0' } }));
    const [tab] = await waitTabs(connection);
    await client.callTool({ name: 'webmcp_select_tab', arguments: { tab: tab.key } });
    const good = await report();
    assert.equal(good.healthy, true);
    assert.deepEqual(good.problems, []);
    assert.equal(good.selected, tab.key);
    assert.equal(good.tabs[0].tool_count, 1);

    // A tab from a build before this diagnostic reports nothing, which is itself the signal.
    chrome.send(JSON.stringify({ type: 'snapshot', tabs: [] }));
    await waitTabs(connection, 0);
    chrome.send(JSON.stringify({ type: 'snapshot', tabs: [sample] }));
    await waitTabs(connection);
    assert.match((await report()).problems.join(' '), /predates this diagnostic/);
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

test('agents install, read, evaluate against and remove plugins through the relay, gated by the browser’s dev mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'webmcp-mcp-plugins-'));
  const store = new PluginStore(join(dir, 'plugins')); await store.load();
  const config = await bridgeConfig(); const relay = await startRelay(config, { store });
  const received: any[] = [];
  const chrome = new WebSocket(`ws://127.0.0.1:${config.port}/browser`, { origin: `chrome-extension://${'a'.repeat(32)}` });
  chrome.on('message', raw => {
    const message = JSON.parse(raw.toString()); received.push(message);
    if (message.type === 'install') chrome.send(JSON.stringify({ type: 'reply', id: message.id, result: { ok: true, tabs: [{ tabId: 9, url: 'https://demo.test/page', shared: true, ok: true, tools: ['demo_site_hello'] }] } }));
    if (message.type === 'call' && message.call.code) chrome.send(JSON.stringify({ type: 'result', id: message.id, result: { ok: true, data: { title: 'Demo page', length: message.call.code.length } } }));
  });
  await once(chrome, 'open');
  chrome.send(JSON.stringify({ type: 'hello', version: 1, token: config.browserToken, browserId: randomUUID() }));
  const connection = await RelayClient.connect(config);
  const server = createMcpServer(connection); const client = new Client({ name: 'builder-agent', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args });
    return JSON.parse((response.content as Array<{ text: string }>)[0].text) as { ok: boolean; data: any; error?: { code: string; message: string; details?: unknown } };
  };
  try {
    await server.connect(a); await client.connect(b);
    // Right after ready, every browser receives the full catalog: empty for now.
    for (let attempt = 0; attempt < 100 && !received.some(message => message.type === 'catalog'); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(received.map(message => message.type), ['ready', 'catalog']);
    assert.deepEqual(received[1].plugins, []);
    chrome.send(JSON.stringify({ type: 'snapshot', tabs: [{ ...sample, url: 'https://demo.test/page', tools: [] }], capabilities: { devMode: false, userScripts: true, extensionVersion: '0.6.0' } }));
    const [tab] = await waitTabs(connection);
    await client.callTool({ name: 'webmcp_select_tab', arguments: { tab: tab.key } });
    const refused = await call('webmcp_install_plugin', { files: demoFiles() });
    assert.equal(refused.error?.code, 'DEV_MODE_DISABLED');
    assert.match((await call('webmcp_doctor')).data.problems.join(' '), /Let agents develop plugins/);
    assert.deepEqual(await readdir(join(dir, 'plugins')), []);

    chrome.send(JSON.stringify({ type: 'snapshot', tabs: [{ ...sample, url: 'https://demo.test/page', tools: [] }], capabilities: { devMode: true, userScripts: true, extensionVersion: '0.6.0' } }));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await call('webmcp_doctor')).data.healthy, true);
    const bad = await call('webmcp_install_plugin', { files: { ...demoFiles(), 'index.ts': 'export const plugin = {' }, note: 'broken' });
    assert.equal(bad.error?.code, 'COMPILE_ERROR');
    const installed = await call('webmcp_install_plugin', { files: demoFiles('hi'), note: 'first cut' });
    assert.equal(installed.ok, true, JSON.stringify(installed));
    assert.equal(installed.data.plugin.id, 'demo-site');
    assert.equal(installed.data.plugin.installedBy, 'builder-agent');
    assert.equal(installed.data.plugin.code, undefined);
    assert.deepEqual(installed.data.browsers[0].tabs[0].tools, ['demo_site_hello']);
    const pushed = received.find(message => message.type === 'install');
    assert.equal(pushed.plugin.id, 'demo-site');
    assert.match(pushed.plugin.code, /demo_site_hello/);
    assert.deepEqual(await readdir(join(dir, 'plugins')), ['demo-site']);
    const listed = await call('webmcp_list_plugins');
    assert.ok(listed.data.plugins.some((plugin: { id: string; source: string; note?: string }) => plugin.id === 'demo-site' && plugin.source === 'dynamic' && plugin.note === 'first cut'));
    const read = await call('webmcp_read_plugin', { id: 'demo-site' });
    assert.equal(read.data.files['index.ts'], demoFiles('hi')['index.ts']);
    assert.equal(read.data.path, join(dir, 'plugins/demo-site'));
    const evaluated = await call('webmcp_evaluate', { code: 'return { title: document.title };' });
    assert.deepEqual(evaluated.data, { title: 'Demo page', length: 'return { title: document.title };'.length });
    const syntax = await call('webmcp_evaluate', { code: 'return {' });
    assert.equal(syntax.error?.code, 'INVALID_INPUT');
    assert.match(syntax.error!.message, /Syntax error/);
    const removed = await call('webmcp_remove_plugin', { id: 'demo-site' });
    assert.deepEqual(removed.data, { removed: true });
    assert.deepEqual(await readdir(join(dir, 'plugins')), []);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(received.some(message => message.type === 'remove' && message.pluginId === 'demo-site'));
    assert.equal((await call('webmcp_remove_plugin', { id: 'reddit' })).error?.code, 'UNKNOWN_PLUGIN');
  } finally { await client.close(); await server.close(); connection.close(); chrome.close(); await relay.close(); await rm(dir, { recursive: true, force: true }); }
});
