import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import type { BridgeConfig } from './config';
import { PROTOCOL_VERSION, type BridgeResult } from './protocol';

export class RelayClient {
  private pending = new Map<string, { resolve(result: BridgeResult): void; reject(error: Error): void; cleanup(): void }>();
  onChanged = () => {};
  onDisconnected = () => {};
  private constructor(private socket: WebSocket) {
    socket.on('message', raw => {
      let message: any; try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message.type === 'changed') this.onChanged();
      if (message.type === 'response') {
        const request = this.pending.get(message.id); if (!request) return;
        this.pending.delete(message.id); request.cleanup(); request.resolve(message.result);
      }
    });
    socket.on('close', () => {
      for (const request of this.pending.values()) { request.cleanup(); request.reject(new Error('Local bridge disconnected. An action may have completed; do not automatically retry.')); }
      this.pending.clear(); this.onDisconnected();
    });
    socket.on('error', () => {});
  }
  static async connect(config: BridgeConfig): Promise<RelayClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${config.port}/agent`, { handshakeTimeout: 2000, maxPayload: 8 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('Local bridge handshake timed out.')); }, 3000);
      const fail = (error: Error) => { clearTimeout(timer); reject(error); };
      socket.once('error', fail);
      socket.once('close', () => fail(new Error('Local bridge rejected authentication or protocol.')));
      socket.once('open', () => socket.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, token: config.agentToken })));
      socket.once('message', raw => {
        try {
          const message = JSON.parse(raw.toString());
          if (message.type !== 'ready' || message.version !== PROTOCOL_VERSION) throw new Error('Unsupported local bridge.');
          clearTimeout(timer); socket.removeListener('error', fail); resolve();
        } catch (error) { socket.close(); fail(error as Error); }
      });
    });
    return new RelayClient(socket);
  }
  request(method: 'tabs' | 'call' | 'shutdown' | 'pairing:request' | 'status' | 'plugins:list' | 'plugins:read' | 'plugins:install' | 'plugins:remove', params?: unknown, signal?: AbortSignal): Promise<BridgeResult> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Local bridge is not connected. Restart this MCP connection.'));
    if (signal?.aborted) return Promise.reject(new Error('Tool call cancelled.'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.socket.send(JSON.stringify({ type: 'cancel', id }));
        const request = this.pending.get(id); this.pending.delete(id); request?.cleanup();
        reject(new Error('Tool call cancelled. An action already sent to the website may have completed.'));
      };
      const timer = setTimeout(cancel, 65_000);
      this.pending.set(id, { resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); } });
      signal?.addEventListener('abort', cancel, { once: true });
      this.socket.send(JSON.stringify({ type: 'request', id, method, params }));
    });
  }
  close() { this.socket.close(); }
}

export type RelayRequester = Pick<RelayClient, 'request' | 'onChanged' | 'onDisconnected'>;

/** One agent session's link to the relay, kept across relay restarts. The relay is shared and can
 * stop (npm run mcp:stop, a crash, a new build); the session reconnects, starting a relay if none
 * answers, so neither it nor the browser's export page is stranded until the agent restarts. */
export class RelayConnection implements RelayRequester {
  onChanged = () => {};
  onDisconnected = () => {};
  private client?: RelayClient;
  private connecting?: Promise<RelayClient>;
  private retry?: NodeJS.Timeout;
  private delay = 0;
  private closed = false;
  private constructor(private readonly connect: () => Promise<RelayClient>, private readonly maxDelayMs: number) {}
  static async open(connect: () => Promise<RelayClient>, options: { maxDelayMs?: number } = {}) {
    const connection = new RelayConnection(connect, options.maxDelayMs ?? 30_000);
    await connection.current();
    return connection;
  }
  private current(): Promise<RelayClient> {
    if (this.closed) return Promise.reject(new Error('Local bridge connection closed.'));
    if (this.client) return Promise.resolve(this.client);
    this.connecting ??= this.connect().then(client => {
      this.connecting = undefined;
      if (this.closed) { client.close(); throw new Error('Local bridge connection closed.'); }
      this.client = client; this.delay = 0;
      client.onChanged = () => this.onChanged();
      client.onDisconnected = () => {
        if (this.client !== client) return;
        this.client = undefined; this.onDisconnected(); this.schedule();
      };
      // Tabs and tools may have changed while the relay was away.
      this.onChanged();
      return client;
    }, error => { this.connecting = undefined; throw error; });
    return this.connecting;
  }
  private schedule() {
    if (this.closed || this.retry) return;
    // Back off, with jitter so every open session does not race to start the relay at once.
    this.delay = Math.min(this.maxDelayMs, Math.max(250, this.delay * 2));
    this.retry = setTimeout(() => { this.retry = undefined; void this.current().catch(() => this.schedule()); }, this.delay / 2 + Math.random() * this.delay / 2);
    // A pending reconnect must not keep a finished agent process alive.
    this.retry.unref();
  }
  async request(...args: Parameters<RelayClient['request']>) { return (await this.current()).request(...args); }
  close() { this.closed = true; clearTimeout(this.retry); this.client?.close(); this.client = undefined; }
}
