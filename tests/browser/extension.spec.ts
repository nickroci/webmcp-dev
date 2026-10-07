import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import { mkdtemp, rm, writeFile, readFile, stat, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { listing, thread, me, submitted, replied } from '../fixtures';
import type { RedditWebMCP } from '../../src/index';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startRelay } from '../../src/mcp/relay';
import { pairingCode } from '../../src/mcp/config';
import { bridgeConfig, MANAGEMENT_TOOLS } from '../bridge-fixtures';
import { PluginStore } from '../../src/mcp/plugins';

// A plugin an agent might write for a site that ships none. The revision marker shows which build a document runs.
const agentPlugin = (revision: string) => ({
  'plugin.json': JSON.stringify({ apiVersion: 1, id: 'unsupported', name: 'Unsupported Site', version: '0.1.0', description: 'Built by an agent during the test.', matches: ['https://unsupported.test/*'] }, null, 2),
  'index.ts': `import { definePlugin, defineTool, z } from '@webmcp-dev/sdk';
import manifest from './plugin.json';
export const plugin = definePlugin({ manifest, setup({ window }) { return { tools: [defineTool({
  name: 'unsupported_heading', title: 'Read heading', description: 'Read the page heading.', schema: z.strictObject({}),
  annotations: { readOnlyHint: true, consequentialHint: false, untrustedContentHint: true },
  execute: () => ({ heading: window.document.querySelector('h1')?.textContent ?? null, revision: ${JSON.stringify(revision)} }),
})] }; } });
`,
});

let context: BrowserContext;
let profile: string;
let extensionId: string;
const submitBodies: string[] = [];
const replyBodies: string[] = [];

test.beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), 'reddit-webmcp-browser-'));
  const buildPath = join(profile, 'build');
  execFileSync(process.execPath, ['scripts/build.mjs', '--outdir', buildPath, '--extra-plugin', resolve('tests/plugin-fixture')]);
  const extensionPath = join(buildPath, 'extension');
  context = await chromium.launchPersistentContext(join(profile, 'chrome'), {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).hostname;
  // Chrome gates chrome.userScripts behind a per-extension toggle. Enable it the way a user would.
  const settings = await context.newPage();
  await settings.goto(`chrome://extensions/?id=${extensionId}`);
  const allowUserScripts = settings.locator('extensions-toggle-row#allow-user-scripts cr-toggle');
  if (!await allowUserScripts.evaluate(element => (element as HTMLElement & { checked: boolean }).checked)) await allowUserScripts.click();
  await expect(allowUserScripts).toHaveJSProperty('checked', true);
  await settings.close();
  // No request in these tests reaches Reddit, including POST /api/submit.
  await context.route('https://*.reddit.com/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/me.json') return route.fulfill({ json: me });
    if (url.pathname === '/api/submit') {
      submitBodies.push(request.postData()!);
      return route.fulfill({ json: submitted });
    }
    if (url.pathname === '/api/comment') {
      replyBodies.push(request.postData()!);
      return route.fulfill({ json: replied(new URLSearchParams(request.postData()!).get('thing_id')!) });
    }
    if (url.pathname.startsWith('/comments/') && url.pathname.endsWith('.json')) return route.fulfill({ json: thread });
    if (url.pathname.endsWith('.json')) {
      return route.fulfill({ json: { ...listing, data: { ...listing.data, after: url.searchParams.has('after') ? null : 't3_abc123' } } });
    }
    return route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; connect-src 'self'" }, body: '<!doctype html><html><head><title>Reddit fixture</title></head><body><h1>Reddit fixture</h1></body></html>' });
  });
  await context.route('https://example.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Example fixture</title><h1>Another site</h1>' }));
  await context.route('https://unsupported.test/**', route => route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': "default-src 'self'; script-src 'self'" }, body: '<!doctype html><title>No plugin</title><h1>Unsupported site</h1>' }));
});
test.afterAll(async () => { await context?.close(); if (profile) await rm(profile, { recursive: true, force: true }); });

test('auto-injects into the main world, lists and reads posts, then reinjects on navigation', async () => {
  const page = await context.newPage();
  await page.goto('https://www.reddit.com/r/webdev/');
  await page.waitForFunction(() => !!window.redditWebMCP);
  const result = await page.evaluate(async () => {
    const api = window.redditWebMCP!;
    await api.ready;
    return { tools: api.listTools(), list: await api.callTool('reddit_list_posts', { subreddit: 'webdev', sort: 'latest' }), read: await api.callTool('reddit_read_post', { post: 'abc123' }) };
  });
  expect(result.tools).toHaveLength(7);
  expect(result.list).toMatchObject({ ok: true, data: { sort: 'new', next_after: 't3_abc123' } });
  expect(result.read).toMatchObject({ ok: true, data: { post: { id: 'abc123' }, comments: [{ id: 'c1' }, { id: 'c2' }] } });
  await page.evaluate(() => window.redditWebMCP!.callTool('reddit_browse_subreddit', { subreddit: 'javascript', sort: 'top', time: 'week' }));
  await page.waitForURL('https://www.reddit.com/r/javascript/top/?t=week');
  await page.waitForFunction(() => !!window.redditWebMCP);
  expect(await page.evaluate(() => window.redditWebMCP!.listTools().length)).toBe(7);
  await page.close();
});

test('publishes through the mocked endpoint and preserves idempotency across reloads', async () => {
  const page = await context.newPage();
  await page.goto('https://old.reddit.com/r/test/');
  await page.waitForFunction(() => !!window.redditWebMCP);
  const input = { subreddit: 'test', title: 'Browser fixture', text: 'This never reaches Reddit.', request_id: 'browser-post-123' };
  const before = submitBodies.length;
  const result = await page.evaluate(input => window.redditWebMCP!.callTool('reddit_create_post', input), input);
  expect(result).toMatchObject({ ok: true, data: { id: 'xyz789', reused: false } });
  await page.reload();
  await page.waitForFunction(() => !!window.redditWebMCP);
  const retry = await page.evaluate(input => window.redditWebMCP!.callTool('reddit_create_post', input), input);
  expect(retry).toMatchObject({ ok: true, data: { reused: true } });
  expect(submitBodies.length - before).toBe(1);
  await page.close();
});

test('generic popup lists and creates Reddit posts using generated forms', async () => {
  const page = await context.newPage();
  await page.goto('https://www.reddit.com/r/webdev/');
  await page.waitForFunction(() => !!window.redditWebMCP);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  // A real popup does not become the active browser tab. Reload it while the target tab is active.
  await page.bringToFront();
  await popup.reload();
  await popup.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(popup.locator('#tool-count')).toHaveText('7 tools available.');
  await popup.getByRole('button', { name: 'List posts', exact: true }).click();
  await expect(popup.locator('#result')).toContainText('A test post <script>not HTML</script>');
  await expect(popup.locator('#result script')).toHaveCount(0);
  await popup.locator('[name=after]').fill('t3_abc123');
  await popup.getByRole('button', { name: 'List posts', exact: true }).click();
  await expect(popup.locator('#result')).toContainText('"next_after": null');
  await popup.screenshot({ path: 'test-results/popup.png', fullPage: true });
  await popup.locator('#tool').selectOption('reddit_create_post');
  await popup.locator('[name=subreddit]').fill('test');
  await popup.locator('[name=title]').fill('Popup fixture');
  await popup.locator('[name=text]').fill('Fixture post body');
  await popup.getByRole('button', { name: 'Publish post' }).click();
  await expect(popup.locator('#result')).toContainText('xyz789');
  await popup.close(); await page.close();
});

test('reply forms publish to the intended post or comment and preserve deduplication after reload', async () => {
  const page = await context.newPage();
  const popup = await context.newPage();
  try {
    await page.goto('https://www.reddit.com/comments/abc123/');
    await page.waitForFunction(() => !!window.redditWebMCP);
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.bringToFront(); await popup.reload();
    await popup.getByRole('button', { name: 'Tools', exact: true }).click();
    await popup.locator('#tool').selectOption('reddit_reply');
    await popup.locator('[name=parent_id]').fill('t3_abc123');
    await popup.locator('[name=text]').fill('A top-level fixture reply');
    const requestId = await popup.locator('[name=request_id]').inputValue();
    expect(requestId).toMatch(/^[a-f0-9-]{36}$/);
    const before = replyBodies.length;
    await popup.getByRole('button', { name: 'Publish reply', exact: true }).click();
    await expect(popup.locator('#result')).toContainText('"fullname": "t1_reply123"');
    expect(new URLSearchParams(replyBodies.at(-1)).get('thing_id')).toBe('t3_abc123');
    await page.reload();
    await page.waitForFunction(() => !!window.redditWebMCP);
    const retry = await page.evaluate(request_id => window.redditWebMCP!.callTool('reddit_reply', {
      parent_id: 't3_abc123', text: 'A top-level fixture reply', request_id,
    }), requestId);
    expect(retry).toMatchObject({ ok: true, data: { reused: true } });
    expect(replyBodies.length - before).toBe(1);
    const nested = await page.evaluate(() => window.redditWebMCP!.callTool('reddit_reply', {
      parent_id: 't1_c1', text: 'A nested fixture reply', request_id: 'nested-fixture-1234',
    }));
    expect(nested).toMatchObject({ ok: true, data: { parent_id: 't1_c1', reused: false } });
    expect(new URLSearchParams(replyBodies.at(-1)).get('thing_id')).toBe('t1_c1');
    expect(replyBodies.length - before).toBe(2);
  } finally { await popup.close(); await page.close(); }
});

test('a separate site package supplies structured input types and dynamic tools', async () => {
  const page = await context.newPage();
  await page.goto('https://example.test/page');
  await page.waitForFunction(() => window.webMCPDev?.listTools().length === 2);
  expect(await page.evaluate(() => window.redditWebMCP)).toBeUndefined();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.bringToFront(); await popup.reload();
  await popup.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(popup.locator('#tool-count')).toHaveText('2 tools available.');
  await popup.locator('#run').click();
  await expect(popup.locator('#result')).toContainText('Example fixture');
  await popup.locator('#tool').selectOption('fixture_echo');
  await popup.locator('[name=count]').fill('2');
  await popup.locator('[name=mode]').selectOption({ label: 'full' });
  await popup.locator('[name=config]').fill('{"label":"Custom"}');
  await popup.locator('[name=tags]').fill('["one","two"]');
  await expect(popup.locator('[name=choice]')).toHaveValue('null');
  await popup.getByRole('button', { name: 'Use JSON', exact: true }).click();
  expect(JSON.parse(await popup.locator('#json-input').inputValue()).choice).toBeNull();
  await popup.getByRole('button', { name: 'Use form', exact: true }).click();
  await popup.locator('#run').click();
  await expect(popup.locator('#result')).toContainText('"ok": true');
  const echoed = JSON.parse((await popup.locator('#result').textContent())!);
  expect(echoed.data).toEqual({ count: 2, mode: 'full', config: { label: 'Custom' }, tags: ['one', 'two'], choice: null });
  await popup.getByRole('button', { name: 'Use JSON', exact: true }).click();
  await popup.locator('#json-input').fill(JSON.stringify({ ...echoed.data, count: 1, choice: 'typed union', enabled: false }));
  await popup.getByRole('button', { name: 'Use form', exact: true }).click();
  await popup.locator('#run').click();
  await expect(popup.locator('#result')).toContainText('typed union');
  await popup.screenshot({ path: 'test-results/generic-plugin.png', fullPage: true });
  await page.evaluate(() => { document.body.dataset.expanded = 'true'; });
  await page.waitForFunction(() => window.webMCPDev?.listTools().length === 3);
  await popup.locator('#refresh').click();
  await expect(popup.locator('#tool-count')).toHaveText('3 tools available.');
  await page.evaluate(() => { document.body.dataset.expanded = 'false'; });
  await page.waitForFunction(() => window.webMCPDev?.listTools().length === 2);
  await popup.close(); await page.close();
});

test('plugins can be disabled persistently and reenabled without affecting another plugin', async () => {
  const page = await context.newPage();
  await page.goto('https://www.reddit.com/r/fixture/');
  await page.waitForFunction(() => window.webMCPDev?.listTools().length === 9);
  const input = { count: 3, mode: 'brief', config: { label: 'test' }, tags: [], choice: null };
  // Reddit owns the shared runtime; the other bundle has a separate SDK Error class.
  expect(await page.evaluate(input => window.webMCPDev!.callTool('fixture_echo', input), input)).toMatchObject({ ok: false, error: { code: 'FIXTURE_ERROR' } });
  expect(await page.evaluate(() => window.webMCPDev!.callTool('fixture_echo', {}))).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.bringToFront(); await popup.reload();
  await expect(popup.locator('#tool-count')).toHaveText('9 tools available.');
  await popup.getByRole('button', { name: 'Site plugins', exact: true }).click();
  await popup.getByRole('checkbox', { name: 'Enable Fixture Site', exact: true }).uncheck();
  await expect(popup.locator('#tool-count')).toHaveText('7 tools available.');
  await page.reload();
  await page.waitForFunction(() => window.webMCPDev?.listTools().length === 7);
  await popup.reload();
  await popup.getByRole('button', { name: 'Site plugins', exact: true }).click();
  await expect(popup.getByRole('checkbox', { name: 'Enable Fixture Site', exact: true })).not.toBeChecked();
  await popup.getByRole('checkbox', { name: 'Enable Fixture Site', exact: true }).check();
  await expect(popup.locator('#tool-count')).toHaveText('9 tools available.');
  await popup.screenshot({ path: 'test-results/plugin-manager.png', fullPage: true });
  await popup.close(); await page.close();
});

test('unsupported pages get no injection and still show the plugin catalog', async () => {
  const page = await context.newPage();
  await page.goto('https://unsupported.test/');
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.bringToFront(); await popup.reload();
  await expect(popup.locator('#status')).toContainText('No installed plugin matches this page.');
  expect(await page.evaluate(() => window.webMCPDev)).toBeUndefined();
  await popup.getByRole('button', { name: 'Site plugins', exact: true }).click();
  // Every installed plugin is listed by name, even on a page none of them inject into.
  for (const name of ['Enable LinkedIn', 'Enable Reddit', 'Enable Fixture Site']) {
    await expect(popup.getByRole('checkbox', { name, exact: true })).toHaveCount(1);
  }
  await popup.close(); await page.close();
});

test('registers in document.modelContext with the current contract and supports disposal', async () => {
  const page = await context.newPage();
  // Stub just the experimental browser API; exercise the real built injection bundle.
  await page.addInitScript(() => {
    const registered = new Map<string, { execute: Function }>();
    Object.defineProperty(document, 'modelContext', { configurable: true, value: {
      registerTool(tool: { name: string; execute: Function }, options: { signal: AbortSignal }) {
        registered.set(tool.name, tool);
        options.signal.addEventListener('abort', () => registered.delete(tool.name));
      },
      getTools: async () => [...registered.keys()].map(name => ({ name })),
      executeTool: async (tool: { name: string }, input: unknown) => registered.get(tool.name)!.execute(input),
    } });
  });
  await page.goto('https://www.reddit.com/r/test/');
  await page.waitForFunction(() => !!window.redditWebMCP);
  const result = await page.evaluate(async () => {
    const api: RedditWebMCP = window.redditWebMCP!;
    await api.ready;
    const mc = (document as any).modelContext;
    const tools = await mc.getTools();
    const value = await mc.executeTool(tools.find((tool: { name: string }) => tool.name === 'reddit_list_posts'), { subreddit: 'test' });
    api.dispose();
    return { count: tools.length, result: JSON.parse(value), remaining: (await mc.getTools()).length };
  });
  expect(result).toMatchObject({ count: 7, result: { ok: true }, remaining: 0 });
  await page.close();
});

test('an actual stdio MCP client requests approval in the extension, navigates visible pages, discovers dynamic tools, and builds a plugin for a site that has none', async () => {
  test.setTimeout(120_000);
  const config = await bridgeConfig();
  const stateDir = await mkdtemp(join(tmpdir(), 'webmcp-bridge-e2e-'));
  await writeFile(join(stateDir, 'connection.json'), JSON.stringify(config), { mode: 0o600 });
  const store = new PluginStore(join(stateDir, 'plugins')); await store.load();
  const relay = await startRelay(config, { store });
  const client = new Client({ name: 'browser-test-agent', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/mcp/cli.js')], env: { WEBMCP_STATE_DIR: stateDir }, stderr: 'pipe' });
  const page = await context.newPage();
  const popup = await context.newPage();
  const call = async (name: string, input: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: input });
    return (result.structuredContent ?? JSON.parse((result.content as Array<{ text: string }>)[0].text)) as { ok: boolean; data: any; error?: { code: string } };
  };
  try {
    await client.connect(transport);
    expect((await call('webmcp_list_tabs')).data.tabs).toEqual([]);
    await page.goto('https://www.reddit.com/r/webdev/');
    await page.waitForFunction(() => !!window.webMCPDev);
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.bringToFront(); await popup.reload();
    await popup.getByRole('button', { name: 'Agents', exact: true }).click();
    // A non-default port isolates this test; normal users need no port setting.
    await popup.getByText('Advanced connection settings', { exact: true }).click();
    await popup.locator('#bridge-port').fill(String(config.port));
    await popup.getByRole('button', { name: 'Use port', exact: true }).click();
    // Discovery flips available only when the relay's first message lands. setPort
    // connects at once, but a first attempt that beats the relay to the port waits for
    // the 3s retry in agent-bridge, so the worst case exceeds the 5s default budget.
    await expect(popup.locator('#agent-status')).toContainText('Ready for agent requests', { timeout: 20_000 });
    await expect(popup.getByRole('button', { name: 'Share this tab', exact: true })).toBeDisabled();
    const request = await call('webmcp_request_connection');
    expect(request.data.status).toBe('pending');
    await expect(popup.locator('#connection-requests')).toContainText('browser-test-agent wants to use this tab');
    await expect(popup.locator('#connection-requests')).toContainText(request.data.code);
    expect((await call('webmcp_list_tabs')).data.tabs).toEqual([]);
    await popup.getByText('Advanced connection settings', { exact: true }).click();
    await popup.screenshot({ path: 'test-results/approve-agent.png', fullPage: true });
    await popup.getByRole('button', { name: 'Allow and share this tab', exact: true }).click();
    await expect(popup.locator('#agent-status')).toContainText('Connected to local bridge');
    expect((await call('webmcp_request_connection', { request_id: request.data.id })).data.status).toBe('approved');
    await expect(popup.locator('#agent-error')).toBeHidden();
    await expect.poll(async () => (await call('webmcp_list_tabs')).data.tabs.length).toBe(1);
    const tab = (await call('webmcp_list_tabs')).data.tabs[0];
    expect((await call('webmcp_select_tab', { tab: tab.key })).ok).toBe(true);
    expect((await client.listTools()).tools.some(tool => tool.name === 'reddit_list_posts')).toBe(true);
    const replyTool = (await client.listTools()).tools.find(tool => tool.name === 'reddit_reply');
    expect(replyTool?.inputSchema.required).toEqual(['parent_id', 'text', 'request_id']);
    expect(replyTool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    const browse = await call('reddit_browse_subreddit', { subreddit: 'webdev', sort: 'latest' });
    expect(browse.ok).toBe(true);
    await expect(page).toHaveURL('https://www.reddit.com/r/webdev/new/');
    expect((await call('reddit_list_posts', { subreddit: 'webdev', sort: 'latest', limit: 1 })).data.posts[0].id).toBe('abc123');
    expect((await call('reddit_open_post', { post: 'abc123' })).ok).toBe(true);
    await expect(page).toHaveURL('https://www.reddit.com/comments/abc123/');
    expect((await call('reddit_read_post', { post: 'abc123' })).data.post.id).toBe('abc123');
    // A site's router can intercept location.assign and keep the document alive.
    // Exercise the real Reddit tools through that path as well as full loads.
    const beforeRoute = (await call('webmcp_list_tabs')).data.tabs[0];
    await page.evaluate(() => {
      window.navigation.addEventListener('navigate', event => {
        if (!event.canIntercept) return;
        event.intercept({ handler: async () => {
          await new Promise(resolve => setTimeout(resolve, 400));
          document.title = `Reddit fixture: ${location.pathname}`;
          document.querySelector('h1')!.textContent = location.pathname;
        } });
      });
    });
    for (const [name, input, path] of [
      ['reddit_browse_subreddit', { subreddit: 'webdev', sort: 'latest' }, '/r/webdev/new/'],
      ['reddit_open_post', { post: 'abc123' }, '/comments/abc123/'],
    ] as const) {
      const started = Date.now();
      const result = await call(name, input);
      expect(result).toMatchObject({ ok: true, data: { navigation_started: true } });
      expect(Date.now() - started).toBeLessThan(5000);
      // Assert immediately: acknowledging just the early URL change is too soon.
      expect(await page.locator('h1').textContent()).toBe(path);
      const current = (await call('webmcp_list_tabs')).data.tabs[0];
      expect(current.documentId).toBe(beforeRoute.documentId);
      expect(current.url).toBe(`https://www.reddit.com${path}`);
    }
    expect((await call('reddit_read_post', { post: 'abc123' })).data.post.id).toBe('abc123');
    const before = submitBodies.length;
    const input = { subreddit: 'test', title: 'MCP fixture', text: 'Never reaches Reddit', request_id: 'mcp-fixture-post-123' };
    expect((await call('reddit_create_post', input)).data.reused).toBe(false);
    // Publishing moves the tab to the new post, so rediscover before calling again, as with browse and open.
    // Wait for the intercepted navigation to finish, not just for the URL to commit.
    await expect(page.locator('h1')).toHaveText('/r/test/comments/xyz789/');
    expect((await call('webmcp_refresh_tools')).ok).toBe(true);
    expect((await call('reddit_create_post', input)).data.reused).toBe(true);
    expect(submitBodies.length - before).toBe(1);
    const repliesBefore = replyBodies.length;
    const reply = { parent_id: 't1_c1', text: 'MCP fixture reply; never reaches Reddit', request_id: 'mcp-fixture-reply-123' };
    expect((await call('reddit_reply', reply)).data).toMatchObject({ fullname: 't1_reply123', parent_id: 't1_c1', reused: false });
    expect((await call('webmcp_call_tool', { tool: 'reddit_reply', input: reply })).data.reused).toBe(true);
    expect(replyBodies.length - repliesBefore).toBe(1);
    // Cross-origin navigation revokes sharing, even though the new site has a plugin.
    await page.goto('https://example.test/page');
    await expect.poll(async () => (await call('webmcp_list_tabs')).data.tabs.length).toBe(0);
    await page.bringToFront(); await popup.reload();
    await popup.getByRole('button', { name: 'Agents', exact: true }).click();
    await popup.getByRole('button', { name: 'Share this tab', exact: true }).click();
    await expect.poll(async () => (await call('webmcp_list_tabs')).data.tabs.length).toBe(1);
    await call('webmcp_select_tab', { tab: (await call('webmcp_list_tabs')).data.tabs[0].key });
    const echo = { count: 2, mode: 'brief', config: { label: 'MCP' }, tags: ['one'], choice: null };
    expect((await call('fixture_echo', echo)).data).toEqual(echo);
    expect((await call('fixture_page_info')).data.title).toBe('Example fixture');
    await page.evaluate(() => { document.body.dataset.expanded = 'true'; });
    await expect.poll(async () => (await client.listTools()).tools.some(tool => tool.name === 'fixture_extra')).toBe(true);
    expect((await call('fixture_extra')).data).toBe('expanded');
    expect((await call('webmcp_call_tool', { tool: 'fixture_echo', input: echo })).data).toEqual(echo);

    // A site with no plugin: share it anyway, probe it, build a plugin, and improve it in the same document.
    await page.goto('https://unsupported.test/');
    await expect.poll(async () => (await call('webmcp_list_tabs')).data.tabs.length).toBe(0);
    await page.bringToFront(); await popup.reload();
    await popup.getByRole('button', { name: 'Agents', exact: true }).click();
    await popup.getByRole('button', { name: 'Share this tab', exact: true }).click();
    await expect.poll(async () => (await call('webmcp_list_tabs')).data.tabs.length).toBe(1);
    const bare = (await call('webmcp_list_tabs')).data.tabs[0];
    expect(bare.tools).toEqual([]);
    await call('webmcp_select_tab', { tab: bare.key });
    expect((await call('webmcp_install_plugin', { files: agentPlugin('v1') })).error?.code).toBe('DEV_MODE_DISABLED');
    expect((await call('webmcp_evaluate', { code: 'return 1;' })).error?.code).toBe('DEV_MODE_DISABLED');
    expect((await call('webmcp_doctor')).data.problems.join(' ')).toContain('Let agents develop plugins');
    await popup.getByRole('checkbox', { name: 'Let agents develop plugins' }).check();
    await expect.poll(async () => (await call('webmcp_doctor')).data.healthy).toBe(true);
    const probe = await call('webmcp_evaluate', { code: 'return { title: document.title, heading: document.querySelector("h1")?.textContent, runtime: typeof window.webMCPDev };' });
    expect(probe.data).toEqual({ title: 'No plugin', heading: 'Unsupported site', runtime: 'undefined' });
    expect((await call('webmcp_evaluate', { code: 'throw new Error("probe failed");' })).error).toMatchObject({ code: 'EVALUATION_ERROR', message: 'probe failed' });
    expect((await call('webmcp_evaluate', { code: 'return await Promise.resolve(location.pathname);' })).data).toBe('/');
    const installed = await call('webmcp_install_plugin', { files: agentPlugin('v1'), note: 'first cut' });
    expect(installed.ok, JSON.stringify(installed)).toBe(true);
    expect(installed.data.plugin).toMatchObject({ id: 'unsupported', source: 'dynamic', installedBy: 'browser-test-agent', note: 'first cut' });
    expect(installed.data.browsers[0].tabs, JSON.stringify(installed)).toEqual([expect.objectContaining({ url: 'https://unsupported.test/', shared: true, ok: true, tools: ['unsupported_heading'] })]);
    expect(installed.data.selected_tab.tools).toEqual(['unsupported_heading']);
    await expect.poll(async () => (await client.listTools()).tools.some(tool => tool.name === 'unsupported_heading')).toBe(true);
    expect((await call('unsupported_heading')).data).toEqual({ heading: 'Unsupported site', revision: 'v1' });
    const documentBefore = (await call('webmcp_list_tabs')).data.tabs[0].documentId;
    const updated = await call('webmcp_install_plugin', { files: agentPlugin('v2'), note: 'second cut' });
    expect(updated.ok, JSON.stringify(updated)).toBe(true);
    // The open document now runs the new revision: no reload, no new tab.
    expect((await call('webmcp_list_tabs')).data.tabs[0].documentId).toBe(documentBefore);
    expect((await call('unsupported_heading')).data).toEqual({ heading: 'Unsupported site', revision: 'v2' });
    expect((await call('webmcp_doctor')).data.tabs[0].plugins).toEqual([expect.objectContaining({ id: 'unsupported', source: 'dynamic', stale: false })]);
    // The source is on disk for people and other agents, and the popup shows where it came from.
    expect(JSON.parse(await readFile(join(stateDir, 'plugins/unsupported/plugin.json'), 'utf8')).id).toBe('unsupported');
    const catalog = await call('webmcp_list_plugins');
    expect(catalog.data.plugins.find((plugin: { id: string }) => plugin.id === 'unsupported')).toMatchObject({ installedBy: 'browser-test-agent', note: 'second cut' });
    expect((await call('webmcp_read_plugin', { id: 'unsupported' })).data.files['index.ts']).toBe(agentPlugin('v2')['index.ts']);
    expect((await call('webmcp_read_plugin', { id: 'reddit' })).data.path).toBe(resolve('src/plugins/reddit'));
    await popup.reload();
    await popup.getByRole('button', { name: 'Site plugins', exact: true }).click();
    await expect(popup.locator('#plugins')).toContainText('Installed by browser-test-agent');
    await expect(popup.locator('#plugins')).toContainText('second cut');
    await popup.screenshot({ path: 'test-results/agent-plugin.png', fullPage: true });
    // A fresh page load activates the plugin through Chrome's registered user script, without the extension worker.
    await page.goto('https://unsupported.test/other');
    await page.waitForFunction(() => window.webMCPDev?.listTools().length === 1);
    await expect.poll(async () => (await call('webmcp_refresh_tools')).data.tab?.url).toBe('https://unsupported.test/other');
    expect((await call('unsupported_heading')).data.revision).toBe('v2');
    expect((await call('webmcp_remove_plugin', { id: 'unsupported' })).data).toEqual({ removed: true });
    await page.waitForFunction(() => window.webMCPDev?.listTools().length === 0);
    await expect.poll(async () => (await call('webmcp_list_tabs')).data.tabs[0].tools).toEqual([]);
    await page.goto('https://unsupported.test/');
    await page.waitForLoadState('load');
    expect(await page.evaluate(() => window.webMCPDev)).toBeUndefined();
    await popup.reload();
    await popup.getByRole('button', { name: 'Agents', exact: true }).click();
    await popup.screenshot({ path: 'test-results/agents.png', fullPage: true });
    await popup.getByRole('button', { name: 'Stop sharing this tab', exact: true }).click();
    await expect.poll(async () => (await call('webmcp_list_tabs')).data.tabs.length).toBe(0);
    expect((await call('webmcp_evaluate', { code: 'return 1;' })).error?.code).toBe('NO_TAB_SELECTED');
    await popup.getByRole('button', { name: 'Disconnect', exact: true }).click();
  } finally {
    await client.close(); await transport.close(); await popup.close(); await page.close();
    await relay.close(); await rm(stateDir, { recursive: true, force: true });
  }
});


test('MCP adapters automatically start and reuse the local relay without a terminal', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'webmcp-autostart-'));
  const { port } = await bridgeConfig();
  const env = { WEBMCP_STATE_DIR: stateDir, WEBMCP_PORT: String(port) };
  const cli = resolve('dist/mcp/cli.js');
  const transports = [0, 1].map(() => new StdioClientTransport({ command: process.execPath, args: [cli], env, stderr: 'pipe' }));
  const clients = [0, 1].map(index => new Client({ name: `startup-test-${index}`, version: '1' }));
  const run = promisify(execFile);
  try {
    await Promise.all(clients.map((client, index) => client.connect(transports[index])));
    for (const client of clients) expect((await client.listTools()).tools.length).toBe(MANAGEMENT_TOOLS.length);
    const config = JSON.parse(await readFile(join(stateDir, 'connection.json'), 'utf8'));
    expect(config.port).toBe(port);
    expect((await stat(join(stateDir, 'connection.json'))).mode & 0o777).toBe(0o600);
    const pair = await run(process.execPath, [cli, 'pair'], { env });
    expect(pair.stdout).toContain(pairingCode(config));
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await Promise.all(transports.map(transport => transport.close()));
    await run(process.execPath, [cli, 'stop'], { env });
    await rm(stateDir, { recursive: true, force: true });
  }
});


test('a new popup recovers from an old worker, including a manifest without alarms', async () => {
  const path = join(profile, 'stale-extension');
  await cp(join(profile, 'build/extension'), path, { recursive: true });
  const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
  manifest.permissions = manifest.permissions.filter((permission: string) => permission !== 'alarms');
  await writeFile(join(path, 'manifest.json'), JSON.stringify(manifest));
  const { port: isolatedPort } = await bridgeConfig();
  // Simulate an older worker kept alive while popup files on disk were updated.
  await writeFile(join(path, 'background.js'), `chrome.storage.local.set({agentBridgePort: ${isolatedPort}});
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type === 'sync') { respond({ok:true, active:[], errors:[]}); return true; }
  });`);
  const stale = await chromium.launchPersistentContext(join(profile, 'stale-chrome'), {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`],
  });
  try {
    // Command-line loading skips the Developer mode flow. Enable it in this
    // test-owned browser as a user would for a real unpacked installation.
    const settings = await stale.newPage();
    await settings.goto('chrome://extensions');
    const developerMode = settings.locator('extensions-toolbar #devMode');
    if (!await developerMode.evaluate(element => (element as HTMLElement & { checked: boolean }).checked)) await developerMode.click();
    await expect(developerMode).toHaveJSProperty('checked', true);
    await settings.close();
    const worker = stale.serviceWorkers()[0] ?? await stale.waitForEvent('serviceworker');
    const id = new URL(worker.url()).hostname;
    const popup = await stale.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await popup.getByRole('button', { name: 'Agents', exact: true }).click();
    await expect(popup.locator('#agent-error')).toContainText('background worker did not reply');
    await expect(popup.locator('#reload-extension')).toBeVisible();
    await expect(popup.locator('body')).not.toContainText("Cannot read properties of undefined");
    await cp(join(profile, 'build/extension/background.js'), join(path, 'background.js'));
    // Reload can close the popup before Playwright acknowledges the click.
    // The fresh popup assertions below still require the replacement worker.
    await popup.locator('#reload-extension').click().catch(error => {
      if (!popup.isClosed() || !String(error).includes('Target page, context or browser has been closed')) throw error;
    });
    // Reopening the popup wakes the replacement worker; do not wait for the
    // worker to start before sending the message that wakes it.
    const fresh = await stale.newPage();
    await expect(async () => { await fresh.goto(`chrome-extension://${id}/popup.html`); }).toPass({ timeout: 5000 });
    await fresh.getByRole('button', { name: 'Agents', exact: true }).click();
    await expect(fresh.locator('#agent-status')).toContainText('Waiting for your local agent');
    await expect(fresh.locator('#agent-error')).toBeHidden();
    await expect(fresh.locator('#reload-extension')).toBeHidden();
  } finally { await stale.close(); }
});
