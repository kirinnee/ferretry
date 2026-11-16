/**
 * THE HEADERS A VERIFIED FILE IS SERVED WITH — decided by the signed worker, never by the edge.
 *
 * The signed list covers a file's BYTES, not the headers a host sends with them, and `_headers` is
 * Pages configuration the list cannot name. So the service worker is BUILT with the rules in
 * `public/_headers` (`scripts/build-release.ts` compiles them in, as it does `_redirects`), and every
 * response it answers from a verified release carries exactly those rules' headers plus a content type
 * from the file's extension. Nothing a host sent when the file was fetched — a weakened CSP, a
 * `Content-Type` swap, a `Refresh` — is ever replayed. See `docs/pwa-release-signing.md`.
 *
 * Pure: shared by the build script that compiles the rules and the worker that applies them.
 */

/** One rule from a Pages `_headers` file: a path pattern, headers to detach, headers to set. */
export interface ReleaseHeaderRule {
  readonly pattern: string;
  readonly detach: readonly string[];
  readonly set: readonly (readonly [string, string])[];
}

/**
 * The rules in a `_headers` file, in order. A line at column 0 starting with `/` opens a rule; an
 * indented `Name: value` sets a header and an indented `! Name` detaches one; `#` lines and blank
 * lines are comments. A line that is none of these opens nothing and adds nothing.
 */
export const parseReleaseHeaders = (text: string): readonly ReleaseHeaderRule[] => {
  const rules: { pattern: string; detach: string[]; set: [string, string][] }[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('/')) {
      rules.push({ pattern: line.trim(), detach: [], set: [] });
      continue;
    }
    const current = rules.at(-1);
    const body = line.trim();
    if (current === undefined || body === '' || body.startsWith('#') || !/^\s/u.test(line)) continue;
    if (body.startsWith('!')) {
      current.detach.push(body.slice(1).trim());
      continue;
    }
    const colon = body.indexOf(':');
    if (colon > 0) current.set.push([body.slice(0, colon).trim(), body.slice(colon + 1).trim()]);
  }
  return rules;
};

/** A Pages pattern as a regex: a splat (`*`) is any characters, a placeholder (`:name`) one segment. */
const patternExpression = (pattern: string): RegExp =>
  new RegExp(
    `^${pattern
      .replace(/[.+?^${}()|[\]\\]/gu, character => `\\${character}`)
      .replaceAll('*', '.*')
      .replace(/:[A-Za-z]\w*/gu, '[^/]+')}$`,
    'u',
  );

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  webmanifest: 'application/manifest+json',
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8',
  woff2: 'font/woff2',
};

/** The type a listed file is served as, from its extension. An unknown one is never sniffed. */
export const contentTypeFor = (path: string): string =>
  CONTENT_TYPES[path.slice(path.lastIndexOf('.') + 1)] ?? 'application/octet-stream';

/**
 * The headers that answer `pathname` with the file at `servedPath`. Every rule whose pattern matches
 * the REQUESTED path applies, in file order, the way Pages applies them: a detach removes what an
 * earlier rule set, and a header set twice is joined with `, `. The content type always comes from
 * the SERVED file's extension, so a rule can never make a script render as a page.
 */
export const releaseHeadersFor = (
  pathname: string,
  servedPath: string,
  rules: readonly ReleaseHeaderRule[],
): readonly (readonly [string, string])[] => {
  const headers = new Map<string, readonly [string, string]>();
  for (const rule of rules) {
    if (!patternExpression(rule.pattern).test(pathname)) continue;
    for (const name of rule.detach) headers.delete(name.toLowerCase());
    for (const [name, value] of rule.set) {
      const existing = headers.get(name.toLowerCase());
      headers.set(
        name.toLowerCase(),
        existing === undefined ? [name, value] : [existing[0], `${existing[1]}, ${value}`],
      );
    }
  }
  headers.set('content-type', ['Content-Type', contentTypeFor(servedPath)]);
  return [...headers.values()];
};
