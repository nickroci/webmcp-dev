export const post = {
  kind: 't3',
  data: {
    id: 'abc123', name: 't3_abc123', subreddit: 'webdev', title: 'A test post <script>not HTML</script>', author: 'fixture_author',
    selftext: 'A **Markdown** post body with & <characters>.', url: 'https://www.reddit.com/r/webdev/comments/abc123/test/',
    permalink: '/r/webdev/comments/abc123/test/', is_self: true, score: 42, num_comments: 3, created_utc: 1700000000,
  },
};
export const listing = { kind: 'Listing', data: { children: [post], after: 't3_abc123', before: null } };
export const thread = [
  { kind: 'Listing', data: { children: [post] } },
  { kind: 'Listing', data: { children: [
    { kind: 't1', data: { id: 'c1', name: 't1_c1', parent_id: 't3_abc123', author: 'reader', body: 'First comment', score: 3, created_utc: 1700000001, replies: {
      kind: 'Listing', data: { children: [{ kind: 't1', data: { id: 'c2', name: 't1_c2', parent_id: 't1_c1', author: 'reply', body: 'Nested reply', score: 2, created_utc: 1700000002, replies: '' } }] },
    } } },
    { kind: 'more', data: { parent_id: 't3_abc123', count: 1, children: ['c3'] } },
  ] } },
];
export const me = { kind: 't2', data: { name: 'fixture_user', modhash: 'test-modhash-do-not-expose' } };
export const submitted = { json: { errors: [], data: { id: 'xyz789', name: 't3_xyz789', url: 'https://www.reddit.com/r/test/comments/xyz789/' } } };
export const replied = (parent_id = 't3_abc123') => ({ json: { errors: [], data: { things: [{ kind: 't1', data: {
  id: 'reply123', name: 't1_reply123', parent_id, link_id: 't3_abc123', author: 'fixture_user', body: 'Fixture reply',
} }] } } });
// What /api/comment actually returns: `id` is a fullname and the target is `parent`.
export const repliedFullname = (parent = 't3_abc123') => ({ json: { errors: [], data: { things: [{ kind: 't1', data: {
  id: 't1_reply123', name: 't1_reply123', parent, link_id: 't3_abc123', author: 'fixture_user', contentText: 'Fixture reply',
} }] } } });
export function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}
// /api/info.json listing for one thing, used by the delete guard.
export const info = (name = 't1_reply123', author = 'fixture_user') => ({
  kind: 'Listing', data: { children: [{ kind: name.startsWith('t3_') ? 't3' : 't1', data: { name, id: name.slice(3), author } }] },
});
