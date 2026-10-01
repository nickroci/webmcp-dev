import { fiberFromNode } from './react';
import { urnInProps, type EntitySource, type JobSource, type PostSource, type ProfileSource } from './extract';

/**
 * The DOM adapter: finds each rendered post card and the URN identifying it.
 *
 * Cards are found by shape, not by class name — a block with substantial text that no
 * single child accounts for. That is the card, as opposed to the paragraph inside it
 * or the wrapper around several of them.
 *
 * Identity is then looked for in the props attached to the card *or anything inside
 * it*. Searching upward alone is not enough: on the feed the URN sits high, but on
 * search pages it sits on a link or a span deep inside the card, and an ancestor's
 * props never mention a URN that lives below them.
 */
const MAX_HOPS = 12;
const NEAR_HOPS = 3;
const MIN_CARD_TEXT = 80;
const CHILD_DOMINANCE = 0.85;
const DESCENDANT_BUDGET = 500;

export function readPostSources(root: ParentNode, minText = MIN_CARD_TEXT): PostSource[] {
  const blocks = cardBlocks(root, minText);
  const order = new Map<Element, number>();
  blocks.forEach((block, index) => order.set(block, index));

  const byUrn = new Map<string, Element>();
  for (const block of blocks) {
    const urn = urnForElement(block, MAX_HOPS) ?? urnFromDescendants(block);
    if (!urn) continue;
    const current = byUrn.get(urn);
    // LinkedIn pairs share and activity URNs; keep whichever element holds the text.
    if (!current || textOf(block).length > textOf(current).length) byUrn.set(urn, block);
  }

  const cards = [...byUrn.entries()].sort((a, b) => (order.get(a[1]) ?? 0) - (order.get(b[1]) ?? 0));
  // Drop a wrapper that swallowed several cards, keeping the individual ones.
  const kept = cards.filter(([, element]) => !cards.some(([, other]) => other !== element && element.contains(other)));
  const seen = new Set<Element>();

  return kept.filter(([, element]) => !seen.has(element) && seen.add(element)).map(([urn, element]) => ({
    urn,
    text: textOf(element),
    controlLabels: controlLabelsOf(element),
    externalUrl: externalUrlOf(element),
  }));
}

/** A block carrying its own substantial text, rather than inheriting it from one child. */
function cardBlocks(root: ParentNode, minText: number): Element[] {
  const blocks: Element[] = [];
  for (const element of root.querySelectorAll('*')) {
    const text = textOf(element);
    if (text.length < minText) continue;
    let dominated = false;
    for (const child of element.children) {
      if (textOf(child).length > text.length * CHILD_DOMINANCE) { dominated = true; break; }
    }
    if (!dominated) blocks.push(element);
  }
  return blocks;
}

export function urnForElement(element: Element, maxHops = MAX_HOPS): string | null {
  let fiber = fiberFromNode(element);
  let hops = 0;
  while (fiber && hops < maxHops) {
    const urn = urnInProps(fiber.memoizedProps);
    if (urn) return urn;
    fiber = fiber.return ?? null;
    hops += 1;
  }
  return null;
}

/** Search pages attach the URN to a link or span inside the card, not above it. */
function urnFromDescendants(block: Element): string | null {
  let checked = 0;
  for (const element of block.querySelectorAll('*')) {
    if (checked >= DESCENDANT_BUDGET) break;
    checked += 1;
    const urn = urnForElement(element, NEAR_HOPS);
    if (urn) return urn;
  }
  return null;
}

function textOf(element: Element): string {
  return ((element as HTMLElement).innerText ?? element.textContent ?? '').trim();
}

/** aria-labels carry the author reliably: "Open control menu for post by <name>". */
function controlLabelsOf(element: Element): string[] {
  const labels: string[] = [];
  for (const node of element.querySelectorAll('button, [aria-label]')) {
    const label = node.getAttribute('aria-label') ?? '';
    if (label) labels.push(label);
    if (labels.length >= 24) break;
  }
  return labels;
}

function externalUrlOf(element: Element): string | null {
  for (const anchor of element.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href') ?? '';
    if (!/^https?:\/\//i.test(href)) continue;
    try {
      const host = new URL(href).hostname;
      if (!/(^|\.)linkedin\.com$/i.test(host) && !/(^|\.)licdn\.com$/i.test(host)) return href;
    } catch { /* Not a usable URL. */ }
  }
  return null;
}

/**
 * People and company cards carry no URN in their props, so they are keyed by the
 * card's own profile or company link instead.
 *
 * The subject is the card's *first* such link: the rest belong to shared connections,
 * and keying on any of those attaches a card to the wrong person.
 */
const MIN_ENTITY_TEXT = 40;

export function readEntitySources(root: ParentNode, kind: 'person' | 'company', minText = MIN_ENTITY_TEXT): EntitySource[] {
  const selector = kind === 'person' ? 'a[href*="/in/"]' : 'a[href*="/company/"]';
  const blocks = cardBlocks(root, minText);
  const byUrl = new Map<string, Element>();

  for (const block of blocks) {
    const anchor = block.querySelector(selector);
    const href = anchor?.getAttribute('href')?.split('?')[0];
    if (!href) continue;
    if (textOf(block).split('\n').filter(Boolean).length < 2) continue;
    const current = byUrl.get(href);
    // Prefer the most specific block: a wrapper around several cards shares its first link.
    if (!current || textOf(block).length < textOf(current).length) byUrl.set(href, block);
  }

  const cards = [...byUrl.entries()];
  const kept = cards.filter(([, element]) => !cards.some(([, other]) => other !== element && element.contains(other)));
  return kept.map(([url, element]) => ({ url: absolute(url), text: textOf(element), kind }));
}

/**
 * A job card carries no URN and no profile link. Identity is the numeric id in its own
 * /jobs/view/<id>/ link. Jobs search is a split pane, so the detail on the right and the
 * card on the left share an id; the smallest block wins, as it does for entity cards.
 */
const MIN_JOB_TEXT = 30;

export function readJobSources(root: ParentNode, minText = MIN_JOB_TEXT): JobSource[] {
  const blocks = cardBlocks(root, minText);
  const byId = new Map<string, Element>();

  for (const block of blocks) {
    const id = jobIdIn(block);
    if (!id) continue;
    if (textOf(block).split('\n').filter(Boolean).length < 2) continue;
    const current = byId.get(id);
    if (!current || textOf(block).length < textOf(current).length) byId.set(id, block);
  }

  const cards = [...byId.entries()];
  const kept = cards.filter(([, element]) => !cards.some(([, other]) => other !== element && element.contains(other)));
  return kept.map(([id, element]) => ({ id, url: `https://www.linkedin.com/jobs/view/${id}/`, text: textOf(element) }));
}

/**
 * The posting body, which is never the card. On a jobs search it is the detail pane
 * beside the list; on /jobs/view/<id>/ it is the page, which links to no job because it
 * *is* the job. Both are the largest block carrying no job link of their own, so cards
 * and the "similar jobs" rail drop out. `contains` pins it to the open job when the card
 * is there to say what its title is.
 */
export function readJobBody(root: ParentNode, contains: string | null, minText = MIN_JOB_TEXT): string | null {
  const blocks = cardBlocks(root, minText).filter(block => !jobIdIn(block));
  const pinned = contains ? blocks.filter(block => textOf(block).includes(contains)) : [];
  const best = (pinned.length ? pinned : blocks).sort((a, b) => textOf(b).length - textOf(a).length)[0];
  return best ? textOf(best) : null;
}

export function jobIdIn(element: Element): string | null {
  for (const anchor of element.querySelectorAll('a[href*="/jobs/view/"]')) {
    const match = (anchor.getAttribute('href') ?? '').match(/\/jobs\/view\/(\d{4,20})/);
    if (match) return match[1]!;
  }
  return null;
}

/**
 * A profile has no cards to find by shape; it is one document with landmarks. The
 * person's name is a heading: an h1 on older layouts, an h2 now. Rather than trust either
 * level, take the heading whose text is the name the page title gives ("Name | LinkedIn").
 * Each other h2 heads a section, which is the widest ancestor holding no other heading,
 * so it takes the whole section and never its neighbour's.
 */
export function readProfileSource(root: ParentNode, url: string, title: string): ProfileSource | null {
  const titled = title.split('|')[0]!.trim();
  const headings = [...root.querySelectorAll('h1, h2')];
  const nameHeading = headings.find(heading => heading.tagName === 'H1')
    ?? headings.find(heading => titled && firstLine(heading) === titled)
    ?? null;
  if (!nameHeading) return null;

  const sections = headings.filter(heading => heading !== nameHeading && heading.tagName === 'H2').map(heading => ({
    heading: firstLine(heading),
    text: textOf(ownSection(heading)),
  })).filter(section => section.heading);

  return { url, name: firstLine(nameHeading) || null, top: textOf(ownSection(nameHeading)), sections };
}

/** The About section, the one place on a profile where "see more" only expands text. */
export function profileAboutSection(root: ParentNode): Element | null {
  const heading = [...root.querySelectorAll('h2')].find(h2 => /^about$/i.test(firstLine(h2)));
  return heading ? ownSection(heading) : null;
}

/** A /details/<section>/ page is one list with no heading element, only its first line. */
export function readProfileDetails(root: Element): { heading: string; text: string } | null {
  const text = textOf(root);
  const heading = text.split('\n').map(line => line.trim()).find(Boolean);
  return heading ? { heading, text } : null;
}

function firstLine(element: Element): string {
  return textOf(element).split('\n')[0]!.trim();
}

function ownSection(heading: Element): Element {
  let section = heading;
  while (section.parentElement && section.parentElement.tagName !== 'MAIN' && section.parentElement.tagName !== 'BODY') {
    const parent = section.parentElement;
    if (parent.querySelectorAll('h1, h2').length > 1) break;
    section = parent;
  }
  return section;
}

function absolute(href: string): string {
  return /^https?:\/\//i.test(href) ? href : `https://www.linkedin.com${href.startsWith('/') ? '' : '/'}${href}`;
}
