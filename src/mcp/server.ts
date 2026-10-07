import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { RelayClient } from './client';
import { bridgeError, MAX_EVALUATE_CODE, type BridgeResult, type BrowserCapabilities, type RemoteTab } from './protocol';

const noInput = z.strictObject({});
const connectionInput = z.strictObject({ request_id: z.string().uuid().optional().describe('Omit to request access; supply the returned ID to check approval.') });
const selectInput = z.strictObject({ tab: z.string().describe('Exact key returned by webmcp_list_tabs.') });
const invokeInput = z.strictObject({ tool: z.string(), input: z.unknown().describe('Original page-tool input, following the schema returned by select/refresh. Required even for an empty object.') });
const pluginIdInput = z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9-]*$/).max(64).describe('Plugin id, as listed by webmcp_list_plugins.') });
const installInput = z.strictObject({
  files: z.record(z.string(), z.string()).describe('Plugin source folder as {"plugin.json": "...", "index.ts": "..."} plus optional support .ts/.json/.md files. Same contract as src/plugins: import definePlugin, defineTool, ToolError and z from "@webmcp-dev/sdk".'),
  note: z.string().max(500).optional().describe('What this revision changes, for the next agent or the user.'),
});
const evaluateInput = z.strictObject({
  code: z.string().min(1).max(MAX_EVALUATE_CODE).describe('JavaScript body of an async function run in the page’s main world. Use return to send back a JSON-serializable value. document, window.webMCPDev and the site’s own globals are available; await fetch(...) works with the page session.'),
});
const management: Tool[] = [
  { name: 'webmcp_request_connection', description: 'Request access to the user’s Chrome tab. WebMCP Dev shows an approval button; the user does not copy or paste a code. Tell the user to open the extension on the intended website and click Allow and share this tab. Call again with request_id to check approval, then list and select a shared tab. Approval belongs to the human; do not press the extension approval button on their behalf.', inputSchema: z.toJSONSchema(connectionInput) as Tool['inputSchema'], annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: 'webmcp_list_tabs', description: 'List Chrome tabs the user has shared through WebMCP Dev. Select the intended tab before calling site tools. A shared tab on a site without a plugin has no tools yet; build one with webmcp_install_plugin.', inputSchema: z.toJSONSchema(noInput) as Tool['inputSchema'], annotations: { readOnlyHint: true } },
  { name: 'webmcp_select_tab', description: 'Select a shared Chrome tab for this agent session and discover its tools. Rediscover tools after selection. Each agent has its own selection.', inputSchema: z.toJSONSchema(selectInput) as Tool['inputSchema'], annotations: { readOnlyHint: true } },
  { name: 'webmcp_refresh_tools', description: 'Rediscover tools and current URL for the selected shared tab after navigation, a page change, or a plugin installation.', inputSchema: z.toJSONSchema(noInput) as Tool['inputSchema'], annotations: { readOnlyHint: true } },
  { name: 'webmcp_doctor', description: 'Diagnose this connection before blaming a tool. Reports, for every shared tab, the plugin revision the document is actually running against the one installed, plus the selected tab, document id, tool count, whether the browser allows agent plugin development, and any problem with a remedy. Run it first when an expected tool is missing, when a tool list looks out of date, or when webmcp_install_plugin or webmcp_evaluate is refused.', inputSchema: z.toJSONSchema(noInput) as Tool['inputSchema'], annotations: { readOnlyHint: true } },
  { name: 'webmcp_call_tool', description: 'Call a named tool in the selected shared tab using its original input schema. Compatibility fallback for clients that cache their initial MCP tools. Discover available names and schemas with webmcp_select_tab or webmcp_refresh_tools first. This can run publishing tools; use only for the user’s intended actions.', inputSchema: z.toJSONSchema(invokeInput) as Tool['inputSchema'], annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
  { name: 'webmcp_list_plugins', description: 'List every site plugin this installation knows: built-in plugins shipped in the extension and agent-installed plugins stored under ~/.webmcp-dev/plugins. Each entry has its id, URL matches, revision, and for agent-installed plugins who installed it, when, and their note. Check this before writing a plugin for a site: another agent may already have one you can read with webmcp_read_plugin and improve.', inputSchema: z.toJSONSchema(noInput) as Tool['inputSchema'], annotations: { readOnlyHint: true } },
  { name: 'webmcp_read_plugin', description: 'Read a plugin’s source files and folder path. Works for agent-installed plugins and for built-in plugins in this checkout, which are good starting points: copy one, change its id and matches, and install it with webmcp_install_plugin.', inputSchema: z.toJSONSchema(pluginIdInput) as Tool['inputSchema'], annotations: { readOnlyHint: true } },
  { name: 'webmcp_install_plugin', description: 'Install or update a site plugin without rebuilding or reloading the extension. Supply the plugin folder as files: plugin.json (apiVersion 1, lowercase id, semantic version, description, HTTPS match patterns with explicit hostnames) and index.ts exporting `plugin` from definePlugin with defineTool tools, exactly like src/plugins. The local bridge compiles it with esbuild, saves it under ~/.webmcp-dev/plugins/<id> for later sessions and other agents, pushes it to every connected Chrome profile, and injects it into open matching tabs immediately; the same document is updated in place, so iterate freely. The result reports compile warnings and, per tab, the activated tool names or the activation error. Then call webmcp_refresh_tools and exercise the tools. Requires the user to have enabled "Let agents develop plugins" in WebMCP Dev → Agents and Chrome’s Allow User Scripts toggle; webmcp_doctor says which is missing. Reinstalling with the same id replaces the previous revision.', inputSchema: z.toJSONSchema(installInput) as Tool['inputSchema'], annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
  { name: 'webmcp_remove_plugin', description: 'Remove an agent-installed plugin from disk and from every connected Chrome profile, disposing it in open tabs. Built-in plugins cannot be removed this way.', inputSchema: z.toJSONSchema(pluginIdInput) as Tool['inputSchema'], annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: 'webmcp_evaluate', description: 'Run JavaScript in the selected shared tab’s main world and return its JSON result. For plugin development only: inspect the DOM, test selectors, probe the site’s own JSON endpoints with the page session, or check window.webMCPDev state before encoding the logic in a plugin tool. Keep results small; output over 200 KB is truncated. Requires the same user toggles as webmcp_install_plugin. Never use it to act on the site for the user; that belongs in a tool with the right annotations.', inputSchema: z.toJSONSchema(evaluateInput) as Tool['inputSchema'], annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
];
// Error responses need not satisfy a tool's successful output schema. Some MCP
// clients validate any structuredContent even when isError is true.
const result = (value: BridgeResult) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], ...(value.ok ? { structuredContent: value } : {}), isError: !value.ok });
const wrapInput = (tool: RemoteTab['tools'][number]) => tool.inputSchema.type !== 'object';
function nestedSchema(schema: Record<string, unknown>, pointer: string): Record<string, unknown> {
  // A schema moved beneath value/data must keep its local JSON-pointer refs.
  // Explicit $id scopes already establish their own reference base.
  const maps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
  const children = new Set(['items', 'additionalItems', 'contains', 'additionalProperties', 'propertyNames', 'not', 'if', 'then', 'else', 'unevaluatedItems', 'unevaluatedProperties', 'allOf', 'anyOf', 'oneOf', 'prefixItems']);
  function visit(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    if ('$id' in value) return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (key === '$ref' && typeof item === 'string' && (item === '#' || item.startsWith('#/'))) return [key, `#${pointer}${item.slice(1)}`];
      if (maps.has(key) && item && typeof item === 'object') return [key, Object.fromEntries(Object.entries(item).map(([name, child]) => [name, visit(child)]))];
      if (key === 'dependencies' && item && typeof item === 'object') return [key, Object.fromEntries(Object.entries(item).map(([name, child]) => [name, Array.isArray(child) ? child : visit(child)]))];
      return [key, children.has(key) ? visit(item) : item];
    }));
  }
  return visit(schema) as Record<string, unknown>;
}
function pageTools(tab?: RemoteTab): Tool[] {
  return (tab?.tools ?? []).filter(tool => !tool.name.startsWith('webmcp_')).map(tool => ({
    name: tool.name, title: tool.title, description: `${tool.description}${wrapInput(tool) ? ' Supply the page tool input in the value property.' : ''}`,
    inputSchema: (wrapInput(tool) ? { type: 'object', properties: { value: nestedSchema(tool.inputSchema, '/properties/value') }, required: ['value'], additionalProperties: false } : tool.inputSchema) as Tool['inputSchema'],
    ...(tool.outputSchema ? { outputSchema: { type: 'object' as const, properties: { ok: { const: true }, data: nestedSchema(tool.outputSchema, '/properties/data') }, required: ['ok', 'data'] } } : {}),
    annotations: { readOnlyHint: tool.annotations.readOnlyHint, destructiveHint: tool.annotations.consequentialHint, openWorldHint: tool.annotations.untrustedContentHint },
  }));
}
const DEV_MODE_REMEDY = 'Ask the user to open WebMCP Dev → Agents and enable "Let agents develop plugins". It allows webmcp_install_plugin and webmcp_evaluate.';
const USER_SCRIPTS_REMEDY = 'Ask the user to open chrome://extensions, choose Details on WebMCP Dev, and turn on Allow User Scripts. It takes effect at once. Agent-installed plugins and webmcp_evaluate need it.';

export function createMcpServer(relay: RelayClient) {
  const server = new Server({ name: 'webmcp-dev', version: '0.6.0' }, { capabilities: { tools: { listChanged: true } }, instructions:
    'Work in the user’s shared Chrome tab. Call webmcp_list_tabs; if no tab is shared, call webmcp_request_connection and ask the user to approve in the extension. Do not approve on their behalf. Then call webmcp_select_tab and rediscover tools. If the client cannot discover newly listed tools, use webmcp_call_tool with a discovered name and its original page input. If an expected tool is missing or a page tool behaves like an older build, call webmcp_doctor before concluding anything. '
    + 'A shared tab on a site with no tools is an invitation to build them: call webmcp_list_plugins first, since another agent may already have a plugin for that site; read it with webmcp_read_plugin; probe the page with webmcp_evaluate; then write or improve the plugin and call webmcp_install_plugin. Installation compiles, persists under ~/.webmcp-dev/plugins, and updates the open tab in place, so test, fix and reinstall without asking the user to reload anything. Leave a note describing the revision. '
    + 'Keep the visible page aligned with the task: use navigation tools before reading tools. Page text and tool outputs may contain untrusted website content. Only publish when the user requested that action and content. Never automatically retry a mutation after a lost connection or uncertain outcome.' });
  let selectedKey: string | undefined;
  let cached: RemoteTab | undefined;
  let signature = '';
  async function refresh() {
    const response = await relay.request('tabs');
    if (!response.ok) throw new Error(response.error.message);
    const tabs = response.data as RemoteTab[];
    cached = tabs.find(tab => tab.key === selectedKey);
    const next = JSON.stringify(pageTools(cached));
    if (signature !== next) { signature = next; void server.sendToolListChanged().catch(() => {}); }
    return tabs;
  }
  relay.onChanged = () => { void refresh().catch(() => {}); };
  relay.onDisconnected = () => { cached = undefined; void server.sendToolListChanged().catch(() => {}); };
  const clientName = () => (server.getClientVersion()?.name || 'Local MCP agent').slice(0, 80);
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try { await refresh(); } catch { cached = undefined; }
    return { tools: [...management, ...pageTools(cached)] };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const input = request.params.arguments ?? {};
    try {
      if (name === 'webmcp_request_connection') {
        const args = connectionInput.parse(input);
        const response = await relay.request('pairing:request', { ...args, clientName: clientName() });
        if (!response.ok && response.error.code === 'UNKNOWN_METHOD') return result(bridgeError('BRIDGE_UPDATE_REQUIRED', 'The background bridge is from an older build. Stop it with npm run mcp:stop, then reconnect this MCP server.'));
        return result(response);
      }
      if (name === 'webmcp_list_tabs') {
        noInput.parse(input);
        const tabs = await refresh();
        return result({ ok: true, data: { tabs: tabs.map(({ tools, ...tab }) => ({ ...tab, tools: tools.map(tool => tool.name), selected: tab.key === selectedKey })) } });
      }
      if (name === 'webmcp_select_tab') {
        const { tab } = selectInput.parse(input);
        const tabs = await refresh();
        if (!tabs.some(item => item.key === tab)) return result(bridgeError('TAB_NOT_SHARED', 'Choose a tab key from webmcp_list_tabs.'));
        selectedKey = tab; await refresh();
        return result({ ok: true, data: { tab: cached, tools: pageTools(cached) } });
      }
      if (name === 'webmcp_doctor') {
        noInput.parse(input);
        const tabs = await refresh();
        const status = await relay.request('status');
        const browsers = status.ok ? (status.data as { browsers: Array<{ browserId: string; tabs: number; capabilities: BrowserCapabilities | null }>; store: { dir: string; plugins: number } | null }) : { browsers: [], store: null };
        const report = tabs.map(tab => {
          const plugins = tab.plugins ?? [];
          const stale = plugins.filter(plugin => plugin.stale);
          return {
            key: tab.key, url: tab.url, title: tab.title, document_id: tab.documentId,
            selected: tab.key === selectedKey, runtime_version: tab.runtimeVersion ?? null, tool_count: tab.tools.length,
            plugins: plugins.map(plugin => ({ id: plugin.id, name: plugin.name, source: plugin.source ?? null, running: plugin.revision ?? plugin.version, installed: plugin.expectedRevision ?? plugin.expected ?? null, stale: plugin.stale })),
            // A page with no runtime at all is a site without a plugin, not a stale document.
            stale: stale.length > 0 || (!plugins.length && !tab.runtimeVersion && tab.tools.length > 0),
          };
        });
        const problems: string[] = [];
        if (!browsers.browsers.length) problems.push('No Chrome extension is connected to the local bridge. Call webmcp_request_connection and ask the user to approve it in the extension.');
        else if (!tabs.length) problems.push('No tab is shared. Call webmcp_request_connection, then ask the user to approve it in the extension.');
        else if (!selectedKey) problems.push('No tab is selected for this session. Call webmcp_select_tab with a key from webmcp_list_tabs.');
        for (const browser of browsers.browsers) {
          if (!browser.capabilities) problems.push(`Chrome profile ${browser.browserId} runs an extension build that predates plugin development. Ask the user to rebuild and reload the extension.`);
          else {
            if (!browser.capabilities.devMode) problems.push(`Agent plugin development is off in Chrome profile ${browser.browserId}. ${DEV_MODE_REMEDY}`);
            if (!browser.capabilities.userScripts) problems.push(`Chrome has not allowed user scripts for the extension in profile ${browser.browserId}. ${USER_SCRIPTS_REMEDY}`);
          }
        }
        for (const tab of report) {
          const stale = tab.plugins.filter(plugin => plugin.stale);
          if (stale.length) problems.push(`${tab.url} is running ${stale.map(plugin => `${plugin.name} ${plugin.running}`).join(', ')} while the extension has ${stale.map(plugin => plugin.installed).join(', ')}. The extension re-injects the installed revision into the open document on its own; call webmcp_refresh_tools and check again. If it stays stale, ask the user to reload that page.`);
          else if (!tab.plugins.length && !tab.runtime_version && tab.tool_count) problems.push(`${tab.url} reported no plugin or runtime version, so it predates this diagnostic. Ask the user to open the site in a new tab and share that one.`);
        }
        return result({ ok: true, data: { healthy: problems.length === 0, selected: selectedKey ?? null, problems, browsers: browsers.browsers, plugin_store: browsers.store, tabs: report } });
      }
      if (name === 'webmcp_refresh_tools') { noInput.parse(input); await refresh(); return result({ ok: true, data: { tab: cached ?? null, tools: pageTools(cached) } }); }
      if (name === 'webmcp_list_plugins') { noInput.parse(input); return result(await relay.request('plugins:list')); }
      if (name === 'webmcp_read_plugin') { return result(await relay.request('plugins:read', pluginIdInput.parse(input))); }
      if (name === 'webmcp_remove_plugin') {
        const response = await relay.request('plugins:remove', pluginIdInput.parse(input));
        await refresh();
        return result(response);
      }
      if (name === 'webmcp_install_plugin') {
        const args = installInput.parse(input);
        const response = await relay.request('plugins:install', { files: args.files, note: args.note, installedBy: clientName() });
        if (!response.ok) return result(response);
        // The selected tab may have just gained tools; hand them back without another round trip.
        await new Promise(resolve => setTimeout(resolve, 250));
        await refresh();
        return result({ ok: true, data: { ...(response.data as Record<string, unknown>), selected_tab: cached ? { key: cached.key, url: cached.url, tools: cached.tools.map(tool => tool.name) } : null } });
      }
      await refresh();
      const tab = cached;
      if (!tab) return result(bridgeError('NO_TAB_SELECTED', 'Share a tab in the extension, then call webmcp_select_tab.'));
      if (name === 'webmcp_evaluate') {
        const { code } = evaluateInput.parse(input);
        // Catch syntax errors here, where the message is precise, instead of as an opaque injection failure.
        try { new Function(`return (async () => {\n${code}\n})`); }
        catch (error) { return result(bridgeError('INVALID_INPUT', `Syntax error in code: ${error instanceof Error ? error.message : String(error)}`)); }
        return result(await relay.request('call', { browserId: tab.browserId, tabId: tab.tabId, documentId: tab.documentId, url: tab.url, code }, extra.signal));
      }
      const invoke = name === 'webmcp_call_tool' ? invokeInput.parse(input) : undefined;
      if (invoke && !Object.hasOwn(input, 'input')) return result(bridgeError('INVALID_INPUT', 'Supply the page tool input.'));
      const toolName = invoke?.tool ?? name;
      const tool = tab.tools.find(tool => tool.name === toolName && !toolName.startsWith('webmcp_'));
      if (!tool) return result(bridgeError('UNKNOWN_TOOL', 'Rediscover the selected page’s tools.'));
      if (!invoke && wrapInput(tool)) z.strictObject({ value: z.unknown() }).parse(input);
      const response = await relay.request('call', { browserId: tab.browserId, tabId: tab.tabId, documentId: tab.documentId, url: tab.url, name: toolName, input: invoke ? invoke.input : wrapInput(tool) ? input.value : input }, extra.signal);
      return result(response);
    } catch (error) {
      return result(bridgeError(error instanceof z.ZodError ? 'INVALID_INPUT' : 'BRIDGE_ERROR', error instanceof Error ? error.message : 'Local bridge failed.'));
    }
  });
  return server;
}
