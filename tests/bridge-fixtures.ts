import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { BridgeConfig } from '../src/mcp/config';

export async function bridgeConfig(): Promise<BridgeConfig> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return { version: 1, port: address.port, browserToken: randomBytes(32).toString('hex'), agentToken: randomBytes(32).toString('hex') };
}

/** The bridge's own MCP tools, in the order the server lists them before any page tools. */
export const MANAGEMENT_TOOLS = ['webmcp_request_connection', 'webmcp_list_tabs', 'webmcp_select_tab', 'webmcp_refresh_tools', 'webmcp_doctor', 'webmcp_call_tool', 'webmcp_list_plugins', 'webmcp_read_plugin', 'webmcp_install_plugin', 'webmcp_remove_plugin', 'webmcp_evaluate'];
