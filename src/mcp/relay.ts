import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import type { BridgeConfig } from './config';
import { PairingRequests } from './pairing';
import { bridgeError, callSchema, PROTOCOL_VERSION, sharedTabSchema, type RemoteTab, type SharedTab } from './protocol';

function equalToken(actual: unknown, expected: string) {
  return typeof actual === 'string' && /^[a-f0-9]{64}$/.test(actual) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
const send = (socket: WebSocket, data: unknown) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data)); };

/** Local relay only. The stdio adapter owns the MCP protocol and per-agent selection. */
export async function startRelay(config: BridgeConfig, options: { pairingTimeoutMs?: number } = {}) {
  let close: () => Promise<void>;
  const http = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  const agents = new Set<WebSocket>();
  const browsers = new Map<string, { socket: WebSocket; tabs: SharedTab[] }>();
  const pending = new Map<string, { agent: WebSocket; requestId: string; browser: WebSocket; key: string; timer: NodeJS.Timeout }>();
  const busy = new Set<string>();
  const pairing = new PairingRequests(config, options.pairingTimeoutMs);
  const changed = () => { for (const agent of agents) send(agent, { type: 'changed' }); };
  const tabs = (): RemoteTab[] => [...browsers].flatMap(([browserId, browser]) => browser.tabs.map(tab => ({ ...tab, browserId, key: `${browserId}:${tab.tabId}` })));
  function finish(id: string, result: unknown) {
    const call = pending.get(id); if (!call) return;
    clearTimeout(call.timer); pending.delete(id); busy.delete(call.key);
    send(call.agent, { type: 'response', id: call.requestId, result });
  }
  http.on('upgrade', (request, socket, head) => {
    const origin = request.headers.origin;
    const browser = request.url === '/browser' && typeof origin === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
    const discovery = request.url === '/pairing' && typeof origin === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
    const agent = request.url === '/agent' && origin === undefined;
    if (request.headers.host !== `127.0.0.1:${config.port}` || (!browser && !agent && !discovery)) { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, ws => {
      if (discovery) { pairing.attach(ws); return; }
      let authenticated = false;
      let browserId: string | undefined;
      const authTimeout = setTimeout(() => ws.close(1008, 'Authentication required'), 3000);
      ws.on('error', () => {});
      ws.on('message', data => {
        let message: any;
        try { message = JSON.parse(data.toString()); } catch { ws.close(1008, 'Invalid JSON'); return; }
        if (!message || typeof message !== 'object') { ws.close(1008, 'Invalid message'); return; }
        if (!authenticated) {
          if (message.type !== 'hello' || message.version !== PROTOCOL_VERSION || !equalToken(message.token, browser ? config.browserToken : config.agentToken)
            || (browser && !z.string().uuid().safeParse(message.browserId).success)) { ws.close(1008, 'Invalid credentials or protocol'); return; }
          authenticated = true; clearTimeout(authTimeout);
          if (browser) {
            browserId = message.browserId;
            browsers.get(browserId!)?.socket.close(1000, 'Reconnected');
            browsers.set(browserId!, { socket: ws, tabs: [] }); changed();
          } else agents.add(ws);
          send(ws, { type: 'ready', version: PROTOCOL_VERSION, features: ['pairing-requests'] }); return;
        }
        if (message.type === 'ping') { send(ws, { type: 'pong' }); return; }
        if (browser) {
          if (message.type === 'snapshot') {
            const result = z.array(sharedTabSchema).max(100).safeParse(message.tabs);
            if (!result.success) { ws.close(1008, 'Invalid tab snapshot'); return; }
            if (browsers.get(browserId!)?.socket !== ws) return;
            browsers.set(browserId!, { socket: ws, tabs: result.data }); changed();
          } else if (message.type === 'result' && typeof message.id === 'string' && pending.get(message.id)?.browser === ws) finish(message.id, message.result);
          return;
        }
        if (message.type === 'cancel' && typeof message.id === 'string') {
          for (const [id, call] of pending) if (call.agent === ws && call.requestId === message.id) send(call.browser, { type: 'cancel', id });
          return;
        }
        if (message.type !== 'request' || typeof message.id !== 'string' || message.id.length > 128) return;
        const respond = (result: unknown) => send(ws, { type: 'response', id: message.id, result });
        if (message.method === 'pairing:request') { respond(pairing.request(ws, message.params)); return; }
        if (message.method === 'shutdown') { respond({ ok: true, data: { stopped: true } }); setTimeout(() => { void close(); }, 50); return; }
        if (message.method === 'tabs') { respond({ ok: true, data: tabs() }); return; }
        if (message.method !== 'call') { respond(bridgeError('UNKNOWN_METHOD', 'Unsupported bridge method.')); return; }
        const parsed = callSchema.safeParse(message.params);
        if (!parsed.success) { respond(bridgeError('INVALID_INPUT', 'Invalid page call.')); return; }
        const call = parsed.data;
        const target = browsers.get(call.browserId);
        const tab = target?.tabs.find(tab => tab.tabId === call.tabId);
        if (!target || !tab || tab.documentId !== call.documentId || tab.url !== call.url) {
          respond(bridgeError('STALE_TAB', 'The shared page changed or disconnected. Refresh tools before trying again.')); return;
        }
        if (!tab.tools.some(tool => tool.name === call.name)) { respond(bridgeError('UNKNOWN_TOOL', 'This page no longer offers that tool.')); return; }
        const key = `${call.browserId}:${call.tabId}`;
        if (busy.has(key)) { respond(bridgeError('TAB_BUSY', 'Another tool is running in this tab.')); return; }
        const id = randomUUID(); busy.add(key);
        const timer = setTimeout(() => {
          send(target.socket, { type: 'cancel', id });
          finish(id, bridgeError('OUTCOME_UNKNOWN', 'No result arrived within 60 seconds. An action may have completed; inspect the page before retrying.'));
        }, 60_000);
        pending.set(id, { agent: ws, requestId: message.id, browser: target.socket, key, timer });
        send(target.socket, { type: 'call', id, call });
      });
      ws.on('close', () => {
        clearTimeout(authTimeout); agents.delete(ws);
        if (agent) pairing.removeAgent(ws);
        if (browserId && browsers.get(browserId)?.socket === ws) { browsers.delete(browserId); changed(); }
        for (const [id, call] of pending) {
          if (call.browser === ws) finish(id, bridgeError('OUTCOME_UNKNOWN', 'Chrome disconnected during execution. Inspect the page before retrying an action.'));
          else if (call.agent === ws) send(call.browser, { type: 'cancel', id });
        }
      });
    });
  });
  try { await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(config.port, '127.0.0.1', resolve); }); }
  catch (error) { pairing.close(); wss.close(); throw error; }
  close = async () => {
    pairing.close();
    for (const [id] of pending) finish(id, bridgeError('DISCONNECTED', 'Local bridge stopped.'));
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
  };
  return { close };
}
