import { z } from 'zod';
import { connectionRequestSchema, DEFAULT_PORT, pairingSchema, type ConnectionRequest } from '../src/mcp/protocol';

export function createDiscovery() {
  let socket: WebSocket | undefined;
  let requests: ConnectionRequest[] = [];
  let available = false;
  let port = DEFAULT_PORT;
  const approvals = new Map<string, { resolve(pairing: z.infer<typeof pairingSchema>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const ready = chrome.storage.local.get(['agentBridgePort', 'agentPairing']).then(saved => {
    const pair = pairingSchema.safeParse(saved.agentPairing);
    const value = saved.agentBridgePort ?? (pair.success ? pair.data.port : DEFAULT_PORT);
    port = z.number().int().min(1024).max(65535).catch(DEFAULT_PORT).parse(value);
  });
  function updateRequests(next: ConnectionRequest[]) {
    requests = next;
    void chrome.action.setBadgeText({ text: requests.length ? String(requests.length) : '' });
    void chrome.action.setBadgeBackgroundColor({ color: '#5145cd' });
  }
  function disconnect() {
    const previous = socket; socket = undefined; available = false; previous?.close(); updateRequests([]);
    for (const pending of approvals.values()) { clearTimeout(pending.timer); pending.reject(new Error('The local connection closed. Ask the agent to request access again.')); }
    approvals.clear();
  }
  async function connect() {
    await ready;
    if (socket && socket.readyState < WebSocket.CLOSING) return;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/pairing`); socket = ws;
    ws.onmessage = event => {
      if (socket !== ws) return;
      let message: any; try { message = JSON.parse(String(event.data)); } catch { ws.close(); return; }
      if (message.type === 'requests') {
        const parsed = z.array(connectionRequestSchema).safeParse(message.requests);
        if (!parsed.success) { ws.close(); return; }
        available = true; updateRequests(parsed.data.filter(request => request.status === 'pending' && request.expiresAt > Date.now()));
      } else if (message.type === 'paired' || message.type === 'pairing-error') {
        const pending = approvals.get(message.id); if (!pending) return;
        approvals.delete(message.id); clearTimeout(pending.timer);
        const pair = pairingSchema.safeParse(message.pairing);
        if (message.type === 'paired' && pair.success && pair.data.port === port) pending.resolve(pair.data);
        else pending.reject(new Error(message.message ?? 'The local bridge returned an invalid approval.'));
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => { if (socket === ws) disconnect(); };
  }
  return {
    connect,
    state: () => ({ requests, available, port }),
    async setPort(value: unknown) {
      await ready;
      port = z.number().int().min(1024).max(65535).parse(value);
      await chrome.storage.local.set({ agentBridgePort: port }); disconnect(); await connect();
    },
    async approve(id: string) {
      if (!available || socket?.readyState !== WebSocket.OPEN || !requests.some(request => request.id === id && request.expiresAt > Date.now())) throw new Error('This request is no longer pending. Ask the agent to request access again.');
      if (approvals.has(id)) throw new Error('This request is already being approved.');
      const saved = await chrome.storage.local.get('agentBrowserId');
      const browserId = z.string().uuid().catch(() => crypto.randomUUID()).parse(saved.agentBrowserId);
      await chrome.storage.local.set({ agentBrowserId: browserId });
      return new Promise<z.infer<typeof pairingSchema>>((resolve, reject) => {
        const timer = setTimeout(() => { approvals.delete(id); reject(new Error('Approval timed out. Ask the agent to check the connection and request again.')); }, 5000);
        approvals.set(id, { resolve, reject, timer });
        socket!.send(JSON.stringify({ type: 'approve', id, browserId }));
      });
    },
    decline(id: string) {
      if (socket?.readyState !== WebSocket.OPEN) throw new Error('The local bridge is not connected.');
      socket.send(JSON.stringify({ type: 'decline', id }));
    },
    ping() { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' })); },
  };
}
