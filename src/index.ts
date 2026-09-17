import { activatePlugin } from './core/runtime';
import { plugin } from './plugins/reddit';
import type { PluginOptions } from './core/types';

export { installWebMCPDeveloper, activatePlugin } from './core/runtime';
export { defineTool } from './core/define-tool';
export { definePlugin } from './sdk';
export { matchesSite, matchesPattern } from './core/matches';
export { RedditClient } from './plugins/reddit/client';
export { ToolError, RedditError } from './errors';
export type { ToolResult } from './errors';
export type * from './core/types';
export type { ClientOptions } from './plugins/reddit/client';
export type { PluginAPI as RedditWebMCP, PluginOptions as InstallOptions } from './core/types';

// Compatibility for existing direct-injection clients.
export function installRedditWebMCP(options: PluginOptions = {}) {
  const api = activatePlugin(plugin, options);
  (options.window ?? window).redditWebMCP = api;
  return api;
}
