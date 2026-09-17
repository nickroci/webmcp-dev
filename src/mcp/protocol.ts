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
export const callSchema = z.strictObject({
  browserId: z.string(), tabId: z.number().int(), documentId: z.string(), url: z.string().url(),
  name: z.string(), input: z.unknown(),
});
export type PageCall = z.infer<typeof callSchema>;
export type BridgeResult = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
export const bridgeError = (code: string, message: string): BridgeResult => ({ ok: false, error: { code, message } });
