/** The public plugin authoring surface. No Reddit-specific dependencies. */
export { z } from 'zod';
export { defineTool } from './core/define-tool';
export { ToolError } from './errors';
export type { SitePlugin, PluginManifest, PluginTool, PluginEnvironment, ExecutionOptions } from './core/types';
import type { SitePlugin } from './core/types';

// JSON imports infer numbers as `number`; validate and narrow the contract here.
export function definePlugin(plugin: Omit<SitePlugin, 'manifest'> & { manifest: Omit<SitePlugin['manifest'], 'apiVersion'> & { apiVersion: number } }): SitePlugin {
  if (plugin.manifest.apiVersion !== 1) throw new Error(`Unsupported plugin API version: ${plugin.manifest.apiVersion}`);
  return plugin as SitePlugin;
}
