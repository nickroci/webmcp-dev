import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { PluginError, PluginStore } from '../src/mcp/plugins';
import { memoryStorage } from './fixtures';
import { demoFiles, demoManifest } from './plugin-fixtures';

/** Run a compiled bundle against a minimal window, the way a page would. */
// Values cross the vm realm boundary; compare them structurally.
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function page(title = 'Demo page') {
  const window: any = { location: { href: 'https://demo.test/page', origin: 'https://demo.test' }, document: { title }, navigator: {}, fetch, sessionStorage: memoryStorage(), setTimeout };
  const context = vm.createContext({ window, console, structuredClone, AbortController, AbortSignal, DOMException, setTimeout, clearTimeout, crypto, TextEncoder, TextDecoder, URL, Promise });
  return { window, run: (code: string) => vm.runInContext(code, context) };
}

test('the store compiles an agent plugin into a working bundle that replaces its older revision in place', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'webmcp-plugins-'));
  try {
    const store = new PluginStore(join(dir, 'plugins'));
    await store.load();
    const first = await store.install(demoFiles('hello'), { installedBy: 'test-agent', note: 'first cut' });
    assert.equal(first.plugin.id, 'demo-site');
    assert.equal(first.plugin.source, 'dynamic');
    assert.equal(first.plugin.installedBy, 'test-agent');
    assert.deepEqual(first.warnings, []);
    assert.deepEqual((await readdir(join(dir, 'plugins/demo-site'))).sort(), ['.bundle.js', '.installed.json', 'index.ts', 'plugin.json', 'support.ts']);
    const site = page();
    site.run(first.plugin.code);
    await site.window.webMCPDev.getPlugin('demo-site').ready;
    assert.deepEqual(plain(site.window.webMCPDev.listTools().map((tool: { name: string }) => tool.name)), ['demo_site_hello']);
    assert.deepEqual(plain(await site.window.webMCPDev.callTool('demo_site_hello', {})), { ok: true, data: 'HELLO WORLD FROM DEMO PAGE' });
    assert.equal(site.window.webMCPDev.listPlugins()[0].revision, first.plugin.revision);
    // Same source, same revision: the bundle is a no-op on a document that already runs it.
    site.run(first.plugin.code);
    const second = await store.install(demoFiles('howdy'), { installedBy: 'another-agent' });
    assert.notEqual(second.plugin.revision, first.plugin.revision);
    site.run(second.plugin.code);
    await site.window.webMCPDev.getPlugin('demo-site').ready;
    assert.deepEqual(plain(await site.window.webMCPDev.callTool('demo_site_hello', { name: 'agent' })), { ok: true, data: 'HOWDY AGENT FROM DEMO PAGE' });
    assert.equal(site.window.webMCPDev.listPlugins().length, 1);
    assert.equal(site.window.__webMCPDevErrors, undefined);
    // A fresh bridge reuses the saved bundle when the source is unchanged, and recompiles when it changed on disk.
    await writeFile(join(dir, 'plugins/demo-site/.bundle.js'), '/* kept */');
    const reloaded = new PluginStore(join(dir, 'plugins'));
    await reloaded.load();
    assert.equal(reloaded.get('demo-site')?.code, '/* kept */');
    assert.equal(reloaded.list()[0].installedBy, 'another-agent');
    await writeFile(join(dir, 'plugins/demo-site/support.ts'), 'export const shout = (text: string) => text.toLowerCase();');
    const recompiled = new PluginStore(join(dir, 'plugins'));
    await recompiled.load();
    assert.notEqual(recompiled.get('demo-site')?.code, '/* kept */');
    assert.notEqual(recompiled.get('demo-site')?.revision, second.plugin.revision);
    assert.ok((await recompiled.read('demo-site'))?.files['support.ts'].includes('toLowerCase'));
    assert.equal(await recompiled.remove('demo-site'), true);
    assert.deepEqual(await readdir(join(dir, 'plugins')), []);
    assert.equal(await recompiled.remove('demo-site'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the store refuses malformed folders, built-in ids and code that does not compile, keeping the last good revision', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'webmcp-plugins-'));
  try {
    const store = new PluginStore(join(dir, 'plugins'));
    const expectError = async (files: unknown, code: string, pattern: RegExp) => {
      const error = await store.install(files, { installedBy: 'test-agent' }).then(() => undefined, (error: unknown) => error);
      assert.ok(error instanceof PluginError, 'expected a PluginError');
      assert.equal(error.code, code);
      assert.match(error.message, pattern);
      return error;
    };
    await expectError({ 'index.ts': 'export const plugin = 1;' }, 'INVALID_PLUGIN', /plugin\.json and index\.ts/);
    await expectError({ ...demoFiles(), '../escape.ts': '' }, 'INVALID_PLUGIN', /plain .ts, .json or .md/);
    await expectError({ ...demoFiles(), 'plugin.json': '{ not json' }, 'INVALID_PLUGIN', /not valid JSON/);
    await expectError({ ...demoFiles(), 'plugin.json': JSON.stringify({ ...demoManifest, matches: ['<all_urls>'] }) }, 'INVALID_PLUGIN', /explicit hostnames/);
    await expectError({ ...demoFiles(), 'plugin.json': JSON.stringify({ ...demoManifest, id: 'reddit' }) }, 'PLUGIN_ID_TAKEN', /built-in/);
    const broken = await expectError({ ...demoFiles(), 'index.ts': 'export const plugin = {\n  oops: \n' }, 'COMPILE_ERROR', /did not compile/);
    assert.match(String((broken as PluginError).details), /index\.ts:\d+:\d+/);
    assert.deepEqual(await readdir(join(dir, 'plugins')), []);
    const good = await store.install(demoFiles(), { installedBy: 'test-agent' });
    await expectError({ ...demoFiles(), 'index.ts': 'import { missing } from "./nowhere";\nexport const plugin = missing;' }, 'COMPILE_ERROR', /nowhere/);
    assert.equal(store.get('demo-site')?.revision, good.plugin.revision);
    assert.equal(await readFile(join(dir, 'plugins/demo-site/.bundle.js'), 'utf8'), good.plugin.code);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
