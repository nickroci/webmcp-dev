/**
 * Joins identity to content.
 *
 * LinkedIn's flagship app is server-driven UI: React props hold a protobuf-shaped
 * program (`proto.sdui.expressions.*`, `Bindable`, `SetState`), not post records. The
 * readable text is produced by evaluating that program and exists only in the DOM.
 * The DOM, in turn, carries no post permalinks or ids.
 *
 * So each half supplies what the other lacks — the post URN comes from the props
 * attached to a rendered element, and the text comes from the element itself.
 *
 * `parsePost` is pure and takes primitives, so the parsing rules are testable without
 * a browser; `readPostSources` is the thin DOM adapter that gathers them.
 */
export const POST_URN = /urn:li:(?:activity|ugcPost|share):[0-9]{1,32}/;
const COMMENT_URN = /^urn:li:(?:fsd_)?comment[:(]/i;

/** Enough text to be a post rather than the composer or a tracking wrapper. */
const MIN_POST_TEXT = 80;
const MAX_HOPS = 12;
const MAX_PROP_DEPTH = 3;

const AUTHOR_LABEL = /(?:control menu for post by|hide post by|post by|actor:)\s*(.+)$/i;
/** An edited post renders its age as "6m \u2022 Edited", so allow a trailing qualifier. */
const AGE = /^(\d+\s*(?:s|m|h|d|w|mo|y|sec|min|hour|day|week|month|year)s?)(\s+ago)?(\s*[\u2022\u00b7\-]\s*[\w ]+)?$/i;
const COUNT_LINE = /^([\d,.]+(?:[KkMm])?)\s+(reactions?|likes?|comments?|reposts?|shares?)$/i;
const ACTION_LINE = /^(like|comment|repost|send|share|follow|connect|…\s*more|see more)$/i;
/** The reaction total renders as a naked number beside the action bar. */
const BARE_COUNT = /^[\d,.]+(?:[KkMm])?$/;
/** Labels LinkedIn puts before the author on feed cards. */
const CARD_MARKER = /^(feed post|suggested post|promoted|sponsored|recommended for you)$/i;
/** Connection chrome LinkedIn renders above a card; not written by the author. */
const SOCIAL_PROOF = /^(followed by\b|\u2022\s*)|\b(likes|loves|celebrates|supports|finds this insightful|commented on|reposted) this$|^(1st|2nd|3rd)\+?$/i;
/** LinkedIn labels the expand control "… more", usually only on the button. */
const MORE_LABEL = /^(?:\u2026|\.\.\.)?\s*(?:see|show|read)?\s*more$/i;

export interface Post {
  urn: string | null;
  permalink: string | null;
  author: string | null;
  posted: string | null;
  text: string | null;
  link: string | null;
  reactions: number | null;
  comments: number | null;
  reposts: number | null;
  kind: 'article' | 'text';
  truncated: boolean;
}

export interface PostSource {
  urn: string;
  text: string;
  /** aria-labels and button text inside the card; the author is reliably in one. */
  controlLabels: string[];
  externalUrl: string | null;
}

export function parsePost(source: PostSource): Post {
  const lines = source.text.split('\n').map(line => line.trim()).filter(Boolean);
  const body: string[] = [];
  let author = authorFromLabels(source.controlLabels);
  let posted: string | null = null;
  const counts: Record<string, number> = {};
  // Everything above the timestamp is header chrome: name, headline, connection degree.
  // It is only used as a fallback author, never as the author's words.
  const header: string[] = [];
  // The expand control is a button label, so it is often absent from the text lines.
  let truncated = source.controlLabels.some(label => MORE_LABEL.test(label.trim()));

  for (const line of lines) {
    if (CARD_MARKER.test(line) || SOCIAL_PROOF.test(line)) continue;
    const count = line.match(COUNT_LINE);
    if (count) { const key = countKey(count[2]!); if (!(key in counts)) counts[key] = parseCount(count[1]!); continue; }
    if (ACTION_LINE.test(line)) { if (MORE_LABEL.test(line)) truncated = true; continue; }
    if (!posted && AGE.test(line)) { posted = line; continue; }
    // Checked after AGE: "4m" is four months old, not four million reactions.
    if (BARE_COUNT.test(line)) { if (!('reactions' in counts)) counts.reactions = parseCount(line); continue; }
    if (!posted) { header.push(line); continue; }
    if (author && line === author) continue;
    body.push(line);
  }

  // A card with no timestamp never separated header from body. Only treat the first
  // line as a name when it reads like one, or a whole paragraph becomes the author.
  if (!posted && !body.length) {
    const [first, ...rest] = header;
    if (first && nameLike(first) && rest.length) { author = author ?? first; body.push(...rest); }
    else body.push(...header);
  } else if (!author) {
    author = header.find(nameLike) ?? null;
  }
  const text = body.join('\n').trim() || null;
  return {
    urn: source.urn,
    permalink: `https://www.linkedin.com/feed/update/${source.urn}/`,
    author,
    posted,
    text,
    link: source.externalUrl,
    reactions: counts.reactions ?? null,
    comments: counts.comments ?? null,
    reposts: counts.reposts ?? null,
    kind: source.externalUrl ? 'article' : 'text',
    truncated,
  };
}

/** A display name is short and is not a sentence. */
function nameLike(line: string): boolean {
  return line.length <= 80 && !/[.!?:]$/.test(line.trim());
}

function authorFromLabels(labels: string[]): string | null {
  for (const label of labels) {
    const match = label.match(AUTHOR_LABEL);
    if (match?.[1]) return match[1].trim().replace(/['"]/g, '') || null;
  }
  return null;
}

function countKey(word: string): string {
  const lower = word.toLowerCase();
  if (lower.startsWith('comment')) return 'comments';
  if (lower.startsWith('repost') || lower.startsWith('share')) return 'reposts';
  return 'reactions';
}

/** LinkedIn abbreviates: "1,234", "12K", "1.2M". */
export function parseCount(value: string): number {
  const cleaned = value.replace(/,/g, '');
  const scale = /k$/i.test(cleaned) ? 1_000 : /m$/i.test(cleaned) ? 1_000_000 : 1;
  const number = Number.parseFloat(cleaned.replace(/[km]$/i, ''));
  return Number.isFinite(number) ? Math.round(number * scale) : 0;
}

/** Cross-origin frames and DOM nodes appear in the props graph and throw when read. */
function unreadable(value: any): boolean {
  try {
    if (typeof Window !== 'undefined' && value instanceof Window) return true;
    return value.self === value || value.nodeType != null || typeof value.then === 'function';
  } catch { return true; }
}

function entriesOf(value: object): Array<[string, unknown]> {
  try { return Object.entries(value); } catch { return []; }
}

/** A post URN inside one props object, ignoring comment URNs that embed one. */
export function urnInProps(value: unknown, depth = MAX_PROP_DEPTH): string | null {
  if (!value || typeof value !== 'object' || depth < 0 || unreadable(value)) return null;
  const entries = entriesOf(value);
  for (const [, item] of entries) {
    if (typeof item !== 'string') continue;
    if (COMMENT_URN.test(item.trim())) continue;
    const match = item.match(POST_URN);
    if (match) return match[0];
  }
  for (const [, item] of entries) {
    if (item && typeof item === 'object') {
      const found = urnInProps(item, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * People and company results are shaped differently from posts: their props carry no
 * URN at all, and identity lives in the DOM instead, as the card's own profile or
 * company link. So entities are keyed by that URL rather than by a URN.
 */
export interface EntitySource { url: string; text: string; kind: 'person' | 'company' }

export interface Entity {
  kind: 'person' | 'company';
  name: string | null;
  /** A person's headline, or a company's industry. */
  headline: string | null;
  location: string | null;
  /** Shared connections for a person, or the description for a company. */
  detail: string | null;
  followers: number | null;
  degree: string | null;
  url: string;
}

const DEGREE_SUFFIX = /^(.*?)\s*[•·]\s*(1st|2nd|3rd\+?)\s*$/i;
const DEGREE_ONLY = /^[•·]?\s*(1st|2nd|3rd\+?)$/i;
const CARD_CONTROL = /^(follow|following|connect|message|view profile|verified|save|•)$/i;
const MUTUALS = /mutual connection/i;
const FOLLOWERS = /^([\d,.]+(?:[KkMm])?)\s+followers?$/i;

export function parseEntity(source: EntitySource): Entity {
  const lines = source.text.split('\n').map(line => line.trim()).filter(Boolean).filter(line => !CARD_CONTROL.test(line));
  let name: string | null = lines.shift() ?? null;
  let degree: string | null = null;

  if (name) {
    const suffixed = name.match(DEGREE_SUFFIX);
    if (suffixed) { name = suffixed[1]!.trim(); degree = suffixed[2]!; }
  }
  // LinkedIn sometimes renders the connection degree on its own line instead.
  if (lines[0] && DEGREE_ONLY.test(lines[0])) degree = lines.shift()!.replace(/^[•·]\s*/, '');

  let followers: number | null = null;
  const remaining: string[] = [];
  let detail: string | null = null;
  for (const line of lines) {
    const count = line.match(FOLLOWERS);
    if (count) { followers = parseCount(count[1]!); continue; }
    if (MUTUALS.test(line)) { detail = detail ?? line; continue; }
    remaining.push(line);
  }

  // Headline then location lead the card; a company's description follows them.
  const headline = remaining[0] ?? null;
  const location = remaining[1] ?? null;
  if (!detail && remaining.length > 2) detail = remaining.slice(2).join(' ') || null;

  return { kind: source.kind, name: name || null, headline, location, detail, followers, degree, url: source.url };
}
