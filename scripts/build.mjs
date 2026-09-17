import { build } from 'esbuild';
import { cp, mkdir, rm, readdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { outdir: { type: 'string', default: 'dist' }, 'extra-plugin': { type: 'string', multiple: true, default: [] } } });
const out = resolve(values.outdir);
// Refuse to erase an arbitrary directory supplied through this developer CLI.
if (out === resolve('.') || !['dist', 'build'].includes(out.split('/').at(-1))) throw new Error('Output directory must be a dist/ or build/ directory.');
const dirs = (await readdir('src/plugins', { withFileTypes: true })).filter(item => item.isDirectory()).map(item => `src/plugins/${item.name}`);
dirs.push(...values['extra-plugin']);
const catalog = [];
const entries = [];
for (const dir of dirs.sort()) {
  const manifest = JSON.parse(await readFile(join(dir, 'plugin.json'), 'utf8'));
  if (manifest.apiVersion !== 1) throw new Error(`Unsupported plugin API version in ${dir}; expected 1.`);
  if (typeof manifest.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(manifest.id) || catalog.some(item => item.id === manifest.id)) throw new Error(`Invalid or duplicate plugin ID in ${dir}`);
  if (typeof manifest.name !== 'string' || !manifest.name.trim() || typeof manifest.description !== 'string' || !manifest.description.trim() || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error(`Missing plugin metadata in ${dir}`);
  if (Object.keys(manifest).some(key => !['$schema', 'apiVersion', 'id', 'name', 'description', 'version', 'matches'].includes(key))) throw new Error(`Unknown plugin metadata field in ${dir}`);
  if (!Array.isArray(manifest.matches) || !manifest.matches.length || manifest.matches.some(pattern => typeof pattern !== 'string' || !/^(https?|\*):\/\/(\*\.)?[a-z0-9.-]+\/[^\s]*$/i.test(pattern))) throw new Error(`Use HTTP(S) Chrome match patterns with explicit hostnames in ${dir}`);
  const entry = resolve(dir, 'index.ts');
  await access(entry);
  const { $schema, ...metadata } = manifest;
  catalog.push({ ...metadata, file: `plugins/${manifest.id}.js` });
  entries.push(entry);
}
await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'extension/plugins'), { recursive: true });
const options = { bundle: true, target: 'chrome120', sourcemap: true, minify: true, legalComments: 'none', alias: { '@webmcp-dev/sdk': resolve('src/sdk.ts') } };
await build({ ...options, entryPoints: ['src/index.ts'], outfile: join(out, 'index.js'), format: 'esm' });
await build({ ...options, entryPoints: ['src/sdk.ts'], outfile: join(out, 'sdk.js'), format: 'esm' });
await build({ ...options, entryPoints: ['src/inject.ts'], outfile: join(out, 'reddit-webmcp.js'), format: 'iife' });
for (let i = 0; i < catalog.length; i++) {
  await build({ ...options, stdin: {
    contents: `import {activatePlugin} from './src/core/runtime'; import {plugin} from ${JSON.stringify(entries[i])}; const manifest = ${JSON.stringify(catalog[i])}; try { const api = activatePlugin({...plugin, manifest}); if(manifest.id === 'reddit') window.redditWebMCP = api; } catch(error) { console.error('[WebMCP Dev]', error); }`,
    resolveDir: resolve('.'), loader: 'ts',
  }, outfile: join(out, 'extension', catalog[i].file), format: 'iife' });
}
for (const name of ['popup', 'background', 'loader']) {
  await build({ ...options, entryPoints: [`extension/${name}.ts`], outfile: join(out, `extension/${name}.js`), format: name === 'background' ? 'esm' : 'iife' });
}
for (const file of ['popup.html', 'popup.css']) await cp(`extension/${file}`, join(out, 'extension', file));
const base = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
const matches = [...new Set(catalog.flatMap(plugin => plugin.matches))];
const manifest = { ...base, host_permissions: [...matches, 'http://127.0.0.1/*'],
  content_scripts: [{ matches, js: ['loader.js'], run_at: 'document_idle', all_frames: false }],
};
await writeFile(join(out, 'extension/manifest.json'), JSON.stringify(manifest, null, 2));
await writeFile(join(out, 'extension/plugins.json'), JSON.stringify(catalog, null, 2));
console.log(`Built WebMCP Dev with ${catalog.length} plugin(s): ${catalog.map(plugin => plugin.name).join(', ')} → ${out}/extension`);

await build({ entryPoints: ['src/mcp/cli.ts'], outfile: join(out, 'mcp/cli.js'), bundle: true, platform: 'node', target: 'node22', format: 'esm', packages: 'external', sourcemap: true });
