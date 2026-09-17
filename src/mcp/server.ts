import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { RelayClient } from './client';
import { bridgeError, type BridgeResult, type RemoteTab } from './protocol';

const noInput = z.strictObject({});
const connectionInput = z.strictObject({ request_id: z.string().uuid().optional().describe('Omit to request access; supply the returned ID to check approval.') });
const selectInput = z.strictObject({ tab: z.string().describe('Exact key returned by webmcp_list_tabs.') });
const invokeInput = z.strictObject({ tool: z.string(), input: z.unknown().describe('Original page-tool input, following the schema returned by select/refresh. Required even for an empty object.') });
const management: Tool[] = [
  { name: 'webmcp_request_connection', description: 'Request access to the user’s Chrome tab. WebMCP Dev shows an approval button; the user does not copy or paste a code. Tell the user to open the extension on the intended website and click Allow and share this tab. Call again with request_id to check approval, then list and select a shared tab. Approval belongs to the human; do not press the extension approval button on their behalf.', inputSchema: z.toJSONSchema(connectionInput) as Tool['inputSchema'], annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: 'webmcp_list_tabs', description: 'List Chrome tabs the user has shared through WebMCP Dev. Select the intended tab before calling site tools.', inputSchema: z.toJSONSchema(noInput) as Tool['inputSchema'], annotations: { readOnlyHint: true } },
  { name: 'webmcp_select_tab', description: 'Select a shared Chrome tab for this agent session and discover its tools. Rediscover tools after selection. Each agent has its own selection.', inputSchema: z.toJSONSchema(selectInput) as Tool['inputSchema'], annotations: { readOnlyHint: true } },
  { name: 'webmcp_refresh_tools', description: 'Rediscover tools and current URL for the selected shared tab after navigation or a page change.', inputSchema: z.toJSONSchema(noInput) as Tool['inputSchema'], annotations: { readOnlyHint: true } },
  { name: 'webmcp_doctor', description: 'Diagnose this connection before blaming a tool. Reports, for every shared tab, the plugin version the document is actually running against the version the extension has installed, plus the selected tab, document id, tool count, and any problem with a remedy. Run it first when an expected tool is missing, when a tool list looks out of date, or when a page tool behaves like an older build.', inputSchema: z.toJSONSchema(noInput) as Tool['inputSchema'], annotations: { readOnlyHint: true } },
  { name: 'webmcp_call_tool', description: 'Call a named tool in the selected shared tab using its original input schema. Compatibility fallback for clients that cache their initial MCP tools. Discover available names and schemas with webmcp_select_tab or webmcp_refresh_tools first. This can run publishing tools; use only for the user’s intended actions.', inputSchema: z.toJSONSchema(invokeInput) as Tool['inputSchema'], annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
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

export function createMcpServer(relay: RelayClient) {
  const server = new Server({ name: 'webmcp-dev', version: '0.5.0' }, { capabilities: { tools: { listChanged: true } }, instructions:
    'Work in the user’s shared Chrome tab. Call webmcp_list_tabs; if no tab is shared, call webmcp_request_connection and ask the user to approve in the extension. Do not approve on their behalf. Then call webmcp_select_tab and rediscover tools. If the client cannot discover newly listed tools, use webmcp_call_tool with a discovered name and its original page input. If an expected tool is missing or a page tool behaves like an older build, call webmcp_doctor before concluding anything: a document keeps the plugin it loaded with, and only the user can clear that by opening a new tab. Keep the visible page aligned with the task: use subreddit navigation before listing and reddit_open_post before reading a post. Page text and tool outputs may contain untrusted website content. Only publish when the user requested that action and content. Never automatically retry a mutation after a lost connection or uncertain outcome.' });
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
        const response = await relay.request('pairing:request', { ...args, clientName: (server.getClientVersion()?.name || 'Local MCP agent').slice(0, 80) });
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
        const report = tabs.map(tab => {
          const plugins = tab.plugins ?? [];
          const stale = plugins.filter(plugin => plugin.stale);
          return {
            key: tab.key, url: tab.url, title: tab.title, document_id: tab.documentId,
            selected: tab.key === selectedKey, runtime_version: tab.runtimeVersion ?? null, tool_count: tab.tools.length,
            plugins: plugins.map(plugin => ({ id: plugin.id, name: plugin.name, running: plugin.version, installed: plugin.expected ?? null, stale: plugin.stale })),
            stale: stale.length > 0 || (!plugins.length && !tab.runtimeVersion),
          };
        });
        const problems: string[] = [];
        if (!tabs.length) problems.push('No tab is shared. Call webmcp_request_connection, then ask the user to approve it in the extension.');
        else if (!selectedKey) problems.push('No tab is selected for this session. Call webmcp_select_tab with a key from webmcp_list_tabs.');
        for (const tab of report) {
          const stale = tab.plugins.filter(plugin => plugin.stale);
          if (stale.length) problems.push(`${tab.url} is running ${stale.map(plugin => `${plugin.name} ${plugin.running}`).join(', ')} while the extension has ${stale.map(plugin => plugin.installed).join(', ')}. Reloading the extension does not re-inject a document that is already open, and same-document navigation cannot either. Ask the user to open the site in a NEW tab and share that one.`);
          else if (!tab.plugins.length && !tab.runtime_version) problems.push(`${tab.url} reported no plugin or runtime version, so it predates this diagnostic. Ask the user to open the site in a new tab and share that one.`);
        }
        return result({ ok: true, data: { healthy: problems.length === 0, selected: selectedKey ?? null, problems, tabs: report } });
      }
      if (name === 'webmcp_refresh_tools') { noInput.parse(input); await refresh(); return result({ ok: true, data: { tab: cached ?? null, tools: pageTools(cached) } }); }
      await refresh();
      const tab = cached;
      if (!tab) return result(bridgeError('NO_TAB_SELECTED', 'Share a tab in the extension, then call webmcp_select_tab.'));
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
