/**
 * THE GET-STARTED PAGE (`/get-started/`) is Onboarding's own static document. Vite names an HTML input by its path
 * under this package, so a page outside it cannot be an input that lands at `get-started/index.html`: the build emits
 * it there instead, with the release version stamped in exactly as `fy-release-version` stamps the app's pages.
 *
 * Its inline scripts are allowed by the shell's CSP by HASH (`public/_headers`, `script-src`), never by
 * `'unsafe-inline'`. A script whose hash is not listed is blocked by the browser, so a page that drifted from the
 * header would ship a first-run page that does nothing: the build FAILS when any inline script's hash is missing from
 * the `script-src` of the policy that serves it (S14, m4). The release stamp stays out of the scripts, so stamping the
 * version never changes a hash.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export const GET_STARTED_PAGE = here('../../plugins/onboarding/app/get-started/index.html');
export const HEADERS_FILE = here('../public/_headers');

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

export interface GetStartedPageOptions {
  readonly version: string;
  /** The page's source and the headers file; the real ones unless a suite plants others. */
  readonly pagePath?: string;
  readonly headersPath?: string;
}

/** The build plugin: stamps the release version, checks the CSP hashes, emits `get-started/index.html`. */
export function getStartedPagePlugin(options: GetStartedPageOptions): Plugin {
  const pagePath = options.pagePath ?? GET_STARTED_PAGE;
  const headersPath = options.headersPath ?? HEADERS_FILE;
  return {
    name: 'fy-get-started-page',
    apply: 'build',
    generateBundle() {
      const page = readFileSync(pagePath, 'utf8');
      const unlisted = unlistedScriptHashes(page, readFileSync(headersPath, 'utf8'));
      if (unlisted.length > 0)
        this.error(
          `The get-started page has inline script(s) the CSP does not allow: add ${unlisted.join(' ')} to script-src ` +
            `in packages/app/public/_headers (or the page and the header have drifted apart), otherwise the browser ` +
            `blocks the script and the page does nothing.`,
        );
      this.emitFile({
        type: 'asset',
        fileName: 'get-started/index.html',
        source: page.replaceAll('%FY_RELEASE_VERSION%', options.version),
      });
    },
  };
}
