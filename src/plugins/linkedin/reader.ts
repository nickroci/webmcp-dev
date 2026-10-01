import { ToolError } from '../../errors';
import { PageActions } from './actions';
import { parseEntity, parseJob, parsePost, type Entity, type Job, type Post } from './extract';
import { readEntitySources, readJobBody, readJobSources, readPostSources } from './dom';
import { normalizeJobId, normalizePostUrn, type FeedInput, type JobsInput, type ReadJobInput, type ReadPostInput, type SearchInput } from './schemas';

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

  private jobs(): Job[] {
    return readJobSources(this.actions.root()).map(parseJob).filter(job => job.title);
  }

  readJobs(input: JobsInput) {
    const jobs = this.jobs();
    return { kind: 'jobs', results: jobs.slice(0, input.limit), rendered: jobs.length, note: NOTE };
  }

  /**
   * Jobs search is a split pane: the list on the left and the open job on the right.
   * Which job is open lives in the URL, so identity comes from there rather than from
   * whichever card happens to render first.
   */
  readJob(input: ReadJobInput) {
    const url = new URL(this.window.location.href);
    const open = url.searchParams.get('currentJobId') ?? decodeURIComponent(url.pathname).match(/\/jobs\/view\/([0-9]{4,20})/)?.[1] ?? null;
    if (!open) throw new ToolError('NOT_FOUND', 'This page is not showing a job. Open one with linkedin_open first.');
    if (input.expect && normalizeJobId(input.expect) !== open) {
      throw new ToolError('WRONG_PAGE', `This tab is showing job ${open}, not the one expected.`);
    }
    // Card and body are found by opposite rules. The card is a block that links to this
    // job; the body is the block that links to none. A jobs search renders both, and a
    // job on its own page renders only the body, so neither alone answers for both.
    const card = readJobSources(this.actions.root()).filter(source => source.id === open)
      .sort((a, b) => b.text.length - a.text.length)[0] ?? null;
    const body = readJobBody(this.actions.root(), card ? parseJob(card).title : null);
    if (!card && !body) throw new ToolError('NOTHING_RENDERED', 'The job is open but nothing is rendered yet. Wait, or call linkedin_load_more.');
    const summary = parseJob(card ?? { id: open, url: `https://www.linkedin.com/jobs/view/${open}/`, text: body! });
    return { job: { ...summary, description: body ?? card!.text }, note: NOTE };
  }

  readSearch(input: SearchInput) {
    const note = 'Read from the rendered search results. Open a different search with linkedin_open before reading other keywords.';
    const shape = (results: Post[] | Entity[], kind: string) => ({
      keywords: input.keywords, kind, results: results.slice(0, input.limit), rendered: results.length, note,
    });

    if (input.type === 'people') return shape(this.entities('person'), 'people');
    if (input.type === 'companies') return shape(this.entities('company'), 'companies');
    if (input.type === 'posts') return shape(this.posts(), 'posts');
    // Jobs were routed to the post extractor, which matches nothing on a jobs page, so a
    // jobs search reported an empty list of "posts" rather than saying it could not read.
    if (input.type === 'jobs') {
      const jobs = this.jobs();
      return { keywords: input.keywords, kind: 'jobs', results: jobs.slice(0, input.limit), rendered: jobs.length, note };
    }

    // "all" does not say what the page is showing, so report whichever kind it rendered.
    const posts = this.posts();
    if (posts.length) return shape(posts, 'posts');
    const people = this.entities('person');
    if (people.length) return shape(people, 'people');
    const companies = this.entities('company');
    if (companies.length) return shape(companies, 'companies');
    const jobs = this.jobs();
    return { keywords: input.keywords, kind: 'jobs', results: jobs.slice(0, input.limit), rendered: jobs.length, note };
  }

  /** What the extractor can see, for diagnosing a field that comes back null. */
  inspect() {
    const sources = readPostSources(this.actions.root());
    const jobSources = readJobSources(this.actions.root());
    const loose = readPostSources(this.actions.root(), 0);
    return {
      url: this.window.location.href,
      cardsFound: sources.length,
      peopleFound: readEntitySources(this.actions.root(), 'person').length,
      companiesFound: readEntitySources(this.actions.root(), 'company').length,
      jobsFound: jobSources.length,
      firstJob: jobSources[0] ? { id: jobSources[0].id, lines: jobSources[0].text.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 12) } : null,
      jobBody: (() => { const text = readJobBody(this.actions.root(), null); return text ? { length: text.length, lines: text.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 8) } : null; })(),
      urnBearingElements: loose.length,
      firstCard: sources[0]
        ? { urn: sources[0].urn, textLength: sources[0].text.length, lines: sources[0].text.split('\n').filter(Boolean).length, controlLabels: sources[0].controlLabels.slice(0, 6), hasExternalUrl: !!sources[0].externalUrl }
        : null,
    };
  }
}

const NOTE = 'Only what LinkedIn has already rendered is included. Use linkedin_load_more to render more.';
