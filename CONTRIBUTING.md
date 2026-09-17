# Contributing

For a new website, start with the [site plugin guide](docs/plugins.md). A plugin owns its tool schemas and handlers; the shared extension discovers them automatically.

## Development

```sh
npm ci
npx playwright install chromium
npm run check
```

Requires Node 22+ and Chrome/Chromium 120+. Browser tests create temporary Chromium profiles and use fixtures for website requests. Do not use real accounts or publish real posts in tests.

After changing extension or plugin code, run `npm run build`, reload the unpacked extension, and refresh the website. After changing bridge code, stop the local relay with `npm run mcp:stop` and reconnect the MCP client.

## Pull requests

Explain the behavior that changes and how you verified it. Keep site-specific logic in the relevant plugin folder. For a new tool, include its input schema, validation, and annotations, and describe whether it navigates, changes the page, or publishes data.

Add regression coverage for behavior changes where it catches a meaningful failure. Use mocked website responses and isolated browser profiles. Keep session credentials, pairing codes, personal browsing data, and generated build output out of commits.
