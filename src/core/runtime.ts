import { ToolError, type ToolResult } from '../errors';
import { matchesSite } from './matches';
import type { ModelContext, PluginAPI, PluginOptions, PluginTool, SitePlugin, WebMCPDeveloper } from './types';

function definition({ execute: _execute, ...metadata }: PluginTool) { return structuredClone(metadata); }

export function installWebMCPDeveloper(win: Window = window): WebMCPDeveloper {
  if (win.webMCPDev) return win.webMCPDev;
  const plugins = new Map<string, { plugin: SitePlugin; api: PluginAPI }>();
  const owners = new Map<string, string>();
  const requests = new Map<string, AbortController>();
  const runtime: WebMCPDeveloper = {
    version: '0.3.0',
    async callRequest(id, name, input) {
      if (requests.has(id)) return failure(new ToolError('DUPLICATE_REQUEST', 'This request is already running.'));
      const controller = new AbortController(); requests.set(id, controller);
      try { return await runtime.callTool(name, input, { signal: controller.signal }); }
      finally { requests.delete(id); }
    },
    cancelRequest(id) { requests.get(id)?.abort(); },
    registerPlugin(plugin, options = {}) {
      const manifest = plugin.manifest;
      if (manifest.apiVersion !== 1) throw new ToolError('UNSUPPORTED_PLUGIN_API', 'This extension supports plugin API version 1.');
      if (!matchesSite(manifest, win.location.href ?? `${win.location.origin}/`)) throw new ToolError('WRONG_SITE', `${manifest.name} does not support this page.`);
      const existing = plugins.get(manifest.id);
      if (existing) {
        if (existing.plugin.manifest.version !== manifest.version) throw new ToolError('VERSION_CONFLICT', `Reload this page to activate ${manifest.name} ${manifest.version}.`);
        return existing.api;
      }
      const setup = plugin.setup({
        window: win, origin: win.location.origin, fetch: options.fetch ?? win.fetch.bind(win),
        storage: options.storage ?? win.sessionStorage,
        navigate: (url: string) => { win.setTimeout(() => win.location.assign(url), 150); }, ...options,
      });
      let entries = new Map<string, PluginTool>();
      const modern = (win.document as Document & { modelContext?: ModelContext }).modelContext;
      const legacy = (win.navigator as Navigator & { modelContext?: ModelContext }).modelContext;
      const native = modern?.registerTool ? modern : legacy?.registerTool ? legacy : undefined;
      const mode = native === modern && native ? 'native' : native ? 'legacy' : 'local';
      const registrations = new Map<string, { controller: AbortController; signature: string }>();
      let registrationErrors: string[] = [];
      let refreshError: string | undefined;
      const lifecycle = new AbortController();
      let disposed = false;
      let unsubscribe: (() => void) | undefined;
      let queue = Promise.resolve();

      function unregister(name: string) {
        const registration = registrations.get(name);
        if (!registration) return;
        registration.controller.abort();
        if (mode === 'legacy') { try { native?.unregisterTool?.(name); } catch { /* Already gone. */ } }
        registrations.delete(name);
      }

      async function refresh() {
        if (disposed) return;
        if (!matchesSite(manifest, win.location.href ?? `${win.location.origin}/`)) { api.dispose(); return; }
        const tools = typeof setup.tools === 'function' ? await setup.tools() : setup.tools;
        if (disposed) return;
        const next = new Map<string, PluginTool>();
        // Validate the entire update before changing ownership or registrations.
        for (const tool of tools) {
          if (tool.name.startsWith('webmcp_') || !/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(tool.name) || !tool.description || typeof tool.execute !== 'function' || !tool.inputSchema || !tool.annotations) {
            throw new ToolError('INVALID_TOOL', 'Each tool needs a name, description, input schema, annotations, and execute function.');
          }
          if (next.has(tool.name) || (owners.has(tool.name) && owners.get(tool.name) !== manifest.id)) {
            throw new ToolError('TOOL_NAME_CONFLICT', `Tool name ${tool.name} is already used. Prefix names with the plugin ID.`);
          }
          // Fail here if developer metadata contains functions or other non-serializable values.
          JSON.stringify(definition(tool));
          next.set(tool.name, tool);
        }
        for (const name of entries.keys()) if (!next.has(name)) { owners.delete(name); unregister(name); }
        entries = next;
        for (const name of entries.keys()) owners.set(name, manifest.id);
        registrationErrors = [];
        refreshError = undefined;
        if (!native) return;
        for (const tool of entries.values()) {
          if (disposed) break;
          const { buttonLabel: _label, defaults: _defaults, outputSchema: _output, ...metadata } = definition(tool);
          const signature = JSON.stringify(metadata);
          if (registrations.get(tool.name)?.signature === signature) continue;
          unregister(tool.name);
          const controller = new AbortController();
          // Record pending registrations too, so disable aborts asynchronous registration.
          registrations.set(tool.name, { controller, signature });
          try {
            await native.registerTool({ ...metadata, execute: async (input, options) => {
              const result = await api.callTool(tool.name, input, options);
              const text = JSON.stringify(result);
              return mode === 'legacy' ? { content: [{ type: 'text', text }], isError: !result.ok } : text;
            } }, { signal: controller.signal });
            if (disposed && mode === 'legacy') native.unregisterTool?.(tool.name);
          } catch (error) {
            unregister(tool.name);
            if (!disposed) registrationErrors.push(`${tool.name}: ${error instanceof Error ? error.message : 'registration failed'}`);
          }
        }
      }

      const api: PluginAPI = {
        version: manifest.version, ready: Promise.resolve(),
        listTools: () => [...entries.values()].map(definition),
        status: () => ({ mode, registered: [...registrations.keys()], registrationErrors: [...registrationErrors], ...(refreshError ? { refreshError } : {}), disposed }),
        refreshTools() {
          const task = queue.catch(() => {}).then(refresh);
          queue = task;
          // Keep diagnostics without an unhandled rejection for subscription-triggered refreshes.
          void task.catch(error => { if (!disposed) refreshError = error instanceof Error ? error.message : 'Could not refresh tools.'; });
          return task;
        },
        async callTool(name, input, options = {}) {
          try {
            await api.ready;
            if (disposed) throw new ToolError('DISPOSED', `${manifest.name} is disabled in this page.`);
            const tool = entries.get(name);
            if (!tool) throw new ToolError('UNKNOWN_TOOL', `Unknown tool: ${name}`);
            if (!matchesSite(manifest, win.location.href ?? `${win.location.origin}/`)) throw new ToolError('WRONG_SITE', 'This plugin does not support the current URL.');
            const signal = options.signal ? AbortSignal.any([options.signal, lifecycle.signal]) : lifecycle.signal;
            signal.throwIfAborted();
            return { ok: true, data: await tool.execute(input, { signal }) };
          } catch (error) {
            if (lifecycle.signal.aborted || options.signal?.aborted) return failure(new DOMException('Cancelled', 'AbortError'));
            return failure(error);
          }
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          lifecycle.abort();
          for (const name of registrations.keys()) unregister(name);
          for (const name of entries.keys()) owners.delete(name);
          entries.clear();
          plugins.delete(manifest.id);
          if (win.redditWebMCP === api) delete win.redditWebMCP;
          try { unsubscribe?.(); } finally { setup.dispose?.(); }
        },
      };
      plugins.set(manifest.id, { plugin, api });
      api.ready = api.refreshTools().catch(() => {});
      try { unsubscribe = setup.subscribe?.(() => { void api.refreshTools().catch(() => {}); }); }
      catch (error) { api.dispose(); throw error; }
      return api;
    },
    unregisterPlugin(id) { plugins.get(id)?.api.dispose(); },
    getPlugin: id => plugins.get(id)?.api,
    listPlugins: () => [...plugins.values()].map(({ plugin, api }) => ({ ...structuredClone(plugin.manifest), ...api.status() })),
    listTools: () => [...plugins.values()].flatMap(({ plugin, api }) => api.listTools().map(tool => ({ ...tool, pluginId: plugin.manifest.id, pluginName: plugin.manifest.name }))),
    async refreshTools() { await Promise.all([...plugins.values()].map(({ api }) => api.refreshTools().catch(() => {}))); },
    async callTool(name, input, options) {
      const knownOwner = owners.get(name);
      if (knownOwner) return plugins.get(knownOwner)!.api.callTool(name, input, options);
      // A caller can invoke immediately after injection, including async plugin discovery.
      await Promise.allSettled([...plugins.values()].map(({ api }) => api.ready));
      const id = owners.get(name);
      return id ? plugins.get(id)!.api.callTool(name, input, options) : failure(new ToolError('UNKNOWN_TOOL', `No active plugin provides ${name}.`));
    },
  };
  win.webMCPDev = runtime;
  return runtime;
}

export function activatePlugin(plugin: SitePlugin, options: PluginOptions = {}) {
  return installWebMCPDeveloper(options.window ?? window).registerPlugin(plugin, options);
}

function failure(error: unknown): ToolResult {
  // Each separately bundled plugin has its own Error constructors. Use the SDK
  // error contract rather than instanceof across those bundle boundaries.
  if (error instanceof Error && error.name === 'ToolError' && 'code' in error && typeof error.code === 'string') {
    return { ok: false, error: { code: error.code, message: error.message, ...('details' in error && error.details !== undefined ? { details: error.details } : {}) } };
  }
  if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) return { ok: false, error: { code: 'ABORTED', message: 'Tool execution cancelled.' } };
  return { ok: false, error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : 'Unexpected plugin error.' } };
}
