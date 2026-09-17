import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [id, domain] = process.argv.slice(2);
if (!id || !/^[a-z][a-z0-9-]*$/.test(id) || !domain || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/i.test(domain)) {
  console.error('Usage: npm run plugin:new -- my-site example.com');
  process.exit(1);
}
const dir = resolve('src/plugins', id);
await mkdir(dir); // Refuse to overwrite an existing plugin.
const name = id.split('-').map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
await writeFile(`${dir}/plugin.json`, JSON.stringify({ $schema: '../../../schemas/plugin.schema.json', apiVersion: 1, id, name, version: '0.1.0', description: `WebMCP tools for ${domain}`, matches: [`https://${domain}/*`, `https://*.${domain}/*`] }, null, 2) + '\n');
await writeFile(`${dir}/index.ts`, `import { definePlugin, defineTool, z } from '@webmcp-dev/sdk';
import manifest from './plugin.json';

export const plugin = definePlugin({
  manifest,
  setup({ window }) {
    return { tools: [defineTool({
      name: '${id.replaceAll('-', '_')}_page_info',
      title: 'Read page info',
      description: 'Read the title and URL of the current page.',
      schema: z.strictObject({}),
      output: z.strictObject({ title: z.string(), url: z.string() }),
      annotations: { readOnlyHint: true, consequentialHint: false, untrustedContentHint: true },
      execute: async () => ({ title: window.document.title, url: window.location.href }),
    })] };
  },
});
`);
await writeFile(`${dir}/README.md`, `# ${name}\n\nA WebMCP Dev API v1 plugin for ${domain}.\n\n- plugin.json: identity, version, and allowed URL patterns.\n- index.ts: typed tools and optional lifecycle hooks.\n- Import definePlugin, defineTool, z, and ToolError from @webmcp-dev/sdk.\n- Use a tools array, or a tools() function for dynamic discovery.\n- See docs/plugins.md in the host project for the complete contract.\n\nCopy this whole folder into another WebMCP Dev project's src/plugins, build, and reload the extension. No core or popup changes are needed.\n`);
console.log(`Created ${dir}. Implement its tools, run npm run build, then reload the existing WebMCP Dev extension.`);
