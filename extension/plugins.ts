import { packPlugins, unpackPlugins, type ArchivedPlugin } from '../src/mcp/archive';
import type { PluginCatalogEntry } from '../src/core/types';
import type { InstalledPlugin } from '../src/mcp/protocol';
import { sendWorkerMessage } from './messages';

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
type Installed = InstalledPlugin & { files: Record<string, string> };
let installed: Installed[] = [];
let builtIn: PluginCatalogEntry[] = [];
let incoming: { source: string; plugins: ArchivedPlugin[] } | undefined;

// The relay words these for agents; the person on this page is the one who flips the switch.
const REMEDIES: Record<string, string> = {
  DEV_MODE_DISABLED: 'Turn on “Let agents develop plugins” in the WebMCP Dev popup’s Agents tab first. Imported plugins run the same way agent-built ones do.',
  USER_SCRIPTS_UNAVAILABLE: 'Turn on Allow User Scripts on WebMCP Dev’s details page in chrome://extensions first. It takes effect at once.',
};
function failure(result: Record<string, any>) {
  if (typeof result.error === 'string') return result.error;
  return REMEDIES[result.error?.code] ?? result.error?.message ?? 'The extension could not complete this action.';
}
const sameFiles = (a: Record<string, string>, b: Record<string, string>) => Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([name, text]) => b[name] === text);
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node;
};
function setStatus(text: string) { $('#status').textContent = text; }

function selectedExports() { return [...document.querySelectorAll<HTMLInputElement>('#installed input:checked')].map(box => installed.find(plugin => plugin.id === box.value)!); }
function updateExport() {
  const count = selectedExports().length;
  $<HTMLButtonElement>('#export').disabled = !count;
  $('#export').textContent = count ? `Export ${count} plugin${count === 1 ? '' : 's'}` : 'Export selected';
  $<HTMLInputElement>('#select-all').checked = !!installed.length && count === installed.length;
}
async function loadInstalled() {
  const result = await sendWorkerMessage({ type: 'agent:plugin-sources' });
  if (!result.ok) throw new Error(failure(result));
  installed = (result.data.plugins as Installed[]).sort((a, b) => a.name.localeCompare(b.name));
  const container = $('#installed'); container.replaceChildren();
  if (!installed.length) container.append(element('p', 'No agent-built plugins yet. Share a tab with an agent and ask it to build one.', 'hint'));
  for (const plugin of installed) {
    const card = element('article', undefined, 'plugin');
    const label = element('label'); label.append(document.createTextNode(`${plugin.name} · ${plugin.version}`));
    const box = element('input'); box.type = 'checkbox'; box.value = plugin.id; box.setAttribute('aria-label', `Export ${plugin.name}`);
    box.addEventListener('change', updateExport);
    label.append(box);
    card.append(label, element('p', plugin.description), element('code', plugin.matches.join(' · ')),
      element('p', `${plugin.id} · ${Object.keys(plugin.files).length} files · installed by ${plugin.installedBy} · ${new Date(plugin.installedAt).toLocaleString()}${plugin.note ? ` · ${plugin.note}` : ''}`, 'installed-by'));
    container.append(card);
  }
  updateExport();
}
function download(bytes: Uint8Array, name: string) {
  const link = element('a'); link.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/zip' })); link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}
$('#select-all').addEventListener('change', () => {
  const all = $<HTMLInputElement>('#select-all').checked;
  document.querySelectorAll<HTMLInputElement>('#installed input').forEach(box => { box.checked = all; });
  updateExport();
});
$('#export').addEventListener('click', async () => {
  const plugins = selectedExports(); if (!plugins.length) return;
  try {
    const bytes = await packPlugins(plugins);
    const name = plugins.length === 1 ? `${plugins[0].id}-${plugins[0].version}.zip` : `webmcp-plugins-${new Date().toISOString().slice(0, 10)}.zip`;
    download(bytes, name);
    setStatus(`Exported ${plugins.map(plugin => plugin.name).join(', ')} to ${name}. Send it only to people who trust you, and keep it off public sites.`);
  } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
});

function selectedImports() { return [...document.querySelectorAll<HTMLInputElement>('#review input[type=checkbox]:checked')].map(box => incoming!.plugins.find(plugin => plugin.id === box.value)!); }
function updateImport() {
  const count = incoming ? selectedImports().length : 0;
  $('#import').hidden = !incoming; $<HTMLButtonElement>('#import').disabled = !count;
  $('#import').textContent = count ? `Install ${count} plugin${count === 1 ? '' : 's'}` : 'Install selected';
}
function renderReview() {
  const container = $('#review'); container.replaceChildren();
  if (!incoming) { updateImport(); return; }
  for (const plugin of incoming.plugins) {
    const current = installed.find(entry => entry.id === plugin.id);
    const reserved = builtIn.some(entry => entry.id === plugin.id);
    const identical = !!current && sameFiles(current.files, plugin.files);
    const card = element('article', undefined, 'plugin review'); card.dataset.plugin = plugin.id;
    const label = element('label'); label.append(document.createTextNode(`${plugin.name} · ${plugin.version}`));
    const box = element('input'); box.type = 'checkbox'; box.value = plugin.id; box.setAttribute('aria-label', `Install ${plugin.name}`);
    box.checked = !reserved && !identical; box.disabled = reserved;
    box.addEventListener('change', updateImport);
    label.append(box);
    const verdict = reserved ? `${plugin.id} is a built-in plugin of this extension, so it cannot be replaced.`
      : identical ? 'Identical to the copy you already have.'
      : current ? `Replaces your installed ${current.name} ${current.version}.` : 'New plugin.';
    card.append(label, element('p', plugin.description), element('p', 'Runs on these sites:', 'runs-on'), element('code', plugin.matches.join(' · ')),
      element('p', `${plugin.id} · ${verdict}`, `installed-by${reserved || current ? ' warning' : ''}`));
    for (const [name, text] of Object.entries(plugin.files).sort(([a], [b]) => a === 'plugin.json' ? -1 : b === 'plugin.json' ? 1 : a.localeCompare(b))) {
      const details = element('details'); details.append(element('summary', `${name} · ${text.split('\n').length} lines`), element('pre', text));
      card.append(details);
    }
    card.append(element('p', '', 'result'));
    container.append(card);
  }
  updateImport();
}
$('#archive').addEventListener('change', async () => {
  const file = $<HTMLInputElement>('#archive').files?.[0];
  incoming = undefined; renderReview();
  if (!file) return;
  try {
    const plugins = await unpackPlugins(new Uint8Array(await file.arrayBuffer()));
    incoming = { source: file.name.slice(0, 60), plugins };
    renderReview();
    setStatus(`${file.name} holds ${plugins.length} plugin${plugins.length === 1 ? '' : 's'}. Read the code below, then install the ones you trust.`);
  } catch (error) { setStatus(`Could not read ${file.name}: ${error instanceof Error ? error.message : String(error)}`); }
});
$('#import').addEventListener('click', async () => {
  if (!incoming) return;
  const plugins = selectedImports(); const source = incoming.source;
  const button = $<HTMLButtonElement>('#import'); button.disabled = true;
  let done = 0;
  for (const plugin of plugins) {
    const line = document.querySelector<HTMLElement>(`#review [data-plugin="${plugin.id}"] .result`)!;
    line.textContent = 'Installing…';
    // One request per plugin keeps each message well under the relay's size limit and reports each outcome.
    const result = await sendWorkerMessage({ type: 'agent:import-plugin', files: plugin.files, source }).catch((error): Record<string, any> => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    if (result.ok) {
      done++;
      const tabs = (result.data.browsers as Array<{ tabs?: unknown[] }>).reduce((sum, browser) => sum + (browser.tabs?.length ?? 0), 0);
      line.textContent = `Installed${tabs ? ` and active in ${tabs} open tab${tabs === 1 ? '' : 's'}` : ''}.`;
      line.className = 'result';
    } else { line.textContent = failure(result); line.className = 'result warning'; }
  }
  setStatus(`Installed ${done} of ${plugins.length} plugin${plugins.length === 1 ? '' : 's'} from ${source}.`);
  await loadInstalled().catch(error => setStatus(error instanceof Error ? error.message : String(error)));
  updateImport();
});

async function start() {
  builtIn = await fetch(chrome.runtime.getURL('plugins.json')).then(response => response.json()).catch(() => []);
  await loadInstalled();
  setStatus(installed.length ? 'Choose plugins to export, or import a file someone you trust sent you.' : 'Import a file someone you trust sent you.');
}
void start().catch(error => setStatus(error instanceof Error ? error.message : String(error)));
