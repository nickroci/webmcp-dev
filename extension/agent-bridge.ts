import { z } from 'zod';
import { matchesSite } from '../src/core/matches';
import type { PluginCatalogEntry } from '../src/core/types';
import { bridgeError, callSchema, pairingSchema, pluginBundleSchema, PROTOCOL_VERSION, type Activation, type BridgeResult, type BrowserCapabilities, type PageCall, type PluginBundle, type SharedTab } from '../src/mcp/protocol';
import type { SyncResult } from './background';
import { createDiscovery } from './discovery';
import { deleteDynamicPlugin, devModeEnabled, dynamicPlugins, reconcileUserScripts, saveDynamicPlugins, userScriptsAvailable } from './dynamic';

export const WORKER_VERSION = '0.6.0';
const EVALUATION_LIMIT = 200_000;
const DEV_MODE_OFF = 'Agent plugin development is off. Ask the user to enable "Let agents develop plugins" in WebMCP Dev → Agents.';
const USER_SCRIPTS_OFF = 'Chrome has not allowed user scripts for this extension. Ask the user to turn on Allow User Scripts on the extension’s details page in chrome://extensions. It takes effect at once.';
const isWebPage = (url: string | undefined): url is string => /^https?:/.test(url ?? '');

/** Runs only in the extension worker. Pairing credentials never enter the page. */
export function startAgentBridge(catalog: () => Promise<PluginCatalogEntry[]>, syncTab: (tabId: number) => Promise<SyncResult>) {
  let socket: WebSocket | undefined;
  let connected = false;
  let status = 'Not paired';
  let shared: Record<string, string> = {};
  let snapshot: SharedTab[] = [];
  let snapshotSignature = '';
  let snapshotting = false;
  let connecting = false;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  const running = new Map<string, PageCall>();
  const healed = new Set<string>();
  const discovery = createDiscovery();
  const ready = chrome.storage.session.get('sharedTabs').then(value => { shared = z.record(z.string(), z.string()).catch({}).parse(value.sharedTabs); });
  const send = (message: unknown) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
  const saveSharing = () => chrome.storage.session.set({ sharedTabs: shared });
  const capabilities = async (): Promise<BrowserCapabilities> => ({ devMode: await devModeEnabled(), userScripts: userScriptsAvailable(), extensionVersion: chrome.runtime.getManifest().version });

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
      // A shared page without any plugin is still a shared page: an agent may be about to build one.
      if (!runtime) return { url, title: document.title, tools: [], plugins: [] };
      await Promise.all(runtime.listPlugins().map(plugin => runtime.getPlugin(plugin.id)!.ready));
      await runtime.refreshTools();
      if (window.navigation?.transition || location.href !== url) return;
      return { url, title: document.title, tools: runtime.listTools(), runtimeVersion: runtime.version, plugins: runtime.listPlugins().map(plugin => ({ id: plugin.id, name: plugin.name, version: plugin.version, revision: plugin.revision })) };
    } });
    const frame = results[0];
    if (!frame?.result || !frame.documentId || shared[String(tabId)] !== origin || new URL(frame.result.url).origin !== origin) return;
    // Only here are both versions visible: what this document runs, and what the extension installed.
    const installed = await catalog();
    const plugins = (frame.result.plugins ?? []).map(plugin => {
      const expected = installed.find(entry => entry.id === plugin.id);
      const stale = !!expected && (expected.revision ? expected.revision !== plugin.revision : expected.version !== plugin.version);
      return { ...plugin, ...(expected?.source ? { source: expected.source } : {}), ...(expected ? { expected: expected.version } : {}), ...(expected?.revision ? { expectedRevision: expected.revision } : {}), stale };
    });
    // A document keeps the revision it loaded. Re-run the installed bundles once per document and
    // revision; they replace older copies of themselves, so no reload or new tab is needed.
    if (plugins.some(plugin => plugin.stale)) {
      const key = `${frame.documentId}:${plugins.filter(plugin => plugin.stale).map(plugin => plugin.expectedRevision ?? plugin.expected).join(',')}`;
      if (!healed.has(key)) { if (healed.size > 500) healed.clear(); healed.add(key); void syncTab(tabId).catch(() => {}); }
    }
    return { tabId, documentId: frame.documentId, ...frame.result, plugins };
  }
  async function publish() {
    await ready;
    if (!connected || snapshotting) return;
    snapshotting = true;
    try {
      const results = await Promise.allSettled(Object.keys(shared).map(id => inspect(Number(id))));
      const next = results.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []);
      const able = await capabilities();
      const signature = JSON.stringify({ next, able });
      if (signature !== snapshotSignature) { snapshot = next; snapshotSignature = signature; send({ type: 'snapshot', tabs: snapshot, capabilities: able }); }
    } finally { snapshotting = false; }
  }
  async function cancel(id: string) {
    const call = running.get(id); if (!call) return;
    await chrome.scripting.executeScript({ target: { tabId: call.tabId, documentIds: [call.documentId] }, world: 'MAIN', args: [id],
      func: (id: string) => window.webMCPDev?.cancelRequest(id),
    }).catch(() => {});
  }
  async function evaluate(id: string, call: PageCall & { code: string }): Promise<BridgeResult> {
    if (!(await devModeEnabled())) return bridgeError('DEV_MODE_DISABLED', DEV_MODE_OFF);
    if (!userScriptsAvailable()) return bridgeError('USER_SCRIPTS_UNAVAILABLE', USER_SCRIPTS_OFF);
    const key = `eval-${id}`;
    // The script's completion value is this promise; Chrome awaits it and hands back the string.
    const wrapped = `(window.__webMCPDevEval ??= {})[${JSON.stringify(key)}] = (async () => {
  try {
    const value = await (async () => {\n${call.code}\n})();
    let text;
    try { text = JSON.stringify(value === undefined ? null : value) ?? 'null'; }
    catch (error) { return JSON.stringify({ ok: false, error: { code: 'NOT_SERIALIZABLE', message: 'The result is not JSON-serializable: ' + String(error) } }); }
    return JSON.stringify(text.length > ${EVALUATION_LIMIT} ? { ok: true, truncated: true, text: text.slice(0, ${EVALUATION_LIMIT}) } : { ok: true, text });
  } catch (error) {
    return JSON.stringify({ ok: false, error: { code: 'EVALUATION_ERROR', message: error instanceof Error ? error.message : String(error), details: error instanceof Error && error.stack ? error.stack.split('\\n').slice(0, 6).join('\\n') : undefined } });
  }
})();`;
    const target = { tabId: call.tabId, documentIds: [call.documentId] };
    const timeout = new Promise<BridgeResult>(resolve => setTimeout(() => resolve(bridgeError('EVALUATION_TIMEOUT', 'The code did not finish within 30 seconds. Return sooner, or move long work into a plugin tool that honors its AbortSignal.')), 30_000));
    const run = (async (): Promise<BridgeResult> => {
      let raw: unknown;
      try {
        const [frame] = await chrome.userScripts.execute({ target, world: 'MAIN', js: [{ code: wrapped }] });
        if (frame?.error) return bridgeError('EVALUATION_ERROR', frame.error);
        raw = frame?.result;
      } catch (error) { return bridgeError('EVALUATION_ERROR', error instanceof Error ? error.message : String(error)); }
      if (typeof raw !== 'string') {
        const [frame] = await chrome.scripting.executeScript({ target, world: 'MAIN', args: [key], func: async (key: string) => {
          const pending = window.__webMCPDevEval?.[key];
          return pending ? await pending : undefined;
        } });
        raw = frame?.result;
      }
      void chrome.scripting.executeScript({ target, world: 'MAIN', args: [key], func: (key: string) => { delete window.__webMCPDevEval?.[key]; } }).catch(() => {});
      if (typeof raw !== 'string') return bridgeError('EVALUATION_ERROR', 'The code produced no result. A syntax error stops the script before it runs; check the code.');
      const parsed = JSON.parse(raw) as { ok: true; text: string; truncated?: boolean } | { ok: false; error: { code: string; message: string; details?: unknown } };
      if (!parsed.ok) return bridgeError(parsed.error.code, parsed.error.message, parsed.error.details);
      return { ok: true, data: parsed.truncated ? { truncated: true, text: parsed.text } : JSON.parse(parsed.text) };
    })();
    return Promise.race([run, timeout]);
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
      if (call.code !== undefined) {
        const outcome = await evaluate(id, { ...call, code: call.code });
        await publish();
        return outcome;
      }
      const results = await chrome.scripting.executeScript({ target: { tabId: call.tabId, documentIds: [call.documentId] }, world: 'MAIN',
        args: [id, call.name ?? '', JSON.stringify(call.input ?? null), call.url],
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
  /** Open web tabs the plugin's own matcher accepts; the same matcher decides injection in the page. */
  const matchingTabs = async (plugin: { matches: string[] }) => {
    const tabs = await chrome.tabs.query({});
    // Shared tabs are the ones an agent is waiting on; include them even if the query missed them.
    for (const id of Object.keys(shared)) if (!tabs.some(tab => tab.id === Number(id))) tabs.push(await chrome.tabs.get(Number(id)).catch(() => undefined as unknown as chrome.tabs.Tab));
    return tabs.filter((tab): tab is chrome.tabs.Tab & { id: number; url: string } => !!tab && tab.id !== undefined && isWebPage(tab.url) && matchesSite(plugin, tab.url));
  };
  /** Activate one bundle in every open matching tab and report what each document now runs. */
  async function activate(plugin: PluginBundle): Promise<Activation[]> {
    const activations: Activation[] = [];
    for (const tab of await matchingTabs(plugin)) {
      const base = { tabId: tab.id, url: tab.url, shared: !!shared[String(tab.id)] };
      try {
        const result = await syncTab(tab.id);
        const state = result.plugins.find(entry => entry.id === plugin.id);
        const error = result.errors.find(message => message.startsWith(`${plugin.name}:`))?.slice(plugin.name.length + 1).trim() ?? state?.error;
        activations.push({ ...base, ok: !!state?.ok && !error, ...(error ? { error } : {}), tools: state?.tools ?? [], ...(state?.refreshError ? { refreshError: state.refreshError } : {}), ...(state?.registrationErrors?.length ? { registrationErrors: state.registrationErrors } : {}) });
      } catch (error) { activations.push({ ...base, ok: false, error: error instanceof Error ? error.message : String(error) }); }
    }
    return activations;
  }
  async function install(message: unknown): Promise<{ ok: boolean; error?: string; tabs?: Activation[] }> {
    const parsed = pluginBundleSchema.safeParse(message);
    if (!parsed.success) return { ok: false, error: 'Invalid plugin bundle.' };
    if (!(await devModeEnabled())) return { ok: false, error: DEV_MODE_OFF };
    if (!userScriptsAvailable()) return { ok: false, error: USER_SCRIPTS_OFF };
    await saveDynamicPlugins([parsed.data]);
    await reconcileUserScripts();
    const tabs = await activate(parsed.data);
    snapshotSignature = ''; await publish();
    return { ok: true, tabs };
  }
  /** The relay's catalog is authoritative while connected: adopt new revisions, drop plugins it no longer has. */
  async function adoptCatalog(message: unknown) {
    const parsed = z.array(pluginBundleSchema).max(200).safeParse(message);
    if (!parsed.success || !(await devModeEnabled())) return;
    const before = new Map((await dynamicPlugins()).map(plugin => [plugin.id, plugin]));
    await saveDynamicPlugins(parsed.data, { replaceAll: true });
    await reconcileUserScripts();
    for (const [id, previous] of before) if (!parsed.data.some(plugin => plugin.id === id)) await dispose(previous);
    for (const plugin of parsed.data) if (before.get(plugin.id)?.revision !== plugin.revision) await activate(plugin);
    snapshotSignature = ''; await publish();
  }
  async function dispose(plugin: PluginBundle) {
    for (const tab of await matchingTabs(plugin)) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', args: [plugin.id], func: (id: string) => window.webMCPDev?.unregisterPlugin(id) }).catch(() => {});
    }
  }
  async function remove(pluginId: string, notifyRelay: boolean) {
    const removed = await deleteDynamicPlugin(pluginId);
    await reconcileUserScripts();
    if (removed) await dispose(removed);
    if (notifyRelay) send({ type: 'plugin-removed', pluginId });
    snapshotSignature = ''; await publish();
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
          connected = true; status = 'Connected to local bridge'; snapshot = []; snapshotSignature = '';
          void capabilities().then(able => { send({ type: 'snapshot', tabs: [], capabilities: able }); return publish(); });
        } else if (message.type === 'call' && typeof message.id === 'string') {
          const parsed = callSchema.safeParse(message.call);
          if (!parsed.success) { send({ type: 'result', id: message.id, result: bridgeError('INVALID_INPUT', 'Invalid tool request.') }); return; }
          void execute(message.id, parsed.data).then(
            result => { if (socket === ws) send({ type: 'result', id: message.id, result }); },
            () => { if (socket === ws) send({ type: 'result', id: message.id, result: bridgeError('OUTCOME_UNKNOWN', 'The tab changed or execution failed. Inspect the page before retrying an action.') }); },
          );
        } else if (message.type === 'cancel') void cancel(message.id);
        else if (message.type === 'catalog') void adoptCatalog(message.plugins).catch(console.warn);
        else if (message.type === 'install' && typeof message.id === 'string') {
          void install(message.plugin).then(
            result => { if (socket === ws) send({ type: 'reply', id: message.id, result }); },
            error => { if (socket === ws) send({ type: 'reply', id: message.id, result: { ok: false, error: error instanceof Error ? error.message : String(error) } }); },
          );
        } else if (message.type === 'remove' && typeof message.pluginId === 'string') void remove(message.pluginId, false).catch(console.warn);
      };
      ws.onclose = event => {
        if (socket !== ws) return;
        socket = undefined; connected = false; snapshot = []; snapshotSignature = '';
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
        if (!isWebPage(tab.url)) throw new Error('Open the website you want to share, then approve from its extension popup.');
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
        // Any web page can be shared: a site without a plugin is where an agent builds one.
        if (!isWebPage(tab.url)) throw new Error('Open a website to share this tab.');
        shared[String(message.tabId)] = new URL(tab.url).origin; await saveSharing();
        await syncTab(message.tabId); snapshotSignature = ''; await publish();
      } else if (message.type === 'agent:unshare') {
        delete shared[String(message.tabId)]; await saveSharing();
        for (const [id, call] of running) if (call.tabId === message.tabId) void cancel(id);
        await publish();
      } else if (message.type === 'agent:devmode') {
        await chrome.storage.local.set({ agentDevMode: message.enabled === true });
        snapshotSignature = ''; await publish();
      } else if (message.type === 'agent:remove-plugin') {
        await remove(z.string().parse(message.pluginId), true);
      }
      await discovery.connect();
      const found = discovery.state();
      const able = await capabilities();
      return { ok: true, workerVersion: WORKER_VERSION, status: connected ? status : found.available ? 'Ready for agent requests' : 'Waiting for your local agent…', connected, shared: !!shared[String(message.tabId)], requests: found.requests, port: found.port, devMode: able.devMode, userScripts: able.userScripts };
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
