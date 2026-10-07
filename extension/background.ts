import { startAgentBridge } from './agent-bridge';
import { matchesSite } from '../src/core/matches';
import type { PluginCatalogEntry } from '../src/core/types';
import { disabledPluginIds } from './settings';
import { dynamicPlugins, injectDynamicPlugin, reconcileUserScripts } from './dynamic';

const staticCatalog: Promise<PluginCatalogEntry[]> = fetch(chrome.runtime.getURL('plugins.json')).then(response => response.json())
  .then((list: PluginCatalogEntry[]) => list.map(plugin => ({ ...plugin, source: 'static' as const })));
const queued = new Map<number, Promise<SyncResult>>();

/** Built-in plugins plus agent-installed ones, without their code. */
export async function catalog(): Promise<PluginCatalogEntry[]> {
  const [statics, dynamics] = await Promise.all([staticCatalog, dynamicPlugins()]);
  return [...statics, ...dynamics.map(({ code: _code, ...plugin }) => plugin)];
}
export interface PluginState { id: string; ok: boolean; error?: string; revision?: string; tools: string[]; refreshError?: string; registrationErrors: string[] }
export interface SyncResult { ok: true; active: string[]; errors: string[]; plugins: PluginState[] }

async function sync(tabId: number): Promise<SyncResult> {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url ?? '';
  const [statics, dynamics] = await Promise.all([staticCatalog, dynamicPlugins()]);
  const all: Array<PluginCatalogEntry & { code?: string }> = [...statics, ...dynamics];
  const matching = all.filter(plugin => matchesSite(plugin, url));
  if (!matching.length) return { ok: true, active: [], errors: [], plugins: [] };
  const { disabledPlugins = [] } = await chrome.storage.local.get('disabledPlugins');
  const disabled = disabledPluginIds(disabledPlugins);
  const enabled = matching.filter(plugin => !disabled.includes(plugin.id));
  const retired = all.filter(plugin => !enabled.includes(plugin)).map(plugin => plugin.id);
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', args: [retired], func: (ids: string[]) => {
    for (const id of ids) window.webMCPDev?.unregisterPlugin(id);
  } });
  const errors: string[] = [];
  for (const plugin of enabled) {
    try {
      // Each bundle replaces an older revision of itself in the document, so re-running is how updates land.
      if (plugin.code === undefined) await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: [plugin.file] });
      else await injectDynamicPlugin(tabId, { ...plugin, code: plugin.code } as Parameters<typeof injectDynamicPlugin>[1]);
    } catch (error) { errors.push(`${plugin.name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const [frame] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', args: [enabled.map(plugin => plugin.id)], func: async (ids: string[]) => {
    const runtime = window.webMCPDev;
    const activationErrors = window.__webMCPDevErrors ?? {};
    await Promise.all(ids.map(id => runtime?.getPlugin(id)?.ready));
    return ids.map(id => {
      const plugin = runtime?.listPlugins().find(entry => entry.id === id);
      return {
        id, ok: !!plugin && !plugin.disposed, error: activationErrors[id], revision: plugin?.revision,
        tools: runtime?.listTools().filter(tool => tool.pluginId === id).map(tool => tool.name) ?? [],
        refreshError: plugin?.refreshError, registrationErrors: plugin?.registrationErrors ?? [],
      };
    });
  } });
  return { ok: true, active: enabled.map(plugin => plugin.id), errors, plugins: (frame?.result as PluginState[] | undefined) ?? [] };
}

function syncTab(tabId: number): Promise<SyncResult> {
  // Serialize setting changes, popup actions, bridge installs, and document-load signals per tab.
  const task = (queued.get(tabId) ?? Promise.resolve()).catch(() => {}).then(() => sync(tabId));
  queued.set(tabId, task);
  void task.finally(() => { if (queued.get(tabId) === task) queued.delete(tabId); }).catch(() => {});
  return task;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== 'sync') return;
  const extensionPage = sender.url?.startsWith(chrome.runtime.getURL(''));
  const tabId = extensionPage ? message.tabId : sender.frameId === 0 ? sender.tab?.id : undefined;
  if (!Number.isInteger(tabId)) { respond({ ok: false, error: 'No supported target tab.' }); return; }
  void syncTab(tabId).then(respond, error => respond({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

async function syncOpenTabs() {
  const plugins = await catalog();
  const tabs = (await chrome.tabs.query({})).filter(tab => tab.id !== undefined && plugins.some(plugin => matchesSite(plugin, tab.url ?? '')));
  await Promise.allSettled(tabs.map(tab => syncTab(tab.id!)));
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.disabledPlugins) { void reconcileUserScripts().catch(console.warn); void syncOpenTabs().catch(console.warn); }
  else if (changes.dynamicPlugins) void reconcileUserScripts().catch(console.warn);
});
// Chrome drops registered user scripts when the extension reloads; open documents keep running
// whatever revision they loaded, so bring both back in line with the installed catalog.
chrome.runtime.onInstalled.addListener(() => { void reconcileUserScripts().catch(console.warn); void syncOpenTabs().catch(console.warn); });
chrome.runtime.onStartup.addListener(() => { void reconcileUserScripts().catch(console.warn); });

startAgentBridge(catalog, syncTab);
