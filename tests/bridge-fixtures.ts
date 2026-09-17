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
