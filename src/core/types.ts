import type { ToolResult } from '../errors';

export interface PluginManifest { apiVersion: 1; id: string; name: string; version: string; description: string; matches: string[] }
export interface PluginCatalogEntry extends PluginManifest { file: string }
export interface ExecutionOptions { signal?: AbortSignal }
export interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, any>;
  annotations: { readOnlyHint: boolean; consequentialHint: boolean; untrustedContentHint: boolean };
}
export interface DeveloperTool extends ToolDefinition {
  buttonLabel?: string;
  defaults?: Record<string, unknown>;
  outputSchema?: Record<string, any>;
}
export interface PluginTool extends DeveloperTool { execute(input: unknown, options: ExecutionOptions): Promise<unknown> }
export interface PluginEnvironment {
  window: Window;
  origin: string;
  fetch: typeof fetch;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  navigate(url: string): void;
  timeoutMs?: number;
}
export interface SitePlugin {
  manifest: PluginManifest;
  setup(environment: PluginEnvironment): {
    tools: PluginTool[] | (() => PluginTool[] | Promise<PluginTool[]>);
    /** Notify the registry when page state changes the available tools. */
    subscribe?(refresh: () => void): () => void;
    dispose?: () => void;
  };
}
export interface PluginOptions extends Partial<PluginEnvironment> {}
export interface ModelContext {
  registerTool(tool: ToolDefinition & { execute(input: unknown, options?: ExecutionOptions): Promise<unknown> }, options?: { signal: AbortSignal }): unknown;
  unregisterTool?(name: string): unknown;
}
export interface PluginStatus { mode: 'native' | 'legacy' | 'local'; registered: string[]; registrationErrors: string[]; refreshError?: string; disposed: boolean }
export interface PluginAPI {
  version: string;
  ready: Promise<void>;
  listTools(): DeveloperTool[];
  refreshTools(): Promise<void>;
  callTool(name: string, input: unknown, options?: ExecutionOptions): Promise<ToolResult>;
  status(): PluginStatus;
  dispose(): void;
}
export interface RegisteredTool extends DeveloperTool { pluginId: string; pluginName: string }
export interface WebMCPDeveloper {
  callRequest(id: string, name: string, input: unknown): Promise<ToolResult>;
  cancelRequest(id: string): void;
  version: string;
  registerPlugin(plugin: SitePlugin, options?: PluginOptions): PluginAPI;
  unregisterPlugin(id: string): void;
  getPlugin(id: string): PluginAPI | undefined;
  listPlugins(): Array<PluginManifest & PluginStatus>;
  listTools(): RegisteredTool[];
  refreshTools(): Promise<void>;
  callTool(name: string, input: unknown, options?: ExecutionOptions): Promise<ToolResult>;
}
declare global { interface Window { webMCPDev?: WebMCPDeveloper; redditWebMCP?: PluginAPI } }
