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
import { dirname, join } from 'node:path';
import { HOSTED_RELAY_DIRECTORY_ORIGIN } from '@ferretry/relay';
import viteConfig, {
  ENTITY_DECODER,
  entityDecoderTrustedTypes,
  entityDecoderWithoutDom,
  leafletTrustedTypes,
} from '../../vite.config.ts';

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

/**
 * Leaflet writes `div.innerHTML = '<svg/>'` while it loads, to learn whether the browser has inline SVG. Under
 * `require-trusted-types-for 'script'` that is a thrown TypeError at import, which would take every map down.
 * The plugin removes the write at build time; these cases pin that it still finds it, and that a Leaflet
 * which changes shape stops the build rather than shipping unaudited.
 */
describe('the Leaflet Trusted Types transform', () => {
  const leaflet = '/repo/node_modules/leaflet/dist/leaflet-src.js';
  const feature =
    "var inlineSvg = !!svg$1 && (function () { var div = document.createElement('div'); div.innerHTML = '<svg/>'; return (div.firstChild && div.firstChild.namespaceURI) === 'http://www.w3.org/2000/svg'; })();";

  it('removes the load-time markup write from the real Leaflet source', async () => {
    const source = await Bun.file(import.meta.resolve('leaflet/dist/leaflet-src.js').replace('file://', '')).text();
    const out = leafletTrustedTypes.transform(source, leaflet);
    expect(out).toBeString();
    expect(out).not.toContain("innerHTML = '<svg/>'");
    expect(out).toContain('var inlineSvg = !!svg$1;');
  });

  it('rewrites the ESM build too and ignores a query string', () => {
    expect(leafletTrustedTypes.transform(feature, '/x/leaflet/dist/leaflet-src.esm.js?v=1')).not.toContain('<svg/>');
  });

  it('leaves every other module alone', () => {
    expect(leafletTrustedTypes.transform(feature, '/repo/src/other.js')).toBeUndefined();
  });

  it('refuses to build when Leaflet no longer has the write it expects', () => {
    expect(() => leafletTrustedTypes.transform('var nothing;', leaflet)).toThrow(/re-audit/u);
  });
});

/**
 * Every markdown body decodes `&amp;`-style references through `decode-named-character-reference`, whose
 * BROWSER build writes the reference into an element's `innerHTML` — a thrown TypeError under
 * `require-trusted-types-for 'script'`, which took a chat holding `&F142;` down to "reload to recover" on
 * every open (2026-10-30). The plugin hands the bundle the package's table-based build instead; these cases
 * pin that it does, that the build it picks writes no markup, and that a reshaped package stops the build.
 */
describe('the markdown entity decoder', () => {
  // A transitive dependency: reached the way the bundle reaches it, through micromark.
  const micromark = Bun.resolveSync('micromark', Bun.resolveSync('react-markdown', import.meta.dir));
  const decoder = Bun.resolveSync(ENTITY_DECODER, micromark);
  const directory = dirname(decoder);
  const SINKS = /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.|new Function\(|\beval\(/u;

  it('is in the plugins the bundle is built with', () => {
    expect(viteConfig.plugins).toContain(entityDecoderTrustedTypes);
  });

  it('sends the browser build to the table-based one, query string kept', () => {
    expect(entityDecoderWithoutDom(join(directory, 'index.dom.js'))).toBe(join(directory, 'index.js'));
    expect(entityDecoderWithoutDom(join(directory, 'index.js'))).toBe(join(directory, 'index.js'));
    expect(entityDecoderWithoutDom('/x/decode-named-character-reference/index.dom.js?v=1')).toBe(
      '/x/decode-named-character-reference/index.js?v=1',
    );
  });

  it('refuses to build when the package resolves to a file it has not audited', () => {
    expect(() => entityDecoderWithoutDom('/x/decode-named-character-reference/lib/decode.js')).toThrow(/re-audit/u);
  });

  it('redirects through the real resolver, and leaves every other specifier alone', async () => {
    const asked: string[] = [];
    const context = {
      resolve: async (source: string) => {
        asked.push(source);
        return { id: join(directory, 'index.dom.js'), external: false };
      },
    };
    expect(await entityDecoderTrustedTypes.resolveId.call(context, ENTITY_DECODER, micromark)).toEqual({
      id: join(directory, 'index.js'),
      external: false,
    });
    expect(await entityDecoderTrustedTypes.resolveId.call(context, 'micromark', undefined)).toBeNull();
    expect(asked).toEqual([ENTITY_DECODER]);
  });

  it('picks a file that writes no markup and still decodes, where the browser build writes innerHTML', async () => {
    // Why the plugin exists: if the browser build ever stops writing markup, this is the line that says so.
    expect(SINKS.exec(await Bun.file(join(directory, 'index.dom.js')).text())?.[0]).toBe('document.');
    const table = join(directory, 'index.js');
    expect({ table, sink: SINKS.exec(await Bun.file(table).text())?.[0] ?? null }).toEqual({ table, sink: null });
    const { decodeNamedCharacterReference } = (await import(table)) as {
      readonly decodeNamedCharacterReference: (value: string) => string | false;
    };
    expect(decodeNamedCharacterReference('amp')).toBe('&');
    expect(decodeNamedCharacterReference('F142')).toBe(false);
  });
});

/**
 * A `chart` is drawn IN THE PAGE (`fy-render-chart-engine.ts`), which is only sound while the three
 * libraries it bundles never write markup, never compile a string into code and never reach the network:
 * the page refuses a string at a script sink (`require-trusted-types-for 'script'`, no default policy),
 * so a library that started doing any of it would either throw at import or — worse — need a policy
 * widened to load. An upgrade that adds one fails here and must be re-audited before it ships.
 */
describe('the chart libraries', () => {
  const file = (specifier: string, from = import.meta.dir): string => Bun.resolveSync(specifier, from);
  const chartJs = file('chart.js');
  const zoom = file('chartjs-plugin-zoom');
  const sources = [chartJs, join(dirname(chartJs), 'chunks/index.js'), zoom, file('hammerjs', dirname(zoom))];
  const SINKS =
    /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write|new Function\(|\beval\(|\bfetch\(|XMLHttpRequest|importScripts/u;

  it('write no markup, compile no string and open no request', async () => {
    for (const path of sources) {
      const source = await Bun.file(path).text();
      expect(source.length).toBeGreaterThan(0);
      expect({ path, sink: SINKS.exec(source)?.[0] ?? null }).toEqual({ path, sink: null });
    }
  });
});
