import { z } from 'zod';
import { ToolError } from '../../errors';

export const linkedinHosts = new Set(['linkedin.com', 'www.linkedin.com']);

// Capped at what a person could actually read on screen. These tools re-present the
// member's own view; they are not a way to collect at a rate no reader could match.
const limit = z.number().int().min(1).max(25).default(10);
const expand = z.boolean().default(true).describe('Click the post’s own "see more" controls first so full text is rendered.');

export const feedSchema = z.strictObject({
  limit,
  expand,
  only: z.enum(['all', 'article', 'text']).default('all').describe('Keep only posts of one kind. Use article for the top shared article.'),
});

export const searchSchema = z.strictObject({
  keywords: z.string().min(1).max(300).describe('The search this tab is showing. Open it with linkedin_open first.'),
  type: z.enum(['all', 'posts', 'people', 'companies', 'jobs']).default('all'),
  limit,
});

export const readPostSchema = z.strictObject({
  expect: z.string().max(2048).optional().describe('Optional post URL or URN the tab should be showing. The read fails rather than returning a different post.'),
  comment_limit: z.number().int().min(0).max(50).default(10),
  expand,
});

export const openSchema = z.strictObject({
  target: z.enum(['feed', 'post', 'profile', 'search']).default('feed'),
  value: z.string().max(2048).optional().describe('Post URL or URN, profile URL or public identifier, or search keywords. Omit for the feed.'),
  type: z.enum(['all', 'posts', 'people', 'companies', 'jobs']).default('all').describe('Which search to open. Used only with target "search"; posts finds articles and updates.'),
});

export type FeedInput = z.infer<typeof feedSchema>;
export type SearchInput = z.infer<typeof searchSchema>;
export type ReadPostInput = z.infer<typeof readPostSchema>;
export type OpenInput = z.infer<typeof openSchema>;

function linkedinURL(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ToolError('INVALID_INPUT', 'Expected a valid LinkedIn URL.'); }
  if (url.protocol !== 'https:' || !linkedinHosts.has(url.hostname) || url.port || url.username || url.password) {
    throw new ToolError('INVALID_INPUT', 'Expected an HTTPS URL on linkedin.com or www.linkedin.com.');
  }
  return url;
}

const URN_TYPES = ['activity', 'ugcPost', 'share'] as const;

export function normalizePostUrn(value: string): string {
  const input = value.trim();
  if (/^urn:li:/i.test(input)) {
    const match = input.match(/^urn:li:(activity|ugcPost|share):([0-9]{1,32})$/i);
    if (!match) throw new ToolError('INVALID_INPUT', `Expected a ${URN_TYPES.join(', ')} URN, such as urn:li:activity:7000000000000000000.`);
    return `urn:li:${URN_TYPES.find(type => type.toLowerCase() === match[1]!.toLowerCase())}:${match[2]}`;
  }
  if (/^[0-9]{6,32}$/.test(input)) return `urn:li:activity:${input}`;
  if (/^https?:/i.test(input)) {
    const url = linkedinURL(input);
    const embedded = decodeURIComponent(url.pathname).match(/\/feed\/update\/(urn:li:(?:activity|ugcPost|share):[0-9]{1,32})/i);
    if (embedded) return normalizePostUrn(embedded[1]!);
    const slug = url.pathname.match(/-activity-([0-9]{6,32})-/i) ?? url.pathname.match(/\/posts\/[^/]*?([0-9]{15,32})/i);
    if (slug) return `urn:li:activity:${slug[1]}`;
    throw new ToolError('INVALID_INPUT', 'That LinkedIn URL does not contain a post ID. Use a /feed/update/ or /posts/ URL.');
  }
  throw new ToolError('INVALID_INPUT', 'Expected a LinkedIn post URL, URN, or numeric post ID.');
}

export function normalizeProfile(value: string): string {
  let id = value.trim();
  if (/^https?:/i.test(id)) {
    const match = linkedinURL(id).pathname.match(/^\/in\/([^/]+)/i);
    if (!match) throw new ToolError('INVALID_INPUT', 'That LinkedIn URL is not a /in/ profile URL.');
    id = decodeURIComponent(match[1]!);
  }
  id = id.replace(/^\/?in\//i, '').replace(/\/$/, '');
  if (!/^[A-Za-z0-9\-%_.À-ɏЀ-ӿ]{3,120}$/.test(id)) throw new ToolError('INVALID_INPUT', 'Expected a LinkedIn profile URL or public identifier.');
  return id;
}

export function postPath(urn: string): string { return `/feed/update/${urn}/`; }

export function searchPath(input: { keywords: string; type: SearchInput['type'] }): string {
  const segment = { all: 'all/', posts: 'content/', people: 'people/', companies: 'companies/', jobs: '' }[input.type];
  const base = input.type === 'jobs' ? '/jobs/search/' : `/search/results/${segment}`;
  return `${base}?keywords=${encodeURIComponent(input.keywords)}`;
}
