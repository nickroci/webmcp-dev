import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePost, parseEntity, parseCount, urnInProps, POST_URN, type PostSource } from '../src/plugins/linkedin/extract';
import { fiberFromNode, propsFromNode, ascendProps } from '../src/plugins/linkedin/react';
import { feedSchema, searchSchema, readPostSchema, normalizePostUrn, normalizeProfile, searchPath } from '../src/plugins/linkedin/schemas';

const SHARE = 'urn:li:share:7506001468462817280';
const ACTIVITY = 'urn:li:activity:7100000000000000001';

/** The exact line structure a live LinkedIn feed card renders. */
const liveCard: PostSource = {
  urn: SHARE,
  text: [
    'Feed post', 'DAIR.AI', '1d',
    'Banger paper from Google Research.',
    'This one is on how LLM assistants reason about the people in a user’s life.',
    '12 reposts', '12 reposts',
    'Like', 'Comment', 'Repost', 'Send',
  ].join('\n'),
  controlLabels: ['Open control menu for post by DAIR.AI', 'Hide post by DAIR.AI', '… more', 'Reaction button state: no reaction'],
  externalUrl: null,
};

test('parses a live feed card into author, age, body and counts', () => {
  const post = parsePost(liveCard);
  assert.equal(post.author, 'DAIR.AI');
  assert.equal(post.posted, '1d');
  assert.equal(post.text, 'Banger paper from Google Research.\nThis one is on how LLM assistants reason about the people in a user’s life.');
  assert.equal(post.reposts, 12);
  assert.equal(post.urn, SHARE);
  assert.equal(post.permalink, `https://www.linkedin.com/feed/update/${SHARE}/`);
  assert.equal(post.kind, 'text');
  assert.ok(!post.text!.includes('Feed post'), 'the card marker is not body text');
  assert.ok(!post.text!.includes('Like'), 'the action bar is not body text');
  assert.ok(!post.text!.includes('12 reposts'), 'counts are not body text');
});

test('notices the "… more" control, which is how LinkedIn labels truncation', () => {
  assert.equal(parsePost(liveCard).truncated, true);
  assert.equal(parsePost({ ...liveCard, controlLabels: [], text: 'Someone\n2h\nA short complete post.' }).truncated, false);
});

test('keeps the author\'s headline and the bare reaction total out of the body', () => {
  const post = parsePost({
    urn: SHARE,
    text: [
      'Feed post', 'Adil Ashfaq',
      'Crypto Marketing Leader | Top 30 Fintech Voice on LinkedIn',
      '1d',
      'One blockchain holds more RWA value than the other nine combined.',
      '180', '77 comments', 'Like', 'Comment',
    ].join('\n'),
    controlLabels: ['Open control menu for post by Adil Ashfaq'],
    externalUrl: null,
  });
  assert.equal(post.author, 'Adil Ashfaq');
  assert.equal(post.text, 'One blockchain holds more RWA value than the other nine combined.');
  assert.equal(post.reactions, 180, 'a naked number beside the action bar is the reaction total');
  assert.equal(post.comments, 77);
  assert.ok(!post.text!.includes('Fintech Voice'), 'the headline is chrome, not the post');
});

test('reads "4m" as four months old, not four million reactions', () => {
  const post = parsePost({
    urn: SHARE,
    text: ['Ali Imran', 'Founder & CEO | Full Stack Developer', '4m', 'Is AI getting too smart?'].join('\n'),
    controlLabels: ['Open control menu for post by Ali Imran'],
    externalUrl: null,
  });
  assert.equal(post.posted, '4m');
  assert.equal(post.reactions, null, 'an age must never be counted as a reaction total');
  assert.equal(post.text, 'Is AI getting too smart?', 'and the headline stays out of the body');
});

test('recognises an edited post\'s timestamp, which carries a trailing qualifier', () => {
  const post = parsePost({
    urn: SHARE,
    text: ['Chris Moreno-Stokoe', 'Leading GenAI Teams since 2022 | Consultant', '6m \u2022 Edited', 'The actual announcement.'].join('\n'),
    controlLabels: ['Open control menu for post by Chris Moreno-Stokoe'],
    externalUrl: null,
  });
  assert.equal(post.posted, '6m \u2022 Edited');
  assert.equal(post.text, 'The actual announcement.', 'the headline must not survive as body text');
});

test('still reads a card that renders no timestamp', () => {
  const post = parsePost({ urn: SHARE, text: 'Someone\nA body with no age line.', controlLabels: [], externalUrl: null });
  assert.equal(post.author, 'Someone');
  assert.equal(post.text, 'A body with no age line.');
});

test('never turns a paragraph into the author when a card has no timestamp', () => {
  const paragraph = 'The last 25 years have shown what is possible when innovation is put to work for the people who need it most.';
  const post = parsePost({ urn: SHARE, text: `${paragraph}\nBut this progress is fragile.`, controlLabels: [], externalUrl: null });
  assert.equal(post.author, null, 'a sentence is not a display name');
  assert.ok(post.text!.startsWith('The last 25 years'), 'and it stays in the body where it belongs');
});

test('keeps LinkedIn\'s connection chrome out of the author\'s words', () => {
  const post = parsePost({ ...liveCard, text: [
    'Feed post', 'Followed by Manisha Thakur \u2022 2nd', 'DAIR.AI', '1d',
    'The actual post body.', 'Dara Roberts likes this', '2 reposts', 'Like',
  ].join('\n') });
  assert.equal(post.text, 'The actual post body.');
  assert.equal(post.posted, '1d');
  assert.equal(post.reposts, 2);
});

test('falls back to the first line when no control label names the author', () => {
  const post = parsePost({ ...liveCard, controlLabels: [] });
  assert.equal(post.author, 'DAIR.AI', 'the line before the timestamp is the author');
  assert.ok(!post.text!.startsWith('DAIR.AI'));
});

test('reads abbreviated counts the way LinkedIn writes them', () => {
  assert.equal(parseCount('1,234'), 1234);
  assert.equal(parseCount('12K'), 12000);
  assert.equal(parseCount('1.2M'), 1200000);
  assert.equal(parseCount('nonsense'), 0);
  const post = parsePost({ ...liveCard, text: 'X\n1d\nBody here.\n1,204 reactions\n38 comments\n12K reposts' });
  assert.equal(post.reactions, 1204);
  assert.equal(post.comments, 38);
  assert.equal(post.reposts, 12000);
});

test('classifies an outbound article by the link found in the card', () => {
  const article = parsePost({ ...liveCard, externalUrl: 'https://example.com/paper' });
  assert.equal(article.kind, 'article');
  assert.equal(article.link, 'https://example.com/paper');
  assert.equal(parsePost(liveCard).kind, 'text');
});

test('takes a post URN from props but never a comment URN that embeds one', () => {
  assert.equal(urnInProps({ value: `reactionState-${ACTIVITY}` }), ACTIVITY, 'state keys carry the identity');
  assert.equal(urnInProps({ nested: { deep: { id: SHARE } } }), SHARE);
  // A comment URN contains its parent activity; matching inside it mislabels every comment.
  assert.equal(urnInProps({ id: 'urn:li:comment:(urn:li:activity:7100000000000000001,72)' }), null);
  assert.equal(urnInProps({ nothing: 'here' }), null);
  assert.match(SHARE, POST_URN);
});

test('survives the objects React leaves in the props graph', () => {
  // A cross-origin frame throws on property access; a real read hit exactly this.
  const crossOrigin = new Proxy({}, { ownKeys() { throw new Error('SecurityError: blocked a frame'); } });
  assert.doesNotThrow(() => urnInProps({ frame: crossOrigin, id: SHARE }));
  assert.equal(urnInProps({ frame: crossOrigin, id: SHARE }), SHARE, 'one unreadable branch does not lose the read');
  const selfRef: any = {}; selfRef.self = selfRef;
  assert.equal(urnInProps({ win: selfRef }), null);
  assert.doesNotThrow(() => urnInProps({ node: { nodeType: 1, id: SHARE } }));
});

test('reaches React internals by prefix, since the suffix changes per render', () => {
  const fiber = { memoizedProps: { a: 1 }, return: { memoizedProps: { b: 2 }, return: null } };
  const node = { __reactFiber$k3n9x: fiber, __reactProps$k3n9x: { c: 3 }, nodeName: 'DIV' };
  assert.equal(fiberFromNode(node), fiber);
  assert.deepEqual(propsFromNode(node), { c: 3 });
  assert.deepEqual(ascendProps(fiberFromNode(node)), [{ a: 1 }, { b: 2 }]);
  assert.equal(fiberFromNode({ nodeName: 'DIV' }), null);
  assert.deepEqual(ascendProps(null), []);
  let deep: any = null;
  for (let i = 0; i < 100; i++) deep = { memoizedProps: { i }, return: deep };
  assert.equal(ascendProps(deep, 5).length, 5, 'the walk stops rather than reaching the root');
});

test('parses a person result, with the degree on the name line or its own', () => {
  const inline = parseEntity({ kind: 'person', url: 'https://www.linkedin.com/in/aaron-spittles/', text: [
    'Aaron Spittles \u2022 2nd',
    'Head of Application Engineering at Pirum',
    'London, England, United Kingdom',
    'Ben Challice, Justin J. Lawson & 1 other mutual connection',
  ].join('\n') });
  assert.equal(inline.name, 'Aaron Spittles');
  assert.equal(inline.degree, '2nd');
  assert.equal(inline.headline, 'Head of Application Engineering at Pirum');
  assert.equal(inline.location, 'London, England, United Kingdom');
  assert.match(inline.detail!, /mutual connection/);

  const stacked = parseEntity({ kind: 'person', url: 'https://www.linkedin.com/in/lewis/', text: [
    'Lewis Nicholson', '\u2022 2nd', 'Client Services Team Leader at Pirum Systems Ltd', 'London, England, United Kingdom',
  ].join('\n') });
  assert.equal(stacked.name, 'Lewis Nicholson', 'the degree line is not the name');
  assert.equal(stacked.degree, '2nd');
  assert.equal(stacked.headline, 'Client Services Team Leader at Pirum Systems Ltd');
});

test('parses a company result, dropping the Follow control', () => {
  const company = parseEntity({ kind: 'company', url: 'https://www.linkedin.com/company/gopirum.com/', text: [
    'Pirum', 'International Trade and Development', 'Seattle', 'Follow',
    'A Seattle based international trade company founded on September 2014.', '38 followers',
  ].join('\n') });
  assert.equal(company.name, 'Pirum');
  assert.equal(company.headline, 'International Trade and Development');
  assert.equal(company.location, 'Seattle');
  assert.equal(company.followers, 38);
  assert.match(company.detail!, /Seattle based international trade/);
  assert.ok(!JSON.stringify(company).includes('"Follow"'), 'a button label is not card content');
});

test('caps reads at what a person could take in on screen', () => {
  assert.equal(feedSchema.parse({}).limit, 10);
  assert.equal(feedSchema.parse({}).expand, true);
  assert.throws(() => feedSchema.parse({ limit: 50 }), 'no bulk collection through limit');
  assert.throws(() => searchSchema.parse({ keywords: 'x', limit: 26 }));
  assert.throws(() => readPostSchema.parse({ comment_limit: 51 }));
});

test('normalizes every accepted post identifier and rejects the rest', () => {
  for (const input of [
    ACTIVITY, '7100000000000000001',
    'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000001/',
    'https://www.linkedin.com/posts/ada-lovelace_engine-activity-7100000000000000001-Ab1c/',
  ]) assert.equal(normalizePostUrn(input), ACTIVITY, input);
  assert.equal(normalizePostUrn('urn:li:ugcPost:7100000000000000001'), 'urn:li:ugcPost:7100000000000000001');
  for (const input of ['urn:li:person:123', 'https://evil.test/feed/update/urn:li:activity:1', 'https://www.linkedin.com/in/ada/', 'https://www.linkedin.com@evil.test/x']) {
    assert.throws(() => normalizePostUrn(input), input);
  }
});

test('normalizes profiles and builds search paths', () => {
  for (const input of ['ada-lovelace', '/in/ada-lovelace/', 'https://www.linkedin.com/in/ada-lovelace/']) {
    assert.equal(normalizeProfile(input), 'ada-lovelace');
  }
  assert.throws(() => normalizeProfile('https://evil.test/in/ada'));
  assert.equal(searchPath({ keywords: 'a b', type: 'people' }), '/search/results/people/?keywords=a%20b');
  assert.equal(searchPath({ keywords: 'ai', type: 'all' }), '/search/results/all/?keywords=ai', 'the all search needs its own segment');
  assert.equal(searchPath({ keywords: 'ai', type: 'posts' }), '/search/results/content/?keywords=ai');
  assert.equal(searchPath({ keywords: 'x', type: 'jobs' }), '/jobs/search/?keywords=x');
});
