// HTTP(S), exact or *.host, and globbed paths. Validated again at build time.
export function matchesPattern(pattern: string, href: string): boolean {
  const match = pattern.match(/^(https?|\*):\/\/(\*\.)?([a-z0-9.-]+)(\/.*)$/i);
  if (!match) return false;
  let url: URL;
  try { url = new URL(href); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  if (match[1] !== '*' && `${match[1]}:` !== url.protocol) return false;
  const host = match[3].toLowerCase();
  if (url.hostname !== host && !(match[2] && url.hostname.endsWith(`.${host}`))) return false;
  const path = match[4].split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${path}$`).test(url.pathname + url.search);
}

export function matchesSite(manifest: { matches: string[] }, href: string): boolean {
  return manifest.matches.some(pattern => matchesPattern(pattern, href));
}
