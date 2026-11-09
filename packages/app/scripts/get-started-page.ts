/**
 * THE GET-STARTED PAGE (`/get-started/`) is Onboarding's own static document. Vite names an HTML input by its path
 * under this package, so a page outside it cannot be an input that lands at `get-started/index.html`: the build emits
 * it there instead, with the release version stamped in exactly as `fy-release-version` stamps the app's pages.
 *
 * Its inline scripts are allowed by the shell's CSP by HASH (`public/_headers`, `script-src`), never by
 * `'unsafe-inline'`. A script whose hash is not listed is blocked by the browser, so a page that drifted from the
 * header would ship a first-run page that does nothing: the build FAILS when any inline script's hash is missing from
 * the `script-src` of the policy that serves it (S14, m4) — for this page and for every other HTML page the build
 * emits (the landing page's redirect script is one). The check hashes the page as emitted, with the release stamp in, so a
 * placeholder inside a script cannot pass it and ship blocked.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export const GET_STARTED_PAGE = here('../../plugins/onboarding/app/get-started/index.html');
export const HEADERS_FILE = here('../public/_headers');
export const PUBLIC_DIR = here('../public');

/** The page's inline scripts, exactly as the browser hashes them (the text between the tags). */
export const inlineScriptsOf = (page: string): readonly string[] =>
  [...page.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1] ?? '');

export const cspHashOf = (script: string): string => `'sha256-${createHash('sha256').update(script).digest('base64')}'`;

/** The `script-src` directive of the policy `_headers` sends for every page (`/*`), or `undefined` when it has none. */
export const scriptSrcOf = (headers: string): string | undefined =>
  (headers.match(/^\s*Content-Security-Policy: (.*)$/m)?.[1] ?? '')
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith('script-src '));

/** The hashes of the page's inline scripts that the policy does not list: empty when the page and header agree. */
export const unlistedScriptHashes = (page: string, headers: string): readonly string[] => {
  const allowed = scriptSrcOf(headers) ?? '';
  return inlineScriptsOf(page)
    .map(cspHashOf)
    .filter(hash => !allowed.split(/\s+/u).includes(hash));
};

/** The `'sha256-…'` entries the policy lists in `script-src`. */
export const listedScriptHashes = (headers: string): readonly string[] =>
  (scriptSrcOf(headers) ?? '').split(/\s+/u).filter(entry => entry.startsWith("'sha256-"));

/**
 * The hashes the policy lists that NO page uses. An allowance nobody owns lets one exact old script run on every page,
 * and the missing-hash check can never see it.
 */
export const unusedScriptHashes = (pages: readonly string[], headers: string): readonly string[] => {
  const used = new Set(pages.flatMap(page => inlineScriptsOf(page).map(cspHashOf)));
  return listedScriptHashes(headers).filter(hash => !used.has(hash));
};

/**
 * The path patterns `_headers` takes OUT of the `/*` policy with `! Content-Security-Policy`. A page served there
 * carries its own policy (the `fy-render` shells pin their scripts in a meta CSP), so it is not judged against `/*`.
 * Read from the file itself, never from a hand list: a new reviewed exclusion needs no edit here.
 */
export const pathsWithOwnPolicy = (headers: string): readonly string[] =>
  headerRulesOf(headers)
    .filter(rule => rule.lines.includes('! Content-Security-Policy'))
    .map(rule => rule.pattern);

/** One `_headers` block: the path pattern and its indented lines, trimmed. */
interface HeaderRule {
  readonly pattern: string;
  readonly lines: readonly string[];
}

const headerRulesOf = (headers: string): readonly HeaderRule[] => {
  const rules: { pattern: string; lines: string[] }[] = [];
  for (const line of headers.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/u.test(line)) rules.push({ pattern: line.trim(), lines: [] });
    else rules.at(-1)?.lines.push(line.trim());
  }
  return rules;
};

const patternMatches = (pattern: string, path: string): boolean =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '.*')}$`, 'u').test(path);

/**
 * The ONE spelling Cloudflare Pages serves a built file at: `/x` for `x.html`, `/d/` for `d/index.html`, `/` for the
 * root `index.html`. Every other spelling (`/x.html`, `/d`, `/d/index.html`) is a 308 redirect, and `_headers` matches
 * the path that was REQUESTED, so a rule on a redirecting spelling never reaches the document itself.
 */
export const servedPathOf = (name: string): string => {
  const path = `/${name}`;
  if (path.endsWith('/index.html')) return path.slice(0, -'index.html'.length);
  return path.endsWith('.html') ? path.slice(0, -'.html'.length) : path;
};

/** True when `_headers` removes the spelling this page is SERVED at from `/*` (it keeps its own policy). */
export const hasOwnPolicy = (name: string, headers: string): boolean =>
  pathsWithOwnPolicy(headers).some(pattern => patternMatches(pattern, servedPathOf(name)));

/** The `!` patterns that match only a redirecting spelling of the page, not the one it is served at. */
const redirectingRulesOf = (name: string, headers: string): readonly string[] => {
  const path = `/${name}`;
  const others = [path, path.endsWith('/index.html') ? path.slice(0, -'/index.html'.length) : undefined];
  return pathsWithOwnPolicy(headers).filter(
    pattern =>
      !patternMatches(pattern, servedPathOf(name)) &&
      others.some(other => other !== undefined && patternMatches(pattern, other)),
  );
};

/**
 * True when a skipped page really carries its own policy: a `<meta http-equiv="Content-Security-Policy">` in the
 * document, or a `_headers` rule on the spelling it is served at that sends a `Content-Security-Policy` of its own.
 */
export const carriesOwnPolicy = (name: string, source: string, headers: string): boolean =>
  /<meta\s[^>]*http-equiv\s*=\s*["']?Content-Security-Policy["']?/iu.test(source) ||
  headerRulesOf(headers).some(
    rule =>
      rule.pattern !== '/*' && // the main policy is the one a `!` rule removes, not a policy of the page's own
      patternMatches(rule.pattern, servedPathOf(name)) &&
      rule.lines.some(line => /^Content-Security-Policy:/iu.test(line)),
  );

/** Every `.html` file under `dir` (the pages copied verbatim from `public/`), as `[path relative to dir, text]`. */
export const htmlPagesUnder = (dir: string): readonly (readonly [string, string])[] => {
  const found: [string, string][] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.html')) found.push([relative(dir, full), readFileSync(full, 'utf8')]);
    }
  };
  walk(dir);
  return found;
};

export interface GetStartedPageOptions {
  readonly version: string;
  /** The page's source, the headers file and the `public/` directory; the real ones unless a suite plants others. */
  readonly pagePath?: string;
  readonly headersPath?: string;
  readonly publicDir?: string;
}

/** What the build hands `generateBundle` that this check reads: the emitted files by name. */
export type EmittedBundle = Readonly<
  Record<string, { readonly type: string; readonly fileName?: string; readonly source?: unknown }>
>;

/** The text of an emitted HTML page, or `undefined` for anything else (a chunk, a stylesheet, an image). */
const htmlSourceOf = (name: string, file: EmittedBundle[string] | undefined): string | undefined => {
  if (file?.type !== 'asset' || !name.endsWith('.html')) return undefined;
  const source = file.source;
  if (typeof source === 'string') return source;
  return source instanceof Uint8Array ? new TextDecoder().decode(source) : undefined;
};

/**
 * The build plugin: stamps the release version into `get-started/index.html`, emits it, and checks the inline scripts
 * of EVERY HTML page the build emits (the landing page, the app page and this one) against the `script-src` hashes
 * `_headers` sends. The pages are read as emitted — stamped, and after Vite's own transforms — because the browser hashes
 * what it is served, not what the source said.
 */
export function getStartedPagePlugin(options: GetStartedPageOptions): Plugin {
  const pagePath = options.pagePath ?? GET_STARTED_PAGE;
  const headersPath = options.headersPath ?? HEADERS_FILE;
  const publicDir = options.publicDir ?? PUBLIC_DIR;
  return {
    name: 'fy-get-started-page',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle: EmittedBundle = {}) {
      const headers = readFileSync(headersPath, 'utf8');
      const stamped = readFileSync(pagePath, 'utf8').replaceAll('%FY_RELEASE_VERSION%', options.version);
      const pages: [string, string][] = [['get-started/index.html', stamped]];
      for (const [name, file] of Object.entries(bundle)) {
        const source = htmlSourceOf(name, file);
        if (source !== undefined) pages.push([name, source]);
      }
      // Pages copied from `public/` never enter the bundle, but the main policy serves them all the same.
      for (const [name, source] of htmlPagesUnder(publicDir)) pages.push([name, source]);
      // A page whose SERVED spelling `_headers` removes from `/*` (`! Content-Security-Policy`) must carry its own policy.
      const governed = pages.filter(([name]) => !hasOwnPolicy(name, headers));
      for (const [name, source] of pages) {
        if (hasOwnPolicy(name, headers) && !carriesOwnPolicy(name, source, headers))
          this.error(
            `The ${name} page is served at ${servedPathOf(name)}, which _headers takes out of the main CSP, but it ` +
              `carries no policy of its own: add a <meta http-equiv="Content-Security-Policy"> to the page or a ` +
              `Content-Security-Policy line to its _headers rule.`,
          );
      }
      for (const [name, source] of governed) {
        const unlisted = unlistedScriptHashes(source, headers);
        if (unlisted.length === 0) continue;
        const redirecting = redirectingRulesOf(name, headers);
        const served = servedPathOf(name);
        this.error(
          `The ${name} page has inline script(s) (${unlisted.join(' ')}) that the main CSP does not allow, so the ` +
            `browser blocks them. ` +
            (redirecting.length > 0
              ? `A \`! Content-Security-Policy\` rule names ${redirecting.join(' ')}, a spelling Pages redirects: the ` +
                `page is served at ${served}, so put the rule on ${served} instead. `
              : '') +
            `Remove the inline script, or exclude ${served} in packages/app/public/_headers ` +
            `(a reviewed choice: \`! Content-Security-Policy\` on that path, with the page carrying its own policy).`,
        );
      }
      const unused = unusedScriptHashes(
        governed.map(([, source]) => source),
        headers,
      );
      if (unused.length > 0)
        this.error(
          `The script-src in packages/app/public/_headers lists ${unused.join(' ')}, which no page the build emits ` +
            `uses: remove it (an allowance with no owner lets one exact old script run on every page).`,
        );
      this.emitFile({ type: 'asset', fileName: 'get-started/index.html', source: stamped });
    },
  };
}
