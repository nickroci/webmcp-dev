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
  request(method: 'tabs' | 'call' | 'shutdown' | 'pairing:request', params?: unknown, signal?: AbortSignal): Promise<BridgeResult> {
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
