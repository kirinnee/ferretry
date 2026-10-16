# Voice: how dictation turns speech into text

Dictation has **two engines**, and each device chooses one in **Settings › Voice**. Neither is a
fallback for the other, and nothing is chosen for you: until a device has chosen, the mic asks.

| Engine                      | What it costs                                                          | Where the audio goes                                                                    |
| --------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Parakeet on this device** | A one-time download of about 683 MB; about 1 GB of memory while in use | Nowhere. It is recorded and transcribed inside this browser.                            |
| **Phone/browser voice**     | Nothing to download                                                    | To the browser's vendor (Google for Chrome and Android, Apple for Safari) to transcribe |

Either way, **Ferretry never sends microphone audio to your daemon**. Optional clean-up (Groq,
Cerebras — `voice.yaml`, [secrets.md](secrets.md)) receives the transcript _text_ only.

The interface says "audio never leaves this device" **only while Parakeet is the active engine**
(`features/settings/voice-engine-choice.tsx`, `components/dictation-sheet.tsx`). Anywhere else it
would be a promise the active engine does not keep.

## Parakeet on this device

Ported from kteam's browser engine (`parakeet-browser-v3`): NVIDIA's Parakeet TDT 0.6B v3 (CC-BY-4.0,
multilingual), as the int8 ONNX export
[`ysdede/parakeet-tdt-0.6b-v3-onnx`](https://huggingface.co/ysdede/parakeet-tdt-0.6b-v3-onnx), run by
[parakeet.js](https://github.com/ysdede/parakeet.js) 1.4.4 on ONNX Runtime Web 1.24.1.

### Installing it

- **Only on an explicit press.** Settings › Voice shows **Install Parakeet (about 683 MB)**. Dictation
  never downloads: an uninstalled model is an actionable error, not a surprise download on cellular.
- **Pinned and verified.** Every file is fetched from `huggingface.co` at one commit
  (`lib/stt/parakeet-model.ts`) and hashed (SHA-256) as it arrives. A file that does not match is
  deleted and downloaded again. The worker hashes the files again when it loads them, because any script
  on this origin can write Cache Storage.
- **Progress, Cancel, Resume.** Files are stored in 32 MiB parts, each with the hash state so far
  (`lib/stt/parakeet-store.ts`). Cancel keeps every finished part; Resume continues with an HTTP `Range`
  request from the first missing byte.
- **Kept in this browser** in the Cache Storage cache `fy-stt-parakeet-v1`. **Remove** deletes it and
  unloads the model. Browsers may still clear site data when they need room (Safari after about seven
  days without a visit); the status then reads "not installed" and Install starts again.

### The network it adds

The download is the only new network traffic, and only on Install: `https://huggingface.co`, which
answers with a redirect to Hugging Face's own CDN (currently `*.hf.co`). **The page's `connect-src`
needs no change**: it already allows `https:`, because a paired daemon can live at any HTTPS origin.
Naming `huggingface.co` there alone would add nothing, and would not cover the CDN host the redirect
lands on, which Hugging Face may change.

### Running it

- **In a Web Worker** (`src/worker/parakeet-worker.ts`, logic in `lib/stt/parakeet-worker-core.ts`), so a
  multi-second decode never freezes the page. Removing the model terminates the worker, which frees its
  memory whole.
- **WebAssembly, single-threaded.** ONNX Runtime's WebGPU provider cannot run this int8 encoder (the
  fp32 one is a 2.5 GB download), and the app sends no cross-origin-isolation headers, so there is no
  `SharedArrayBuffer` for threads. Expect transcription to take a few seconds on a laptop and longer on a
  phone. The model loads when the microphone opens, so loading overlaps with speaking.
- **No live caption.** Parakeet is not a streaming model: words land when Stop transcribes the take.
- The recording is `MediaRecorder` audio decoded and resampled to 16 kHz mono by `decodeAudioData`
  (`lib/stt/audio-capture.ts`) — no AudioWorklet, so no second script for the page policy to allow.

### Self-hosted runtime, and what the page policy allows

- The ONNX Runtime WebAssembly binary (12.3 MB) is **built into the app** under `/assets/` — no CDN.
  parakeet.js would otherwise point ONNX Runtime at jsDelivr; the worker instead hands the runtime its
  verified bytes (`env.wasm.wasmBinary`), so no path is ever resolved. Its SHA-256 is pinned in
  `ORT_RUNTIME_FILE`, and a unit test re-hashes the installed package so a version bump cannot drift.
- The signed release **lists and verifies** that binary like every other file, but the service worker
  does not download it at install (`isDeferredReleaseFile`): only people who install Parakeet ever
  fetch it, verified, on the same Install press.
- `public/_headers` adds **`'wasm-unsafe-eval'`** to `script-src`. It allows WebAssembly to compile and
  nothing else — no `eval`, no `new Function`. Without it Chromium refuses to instantiate the runtime.
  `'unsafe-eval'` stays absent, and `scripts/validate/pages-config.sh` pins both facts.
- **Trusted Types**: the worker is started with a URL the `fy-worker` policy made, which accepts only the
  app's own hashed `/assets/parakeet-worker-<hash>.js` (and the dev server's address for it) besides
  the service worker (`lib/trusted-types.ts`).

### Proving it in a real browser

Unit tests use fakes and never touch the network. `packages/pwa/harness/parakeet-smoke.ts` is the
end-to-end proof: it serves the built app under its real `_headers`, installs the real model from
Hugging Face into a fresh Chrome profile, and transcribes a LibriSpeech sample. It downloads ~683 MB,
so it is **manual and never runs in CI**:

```sh
cd packages/pwa && bunx vite build && bun harness/parakeet-smoke.ts
```

## Phone/browser voice

The browser's own `SpeechRecognition` (`lib/stt/browser-recognition.ts`). Nothing to download, live
words while you speak, and on Chrome, Android and Safari the audio goes to the vendor's speech service,
so it needs a connection and the vendor's privacy policy applies. Firefox does not offer it, and an
installed iPhone/iPad Home Screen app cannot use it.

## Not built yet

- **Parakeet on your machine** (kteam's daemon engine, sherpa-onnx `parakeet-tdt-0.6b-v2-int8`):
  downloaded once to the daemon, usable by every paired device, audio crossing only the end-to-end
  channel to your own machine. It needs a native sherpa-onnx addon inside the compiled `fyd` binary (per
  platform, and inside the Nix build's pinned dependency hash), a 460 MB archive download and
  extraction on the daemon, an audio route plus its PWA dial and a `grants` capability for it. That is
  its own change, not part of this one.
- ~~A machine-wide default chosen during onboarding~~ — done: New machine setup's Voice step renders
  `VoiceEngineChoice` and saves the choice as `voice.yaml`'s `defaultEngine`; a device that has not picked an
  engine dictates with it until it picks its own. Settings › Dictation still shows the device's own choice
  (none) rather than the machine default it is using.
