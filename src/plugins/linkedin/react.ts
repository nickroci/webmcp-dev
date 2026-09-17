/**
 * Access to what LinkedIn has already rendered, with no network calls of any kind.
 *
 * LinkedIn's flagship web app is React Server Components now: the Ember app and the
 * Voyager GraphQL calls it used to make are gone from the page, and so are the DOM
 * conventions built around them. What remains is that the data React drew from is
 * still attached to the nodes it drew — reachable from a rendered element's fiber.
 *
 * Reading it makes no request. It reads what the member's own page already received
 * and displayed, which is the only thing these tools are entitled to see.
 */
export interface FiberLike {
  memoizedProps?: unknown;
  return?: FiberLike | null;
  [key: string]: unknown;
}

const FIBER_PREFIX = '__reactFiber$';
const PROPS_PREFIX = '__reactProps$';

/** React suffixes these keys with a per-render id, so find them by prefix. */
export function fiberFromNode(node: object | null | undefined): FiberLike | null {
  if (!node) return null;
  for (const key of Object.keys(node)) {
    if (key.startsWith(FIBER_PREFIX)) return (node as Record<string, FiberLike>)[key] ?? null;
  }
  return null;
}

export function propsFromNode(node: object | null | undefined): unknown {
  if (!node) return null;
  for (const key of Object.keys(node)) {
    if (key.startsWith(PROPS_PREFIX)) return (node as Record<string, unknown>)[key];
  }
  return null;
}

/**
 * Props from a node and its ancestors, nearest first. Component names are minified,
 * so callers must match on the shape of the data rather than on a component or path.
 */
export function ascendProps(start: FiberLike | null, maxHops = 40): unknown[] {
  const found: unknown[] = [];
  let fiber = start;
  let hops = 0;
  while (fiber && hops < maxHops) {
    if (fiber.memoizedProps && typeof fiber.memoizedProps === 'object') found.push(fiber.memoizedProps);
    fiber = fiber.return ?? null;
    hops += 1;
  }
  return found;
}

/**
 * Rendered elements worth walking up from: blocks that carry their own visible text
 * rather than inheriting it from a child. These sit near the components holding a
 * post's data, which keeps the upward walk short.
 */
export function textBearingElements(root: Element, min = 40, max = 5000): Element[] {
  const blocks: Element[] = [];
  for (const element of root.querySelectorAll('*')) {
    const own = visibleText(element);
    if (own.length < min || own.length > max) continue;
    let dominatedByChild = false;
    for (const child of element.children) {
      if (visibleText(child).length > own.length * 0.85) { dominatedByChild = true; break; }
    }
    if (!dominatedByChild) blocks.push(element);
  }
  return blocks;
}

export function visibleText(element: Element): string {
  return ((element as HTMLElement).innerText ?? element.textContent ?? '').trim();
}
