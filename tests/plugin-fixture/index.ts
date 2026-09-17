import { definePlugin, defineTool, ToolError, z } from '@webmcp-dev/sdk';
import manifest from './plugin.json';

const annotations = { readOnlyHint: true, consequentialHint: false, untrustedContentHint: true };
export const plugin = definePlugin({
  manifest,
  setup({ window }) {
    return {
      tools: async () => [
        defineTool({ name: 'fixture_page_info', title: 'Read page info', description: 'Read the current page.',
          schema: z.strictObject({}), output: z.strictObject({ title: z.string(), url: z.string() }), annotations,
          execute: () => ({ title: window.document.title, url: window.location.href }),
        }),
        defineTool({ name: 'fixture_echo', title: 'Echo structured input', description: 'Exercise new tool schemas without popup code changes.',
          schema: z.strictObject({ count: z.number().int().min(1).max(3), mode: z.enum(['brief', 'full']), enabled: z.boolean().optional(),
            config: z.strictObject({ label: z.string() }), tags: z.array(z.string()), choice: z.union([z.string(), z.number()]).nullable() }),
          annotations, defaults: { count: 1, mode: 'brief', config: { label: 'Fixture' }, tags: ['one'], choice: null },
          execute(input) { if (input.count === 3) throw new ToolError('FIXTURE_ERROR', 'Error crosses plugin bundle boundaries.'); return input; },
        }),
        ...(window.document.body.dataset.expanded === 'true' ? [defineTool({ name: 'fixture_extra', title: 'Context tool',
          description: 'Available only when this page is expanded.', schema: z.strictObject({}), annotations, execute: () => 'expanded' })] : []),
      ],
      subscribe(refresh) {
        const observer = new MutationObserver(refresh);
        observer.observe(window.document.body, { attributes: true, attributeFilter: ['data-expanded'] });
        return () => observer.disconnect();
      },
    };
  },
});
