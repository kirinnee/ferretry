/**
 * THE BUNDLER'S TWO TRUSTED TYPES FIXES, as Vite plugins: a third-party module that cannot run under the page's policy
 * (`require-trusted-types-for 'script'`, no `default` policy) is fixed in the bundle, never by loosening the policy.
 * Conversation's `map` blocks load Leaflet and every Markdown body decodes entities, so both belong to the one bundle
 * that carries them. Copied from today's PWA `vite.config.ts`.
 */

/**
 * LEAFLET'S ONE LOAD-TIME MARKUP WRITE, removed from the bundle.
 *
 * At module evaluation Leaflet feature-tests inline SVG with `div.innerHTML = '<svg/>'`. The page's
 * policy is `require-trusted-types-for 'script'` with no `default` policy, so that assignment THROWS in
 * Chromium and the whole `type: map` chunk would fail to evaluate. Every browser this app supports has
 * inline SVG, so the test is replaced by its answer rather than a new Trusted Types policy being named in
 * the CSP for a string that is a constant. The transform FAILS THE BUILD if it no longer matches, so a
 * Leaflet bump is a conscious re-audit (`tests/unit/build-trusted-types.test.ts` also proves the built chunk
 * has no `innerHTML = '<svg` left and no policy named).
 */
export const LEAFLET_INLINE_SVG_TEST =
  /var inlineSvg = !!svg\$1 && \(function \(\) \{\s*var div = document\.createElement\('div'\);\s*div\.innerHTML = '<svg\/>';\s*return \(div\.firstChild && div\.firstChild\.namespaceURI\) === 'http:\/\/www\.w3\.org\/2000\/svg';\s*\}\)\(\);/u;

export const leafletTrustedTypes = {
  name: 'fy-leaflet-trusted-types',
  enforce: 'pre' as const,
  transform(code: string, id: string): string | undefined {
    if (!/[\\/]leaflet[\\/]dist[\\/]leaflet-src(?:\.esm)?\.js(?:\?|$)/u.test(id)) return undefined;
    if (!LEAFLET_INLINE_SVG_TEST.test(code)) {
      throw new Error(
        'fy-leaflet-trusted-types: Leaflet no longer has the inline-SVG test this plugin removes; re-audit its markup writes',
      );
    }
    return code.replace(LEAFLET_INLINE_SVG_TEST, () => 'var inlineSvg = !!svg$1;');
  },
};

/**
 * MARKDOWN'S ENTITY DECODER, WITHOUT THE MARKUP WRITE.
 *
 * Every markdown body (`react-markdown` → `micromark`) decodes a named character reference such as
 * `&amp;` or `&F142;` through `decode-named-character-reference`. Its `browser` export
 * (`index.dom.js`) does that by assigning `'&' + name + ';'` to an element's `innerHTML`, which under
 * `require-trusted-types-for 'script'` with no `default` policy THROWS — so one chat or agenda message
 * containing `&<letters>;` took its whole pane down to "reload to recover", on every open, until the
 * message scrolled away (2026-10-30). The package's default export (`index.js`) answers from the
 * `character-entities` table instead and touches no DOM, so the browser build is swapped for it here
 * rather than a policy being widened for a string built from chat text.
 *
 * Resolved through Vite's own resolver and then redirected, because the package is a transitive
 * dependency this package cannot name a path to. A resolution that is neither file FAILS THE BUILD: a
 * new version is a conscious re-audit, never a silently restored innerHTML write
 * (`tests/unit/build-trusted-types.test.ts`).
 */
export const ENTITY_DECODER = 'decode-named-character-reference';

/** The table-based file for whatever file the resolver chose, or a thrown re-audit request. */
export function entityDecoderWithoutDom(resolvedId: string): string {
  const match = /^(.*[\\/]decode-named-character-reference[\\/])index(?:\.dom)?\.js(\?.*)?$/u.exec(resolvedId);
  if (match === null) {
    throw new Error(
      `fy-entity-decoder: ${ENTITY_DECODER} resolved to ${resolvedId}, not index.js or index.dom.js; re-audit its markup writes`,
    );
  }
  return `${match[1]}index.js${match[2] ?? ''}`;
}

/** What the resolver answers: the file, and whatever else it decided about it, passed on untouched. */
interface ResolvedModule {
  readonly id: string;
  readonly [decided: string]: unknown;
}

interface ResolveContext {
  resolve(
    source: string,
    importer: string | undefined,
    options: { readonly skipSelf: true } & Record<string, unknown>,
  ): Promise<ResolvedModule | null>;
}

export const entityDecoderTrustedTypes = {
  name: 'fy-entity-decoder-trusted-types',
  enforce: 'pre' as const,
  async resolveId(
    this: ResolveContext,
    source: string,
    importer: string | undefined,
    options: Record<string, unknown> = {},
  ): Promise<ResolvedModule | null> {
    if (source !== ENTITY_DECODER) return null;
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
    if (resolved === null) return null;
    return { ...resolved, id: entityDecoderWithoutDom(resolved.id) };
  },
};
