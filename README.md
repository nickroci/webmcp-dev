# WebMCP Dev: Add WebMCP to websites, starting with Reddit

[![CI](https://github.com/nickroci/webmcp-dev/actions/workflows/ci.yml/badge.svg)](https://github.com/nickroci/webmcp-dev/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**A Chrome extension that adds WebMCP to websites that don't natively support it.**

WebMCP Dev injects tools through site plugins. The included Reddit plugin lets agents browse subreddits, list and read posts, and publish posts using your existing signed-in tab. Add plugins to support other websites through the same extension.

A bundled local MCP server connects agents such as Codex and Claude Code to the tabs you choose to share. Navigation tools change the visible page, so you and your agent can work in the same browser tab.

Each plugin owns its tools and schemas. There is no central list of allowed tool types, site-specific popup, or switch statement to extend. The popup discovers tools at runtime and builds their input controls.

## Install in Chrome

Requires Node 22+ and Chrome/Chromium 120+. From the project directory, build the extension (skip this if `dist/extension` is already built):

```sh
git clone https://github.com/nickroci/webmcp-dev.git
cd webmcp-dev
npm ci
npm run build
```

1. In the **Chrome profile you use for Reddit**, open `chrome://extensions`.
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked** and select this project's **`dist/extension`** folder. Run `pwd` in the project directory to find its full path. On macOS, press **⌘⇧G** in the folder picker to paste a path.

4. Open or refresh an HTTPS Reddit page, such as `https://www.reddit.com/r/webdev/`.
5. Click Chrome's **puzzle-piece Extensions icon → WebMCP Dev** to open the tool popup. Use the pin icon to keep it on the toolbar.

**Already installed the earlier Reddit extension?** If it was loaded from this same folder, click its **reload ↻** button on `chrome://extensions` instead of loading another copy. It becomes **WebMCP Dev**. Refresh the Reddit tab afterward.

After future code or plugin changes, run `npm run build`, reload the same extension, and refresh the website tab. Loading it in one Chrome profile does not install it in your other profiles.

Open the popup on Reddit, choose a tool, enter its inputs, and run it. **Site plugins** lists supported sites and lets you enable or disable each plugin. Settings persist across tabs and browser restarts. **Publish post** immediately submits the supplied content as the account signed into that Reddit tab.

## Connect Codex or Claude Code locally

After building, reload the extension and refresh the Reddit tab. Pairing is initiated by the agent: there is no code to copy or terminal pairing command in the normal flow.

Register the MCP server with whichever local client you use. Run these from the project folder so `$PWD` resolves to this checkout:

```sh
# Codex
codex mcp add webmcp-dev -- node "$PWD/dist/mcp/cli.js"

# Claude Code
claude mcp add --transport stdio --scope user webmcp-dev -- node "$PWD/dist/mcp/cli.js"
```

Start a new agent session or reconnect its MCP server to load the tools. Then ask:

> Use WebMCP Dev. Request access to my Chrome tab, then open r/webdev sorted by latest, list one post, open it, and read it to me.

When the agent requests access with `webmcp_request_connection`, open **WebMCP Dev → Agents** on the intended Reddit tab and click **Allow and share this tab**. That single click connects the extension and shares this tab. The request shows the MCP client name and a short reference code, and expires after five minutes. Decline leaves the tab unshared.

The agent calls `webmcp_list_tabs`, then `webmcp_select_tab` with the returned tab key, then discovers the selected page's tools. `webmcp_refresh_tools` refreshes the selected page's metadata. Clients that cache their tool list can use the always-available `webmcp_call_tool` fallback with the discovered name and input. Site tools retain their names, such as `reddit_browse_subreddit`, `reddit_list_posts`, and `reddit_read_post`.

**You do not need to keep a terminal running.** The MCP client starts a local background relay automatically; multiple MCP sessions reuse it. Each agent chooses its own shared tab. Use `npm run mcp:stop` to stop the relay; starting a new MCP connection starts it again. Disconnect in the popup to remove pairing and revoke all shared tabs for that Chrome profile.

This uses the Chrome instance already open on this computer. No Firecrawl, hosted browser, remote debugging port, or browser launch flag is required. The MCP client and Chrome must run on the same machine. Native WebMCP is optional for this connection.

If the popup reports an outdated or missing background worker, use its **Reload extension** button and reopen the popup. **Advanced connection settings** holds a custom port setting and the optional legacy manual-pairing flow.

See [local connection details, manual config, and troubleshooting](docs/local-mcp.md).

## WebMCP for Reddit

| Reddit tool | Behavior |
| --- | --- |
| `reddit_browse_subreddit` | Open a subreddit with a selected sort. |
| `reddit_list_posts` | List posts by latest/new, hot, top, rising, or controversial; supports time windows and cursor pagination. |
| `reddit_open_post` | Open a post in the visible tab by URL or ID. |
| `reddit_read_post` | Read a post and bounded comments by URL or ID. |
| `reddit_create_post` | Publish a text or link post, including optional flair and flags. |

See [Reddit inputs and submission behavior](src/plugins/reddit/README.md). Live authenticated posting remains untested; browser tests mock all Reddit requests.

## Add a plugin

```sh
npm run plugin:new -- my-site example.com
# Implement tools in src/plugins/my-site/index.ts
npm run build
```

Reload the same extension in Chrome. New host permissions may require Chrome to grant access. No extra extension or page script installation is needed for each site.

```text
src/plugins/my-site/
  plugin.json   Identity, API version, and URL matches
  index.ts      Typed tool definitions and handlers
  README.md     Plugin-specific usage
```

Copy that entire folder to another WebMCP Dev checkout to reuse it. The build discovers plugin folders, validates their metadata, bundles one script per plugin, and generates Chrome permissions and the popup catalog. Support files can live alongside `index.ts`. Plugins use the single `@webmcp-dev/sdk` authoring import, resolved by this project; it is not a published npm package.

The [plugin authoring guide](docs/plugins.md) covers static and dynamic tools, input/output schemas, UI hints, subscriptions, cleanup, and errors. The [manifest schema](schemas/plugin.schema.json) enables editor completion and validation.

## Dynamic tool types

- Any tool name and handler, with typed, validated input schemas and optional output validation.
- Forms for strings, numbers, booleans, and enums; JSON editors for objects, arrays, nullable values, and unions. Full JSON mode handles more complex schemas.
- A fixed `tools` array or an async `tools()` factory that changes tools and schemas with page state.
- An optional `subscribe(refresh)` hook to notify the runtime when context changes; `dispose` and unsubscribe hooks for cleanup.
- Multiple plugins can coexist on a page. Names must be unique; failed updates preserve the previous working tools and report diagnostics.

Use **Refresh** to rediscover tools in the popup after the page changes. Outputs are displayed as JSON with text-safe rendering and a copy button.

## Page API and connection

```js
const dev = window.webMCPDev;
await dev.refreshTools();
dev.listPlugins();
dev.listTools();
await dev.callTool('reddit_list_posts', {
  subreddit: 'webdev', sort: 'latest', limit: 10,
});
```

Local calls return `{ ok: true, data }` or `{ ok: false, error: { code, message, details? } }`. Pass `{ signal }` as a third argument to cancel execution. The `window.webMCPDev` API and old `window.redditWebMCP` alias remain available for compatibility.

```text
Plugin folder → build → one extension
                         ├─ service worker: match site + inject enabled plugins
                         ├─ shared popup: discover schemas + run tools
                         └─ page runtime: window.webMCPDev
                                           └─ native WebMCP when available
```

The runtime registers with the current `document.modelContext` API, with support for the older `navigator.modelContext` surface. Native availability depends on the Chrome version and configuration. The popup and page API work locally without native support and expose registration failures in diagnostics.

The bundled stdio MCP server exposes the same plugin registry to local agents through an authenticated loopback WebSocket connection. Shared tabs advertise their current tools automatically; the server sends MCP tool-list-change notifications when the selection or tool definitions change. The popup and native WebMCP path continue to work independently.

Plugin code is bundled locally. It runs in the page's main world, with that page's session and origin permissions; plugins are trusted code, not isolated from each other or the website. Extension APIs stay in the extension context. Remote executable plugin downloads are not implemented, consistent with [Chrome's Manifest V3 code packaging requirements](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code).

## Outputs and checks

- `dist/mcp/cli.js`: local stdio MCP server, pairing command, and background relay.
- `dist/extension/`: load this one extension.
- `dist/extension/plugins/*.js`: self-contained, compiled site plugin bundles.
- `dist/index.js`, `dist/sdk.js`, `dist/types/`: library, authoring SDK, and TypeScript declarations.
- `dist/reddit-webmcp.js`: standalone Reddit injection bundle for existing integrations.

```sh
npm run check
# If Chromium is not installed:
npx playwright install chromium
```

The suite covers Reddit behavior, schema validation, dynamic discovery, cancellation, name conflicts, two independently bundled plugins, generated popup forms, persistent enable/disable, and navigation. The end-to-end MCP test uses a real stdio MCP client, local relay, and built Chrome extension, including visible navigation, dynamic tool discovery, and sharing revocation. All browser test site requests use fixtures. Native WebMCP registration is tested against a stub of the [current imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api), not a live experimental browser configuration.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and pull request guidance.

## License

[MIT](LICENSE) © 2026 nickroci.
