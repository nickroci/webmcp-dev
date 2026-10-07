import type { PluginBundle } from '../src/mcp/protocol';
import { disabledPluginIds } from './settings';

/** Agent-installed plugins: compiled by the local bridge, kept in extension storage so they
 * survive bridge restarts, and injected through chrome.userScripts, the API Chrome provides
 * for code the extension did not ship with. */
const SCRIPT_PREFIX = 'webmcp-plugin-';

/** chrome.userScripts exists only once the user allowed user scripts for this extension (Chrome 138+:
 * the Allow User Scripts toggle on its details page; earlier: Developer mode). */
export const userScriptsAvailable = () => typeof chrome.userScripts?.execute === 'function';

export async function devModeEnabled(): Promise<boolean> {
  const { agentDevMode } = await chrome.storage.local.get('agentDevMode');
  return agentDevMode === true;
}

export async function dynamicPlugins(): Promise<PluginBundle[]> {
  const { dynamicPlugins = {} } = await chrome.storage.local.get('dynamicPlugins');
  return Object.values(dynamicPlugins as Record<string, PluginBundle>).filter(plugin => plugin && typeof plugin.code === 'string' && Array.isArray(plugin.matches));
}
export async function saveDynamicPlugins(bundles: PluginBundle[], options: { replaceAll?: boolean } = {}) {
  const { dynamicPlugins = {} } = await chrome.storage.local.get('dynamicPlugins');
  const next: Record<string, PluginBundle> = options.replaceAll ? {} : { ...(dynamicPlugins as Record<string, PluginBundle>) };
  for (const bundle of bundles) next[bundle.id] = bundle;
  await chrome.storage.local.set({ dynamicPlugins: next });
}
export async function deleteDynamicPlugin(id: string): Promise<PluginBundle | undefined> {
  const { dynamicPlugins = {} } = await chrome.storage.local.get('dynamicPlugins');
  const all = dynamicPlugins as Record<string, PluginBundle>;
  const removed = all[id];
  delete all[id];
  await chrome.storage.local.set({ dynamicPlugins: all });
  return removed;
}

/** Make Chrome's registered user scripts match the enabled agent-installed plugins, so matching
 * pages activate them on load without the extension worker being awake. */
let reconciling: Promise<void> = Promise.resolve();
export function reconcileUserScripts(): Promise<void> {
  // Storage changes and explicit installs both ask for this; Chrome rejects a concurrent duplicate registration.
  const task = reconciling.catch(() => {}).then(reconcile);
  reconciling = task;
  return task;
}
async function reconcile(): Promise<void> {
  if (!userScriptsAvailable()) return;
  const [plugins, { disabledPlugins = [] }] = await Promise.all([dynamicPlugins(), chrome.storage.local.get('disabledPlugins')]);
  const disabled = disabledPluginIds(disabledPlugins);
  const desired = plugins.filter(plugin => !disabled.includes(plugin.id));
  const registered = (await chrome.userScripts.getScripts()).filter(script => script.id.startsWith(SCRIPT_PREFIX));
  const stale = registered.filter(script => !desired.some(plugin => SCRIPT_PREFIX + plugin.id === script.id)).map(script => script.id);
  if (stale.length) await chrome.userScripts.unregister({ ids: stale });
  const scripts = desired.map(plugin => ({ id: SCRIPT_PREFIX + plugin.id, matches: plugin.matches, js: [{ code: plugin.code }], world: 'MAIN' as const, runAt: 'document_idle' as const }));
  const toRegister = scripts.filter(script => !registered.some(existing => existing.id === script.id));
  const toUpdate = scripts.filter(script => registered.some(existing => existing.id === script.id));
  if (toRegister.length) await chrome.userScripts.register(toRegister);
  if (toUpdate.length) await chrome.userScripts.update(toUpdate);
}

/** Run one agent-installed bundle in an open tab right now. Page CSP does not apply to user scripts. */
export async function injectDynamicPlugin(tabId: number, plugin: PluginBundle): Promise<void> {
  if (!userScriptsAvailable()) throw new Error('Chrome has not allowed user scripts for this extension. Turn on Allow User Scripts on its details page.');
  const [frame] = await chrome.userScripts.execute({ target: { tabId }, world: 'MAIN', js: [{ code: plugin.code }] });
  if (frame?.error) throw new Error(frame.error);
}
