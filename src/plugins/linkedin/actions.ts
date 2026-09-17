import { ToolError } from '../../errors';
import { visibleText } from './react';

/**
 * The gestures a person makes to see more of a page: expanding truncated text and
 * scrolling for the next batch. Each is one explicit step per call — nothing loops,
 * polls, or runs on a timer, so the page only ever advances because a tool was asked to.
 */
const MORE_LABEL = /^(?:\u2026|\.\.\.)?\s*(?:see|show|read)?\s*more$/i;
const GROWTH_TIMEOUT_MS = 4000;

export class PageActions {
  constructor(private window: Window) {}

  private get document(): Document { return this.window.document; }

  /** Click the "see more" controls LinkedIn renders on truncated posts. */
  expandTruncated(limit = 12): number {
    let clicked = 0;
    for (const button of this.document.querySelectorAll('button')) {
      if (clicked >= limit) break;
      const label = visibleText(button);
      if (!MORE_LABEL.test(label) && !MORE_LABEL.test(button.getAttribute('aria-label') ?? '')) continue;
      if (!(button as HTMLElement).offsetParent) continue;
      try { (button as HTMLElement).click(); clicked += 1; } catch { /* Not clickable; leave it truncated. */ }
    }
    return clicked;
  }

  /**
   * One scroll gesture to the foot of the list, then wait for the page to render more.
   *
   * Chrome pauses lazy-loading, IntersectionObserver callbacks and timers in a tab that
   * is not on screen, so a hidden tab never loads another page however it is scrolled.
   * That is reported rather than returned as "nothing more to show", which is what it
   * looks like from the outside.
   */
  async loadMore(signal?: AbortSignal): Promise<{ grew: boolean; heightBefore: number; heightAfter: number; visible: boolean }> {
    const scroller = this.scroller();
    const before = scroller.scrollHeight;
    if (this.document.visibilityState === 'hidden') {
      throw new ToolError('TAB_NOT_VISIBLE', 'This LinkedIn tab is in the background, and Chrome pauses lazy-loading there, so scrolling it cannot load more. Bring the tab to the front and call this again.', { visibility_state: this.document.visibilityState });
    }
    // Infinite scroll triggers at the foot of the list, not one viewport down.
    if (scroller === (this.document.scrollingElement ?? this.document.documentElement)) {
      this.window.scrollTo(0, before);
    } else {
      scroller.scrollTop = before;
    }
    const grew = await this.waitForGrowth(scroller, before, signal);
    return { grew, heightBefore: before, heightAfter: scroller.scrollHeight, visible: true };
  }

  /** The element that actually scrolls: overflow must allow it, not merely overflow. */
  private scroller(): Element {
    const main = this.document.querySelector('main');
    if (main && this.isScrollable(main)) return main;
    for (const element of this.document.querySelectorAll('div, section')) {
      if (this.isScrollable(element)) return element;
    }
    return this.document.scrollingElement ?? this.document.documentElement;
  }

  private isScrollable(element: Element): boolean {
    if (element.scrollHeight <= element.clientHeight + 20) return false;
    try { return /(auto|scroll)/.test(this.window.getComputedStyle(element).overflowY); }
    catch { return false; }
  }

  private waitForGrowth(scroller: Element, before: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise(resolve => {
      const started = Date.now();
      const tick = () => {
        if (signal?.aborted) { resolve(false); return; }
        if (scroller.scrollHeight > before) { resolve(true); return; }
        if (Date.now() - started > GROWTH_TIMEOUT_MS) { resolve(false); return; }
        this.window.setTimeout(tick, 250);
      };
      this.window.setTimeout(tick, 250);
    });
  }

  /** The element holding the rendered content; everything is read from inside it. */
  root(): Element {
    const main = this.document.querySelector('main');
    if (!main) throw new ToolError('PAGE_NOT_READY', 'This LinkedIn page has not rendered its main content yet. Wait for it to finish loading, or open the page again.');
    return main;
  }
}
