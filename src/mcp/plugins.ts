import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { revisionOf } from '../core/bundle.mjs';
import type { PluginCatalogEntry } from '../core/types';
import { CompileError, compilePlugin, projectRoot } from './compile';
import { PLUGIN_FILE_PATTERN, pluginFilesSchema, pluginManifestSchema, type InstalledPlugin, type PluginBundle } from './protocol';

export class PluginError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); this.name = 'PluginError'; }
}
const installedMeta = z.object({ installedBy: z.string(), installedAt: z.string(), note: z.string().optional(), revision: z.string() });
const META = '.installed.json';
const BUNDLE = '.bundle.js';

/** Agent-authored plugins, kept as portable source folders so a person or another agent
 * can read them, and so a finished one can be copied into src/plugins unchanged. */
export class PluginStore {
  private entries = new Map<string, { plugin: InstalledPlugin; code: string; files: Record<string, string> }>();
  private staticEntries: PluginCatalogEntry[] | undefined;
  private queue = Promise.resolve();
  constructor(readonly dir: string, private readonly root = projectRoot()) {}

  /** Read every folder; reuse a bundle whose recorded revision still matches, compile the rest. */
  async load(log: (message: string) => void = message => console.error(message)) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    for (const item of await readdir(this.dir, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const folder = join(this.dir, item.name);
      try {
        const files = await readFiles(folder);
        const manifest = pluginManifestSchema.parse(JSON.parse(files['plugin.json'] ?? '{}'));
        if (manifest.id !== item.name) throw new Error(`plugin.json id ${manifest.id} does not match folder ${item.name}`);
        const meta = installedMeta.parse(JSON.parse(await readFile(join(folder, META), 'utf8')));
        const plugin = this.entry(manifest, files, meta);
        let code: string | undefined;
        if (meta.revision === plugin.revision) code = await readFile(join(folder, BUNDLE), 'utf8').catch(() => undefined);
        if (code === undefined) {
          code = (await compilePlugin(folder, plugin)).code;
          await writeFile(join(folder, BUNDLE), code, { mode: 0o600 });
          await writeFile(join(folder, META), JSON.stringify({ ...meta, revision: plugin.revision }, null, 2), { mode: 0o600 });
        }
        this.entries.set(plugin.id, { plugin, code, files });
      } catch (error) { log(`Skipping installed plugin ${item.name}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  list(): InstalledPlugin[] { return [...this.entries.values()].map(entry => entry.plugin); }
  bundles(): PluginBundle[] { return [...this.entries.values()].map(entry => ({ ...entry.plugin, code: entry.code })); }
  get(id: string): PluginBundle | undefined { const entry = this.entries.get(id); return entry && { ...entry.plugin, code: entry.code }; }
  async read(id: string): Promise<{ plugin: PluginCatalogEntry; path: string; files: Record<string, string> } | undefined> {
    const entry = this.entries.get(id);
    if (entry) return { plugin: entry.plugin, path: join(this.dir, id), files: entry.files };
    const built = (await this.builtIn()).find(plugin => plugin.id === id);
    if (!built) return;
    const path = join(this.root, 'src/plugins', id);
    return { plugin: built, path, files: await readFiles(path).catch(() => ({})) };
  }
  /** Plugins shipped in the extension build, if this checkout has been built. */
  async builtIn(): Promise<PluginCatalogEntry[]> {
    if (!this.staticEntries) {
      const list = await readFile(join(this.root, 'dist/extension/plugins.json'), 'utf8').then(text => JSON.parse(text) as PluginCatalogEntry[]).catch(() => []);
      this.staticEntries = list.map(plugin => ({ ...plugin, source: 'static' as const }));
    }
    return this.staticEntries;
  }
  install(input: unknown, meta: { installedBy: string; note?: string }): Promise<{ plugin: PluginBundle; warnings: string[] }> {
    const task = this.queue.catch(() => {}).then(() => this.write(input, meta));
    this.queue = task.then(() => {}, () => {});
    return task;
  }
  private async write(input: unknown, meta: { installedBy: string; note?: string }) {
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      const bad = Object.keys(input).find(name => !PLUGIN_FILE_PATTERN.test(name));
      if (bad) throw new PluginError('INVALID_PLUGIN', `${bad} is not a plain .ts, .json or .md file name. Keep every file directly in the plugin folder.`);
    }
    const parsedFiles = pluginFilesSchema.safeParse(input);
    if (!parsedFiles.success) throw new PluginError('INVALID_PLUGIN', parsedFiles.error.issues[0]?.message ?? 'Invalid plugin files.', parsedFiles.error.issues);
    const files = parsedFiles.data;
    let manifestJson: unknown;
    try { manifestJson = JSON.parse(files['plugin.json']); } catch (error) { throw new PluginError('INVALID_PLUGIN', `plugin.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
    const parsedManifest = pluginManifestSchema.safeParse(manifestJson);
    if (!parsedManifest.success) throw new PluginError('INVALID_PLUGIN', `plugin.json: ${parsedManifest.error.issues.map(issue => `${issue.path.join('.') || 'root'} ${issue.message}`).join('; ')}`, parsedManifest.error.issues);
    const manifest = parsedManifest.data;
    if ((await this.builtIn()).some(plugin => plugin.id === manifest.id)) throw new PluginError('PLUGIN_ID_TAKEN', `${manifest.id} is a built-in plugin of this extension. Choose another id, or change its source under src/plugins and rebuild.`);
    const plugin = this.entry(manifest, files, { installedBy: meta.installedBy.slice(0, 80), installedAt: new Date().toISOString(), ...(meta.note ? { note: meta.note.slice(0, 500) } : {}) });
    // Compile from a staging folder so a broken revision never replaces a working one.
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const staging = join(this.dir, `.staging-${randomUUID()}`);
    await mkdir(staging, { mode: 0o700 });
    try {
      for (const [name, text] of Object.entries(files)) await writeFile(join(staging, name), text, { mode: 0o600 });
      let compiled: { code: string; warnings: string[] };
      try { compiled = await compilePlugin(staging, plugin); }
      catch (error) { if (error instanceof CompileError) throw new PluginError('COMPILE_ERROR', error.message, error.details); throw error; }
      await writeFile(join(staging, BUNDLE), compiled.code, { mode: 0o600 });
      await writeFile(join(staging, META), JSON.stringify({ installedBy: plugin.installedBy, installedAt: plugin.installedAt, note: plugin.note, revision: plugin.revision }, null, 2), { mode: 0o600 });
      const target = join(this.dir, plugin.id);
      await rm(target, { recursive: true, force: true });
      await rename(staging, target);
      this.entries.set(plugin.id, { plugin, code: compiled.code, files });
      return { plugin: { ...plugin, code: compiled.code }, warnings: compiled.warnings };
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  async remove(id: string): Promise<boolean> {
    const existed = this.entries.delete(id);
    if (existed) await rm(join(this.dir, id), { recursive: true, force: true });
    return existed;
  }
  private entry(manifest: z.infer<typeof pluginManifestSchema>, files: Record<string, string>, meta: { installedBy: string; installedAt: string; note?: string }): InstalledPlugin {
    const { $schema: _schema, ...metadata } = manifest;
    return { ...metadata, file: `dynamic/${manifest.id}.js`, revision: revisionOf(files), source: 'dynamic', installedBy: meta.installedBy, installedAt: meta.installedAt, ...(meta.note ? { note: meta.note } : {}) };
  }
}

async function readFiles(folder: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const item of await readdir(resolve(folder), { withFileTypes: true })) {
    if (item.isFile() && PLUGIN_FILE_PATTERN.test(item.name)) files[item.name] = await readFile(join(folder, item.name), 'utf8');
  }
  return files;
}
