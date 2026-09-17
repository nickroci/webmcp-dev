import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { z } from 'zod';
import type { BridgeConfig } from './config';
import { bridgeError, type BridgeResult, type ConnectionRequest } from './protocol';

const send = (socket: WebSocket, value: unknown) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
const requestInput = z.strictObject({ clientName: z.string().min(1).max(80), request_id: z.string().uuid().optional() });
const decision = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('approve'), id: z.string().uuid(), browserId: z.string().uuid() }),
  z.strictObject({ type: z.literal('decline'), id: z.string().uuid() }),
]);

/** Discovery carries only pending requests. Credentials are sent to the
 * approving extension connection; tab access still requires explicit sharing. */
export class PairingRequests {
  private entries = new Map<string, { owner: WebSocket; request: ConnectionRequest }>();
  private observers = new Set<WebSocket>();
  private timer: NodeJS.Timeout;
  constructor(private config: BridgeConfig, private ttlMs = 300_000) {
    this.timer = setInterval(() => this.expire(), Math.min(1000, ttlMs));
  }
  private pending() { return [...this.entries.values()].map(entry => entry.request).filter(request => request.status === 'pending'); }
  private broadcast() { for (const observer of this.observers) send(observer, { type: 'requests', requests: this.pending() }); }
  private expire() {
    let changed = false;
    for (const [id, entry] of this.entries) {
      if (Date.now() >= entry.request.expiresAt && entry.request.status === 'pending') { entry.request.status = 'expired'; changed = true; }
      if (Date.now() >= entry.request.expiresAt + this.ttlMs) this.entries.delete(id);
    }
    if (changed) this.broadcast();
  }
  request(owner: WebSocket, input: unknown): BridgeResult {
    this.expire();
    const parsed = requestInput.safeParse(input);
    if (!parsed.success) return bridgeError('INVALID_INPUT', 'Invalid connection request.');
    if (parsed.data.request_id) {
      const entry = this.entries.get(parsed.data.request_id);
      return entry?.owner === owner ? { ok: true, data: entry.request } : bridgeError('REQUEST_NOT_FOUND', 'This connection request expired or belongs to another agent session.');
    }
    const previous = [...this.entries.values()].find(entry => entry.owner === owner && entry.request.status === 'pending');
    if (previous) return { ok: true, data: previous.request };
    if (this.entries.size >= 50) return bridgeError('TOO_MANY_REQUESTS', 'Too many connection requests. Wait for existing requests to expire.');
    const request: ConnectionRequest = { id: randomUUID(), code: randomBytes(3).toString('hex').toUpperCase(), clientName: parsed.data.clientName,
      expiresAt: Date.now() + this.ttlMs, status: 'pending' };
    this.entries.set(request.id, { owner, request }); this.broadcast();
    return { ok: true, data: request };
  }
  attach(socket: WebSocket) {
    this.expire(); this.observers.add(socket);
    send(socket, { type: 'requests', requests: this.pending() });
    socket.on('message', raw => {
      let message: unknown;
      try { message = JSON.parse(raw.toString()); } catch { socket.close(1008, 'Invalid JSON'); return; }
      if ((message as { type?: string })?.type === 'ping') { send(socket, { type: 'pong' }); return; }
      const parsed = decision.safeParse(message);
      if (!parsed.success) { socket.close(1008, 'Unsupported pairing message'); return; }
      this.expire();
      const entry = this.entries.get(parsed.data.id);
      if (!entry || entry.request.status !== 'pending') {
        send(socket, { type: 'pairing-error', id: parsed.data.id, message: 'This request is no longer pending. Ask the agent to request access again.' }); return;
      }
      entry.request.status = parsed.data.type === 'approve' ? 'approved' : 'declined';
      if (parsed.data.type === 'approve') {
        entry.request.browserId = parsed.data.browserId;
        send(socket, { type: 'paired', id: parsed.data.id, pairing: { version: this.config.version, port: this.config.port, token: this.config.browserToken } });
      } else send(socket, { type: 'declined', id: parsed.data.id });
      this.broadcast();
    });
    socket.on('error', () => {});
    socket.on('close', () => this.observers.delete(socket));
  }
  removeAgent(owner: WebSocket) {
    for (const [id, entry] of this.entries) if (entry.owner === owner) this.entries.delete(id);
    this.broadcast();
  }
  close() { clearInterval(this.timer); for (const socket of this.observers) socket.terminate(); this.observers.clear(); this.entries.clear(); }
}
