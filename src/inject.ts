import { installRedditWebMCP } from './index';

try {
  const api = installRedditWebMCP();
  void api.ready.then(() => {
    if (api.status().registrationErrors.length) console.warn('[reddit-webmcp] Native registration failed; local tools remain available.', api.status().registrationErrors);
  });
} catch (error) {
  console.error('[reddit-webmcp] Could not initialize.', error instanceof Error ? error.message : error);
}
