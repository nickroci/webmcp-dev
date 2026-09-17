import { test } from 'node:test';
import assert from 'node:assert/strict';
import { definePlugin, defineTool, z } from '../src/sdk';
import { installWebMCPDeveloper } from '../src/core/runtime';
import { matchesPattern } from '../src/core/matches';
import type { PluginTool, ModelContext } from '../src/core/types';
import { memoryStorage } from './fixtures';

function fixture() {
  const native = new Map<string, any>();
  let registrations = 0;
  const modelContext: ModelContext = {
    registerTool(tool, { signal } = { signal: new AbortController().signal }) {
      registrations++; native.set(tool.name, tool);
      signal.addEventListener('abort', () => native.delete(tool.name));
    },
  };
  const win = { location: { href: 'https://example.test/page', origin: 'https://example.test' },
    document: { modelContext }, navigator: {}, fetch, sessionStorage: memoryStorage() } as unknown as Window;
  return { win, native, registrations: () => registrations, runtime: installWebMCPDeveloper(win) };
}
const annotations = { readOnlyHint: true, consequentialHint: false, untrustedContentHint: true };
function tool(name: string, value = 1) {
  return defineTool({ name, description: 'Fixture tool', schema: z.strictObject({}), annotations, execute: () => value });
}
function plugin(id: string, tools: PluginTool[] | (() => PluginTool[] | Promise<PluginTool[]>)) {
  return definePlugin({ manifest: { apiVersion: 1, id, name: id, version: '1.0.0', description: 'Fixture', matches: ['https://example.test/*'] }, setup: () => ({ tools }) });
}

test('site matching honors schemes, host boundaries, paths, and escaped literals', () => {
  assert.equal(matchesPattern('https://*.example.test/path/*', 'https://a.example.test/path/x?q=1'), true);
  assert.equal(matchesPattern('https://*.example.test/*', 'https://example.test/'), true);
  assert.equal(matchesPattern('*://example.test/a.b*', 'http://example.test/a.b?q=1'), true);
  for (const url of ['https://example.test.evil/a.b', 'https://badexample.test/a.b', 'file://example.test/a.b', 'https://example.test/axb']) {
    assert.equal(matchesPattern('https://example.test/a.b*', url), false, url);
  }
  assert.equal(matchesPattern('https://example.test/*', 'http://example.test/'), false);
  assert.equal(matchesPattern('<all_urls>', 'https://example.test/'), false);
});

test('multiple plugins coexist and a name conflict cannot replace another plugin', async () => {
  const { runtime, native } = fixture();
  await runtime.registerPlugin(plugin('one', [tool('one_read')])).ready;
  await runtime.registerPlugin(plugin('two', [tool('two_read', 2)])).ready;
  assert.deepEqual(runtime.listTools().map(t => t.pluginId), ['one', 'two']);
  assert.deepEqual(await runtime.callTool('two_read', {}), { ok: true, data: 2 });
  const bad = runtime.registerPlugin(plugin('bad', [tool('one_read', 99)]));
  await bad.ready;
  assert.match(bad.status().refreshError!, /already used/);
  assert.deepEqual(await runtime.callTool('one_read', {}), { ok: true, data: 1 });
  assert.equal(native.size, 2);
  runtime.unregisterPlugin('one');
  assert.equal(native.has('one_read'), false);
  assert.equal(native.has('two_read'), true);
});

test('dynamic discovery adds, changes, and removes tools without duplicate native registrations', async () => {
  const { runtime, native, registrations } = fixture();
  let tools = [tool('dynamic_one')];
  const api = runtime.registerPlugin(plugin('dynamic', async () => tools));
  assert.deepEqual(await runtime.callTool('dynamic_one', {}), { ok: true, data: 1 });
  tools = [tool('dynamic_one', 2), tool('dynamic_two')];
  await api.refreshTools();
  assert.equal(registrations(), 2);
  assert.deepEqual(JSON.parse(await native.get('dynamic_one').execute({})), { ok: true, data: 2 });
  tools = [{ ...tool('dynamic_two'), description: 'Changed description' }];
  await api.refreshTools();
  assert.deepEqual([...native.keys()], ['dynamic_two']);
  assert.equal(registrations(), 3);
});

test('failed dynamic updates keep the last working tools and can recover', async () => {
  const { runtime } = fixture();
  let tools = [tool('state_read')];
  const api = runtime.registerPlugin(plugin('state', () => tools)); await api.ready;
  tools = [tool('duplicate'), tool('duplicate')];
  await assert.rejects(api.refreshTools(), /already used/);
  assert.deepEqual(api.listTools().map(t => t.name), ['state_read']);
  tools = [tool('state_new')];
  await api.refreshTools();
  assert.equal(api.status().refreshError, undefined);
  assert.deepEqual(api.listTools().map(t => t.name), ['state_new']);
});

test('subscribe triggers discovery and disable cleans listeners and aborts execution', async () => {
  const { runtime } = fixture();
  let notify = () => {}; let cleaned = false; let tools = [tool('live_read')];
  const p = plugin('live', () => tools);
  p.setup = () => ({ tools: () => tools, subscribe(callback) { notify = callback; return () => { cleaned = true; }; } });
  const api = runtime.registerPlugin(p); await api.ready;
  tools = [defineTool({ name: 'live_wait', description: 'Wait for cancellation', schema: z.strictObject({}), annotations,
    execute: (_input, { signal }) => new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason))) })];
  notify(); await api.refreshTools();
  const pending = api.callTool('live_wait', {});
  await new Promise(resolve => setImmediate(resolve));
  runtime.unregisterPlugin('live');
  assert.deepEqual(await pending, { ok: false, error: { code: 'ABORTED', message: 'Tool execution cancelled.' } });
  assert.equal(cleaned, true);
  assert.equal(runtime.listTools().length, 0);
  await runtime.registerPlugin(plugin('live', [tool('live_read')])).ready;
  assert.equal(runtime.listTools().length, 1);
});

test('nested, array, nullable, and union input types are validated along with outputs', async () => {
  const { runtime } = fixture();
  const schema = z.strictObject({ items: z.array(z.strictObject({ value: z.union([z.string(), z.number()]) })), maybe: z.string().nullable() });
  const echo = defineTool({ name: 'typed_echo', description: 'Echo typed inputs', schema, output: schema, annotations, execute: input => input });
  const bad = defineTool({ name: 'typed_bad', description: 'Broken output', schema: z.strictObject({}), output: z.strictObject({ count: z.number() }), annotations, execute: () => ({ count: 'oops' } as any) });
  const api = runtime.registerPlugin(plugin('typed', [echo, bad])); await api.ready;
  const input = { items: [{ value: 1 }, { value: 'two' }], maybe: null };
  assert.deepEqual(await api.callTool('typed_echo', input), { ok: true, data: input });
  const invalid = await api.callTool('typed_echo', { ...input, items: [{ value: true }] });
  assert.equal(!invalid.ok && invalid.error.code, 'INVALID_INPUT');
  const invalidOutput = await api.callTool('typed_bad', {});
  assert.equal(!invalidOutput.ok && invalidOutput.error.code, 'INVALID_OUTPUT');
  assert.equal(api.listTools()[0].outputSchema!.type, 'object');
});

test('incompatible plugin versions and unsupported sites fail explicitly', async () => {
  const { runtime } = fixture();
  const first = plugin('versioned', [tool('versioned_read')]);
  const api = runtime.registerPlugin(first); await api.ready;
  assert.equal(runtime.registerPlugin(first), api);
  assert.throws(() => runtime.registerPlugin({ ...first, manifest: { ...first.manifest, version: '2.0.0' } }), /Reload/);
  assert.throws(() => runtime.registerPlugin({ ...first, manifest: { ...first.manifest, matches: ['https://other.test/*'] } }), /does not support/);
  assert.throws(() => runtime.registerPlugin({ ...first, manifest: { ...first.manifest, apiVersion: 2 } } as any), /version 1/);
});
