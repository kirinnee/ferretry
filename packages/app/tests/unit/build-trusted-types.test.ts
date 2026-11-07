/**
 * The two Trusted Types fixes the bundle carries for Conversation's blocks (Leaflet's load-time markup write, the
 * Markdown entity decoder's browser build) and the audit of the chart libraries. Copied from today's PWA
 * `build-contract.test.ts`; the plugins live in `scripts/trusted-types-plugins.ts` and are registered in `vite.config.ts`.
 */

import { describe, expect, it } from 'bun:test';
import { dirname, join } from 'node:path';
import viteConfig from '../../vite.config.ts';
import {
  ENTITY_DECODER,
  entityDecoderTrustedTypes,
  entityDecoderWithoutDom,
  leafletTrustedTypes,
} from '../../scripts/trusted-types-plugins.ts';

/** Leaflet and the chart libraries are Conversation's dependencies, so they resolve from its folder. */
const CONVERSATION = join(import.meta.dir, '../../../plugins/conversation');

it('registers both plugins in the bundle', () => {
  expect(viteConfig.plugins).toContain(leafletTrustedTypes);
  expect(viteConfig.plugins).toContain(entityDecoderTrustedTypes);
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
    const source = await Bun.file(Bun.resolveSync('leaflet/dist/leaflet-src.js', CONVERSATION)).text();
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
  const file = (specifier: string, from = CONVERSATION): string => Bun.resolveSync(specifier, from);
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
