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
      for (const [name, source] of pages) {
        const unlisted = unlistedScriptHashes(source, headers);
        if (unlisted.length > 0)
          this.error(
            `The ${name} page has inline script(s) the CSP does not allow: add ${unlisted.join(' ')} to script-src ` +
              `in packages/app/public/_headers (or the page and the header have drifted apart), otherwise the browser ` +
              `blocks the script and the page does nothing.`,
          );
      }
      const unused = unusedScriptHashes(
        pages.map(([, source]) => source),
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
