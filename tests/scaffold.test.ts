import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

test('scaffold produces a portable SDK plugin and refuses to overwrite it', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'webmcp-scaffold-'));
  try {
    await mkdir(join(temp, 'src/plugins'), { recursive: true });
    const script = resolve('scripts/new-plugin.mjs');
    execFileSync(process.execPath, [script, 'demo-site', 'example.com'], { cwd: temp, stdio: 'pipe' });
    const folder = join(temp, 'src/plugins/demo-site');
    const metadata = JSON.parse(await readFile(join(folder, 'plugin.json'), 'utf8'));
    assert.equal(metadata.apiVersion, 1);
    assert.deepEqual(metadata.matches, ['https://example.com/*', 'https://*.example.com/*']);
    const original = await readFile(join(folder, 'index.ts'), 'utf8');
    assert.match(original, /@webmcp-dev\/sdk/);
    // Compile the generated plugin through the same discovery path as real packages.
    execFileSync(process.execPath, ['scripts/build.mjs', '--outdir', join(temp, 'build'), '--extra-plugin', folder], { cwd: resolve('.'), stdio: 'pipe' });
    const catalog = JSON.parse(await readFile(join(temp, 'build/extension/plugins.json'), 'utf8'));
    assert.ok(catalog.some((item: { id: string }) => item.id === 'demo-site'));
    assert.throws(() => execFileSync(process.execPath, [script, 'demo-site', 'example.org'], { cwd: temp, stdio: 'pipe' }));
    assert.equal(await readFile(join(folder, 'index.ts'), 'utf8'), original);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
