/** The path (and plain query) of a `Link` header's `rel="next"` target on `api.github.com`, or `undefined` when there is none. */
export function nextPagePath(link: string | undefined): string | undefined {
  if (link === undefined) return undefined;
  for (const part of link.split(',')) {
    const match = /^\s*<([^>]{1,2048})>\s*;\s*rel="next"\s*$/u.exec(part);
    if (match?.[1] === undefined) continue;
    let url: URL;
    try {
      url = new URL(match[1]);
    } catch {
      return undefined;
    }
    // Only ever the API host over https: a `Link` that points anywhere else is not followed.
    if (url.protocol !== 'https:' || url.host !== 'api.github.com' || url.username !== '' || url.password !== '')
      return undefined;
    return `${url.pathname}${url.search}`;
  }
  return undefined;
}
