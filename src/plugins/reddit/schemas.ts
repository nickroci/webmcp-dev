import { z } from 'zod';
import { ToolError as RedditError } from '../../errors';

export const redditHosts = new Set(['reddit.com', 'www.reddit.com', 'old.reddit.com', 'new.reddit.com']);
const subreddit = z.string().min(1).max(200).describe('Subreddit name, r/name, or a Reddit subreddit URL.');
const sort = z.enum(['new', 'latest', 'hot', 'top', 'rising', 'controversial']).default('new');
const time = z.enum(['hour', 'day', 'week', 'month', 'year', 'all']).default('all').describe('Time window for top or controversial.');
export const browseSchema = z.strictObject({ subreddit, sort, time });
export const listSchema = browseSchema.extend({
  limit: z.number().int().min(1).max(100).default(25),
  after: z.string().regex(/^t3_[a-z0-9]+$/i).optional().describe('Use next_after from the previous result.'),
});
export const readSchema = z.strictObject({
  post: z.string().min(1).max(2048).describe('Reddit post URL, base36 ID, or t3_ fullname. Share /s/ links are not supported.'),
  comment_sort: z.enum(['best', 'top', 'new', 'old', 'controversial', 'qa']).default('best'),
  comment_limit: z.number().int().min(0).max(100).default(25),
  comment_depth: z.number().int().min(1).max(10).default(3),
});
export const createSchema = z.strictObject({
  subreddit,
  title: z.string().min(1).max(300),
  kind: z.enum(['text', 'link']).default('text'),
  text: z.string().max(40000).optional().describe('Markdown body for text posts.').meta({ 'x-multiline': true }),
  url: z.string().url().max(2048).optional().describe('HTTP(S) target for link posts.'),
  flair_id: z.string().uuid().optional(),
  flair_text: z.string().max(64).optional(),
  nsfw: z.boolean().default(false),
  spoiler: z.boolean().default(false),
  send_replies: z.boolean().default(true),
  request_id: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/).describe('Unique ID per intended post. Reuse on retries with identical inputs to prevent duplicate submission in this tab/origin.').meta({ 'x-generate': 'uuid' }),
});
export const replySchema = z.strictObject({
  parent_id: z.string().regex(/^t[13]_[a-z0-9]{1,16}$/i).describe('Fullname of the target post (t3_...) or comment (t1_...), from list_posts or read_post. Bare IDs and private messages are not accepted.'),
  text: z.string().min(1).max(10000).describe('Markdown text of the reply.').meta({ 'x-multiline': true }),
  request_id: createSchema.shape.request_id.describe('Unique ID per intended reply. Reuse with identical parent and text on retries to prevent duplicate submission in this tab/origin.').meta({ 'x-generate': 'uuid' }),
});

export type BrowseInput = z.infer<typeof browseSchema>;
export type ListInput = z.infer<typeof listSchema>;
export type ReadInput = z.infer<typeof readSchema>;
export type CreateInput = z.infer<typeof createSchema>;
export type ReplyInput = z.infer<typeof replySchema>;

function redditURL(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new RedditError('INVALID_INPUT', 'Expected a valid Reddit URL.'); }
  if (url.protocol !== 'https:' || !redditHosts.has(url.hostname) || url.port || url.username || url.password) {
    throw new RedditError('INVALID_INPUT', 'Expected an HTTPS URL on reddit.com, www.reddit.com, old.reddit.com, or new.reddit.com.');
  }
  return url;
}

export function normalizeSubreddit(value: string): string {
  let name = value.trim();
  if (/^https?:/i.test(name)) {
    const match = redditURL(name).pathname.match(/^\/r\/([a-z0-9_]+)(?:\/|$)/i);
    if (!match) throw new RedditError('INVALID_INPUT', 'URL must identify a subreddit.');
    name = match[1];
  } else {
    name = name.replace(/^\/?r\//i, '').replace(/\/$/, '');
  }
  if (!/^[a-z0-9_]{2,21}$/i.test(name)) throw new RedditError('INVALID_INPUT', 'Subreddit names must contain 2–21 letters, digits, or underscores.');
  return name;
}

export function normalizePost(value: string): string {
  let id = value.trim();
  if (/^https?:/i.test(id)) {
    const url = new URL(id);
    if (url.hostname === 'redd.it' && url.protocol === 'https:' && !url.username && !url.password && !url.port) {
      id = url.pathname.replace(/^\//, '').replace(/\/$/, '');
    } else {
      const match = redditURL(id).pathname.match(/^\/(?:r\/[a-z0-9_]+\/)?comments\/([a-z0-9]+)(?:\/|$)/i);
      if (!match) throw new RedditError('INVALID_INPUT', 'Use a full /comments/ post URL, not a /s/ share URL.');
      id = match[1];
    }
  }
  id = id.replace(/^t3_/i, '');
  if (!/^[a-z0-9]{1,16}$/i.test(id)) throw new RedditError('INVALID_INPUT', 'Expected a Reddit post ID or URL.');
  return id.toLowerCase();
}

export function normalizedSort(value: BrowseInput['sort']): string { return value === 'latest' ? 'new' : value; }

export function subredditPath(input: BrowseInput): string {
  const sort = normalizedSort(input.sort);
  const path = `/r/${normalizeSubreddit(input.subreddit)}/${sort}/`;
  return ['top', 'controversial'].includes(sort) ? `${path}?t=${input.time}` : path;
}
