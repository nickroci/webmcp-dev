import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrap } from '../core/bundle.mjs';
import type { PluginCatalogEntry } from '../core/types';

/** The checkout this bridge runs from. Both dist/mcp/cli.js and src/mcp/compile.ts sit two levels below it. */
export const projectRoot = () => fileURLToPath(new URL('../..', import.meta.url));

export class CompileError extends Error {
  constructor(message: string, public details: string[]) { super(message); this.name = 'CompileError'; }
}

/** Bundle one plugin folder the same way scripts/build.mjs bundles built-in plugins:
 * runtime, SDK and zod from this checkout, one self-contained IIFE for the page. */
export async function compilePlugin(dir: string, manifest: PluginCatalogEntry): Promise<{ code: string; warnings: string[] }> {
  const root = projectRoot();
  const { build } = await import('esbuild');
  const describe = (message: { text: string; location?: { file: string; line: number; column: number; lineText?: string } | null }) => {
    if (!message.location) return message.text;
    const file = message.location.file.startsWith(dir) ? message.location.file.slice(dir.length + 1) : message.location.file;
    return `${file}:${message.location.line}:${message.location.column + 1}: ${message.text}${message.location.lineText ? `\n  ${message.location.lineText.trim()}` : ''}`;
  };
  try {
    const result = await build({
      bundle: true, write: false, target: 'chrome120', minify: true, legalComments: 'none', format: 'iife', logLevel: 'silent',
      alias: { '@webmcp-dev/sdk': join(root, 'src/sdk.ts') }, nodePaths: [join(root, 'node_modules')],
      stdin: { contents: bootstrap(join(root, 'src/core/runtime.ts'), join(dir, 'index.ts'), manifest), resolveDir: root, loader: 'ts' },
    });
    return { code: result.outputFiles[0].text, warnings: result.warnings.map(describe) };
  } catch (error) {
    const failure = error as { errors?: Array<{ text: string; location?: { file: string; line: number; column: number; lineText?: string } | null }> };
    const details = failure.errors?.map(describe) ?? [error instanceof Error ? error.message : String(error)];
    throw new CompileError(`The plugin did not compile: ${details[0]}`, details);
  }
}
