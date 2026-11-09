import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cspHashOf,
  GET_STARTED_PAGE,
  getStartedPagePlugin,
  HEADERS_FILE,
  inlineScriptsOf,
  scriptSrcOf,
  unlistedScriptHashes,
} from '../../scripts/get-started-page.ts';
import config from '../../vite.config.ts';

/**
 * S14 (m6, m4): the static `/get-started/` page is Onboarding's own document, emitted by the shell's build, and its
 * inline scripts are allowed by the shell's CSP by HASH — not by `'unsafe-inline'`. The test pins the page and the
 * header against each other, and the BUILD refuses a page whose script hash the header does not list (a planted drift
 * below proves it), so drift cannot ship a first-run page the browser blocks.
 */

const page = readFileSync(GET_STARTED_PAGE, 'utf8');
const headers = readFileSync(HEADERS_FILE, 'utf8');
const release = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../release.json', import.meta.url)), 'utf8'),
) as { version: string };

const inlineScripts = inlineScriptsOf(page);
const scriptSrc = scriptSrcOf(headers);

type Emitted = { type: string; fileName: string; source: string };
interface BuildPlugin {
  readonly name: string;
  readonly generateBundle: (this: { emitFile: (file: Emitted) => void; error: (message: string) => never }) => void;
}

/** Runs a plugin's `generateBundle` the way rollup would, collecting what it emits and what it rejects with. */
function build(plugin: BuildPlugin): { readonly emitted: Emitted[]; readonly error: string | undefined } {
  const emitted: Emitted[] = [];
  try {
    plugin.generateBundle.call({
      emitFile: file => emitted.push(file),
      error: message => {
        throw new Error(message);
      },
    });
  } catch (error: unknown) {
    return { emitted, error: error instanceof Error ? error.message : String(error) };
  }
  return { emitted, error: undefined };
}

describe('S14 the get-started page', () => {
  it('has inline scripts, none of them carrying the release placeholder (a stamped script would change its hash)', () => {
    expect(inlineScripts.length).toBeGreaterThan(0);
    for (const script of inlineScripts) expect(script).not.toContain('%FY_RELEASE_VERSION%');
  });

  it('the CSP hash matches every inline script', () => {
    expect(scriptSrc).toBeDefined();
    for (const script of inlineScripts) expect(scriptSrc).toContain(cspHashOf(script));
    expect(unlistedScriptHashes(page, headers)).toEqual([]);
  });

  it('the CSP lets scripts run by hash alone: no unsafe-inline in script-src', () => {
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it('the build emits the page as get-started/index.html with the release version stamped in', () => {
    const plugin = (config.plugins ?? [])
      .flat()
      .find(
        (candidate): candidate is BuildPlugin =>
          typeof candidate === 'object' &&
          candidate !== null &&
          'name' in candidate &&
          candidate.name === 'fy-get-started-page',
      );
    expect(plugin).toBeDefined();
    const { emitted, error } = build(plugin as BuildPlugin);
    expect(error).toBeUndefined();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.fileName).toBe('get-started/index.html');
    expect(emitted[0]?.type).toBe('asset');
    expect(emitted[0]?.source).toBe(page.replaceAll('%FY_RELEASE_VERSION%', release.version));
    expect(emitted[0]?.source).not.toContain('%FY_RELEASE_VERSION%');
  });

  it('m4 the build FAILS when an inline script drifted from the header, naming the hash to add, and emits nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fy-get-started-'));
    try {
      const drifted = join(dir, 'index.html');
      // One character of the real script changed: the page now carries a script the header has never heard of.
      const script = inlineScripts[0] ?? '';
      writeFileSync(drifted, page.replace(script, `${script}\n/* drift */`));
      const planted = getStartedPagePlugin({ version: release.version, pagePath: drifted });
      const { emitted, error } = build(planted as unknown as BuildPlugin);
      expect(error).toContain('inline script');
      expect(error).toContain(cspHashOf(`${script}\n/* drift */`));
      expect(emitted).toEqual([]);

      // And a header with no script-src at all allows nothing.
      const bare = join(dir, '_headers');
      writeFileSync(bare, '/*\n  Content-Security-Policy: default-src self\n');
      const noPolicy = getStartedPagePlugin({ version: release.version, headersPath: bare });
      expect(build(noPolicy as unknown as BuildPlugin).error).toContain(cspHashOf(script));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
