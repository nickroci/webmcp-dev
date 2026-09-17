import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RedditClient } from '../src/plugins/reddit/client';
import { browseSchema, listSchema, readSchema, createSchema, replySchema, normalizeSubreddit, normalizePost, subredditPath } from '../src/plugins/reddit/schemas';
import { listing, thread, me, submitted, replied, memoryStorage } from './fixtures';

function harness(responses: Array<unknown | Response | Error>, storage = memoryStorage()) {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: new URL(String(url)), init: init! });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (response instanceof Response) return response;
    if (response === undefined) throw new Error('No fixture response left');
    return Response.json(response);
  }) as typeof fetch;
  return { client: new RedditClient({ origin: 'https://www.reddit.com', fetch: fetcher, storage }), requests, storage };
}
const textPost = (overrides = {}) => createSchema.parse({ subreddit: 'test', title: 'Test post', text: 'Body', request_id: 'request-1234', ...overrides });
const replyInput = (overrides = {}) => replySchema.parse({ parent_id: 't3_abc123', text: 'A **reply** & more\n  indented', request_id: 'reply-request-1234', ...overrides });

test('normalizes subreddit names and URLs without allowing path/host injection', () => {
  for (const input of ['webdev', 'r/webdev', '/r/webdev/', 'https://old.reddit.com/r/webdev/new/']) assert.equal(normalizeSubreddit(input), 'webdev');
  for (const input of ['../../api/submit', 'https://reddit.com.evil.test/r/webdev', 'https://evil.test/r/webdev', 'webdev?foo=bar', 'https://reddit.com:8443/r/webdev', 'webdev+javascript']) {
    assert.throws(() => normalizeSubreddit(input));
  }
  assert.equal(subredditPath(browseSchema.parse({ subreddit: 'r/webdev', sort: 'latest' })), '/r/webdev/new/');
  assert.equal(subredditPath(browseSchema.parse({ subreddit: 'webdev', sort: 'top', time: 'week' })), '/r/webdev/top/?t=week');
});

test('accepts full post URLs, short URLs, and IDs; rejects other sites and share links', () => {
  for (const input of ['abc123', 't3_abc123', 'https://redd.it/abc123', 'https://www.reddit.com/r/webdev/comments/abc123/title/?x=1']) assert.equal(normalizePost(input), 'abc123');
  for (const input of ['https://evil.test/comments/abc123', 'https://www.reddit.com/r/webdev/s/random', '/api/submit', 'https://reddit.com@evil.test/comments/abc123']) assert.throws(() => normalizePost(input));
});

test('lists latest posts with cookies, raw JSON, and cursor pagination', async () => {
  const { client, requests } = harness([listing]);
  const result = await client.listPosts(listSchema.parse({ subreddit: 'r/webdev', sort: 'latest', after: 't3_previous', limit: 10 }));
  assert.equal(requests[0].url.pathname, '/r/webdev/new.json');
  assert.equal(requests[0].url.searchParams.get('after'), 't3_previous');
  assert.equal(requests[0].url.searchParams.get('limit'), '10');
  assert.equal(requests[0].url.searchParams.get('raw_json'), '1');
  assert.equal(requests[0].init.credentials, 'same-origin');
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(result.next_after, 't3_abc123');
  assert.equal(result.posts[0].text, 'A **Markdown** post body with & <characters>.');
  assert.ok(!JSON.stringify(result).includes('modhash'));
});

test('applies a time window to top and controversial only', async () => {
  for (const sort of ['top', 'controversial', 'new', 'hot', 'rising'] as const) {
    const { client, requests } = harness([listing]);
    await client.listPosts(listSchema.parse({ subreddit: 'webdev', sort, time: 'week' }));
    assert.equal(requests[0].url.searchParams.get('t'), ['top', 'controversial'].includes(sort) ? 'week' : null);
  }
});

test('reads full text, flattens replies, preserves parents, and exposes unloaded comments', async () => {
  const { client, requests } = harness([thread]);
  const result = await client.readPost(readSchema.parse({ post: 't3_abc123', comment_sort: 'best' }));
  assert.equal(requests[0].url.pathname, '/comments/abc123.json');
  assert.equal(requests[0].url.searchParams.get('sort'), 'confidence');
  assert.equal(result.comments[1].parent_id, 't1_c1');
  assert.equal(result.comments[1].depth, 1);
  assert.deepEqual(result.more_comments[0].children, ['c3']);
  assert.equal(result.comments_truncated, true);
});

test('honors total comment limits, zero comments, and depth', async () => {
  for (const params of [{ comment_limit: 0 }, { comment_limit: 1 }, { comment_depth: 1 }]) {
    const { client } = harness([thread]);
    const result = await client.readPost(readSchema.parse({ post: 'abc123', ...params }));
    assert.equal(result.comments.length, params.comment_limit === 0 ? 0 : 1);
    assert.equal(result.comments_truncated, true);
  }
});

test('returns actionable errors for blocked, rate-limited, and non-JSON responses', async () => {
  for (const [response, code] of [
    [new Response('blocked', { status: 403 }), 'ACCESS_DENIED'],
    [new Response('wait', { status: 429, headers: { 'retry-after': '30' } }), 'RATE_LIMITED'],
    [new Response('<html>login</html>'), 'UNEXPECTED_RESPONSE'],
    [{ kind: 'unexpected' }, 'UNEXPECTED_RESPONSE'],
  ] as const) {
    const { client } = harness([response]);
    await assert.rejects(client.listPosts(listSchema.parse({ subreddit: 'test' })), { code });
  }
});

test('submits a text post with session CSRF, flair, and flags; returns no token', async () => {
  const { client, requests, storage } = harness([me, submitted]);
  const result = await client.createPost(textPost({ nsfw: true, spoiler: true, flair_id: '123e4567-e89b-42d3-a456-426614174000', flair_text: 'Discussion' }));
  const request = requests[1];
  assert.equal(request.url.pathname, '/api/submit');
  assert.equal(request.init.method, 'POST');
  assert.equal((request.init.headers as Record<string, string>)['X-Modhash'], me.data.modhash);
  const body = new URLSearchParams(String(request.init.body));
  assert.equal(body.get('kind'), 'self');
  assert.equal(body.get('text'), 'Body');
  assert.equal(body.get('nsfw'), 'true');
  assert.equal(body.get('flair_text'), 'Discussion');
  assert.equal(body.get('resubmit'), 'false');
  assert.ok(!JSON.stringify(result).includes(me.data.modhash));
  assert.ok(!storage.getItem('reddit-webmcp:submission:request-1234')!.includes('Body'));
});

test('link posts require HTTP(S) URLs and cannot silently discard text', async () => {
  const { client, requests } = harness([me, submitted]);
  await assert.rejects(client.createPost(textPost({ kind: 'link', url: 'javascript:alert(1)', text: undefined })), { code: 'INVALID_INPUT' });
  await assert.rejects(client.createPost(textPost({ kind: 'link', url: 'https://example.com' })), { code: 'INVALID_INPUT' });
  assert.equal(requests.length, 0);
  await client.createPost(textPost({ kind: 'link', url: 'https://example.com', text: undefined }));
  const body = new URLSearchParams(String(requests[1].init.body));
  assert.equal(body.get('kind'), 'link');
  assert.equal(body.get('url'), 'https://example.com');
  assert.equal(body.has('text'), false);
});

test('reuses successful outcomes across reloads and rejects changed content for an ID', async () => {
  const { client, requests, storage } = harness([me, submitted]);
  await client.createPost(textPost());
  const reloaded = harness([], storage);
  const result = await reloaded.client.createPost(textPost()) as { reused: boolean };
  assert.equal(result.reused, true);
  assert.equal(requests.length, 2);
  assert.equal(reloaded.requests.length, 0);
  await assert.rejects(client.createPost(textPost({ title: 'Changed title' })), { code: 'REQUEST_ID_CONFLICT' });
});

test('concurrent calls with the same ID submit only once', async () => {
  const { client, requests } = harness([me, submitted]);
  await Promise.all([client.createPost(textPost()), client.createPost(textPost())]);
  assert.equal(requests.filter(request => request.init.method === 'POST').length, 1);
});

test('does not post without login or a modhash', async () => {
  for (const [response, code] of [[{ data: {} }, 'LOGIN_REQUIRED'], [{ data: { name: 'user' } }, 'SESSION_UNSUPPORTED']] as const) {
    const { client, requests } = harness([response]);
    await assert.rejects(client.createPost(textPost()), { code });
    assert.equal(requests.length, 1);
  }
});

test('surfaces Reddit validation errors and permits a corrected retry', async () => {
  const { client, requests } = harness([me, { json: { errors: [['SUBREDDIT_NOEXIST', 'That community does not exist', 'sr']] } }, me, submitted]);
  await assert.rejects(client.createPost(textPost()), { code: 'REDDIT_REJECTED' });
  await client.createPost(textPost({ subreddit: 'validcommunity' }));
  assert.equal(requests.length, 4);
});

test('uncertain submissions are never retried, including after page reload', async () => {
  for (const response of [new TypeError('Connection lost'), new Response('oops', { status: 500 }), { json: { errors: [], data: {} } }]) {
    const { client, requests, storage } = harness([me, response]);
    await assert.rejects(client.createPost(textPost()), { code: 'SUBMISSION_UNCERTAIN' });
    await assert.rejects(harness([], storage).client.createPost(textPost()), { code: 'SUBMISSION_UNCERTAIN' });
    assert.equal(requests.length, 2);
  }
});

test('refuses to submit when persistence is unavailable', async () => {
  const { client, requests } = harness([], { ...memoryStorage(), setItem() { throw new Error('quota exceeded'); } });
  await assert.rejects(client.createPost(textPost()), { code: 'STORAGE_UNAVAILABLE' });
  assert.equal(requests.length, 0);
});

test('replies to posts and comments with the exact Markdown and session credentials', async () => {
  for (const parent of ['t3_abc123', 't1_c1']) {
    const { client, requests, storage } = harness([me, replied(parent)]);
    const result = await client.reply(replyInput({ parent_id: parent.toUpperCase() }));
    const request = requests[1];
    assert.equal(request.url.pathname, '/api/comment');
    assert.equal(request.init.method, 'POST');
    assert.equal(request.init.credentials, 'same-origin');
    assert.equal(request.init.redirect, 'error');
    assert.equal((request.init.headers as Record<string, string>)['X-Modhash'], me.data.modhash);
    const body = new URLSearchParams(String(request.init.body));
    assert.equal(body.get('thing_id'), parent);
    assert.equal(body.get('api_type'), 'json');
    assert.equal(body.get('text'), replyInput().text);
    assert.deepEqual(result, { id: 'reply123', fullname: 't1_reply123', parent_id: parent, url: 'https://www.reddit.com/comments/abc123/_/reply123/', author: 'fixture_user', reused: false });
    const persisted = storage.getItem('reddit-webmcp:reply:reply-request-1234')!;
    for (const secret of [replyInput().text, 'Fixture reply', me.data.modhash]) {
      assert.ok(!persisted.includes(secret));
      assert.ok(!JSON.stringify(result).includes(secret));
    }
  }
});

test('rejects ambiguous reply targets and invalid text before making requests', async () => {
  const { client, requests } = harness([]);
  for (const parent_id of ['abc123', 't4_message', 't3_abc123/other', 'https://www.reddit.com/comments/abc123/']) {
    assert.equal(replySchema.safeParse({ ...replyInput(), parent_id }).success, false);
    await assert.rejects(client.reply({ ...replyInput(), parent_id }), { code: 'INVALID_INPUT' });
  }
  for (const text of ['', ' \n\t', 'a'.repeat(10001)]) await assert.rejects(client.reply({ ...replyInput(), text }), { code: 'INVALID_INPUT' });
  assert.equal(requests.length, 0);
});

test('deduplicates concurrent replies and survives reloads, rejecting changed targets or text', async () => {
  const { client, requests, storage } = harness([me, replied()]);
  await Promise.all([client.reply(replyInput()), client.reply(replyInput())]);
  assert.equal(requests.filter(request => request.init.method === 'POST').length, 1);
  const reloaded = harness([], storage);
  assert.equal((await reloaded.client.reply(replyInput({ parent_id: 'T3_ABC123' })) as { reused: boolean }).reused, true);
  assert.equal(reloaded.requests.length, 0);
  for (const change of [{ parent_id: 't1_c1' }, { text: 'Different reply' }]) await assert.rejects(client.reply(replyInput(change)), { code: 'REQUEST_ID_CONFLICT' });
});

test('post and reply request IDs have independent outcomes', async () => {
  const { client, requests } = harness([me, submitted, me, replied()]);
  await client.createPost(textPost());
  const result = await client.reply(replyInput({ request_id: textPost().request_id })) as { fullname: string };
  assert.equal(result.fullname, 't1_reply123');
  assert.deepEqual(requests.filter(request => request.init.method === 'POST').map(request => request.url.pathname), ['/api/submit', '/api/comment']);
});

test('keeps uncertain replies blocked after reload, including malformed or mismatched confirmations', async () => {
  for (const response of [new TypeError('Connection lost'), new Response('oops', { status: 500 }), { json: { errors: [], data: {} } }, replied('t1_wrong'), { json: { errors: [], data: { things: [{ kind: 't1', data: { id: '../bad' } }] } } }]) {
    const { client, requests, storage } = harness([me, response]);
    await assert.rejects(client.reply(replyInput()), { code: 'SUBMISSION_UNCERTAIN' });
    const reloaded = harness([], storage);
    await assert.rejects(reloaded.client.reply(replyInput()), { code: 'SUBMISSION_UNCERTAIN' });
    assert.equal(requests.length, 2);
    assert.equal(reloaded.requests.length, 0);
  }
});

test('surfaces reply rejections and allows corrected input with the same request ID', async () => {
  const { client, requests } = harness([me, { json: { errors: [['THREAD_LOCKED', 'This thread is locked', 'thing_id']] } }, me, replied('t1_c1')]);
  await assert.rejects(client.reply(replyInput()), { code: 'REDDIT_REJECTED', message: 'THREAD_LOCKED: This thread is locked' });
  await client.reply(replyInput({ parent_id: 't1_c1' }));
  assert.equal(requests.length, 4);
});

test('does not reply without login, modhash, storage, or after cancellation', async () => {
  for (const [response, code] of [[{ data: {} }, 'LOGIN_REQUIRED'], [{ data: { name: 'user' } }, 'SESSION_UNSUPPORTED']] as const) {
    const { client, requests } = harness([response]);
    await assert.rejects(client.reply(replyInput()), { code });
    assert.equal(requests.length, 1);
  }
  const unavailable = harness([], { ...memoryStorage(), setItem() { throw new Error('quota exceeded'); } });
  await assert.rejects(unavailable.client.reply(replyInput()), { code: 'STORAGE_UNAVAILABLE' });
  assert.equal(unavailable.requests.length, 0);
  const cancelled = harness([]);
  await assert.rejects(cancelled.client.reply(replyInput(), AbortSignal.abort()), { name: 'AbortError' });
  assert.equal(cancelled.requests.length, 0);
});
