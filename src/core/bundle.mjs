// Shared by the build script (plain Node) and the local bridge's plugin compiler (TypeScript).
import { createHash } from 'node:crypto';

/** Content hash of a plugin's source files, independent of where the folder lives. */
export function revisionOf(files) {
  const hash = createHash('sha256');
  for (const name of Object.keys(files).sort()) hash.update(`${name}\0${files[name]}\0`);
  return hash.digest('hex').slice(0, 16);
}

/** Entry module for one plugin bundle. A document keeps whatever revision it loaded,
 * so the bundle replaces an older revision of itself instead of refusing to load. */
export function bootstrap(runtimeSpecifier, pluginSpecifier, manifest) {
  return `import { activatePlugin } from ${JSON.stringify(runtimeSpecifier)};
import { plugin } from ${JSON.stringify(pluginSpecifier)};
const manifest = ${JSON.stringify(manifest)};
try {
  const runtime = window.webMCPDev;
  const current = runtime?.listPlugins().find(entry => entry.id === manifest.id);
  if (current && current.revision !== manifest.revision) runtime.unregisterPlugin(manifest.id);
  const api = activatePlugin({ ...plugin, manifest });
  if (manifest.id === 'reddit') window.redditWebMCP = api;
  if (window.__webMCPDevErrors) delete window.__webMCPDevErrors[manifest.id];
} catch (error) {
  console.error('[WebMCP Dev]', error);
  (window.__webMCPDevErrors ??= {})[manifest.id] = error instanceof Error ? error.message : String(error);
}
`;
}
