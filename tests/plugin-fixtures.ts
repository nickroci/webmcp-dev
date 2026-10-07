// An agent-authored plugin folder, used by the store, relay and browser tests.
export const demoManifest = { apiVersion: 1, id: 'demo-site', name: 'Demo Site', version: '0.1.0', description: 'Agent-authored fixture.', matches: ['https://demo.test/*'] };
export const demoSource = (greeting: string) => `import { definePlugin, defineTool, z } from '@webmcp-dev/sdk';
import manifest from './plugin.json';
import { shout } from './support';
export const plugin = definePlugin({ manifest, setup({ window }) {
  return { tools: [defineTool({
    name: 'demo_site_hello', title: 'Hello', description: 'Greet from the page.',
    schema: z.strictObject({ name: z.string().default('world') }),
    annotations: { readOnlyHint: true, consequentialHint: false, untrustedContentHint: true },
    execute: input => shout(${JSON.stringify(greeting)} + ' ' + input.name + ' from ' + window.document.title),
  })] };
} });
`;
export const demoFiles = (greeting = 'hello') => ({ 'plugin.json': JSON.stringify(demoManifest, null, 2), 'index.ts': demoSource(greeting), 'support.ts': 'export const shout = (text: string) => text.toUpperCase();' });
