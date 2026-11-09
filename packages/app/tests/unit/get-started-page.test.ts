import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  unusedScriptHashes,
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

const landing = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');
const asBundle = (pages: Record<string, string>): Bundle =>
  Object.fromEntries(Object.entries(pages).map(([name, source]) => [name, { type: 'asset', fileName: name, source }]));

const inlineScripts = inlineScriptsOf(page);
const scriptSrc = scriptSrcOf(headers);

type Emitted = { type: string; fileName: string; source: string };
type Bundle = Readonly<Record<string, { type: string; fileName?: string; source?: unknown }>>;
interface BuildPlugin {
  readonly name: string;
  readonly generateBundle: (
    this: { emitFile: (file: Emitted) => void; error: (message: string) => never },
    options: unknown,
    bundle: Bundle,
  ) => void;
}

/** Runs a plugin's `generateBundle` the way rollup would (over `bundle`, the build's other files), collecting what it emits and what it rejects with. */
function build(
  plugin: BuildPlugin,
  bundle: Bundle = {},
): { readonly emitted: Emitted[]; readonly error: string | undefined } {
  const emitted: Emitted[] = [];
  try {
    plugin.generateBundle.call(
      {
        emitFile: file => emitted.push(file),
        error: message => {
          throw new Error(message);
        },
      },
      {},
      bundle,
    );
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
    const { emitted, error } = build(plugin as BuildPlugin, asBundle({ 'index.html': landing }));
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

describe('S14 m3 every HTML page the build emits is checked, not just this one', () => {
  const real = () => getStartedPagePlugin({ version: release.version }) as unknown as BuildPlugin;

  it('the landing page’s inline scripts (its paired-device redirect among them) are all listed in script-src', () => {
    expect(inlineScriptsOf(landing).length).toBeGreaterThan(0);
    expect(unlistedScriptHashes(landing, headers)).toEqual([]);
  });

  it('the real pages pass together', () => {
    const { error, emitted } = build(real(), asBundle({ 'index.html': landing, 'app/index.html': '<html></html>' }));
    expect(error).toBeUndefined();
    expect(emitted.map(file => file.fileName)).toEqual(['get-started/index.html']);
  });

  it('a planted drift on index.html fails the build, naming the page and the hash, and emits nothing', () => {
    const script = inlineScriptsOf(landing)[0] ?? '';
    const drifted = landing.replace(script, `${script}\n/* drift */`);
    const { error, emitted } = build(real(), asBundle({ 'index.html': drifted }));
    expect(error).toContain('The index.html page');
    expect(error).toContain(cspHashOf(`${script}\n/* drift */`));
    expect(emitted).toEqual([]);
  });

  it('a planted drift on the app page fails the same way, and a non-page file is not read as one', () => {
    const rogue = '<script>alert(1)</script>';
    const { error } = build(real(), asBundle({ 'app/index.html': rogue }));
    expect(error).toContain('The app/index.html page');
    expect(error).toContain(cspHashOf('alert(1)'));
    const notAPage: Bundle = {
      ...asBundle({ 'index.html': landing }),
      'assets/app.js': { type: 'chunk', source: rogue },
      'a.txt': { type: 'asset', source: rogue },
    };
    expect(build(real(), notAPage).error).toBeUndefined();
  });

  it('m1 a planted UNUSED hash in script-src fails the build, naming it, and emits nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fy-get-started-'));
    try {
      const stale = "'sha256-+wiRIqS9x5FvDCgblRWdz5D6qiFnSdt9s0Fren/SWoo='";
      const planted = join(dir, '_headers');
      writeFileSync(planted, headers.replace("script-src 'self'", `script-src 'self' ${stale}`));
      const plugin = getStartedPagePlugin({ version: release.version, headersPath: planted });
      const { error, emitted } = build(plugin as unknown as BuildPlugin, asBundle({ 'index.html': landing }));
      expect(error).toContain(stale);
      expect(error).toContain('no page');
      expect(emitted).toEqual([]);
      expect(unusedScriptHashes([landing, page], headers)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('m1 a planted inline script in a public/ page with no hash fails the build, naming the page', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fy-get-started-'));
    try {
      mkdirSync(join(dir, 'oauth'));
      writeFileSync(join(dir, 'oauth', 'planted.html'), '<script>alert(1)</script>');
      const plugin = getStartedPagePlugin({ version: release.version, publicDir: dir });
      const { error, emitted } = build(plugin as unknown as BuildPlugin, asBundle({ 'index.html': landing }));
      expect(error).toContain('The oauth/planted.html page');
      expect(error).toContain(cspHashOf('alert(1)'));
      expect(emitted).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('n2 hashes the STAMPED page: a placeholder inside a script cannot pass on the strength of its unstamped text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fy-get-started-'));
    try {
      const stamped = join(dir, 'index.html');
      const body = 'window.__v = "%FY_RELEASE_VERSION%";';
      writeFileSync(stamped, `<script>${body}</script>`);
      const bare = join(dir, '_headers');
      // The header lists the hash of the UNSTAMPED text, which is what the old check read.
      writeFileSync(bare, `/*\n  Content-Security-Policy: script-src 'self' ${cspHashOf(body)}\n`);
      const plugin = getStartedPagePlugin({ version: release.version, pagePath: stamped, headersPath: bare });
      const { error } = build(plugin as unknown as BuildPlugin);
      expect(error).toContain(cspHashOf(body.replace('%FY_RELEASE_VERSION%', release.version)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
