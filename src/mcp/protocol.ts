import { z } from 'zod';

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 19375;
export const connectionRequestSchema = z.object({
  id: z.string().uuid(), code: z.string(), clientName: z.string(), expiresAt: z.number(),
  status: z.enum(['pending', 'approved', 'declined', 'expired']), browserId: z.string().uuid().optional(),
});
export type ConnectionRequest = z.infer<typeof connectionRequestSchema>;
export const pairingSchema = z.strictObject({
  version: z.literal(PROTOCOL_VERSION), port: z.number().int().min(1024).max(65535),
  token: z.string().regex(/^[a-f0-9]{64}$/),
});
export const pageToolSchema = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/),
  title: z.string().optional(), description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  annotations: z.object({ readOnlyHint: z.boolean(), consequentialHint: z.boolean(), untrustedContentHint: z.boolean() }),
  pluginId: z.string(), pluginName: z.string(),
});
export const tabPluginSchema = z.object({
  id: z.string(), name: z.string(), version: z.string(),
  expected: z.string().optional(), stale: z.boolean(),
  revision: z.string().optional(), expectedRevision: z.string().optional(),
  source: z.enum(['static', 'dynamic']).optional(),
});
export const sharedTabSchema = z.object({
  tabId: z.number().int(), documentId: z.string(), url: z.string().url(), title: z.string(),
  tools: z.array(pageToolSchema).max(500),
  // A document keeps the plugin injected when it loaded, so what it runs can trail the extension.
  runtimeVersion: z.string().optional(),
  plugins: z.array(tabPluginSchema).max(50).optional(),
});
export type SharedTab = z.infer<typeof sharedTabSchema>;
export type RemoteTab = SharedTab & { browserId: string; key: string };
/** What one connected browser can do for agents beyond calling registered tools. */
export const browserCapabilitiesSchema = z.object({
  /** The user allowed agents to install plugins and run code in shared tabs. */
  devMode: z.boolean(),
  /** chrome.userScripts is usable: the Allow User Scripts toggle is on for this extension. */
  userScripts: z.boolean(),
  extensionVersion: z.string().optional(),
});
export type BrowserCapabilities = z.infer<typeof browserCapabilitiesSchema>;
export const MAX_EVALUATE_CODE = 64 * 1024;
export const callSchema = z.strictObject({
  browserId: z.string(), tabId: z.number().int(), documentId: z.string(), url: z.string().url(),
  // Either a registered tool call, or (dev mode only) code to run in that document.
  name: z.string().optional(), input: z.unknown().optional(),
  code: z.string().max(MAX_EVALUATE_CODE).optional(),
}).refine(call => (call.name === undefined) !== (call.code === undefined), { message: 'Supply a tool name or code, not both.' });
export type PageCall = z.infer<typeof callSchema>;

/** Agent-authored plugins live as source folders in the local state directory. */
export const PLUGIN_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\.(ts|json|md)$/;
export const MAX_PLUGIN_FILES = 20;
export const MAX_PLUGIN_SOURCE_BYTES = 1024 * 1024;
export const pluginManifestSchema = z.strictObject({
  $schema: z.string().optional(),
  apiVersion: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'Use a lowercase id such as my-site.').max(64),
  name: z.string().trim().min(1).max(80),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'Use a semantic version such as 0.1.0.'),
  description: z.string().trim().min(1).max(500),
  matches: z.array(z.string().regex(/^(https?|\*):\/\/(\*\.)?[a-z0-9.-]+\/[^\s]*$/i, 'Use HTTP(S) Chrome match patterns with explicit hostnames.')).min(1).max(20),
});
export const pluginFilesSchema = z.record(z.string().regex(PLUGIN_FILE_PATTERN, 'File names must be plain .ts, .json or .md names without directories.'), z.string())
  .refine(files => 'plugin.json' in files && 'index.ts' in files, { message: 'Supply plugin.json and index.ts.' })
  .refine(files => Object.keys(files).length <= MAX_PLUGIN_FILES, { message: `At most ${MAX_PLUGIN_FILES} files.` })
  .refine(files => Object.values(files).reduce((sum, text) => sum + text.length, 0) <= MAX_PLUGIN_SOURCE_BYTES, { message: 'Plugin source is too large.' });
export const installedPluginSchema = pluginManifestSchema.omit({ $schema: true }).extend({
  file: z.string(), revision: z.string(), source: z.literal('dynamic'),
  installedBy: z.string(), installedAt: z.string(), note: z.string().optional(),
});
export type InstalledPlugin = z.infer<typeof installedPluginSchema>;
export const pluginBundleSchema = installedPluginSchema.extend({ code: z.string() });
export type PluginBundle = z.infer<typeof pluginBundleSchema>;
/** One tab's view of a plugin right after the extension injected it. */
export const activationSchema = z.object({
  tabId: z.number().int(), url: z.string(), shared: z.boolean(), ok: z.boolean(),
  error: z.string().optional(), tools: z.array(z.string()).optional(),
  refreshError: z.string().optional(), registrationErrors: z.array(z.string()).optional(),
});
export type Activation = z.infer<typeof activationSchema>;
export type BridgeResult = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string; details?: unknown } };
export const bridgeError = (code: string, message: string, details?: unknown): BridgeResult => ({ ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } });
