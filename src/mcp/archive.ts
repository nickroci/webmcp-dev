import { createZip, readZip, ZipError } from '../core/zip';
import { MAX_PLUGIN_FILES, MAX_PLUGIN_SOURCE_BYTES, PLUGIN_FILE_PATTERN, pluginFilesSchema, pluginManifestSchema } from './protocol';

/** A plugin as it travels in an export: its source folder, never the compiled bundle, so whoever
 * receives it can read exactly what will run before installing it. */
export interface ArchivedPlugin { id: string; name: string; version: string; description: string; matches: string[]; files: Record<string, string> }
export const MAX_ARCHIVE_PLUGINS = 50;
export const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
export class ArchiveError extends Error { constructor(message: string) { super(message); this.name = 'ArchiveError'; } }

const README = `WebMCP Dev site plugins

Each folder is one plugin's source code. To install them, open WebMCP Dev → Site plugins → Export or import,
and choose this file. Review the code first: a plugin runs on every site its plugin.json matches, with access
to your signed-in session there. Only install plugins from someone you trust completely.
`;

/** One ZIP with a folder per plugin, laid out exactly as ~/.webmcp-dev/plugins/<id>. */
export function packPlugins(plugins: Array<{ id: string; files: Record<string, string> }>, exportedAt = new Date()) {
  const entries: Record<string, string> = { 'README.txt': README };
  for (const plugin of plugins) for (const [name, text] of Object.entries(plugin.files)) entries[`${plugin.id}/${name}`] = text;
  return createZip(entries, exportedAt);
}

/** Unpack and validate an export. Files at the archive root, such as the README, are ignored. */
export async function unpackPlugins(bytes: Uint8Array): Promise<ArchivedPlugin[]> {
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new ArchiveError('This file is too large to be a plugin export.');
  let entries: Record<string, string>;
  try { entries = await readZip(bytes, { maxEntries: MAX_ARCHIVE_PLUGINS * MAX_PLUGIN_FILES + 10, maxEntryBytes: MAX_PLUGIN_SOURCE_BYTES, maxTotalBytes: MAX_ARCHIVE_BYTES }); }
  catch (error) { throw error instanceof ZipError ? new ArchiveError(error.message) : error; }
  const folders = new Map<string, Record<string, string>>();
  for (const [path, text] of Object.entries(entries)) {
    const parts = path.split(/[\\/]/);
    if (parts.some(part => part === '' || part === '..')) throw new ArchiveError(`${path} is not a safe path inside a plugin export.`);
    // Archive tools add metadata such as __MACOSX/ and .DS_Store; it is never plugin source.
    if (parts.some(part => part.startsWith('.') || part === '__MACOSX')) continue;
    if (parts.length === 1) continue;
    if (parts.length !== 2) throw new ArchiveError(`${path} is nested too deeply. A plugin export holds one flat folder per plugin.`);
    const [folder, name] = parts;
    folders.set(folder, { ...folders.get(folder), [name]: text });
  }
  if (!folders.size) throw new ArchiveError('This archive contains no plugins.');
  if (folders.size > MAX_ARCHIVE_PLUGINS) throw new ArchiveError(`This archive holds ${folders.size} plugins; at most ${MAX_ARCHIVE_PLUGINS} can be imported at once.`);
  return [...folders].map(([folder, files]) => {
    const bad = Object.keys(files).find(name => !PLUGIN_FILE_PATTERN.test(name));
    if (bad) throw new ArchiveError(`${folder}/${bad} is not a plain .ts, .json or .md file. Plugins contain nothing else.`);
    const parsed = pluginFilesSchema.safeParse(files);
    if (!parsed.success) throw new ArchiveError(`${folder}: ${parsed.error.issues[0]?.message ?? 'invalid plugin files.'}`);
    let json: unknown;
    try { json = JSON.parse(parsed.data['plugin.json']); } catch { throw new ArchiveError(`${folder}/plugin.json is not valid JSON.`); }
    const manifest = pluginManifestSchema.safeParse(json);
    if (!manifest.success) throw new ArchiveError(`${folder}/plugin.json: ${manifest.error.issues.map(issue => `${issue.path.join('.') || 'root'} ${issue.message}`).join('; ')}`);
    if (manifest.data.id !== folder) throw new ArchiveError(`${folder}/plugin.json has id ${manifest.data.id}; it must match its folder.`);
    const { id, name, version, description, matches } = manifest.data;
    return { id, name, version, description, matches, files: parsed.data };
  });
}
