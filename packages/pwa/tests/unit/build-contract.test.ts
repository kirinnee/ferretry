/**
 * The Vite config decides directory names that things OUTSIDE this package
 * independently hardcode, so a rename here is not a local change.
 *
 * The separately owned Cloudflare Pages deployment is still pending. Its
 * declared contract is to publish `packages/pwa/dist/` and apply immutable
 * caching only beneath `assets/`. Rename either directory here and that deploy
 * will be wrong when it lands. Neither failure is visible in a build log, so
 * this package pins the values it owns against the real config object.
 *
 * The config is IMPORTED, not text-matched: what matters is the value Vite
 * resolves, including that the PostCSS pipeline really has Tailwind in it. A
 * missing plugin does not fail a build — it emits `@tailwind base;` as literal
 * text and ships an unstyled app.
 */

import { describe, expect, it } from 'bun:test';
import { HOSTED_RELAY_DIRECTORY_ORIGIN } from '@ferretry/relay';
import viteConfig from '../../vite.config.ts';

/**
 * The `define` this config resolves for one value of `FY_RELAY_DIRECTORY_ORIGIN`.
 *
 * RE-IMPORTED RATHER THAN READ OFF THE STATIC IMPORT ABOVE, because the override is computed at
 * module scope — the config object is a snapshot of the environment that was present the first time
 * this file was evaluated. A query suffix gives Bun a distinct module key, so each case evaluates
 * the real config against the environment it is about, which is the only version of this assertion
 * that could fail. The specifier is held in a variable so it stays a dynamic import: a literal one
 * would ask TypeScript to resolve a path with a query string that no loader declares.
 *
 * The environment is saved and restored around every case, including the deletion, so a run that
 * inherits `FY_RELAY_DIRECTORY_ORIGIN` from a shell — the E2E harness exports one — cannot make the
 * default case pass or fail for a reason that has nothing to do with this config.
 */
async function directoryDefine(origin: string | undefined, cacheKey: string): Promise<unknown> {
  const previous = process.env.FY_RELAY_DIRECTORY_ORIGIN;
  if (origin === undefined) delete process.env.FY_RELAY_DIRECTORY_ORIGIN;
  else process.env.FY_RELAY_DIRECTORY_ORIGIN = origin;
  const specifier = `../../vite.config.ts?directory-case=${cacheKey}`;
  try {
    const evaluated = (await import(specifier)) as { readonly default: typeof viteConfig };
    return evaluated.default.define?.__FY_RELAY_DIRECTORY__;
  } finally {
    if (previous === undefined) delete process.env.FY_RELAY_DIRECTORY_ORIGIN;
    else process.env.FY_RELAY_DIRECTORY_ORIGIN = previous;
  }
}

describe('the bundler contract', () => {
  const build = viteConfig.build ?? {};

  it('writes the directory the Pages project publishes', () => {
    expect(build.outDir).toBe('dist');
    expect(build.emptyOutDir).toBe(true);
  });

  it('fingerprints assets into the directory the cache headers name', () => {
    expect(build.assetsDir).toBe('assets');
  });

  it('targets the baseline the ported source already requires, without sourcemaps', () => {
    expect(build.target).toBe('es2022');
    expect(build.sourcemap).toBe(false);
  });

  it('resolves shared assets from the site root, not from either document route', () => {
    // `/app/` and `/d/<daemonId>/…` are both application routes. The landing
    // and the app share one root-level public icon/manifest set, so an `/app/`
    // base would rewrite those links to files the build does not emit.
    expect(viteConfig.base).toBe('/');
  });

  it('runs the design system through Tailwind and Autoprefixer', () => {
    const postcss = viteConfig.css?.postcss;
    const plugins = typeof postcss === 'object' && postcss !== null && 'plugins' in postcss ? postcss.plugins : [];
    const names = (plugins ?? []).map(plugin =>
      typeof plugin === 'object' && plugin !== null && 'postcssPlugin' in plugin ? plugin.postcssPlugin : undefined,
    );
    expect(names).toContain('tailwindcss');
    expect(names).toContain('autoprefixer');
  });

  it('refuses to move its dev port', () => {
    expect(viteConfig.server?.port).toBe(5173);
    expect(viteConfig.server?.strictPort).toBe(true);
  });
});

/**
 * THE ONE FACT NO OTHER TIER CAN CHECK: which directory the SHIPPED bundle asks.
 *
 * `__FY_RELAY_DIRECTORY__` is how the app learns where to read the hosted rendezvous
 * advertisement, and it exists only as a `define` this config resolves at build time. Every other
 * test of the reader — `features/hosted-relay.test.ts`, `store.test.tsx` — assigns the GLOBAL
 * directly, which proves the reader and says nothing about whether `vite build` would ever set it.
 *
 * That gap has already cost a build. The E2E harness passed `FY_RELAY_DIRECTORY_ORIGIN` and
 * believed the bundle carried no directory; this config read no environment at all, so the bundle
 * carried the PRODUCTION origin and every page load dialled a real Cloudflare Worker. The variable
 * was inert and nothing failed. The override below is what fixed it, and these are the cases that
 * make deleting it loud: with the variable set the bundle must ask THAT origin, and without it the
 * shared default `@ferretry/relay` owns — the same constant the daemon compiles in, so the two ends
 * cannot silently disagree about which directory to read.
 *
 * A `define` value is JavaScript source that Vite substitutes verbatim, so each case parses it
 * rather than comparing strings: a bare origin spliced into the bundle would be an identifier, not
 * a string literal, and would break the app at load rather than at build.
 */
describe('the relay directory the bundle asks', () => {
  it('compiles the shared hosted default when no origin is supplied', async () => {
    const value = await directoryDefine(undefined, 'default');

    expect(typeof value).toBe('string');
    expect(JSON.parse(String(value))).toBe(HOSTED_RELAY_DIRECTORY_ORIGIN);
  });

  it('compiles FY_RELAY_DIRECTORY_ORIGIN in place of the default when one is supplied', async () => {
    const value = await directoryDefine('http://127.0.0.1:45871', 'override');

    expect(JSON.parse(String(value))).toBe('http://127.0.0.1:45871');
    // Named explicitly: the failure this guards is the override being ignored, which looks exactly
    // like a passing build while the bundle dials the production directory instead.
    expect(JSON.parse(String(value))).not.toBe(HOSTED_RELAY_DIRECTORY_ORIGIN);
  });

  it('reads a blank origin as "use the default", never as a directory of no length', async () => {
    // The documented contract of the variable: an empty or whitespace value is how a caller says it
    // has no opinion. Compiling `''` would leave the app with a directory it can never read and no
    // relayed first pairing, which fails closed but for a reason nothing would name.
    expect(JSON.parse(String(await directoryDefine('', 'blank')))).toBe(HOSTED_RELAY_DIRECTORY_ORIGIN);
    expect(JSON.parse(String(await directoryDefine('   ', 'whitespace')))).toBe(HOSTED_RELAY_DIRECTORY_ORIGIN);
  });
});
