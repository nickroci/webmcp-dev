import { sendWorkerMessage, WorkerUnavailableError } from './messages';
import { matchesSite } from '../src/core/matches';
import type { PluginCatalogEntry, RegisteredTool } from '../src/core/types';
import type { ToolResult } from '../src/errors';
import { renderFields } from './forms';
import { disabledPluginIds } from './settings';

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
let tabId: number | undefined;
let tabUrl = '';
let catalog: PluginCatalogEntry[] = [];
let tools: RegisteredTool[] = [];
let readFields = (): Record<string, unknown> => ({});
let jsonMode = false;
let result: ToolResult | undefined;

async function inTab<T>(func: () => T | Promise<T>): Promise<T> {
  const response = await chrome.scripting.executeScript({ target: { tabId: tabId! }, world: 'MAIN', func });
  if (!response.length || response[0].result === undefined) throw new Error('The target tab changed. Reopen this popup after it loads.');
  return response[0].result as T;
}
function selected() { return tools.find(tool => tool.name === $<HTMLSelectElement>('#tool').value); }
function renderTool() {
  const tool = selected(); if (!tool) return;
  jsonMode = false;
  $('#fields').hidden = false; $('#json-label').hidden = true;
  $<HTMLFieldSetElement>('#fields').disabled = false;
  $('#input-mode').textContent = 'Use JSON';
  $('#description').textContent = tool.description;
  $('#run').textContent = tool.buttonLabel ?? 'Run tool';
  $('#schema').textContent = JSON.stringify(tool, null, 2);
  const badges = $('#badges'); badges.replaceChildren();
  for (const text of [tool.pluginName, tool.annotations.readOnlyHint ? 'Read only' : tool.annotations.consequentialHint ? 'Publishes or changes data' : 'Changes page']) {
    const badge = document.createElement('span'); badge.className = `badge ${tool.annotations.consequentialHint ? 'consequential' : ''}`; badge.textContent = text; badges.append(badge);
  }
  readFields = renderFields($('#fields'), tool);
}

async function loadTools() {
  tools = [];
  const supported = tabId !== undefined && catalog.some(plugin => matchesSite(plugin, tabUrl));
  if (supported) {
    const sync = await sendWorkerMessage({ type: 'sync', tabId });
    if (!sync.ok || sync.errors?.length) throw new Error(sync.error ?? sync.errors.join('; '));
    const state = await inTab(async () => {
      const runtime = window.webMCPDev;
      if (!runtime) return { plugins: [], tools: [] };
      await Promise.all(runtime.listPlugins().map(plugin => runtime.getPlugin(plugin.id)!.ready));
      await runtime.refreshTools();
      return { plugins: runtime.listPlugins(), tools: runtime.listTools() };
    });
    tools = state.tools;
    const errors = state.plugins.flatMap(plugin => [...plugin.registrationErrors, ...(plugin.refreshError ? [plugin.refreshError] : [])]);
    const mode = state.plugins.some(plugin => plugin.mode !== 'local') ? 'WebMCP' : 'local tools';
    $('#status').textContent = errors.length ? `Local tools available; native registration failed: ${errors.join('; ')}` : `${state.plugins.length} active plugin(s) · ${mode}`;
  } else $('#status').textContent = 'No installed plugin matches this page.';
  const select = $<HTMLSelectElement>('#tool');
  const previous = select.value;
  select.replaceChildren();
  for (const tool of tools) select.append(new Option(`${tool.pluginName} · ${tool.title ?? tool.name}`, tool.name));
  select.value = tools.some(tool => tool.name === previous) ? previous : (tools.find(tool => tool.annotations.readOnlyHint) ?? tools[0])?.name ?? '';
  $('#tool-form').hidden = !tools.length; $('#empty').hidden = !!tools.length;
  $('#tool-count').textContent = `${tools.length} tools available.`;
  renderTool();
}

async function renderPlugins() {
  const { disabledPlugins = [] } = await chrome.storage.local.get('disabledPlugins');
  const container = $('#plugins'); container.replaceChildren();
  for (const plugin of catalog) {
    const card = document.createElement('article'); card.className = 'plugin';
    const label = document.createElement('label'); label.append(document.createTextNode(`${plugin.name} · ${plugin.version}`));
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = !disabledPluginIds(disabledPlugins).includes(plugin.id); checkbox.setAttribute('aria-label', `Enable ${plugin.name}`);
    checkbox.addEventListener('change', async () => {
      checkbox.disabled = true;
      try {
        const current = await chrome.storage.local.get('disabledPlugins');
        const disabled = new Set(disabledPluginIds(current.disabledPlugins));
        checkbox.checked ? disabled.delete(plugin.id) : disabled.add(plugin.id);
        await chrome.storage.local.set({ disabledPlugins: [...disabled] });
        await loadTools();
      } catch (error) { showError(error); }
      finally { checkbox.disabled = false; }
    });
    label.append(checkbox); card.append(label);
    const description = document.createElement('p'); description.textContent = plugin.description; card.append(description);
    const matches = document.createElement('code'); matches.textContent = plugin.matches.join(' · '); card.append(matches);
    const here = document.createElement('p'); here.textContent = matchesSite(plugin, tabUrl) ? 'Matches this page' : 'Available on its matching sites'; card.append(here);
    container.append(card);
  }
}

function showError(error: unknown) { $('#status').textContent = error instanceof Error ? error.message : String(error); if (error instanceof WorkerUnavailableError) $('#reload-extension').hidden = false; }
function selectView(name: string) {
  for (const view of ['tools', 'plugins', 'agents']) $(`#${view}-view`).hidden = view !== name;
  document.querySelectorAll<HTMLElement>('[data-view]').forEach(item => item.setAttribute('aria-pressed', String(item.dataset.view === name)));
}
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => button.addEventListener('click', () => selectView(button.dataset.view!)));
$('#reload-extension').addEventListener('click', () => chrome.runtime.reload());
$('#tool').addEventListener('change', renderTool);
$('#refresh').addEventListener('click', () => { void loadTools().catch(showError); });
$('#input-mode').addEventListener('click', () => {
  try {
    if (!jsonMode) $<HTMLTextAreaElement>('#json-input').value = JSON.stringify(readFields(), null, 2);
    else {
      const input = JSON.parse($<HTMLTextAreaElement>('#json-input').value);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Form inputs must be a JSON object.');
      const tool = selected()!;
      if (Object.keys(input).some(key => !(key in (tool.inputSchema.properties ?? {})))) throw new Error('These arguments need JSON mode because they contain fields outside the generated form.');
      readFields = renderFields($('#fields'), tool, input);
    }
    jsonMode = !jsonMode;
    $('#fields').hidden = jsonMode; $('#json-label').hidden = !jsonMode;
    $<HTMLFieldSetElement>('#fields').disabled = jsonMode;
    $('#input-mode').textContent = jsonMode ? 'Use form' : 'Use JSON';
  } catch (error) { showError(error); }
});
$('#tool-form').addEventListener('submit', async event => {
  event.preventDefault();
  const tool = selected(); if (!tool || tabId === undefined) return;
  const run = $<HTMLButtonElement>('#run');
  run.disabled = true; $('#status').textContent = `Running ${tool.title ?? tool.name}…`;
  try {
    const args = jsonMode ? JSON.parse($<HTMLTextAreaElement>('#json-input').value) : readFields();
    // Pass one JSON string: Chrome's argument conversion can omit null object values.
    const response = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', args: [tool.name, JSON.stringify(args)], func: async (name: string, serializedInput: string) => {
      const runtime = window.webMCPDev;
      return runtime ? runtime.callTool(name, JSON.parse(serializedInput)) : { ok: false, error: { code: 'NOT_ACTIVE', message: 'Refresh the tools after the page finishes loading.' } };
    } });
    result = response[0]?.result as ToolResult | undefined;
    if (!result) throw new Error('The tab changed before a result arrived.');
    $('#output').hidden = false; $('#result').textContent = JSON.stringify(result, null, 2);
    $('#status').textContent = result.ok ? 'Done' : result.error.message;
  } catch (error) { showError(error); }
  finally { run.disabled = false; }
});
$('#copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(JSON.stringify(result, null, 2)); $('#copy').textContent = 'Copied'; }
  catch { $('#copy').textContent = 'Select JSON to copy'; }
});

async function start() {
  catalog = await fetch(chrome.runtime.getURL('plugins.json')).then(response => response.json());
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id; tabUrl = tab?.url ?? '';
  $('#site').textContent = /^https?:/.test(tabUrl) ? new URL(tabUrl).hostname : 'Open a supported website';
  await renderPlugins();
  await loadTools().catch(showError);
  await agentAction().catch(agentError);
  if (requestSignature && requestSignature !== '[]') selectView('agents');
}
void start().catch(showError);

let sharing = false;
let requestSignature = '';
let agentBusy = false;
async function agentAction(type = 'agent:status', extra: Record<string, unknown> = {}) {
  const state = await sendWorkerMessage({ type, tabId, ...extra });
  if (!state.ok) throw new Error(state.error ?? 'The extension could not complete this action.');
  if (state.workerVersion !== '0.4.0') throw new WorkerUnavailableError();
  sharing = state.shared;
  $('#reload-extension').hidden = true;
  $('#agent-status').textContent = `${state.status}${sharing ? ' · This tab is shared' : ''}`;
  const supported = tabId !== undefined && catalog.some(plugin => matchesSite(plugin, tabUrl));
  $('#share-tab').textContent = sharing ? 'Stop sharing this tab' : 'Share this tab';
  $<HTMLButtonElement>('#share-tab').disabled = !supported || !state.connected;
  $<HTMLButtonElement>('#disconnect-agent').disabled = !state.connected && !sharing;
  if (document.activeElement !== $('#bridge-port')) $<HTMLInputElement>('#bridge-port').value = String(state.port);
  const requests = state.requests ?? [];
  const signature = JSON.stringify(requests);
  $('#no-requests').hidden = !!requests.length;
  if (signature !== requestSignature) {
    requestSignature = signature;
    const container = $('#connection-requests'); container.replaceChildren();
    for (const request of requests) {
      const card = document.createElement('article'); card.className = 'connection-request';
      const heading = document.createElement('h2'); heading.textContent = `${request.clientName} wants to use this tab`;
      const detail = document.createElement('p'); detail.textContent = `Request ${request.code} · Expires ${new Date(request.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      const buttons = document.createElement('div'); buttons.className = 'agent-actions';
      const approve = document.createElement('button'); approve.type = 'button'; approve.textContent = 'Allow and share this tab'; approve.disabled = !supported;
      approve.addEventListener('click', () => { void runAgentAction('agent:approve', { requestId: request.id }); });
      const decline = document.createElement('button'); decline.type = 'button'; decline.className = 'secondary'; decline.textContent = 'Decline';
      decline.addEventListener('click', () => { void runAgentAction('agent:decline', { requestId: request.id }); });
      buttons.append(approve, decline); card.append(heading, detail, buttons);
      if (!supported) { const hint = document.createElement('p'); hint.textContent = 'Open a supported website, then open this popup there to approve.'; card.append(hint); }
      container.append(card);
    }
  }
}
const agentError = (error: unknown) => {
  $('#agent-error').hidden = false;
  $('#agent-error').textContent = error instanceof Error ? error.message : String(error);
  if (error instanceof WorkerUnavailableError) { showError(error); $<HTMLButtonElement>('#share-tab').disabled = true; }
};
async function runAgentAction(type: string, extra: Record<string, unknown> = {}) {
  if (agentBusy) return;
  agentBusy = true; $('#agent-error').hidden = true;
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('#agents-view button')];
  buttons.forEach(button => { button.disabled = true; });
  try { await agentAction(type, extra); }
  catch (error) { agentError(error); }
  finally {
    agentBusy = false; requestSignature = '';
    buttons.forEach(button => { button.disabled = false; });
    await agentAction().catch(agentError);
  }
}
$('#pair-form').addEventListener('submit', event => {
  event.preventDefault();
  void runAgentAction('agent:pair', { code: $<HTMLTextAreaElement>('#pair-code').value })
    .then(() => { $<HTMLTextAreaElement>('#pair-code').value = ''; });
});
$('#port-form').addEventListener('submit', event => { event.preventDefault(); void runAgentAction('agent:port', { port: Number($<HTMLInputElement>('#bridge-port').value) }); });
$('#share-tab').addEventListener('click', () => { void runAgentAction(sharing ? 'agent:unshare' : 'agent:share'); });
$('#disconnect-agent').addEventListener('click', () => { void runAgentAction('agent:disconnect'); });
setInterval(() => { if (!agentBusy && !$('#agents-view').hidden) void agentAction().catch(agentError); }, 1000);
