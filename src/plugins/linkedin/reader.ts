import { ToolError } from '../../errors';
import { PageActions } from './actions';
import { parseEntity, parsePost, type Entity, type Post } from './extract';
import { readEntitySources, readPostSources } from './dom';
import { normalizePostUrn, type FeedInput, type ReadPostInput, type SearchInput } from './schemas';

/**
 * Reads the page the member is already looking at. Every method works from rendered
 * output: no requests are made, and nothing is written to storage or kept between calls.
 */
export class PageReader {
  private actions: PageActions;

  constructor(private window: Window) {
    this.actions = new PageActions(window);
  }

  get gestures(): PageActions { return this.actions; }

  private posts(): Post[] {
    return readPostSources(this.actions.root()).map(parsePost).filter(post => post.text);
  }

  readFeed(input: FeedInput) {
    const expanded = input.expand ? this.actions.expandTruncated() : 0;
    const all = this.posts();
    if (!all.length) {
      throw new ToolError('NOTHING_RENDERED', 'No posts are rendered on this page yet. Wait for the feed to finish loading, or call linkedin_load_more to bring more into view.');
    }
    const filtered = input.only === 'all' ? all : all.filter(post => post.kind === input.only);
    return {
      posts: filtered.slice(0, input.limit),
      rendered: all.length,
      filtered_out: all.length - filtered.length,
      expanded,
      note: 'Read from what this tab has already rendered. Call linkedin_load_more for the next screenful, the same way a reader scrolls.',
    };
  }

  readPost(input: ReadPostInput) {
    if (input.expand) this.actions.expandTruncated();
    const posts = this.posts();
    if (input.expect) {
      const wanted = normalizePostUrn(input.expect);
      const id = wanted.split(':').at(-1)!;
      // LinkedIn pairs share and activity URNs for the same post, so compare the id.
      const match = posts.find(post => post.urn?.endsWith(id));
      if (!match) {
        throw new ToolError('WRONG_PAGE', `This tab is showing ${this.window.location.href}, which is not rendering ${wanted}. Open it with linkedin_open, wait for it to load, then read it.`, { expected: wanted, url: this.window.location.href });
      }
      return { post: match, note: NOTE };
    }
    const post = posts[0];
    if (!post) throw new ToolError('NOT_FOUND', 'No post is rendered on this page. Open a post with linkedin_open and wait for it to load.');
    return { post, note: NOTE };
  }

  private entities(kind: 'person' | 'company'): Entity[] {
    return readEntitySources(this.actions.root(), kind).map(parseEntity).filter(entity => entity.name);
  }

  readSearch(input: SearchInput) {
    const note = 'Read from the rendered search results. Open a different search with linkedin_open before reading other keywords.';
    const shape = (results: Post[] | Entity[], kind: string) => ({
      keywords: input.keywords, kind, results: results.slice(0, input.limit), rendered: results.length, note,
    });

    if (input.type === 'people') return shape(this.entities('person'), 'people');
    if (input.type === 'companies') return shape(this.entities('company'), 'companies');
    if (input.type === 'posts' || input.type === 'jobs') return shape(this.posts(), 'posts');

    // "all" does not say what the page is showing, so report whichever kind it rendered.
    const posts = this.posts();
    if (posts.length) return shape(posts, 'posts');
    const people = this.entities('person');
    if (people.length) return shape(people, 'people');
    return shape(this.entities('company'), 'companies');
  }

  /** What the extractor can see, for diagnosing a field that comes back null. */
  inspect() {
    const sources = readPostSources(this.actions.root());
    const loose = readPostSources(this.actions.root(), 0);
    return {
      url: this.window.location.href,
      cardsFound: sources.length,
      peopleFound: readEntitySources(this.actions.root(), 'person').length,
      companiesFound: readEntitySources(this.actions.root(), 'company').length,
      urnBearingElements: loose.length,
      firstCard: sources[0]
        ? { urn: sources[0].urn, textLength: sources[0].text.length, lines: sources[0].text.split('\n').filter(Boolean).length, controlLabels: sources[0].controlLabels.slice(0, 6), hasExternalUrl: !!sources[0].externalUrl }
        : null,
    };
  }
}

const NOTE = 'Only what LinkedIn has already rendered is included. Use linkedin_load_more to render more.';
