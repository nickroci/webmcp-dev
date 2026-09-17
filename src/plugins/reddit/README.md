# Reddit plugin

API v1 site plugin bundled with [WebMCP Dev](../../../README.md). Use the shared extension popup or the compatible `window.redditWebMCP` page API.

## Tools

| Tool | Inputs | Behavior |
| --- | --- | --- |
| `reddit_browse_subreddit` | `subreddit`, optional `sort`, `time` | Navigates the current tab. Wait for navigation before calling another tool. |
| `reddit_list_posts` | `subreddit`, optional `sort`, `time`, `limit`, `after` | Returns posts, full Markdown bodies, and pagination cursors without navigating. |
| `reddit_open_post` | `post` | Opens the post in the visible tab. |
| `reddit_read_post` | `post`, optional `comment_sort`, `comment_limit`, `comment_depth` | Returns the post and flattened comments with `parent_id` and `depth`. |
| `reddit_create_post` | `subreddit`, `title`, `request_id`, optional `kind`, `text`, `url`, `flair_id`, `flair_text`, `nsfw`, `spoiler`, `send_replies` | Publishes a text or link post and returns its ID and URL. |

Post sorts: `new` (default), `latest` (alias for `new`), `hot`, `top`, `rising`, `controversial`. Time windows: `hour`, `day`, `week`, `month`, `year`, `all` (default); used only for `top` and `controversial`. List limits: 1–100, default 25.

Subreddits can be supplied as `webdev`, `r/webdev`, or an HTTPS Reddit subreddit URL. Posts accept a base36 ID, `t3_` fullname, full `/comments/` URL, or `https://redd.it/ID`. Reddit `/s/` share links must first be resolved to a full post URL.

Comments default to `best`, 25 comments total, and depth 3. Other sorts: `top`, `new`, `old`, `controversial`, `qa`. Set `comment_limit: 0` for just the post. The result reports `comments_truncated` and `more_comments`; this version does not expand unloaded comments.

For a shared browsing workflow, call `reddit_browse_subreddit` before listing and `reddit_open_post` before reading. These navigation tools change the visible page; list/read return structured data. Publishing submits through the current session and returns a post URL; use `reddit_open_post` afterward to show the result. The local MCP bridge recognizes both full page loads and URL changes within the current document, and refreshes the shared tools before returning. Direct page callers must wait for navigation and reacquire the runtime if the document was replaced.

## Call from the page

With the extension loaded, run these in the Reddit tab’s DevTools console, or use the equivalent main-world script execution capability in your browser agent:

```js
await window.redditWebMCP.ready;
window.redditWebMCP.status();
window.redditWebMCP.listTools();

const first = await window.redditWebMCP.callTool('reddit_list_posts', {
  subreddit: 'webdev', sort: 'latest', limit: 10,
});

if (first.ok && first.data.next_after) {
  const next = await window.redditWebMCP.callTool('reddit_list_posts', {
    subreddit: 'webdev', sort: 'latest', limit: 10,
    after: first.data.next_after,
  });
}

// Read one of the returned posts.
if (first.ok && first.data.posts.length) {
  const post = await window.redditWebMCP.callTool('reddit_read_post', {
    post: first.data.posts[0].permalink,
    comment_sort: 'new', comment_limit: 10,
  });
}
```

Navigation can replace the document or be handled within it by the site. A direct page API acknowledgement confirms that navigation was started, not that the destination loaded successfully:

```js
await window.redditWebMCP.callTool('reddit_browse_subreddit', {
  subreddit: 'javascript', sort: 'top', time: 'week',
});
// Wait for navigation; reacquire window.redditWebMCP if the document was replaced.
```

The following **publishes a real post** when run in a supported signed-in session. Replace the content and community with the intended destination:

```js
const requestId = crypto.randomUUID(); // Save this; reuse it if the call is interrupted.
await window.redditWebMCP.callTool('reddit_create_post', {
  subreddit: 'your_community',
  title: 'Your intended title',
  kind: 'text',
  text: 'Your intended Markdown body.',
  request_id: requestId,
});
// Link variant: kind: 'link', url: 'https://example.com', and omit text.
```

All local calls return `{ ok: true, data: ... }` or `{ ok: false, error: { code, message, details? } }`. Inputs are validated even when called directly. Calls accept `{ signal }` as an optional third argument for cancellation.

## Submission behavior and limits

- A signed-in session that exposes Reddit’s legacy modhash is required for posting. When unavailable, the tool returns `SESSION_UNSUPPORTED`; try `old.reddit.com` while signed in. This version has no OAuth fallback.
- Reddit can reject requests because of community restrictions, required flair, CAPTCHA, login, API access restrictions, or rate limits. Errors are returned to the caller; this library does not bypass them.
- Supply any required flair UUID through `flair_id`. Automatic flair discovery is not implemented.
- Reusing `request_id` with identical normalized inputs returns a completed result or waits for its in-flight request. Reusing it for different content is rejected. Tracking is limited to the current tab/origin and session storage; it is **not** a Reddit server-side idempotency guarantee across tabs, origins, or cleared storage.
- A failed POST transport, malformed success response, or interrupted submission returns `SUBMISSION_UNCERTAIN`. The same ID cannot resubmit. Check the user’s profile before deciding whether a new submission is necessary. No mutation is automatically retried.
- Explicit Reddit validation errors allow a corrected retry. Posting success means Reddit accepted a submission; it does not guarantee moderators made it publicly visible.
- The popup retains its request ID for identical inputs while it stays open. After closing it, inspect the profile before retrying an interrupted submission.
- Native annotations mark posting as consequential and Reddit content as untrusted. Those hints do not enforce consent or protect an external agent by themselves; the caller remains responsible for acting on the user’s request.


See the [Reddit API reference](https://www.reddit.com/dev/api/) for endpoint behavior. Live authenticated posting has not been tested; browser tests intercept all Reddit requests.
