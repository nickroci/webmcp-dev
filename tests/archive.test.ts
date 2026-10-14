import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZip, readZip } from '../src/core/zip';
import { packPlugins, unpackPlugins } from '../src/mcp/archive';
import { demoFiles, demoManifest } from './plugin-fixtures';

const limits = { maxEntries: 10, maxEntryBytes: 1024, maxTotalBytes: 4096 };
const hasZipTools = (() => { try { execFileSync('zip', ['-v']); execFileSync('unzip', ['-v']); return true; } catch { return false; } })();
const other = () => ({ ...demoFiles('hey'), 'plugin.json': JSON.stringify({ ...demoManifest, id: 'other-site', name: 'Other Site' }) });

test('exports round-trip every plugin’s source, including non-ASCII text', async () => {
  const files = { ...demoFiles('héllo ✓'), 'README.md': '# Notes\n' };
  const plugins = await unpackPlugins(await packPlugins([{ id: 'demo-site', files }, { id: 'other-site', files: other() }]));
  assert.deepEqual(plugins.map(plugin => plugin.id), ['demo-site', 'other-site']);
  assert.deepEqual(plugins[0].files, files);
  assert.deepEqual(plugins[0].matches, ['https://demo.test/*']);
});

test('exports are ordinary ZIPs that standard tools read, and ZIPs those tools make import', { skip: !hasZipTools && 'zip and unzip are not installed' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'webmcp-archive-'));
  try {
    await writeFile(join(dir, 'export.zip'), await packPlugins([{ id: 'demo-site', files: demoFiles('héllo') }]));
    execFileSync('unzip', ['-q', 'export.zip', '-d', 'out'], { cwd: dir });
    assert.equal(await readFile(join(dir, 'out/demo-site/index.ts'), 'utf8'), demoFiles('héllo')['index.ts']);
    assert.match(await readFile(join(dir, 'out/README.txt'), 'utf8'), /trust/);
    // Someone who unpacked an export, edited it and zipped it again, with a stray .DS_Store.
    await writeFile(join(dir, 'out/demo-site/.DS_Store'), 'binary-ish');
    execFileSync('zip', ['-qr', '../again.zip', '.'], { cwd: join(dir, 'out') });
    const plugins = await unpackPlugins(new Uint8Array(await readFile(join(dir, 'again.zip'))));
    assert.deepEqual(plugins[0].files, demoFiles('héllo'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('imports reject archives that are not flat plugin folders', async () => {
  const pack = (entries: Record<string, string>) => createZip(entries).then(unpackPlugins);
  await assert.rejects(pack({ 'README.txt': 'hi' }), /no plugins/);
  await assert.rejects(pack({ 'demo-site/../../evil.ts': 'x', ...Object.fromEntries(Object.entries(demoFiles()).map(([name, text]) => [`demo-site/${name}`, text])) }), /not a safe path/);
  await assert.rejects(pack({ '/etc/demo.ts': 'x' }), /not a safe path/);
  await assert.rejects(pack({ 'webmcp/demo-site/index.ts': 'x' }), /nested too deeply/);
  await assert.rejects(pack(Object.fromEntries(Object.entries(demoFiles()).map(([name, text]) => [`renamed/${name}`, text]))), /must match its folder/);
  await assert.rejects(pack({ 'demo-site/plugin.json': JSON.stringify(demoManifest) }), /plugin\.json and index\.ts/);
  await assert.rejects(pack({ 'demo-site/index.ts': 'x', 'demo-site/plugin.json': JSON.stringify(demoManifest), 'demo-site/run.sh': 'rm -rf ~' }), /plain \.ts, \.json or \.md/);
  await assert.rejects(pack({ 'demo-site/index.ts': 'x', 'demo-site/plugin.json': JSON.stringify({ ...demoManifest, matches: ['<all_urls>'] }) }), /matches/);
  await assert.rejects(unpackPlugins(new TextEncoder().encode('not a zip at all')), /not a ZIP archive/);
});

test('the ZIP reader refuses oversize, lying, corrupt and binary entries', async () => {
  await assert.rejects(readZip(await createZip({ 'a.ts': 'x'.repeat(2000) }), limits), /too large/);
  await assert.rejects(readZip(await createZip(Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`f${i}.ts`, 'x']))), limits), /at most 10/);
  // An entry whose header understates its size, as a decompression bomb would.
  const bomb = await createZip({ 'a.ts': 'x'.repeat(900) });
  const view = new DataView(bomb.buffer);
  const central = bomb.length - 22 - (46 + 4);
  view.setUint32(central + 24, 10, true);
  await assert.rejects(readZip(bomb, limits), /larger than its header/);
  const corrupt = await createZip({ 'a.ts': 'hello hello hello' });
  new DataView(corrupt.buffer).setUint32(14, 0, true); new DataView(corrupt.buffer).setUint32(corrupt.length - 22 - 50 + 16, 0, true);
  await assert.rejects(readZip(corrupt, limits), /corrupt/);
  const dir = await mkdtemp(join(tmpdir(), 'webmcp-archive-'));
  try {
    if (hasZipTools) {
      await mkdir(join(dir, 'demo-site'));
      await writeFile(join(dir, 'demo-site/blob.ts'), Buffer.from([0xff, 0xfe, 0x00, 0x81]));
      execFileSync('zip', ['-q', 'binary.zip', 'demo-site/blob.ts'], { cwd: dir });
      await assert.rejects(readZip(new Uint8Array(await readFile(join(dir, 'binary.zip'))), limits), /not a text file/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
