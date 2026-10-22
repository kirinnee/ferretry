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
 * who installs Parakeet ever downloads it. The sherpa worker and the sherpa-onnx
 * WebAssembly binary are bound the same way, for the sherpa models
 * (`lib/stt/sherpa-voice.ts`); `sherpa-runtime-wasm` is a `vite.config.ts` alias.
 * So are Vosk's worker and binary, and the Whisper worker
 * (`worker/whisper-worker.ts`) with its WebGPU-capable runtime build (the
 * asyncify binary); only someone who installs a model on a runtime downloads it.
 *
 * The CSS import is what pulls `styles/index.css` (and, through its `@import`s,
 * the theme tokens and every component stylesheet) into the build as a real
 * asset. Without it the bundle would ship logic and no design system: the
 * harness compiles the same stylesheet with the Tailwind CLI instead, which is
 * why a green harness never proved this line existed.
 *
 * ONE EXCEPTION TO "MOUNTING ONLY": the install offer. Chromium fires
 * `beforeinstallprompt` once, whenever it decides the app is installable, and a
 * page that was not listening has lost the only handle that can open the install
 * dialog. So the listener is attached HERE, before React mounts, and the store
 * that holds the event is handed to the app through context
 * (`lib/install-prompt.ts`, `hooks/use-install-prompt.ts`).
 */

import whisperRuntimeUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import voskRuntimeUrl from '@lichess-org/vosk-browser/dist/vosk.wasm?url';
import runtimeUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import { StrictMode } from 'react';
import sherpaRuntimeUrl from 'sherpa-runtime-wasm?url';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { DevicePermissionsContext } from './hooks/use-device-permissions.ts';
import { InstallPromptContext } from './hooks/use-install-prompt.ts';
import { LocationShareContext } from './hooks/use-location-share.ts';
import { windowPermissionsHost } from './lib/device-permissions.ts';
import { createBrowserInstallPrompt } from './lib/install-prompt.ts';
import { browserLocationShareHost } from './lib/location-share.ts';
import workerUrl from './worker/parakeet-worker.ts?worker&url';
import whisperWorkerUrl from './worker/whisper-worker.ts?worker&url';
import sherpaWorkerUrl from './worker/sherpa-worker.ts?worker&url';
import voskWorkerUrl from './worker/vosk-worker.ts?worker&url';
import './styles/index.css';

const host = document.getElementById('root');
// Louder than rendering into a fabricated element: a document without `#root` is
// not this app's document, and a silent fallback would hide the fact that
// something else is serving the HTML.
if (!host) throw new Error('missing #root — the host document is not this app’s index.html');

const installPrompt = createBrowserInstallPrompt(window);
const devicePermissions = windowPermissionsHost(window as unknown as Parameters<typeof windowPermissionsHost>[0]);
const locationShare = browserLocationShareHost(navigator);

createRoot(host).render(
  <StrictMode>
    <DevicePermissionsContext.Provider value={devicePermissions}>
      <InstallPromptContext.Provider value={installPrompt}>
        <LocationShareContext.Provider value={locationShare}>
          <App
            speechAssets={{
              workerUrl,
              runtimeUrl,
              sherpa: { workerUrl: sherpaWorkerUrl, runtimeUrl: sherpaRuntimeUrl },
              vosk: { workerUrl: voskWorkerUrl, runtimeUrl: voskRuntimeUrl },
              whisper: { workerUrl: whisperWorkerUrl, runtimeUrl: whisperRuntimeUrl },
            }}
          />
        </LocationShareContext.Provider>
      </InstallPromptContext.Provider>
    </DevicePermissionsContext.Provider>
  </StrictMode>,
);
