import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  arrivalScriptIsFirst,
  carriesOwnPolicy,
  cspHashOf,
  servedPathOf,
  GET_STARTED_PAGE,
  getStartedPagePlugin,
  HEADERS_FILE,
  hasOwnPolicy,
  htmlPagesUnder,
  inlineScriptsOf,
  isSandboxedByHeader,
  PUBLIC_DIR,
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
const appPage = readFileSync(fileURLToPath(new URL('../../app/index.html', import.meta.url)), 'utf8');
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
    const { error, emitted } = build(real(), asBundle({ 'index.html': landing, 'app/index.html': appPage }));
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

  it('m1 a generated sandbox-shaped page under a `!` path passes, in a tree where the shells WERE generated', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fy-get-started-'));
    try {
      // The shape `build:fy-render-shell` writes: one inline script, pinned by its own meta CSP, absent from `/*`.
      for (const shell of ['fy-render-sandbox.html', 'fy-render-html.html'])
        writeFileSync(
          join(dir, shell),
          '<meta http-equiv="Content-Security-Policy" content="x"><script>shell()</script>',
        );
      const plugin = getStartedPagePlugin({ version: release.version, publicDir: dir });
      const { error } = build(plugin as unknown as BuildPlugin, asBundle({ 'index.html': landing }));
      expect(error).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('m1 the same page under a normal path fails, and the message never advises adding its hash to `/*`', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fy-get-started-'));
    try {
      writeFileSync(join(dir, 'ordinary.html'), '<script>shell()</script>');
      const plugin = getStartedPagePlugin({ version: release.version, publicDir: dir });
      const { error } = build(plugin as unknown as BuildPlugin, asBundle({ 'index.html': landing }));
      expect(error).toContain('The ordinary.html page');
      expect(error).toContain('Remove the inline script');
      expect(error).toContain('exclude /ordinary');
      expect(error).not.toContain('add ');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('m1 the `!` paths are read from _headers, in both spellings', () => {
    expect(hasOwnPolicy('fy-render-sandbox.html', headers)).toBe(true);
    expect(hasOwnPolicy('fy-render-html.html', headers)).toBe(true);
    expect(hasOwnPolicy('index.html', headers)).toBe(false);
    expect(hasOwnPolicy('oauth/callback.html', headers)).toBe(false);
  });

  /** Runs the real plugin over a temp `public/` holding `files`, with `_headers` replaced by `headerText`. */
  const buildWith = (files: Record<string, string>, headerText: string): string | undefined => {
    const dir = mkdtempSync(join(tmpdir(), 'fy-get-started-'));
    try {
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(join(dir, name, '..'), { recursive: true });
        writeFileSync(join(dir, name), text);
      }
      const planted = join(dir, '_headers.txt');
      writeFileSync(planted, headerText);
      const plugin = getStartedPagePlugin({ version: release.version, publicDir: dir, headersPath: planted });
      return build(plugin as unknown as BuildPlugin, asBundle({ 'index.html': landing })).error;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const base = headers.slice(0, headers.indexOf('# The `fy-render` sandbox shell'));
  const own = '<meta http-equiv="Content-Security-Policy" content="x"><script>shell()</script>';
  const bang = (path: string): string => `${base}\n${path}\n  ! Content-Security-Policy\n`;
  /** The same rule as the real shells carry: out of `/*`, and a sandboxed (opaque-origin) document. */
  const sandboxed = (path: string): string =>
    `${bang(path)}  Content-Security-Policy: frame-ancestors 'self'; sandbox allow-scripts\n`;

  it('m1 a `!` rule on the REDIRECT spelling only does not skip the page; the SERVED spelling does', () => {
    // x.html is served at /x
    const onHtml = buildWith({ 'x.html': own }, bang('/x.html'));
    expect(onHtml).toContain('The x.html page');
    expect(onHtml).toContain('/x.html, a spelling Pages redirects');
    expect(onHtml).toContain('put the rule on /x');
    expect(buildWith({ 'x.html': own }, sandboxed('/x'))).toBeUndefined();
    // d/index.html is served at /d/
    expect(buildWith({ 'd/index.html': own }, bang('/d'))).toContain('The d/index.html page');
    expect(buildWith({ 'd/index.html': own }, bang('/d/index.html'))).toContain('The d/index.html page');
    expect(buildWith({ 'd/index.html': own }, sandboxed('/d/'))).toBeUndefined();
  });

  it('m1 servedPathOf is the one spelling Pages serves', () => {
    expect(servedPathOf('x.html')).toBe('/x');
    expect(servedPathOf('d/index.html')).toBe('/d/');
    expect(servedPathOf('index.html')).toBe('/');
    expect(hasOwnPolicy('x.html', bang('/x.html'))).toBe(false);
    expect(hasOwnPolicy('x.html', bang('/x'))).toBe(true);
  });

  it('n1 a skipped page’s inline script does not count as using a `/*` hash: an unused `/*` hash is refused', () => {
    const listed = `${base.replace("script-src 'self'", `script-src 'self' ${cspHashOf('shell()')}`)}\n/x\n  ! Content-Security-Policy\n`;
    const error = buildWith({ 'x.html': own }, listed);
    expect(error).toContain(cspHashOf('shell()'));
    expect(error).toContain('no page');
  });

  it('n3 a skipped page with no policy of its own fails; a meta CSP or a `_headers` CSP line on its path passes', () => {
    const bare = '<script>shell()</script>';
    expect(buildWith({ 'x.html': bare }, bang('/x'))).toContain('carries no policy of its own');
    expect(buildWith({ 'x.html': own }, sandboxed('/x'))).toBeUndefined();
    expect(
      buildWith({ 'x.html': bare }, `${bang('/x')}  Content-Security-Policy: frame-ancestors 'self'; sandbox\n`),
    ).toBeUndefined();
    expect(carriesOwnPolicy('x.html', bare, bang('/x'))).toBe(false);
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

/**
 * THE PAIRING FRAGMENT LEAVES THE ADDRESS FIRST, ON EVERY DOCUMENT (shell contract S3, early half). The build refuses
 * any HTML page it emits whose first script is not `public/arrival.js`: a page the check does not name could keep a
 * live code in the address for the whole load.
 */
describe('every emitted HTML page starts with the early-arrival script', () => {
  const real = () => getStartedPagePlugin({ version: release.version }) as unknown as BuildPlugin;
  const ARRIVAL = '<script src="/arrival.js"></script>';
  const publicPages = htmlPagesUnder(PUBLIC_DIR).filter(([name]) => !hasOwnPolicy(name, headers));

  it('the sources the build emits as served documents all begin with it (a page copied from public/ included)', () => {
    expect(publicPages.map(([name]) => name)).toContain('oauth/mcp-callback.html');
    for (const [name, source] of [
      ['index.html', landing],
      ['app/index.html', appPage],
      ['get-started/index.html', page],
      ...publicPages,
    ] as const)
      expect([name, arrivalScriptIsFirst(source)]).toEqual([name, true]);
  });

  it('the real pages pass, and the generated sandbox shells are exempt only because _headers sandboxes them', () => {
    expect(isSandboxedByHeader('fy-render-sandbox.html', headers)).toBe(true);
    expect(isSandboxedByHeader('fy-render-html.html', headers)).toBe(true);
    expect(isSandboxedByHeader('index.html', headers)).toBe(false);
    expect(build(real(), asBundle({ 'index.html': landing, 'app/index.html': appPage })).error).toBeUndefined();
  });

  it('a page whose theme script comes first fails the build, naming the page', () => {
    const late = appPage
      .replace(/<script src="\/arrival\.js"><\/script>/u, '')
      .replace('<script src="/pre-paint.js"></script>', `<script src="/pre-paint.js"></script>\n${ARRIVAL}`);
    expect(arrivalScriptIsFirst(late)).toBe(false);
    const { error, emitted } = build(real(), asBundle({ 'index.html': landing, 'app/index.html': late }));
    expect(error).toContain('The app/index.html page does not start with the early-arrival script');
    expect(emitted).toEqual([]);
  });

  it('a page without it, one with only an inline script before it, or a stylesheet before it, fails', () => {
    const cases: Record<string, string> = {
      none: '<html><head><title>x</title></head><body></body></html>',
      inline: `<head><script>1</script>${ARRIVAL}</head>`,
      stylesheet: `<head><link rel="stylesheet" href="/a.css">${ARRIVAL}</head>`,
      style: `<head><style>a{}</style>${ARRIVAL}</head>`,
      other: '<head><script src="/arrival.js.map"></script></head>',
      commented: `<head><!-- ${ARRIVAL} --><script src="/other.js"></script></head>`,
    };
    for (const [label, source] of Object.entries(cases))
      expect([label, arrivalScriptIsFirst(source)]).toEqual([label, false]);
    const { error } = build(real(), asBundle({ 'index.html': landing, 'x.html': cases.inline ?? '' }));
    expect(error).toBeDefined();
  });

  it('what passes: it first, a data-drop attribute, favicons and comments before it, other scripts after', () => {
    for (const source of [
      `<head>${ARRIVAL}<script src="/pre-paint.js"></script></head>`,
      '<head><script src="/arrival.js" data-drop></script><script>1</script></head>',
      `<head><!-- <script src="/x.js"></script> --><link rel="icon" href="/i.svg">${ARRIVAL}</head>`,
    ])
      expect(arrivalScriptIsFirst(source)).toBe(true);
  });

  it('a page with a policy of its own that is NOT sandboxed fails: only a sandboxed shell is exempt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fy-get-started-'));
    try {
      writeFileSync(
        join(dir, 'x.html'),
        '<meta http-equiv="Content-Security-Policy" content="x"><script>shell()</script>',
      );
      const own = `${headers.slice(0, headers.indexOf('# The \`fy-render\` sandbox shell'))}\n/x\n  ! Content-Security-Policy\n`;
      const planted = join(dir, '_headers.txt');
      writeFileSync(planted, own);
      const plugin = getStartedPagePlugin({ version: release.version, publicDir: dir, headersPath: planted });
      const { error } = build(plugin as unknown as BuildPlugin, asBundle({ 'index.html': landing }));
      expect(error).toContain('The x.html page is served with a policy of its own and is not sandboxed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
