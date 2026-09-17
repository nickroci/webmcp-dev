# Local MCP connection

WebMCP Dev includes a conventional stdio MCP server and a local background relay. Both are packaged in `dist/mcp/cli.js`. Chrome's extension worker connects out to the relay; the extension itself does not run a Node server.

```text
Codex / Claude Code / another local MCP client
  ↕ stdio MCP
WebMCP Dev adapter (one per agent session)
  ↕ authenticated WebSocket on 127.0.0.1
Local relay (shared background process)
  ↕ authenticated WebSocket
WebMCP Dev Chrome extension
  ↕ named tool call in a specific shared document
window.webMCPDev → enabled site plugins → real page/session
```

The browser connection stays on your computer. The bridge has no Firecrawl integration or external service dependency. Website requests still go to their normal destinations, and your chosen MCP client handles its own model connection.

## Setup

1. Run `npm ci && npm run build` in this project.
2. Load `dist/extension` in Chrome, or reload the existing unpacked extension. Refresh your Reddit tab afterward.
3. Configure your local MCP client below, verify the entry reports as connected with `claude mcp list` or `codex mcp list`, then start a new session or reconnect its MCP server. Tools load at session start.
4. Ask the agent to connect using WebMCP Dev. It calls `webmcp_request_connection`.
5. Open the extension on the website you want to share and press **Allow and share this tab** on the pending request. No copy/paste step is needed.

From this project directory:

```sh
codex mcp add webmcp-dev -- node "$PWD/dist/mcp/cli.js"
# Or:
claude mcp add --transport stdio --scope user webmcp-dev -- node "$PWD/dist/mcp/cli.js"
```

These use the clients' standard local MCP configuration: [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) and [Claude Code MCP](https://code.claude.com/docs/en/mcp). If `node` is not on your desktop application's PATH, use its absolute executable path from `node -p process.execPath` as the command.

For a client that uses JSON MCP configuration:

```json
{
  "mcpServers": {
    "webmcp-dev": {
      "command": "node",
      "args": ["/absolute/path/to/checkout/dist/mcp/cli.js"]
    }
  }
}
```

Replace the path if your checkout is elsewhere. Keep this checkout and its `node_modules` directory available; this is a developer package, not a standalone binary. Do not configure `npm run mcp` as the stdio command: npm's banner can pollute the MCP protocol stream. Call `node dist/mcp/cli.js` directly.

No terminal needs to stay open. A new MCP adapter starts the relay automatically if needed. Concurrent agents reuse it, while tab selection remains separate for each agent session. A machine restart stops it; a subsequent MCP connection starts it again. `npm run mcp:stop` stops the relay explicitly.

## Agent workflow

1. If no tab is shared, `webmcp_request_connection` creates a pending request. The client name comes from MCP initialization. The user approves or declines in the extension; the agent must not click the approval itself. Requests expire after five minutes and are withdrawn if the requesting MCP session disconnects. Poll the same tool with `{ "request_id": "<returned id>" }` to check its status.
2. `webmcp_list_tabs` lists only shared tabs, with keys that identify both browser profile and tab.
3. `webmcp_select_tab` selects one key for this MCP session. The result includes its available tools, and the server sends a tool-list-change notification.
4. Rediscover MCP tools. Site tools appear by their own names and input schemas.
5. Use navigation tools to put the relevant content on the visible page; use data tools to read it. Rediscover after navigation or call `webmcp_refresh_tools`.

For Reddit: browse `webdev` with `sort: "latest"`, list one post, open its ID with `reddit_open_post`, then read it. Listing and reading return JSON; the browse/open calls change the actual tab. Creating a post submits it through the signed-in session and returns its URL; open it afterward to show the result. To reply, call `reddit_reply` with the intended `t3_` post or `t1_` comment fullname as `parent_id`, Markdown `text`, and a unique `request_id`. Refresh the thread after a confirmed reply to show it. Reuse the request ID with identical inputs on retries; uncertain submissions must be inspected before any new attempt.

`webmcp_doctor` reports, for each shared tab, the plugin version that document is running against the version the extension installed, plus the selected tab, document ID, runtime version and tool count. A tab whose plugin version trails the installed one is running a document injected before the last rebuild; only opening the site in a new tab clears it. A tab that reports no version at all predates this diagnostic and needs the same treatment.

Clients that cache their initial tool list can use the always-present `webmcp_call_tool` fallback. Pass `{ "tool": "reddit_list_posts", "input": { "subreddit": "webdev", "sort": "latest", "limit": 1 } }`. Select or refresh returns the original page schemas in `data.tab.tools`; this fallback follows those schemas directly, including root arrays or scalar inputs. It routes through the same tab checks and execution path as directly exposed site tools. Selection belongs to the MCP session; reconnecting clears it.

## Sharing and execution

- Pairing persists per Chrome profile. Sharing uses Chrome session storage: it survives extension-worker restarts but ends on Chrome restart or extension reload.
- Sharing continues through navigation within the same origin. Leaving that origin, closing the tab, stopping sharing, or disconnecting revokes access. Share the tab again after moving to another origin, including `www.reddit.com` → `old.reddit.com`.
- All local MCP clients with this installation's credentials can see shared tabs and call their enabled tools. Pairing is not a separate approval for each agent session.
- Calls target Chrome document IDs and verify the expected URL before execution. A stale page fails instead of executing in a replacement document.
- One bridge tool call runs per tab at a time. Other calls return `TAB_BUSY`. Human interaction with the page remains available.
- Navigation acknowledgement recognizes both a replacement document and a URL change within the current document. It waits for page tools to be ready, any active Navigation API transition to finish, and updated tab metadata to reach the relay, with a 15-second timeout. `NAVIGATION_PENDING` means navigation started but the new page was not ready in that interval.
- Cancellation is forwarded to the plugin's AbortSignal. A handler must cooperate with cancellation, and a completed website action cannot be undone by aborting.
- Lost responses and disconnects never automatically replay actions. An `OUTCOME_UNKNOWN` result requires inspecting the page or account before retrying a mutation. Reddit posting additionally uses its existing request-ID tracking.

Page code and plugin output remain untrusted input for the agent. Plugins themselves are developer-installed code running in the site's main world; the site can inspect or alter that runtime. The bridge exposes registered plugin tools rather than an arbitrary JavaScript evaluation endpoint.

## Local state and troubleshooting

The extension discovers pending requests through a separate loopback `/pairing` WebSocket. That channel accepts extension origins, carries request metadata, and cannot list tabs or run tools. Only an approval decision sends browser credentials to the approving extension connection. The user must then share a specific tab; the approval button performs both steps together. Agent credentials never cross this channel.

The default relay endpoint is `ws://127.0.0.1:19375`. It binds only to loopback and accepts separate random credentials for extension and agent clients. Ordinary website origins are rejected. Tokens stay in the local state file and extension storage; they are not injected into page code.

Local state lives in `~/.webmcp-dev/`:

- `connection.json`: port and credentials, created with owner-only file permissions.
- `bridge.log`: startup errors from the background relay; tool arguments and page results are not logged.

`WEBMCP_STATE_DIR` selects a different state directory. `WEBMCP_PORT` selects the port when that directory's connection file is first created. Use the same environment settings for every MCP client. For a non-default port, set that port under **Agents → Advanced connection settings → Local bridge port**. The normal default needs no port configuration.

Legacy manual pairing remains available under **Advanced connection settings → Manual pairing**: run `npm run mcp:pair` and paste its output there. It is optional; agent-requested approval is the default flow.

| Symptom | Action |
| --- | --- |
| Agent has no `webmcp_*` tools | Register the MCP server, then start a new agent session or reconnect it. Confirm the entry with `claude mcp list` or `codex mcp list`. |
| Registered but not connected | Check the recorded command points at this checkout's built `dist/mcp/cli.js`. Re-register from the checkout, or use the absolute `node` path from `node -p process.execPath`. |
| No Agents panel | Rebuild and reload the extension from `dist/extension`. |
| Waiting for your local agent | Start or reconnect the configured local MCP client. |
| No request appears | Ask the agent to call `webmcp_request_connection`. Check that the extension and server use the same local port. |
| Background worker did not reply | Click **Reload extension** in the popup and reopen it. This handles updated popup files paired with an older running worker. |
| Pairing rejected | Request access again from the configured MCP client and approve in the extension. |
| No shared tabs | Ask the agent to request access, then approve on the intended site. If already connected, use **Share this tab**. Check the Chrome profile. |
| No site tools yet | Select a shared tab, then rediscover tools. Check that its plugin is enabled. |
| Tool list missing a newly built tool | Call `webmcp_doctor`: it compares the running plugin version with the installed one. The tab still runs the previously injected plugin, so reload the extension, then open the site in a new tab and share that one; same-document navigation does not re-inject. |
| Refresh this page / stale runtime | Refresh the website after an extension update. |
| Bridge disconnected | Restart the client's MCP connection. The adapter does not replay an interrupted request. |
| Port already occupied or incompatible relay | Check `bridge.log`. Stop the old bridge before upgrading, or choose another state directory and port. |
| Posting rejected | Read the [Reddit submission limitations](../src/plugins/reddit/README.md#submission-behavior-and-limits). |

After rebuilding bridge code, run `npm run mcp:stop` and reconnect your MCP client so the background process loads the new build. Reload the extension and refresh the site for extension/plugin changes.
