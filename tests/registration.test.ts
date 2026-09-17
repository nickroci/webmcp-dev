import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installRedditWebMCP, type ModelContext, type ToolDefinition } from '../src/index';
import { listing, memoryStorage } from './fixtures';

function fakeWindow(mode: 'native' | 'legacy' | 'local' | 'failure') {
  const registrations: Array<ToolDefinition & { execute: Function }> = [];
  const aborted: string[] = [];
  const native: ModelContext = {
    registerTool(tool, options) {
      if (mode === 'failure') throw new Error('Permissions policy blocked registration');
      registrations.push(tool);
      options?.signal.addEventListener('abort', () => aborted.push(tool.name));
    },
    unregisterTool(name) { aborted.push(name); },
  };
  const win = {
    location: { origin: 'https://www.reddit.com' },
    document: mode === 'native' || mode === 'failure' ? { modelContext: native } : {},
    navigator: mode === 'legacy' ? { modelContext: native } : {},
    fetch: async () => Response.json(listing), sessionStorage: memoryStorage(),
  } as unknown as Window;
  return { win, registrations, aborted };
}

test('registers all six native tools and returns JSON strings', async () => {
  const { win, registrations, aborted } = fakeWindow('native');
  const api = installRedditWebMCP({ window: win });
  await api.ready;
  assert.equal(api.status().mode, 'native');
  assert.equal(registrations.length, 6);
  const result = JSON.parse(await registrations[1].execute({ subreddit: 'webdev' }));
  assert.equal(result.ok, true);
  assert.equal(registrations[3].annotations.consequentialHint, true);
  assert.equal(registrations.find(tool => tool.name === 'reddit_reply')!.annotations.consequentialHint, true);
  assert.equal(registrations[1].annotations.untrustedContentHint, true);
  assert.equal(installRedditWebMCP({ window: win }), api);
  assert.equal(registrations.length, 6);
  api.dispose();
  assert.equal(aborted.length, 6);
  assert.equal(win.redditWebMCP, undefined);
});

test('legacy registration returns MCP-shaped results', async () => {
  const { win, registrations } = fakeWindow('legacy');
  const api = installRedditWebMCP({ window: win }); await api.ready;
  const result = await registrations[1].execute({ subreddit: 'webdev' });
  assert.equal(result.content[0].type, 'text');
  assert.equal(JSON.parse(result.content[0].text).ok, true);
  assert.equal(result.isError, false);
});

test('local execution works without WebMCP and does not forge browser APIs', async () => {
  const { win } = fakeWindow('local');
  const api = installRedditWebMCP({ window: win }); await api.ready;
  assert.equal(api.status().mode, 'local');
  assert.equal('modelContext' in win.document, false);
  assert.equal((await api.callTool('reddit_list_posts', { subreddit: 'webdev' })).ok, true);
});

test('registration failure preserves local tools and reports the failure', async () => {
  const { win } = fakeWindow('failure');
  const api = installRedditWebMCP({ window: win }); await api.ready;
  assert.equal(api.status().registrationErrors.length, 6);
  assert.equal(api.status().registered.length, 0);
  assert.equal((await api.callTool('reddit_list_posts', { subreddit: 'webdev' })).ok, true);
});

test('validates before fetch or navigation, including unknown arguments', async () => {
  const { win } = fakeWindow('local'); let navigated = '';
  const api = installRedditWebMCP({ window: win, navigate: url => { navigated = url; } });
  for (const input of [{ subreddit: 'webdev', limit: 101 }, { subreddit: 'webdev', sort: 'wrong' }, { subreddit: 'webdev', surprise: true }]) {
    const result = await api.callTool('reddit_list_posts', input);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'INVALID_INPUT');
  }
  assert.equal((await api.callTool('reddit_browse_subreddit', { subreddit: 'webdev', sort: 'top', time: 'day' })).ok, true);
  assert.equal(navigated, 'https://www.reddit.com/r/webdev/top/?t=day');
  const unknown = await api.callTool('missing', {});
  assert.equal(unknown.ok, false);
  api.dispose();
  assert.equal((await api.callTool('reddit_list_posts', { subreddit: 'webdev' })).ok, false);
});

test('cancellation stops a tool before it starts', async () => {
  const { win } = fakeWindow('local'); let fetched = false;
  const api = installRedditWebMCP({ window: win, fetch: async () => { fetched = true; return Response.json(listing); } });
  const controller = new AbortController(); controller.abort();
  const result = await api.callTool('reddit_list_posts', { subreddit: 'webdev' }, { signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(fetched, false);
});
