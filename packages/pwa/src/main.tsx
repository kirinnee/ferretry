/**
 * The browser entry point. Ported from kteam `ui/src/main.tsx`.
 *
 * Load order, and the reason this file is as small as it is:
 *
 *     index.html → public/pre-paint.js (theme, pre-paint) → main.tsx → <App />
 *
 * MOUNTING ONLY. Everything about what the app IS — the router, the store, the
 * provider stack, the notification watch — belongs to `App.tsx`, which owns its
 * own composition. kteam stacked four providers here, and that made the entry
 * point a second, invisible place where the app's shape was decided. Here the
 * entry point knows exactly three things: where the document's mount point is,
 * that the stylesheet is part of the bundle, and where the bundler put the
 * on-device speech worker and its runtime (docs/voice.md).
 *
 * Those two are Vite-only imports, which is why they live HERE and nowhere a
 * test loads. `?worker&url` bundles `worker/parakeet-worker.ts` as a module
 * worker and returns its hashed URL as a STRING — what Trusted Types needs; a
 * `new Worker(new URL(…))` would hand the browser an object no policy made.
 * `?url` emits ONNX Runtime's WebAssembly binary under `/assets/`; only someone
 * who installs Parakeet ever downloads it.
 *
 * The CSS import is what pulls `styles/index.css` (and, through its `@import`s,
 * the theme tokens and every component stylesheet) into the build as a real
 * asset. Without it the bundle would ship logic and no design system: the
 * harness compiles the same stylesheet with the Tailwind CLI instead, which is
 * why a green harness never proved this line existed.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import runtimeUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import workerUrl from './worker/parakeet-worker.ts?worker&url';
import './styles/index.css';

const host = document.getElementById('root');
// Louder than rendering into a fabricated element: a document without `#root` is
// not this app's document, and a silent fallback would hide the fact that
// something else is serving the HTML.
if (!host) throw new Error('missing #root — the host document is not this app’s index.html');

createRoot(host).render(
  <StrictMode>
    <App speechAssets={{ workerUrl, runtimeUrl }} />
  </StrictMode>,
);
