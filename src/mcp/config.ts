import { chmod, link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_PORT, PROTOCOL_VERSION } from './protocol';

const configSchema = z.strictObject({
  version: z.literal(PROTOCOL_VERSION), port: z.number().int().min(1024).max(65535),
  browserToken: z.string().regex(/^[a-f0-9]{64}$/), agentToken: z.string().regex(/^[a-f0-9]{64}$/),
});
export type BridgeConfig = z.infer<typeof configSchema>;
export const stateDirectory = () => resolve(process.env.WEBMCP_STATE_DIR ?? join(homedir(), '.webmcp-dev'));
export async function readConfig(): Promise<BridgeConfig> {
  const dir = stateDirectory();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'connection.json');
  try { return configSchema.parse(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const config = configSchema.parse({ version: PROTOCOL_VERSION,
    port: Number(process.env.WEBMCP_PORT ?? DEFAULT_PORT),
    browserToken: randomBytes(32).toString('hex'), agentToken: randomBytes(32).toString('hex'),
  });
  // Publish a complete file atomically; simultaneous MCP clients reuse the winner.
  const temp = join(dir, `connection-${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
  try { await link(temp, path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  finally { await unlink(temp); }
  await chmod(path, 0o600);
  return configSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}
export function pairingCode(config: BridgeConfig): string {
  return Buffer.from(JSON.stringify({ version: config.version, port: config.port, token: config.browserToken })).toString('base64');
}
