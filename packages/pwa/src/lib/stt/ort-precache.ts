/**
 * The one build-side fact this subsystem needs to state, isolated so a build
 * script can import it.
 *
 * THE PROBLEM, precisely. A PWA post-build step builds its precache list from
 * the FULL recursive closure of the bundler manifest — every record's `file`,
 * `css` and `assets`, following `imports` AND `dynamicImports`. That is correct
 * for the app shell: it is why a lazily-imported chat chunk still works
 * offline. But the ONNX Runtime `.wasm` binary the browser-local engine pulls
 * in is ~25 MB, and it would be swept into that closure by the same rule — so
 * every installed PWA, on every device, including readers who will never turn
 * on browser-local dictation, would download 25 MB at install time.
 *
 * THE FIX IS ONE LINE IN A FILE THIS SUBSYSTEM DOES NOT OWN, so it is
 * specified here as a predicate with a test rather than described in prose:
 *
 *     for (const asset of record.assets ?? []) {
 *       if (isOrtRuntimeAsset(asset)) continue;   // ← import from
 *       urls.add(`/${asset}`);                    //   ../src/lib/stt/ort-precache
 *     }
 *
 * Ferretry has no PWA post-build step yet; when one lands it must consult this
 * predicate. This module has NO imports and no bundler-specific syntax
 * precisely so a plain Bun build script can import it.
 *
 * The excluded asset is NOT lost: `local-engine.ts` fetches it on the reader's
 * explicit "prepare this device" action and stores it in the same model cache
 * as the weights, which a cache-first service worker then serves offline. The
 * asset is deferred from the install, not dropped from the app.
 */

/**
 * Filenames ONNX Runtime Web 1.24.x publishes as loadable binaries. Matched by
 * the stem so a bundler content hash (`ort-wasm-simd-threaded.jsep-a1b2c3d4.wasm`)
 * still matches.
 */
const ORT_ASSET_STEM = /(^|\/)ort-wasm-simd-threaded[.a-zA-Z0-9_-]*\.(wasm|mjs)$/u;

/**
 * True for an emitted asset that belongs to the ONNX Runtime, and therefore
 * must NOT enter the app-shell install closure.
 *
 * Accepts a bare manifest path (`assets/ort-wasm-….wasm`), a root-absolute URL
 * (`/assets/…`) or a full URL — the build script has the first, the runtime has
 * the others.
 */
export const isOrtRuntimeAsset = (url: string): boolean => {
  if (url.length === 0) return false;
  const path = url.split('?')[0]?.split('#')[0] ?? '';
  return ORT_ASSET_STEM.test(path);
};

/**
 * Human-readable size of the deferred runtime, for the settings copy and for
 * anyone reading the build patch above and wondering whether it is worth it.
 * Measured on `onnxruntime-web@1.24.1`'s published files.
 */
export const ORT_RUNTIME_BYTES = {
  /**
   * `ort-wasm-simd-threaded.jsep.wasm` — the WebGPU/JSEP-capable build, which
   * is what the package's default browser entry loads.
   */
  jsepWasm: 25_000_000,
  /** `ort-wasm-simd-threaded.wasm` — the plain WASM build. */
  plainWasm: 12_300_000,
} as const;
