import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readConfig, pairingCode, stateDirectory, type BridgeConfig } from './config';
import { RelayClient } from './client';
import { startRelay } from './relay';
import { createMcpServer } from './server';

async function ensureRelay(config: BridgeConfig): Promise<RelayClient> {
  try { return await RelayClient.connect(config); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ECONNREFUSED') throw error; }
  const log = await open(join(stateDirectory(), 'bridge.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'relay'], { detached: true, stdio: ['ignore', log.fd, log.fd], windowsHide: true });
    child.on('error', error => { console.error(`Could not start local bridge: ${error.message}`); });
    child.unref();
  } finally { await log.close(); }
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    try { return await RelayClient.connect(config); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ECONNREFUSED') throw error; }
  }
  throw new Error(`Local bridge could not start. See ${join(stateDirectory(), 'bridge.log')}.`);
}

async function main() {
  const command = process.argv[2] ?? 'stdio';
  if (!['stdio', 'pair', 'relay', 'stop'].includes(command)) throw new Error('Usage: node dist/mcp/cli.js [stdio|pair|relay|stop]');
  const config = await readConfig();
  if (command === 'relay') {
    const relay = await startRelay(config);
    const stop = () => { void relay.close().then(() => process.exit(0)); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    return;
  }
  if (command === 'stop') {
    const relay = await RelayClient.connect(config);
    await relay.request('shutdown'); relay.close(); console.log('Local bridge stopped.'); return;
  }
  const relay = await ensureRelay(config);
  if (command === 'pair') {
    console.log('Paste this pairing code into WebMCP Dev → Agents → Connect:\n');
    console.log(pairingCode(config));
    console.log('\nThen click Share this tab on the website you want the agent to use.');
    relay.close(); return;
  }
  const server = createMcpServer(relay);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const stop = () => { relay.close(); void server.close(); };
  process.stdin.once('end', stop);
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
void main().catch(error => { console.error(`WebMCP Dev: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
