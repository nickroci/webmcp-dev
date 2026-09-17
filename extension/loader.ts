// Runs in an isolated world, without exposing extension APIs to the website.
void chrome.runtime.sendMessage({ type: 'sync' }).catch(error => {
  console.warn('[WebMCP Dev] Could not activate site plugins.', String(error));
});
