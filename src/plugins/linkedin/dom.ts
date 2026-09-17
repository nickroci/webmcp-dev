import { fiberFromNode } from './react';
import { urnInProps, type EntitySource, type PostSource } from './extract';

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

function absolute(href: string): string {
  return /^https?:\/\//i.test(href) ? href : `https://www.linkedin.com${href.startsWith('/') ? '' : '/'}${href}`;
}
