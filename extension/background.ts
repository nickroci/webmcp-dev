import { startAgentBridge } from './agent-bridge';
import { matchesSite } from '../src/core/matches';
import type { PluginCatalogEntry } from '../src/core/types';
import { disabledPluginIds } from './settings';

const catalogPromise: Promise<PluginCatalogEntry[]> = fetch(chrome.runtime.getURL('plugins.json')).then(response => response.json());
const queued = new Map<number, Promise<unknown>>();

async function sync(tabId: number) {
  const catalog = await catalogPromise;
  const tab = await chrome.tabs.get(tabId);
  const matching = catalog.filter(plugin => matchesSite(plugin, tab.url ?? ''));
  if (!matching.length) return { ok: true, active: [], errors: [] };
  const { disabledPlugins = [] } = await chrome.storage.local.get('disabledPlugins');
  const enabled = matching.filter(plugin => !disabledPluginIds(disabledPlugins).includes(plugin.id));
  const disabled = catalog.filter(plugin => !enabled.includes(plugin)).map(plugin => plugin.id);
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', args: [disabled], func: (ids: string[]) => {
    for (const id of ids) window.webMCPDev?.unregisterPlugin(id);
  } });
  const errors: string[] = [];
  for (const plugin of enabled) {
    try { await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: [plugin.file] }); }
    catch (error) { errors.push(`${plugin.name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { ok: true, active: enabled.map(plugin => plugin.id), errors };
}

function syncTab(tabId: number) {
  // Serialize setting changes, popup actions, and document-load signals per tab.
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
  const catalog = await catalogPromise;
  const tabs = await chrome.tabs.query({ url: [...new Set(catalog.flatMap(plugin => plugin.matches))] });
  await Promise.allSettled(tabs.filter(tab => tab.id !== undefined).map(tab => syncTab(tab.id!)));
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.disabledPlugins) void syncOpenTabs().catch(console.warn);
});
chrome.runtime.onInstalled.addListener(() => { void syncOpenTabs().catch(console.warn); });

startAgentBridge(catalogPromise, syncTab);
