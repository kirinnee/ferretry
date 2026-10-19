// SPIKE: assemble the static bench into dist/ — the page, both workers, the sherpa-onnx wasm build,
// onnxruntime-web's wasm (Parakeet) and the four fixture clips. No model weights: the page fetches
// those from Hugging Face at pinned revisions.
//
//   SHERPA_WASM_DIR=<sherpa-onnx>/build-wasm-simd-asr/install/bin/wasm/asr \
//   CLIPS_DIR=<dir with c1..c4.wav> bun spikes/nemotron-browser/build.ts

import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = process.env.DIST_DIR ?? join(here, 'dist');
const sherpaDir = process.env.SHERPA_WASM_DIR ?? '/tmp/claude-1000/nemo/sherpa-onnx/build-wasm-simd-asr/install/bin/wasm/asr';
const clipsDir = process.env.CLIPS_DIR ?? '/tmp/claude-1000/nemo/clips';
const pwa = resolve(here, '../../packages/pwa');

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'clips'), { recursive: true });
cpSync(join(here, 'web'), dist, { recursive: true });
for (const file of ['sherpa-onnx-asr.js', 'sherpa-onnx-wasm-main-asr.js', 'sherpa-onnx-wasm-main-asr.wasm'])
  cpSync(join(sherpaDir, file), join(dist, file));
cpSync(join(pwa, 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm'), join(dist, 'ort-wasm-simd-threaded.wasm'));
for (const n of [1, 2, 3, 4]) cpSync(join(clipsDir, `c${n}.wav`), join(dist, 'clips', `c${n}.wav`));

const bundle = await Bun.build({
  entrypoints: [join(here, 'parakeet-worker.ts')],
  target: 'browser',
  format: 'esm',
  minify: true,
  plugins: [
    {
      name: 'resolve-from-pwa',
      setup(build) {
        // The worker borrows packages/pwa's own parakeet.js and onnxruntime-web, at their pinned versions.
        build.onResolve({ filter: /^(parakeet\.js|onnxruntime-web)(\/|$)/ }, args =>
          // Both specifiers get the browser wasm bundle Vite picks for the app (the 'import' default).
          args.path.startsWith('onnxruntime-web')
            ? { path: join(pwa, 'node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs') }
            : { path: Bun.resolveSync(args.path, pwa) },);
      },
    },
  ],
});
const [script] = bundle.outputs;
if (!bundle.success || script === undefined) throw new Error(bundle.logs.join('\n'));
writeFileSync(join(dist, 'parakeet-worker.js'), await script.text());

// Cloudflare Pages: let phones keep the engine binaries; the page itself stays fresh.
writeFileSync(
  join(dist, '_headers'),
  ['/*.wasm', '  Cache-Control: public, max-age=86400', '/*', '  X-Robots-Tag: noindex', ''].join('\n'),
);
console.log(`built ${dist}`);
