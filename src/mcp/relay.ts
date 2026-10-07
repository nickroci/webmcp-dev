import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import type { BridgeConfig } from './config';
import { PairingRequests } from './pairing';
import { PluginError, type PluginStore } from './plugins';
import { activationSchema, bridgeError, browserCapabilitiesSchema, callSchema, PROTOCOL_VERSION, sharedTabSchema, type BrowserCapabilities, type RemoteTab, type SharedTab } from './protocol';

function equalToken(actual: unknown, expected: string) {
  return typeof actual === 'string' && /^[a-f0-9]{64}$/.test(actual) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
const send = (socket: WebSocket, data: unknown) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data)); };
const installInput = z.object({ files: z.unknown(), installedBy: z.string().min(1).max(80), note: z.string().max(500).optional() });
const idInput = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]*$/).max(64) });
const browserReply = z.object({ ok: z.boolean(), error: z.string().optional(), tabs: z.array(activationSchema).optional() });

/** Local relay only. The stdio adapter owns the MCP protocol and per-agent selection. */
export async function startRelay(config: BridgeConfig, options: { pairingTimeoutMs?: number; store?: PluginStore } = {}) {
  let close: () => Promise<void>;
  const store = options.store;
  const http = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  const agents = new Set<WebSocket>();
  const browsers = new Map<string, { socket: WebSocket; tabs: SharedTab[]; capabilities?: BrowserCapabilities }>();
  const pending = new Map<string, { agent: WebSocket; requestId: string; browser: WebSocket; key: string; timer: NodeJS.Timeout }>();
  // Requests the relay itself makes of a browser, such as installing a plugin.
  const asks = new Map<string, { browser: WebSocket; resolve(reply: unknown): void; timer: NodeJS.Timeout }>();
  const busy = new Set<string>();
  const pairing = new PairingRequests(config, options.pairingTimeoutMs);
  const changed = () => { for (const agent of agents) send(agent, { type: 'changed' }); };
  const tabs = (): RemoteTab[] => [...browsers].flatMap(([browserId, browser]) => browser.tabs.map(tab => ({ ...tab, browserId, key: `${browserId}:${tab.tabId}` })));
  const status = () => ({
    browsers: [...browsers].map(([browserId, browser]) => ({ browserId, tabs: browser.tabs.length, capabilities: browser.capabilities ?? null })),
    store: store ? { dir: store.dir, plugins: store.list().length } : null,
  });
  function finish(id: string, result: unknown) {
    const call = pending.get(id); if (!call) return;
    clearTimeout(call.timer); pending.delete(id); busy.delete(call.key);
    send(call.agent, { type: 'response', id: call.requestId, result });
  }
  function ask(browserId: string, message: Record<string, unknown>, timeoutMs = 20_000): Promise<{ browserId: string; reply: unknown }> {
    const browser = browsers.get(browserId);
    if (!browser) return Promise.resolve({ browserId, reply: { ok: false, error: 'Chrome disconnected.' } });
    const id = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => { asks.delete(id); resolve({ browserId, reply: { ok: false, error: 'Chrome did not answer within 20 seconds.' } }); }, timeoutMs);
      asks.set(id, { browser: browser.socket, resolve: reply => resolve({ browserId, reply }), timer });
      send(browser.socket, { ...message, id });
    });
  }
  const connectedBrowsers = () => [...browsers].filter(([, browser]) => browser.socket.readyState === WebSocket.OPEN);
  function pluginError(error: unknown) {
    if (error instanceof PluginError) return bridgeError(error.code, error.message, error.details);
    return bridgeError('INSTALL_FAILED', error instanceof Error ? error.message : 'Could not install the plugin.');
  }
  async function installPlugin(params: unknown) {
    if (!store) return bridgeError('UNSUPPORTED', 'This local bridge has no plugin store. Rebuild and restart it with npm run mcp:stop.');
    const parsed = installInput.safeParse(params);
    if (!parsed.success) return bridgeError('INVALID_INPUT', 'Invalid plugin installation request.');
    const connected = connectedBrowsers();
    if (!connected.length) return bridgeError('NO_BROWSER', 'No Chrome extension is connected. Ask the user to approve a connection request first.');
    const capable = connected.filter(([, browser]) => browser.capabilities?.devMode && browser.capabilities.userScripts);
    if (!capable.length) {
      const needsToggle = connected.some(([, browser]) => browser.capabilities?.devMode && !browser.capabilities.userScripts);
      return needsToggle
        ? bridgeError('USER_SCRIPTS_UNAVAILABLE', 'Chrome has not allowed user scripts for WebMCP Dev. Ask the user to open chrome://extensions, choose Details on WebMCP Dev, and turn on Allow User Scripts. It takes effect at once.')
        : bridgeError('DEV_MODE_DISABLED', 'Agent plugin development is off. Ask the user to open WebMCP Dev → Agents and enable "Let agents develop plugins".');
    }
    let installed: Awaited<ReturnType<PluginStore['install']>>;
    try { installed = await store.install(parsed.data.files, { installedBy: parsed.data.installedBy, note: parsed.data.note }); }
    catch (error) { return pluginError(error); }
    const replies = await Promise.all(capable.map(([browserId]) => ask(browserId, { type: 'install', plugin: installed.plugin })));
    const { code: _code, ...plugin } = installed.plugin;
    changed();
    return { ok: true, data: { plugin, warnings: installed.warnings, browsers: replies.map(({ browserId, reply }) => {
      const parsedReply = browserReply.safeParse(reply);
      return { browserId, ...(parsedReply.success ? parsedReply.data : { ok: false, error: 'Chrome returned an invalid installation reply.' }) };
    }) } };
  }
  async function removePlugin(id: string, except?: WebSocket) {
    const removed = store ? await store.remove(id) : false;
    for (const [, browser] of connectedBrowsers()) if (browser.socket !== except) send(browser.socket, { type: 'remove', pluginId: id });
    changed();
    return removed;
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
          send(ws, { type: 'ready', version: PROTOCOL_VERSION, features: ['pairing-requests', 'plugins', 'evaluate'] });
          // Every browser receives the whole catalog, so plugins installed from one agent session reach every profile.
          if (browser && store) send(ws, { type: 'catalog', plugins: store.bundles() });
          return;
        }
        if (message.type === 'ping') { send(ws, { type: 'pong' }); return; }
        if (browser) {
          if (message.type === 'snapshot') {
            const result = z.array(sharedTabSchema).max(100).safeParse(message.tabs);
            if (!result.success) { ws.close(1008, 'Invalid tab snapshot'); return; }
            if (browsers.get(browserId!)?.socket !== ws) return;
            const capabilities = browserCapabilitiesSchema.safeParse(message.capabilities);
            browsers.set(browserId!, { socket: ws, tabs: result.data, capabilities: capabilities.success ? capabilities.data : browsers.get(browserId!)?.capabilities }); changed();
          } else if (message.type === 'result' && typeof message.id === 'string' && pending.get(message.id)?.browser === ws) finish(message.id, message.result);
          else if (message.type === 'reply' && typeof message.id === 'string' && asks.get(message.id)?.browser === ws) {
            const asked = asks.get(message.id)!; asks.delete(message.id); clearTimeout(asked.timer); asked.resolve(message.result);
          } else if (message.type === 'plugin-removed' && typeof message.pluginId === 'string') void removePlugin(message.pluginId, ws);
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
        if (message.method === 'status') { respond({ ok: true, data: status() }); return; }
        if (message.method === 'plugins:list') {
          if (!store) { respond({ ok: true, data: { plugins: [], dir: null } }); return; }
          void store.builtIn().then(builtIn => respond({ ok: true, data: { dir: store.dir, plugins: [...builtIn, ...store.list()] } }));
          return;
        }
        if (message.method === 'plugins:read') {
          const parsed = idInput.safeParse(message.params);
          if (!parsed.success || !store) { respond(bridgeError('INVALID_INPUT', 'Supply a plugin id.')); return; }
          void store.read(parsed.data.id).then(found => respond(found ? { ok: true, data: found } : bridgeError('UNKNOWN_PLUGIN', 'No plugin has that id. Call plugins:list for the catalog.')));
          return;
        }
        if (message.method === 'plugins:install') { void installPlugin(message.params).then(respond, error => respond(pluginError(error))); return; }
        if (message.method === 'plugins:remove') {
          const parsed = idInput.safeParse(message.params);
          if (!parsed.success) { respond(bridgeError('INVALID_INPUT', 'Supply a plugin id.')); return; }
          if (!store?.get(parsed.data.id)) { respond(bridgeError('UNKNOWN_PLUGIN', 'Only agent-installed plugins can be removed here. Built-in plugins live in src/plugins.')); return; }
          void removePlugin(parsed.data.id).then(removed => respond({ ok: true, data: { removed } }));
          return;
        }
        if (message.method !== 'call') { respond(bridgeError('UNKNOWN_METHOD', 'Unsupported bridge method.')); return; }
        const parsed = callSchema.safeParse(message.params);
        if (!parsed.success) { respond(bridgeError('INVALID_INPUT', 'Invalid page call.')); return; }
        const call = parsed.data;
        const target = browsers.get(call.browserId);
        const tab = target?.tabs.find(tab => tab.tabId === call.tabId);
        if (!target || !tab || tab.documentId !== call.documentId || tab.url !== call.url) {
          respond(bridgeError('STALE_TAB', 'The shared page changed or disconnected. Refresh tools before trying again.')); return;
        }
        if (call.name !== undefined && !tab.tools.some(tool => tool.name === call.name)) { respond(bridgeError('UNKNOWN_TOOL', 'This page no longer offers that tool.')); return; }
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
        for (const [id, asked] of asks) if (asked.browser === ws) { asks.delete(id); clearTimeout(asked.timer); asked.resolve({ ok: false, error: 'Chrome disconnected during installation.' }); }
      });
    });
  });
  try { await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(config.port, '127.0.0.1', resolve); }); }
  catch (error) { pairing.close(); wss.close(); throw error; }
  close = async () => {
    pairing.close();
    for (const [id] of pending) finish(id, bridgeError('DISCONNECTED', 'Local bridge stopped.'));
    for (const [id, asked] of asks) { asks.delete(id); clearTimeout(asked.timer); asked.resolve({ ok: false, error: 'Local bridge stopped.' }); }
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
  };
  return { close };
}
