import { ToolError as RedditError } from '../../errors';
import { deleteSchema, normalizePost, normalizeSubreddit, normalizedSort, redditHosts, replySchema, type CreateInput, type DeleteInput, type ListInput, type ReadInput, type ReplyInput } from './schemas';

type Json = Record<string, any>;
export interface ClientOptions {
  origin: string;
  fetch: typeof fetch;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  timeoutMs?: number;
}

function listing(value: Json): Json[] {
  if (value?.kind !== 'Listing' || !Array.isArray(value.data?.children)) {
    throw new RedditError('UNEXPECTED_RESPONSE', 'Reddit did not return a post listing. Check access to this subreddit.');
  }
  return value.data.children;
}

function postData(data: Json) {
  return {
    id: data.id, fullname: data.name, subreddit: data.subreddit,
    title: data.title, author: data.author, text: data.selftext ?? '',
    url: data.url, permalink: new URL(data.permalink, 'https://www.reddit.com').href,
    kind: data.is_self ? 'text' : 'link', score: data.score, comment_count: data.num_comments,
    created_utc: data.created_utc, nsfw: !!data.over_18, spoiler: !!data.spoiler,
    pinned: !!data.stickied, locked: !!data.locked, flair: data.link_flair_text ?? null,
  };
}

export class RedditClient {
  private origin: string;
  private inFlight = new Map<string, Promise<unknown>>();
  constructor(private options: ClientOptions) {
    const url = new URL(options.origin);
    if (!redditHosts.has(url.hostname) || url.protocol !== 'https:' || url.port || url.username || url.password) {
      throw new RedditError('WRONG_ORIGIN', 'Inject Reddit WebMCP into an HTTPS Reddit page.');
    }
    this.origin = url.origin;
  }

  private async request(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Json> {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) throw new RedditError('WRONG_ORIGIN', 'Reddit requests must stay on the current origin.');
    url.searchParams.set('raw_json', '1');
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 20000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await this.options.fetch(url.href, {
        ...init, credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: combined,
        headers: { Accept: 'application/json', ...init.headers },
      });
      if (!response.ok) {
        const code = response.status === 429 ? 'RATE_LIMITED' : response.status === 401 ? 'LOGIN_REQUIRED' : response.status === 403 ? 'ACCESS_DENIED' : 'HTTP_ERROR';
        throw new RedditError(code, `Reddit returned HTTP ${response.status}. ${response.status === 403 ? 'Check login and subreddit access in this tab; Reddit may also be blocking API requests.' : response.status === 429 ? 'Wait before trying again.' : 'Check the Reddit page before retrying.'}`, { status: response.status, retry_after: response.headers.get('retry-after') });
      }
      let data: Json;
      try { data = await response.json(); }
      catch { throw new RedditError('UNEXPECTED_RESPONSE', 'Reddit returned a non-JSON response. Open Reddit and resolve any login or verification screen.'); }
      if (!data || typeof data !== 'object') throw new RedditError('UNEXPECTED_RESPONSE', 'Reddit returned an invalid response.');
      if (typeof data.error === 'number' && data.error >= 400) {
        throw new RedditError('REDDIT_ERROR', String(data.message ?? `Reddit error ${data.error}`), { status: data.error });
      }
      return data;
    } catch (error) {
      if (error instanceof RedditError) throw error;
      if (combined.aborted) throw new RedditError('ABORTED', 'Request cancelled or timed out.');
      throw new RedditError('NETWORK_ERROR', 'Could not reach the Reddit endpoint. Check this tab’s connection and login.');
    }
  }

  async listPosts(input: ListInput, signal?: AbortSignal) {
    const subreddit = normalizeSubreddit(input.subreddit);
    const sort = normalizedSort(input.sort);
    const params = new URLSearchParams({ limit: String(input.limit) });
    if (['top', 'controversial'].includes(sort)) params.set('t', input.time);
    if (input.after) params.set('after', input.after);
    const data = await this.request(`/r/${subreddit}/${sort}.json?${params}`, {}, signal);
    const posts = listing(data).filter(item => item.kind === 't3').map(item => postData(item.data));
    return { subreddit, sort, time: ['top', 'controversial'].includes(sort) ? input.time : null, posts, next_after: data.data.after ?? null, previous_before: data.data.before ?? null };
  }

  async readPost(input: ReadInput, signal?: AbortSignal) {
    const id = normalizePost(input.post);
    const params = new URLSearchParams({
      sort: input.comment_sort === 'best' ? 'confidence' : input.comment_sort,
      limit: String(input.comment_limit), depth: String(input.comment_depth),
    });
    const response = await this.request(`/comments/${id}.json?${params}`, {}, signal);
    if (!Array.isArray(response) || response.length < 2) throw new RedditError('UNEXPECTED_RESPONSE', 'Reddit did not return a post and comment tree.');
    const post = listing(response[0]).find(item => item.kind === 't3');
    if (!post) throw new RedditError('NOT_FOUND', 'This post is unavailable.');
    const comments: Json[] = [];
    const more: Json[] = [];
    let truncated = false;
    const visit = (items: Json[], depth: number) => {
      for (const item of items) {
        if (item.kind === 'more') { more.push({ parent_id: item.data.parent_id, count: item.data.count, children: item.data.children ?? [] }); continue; }
        if (item.kind !== 't1') continue;
        if (comments.length >= input.comment_limit || depth >= input.comment_depth) { truncated = true; continue; }
        const data = item.data;
        comments.push({ id: data.id, fullname: data.name, parent_id: data.parent_id, author: data.author, text: data.body, score: data.score, created_utc: data.created_utc, depth });
        if (data.replies?.data?.children) visit(data.replies.data.children, depth + 1);
      }
    };
    visit(listing(response[1]), 0);
    return { post: postData(post.data), comments, more_comments: more, comments_truncated: truncated || more.length > 0 };
  }

  async createPost(input: CreateInput, signal?: AbortSignal): Promise<unknown> {
    const normalized = { ...input, subreddit: normalizeSubreddit(input.subreddit), title: input.title.trim() };
    if (!normalized.title) throw new RedditError('INVALID_INPUT', 'Title cannot be blank.');
    if (input.kind === 'link') {
      if (!input.url || !['https:', 'http:'].includes(new URL(input.url).protocol)) throw new RedditError('INVALID_INPUT', 'Link posts require an HTTP(S) URL.');
      if (input.text !== undefined) throw new RedditError('INVALID_INPUT', 'Use text only with kind: text.');
    } else if (input.url !== undefined) throw new RedditError('INVALID_INPUT', 'Use url only with kind: link.');
    return this.trackSubmission(`reddit-webmcp:submission:${input.request_id}`, normalized, () => this.submit(normalized, signal), signal);
  }

  async reply(input: ReplyInput, signal?: AbortSignal): Promise<unknown> {
    const parsed = replySchema.safeParse(input);
    if (!parsed.success || !parsed.data.text.trim()) throw new RedditError('INVALID_INPUT', 'Supply a t3_ post or t1_ comment fullname, nonblank reply text up to 10,000 characters, and a valid request_id.');
    const normalized = { ...parsed.data, parent_id: parsed.data.parent_id.toLowerCase() };
    return this.trackSubmission(`reddit-webmcp:reply:${input.request_id}`, normalized, () => this.submitReply(normalized, signal), signal);
  }

  async deleteThing(input: DeleteInput, signal?: AbortSignal) {
    const parsed = deleteSchema.safeParse(input);
    if (!parsed.success) throw new RedditError('INVALID_INPUT', 'Supply a t3_ post or t1_ comment fullname that you authored.');
    if (!parsed.data.confirm) throw new RedditError('CONFIRMATION_REQUIRED', 'Set confirm to true. Deleting a post or comment is permanent and cannot be undone.');
    const thingId = parsed.data.thing_id.toLowerCase();
    const me = await this.request('/api/me.json', {}, signal);
    if (!me.data?.name) throw new RedditError('LOGIN_REQUIRED', 'Sign in to Reddit in this tab before deleting.');
    if (!me.data.modhash) throw new RedditError('SESSION_UNSUPPORTED', 'Reddit did not expose a CSRF modhash for this session. Try the extension on old.reddit.com while signed in.');
    // Reddit silently ignores a delete on someone else's thing, so confirm authorship rather than
    // reporting a success that never happened.
    const before = listing(await this.request(`/api/info.json?id=${encodeURIComponent(thingId)}`, {}, signal))
      .find(item => item.data?.name === thingId);
    if (!before) throw new RedditError('NOT_FOUND', 'No post or comment with that fullname is visible from this tab.');
    if (before.data.author !== me.data.name) {
      throw new RedditError('NOT_AUTHOR', `This ${before.kind === 't3' ? 'post' : 'comment'} was written by u/${before.data.author}, not by the signed-in user u/${me.data.name}.`);
    }
    if (signal?.aborted) throw new RedditError('ABORTED', 'Cancelled before deletion.');
    await this.request('/api/del', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Modhash': me.data.modhash },
      body: new URLSearchParams({ id: thingId }).toString(),
    }, signal);
    // Deletion is idempotent, so an unverified result is safe to re-run; report it rather than guess.
    let verified = false;
    try {
      const after = listing(await this.request(`/api/info.json?id=${encodeURIComponent(thingId)}`, {}, signal))
        .find(item => item.data?.name === thingId);
      verified = !after || after.data.author === '[deleted]';
    } catch { verified = false; }
    return { thing_id: thingId, kind: before.kind === 't3' ? 'post' : 'comment', author: me.data.name, deleted: true, verified };
  }

  private async trackSubmission(key: string, input: unknown, submit: () => Promise<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown> {
    // Only the fingerprint and outcome persist; bodies and CSRF tokens are never stored.
    const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input)))))
      .map(n => n.toString(16).padStart(2, '0')).join('');
    let existing: Json | null;
    try { existing = JSON.parse(this.options.storage.getItem(key) ?? 'null'); }
    catch { throw new RedditError('STORAGE_UNAVAILABLE', 'Session storage is unavailable; cannot track this submission safely.'); }
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new RedditError('REQUEST_ID_CONFLICT', 'This request_id was already used for different content or a different target.');
      const active = this.inFlight.get(key);
      if (active) return active;
      if (existing.state === 'complete') return { ...existing.result, reused: true };
      throw new RedditError('SUBMISSION_UNCERTAIN', 'A submission with this request_id was started but its outcome is unknown. Check your Reddit profile before submitting again.');
    }
    signal?.throwIfAborted();
    try { this.options.storage.setItem(key, JSON.stringify({ fingerprint, state: 'pending' })); }
    catch { throw new RedditError('STORAGE_UNAVAILABLE', 'Session storage is unavailable; nothing was submitted.'); }
    const task = submit().then(result => {
      try { this.options.storage.setItem(key, JSON.stringify({ fingerprint, state: 'complete', result })); } catch { /* Pending marker still prevents retry. */ }
      return result;
    }).catch(error => {
      if (error instanceof RedditError && error.code !== 'SUBMISSION_UNCERTAIN') {
        this.options.storage.removeItem(key);
      }
      throw error;
    }).finally(() => { this.inFlight.delete(key); });
    this.inFlight.set(key, task);
    return task;
  }

  private async submitReply(input: ReplyInput, signal?: AbortSignal) {
    const me = await this.request('/api/me.json', {}, signal);
    if (!me.data?.name) throw new RedditError('LOGIN_REQUIRED', 'Sign in to Reddit in this tab before posting a reply.');
    if (!me.data.modhash) throw new RedditError('SESSION_UNSUPPORTED', 'Reddit did not expose a CSRF modhash for this session. Try the extension on old.reddit.com while signed in.');
    const body = new URLSearchParams({ api_type: 'json', thing_id: input.parent_id, text: input.text });
    if (signal?.aborted) throw new RedditError('ABORTED', 'Cancelled before submission.');
    let response: Json;
    try {
      response = await this.request('/api/comment', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Modhash': me.data.modhash }, body: body.toString() }, signal);
    } catch (error) {
      throw new RedditError('SUBMISSION_UNCERTAIN', 'Reply did not return a confirmed outcome. Check the thread or your Reddit profile before trying again.', error instanceof RedditError ? { cause: error.code, ...asObject(error.details) } : undefined);
    }
    const errors = response.json?.errors;
    if (Array.isArray(errors) && errors.length) {
      throw new RedditError('REDDIT_REJECTED', errors.map((entry: unknown[]) => `${entry[0]}: ${entry[1]}`).join('; '), { errors });
    }
    const things = response.json?.data?.things;
    const data = Array.isArray(things) ? things.find(item => item?.kind === 't1')?.data : undefined;
    // /api/comment returns `id` as a fullname and names the target `parent`, while listing
    // data uses a bare `id` and `parent_id`. Accept either, or a confirmed reply reads as lost.
    const bare = (value: unknown) => (typeof value === 'string' ? value.replace(/^t1_/, '') : undefined);
    const id = bare(data?.id) ?? bare(data?.name);
    const named = bare(data?.name);
    const parent = typeof data?.parent_id === 'string' ? data.parent_id
      : typeof data?.parent === 'string' ? data.parent : undefined;
    if (typeof id !== 'string' || !/^[a-z0-9]{1,16}$/.test(id) || (named && named !== id) || (parent && parent.toLowerCase() !== input.parent_id)) {
      throw new RedditError('SUBMISSION_UNCERTAIN', 'Reddit did not return a confirmed comment ID for this reply. Check the thread or your profile before retrying.');
    }
    // Construct a permalink from the confirmed IDs; never persist the reply body.
    const post = typeof data.link_id === 'string' && /^t3_[a-z0-9]{1,16}$/.test(data.link_id)
      ? data.link_id.slice(3) : input.parent_id.startsWith('t3_') ? input.parent_id.slice(3) : undefined;
    const url = post ? new URL(`/comments/${post}/_/${id}/`, this.origin).href : null;
    return { id, fullname: `t1_${id}`, parent_id: input.parent_id, url, author: me.data.name, reused: false };
  }

  private async submit(input: CreateInput, signal?: AbortSignal) {
    const me = await this.request('/api/me.json', {}, signal);
    if (!me.data?.name) throw new RedditError('LOGIN_REQUIRED', 'Sign in to Reddit in this tab before creating a post.');
    if (!me.data.modhash) throw new RedditError('SESSION_UNSUPPORTED', 'Reddit did not expose a CSRF modhash for this session. Try the extension on old.reddit.com while signed in.');
    const body = new URLSearchParams({
      api_type: 'json', sr: input.subreddit, title: input.title,
      kind: input.kind === 'text' ? 'self' : 'link',
      nsfw: String(input.nsfw), spoiler: String(input.spoiler), sendreplies: String(input.send_replies),
      resubmit: 'false', extension: 'json',
    });
    if (input.kind === 'text') body.set('text', input.text ?? '');
    else body.set('url', input.url!);
    if (input.flair_id) body.set('flair_id', input.flair_id);
    if (input.flair_text !== undefined) body.set('flair_text', input.flair_text);
    if (signal?.aborted) throw new RedditError('ABORTED', 'Cancelled before submission.');
    let response: Json;
    try {
      response = await this.request('/api/submit', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Modhash': me.data.modhash }, body: body.toString() }, signal);
    } catch (error) {
      // Never retry a mutation automatically: Reddit might have committed it before a timeout.
      throw new RedditError('SUBMISSION_UNCERTAIN', 'Submission did not return a confirmed outcome. Check your Reddit profile before trying again.', error instanceof RedditError ? { cause: error.code, ...asObject(error.details) } : undefined);
    }
    const errors = response.json?.errors;
    if (Array.isArray(errors) && errors.length) {
      throw new RedditError('REDDIT_REJECTED', errors.map((entry: unknown[]) => `${entry[0]}: ${entry[1]}`).join('; '), { errors });
    }
    const data = response.json?.data;
    if (!data?.url || !(data.name || data.id)) throw new RedditError('SUBMISSION_UNCERTAIN', 'Reddit did not return a post ID and URL. Check your profile before retrying.');
    return { id: data.id ?? String(data.name).replace(/^t3_/, ''), fullname: data.name ?? `t3_${data.id}`, url: data.url, subreddit: input.subreddit, author: me.data.name, reused: false };
  }
}

function asObject(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }
