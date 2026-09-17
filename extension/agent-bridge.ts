import { matchesSite } from '../src/core/matches';
import { z } from 'zod';
import type { PluginCatalogEntry } from '../src/core/types';
import { bridgeError, callSchema, pairingSchema, PROTOCOL_VERSION, type PageCall, type SharedTab } from '../src/mcp/protocol';
import { createDiscovery } from './discovery';

/** Runs only in the extension worker. Pairing credentials never enter the page. */
export function startAgentBridge(catalog: Promise<PluginCatalogEntry[]>, syncTab: (tabId: number) => Promise<unknown>) {
  let socket: WebSocket | undefined;
  let connected = false;
  let status = 'Not paired';
  let shared: Record<string, string> = {};
  let snapshot: SharedTab[] = [];
  let snapshotting = false;
  let connecting = false;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  const running = new Map<string, PageCall>();
  const discovery = createDiscovery();
  const ready = chrome.storage.session.get('sharedTabs').then(value => { shared = z.record(z.string(), z.string()).catch({}).parse(value.sharedTabs); });
  const send = (message: unknown) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
  const saveSharing = () => chrome.storage.session.set({ sharedTabs: shared });

  async function inspect(tabId: number): Promise<SharedTab | undefined> {
    const origin = shared[String(tabId)]; if (!origin) return;
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || new URL(tab.url).origin !== origin) {
      delete shared[String(tabId)]; await saveSharing(); return;
    }
    if (tab.status === 'loading') return;
    const results = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: async () => {
      // Client-side routers can commit the URL before rendering the new page.
      if (window.navigation?.transition) return;
      const url = location.href;
      const runtime = window.webMCPDev;
      if (!runtime) return;
      await Promise.all(runtime.listPlugins().map(plugin => runtime.getPlugin(plugin.id)!.ready));
      await runtime.refreshTools();
      if (window.navigation?.transition || location.href !== url) return;
      return { url, title: document.title, tools: runtime.listTools(), runtimeVersion: runtime.version, plugins: runtime.listPlugins().map(plugin => ({ id: plugin.id, name: plugin.name, version: plugin.version })) };
    } });
    const frame = results[0];
    if (!frame?.result || !frame.documentId || shared[String(tabId)] !== origin || new URL(frame.result.url).origin !== origin) return;
    // Only here are both versions visible: what this document runs, and what the extension installed.
    const installed = await catalog;
    const plugins = (frame.result.plugins ?? []).map(plugin => {
      const expected = installed.find(entry => entry.id === plugin.id)?.version;
      return { ...plugin, ...(expected ? { expected } : {}), stale: !!expected && expected !== plugin.version };
    });
    return { tabId, documentId: frame.documentId, ...frame.result, plugins };
  }
  async function publish() {
    await ready;
    if (!connected || snapshotting) return;
    snapshotting = true;
    try {
      const results = await Promise.allSettled(Object.keys(shared).map(id => inspect(Number(id))));
      const next = results.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []);
      if (JSON.stringify(next) !== JSON.stringify(snapshot)) { snapshot = next; send({ type: 'snapshot', tabs: snapshot }); }
    } finally { snapshotting = false; }
  }
  async function cancel(id: string) {
    const call = running.get(id); if (!call) return;
    await chrome.scripting.executeScript({ target: { tabId: call.tabId, documentIds: [call.documentId] }, world: 'MAIN', args: [id],
      func: (id: string) => window.webMCPDev?.cancelRequest(id),
    }).catch(() => {});
  }
  async function execute(id: string, call: PageCall) {
    await ready;
    const origin = shared[String(call.tabId)];
    if (!origin || new URL(call.url).origin !== origin) return bridgeError('TAB_NOT_SHARED', 'This tab is no longer shared.');
    if ([...running.values()].some(item => item.tabId === call.tabId)) return bridgeError('TAB_BUSY', 'Another tool is running in this tab.');
    running.set(id, call);
    try {
      const tab = await chrome.tabs.get(call.tabId);
      if (shared[String(call.tabId)] !== origin) return bridgeError('TAB_NOT_SHARED', 'This tab is no longer shared.');
      if (tab.url !== call.url || tab.status === 'loading') return bridgeError('STALE_TAB', 'The page changed. Rediscover tools.');
      const results = await chrome.scripting.executeScript({ target: { tabId: call.tabId, documentIds: [call.documentId] }, world: 'MAIN',
        args: [id, call.name, JSON.stringify(call.input), call.url],
        func: async (id: string, name: string, serialized: string, url: string) => {
          if (location.href !== url) return { ok: false as const, error: { code: 'STALE_TAB', message: 'The page changed before execution.' } };
          return window.webMCPDev?.callRequest(id, name, JSON.parse(serialized)) ?? { ok: false as const, error: { code: 'NOT_ACTIVE', message: 'Refresh this page to activate the current extension.' } };
        },
      });
      const result = results[0]?.result;
      if (!result) return bridgeError('OUTCOME_UNKNOWN', 'The page changed before a result arrived. Inspect it before retrying an action.');
      // Navigation may replace the document or change its URL in place. Wait
      // for the updated page and registry so subsequent calls use that state.
      if (result.ok && typeof result.data === 'object' && result.data && 'navigation_started' in result.data && result.data.navigation_started) {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && connected && shared[String(call.tabId)]) {
          await new Promise(resolve => setTimeout(resolve, 150));
          const next = await inspect(call.tabId).catch(() => undefined);
          if (next && (next.documentId !== call.documentId || next.url !== call.url)) {
            await publish();
            // A concurrent snapshot may have made publish() return early.
            // Acknowledge only once the relay has the observed page metadata.
            if (snapshot.some(tab => tab.tabId === next.tabId && tab.documentId === next.documentId && tab.url === next.url)) return result;
          }
        }
        return bridgeError('NAVIGATION_PENDING', 'Navigation started but the new page is not ready. Refresh tools before continuing.');
      }
      await publish();
      return result;
    } finally { running.delete(id); }
  }
  async function connect() {
    if (connecting || socket && socket.readyState < WebSocket.CLOSING) return;
    connecting = true;
    try {
      const saved = await chrome.storage.local.get(['agentPairing', 'agentBrowserId']);
      const pair = pairingSchema.safeParse(saved.agentPairing);
      if (!pair.success) { status = 'Not paired'; return; }
      const browserId = typeof saved.agentBrowserId === 'string' ? saved.agentBrowserId : crypto.randomUUID();
      await chrome.storage.local.set({ agentBrowserId: browserId });
      status = 'Connecting to local bridge…';
      const ws = new WebSocket(`ws://127.0.0.1:${pair.data.port}/browser`);
      socket = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, browserId, token: pair.data.token }));
      ws.onmessage = event => {
        let message: any; try { message = JSON.parse(String(event.data)); } catch { ws.close(); return; }
        if (message.type === 'ready') {
          connected = true; status = 'Connected to local bridge'; snapshot = [];
          send({ type: 'snapshot', tabs: [] }); void publish();
        } else if (message.type === 'call' && typeof message.id === 'string') {
          const parsed = callSchema.safeParse(message.call);
          if (!parsed.success) { send({ type: 'result', id: message.id, result: bridgeError('INVALID_INPUT', 'Invalid tool request.') }); return; }
          void execute(message.id, parsed.data).then(
            result => { if (socket === ws) send({ type: 'result', id: message.id, result }); },
            () => { if (socket === ws) send({ type: 'result', id: message.id, result: bridgeError('OUTCOME_UNKNOWN', 'The tab changed or execution failed. Inspect the page before retrying an action.') }); },
          );
        } else if (message.type === 'cancel') void cancel(message.id);
      };
      ws.onclose = event => {
        if (socket !== ws) return;
        socket = undefined; connected = false; snapshot = [];
        status = event.code === 1008 ? 'Pairing rejected. Generate a new pairing code.' : 'Waiting for the local bridge…';
        for (const id of running.keys()) void cancel(id);
        if (event.code !== 1008) reconnect = setTimeout(() => { void connect(); }, 3000);
      };
    } finally { connecting = false; }
  }
  setInterval(() => { if (connected) send({ type: 'ping' }); discovery.ping(); }, 20_000);
  setInterval(() => { void discovery.connect().catch(() => {}); }, 3000);
  setInterval(() => { void publish().catch(() => {}); }, 2000);
  chrome.tabs.onUpdated.addListener((id, change) => {
    if (!shared[String(id)]) return;
    if (change.url && new URL(change.url).origin !== shared[String(id)]) {
      delete shared[String(id)]; void saveSharing();
      for (const [requestId, call] of running) if (call.tabId === id) void cancel(requestId);
    }
    void publish();
  });
  chrome.tabs.onRemoved.addListener(id => { delete shared[String(id)]; void saveSharing(); void publish(); });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!message?.type?.startsWith('agent:') || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
    void (async () => {
      await ready;
      if (message.type === 'agent:approve') {
        const tab = await chrome.tabs.get(message.tabId);
        if (!tab.url || !(await catalog).some(plugin => matchesSite(plugin, tab.url!))) throw new Error('Open the website you want to share, then approve from its extension popup.');
        const pair = await discovery.approve(message.requestId);
        const current = await chrome.tabs.get(message.tabId);
        if (current.url !== tab.url) throw new Error('The tab changed during approval. Open the extension on the intended page and request access again.');
        await chrome.storage.local.set({ agentPairing: pair });
        shared[String(message.tabId)] = new URL(tab.url).origin;
        await syncTab(message.tabId); await saveSharing();
        clearTimeout(reconnect); const previous = socket; socket = undefined; connected = false; previous?.close();
        await connect();
      } else if (message.type === 'agent:decline') {
        discovery.decline(message.requestId);
      } else if (message.type === 'agent:port') {
        const port = z.number().int().min(1024).max(65535).parse(message.port);
        await chrome.storage.local.remove('agentPairing');
        clearTimeout(reconnect); const previous = socket; socket = undefined; connected = false; previous?.close();
        for (const id of running.keys()) void cancel(id);
        shared = {}; snapshot = []; await saveSharing();
        status = 'Not paired'; await discovery.setPort(port);
      } else if (message.type === 'agent:pair') {
        const pair = pairingSchema.parse(JSON.parse(atob(String(message.code).trim())));
        await chrome.storage.local.set({ agentPairing: pair });
        await discovery.setPort(pair.port);
        clearTimeout(reconnect); const previous = socket; socket = undefined; connected = false; previous?.close();
        await connect();
      } else if (message.type === 'agent:disconnect') {
        await chrome.storage.local.remove('agentPairing');
        clearTimeout(reconnect); const previous = socket; socket = undefined; connected = false; previous?.close();
        for (const id of running.keys()) void cancel(id);
        shared = {}; snapshot = []; await saveSharing(); status = 'Not paired';
      } else if (message.type === 'agent:share') {
        if (!connected) throw new Error('Ask your agent to request a connection, then approve it here.');
        const tab = await chrome.tabs.get(message.tabId);
        if (!tab.url || !(await catalog).some(plugin => matchesSite(plugin, tab.url!))) throw new Error('Open a supported website to share this tab.');
        shared[String(message.tabId)] = new URL(tab.url).origin; await saveSharing();
        await syncTab(message.tabId); await publish();
      } else if (message.type === 'agent:unshare') {
        delete shared[String(message.tabId)]; await saveSharing();
        for (const [id, call] of running) if (call.tabId === message.tabId) void cancel(id);
        await publish();
      }
      await discovery.connect();
      const found = discovery.state();
      return { ok: true, workerVersion: '0.5.0', status: connected ? status : found.available ? 'Ready for agent requests' : 'Waiting for your local agent…', connected, shared: !!shared[String(message.tabId)], requests: found.requests, port: found.port };
    })().then(respond, error => respond({ ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }));
    return true;
  });
  // Register the message handler before optional APIs: a popup from a new build
  // can coexist with an older loaded manifest that lacks the alarms permission.
  if (chrome.alarms) {
    void chrome.alarms.create('webmcp-connect', { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'webmcp-connect') { void connect(); void discovery.connect(); } });
  }
  void connect().catch(() => {});
  void discovery.connect().catch(() => {});
}
