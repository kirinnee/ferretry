/**
 * The PWA's production bundle and dev server.
 *
 * Ported from kteam `ui/vite.config.ts`, with its release machinery deliberately
 * left behind — see the four departures below. `outDir`, `assetsDir` and
 * `publicDir` are not free choices even though the Cloudflare Pages deployment
 * is not in this repo yet (a separate unit owns it): the PENDING contract is a
 * `wrangler.jsonc` naming `./packages/pwa/dist` as the published directory and
 * a `packages/pwa/public/_headers` giving `/assets/*` an immutable year.
 * Neither file exists here today — changing `outDir` or `assetsDir` now would
 * still break that deploy the moment it lands, so these are fixed against the
 * contract this package will have to honour, not against files present today.
 *
 * 1. NO RELEASE FINGERPRINT. kteam's config was a child of
 *    `scripts/build-pwa.ts`, which minted one release id and threaded it through
 *    a `define`, an index.html placeholder and the generated manifests. None of that
 *    orchestration is ported yet (service worker, precache closure, 14 themed
 *    manifests, icons), so a release id here would name a generation nothing
 *    else in the bundle belongs to. `vite build` is the whole build until the
 *    worker/manifest slice lands.
 * 2. NO DEV PROXY. kteam's dev server forwarded `/v1` and `/stt-models` to one
 *    hardcoded loopback daemon, because its UI read its daemon from the page
 *    origin. Ferretry's PWA has no default daemon at all: pairing supplies each
 *    connection at runtime and transport URLs come from that connection
 *    (`src/lib/daemon-connection.ts`, `README.md`). A proxy would reintroduce
 *    exactly the single-origin coupling the pairing seam removed.
 * 3. NO `@vitejs/plugin-react`. The only thing it adds over the built-in
 *    TS/JSX transform is Fast Refresh in dev; `tsconfig.json` already sets
 *    `jsx: react-jsx`, which the transform honours for both dev and build. A dev
 *    edit therefore reloads the page instead of preserving component state —
 *    the cost of one fewer toolchain in the tree, and reversible in one line.
 * 4. POSTCSS IS CONFIGURED HERE, not in a sibling `postcss.config.js`. The
 *    Tailwind config is a TypeScript module in this package, so importing it
 *    means the plugin and `tailwind.config.ts` cannot drift and the whole
 *    pipeline stays inside the typechecked surface.
 */

import autoprefixer from 'autoprefixer';
import { HOSTED_RELAY_DIRECTORY_ORIGIN } from '@ferretry/relay';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from 'tailwindcss';
import { defineConfig } from 'vite';
import { textScalePostcss } from './src/lib/text-scale-postcss.ts';
import tailwindConfig from './tailwind.config.ts';

/**
 * `@sherpaw/asr`'s own files the sherpa worker needs and its exports map does not name: the Emscripten
 * loader, which takes the WebAssembly binary as bytes, and the binary itself, emitted under `/assets/`
 * and fetched only by an Install (`lib/stt/sherpa-models.ts`). Both are files of the exact version
 * `package.json` pins; a version bump that renames the loader fails this build.
 */
const SHERPA_DIST = dirname(createRequire(import.meta.url).resolve('@sherpaw/asr'));
const SHERPA_ALIASES = [
  { find: /^sherpa-glue$/u, replacement: join(SHERPA_DIST, 'asr-B3QtWJoU.js') },
  { find: /^sherpa-runtime-wasm/u, replacement: join(SHERPA_DIST, 'prebuilt', 'asr.wasm') },
];

/**
 * The default relay’s discovery ORIGIN, baked in at build time.
 *
 * The relay is a separate Worker on its own hostname and Pages stays static — no
 * Functions, no proxy — so a relative path could never reach it. One shared,
 * non-user-identifying origin is therefore a build constant. It is imported from
 * `@ferretry/relay`, the same source the daemon imports, so Nix, GoReleaser, Pages,
 * local Bun builds and forks cannot disagree about which directory to ask.
 *
 * The directory remains distinct from the carrier. Its no-store advertisement can
 * withdraw the carrier without rebuilding either end.
 *
 * `FY_RELAY_DIRECTORY_ORIGIN` OVERRIDES IT, and until now it did not. Two callers
 * already passed the variable and got nothing for it — `tests/e2e/support/relay-harness.ts`,
 * whose comment claimed the bundle carried NO directory while it in fact carried the
 * production one and dialled it on load, and `harness/app-screenshot.ts`, which needs
 * an origin its interceptor can answer. The daemon has honoured the same variable all
 * along (`packages/daemon/src/adapters/system/runtime-environment.ts`: "the environment
 * wins over the build"), so the two ends disagreed about whether the escape hatch
 * existed. An empty or blank value is NOT an override — it is how a caller says "use
 * the default" — and `scripts/validate/relay-config.sh` still holds this file to
 * importing the shared default, which is the fact it pins.
 */
const overriddenDirectory = process.env.FY_RELAY_DIRECTORY_ORIGIN?.trim() ?? '';

/**
 * THE APP'S OWN RELEASE VERSION, stamped from the repository's `VERSION` — the release semantic-release
 * last cut, and the number the signed release list carries (`scripts/build-release.ts`). Settings ›
 * Machine › About shows it beside the machine's, and the "Ferretry updated" line compares it with the
 * last one this browser saw (`src/lib/app-version.ts`).
 * The file is part of every checkout, so a build without one fails rather than ships an unknown version.
 */
const appVersion = readFileSync(fileURLToPath(new URL('../../VERSION', import.meta.url)), 'utf8').trim();

/**
 * THE NEWEST RELEASE NOTES, stamped in at build time for Settings › About › "What's new"
 * (`src/lib/changelog.ts`). The repository's `Changelog.md` is part of every checkout; only the first
 * `RECENT_RELEASES` sections ship, so the bundle carries a screenful of history and not four hundred
 * releases. The app never fetches these at run time.
 */
const RECENT_RELEASES = 40;
const recentChangelog = readFileSync(fileURLToPath(new URL('../../Changelog.md', import.meta.url)), 'utf8')
  .split(/^(?=## )/mu)
  .filter(section => section.startsWith('## '))
  .slice(0, RECENT_RELEASES)
  .join('');

/**
 * LEAFLET'S ONE LOAD-TIME MARKUP WRITE, removed from the bundle.
 *
 * At module evaluation Leaflet feature-tests inline SVG with `div.innerHTML = '<svg/>'`. The page's
 * policy is `require-trusted-types-for 'script'` with no `default` policy, so that assignment THROWS in
 * Chromium and the whole `type: map` chunk would fail to evaluate. Every browser this app supports has
 * inline SVG, so the test is replaced by its answer rather than a new Trusted Types policy being named in
 * the CSP for a string that is a constant. The transform FAILS THE BUILD if it no longer matches, so a
 * Leaflet bump is a conscious re-audit (`tests/unit/build-contract.test.ts` also proves the built chunk
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
 * (`tests/unit/build-contract.test.ts`).
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

/**
 * VOSK'S JAVASCRIPT GLUE, MADE EVAL-FREE AT BUILD TIME — the worker transform behind the Vosk speech
 * worker (`src/worker/vosk-worker.ts`), beside Leaflet's for the same reason: a third-party module
 * that cannot run under the page's policy is fixed in the bundle, never by loosening the policy.
 *
 * `@lichess-org/vosk-browser` ships its Emscripten glue (`LoadVosk`, the module that compiles
 * `vosk.wasm` and binds Kaldi's classes) inside `dist/vosk.worker.js`, a complete worker of its own.
 * Two things in that file cannot run in this app:
 *
 *   1. EMBIND BUILDS FUNCTIONS FROM STRINGS. Its invoker for every bound method
 *      (`craftInvokerFunction`) and its JS-method caller (`__emval_get_method_caller`) are generated
 *      with `new Function(…)`. The page's policy has `'wasm-unsafe-eval'` and NOT `'unsafe-eval'`, and
 *      it requires Trusted Types for scripts, so each of those throws an `EvalError` and the module
 *      never finishes starting. Emscripten has an eval-free form of both (its `DYNAMIC_EXECUTION=0`
 *      build); this transform swaps in closures that do exactly what the generated code does —
 *      convert each argument to its wire type, call the C++ invoker, run the destructors, convert the
 *      result back — so the policy stays as strict as it is.
 *   2. THE FILE IS A WORKER, NOT A LIBRARY. Its tail starts ccoreilly's message protocol
 *      (`new RecognizerWorker()`), which downloads the model itself and keeps it in IndexedDB. Our
 *      worker never downloads and answers its own protocol, so only the glue is kept — the file up to
 *      `var vosk_default = LoadVosk;` — and exported as the module's default.
 *
 * Every anchor must match EXACTLY ONCE or the build fails: a new package version is a conscious
 * re-audit, never a silently half-patched runtime. The installed file is pinned by hash in
 * `tests/unit/stt/vosk-glue.test.ts` for the same reason, and
 * `tests/unit/stt/vosk-glue-runtime.test.ts` runs the result on the real binary.
 */
const GLUE_END = 'var vosk_default = LoadVosk;';

/** Embind's string-built invoker for every bound function and method… */
const INVOKER_FROM = `      let [args, invokerFnBody] = createJsInvoker(argTypes, isClassMethodFunc, returns, isAsync);
      args.push(invokerFnBody);
      var invokerFn = newFunc(Function, args)(...closureArgs);
      return createNamedFunction(humanName, invokerFn);`;

/** …and the closure that does what `createJsInvoker`'s generated body does, without `new Function`. */
const INVOKER_TO = `      var invokerFn = function(...callArgs) {
        var destructors = needsDestructorStack ? [] : null;
        var thisWired;
        var argsWired = [];
        var wired = [cppTargetFunc];
        if (isClassMethodFunc) {
          thisWired = argTypes[1]["toWireType"](destructors, this);
          wired.push(thisWired);
        }
        for (var i = 0; i < argCount - 2; ++i) {
          argsWired.push(argTypes[i + 2]["toWireType"](destructors, callArgs[i]));
          wired.push(argsWired[i]);
        }
        var rv = cppInvokerFunc(...wired);
        if (needsDestructorStack) {
          runDestructors(destructors);
        } else {
          for (var i = isClassMethodFunc ? 1 : 2; i < argTypes.length; ++i) {
            if (argTypes[i].destructorFunction !== null) argTypes[i].destructorFunction(i === 1 ? thisWired : argsWired[i - 2]);
          }
        }
        if (returns) return argTypes[0]["fromWireType"](rv);
      };
      return createNamedFunction(humanName, invokerFn);`;

/** The string-built caller C++ uses to call a JavaScript method (`ArchiveHelper`'s callbacks)… */
const CALLER_START = '      var functionBody = `return function (obj, func, destructorsRef, args) {';
const CALLER_END = '      var invokerFunction = newFunc(Function, params)(...args);';

/** …and its closure form: read each argument from the stack, call, hand the result back. */
const CALLER_TO = `      var invokerFunction = function(obj, func, destructorsRef, args) {
        var offset = 0;
        var values = kind === 0 ? [obj] : [];
        for (var i = 0; i < argCount; ++i) {
          values.push(types[i].readValueFromPointer(args + offset));
          offset += types[i].argPackAdvance;
        }
        var rv = kind === 1 ? new func(...values) : func.call(...values);
        if (!retType.isVoid) return emval_returnValue(retType, destructorsRef, rv);
      };`;

/** Anything left that would build code from a string at run time. */
const DYNAMIC_CODE = /new Function\b|newFunc\(\s*Function\b|\beval\(/u;

const fail = (what: string): never => {
  throw new Error(`fy-vosk-glue: ${what}; re-audit @lichess-org/vosk-browser's glue before upgrading it`);
};

/** The index of `anchor` in `text`, which must hold it exactly once. */
const once = (text: string, anchor: string, name: string): number => {
  const at = text.indexOf(anchor);
  if (at < 0) fail(`the ${name} is not in the glue`);
  if (text.includes(anchor, at + anchor.length)) fail(`the ${name} is in the glue more than once`);
  return at;
};

/** The glue alone, eval-free, as an ES module whose default export is `LoadVosk`. Pure. */
export function evalFreeVoskGlue(source: string): string {
  const glue = source.slice(0, once(source, GLUE_END, 'end of the Emscripten module') + GLUE_END.length);
  const invoker = once(glue, INVOKER_FROM, 'string-built invoker');
  const withInvoker = glue.slice(0, invoker) + INVOKER_TO + glue.slice(invoker + INVOKER_FROM.length);
  const callerStart = once(withInvoker, CALLER_START, 'string-built method caller');
  const callerEnd = once(withInvoker, CALLER_END, 'end of the string-built method caller') + CALLER_END.length;
  if (callerEnd < callerStart) fail('the method caller is not where it was');
  const out = withInvoker.slice(0, callerStart) + CALLER_TO + withInvoker.slice(callerEnd);
  if (DYNAMIC_CODE.test(out)) fail('code built from a string is still in the glue');
  return `${out}\nexport default LoadVosk;\n`;
}

/** The module the Vosk worker imports the glue from. */
const VOSK_GLUE_MODULE = /[\\/]@lichess-org[\\/]vosk-browser[\\/]dist[\\/]vosk\.worker\.js(?:\?|$)/u;

export const voskEvalFreeGlue = {
  name: 'fy-vosk-eval-free-glue',
  enforce: 'pre' as const,
  transform(code: string, id: string): string | undefined {
    return VOSK_GLUE_MODULE.test(id) ? evalFreeVoskGlue(code) : undefined;
  },
};

export default defineConfig({
  plugins: [
    leafletTrustedTypes,
    entityDecoderTrustedTypes,
    {
      name: 'fy-release-version',
      transformIndexHtml: {
        order: 'pre',
        handler: html => html.replaceAll('%FY_RELEASE_VERSION%', appVersion),
      },
    },
  ],
  define: {
    __FY_APP_VERSION__: JSON.stringify(appVersion),
    __FY_CHANGELOG__: JSON.stringify(recentChangelog),
    __FY_RELAY_DIRECTORY__: JSON.stringify(
      overriddenDirectory === '' ? HOSTED_RELAY_DIRECTORY_ORIGIN : overriddenDirectory,
    ),
  },
  // The static landing owns `/` and the PWA document is `/app/`, but their
  // public assets are emitted once at the site root. Keep every generated chunk
  // root-absolute: that lets the app load on daemon-qualified deep links without
  // rewriting shared icons or the manifest to a nonexistent `/app/...` copy.
  base: '/',
  build: {
    outDir: 'dist',
    // Named, not defaulted: the pending `public/_headers` (not yet in this repo)
    // is meant to give `/assets/*` an immutable year, so the directory this
    // writes into is the cache-policy boundary that contract will name.
    assetsDir: 'assets',
    // The bundle is a deployment artifact, not an accumulation of them: a stale
    // chunk left behind by an earlier build would be served as immutable.
    emptyOutDir: true,
    // The floor is set by what the app already requires of a browser, not by
    // taste: private class fields (`#storage` in `lib/theme-preferences.ts`) and
    // logical assignment (`#snapshot ??=` in the same file) are both ES2022, and
    // the same target is what kteam shipped this UI on.
    target: 'es2022',
    // Nothing consumes them: the Pages deployment publishes exactly what is in
    // `dist/`, so shipping maps would publish the readable source of a bundle
    // whose only purpose is to be minified, and shipping them without
    // publishing them makes the build slower for nobody's benefit.
    sourcemap: false,
    rollupOptions: {
      input: {
        landing: fileURLToPath(new URL('./index.html', import.meta.url)),
        app: fileURLToPath(new URL('./app/index.html', import.meta.url)),
        'get-started': fileURLToPath(new URL('./get-started/index.html', import.meta.url)),
      },
    },
  },
  /**
   * ON-DEVICE DICTATION's worker (`src/worker/parakeet-worker.ts`).
   *
   * A MODULE worker, because its bundle has a lazy chunk (parakeet.js reaches ONNX Runtime through a
   * dynamic import) and Vite's default classic-worker format cannot split one.
   *
   * `onnxruntime-web` resolves to its WASM-ONLY build. parakeet.js imports the bare package, whose
   * default entry is the WebGPU/JSEP build — a second, 25 MB runtime binary this app never runs,
   * because the pinned int8 encoder cannot run on WebGPU. The alias makes the library and the worker
   * share the one 12 MB build the worker configures.
   *
   * WHISPER (`src/worker/whisper-worker.ts`) runs on that SAME build: transformers.js imports
   * `onnxruntime-web/webgpu`, and the alias sends that subpath to `onnxruntime-web/wasm` too. The
   * WebGPU build's binary (`ort-wasm-simd-threaded.asyncify.wasm`, 27,084,114 bytes) is over Cloudflare
   * Pages' 25 MiB per-file limit, so a build that emitted it could not deploy at all (every Pages
   * deploy failed from 2026-10-23 until this alias). The root `package.json` overrides
   * transformers.js's own ONNX Runtime pin, so there is one runtime package, in one build, and
   * `scripts/ci/build-pwa.sh` fails any build that emits a file Pages would refuse.
   * Workers are bundled by a build of their own, so a transform one of them needs is named HERE:
   * {@link voskEvalFreeGlue} makes the Vosk worker's Emscripten glue eval-free.
   */
  worker: { format: 'es', plugins: () => [voskEvalFreeGlue] },
  resolve: {
    alias: [{ find: /^onnxruntime-web(?:\/webgpu)?$/u, replacement: 'onnxruntime-web/wasm' }, ...SHERPA_ALIASES],
  },
  css: {
    postcss: {
      plugins: [tailwindcss(tailwindConfig), textScalePostcss(), autoprefixer()],
    },
  },
  server: {
    // kteam's dev port, kept so the URL a developer already has in a bookmark
    // still opens this app.
    port: 5173,
    // Fail instead of silently sliding to 5174. A dev server on an unexpected
    // port is a pairing problem, not an inconvenience: a daemon's paired origin
    // includes the port, so the "wrong" server looks like an unpaired one.
    strictPort: true,
  },
});
