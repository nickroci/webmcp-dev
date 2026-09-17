# Authoring a site plugin

Create a package with `npm run plugin:new -- my-site example.com`. Add any support modules beside its `index.ts`; the build bundles imports and discovers the folder automatically. Keep plugin code inside its folder, apart from the shared SDK import. There are no popup edits or central tool-type registrations.

## Manifest

```json
{
  "$schema": "../../../schemas/plugin.schema.json",
  "apiVersion": 1,
  "id": "my-site",
  "name": "My Site",
  "version": "0.1.0",
  "description": "Tools for example.com",
  "matches": ["https://example.com/*", "https://*.example.com/*"]
}
```

`apiVersion` versions the host contract; `version` versions your plugin. Use unique lowercase IDs and explicit HTTP(S) hostname match patterns. `*.example.com` covers the base domain and its subdomains. Patterns can restrict paths. The build uses this manifest as the authority for injection and tool ownership.

## Typed tools

```ts
import { definePlugin, defineTool, z } from '@webmcp-dev/sdk';
import manifest from './plugin.json';

export const plugin = definePlugin({
  manifest,
  setup({ window }) {
    return {
      tools: [defineTool({
        name: 'my_site_find_links',
        title: 'Find links',
        description: 'Find visible page links containing some text.',
        schema: z.strictObject({
          query: z.string().min(1).describe('Text to find in link labels'),
          limit: z.number().int().min(1).max(50).default(10),
          options: z.strictObject({ case_sensitive: z.boolean() }).optional(),
        }),
        output: z.array(z.strictObject({ label: z.string(), url: z.string() })),
        defaults: { query: 'docs' },
        buttonLabel: 'Find links',
        annotations: {
          readOnlyHint: true,
          consequentialHint: false,
          untrustedContentHint: true,
        },
        execute(input, { signal }) {
          signal?.throwIfAborted();
          const normalize = (text: string) => input.options?.case_sensitive ? text : text.toLowerCase();
          return [...window.document.querySelectorAll<HTMLAnchorElement>('a[href]')]
            .filter(link => link.getClientRects().length > 0 && normalize(link.textContent ?? '').includes(normalize(input.query)))
            .slice(0, input.limit)
            .map(link => ({ label: link.textContent ?? '', url: link.href }));
        },
      })],
    };
  },
});
```

`defineTool` infers handler input types from the Zod schema and validates every call before execution. Use JSON-representable schemas; refinements can enforce additional constraints at execution time. Input transforms are allowed when the input JSON Schema can be generated. Optional `output` schemas validate the returned data and appear in developer tool metadata; they are not sent as a nonstandard native WebMCP property.

Return JSON-compatible data. A lower-level `PluginTool` interface is also exported for authors who generate JSON Schema themselves; its `execute` handler is responsible for validating its input. SDK tools provide that validation automatically.

Use names prefixed by your plugin ID with underscores, such as `my_site_search`. Names and schemas can vary at runtime. Tools are ordinary definitions, not subclasses of predefined navigation, search, or posting types.

## Input UI

| Schema | Popup control |
| --- | --- |
| String, number, integer | Text or numeric input, including simple bounds |
| Enum | Select with typed values |
| Boolean | Checkbox, or optional unset/true/false select |
| Object, array, nullable value, union | JSON textarea |
| Complex root schema or arbitrary additional fields | Full JSON mode |

Use `.describe()` for help text and `.meta({ title: 'Friendly label' })` for labels. `.meta({ 'x-multiline': true })` renders a string as a textarea; `.meta({ 'x-generate': 'uuid' })` initializes a string with a UUID. These are optional developer UI hints. Runtime schema validation remains authoritative; the form does not implement every JSON Schema constraint.

Per-tool `defaults` override schema defaults. JSON mode preserves typed values, including `null`, `false`, nested objects, and arrays. Returning to form mode preserves fields the form can represent; otherwise the popup keeps JSON mode. Results are displayed as JSON, so a new tool does not require a renderer or arbitrary popup code.

## Dynamic discovery and lifecycle

`setup` runs once per enabled plugin per document. It receives `window`, `origin`, bound `fetch`, session `storage`, and `navigate(url)`. Use the tool's execution signal in fetch calls. `navigate` defers navigation briefly so the tool can acknowledge it; callers must reacquire tools after the new document loads.

Instead of an array, return a function that discovers the current tools:

```ts
setup({ window }) {
  const document = window.document;
  return {
    tools: async () => {
      const tools = [readPageTool]; // Tool definitions created by your plugin.
      if (document.querySelector('[data-editor-open]')) tools.push(readDraftTool);
      return tools;
    },
    subscribe(refresh) {
      const observer = new MutationObserver(refresh);
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ['data-editor-open'],
        subtree: true,
      });
      return () => observer.disconnect();
    },
    dispose() {
      // Release any resources not owned by subscribe.
    },
  };
}
```

Observe specific state changes, and debounce noisy events in your plugin. For a site's router, subscribe to its navigation events. No generic history monkey-patching is performed. Path-specific plugins that become applicable only after a same-document route change may need a document reload; prefer matching the whole host and selecting tools by context.

The runtime serializes refreshes per plugin. It validates a new tool set before replacing the last one, updates handlers even if schemas are unchanged, unregisters removed tools, and refreshes native registrations only when their metadata changes. Calls already executing continue with their original handler. Disabling a plugin aborts its execution signal, unregisters tools, and invokes cleanup; handlers must honor cancellation.

```js
const api = window.webMCPDev.getPlugin('my-site');
await api.ready;
await api.refreshTools();
api.listTools();
api.status(); // Includes native registration errors or a failed discovery update.
```

An initial discovery error leaves the plugin diagnosable with no tools. A later refresh can recover it. The popup's **Refresh** rediscovers tools and updates its controls. Rebuilding source code requires reloading the extension and website tab; refreshing the tool list does not replace loaded JavaScript.

## Errors and boundaries

Throw `new ToolError('CODE', 'Helpful message', optionalDetails)` for an expected failure. The runtime returns it as a structured error. Invalid SDK inputs yield `INVALID_INPUT`; invalid declared outputs yield `INVALID_OUTPUT`. Cancellation yields `ABORTED`. Unexpected exceptions yield `INTERNAL_ERROR`.

Plugins share the website's main world. They have no special Chrome privileges through this SDK, no credentials store, and no isolation from other page scripts. Keep returned page content marked untrusted. Mark tools that publish or make consequential changes accordingly; annotations describe behavior and do not replace caller authorization.

## Packaging and verification

The reusable source package is the entire plugin folder. Copy it into `src/plugins` of a WebMCP Dev project and rebuild. For integration tests, include a package outside that directory with:

```sh
node scripts/build.mjs --outdir /tmp/webmcp-test/build --extra-plugin /absolute/path/to/plugin
```

The destination must end in `build` or `dist`; the build replaces that output directory. Imports from `@webmcp-dev/sdk` resolve through the host build even for external plugin folders. This is a local developer packaging convention, not a remote code marketplace or npm distribution.

The build emits one self-contained `plugins/<id>.js`, a metadata catalog, and the union of site permissions. All executable code ships in the extension. Do not dynamically fetch and evaluate plugin JavaScript. Use fixtures like `tests/plugin-fixture` to verify your plugin without changing real site data.


## Local MCP exposure

No transport code is needed inside a site plugin. When the user shares a matching tab, its enabled tools are exposed through the bundled MCP server. Dynamic metadata is refreshed every two seconds and after calls, and MCP clients receive tool-list-change notifications. Clients rediscover tools after selecting a tab or changing context; clients with a cached tool list can use the stable `webmcp_call_tool` fallback with the original page input.

Tool names must start with a letter, contain only letters, digits, underscores, or hyphens, and be at most 128 characters. The `webmcp_` prefix is reserved for the bridge's management tools. Keep tool names stable and prefix them with your plugin ID.

Object input schemas pass through directly. MCP requires object arguments, so a page tool with a root array, scalar, or union uses `{ "value": <original input> }` at the MCP boundary. The handler still receives its original input type. Optional output schemas describe `{ "ok": true, "data": <handler output> }`; errors use MCP's `isError` flag and a JSON text result. Nested local JSON-pointer references are preserved when wrapping schemas.

For navigation, return `{ url, navigation_started: true }` after calling `environment.navigate(url)`. The bridge waits up to 15 seconds for a replacement document before acknowledging the call. Same-document UI changes should return their normal result. Keep the user-visible page in sync with the task through explicit navigation or DOM updates in your handlers.

The extension executes only named registry tools, targeted at the selected document ID. It propagates MCP cancellation via `window.webMCPDev.callRequest(id, name, input)` and `cancelRequest(id)`. Handlers should honor the provided AbortSignal; cancellation cannot undo a request already accepted by the website.
