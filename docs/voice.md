# Voice: how dictation turns speech into text

Dictation has **two engines**, and each device chooses one in **Settings › Voice**. Neither is a
fallback for the other, and nothing is chosen for you: until a device has chosen, the mic asks.

| Engine                      | What it costs                                                          | Where the audio goes                                                                    |
| --------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Parakeet on this device** | A one-time download of about 683 MB; about 1 GB of memory while in use | Nowhere. It is recorded and transcribed inside this browser.                            |
| **Phone/browser voice**     | Nothing to download                                                    | To the browser's vendor (Google for Chrome and Android, Apple for Safari) to transcribe |

Either way, **dictation never sends microphone audio to your daemon**. (Voice mode and Talk to test do, on purpose, and only
over the stream below, sealed end to end and never stored.) Optional clean-up (Groq,
Cerebras — `voice.yaml`, [secrets.md](secrets.md)) receives the transcript _text_ only.

The interface says "audio never leaves this device" **only while Parakeet is the active engine**
(`features/settings/voice-engine-choice.tsx`, `components/dictation-sheet.tsx`). Anywhere else it
would be a promise the active engine does not keep.

## The review box: by default, nothing reaches the draft without Insert

Both engines end the same way. While you record, the strip above the composer shows the sound wave
(and live words only if you switched on the experimental toggle in Settings › Voice) and stays
non-modal: you can keep typing. On **Stop** the strip becomes a compact **review box**
(`components/dictation-review-box.tsx`):

- the transcript — after clean-up, if clean-up is on — as small, editable text;
- **Insert** (primary) puts it at the composer's caret **as it is at that moment** and never replaces
  the draft; **Discard** drops it; **Record again** throws it away and starts a new take;
- if clean-up changed the words, a quiet **Cleaned | Raw** switch shows and inserts either; each side
  keeps its own edits. If clean-up failed there is no switch: the box says so and shows the raw words;
- keys, when focus is in the text: **Enter** or **⌘/Ctrl+Enter** inserts, **Esc** discards,
  **Shift+Enter** is a newline. The box never takes focus by itself — you may be typing in the composer.

A hidden panel reopens when the take lands, so a finished transcript is never stranded. The hook
(`hooks/use-dictation.ts`) holds the take as `review`; `insert(text)` is the only call that reaches
`onDraft` for a take, so by default the draft cannot change without the person pressing Insert.

### After dictating: Review first, or Insert straight away

A per-device choice in Settings › Voice (`afterDictation` in `lib/stt/stt-settings.ts`, shown with the
**This device** badge; the settings palette finds it as "review first", "insert straight away", "preview"
or "inject"). The default is **Review first**, everything above. The settings payload is version 2; a
version 1 payload still reads, with the new field defaulting to `review`, and the next save writes
version 2.

**Insert straight away** changes only what happens when the cleaned text is ready:

- the hook calls the same internal commit that **Insert** uses — same caret, selection and spacing rules,
  same transcription-log entry — exactly once, and it never sends the message;
- the panel closes and a small **Inserted · Undo** note (`components/dictation-inserted-toast.tsx`) appears
  above the composer for a few seconds; **Undo** restores the draft and caret as they were before. If the
  person has edited the draft since, the note leaves rather than overwrite their typing;
- anything that is not a clean result still parks the take in the review box with its reason: a failed
  clean-up (the raw words are shown), an empty take, a recognition or permission error. Words are never
  inserted silently from a take that went wrong;
- push-to-talk and the mic button follow the same setting.

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
- **Side by side.** An install downloads at most three files at a time in ALL (`FILE_CONCURRENCY` and `DownloadSlots` in
  `lib/stt/model-store.ts`): a model's runtime and its model files are separate bundles that download together, out of ONE
  budget (`runtime-model-store.ts` for Whisper, `runtimeAndModelInstaller` in `bundle-set.ts` for the sherpa models), so peak
  memory is at most three 32 MiB parts. Progress counts each file's own bytes once, so it only
  moves forward. One failed file stops the others (what they finished is kept) and its error is the one shown; the status check
  reads every file at once.
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
  `SharedArrayBuffer` for threads. Measured on a fast desktop: about 1.8 s for 5 s of speech; expect longer
  on a phone. The model loads when the microphone opens, so loading overlaps with speaking. Why not threads,
  what they would give, and what turning them on would cost: [Speed](#speed-which-path-each-engine-runs-on).
- The recording is `MediaRecorder` audio decoded and resampled to 16 kHz mono by `decodeAudioData`
  (`lib/stt/audio-capture.ts`) — no AudioWorklet, so no second script for the page policy to allow.

### The input meter

While the microphone is open the dictation strip draws rolling bars, one per ~50 ms of measured
loudness, so the reader can see that what they say is being captured. Silence is flat, reduced motion
swaps the scrolling bars for one level bar, and the colour is the theme's accent. It is wired for
**both** engines through one port (`lib/stt/level-monitor.ts`):

- **Parakeet** taps the stream its own recorder already holds with a read-only `AnalyserNode` that is
  never connected to a destination. There is no second `getUserMedia`, and the bars move for exactly
  the audio being transcribed.
- **Browser voice** owns its microphone and exposes no level, so there is no stream to tap. The hook
  opens a **meter-only** stream beside it (`audio: true`, nothing recorded), releases it the moment
  dictation ends, and treats any refusal as "no bars" — never as a failed dictation.

If the meter hears nothing for three seconds the strip says so ("No microphone signal yet").

### Live words (near-live, experimental, off by default)

Parakeet is not a streaming model, so live words are **near-live** (`lib/stt/near-live.ts`). They are
**experimental and OFF by default**: the default is batch transcription after Stop. The per-device
**Live words (experimental)** switch (Settings › Voice, shown while Parakeet is the engine) turns them on.

The choice is stored as `liveWordsOptIn`. An earlier build defaulted live words to on and wrote
`liveWords: true` for everyone, which proves no choice; that key is no longer read, so an existing
device starts at off and only a choice made after this shipped can turn it on.

- **While recording**, about every 1.2 s the recording so far is decoded (`AudioRecording.peek`) and
  the audio since the last committed point is transcribed again, with word times. Words two passes
  in a row agree on (LocalAgreement-2) are **committed** and never change; the rest are **interim**,
  shown greyed in the dictation strip where browser voice shows its words.
- **A window only ever starts in a pause.** Parakeet (int8, through parakeet.js) answers _nothing_,
  or stops part-way, for many windows cut at an arbitrary point in speech — measured: cutting at the
  model's own word boundaries, most windows came back empty, and moving a cut by 10 ms flips the
  answer. Windows that open in real silence, 180 ms before the voice resumes, are the reliable ones.
  So agreed words commit only up to a pause in the audio, and the window then moves past them, which
  keeps every pass short however long the dictation runs. Past 6 s uncommitted it cuts at any pause
  that leaves 2.5 s; past 16 s with no pause at all, live words stop for the take.
- **A miss is not silence.** An empty answer for a window that holds speech keeps the words on screen
  and the next pass tries again with more audio.
- **Never two inferences at once.** The next pass is scheduled only after the last one answered. A
  pass that takes most of its interval doubles the interval (up to 4.8 s); one that takes longer
  than that, or longer than the audio it covered, pauses live words for the take and the strip says
  **live words paused — device too slow**.
- **Stop** transcribes only the uncommitted tail and replaces the interim words with it; with nothing
  committed that is exactly the single pass over the whole take. A tail the model misses falls back to
  that single pass, so the final text is never less accurate than it. Clean-up (Groq, Cerebras, local
  word correction) still runs once, on the final text only.
- **Cost:** passes run only while the microphone is open; the worker idles otherwise. Off, the take is
  transcribed once on Stop, as before.

The loudness math behind "pause" (RMS, noise floor, quiet threshold) lives in `lib/stt/energy.ts`, used by
near-live (the turn endpointer that shared it was dropped, see
[Pause detection](#pause-detection-the-end-of-a-spoken-turn)).

`packages/pwa/harness/parakeet-near-live-smoke.ts` measures it in a real browser (manual, like the
smoke below): it plays LibriSpeech dev-clean clips into the shipped transcriber in real time and
reports pass times, how far live words trail the speech, Stop-to-final time and the word error rate
next to the single pass. `PARAKEET_SMOKE_SLOWDOWN=3` stands in for a phone.

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

## Which engine a device dictates with by default

Every engine is offered side by side in **Settings › Voice**, each row carrying the numbers the on-device
speech research measured for it (`lib/stt/research-numbers.ts`: headless Chrome with a 4× slower CPU,
20 LibriSpeech clips and 10 synthetic technical dictations). Until a device picks one, it dictates with
(`lib/stt/engine-defaults.ts`):

1. the machine's default from `voice.yaml`, where `parakeet` means the Parakeet that suits this device;
2. otherwise, on a **phone** (touch-first, or at most 4 GB of memory), **Parakeet TDT 110M** on the
   sherpa runtime: 2.0% WER like Parakeet 0.6B, 149 MB, 0.87 GB of memory, text 1.7 s after Stop at 4×;
3. otherwise, on a **computer**, **Parakeet TDT 0.6B v3**: the most accurate measured and multilingual.

A default never downloads anything; until it is installed, the microphone says to install it.

The streaming **Zipformer 20M** is not offered: in the research benchmark, and again through this app's
own worker on the same 30 clips, it dropped the first second of 26 of 33 utterances.

## Whisper tiny.en and base.en on this device

OpenAI's Whisper (MIT), English only, as the q8 ONNX exports
[`onnx-community/whisper-tiny.en`](https://huggingface.co/onnx-community/whisper-tiny.en) and
[`onnx-community/whisper-base.en`](https://huggingface.co/onnx-community/whisper-base.en), run by
[transformers.js](https://github.com/huggingface/transformers.js) 4.3.1 in a worker
(`src/worker/whisper-worker.ts`, logic in `lib/stt/whisper-worker-core.ts`). Words appear after Stop;
there are no live words.

- **Installing** works like Parakeet's: explicit, pinned at one commit, hashed, resumable, removable
  (`lib/stt/whisper-model.ts`). Every file transformers.js reads is pinned — the model and generation
  configs, the feature-extractor config, the tokenizer and its config, and the two graphs.
- **One shared runtime.** Both models run on ONNX Runtime Web's plain WebAssembly build
  (`ort-wasm-simd-threaded.wasm`, ~12 MB) — the same binary Parakeet runs — kept once in
  `fy-stt-transformers-js-v1` (`lib/stt/runtime-model-store.ts`). Installing the second model does not
  download it again; removing one keeps it while the other is installed. It is the same
  `onnxruntime-web` 1.24.1 Parakeet runs: the root `package.json` overrides transformers.js's own pin,
  and Vite aliases both `onnxruntime-web` and transformers.js's `onnxruntime-web/webgpu` to
  `onnxruntime-web/wasm`. Like Parakeet's copy, it is listed in the signed release but only downloaded
  on Install (`isDeferredReleaseFile`).
- **The worker never fetches.** transformers.js is handed the verified bytes as its cache, keyed by the
  pinned URL (the commit is fixed in `env.remotePathTemplate`, because some of its own lookups pass no
  revision); its `fetch` answers `404` for anything not pinned; its browser and WASM caches are off; and
  ONNX Runtime gets its binary as bytes with `wasmPaths` cleared, so it uses the glue embedded in the
  bundle and never jsDelivr.
- **WebAssembly only, no WebGPU** (more in [Speed](#speed-which-path-each-engine-runs-on)). The WebGPU-capable build's binary
  (`ort-wasm-simd-threaded.asyncify.wasm`, 27,084,114 bytes) is over Cloudflare Pages' 25 MiB per-file
  limit: while the app shipped it, every Pages deploy failed (2026-10-23 to 2026-10-24). So the worker's
  `gpu` port answers `false` and the core builds every model on WebAssembly, under the page's CSP and
  Trusted Types; Try it, and the dictation timing, still name the backend
  (`Whisper tiny.en q8 · 2575352 · WebAssembly`). The core's WebGPU-first path
  (`lib/stt/whisper-worker-core.ts`) is kept, tested against fakes, for a WebGPU runtime that fits the
  host. `scripts/ci/build-pwa.sh` fails any build that
  emits a file over 24 MiB, so a runtime that does not fit fails the PR instead of the deploy.
- **Measured** (`harness/whisper-smoke.ts`, desktop Chrome on x64, WebAssembly, one thread, a 10 s
  LibriSpeech clip): tiny.en 2.2 s (4.6 s for the first take, which loads the model), base.en 4.2 s
  (7.5 s); roughly 600 MB and 750 MB of memory while transcribing.
- **Not tested on Safari before 26.** It is the build transformers.js itself picks for Safari < 26 without
  WebGPU, so such a Safari should load it, but no run has proven it.
- **Node-only dependencies are stubbed.** transformers.js declares `onnxruntime-node` (~300 MB) and
  `sharp`, which only its Node build imports. The root `package.json` overrides both to the throwing
  stubs in `packages/pwa/vendor/`, so neither is installed.

## Vosk small English on this device: the light floor

`vosk-small-en` in the on-device catalog (`lib/stt/model-catalog.ts`): Alpha Cephei's
`vosk-model-small-en-us-0.15` (Apache-2.0) on the Vosk/Kaldi WebAssembly runtime. It is the smallest
install (about 44 MB) and the lightest on memory (about 110 MB while it listens), and it is a TRUE
streaming recognizer, so Settings shows it with **Live words** and there is no opt-in: words appear while
you speak, committed at each pause, and the text is ready about 0.1 s after Stop. It is the least
accurate engine here (9.85% WER on LibriSpeech test-clean, as published) and English only.

- **What is pinned.** One file: the OFFICIAL `vosk-model-small-en-us-0.15.zip` (41,205,931 bytes, SHA-256
  `30f26242…0942498`, byte-identical to alphacephei.com's), served from
  `tech-guy-1991-A/vosk-model-small-en-us-0.15` at one Hugging Face commit, plus the runtime binary
  (`@lichess-org/vosk-browser@0.0.3`'s `vosk.wasm`, 3 MB), self-hosted and deferred like ONNX
  Runtime's. Both live in the `fy-stt-vosk-small-en-v1` cache (`lib/stt/vosk-model.ts`).
- **No network in the worker** (`src/worker/vosk-worker.ts`). It reads the verified bytes back from the
  store, hands the runtime its binary as bytes (`wasmBinary`), writes the zip into the runtime's
  in-memory file system, unpacks it with the runtime's own unpacker, and drops both copies once Kaldi
  has read the model (`lib/stt/vosk-runtime.ts`). Nothing is kept in IndexedDB.
- **No eval.** The package's Emscripten glue builds its embind invokers with `new Function`, which the
  page's policy refuses (no `'unsafe-eval'`, Trusted Types). The build rewrites those two places into
  eval-free closures and keeps only the glue, not the package's own downloading worker
  (`voskEvalFreeGlue` in `vite.config.ts`); a package whose glue changed shape fails the build. The
  same build without the rewrite is refused by Chrome with "Evaluating a string as JavaScript violates
  the following Content Security Policy directive".
- **Streaming.** `lib/stt/vosk-session.ts` reads the recording every 0.4 s and feeds the worker only the
  audio it has not had; the worker (`lib/stt/vosk-worker-core.ts`) answers committed and interim words
  through `onLive`. A failure to load ends the dictation at once rather than at Stop.

`packages/pwa/harness/vosk-smoke.ts` is its end-to-end proof under the real `_headers` (manual, never
in CI; it downloads ~41 MB): it installs the model, streams a LibriSpeech sample in recording-sized
pieces, and fails on a policy violation, on no live words, or on any request after the install other
than the worker's own script.

```sh
cd packages/pwa && bunx vite build && bun harness/vosk-smoke.ts
```

## Google live words on this device (AudioTranscriber)

An extra dictation engine, tile **Google live words** in Settings › Voice (`google-audio-transcriber`): Google AI Edge's
[AudioTranscriber](https://developers.google.com/edge/mediapipe/solutions/audio/audio_transcriber) running **NVIDIA Parakeet
TDT 0.6B v3** as one `.litertlm` file, on MediaPipe's WebAssembly runtime, in a worker. Words appear **while you speak**
(settled phrases first, the phrase being heard greyed, corrected as you go), with punctuation and capitals from the model, in 25
European languages. Audio stays on the device; nothing but the model download uses the network.

- **Where it comes from (official upstream only, each pinned and hashed like every other model here;
  `lib/stt/google-transcriber-model.ts`).**
  - The model: `litert-community/parakeet-tdt-0.6b-v3` on Hugging Face (Google's `litert-community` organisation), file
    `parakeet_tdt_0.6b_v3_5s_i8_stateful.litertlm`, at commit `cd95f7bb97fd`: **614,588,752 bytes**, SHA-256
    `66c5a74c…eeb3504` (Hugging Face's own `x-linked-size` / `x-linked-etag`, re-computed from the bytes).
  - The runtime: `@mediapipe/tasks-audio` **1.2.3** on npm (Google, Apache-2.0), its `audio_wasm_module_internal.wasm`: **21,979,681
    bytes**, SHA-256 `49effd46…c850a`. Self-hosted: the build emits it under `/assets/`, the signed release lists it and **defers**
    it (`isDeferredReleaseFile`), and only this engine's Install downloads it. Its JavaScript loader is part of the app's build.
  - A unit test re-hashes the installed package, so a version bump that forgets the pin fails.
- **Licence.** The model is **CC-BY-4.0** (the Hugging Face model page's `license: cc-by-4.0`; base `nvidia/parakeet-tdt-0.6b-v3`): credit
  to NVIDIA for the model and to Google AI Edge for the conversion, said on the tile (behind the "i"). The runtime is Apache-2.0.
- **Install, hashing and Remove** are the shared on-device ones (`bundle-set.ts`): the runtime and the model download side by
  side, 636.6 MB in all; every byte is hashed as it arrives and again on every read; a flipped bit is refused (`integrity`) and
  nothing of it stays; Remove deletes both caches (the runtime stays only while another MediaPipe model needs it — none does).
- **The worker never fetches.** `app/worker/google-worker.ts` hands Emscripten the verified runtime bytes through its own
  `Module.instantiateWasm` hook (MediaPipe's loader keeps a `Module` set before the task is created) — a `blob:` URL would be
  refused by `connect-src` — and hands the task the verified model bytes. It runs the **CPU delegate** the model page
  recommends; the GPU delegate is not offered until it has been measured. The page's policy needed one change: the worker
  script name (`google-worker-<hash>.js`) joins the speech workers Trusted Types accepts.
- **How words arrive** (`lib/stt/google-worker-core.ts`): the transcriber works in 5 s windows that advance 2.5 s. Each advance
  answers the oldest 2.5 s as a **final** segment (never changes) and the 5 s ahead as an **interim** one (replaced by the next
  answer). The page side is the sherpa engine's protocol and streaming session, unchanged.

### Measured, and what that says (2026-11-24)

`tests/realworld/google-transcriber.realworld.test.ts` (real Chrome, the **built** app's real `_headers` policy, a fake microphone
playing `clip-5s.wav`, the shipped voice's own Install and dictation session). 32-core Linux x64, load average ~8.

| What                                                    | Full speed            | Browser held to a quarter of one core |
| ------------------------------------------------------- | --------------------- | ------------------------------------- |
| Install (636.6 MB, hashed)                              | 8 s                   | 36–39 s                               |
| First take: Stop → text, **includes loading the model** | 9 s                   | 41–43 s                               |
| Warm take, 5 s clip: Stop → text                        | **1.2 s**             | **8.2 s**                             |
| First live words                                        | 3.9 s into the take   | none within the 5 s take              |
| Clip transcribed                                        | word for word, 0% WER | word for word, 0% WER                 |
| Memory, whole browser, model loaded                     | 3.0 GB                | 3.0 GB                                |

- **The load is slow because the bytes are hashed again on every read** (the doctrine: nothing stored is trusted): about 7 s
  of the 9 s (the model alone builds in 1.9 s when handed its bytes, in a plain page). The worker lives until the engine is unloaded, so only the first take of a session pays.
- **It is a laptop engine.** At a quarter of one core, the nearest this box has to the research's 4× CPU slowdown (Chrome's
  `Emulation.setCPUThrottlingRate` is refused for workers — "only supported for pages" — and this engine runs in one), it needed 8.2 s
  after Stop (Parakeet 0.6B on ONNX Runtime: 7.1 s at 4×, a different and gentler throttle) and drew no live words in 5 s. The tile
  says so: Speed 8.2 s, Size 637 MB, "A laptop."
- **Accuracy is not scored on the 33 key terms**: that technical set is not in this repository, so the tile draws no Accuracy bar.
  What is known: the bench clip came out right, word for word, like Parakeet 0.6B on ONNX Runtime; the weights are the same; Google
  reports 5.07–5.15% average WER over a 5-set English streaming test (280 utterances), within 0.17 points of the unquantised model.
- **A phone is not measured.** The one-click page (`tests/realworld/dev/speed-bench/`, `bunx vite` in `packages/app`) lists this engine
  too, for a phone on `adb reverse`; no phone was available for this change. The model needs a 615 MB download and ~3 GB of
  browser memory, so some phones will refuse it — the tile shows its size and measured speed before anything downloads.

Run it yourself (manual, never in CI): build the app, then
`FY_VOICE_APP_DIST=<dist> FY_VOICE_GOOGLE_MODEL=<the .litertlm> CHROME_PATH=<chrome> bun test tests/realworld/google-transcriber.realworld.test.ts`
in `packages/plugins/voice`; prefix it with `FY_VOICE_LIMITED=1 systemd-run --user --scope -p CPUQuota=25%` for the quarter-core column.

## Phone/browser voice

The browser's own `SpeechRecognition` (`lib/stt/browser-recognition.ts`). Nothing to download, live
words while you speak, and on Chrome, Android and Safari the audio goes to the vendor's speech service,
so it needs a connection and the vendor's privacy policy applies. Firefox does not offer it, and an
installed iPhone/iPad Home Screen app cannot use it. **First-run onboarding never records with it**: the
"Test your audio" step (`features/onboarding/voice-test.tsx`) only records with a verified on-device engine, so
choosing Browser voice there sends no audio anywhere and Record says to pick an on-device voice.

## Voice mode: the machine's speech engine

**Built (voice mode units 3 to 7):** the machine can install, load and run the speech models voice mode needs, a
device can stream its microphone to them (below), a chat has a **Voice mode** panel ([below](#the-voice-mode-panel)) that
speaks replies in the machine's reply voice and can be talked over ([Barge-in](#barge-in-talking-over-a-reply)), and Settings ›
Voice › **Voice mode** installs, shows the state, removes, and offers **Talk to test**.

- **What runs where.** Owner decision O2: the sherpa-onnx **WebAssembly** runtime first (the same `@sherpaw/asr` the
  app ships), in one **worker thread** of the daemon (`daemon/worker/speech.worker.ts`), never in the daemon's own
  event loop. Parakeet TDT 0.6B v3 (int8, multilingual) decodes. **Silero VAD v5** finds the voice, run by
  onnxruntime-web in the same thread, because sherpa's WebAssembly build has no voice-detector entry point. Where this machine can run it,
  the **native** sherpa-onnx library (fetched at Install, pinned by size and SHA-256 and hashed again before every load) runs
  instead; see the next bullet and the declared gaps in `docs/design/voice-modes.md` §2.3.1.
- **The native engine runs in a child process of the daemon, one per loaded engine** (`daemon/worker/speech-host.ts`), so a native
  crash (a fault in sherpa-onnx or onnxruntime) ends that engine and not `fyd`: it reports itself stopped in Settings, the turn
  fails cleanly, the next use starts a new child, and three stops in a row fall back to WebAssembly. The child is sealed with an
  environment of `{}`, speaks in bounded frames with a deadline on every call, and is ended on unload, idle and daemon stop;
  `fyd --check` loads the library in a throwaway child as well. The files are verified immediately before each spawn, but a
  program of the same user could still swap one between that check and the load (such a program can already read the vault,
  `docs/secrets.md`). The design and the declared gaps are `docs/design/voice-modes.md` §2.3.1.
- **Install** (`POST /v1/voice/engine/install`, answers 202; Settings › Voice › Voice mode) downloads seven pinned
  files, **698,905,830 bytes** in all, into `state/voice/models/parakeet-tdt-0.6b-v3/`: Parakeet's three graphs and
  vocabulary and Silero (Hugging Face, by commit), and the two WebAssembly runtimes (jsDelivr, by version). Each file
  is checked against its pinned size and **SHA-256** before it is written, so one that differs by a bit is refused
  (`hash_mismatch`) and nothing of it is kept. A file already on disk at its pinned size is not downloaded again.
  There is no partial-download resume yet: a failure restarts the file it stopped in. Install ends by loading the
  models and decoding a second of silence, so **Ready means it ran**, not only that it is saved; the models are then
  unloaded again, so an install does not leave about 1.8 GB resident. `fy` and the app read
  the state from `GET /v1/voice/engine`; `DELETE /v1/voice/engine` unloads and deletes. Before it downloads anything Install asks the disk under `state/voice/models/`, and refuses with
  `no_disk` (and a sentence that says how much is needed and how much is free) unless the files still MISSING plus
  1 GB are free; a write that fails leaves no temporary file behind. Grants (owner decision O3): the routes belong to
  their own `voice` capability — a read is `voice.use`, install and remove are a person's `voice.configure` — so
  narrowing `fleet` does not govern them.
- **Memory.** The models load on the first call and the thread ends **10 idle minutes** after the last one, which
  returns its memory. A load is refused (`no_memory`) when the machine's available memory is under the files plus
  1.5 GB.
  The WebAssembly worker is a thread **inside the daemon process**: a process-level out-of-memory kill takes the daemon
  down with it (the native engine is a child, so one takes only that child), and the free-memory check reads the machine's free memory (`os.freemem()`), which ignores a cgroup
  `MemoryMax` the daemon may be running under.
- **The port.** Other plugins use `VoiceApi.engine`: `transcribe(samples)` (16 kHz mono, one whole take; returns the
  text and the real-time factor) and `detectSpeech(samples)` (spans in samples). No route takes audio.

### The voice stream (`GET /v1/voice/stream`)

A `voice.use` socket, **person-only** (`caller: 'person'`: a ferret's or the warden's credential is not a grant caller, so
the capability alone would not have stopped it). It is a §14 stream session (`docs/relay-protocol.md`), so direct, WebRTC
and relay carry it with no new code, and the kernel re-checks the device's grants on every frame: **narrowing `voice`
closes an open stream at once** (4401). `contract/stream.ts` is the wire; `daemon/lib/stream/` is the machine's end.

- **Open.** Before the protocol switches the machine answers with a status: `409 voice_not_ready` (speech not installed),
  `429 voice_busy` (one stream per device, two per machine). The first record is a text frame
  `{t:'start', v:1, purpose:'test'|'chat', ferretId?, session?, style?, reply?:'machine'}` (`session` is optional, and only a `chat` may carry it); anything else first is a protocol error
  (4400), and the machine **sends nothing until it has the start record** (what it asks for decides the size of every unit
  after it). A frame after the start is a `speak` line (below), and only on a stream that asked for `reply: 'machine'`. `test` shows live words and sends nothing. `chat` sends each finished turn to `ferretId` (an id or a
  callsign, resolved as a typed send resolves it), and a second stream for the same ferret, however it is named, is refused
  `voice_busy` in its first unit. **A chat needs `fleet.use` as well as `voice.use`**: without it the start is refused in
  a plain sentence (`fleet_not_granted`, close 4403), the grant is asked again before every message, and each message
  sent leaves the same `agent.prompted` audit record a typed send does.
- **Up: a constant 1,344-byte unit every 40 ms** — 640 samples of 16 kHz PCM16, then a 64-byte control slot (`none`,
  `muted`, `unmuted`, `end`, and the newest nonce echoed). Silence and muted time are zero samples, so a relay never sees
  when anyone speaks. More than 1.25× the nominal rate over 5 s is closed (1008).
- **Down: a constant 1,024-byte unit every 200 ms** — a length and JSON, zero-padded: the machine's state (`loading`,
  `listening`, `hearing`, `working`, `muted`), a fresh nonce, the words of the turn in fragments that arrive over
  consecutive ticks (the browser rebuilds them by `(turn, rev)`; over 16 KB is refused), and how the last turn ended
  (`sent`, `heard`, `dropped`, `cancelled`, `failed`). A refusal is one unit with a fixed sentence, then the close. A
  stream that asked for the reply voice has a **larger constant unit, 7,424 bytes**: the same 1,024-byte slot, then 200 ms
  of 16 kHz PCM16 (see [The reply voice](#the-reply-voice-kokoro-on-the-machine)).
- **The pause and the send (owner decision O1: no countdown).** Silero VAD finds the voice; a silence of 1.5 s (styles
  `quick` 1.0 s, `thinker` 2.5 s — **guesses**, tuned from unit 5's numbers) ends the turn, or 120 s whatever the voice
  is doing. The final decode starts **0.3 s after the last word**, not at the pause: a turn of at most 5 s is decoded in the pause, and
  the pause uses that result when no voice came back (voice that did outdates it, and the whole turn is decoded again).
  Measured on the real engine, `clip-5s`, last word → sent: **3.28 s before, 2.4–2.6 s after** (0.5 s trigger: 2.88 s). The
  floor is the decode itself (about 1.7 s for 5 s), which the offline engine cannot hide the way the browser's
  `beginFinish()` hides a streaming one. **On a busy machine** (the real engine and the stream pinned to 2 CPUs shared with 4
  busy loops, `clip-5s`, 12 runs each): **0 of 12 turns sent before, 12 of 12 after** (before, every run lost the turn as
  `engine_behind`: an interim decode over 2 s counted as unseen audio); last word → sent was about 3.3 s there. A longer turn is decoded at the pause as before. The message is sent **as soon as it is ready**, as the person's own
  message through Conversation's send, prefixed `(voice) `, with the stable id `<streamId>:<turn>`. A turn is handed over
  once; a refused or failed send is reported, never repeated by the stream.
- **Entering voice mode tells the ferret, once per chat.** A `chat` start MAY carry `session`, a name the page mints when voice
  mode is turned on and keeps across reconnects (8–64 URL-safe characters); **without it the stream is exactly what it was** (no
  entry message), so a client that predates the field still streams. The ferret is told by **one message per chat, whoever is in
  voice mode there**: the machine holds a **claim per chat** (in memory, in the stream registry) that a stream and a phone's own
  engine both enter. The one that finds no live claim sends the message as the owner, `(voice mode on) Speak first, narrate as
you work, speak the result.`, with the stable id `voice-on:<session>`; every other tab, device or engine that enters while
  the claim is live (a second tab whose stream got `voice_busy` and fell back to the phone, a phone started while another
  device is on the machine) sends nothing. The claim is renewed by anyone still in voice mode (the stream every
  `ENTRY_RENEW_MS`, 60 s; a phone on its own speech by asking again) and lapses `ENTRY_LEASE_MS` (3 min) after the last
  renewal, so a stream that drops and reopens inside it is not a repeat, and a later voice mode tells the ferret afresh. A refused
  entry gives the claim up (the next to enter sends it), does not end the stream, and is not audited (a fixed sentence with none
  of the person's words). A phone on its own speech has no stream, so it asks the machine: `POST /v1/voice/entry`
  `{ferretId, session}` → `{sent}` (`fleet.use`; `sent` is false when the claim was already live). The static instruction
  (`instructions/voice.md`) teaches the grammar on every turn; this message switches it on for the conversation.
- **A dead phone never sends.** The send waits for an echo of a nonce the machine issued **after** it heard the pause. A
  device that died, lost its network or entered a tunnel cannot echo it; the turn is cancelled
  (`phone_silent`) and nothing is sent. Units that arrive for a moment after a phone dies carry the OLD nonce, which proves
  nothing. A stream with no unit for 5 s is closed (4408).
- **Words while you speak.** The engine has no streaming decode, so a turn of at most 5 s is re-decoded about every 1.2 s
  (5 s of speech decodes in about 1.9 s, above); a longer turn keeps its last words until the final decode. Past that the
  final decode has 5 s plus half the audio's length. **Interim words and the early decode are best-effort**: while one
  runs the VAD cannot look, so the audio that arrived meanwhile is scanned in full afterwards (no voice is skipped, the
  pause is still heard) and is not counted as unseen; the engine is then left alone for as long as that decode took (a
  busy engine skips interim words, it never queues them); one that runs over its budget is dropped, not a lost turn.
- **Fails out loud.** More than 2 s of audio the VAD itself has not had (`engine_behind`) or a FINAL decode over its
  budget (`engine_timeout`) loses that turn, with a sentence; three lost turns in a row end the stream (`engine_overloaded`, 4450). Not enough memory to
  load speech ends it at once (`voice_no_memory`). Audio is never silently skipped inside a turn. Only the engine's
  public API is used: the load generation and the idle unload are the engine's own, and a load superseded by an unload is
  asked again once.
- **Never stored.** Audio lives in the stream's memory for the turn and is dropped when the turn ends.
- **Declared gaps.** The browser cannot yet see the socket's back-pressure (`PluginSocket` has no credit signal), so it
  does not stop at "2 s of audio it has no credit to send". The Opus uplink (design B6) is not built: about 190 MB an hour
  over the wire. The nonce proof is stricter than the design's text (an echo issued after the pause, not any echo within
  1 s), so a phone dying within the last second can no longer send.

**Measured here (2026-11-24; 32-core Linux x64, load average about 8, run under `nice`; one WebAssembly thread):**

| What                                                    | Measured                                             |
| ------------------------------------------------------- | ---------------------------------------------------- |
| Install, real download from Hugging Face + jsDelivr     | 699 MB in under 10 s (daemon, whole install)         |
| Load the models in the worker                           | 1.8 s (1.77–1.94 over five loads)                    |
| Decode `clip-5s.wav` (5.0 s), Parakeet v3               | 1.86–2.10 s: **real-time factor 0.37–0.42**          |
| Decode a real 5.8 s recording (`en.wav`)                | 2.08–2.12 s: real-time factor 0.36–0.37              |
| Silero VAD over `clip-5s.wav`                           | 0.44 ms per 32 ms chunk: real-time factor 0.014      |
| Daemon resident memory, idle → models loaded → unloaded | 272 MB → **1.83 GB** → 281 MB                        |
| The sherpa module's own heap once loaded                | 819 MB (the in-memory copies of the files are freed) |

The real-time factor matches the browser's single-thread number for the same model (`docs/voice.md` › Speed: 1.76 s
for 5 s), so the machine is **not faster per decode**; its gain is that a pass never competes with a page. Native
sherpa-onnx with several threads is the next step **only if** the first-audio target later needs it (plan risk 1).

Proof: `packages/plugins/voice/tests/realworld/speech-engine.realworld.test.ts` runs the engine's own entry (install →
load → decode) against the real files, first with one flipped bit (refused) and then the pinned bytes
(`FY_VOICE_ENGINE_FILES` names a folder holding the files by role; without it the test skips).

### The voice mode panel

Hands-free chat with the ferret whose page you are on. **Voice mode** is a button in the composer's tools
(`composer.tools`, beside dictation); the panel stands where the composer was, through Conversation's
**`conversation.composer`** slot (a replace slot, like `conversation.row-body`; the chat offers it only on a ferret's own page, never
under an agenda item's reply box). Voice's own code is `app/components/voice-mode-panel.tsx`, `voice-mode-button.tsx` and
`app/lib/voice-mode/voice-mode-store.ts`.

- **Pressing it** first reads `GET /v1/voice/engine`. Speech not installed or still installing leaves the composer where it
  is and says why in one sentence above it (with where to install: Settings › Voice › Voice mode). It never installs by
  itself: that download is the person's press, with its size shown. A machine that cannot be reached starts voice mode on the
  phone's own engine instead ([Phone fallback](#phone-fallback-the-phones-own-engine)).
- **The composer is hidden, never dropped.** The panel renders the chat's composer in the same place with `display: none`,
  so the draft, caret and attachments are the very ones that come back on **End**. Nothing is sent from the draft.
- **One `chat` stream** (`purpose: 'chat'`, this ferret) opens as soon as voice mode is on, and every stream rule above holds:
  the **machine** sends each utterance once, right after the pause (owner decision O1), as the person's own `(voice) `
  message; a device that stops answering sends nothing; muted time is zero samples; the chat needs `voice.use` AND
  `fleet.use`. The panel only shows what the machine reports: **Loading speech on <machine>…**, **Listening**, **Hearing
  you…** with the live words (greyed while they may still change, firm when final), **Muted**, and **Working…** while the
  ferret's turn runs. The ferret's turn is the chat's own live reading, handed to the slot, so an unread or cached turn is
  never claimed as working.
- **Replies are spoken, by the machine's voice when it has one.** Voice mode turns **Auto-read** on for that ferret whatever the
  device's switch says (the switch itself is untouched); a `<voice>` reply is what it reads (unit 1). While the panel is on, the
  page's read-aloud controller speaks through the machine's reply voice over the same stream (`createMachineSpeaker`,
  attached with `ReadAloudController.attach`), and the stream is opened with `reply: 'machine'`. A machine with no reply voice
  (`absent`), or one that fails on the first line before any sound, hands the same words to **the device's own voice** instead;
  a line that fails after it was heard is never read again by another voice. A reply voice that is still **loading** takes the
  line and speaks when it is ready (a Kokoro load is seconds; switching voices mid-conversation would be worse). The sound
  output is made inside the tap on the Voice mode button and handed to the panel (iOS lets sound start only from a tap).
  **The microphone stays open under the machine's voice** (echo cancellation is on in the capture) **and is muted under the
  device's voice**: a speech-synthesis voice is not part of the page's audio graph, so nothing proves the browser removes it
  from the microphone, and the machine would send the reply back as the person's own words. The panel says which is on.
- **It ends, and says why.** **End voice mode** tells the machine, closes the stream, stops the microphone and gives the
  composer back. A refused permission (the machine's own sentence, or one for its close code: 4401 voice, 4403 fleet), a
  refused microphone, or a browser that cannot open a stream also give the composer back and leave one sentence above it until
  dismissed. A machine that fails for any other reason does not end it: the loop moves to the phone. Leaving the
  chat, or a question taking the composer's place, ends it; it never restarts by itself on return.
- **Measured here (2026-11-24, real Chrome, real engine).** Chrome's fake microphone plays `clip-5s.wav` ("Please fix the
  login redirect and run the tests again", with 1 s of silence before it) into the shipped `browserMic`; the panel's stream
  runs over a WebSocket to the daemon's real `VoiceStream` and the real Parakeet + Silero (`tests/realworld/voice-mode.realworld.test.ts`,
  `FY_VOICE_MODE_REAL=1`). The panel showed interim words while the clip played and firm words at the end; the machine sent
  **one** message, `(voice) Please fix the login redirect, and run the tests again.`, id `<stream>:1`, and nothing more over
  3 s of trailing silence and End. **From the last word to the send: 3.1–3.2 s** in four runs (the 1.5 s pause, then the
  final decode, then the nonce echo). The ferret was a recorder, not a live one: a real ferret needs a harness login and spends a
  turn, and the send is the same function the daemon hands the stream.
  **A finding about the stream, not the panel:** on a busy box (load average 7–10) **6 of 12 runs lost the turn** with
  `engine_behind` and the sentence "This machine is too busy to keep up": an interim decode that takes over 2 s trips the
  stream's "more than 2 s of unseen audio" rule, so the panel says "The machine could not turn that into words. Try again." and
  sends nothing (it never sends a lost turn). The panel is honest about it; whether the rule should wait for the decode is the
  stream's to decide (unit 4's latency follow-up).
- **Declared gaps.** A keyboard shortcut and a palette entry for it are not built.

### Phone fallback: the phone's own engine

**Built (voice mode unit 8).** Voice mode runs on the machine; the phone's own engine is only ever the fallback (owner
decision 2026-11-23). The same panel, the same two buttons and the same hidden composer carry on, with a banner at the top
of the panel (`data-voice-mode-banner`, `data-engine="phone"`) that says why for as long as it is there. There are three ways in, and
nothing else starts it:

1. **The machine cannot be reached when Voice mode is pressed** (`GET /v1/voice/engine` fails): "Your machine cannot be
   reached, so voice mode runs on this phone's own speech."
2. **The machine's stream ends for any reason but a refused permission or a person's End** (the route dies mid-chat, a close
   with no code, `4408` it stopped hearing the phone, `4429` busy, `4450` too slow, `1011` speech failed, a protocol
   error). The loop moves to the phone and the banner says why, in the machine's own sentence when it gave one. A refused
   permission (`4401`, `4403`) is **not** routed round: the owner said this device may not, and the phone would be doing it
   anyway.
3. **The person chose "Keep audio on this phone"** (Settings › Voice › Voice mode; `voiceModeOnPhone` in this browser's
   live-voice settings, off by default). The machine is then not asked at all, and the banner says that is why.

What the phone's engine is: the dictation engine the person already chose (Settings › Voice: Parakeet on this device, the
browser's voice, the others), driven by `useDictation` as a person would drive it, into an empty draft that is never shown
(`afterDictation: 'insert'`; the transcription log and debug ring are not written: voice mode is not a dictation the person
asked to keep). The phone watches its own microphone level for the pause (`lib/voice-mode/phone-loop.ts`: speech heard, then
**1.5 s** of quiet, the machine's own pause, so the rhythm is the same), or, for an engine that lends no microphone tap (the
browser's voice), the words standing still for as long. Then it stops the take and **sends it itself**, through the ordinary
`POST /v1/ferrets/:ferretId/send`, as `(voice) <words>` with a send id of its own (`phone-<uuid>:<n>`) in both the body and
`x-fy-request-id`: a send that fails is tried once more with the **same** id, so a lost answer never sends twice, and one that
still fails says "Not sent: <the route's sentence>" and keeps listening. Sends go out one at a time, in the order spoken. The
send needs `fleet.use`, as a typed send does. Replies are read by the device's voice (Voice mode turns Auto-read on), and the
microphone is off while one is read (the take is stopped, then restarted a moment after: no reply can be heard and sent back as
the person's words). Mute stops the take too.

If the engine cannot listen at all (no dictation engine chosen yet, the microphone refused, the engine unavailable), voice mode
**ends** with the engine's own sentence and the composer comes back: nothing else would ever send.

**Declared gaps.** The fallback is one way: the phone does not go back to the machine by itself (End, then Voice mode again, asks
the machine first). A machine that is wholly unreachable cannot take the phone's sends either: the panel says "Not sent" for each.
The phone engine has no live words unless the chosen engine gives them (the browser's voice does; Parakeet does with
"Live words"). Real-device proof (a phone's own Parakeet in a real chat) is the owner's: the harness below scripts the engine.

**Measured here (2026-11-24, real Chrome).** `tests/integration/app/voice-mode-panel.visual.test.ts`: the machine's stream is
dropped 600 ms into a chat (`1006`); the panel moves to the phone engine (banner "Lost Studio Mac, so voice mode carries on
with this phone's own speech."), the machine's microphone is released, a scripted engine hears one sentence, the pause is found
from the microphone level and `(voice) Please check the build` is sent once. A machine unreachable on press starts on the phone
with no stream opened. At 390 and 1440 px, light and dark: no sideways scroll, 44 px controls.

### Barge-in: talking over a reply

While the **machine's** voice speaks, the microphone stays open and the page listens for the person: **300 ms of speech**
(`BARGE_IN_MS`) stops the sound at once, hushes the machine, and the panel says **Stopped. Go ahead, I am listening.** The
machine hears the same speech and sends it after the pause as usual, so the person just carries on.

- **The detector** (`app/lib/voice-mode/barge-in.ts`) is pure: it is fed the microphone's 40 ms units exactly as they are sent
  (zeros while muted, so a muted person never interrupts and nothing of the room is heard here). A unit is **speech** when its
  RMS is at least **0.02** and at least **3× the room's level** (the quietest tenth of the last 3 s, which includes whatever
  echo is left under the reply). A quiet stretch of under **120 ms** inside speech does not restart the count. It fires once,
  at the unit that completes 300 ms (the eighth, 320 ms of audio), then starts over; it only fires while a reply is playing.
- **The hush.** `VoiceStreamHandle.hush()` stops the player, sends a **`hush` text frame** (the same fixed 1,024 bytes as a
  `speak` frame, `encodeHushFrame`; `decodeLineFrame` reads either) and ignores the sound of every line sent before it that
  is still on the wire. The machine drops every line not yet spoken and every sound not yet sent, and throws away the line it
  is making when it finishes (it cannot be interrupted mid-sentence). Nothing is reported back. A stream that did not ask for
  the reply voice that sends one is a protocol error, like a `speak`.
- **The drop.** `VoiceStreamHandle.drop(ids)` sends a **`drop` text frame** per line (`{t:'drop', id}`, the same fixed size) for a
  line that was sent and nobody has heard: the machine takes it out of its queue, does not send any sound made for it and throws
  it away if it is being made. A line whose first sound has gone down is left to finish (the person has heard its start), and the
  browser ignores sound of a dropped line that still arrives.
- **Speaking while the ferret works (V4).** A `<voice>` line the ferret finishes mid-turn is handed to the machine's voice at
  once, behind the piece that is playing, and never waits for the turn to end (`useLiveVoiceLines` reads the closed lines of
  the rows; `createLiveLines` is the machine voice). Progress lines can arrive faster than they are spoken, so a waiting line is dropped only when it is **known to be progress**: the ferret used a
  tool after it (a turn's result is never followed by one; the turn's state is no evidence, because the last line of a result is
  read before the turn says it ended), nobody has heard any of it, and a newer line is waiting behind it. **When unsure, a line is
  kept**: the first line of the turn, any line the ferret has not worked past (so every part of a result, even a result of several
  lines, and a result that finishes just before the next turn begins) and a line already being heard are never dropped. History, a
  cached copy of the rows and a hidden tab are never said. **The reading at the end of the turn says exactly what was not played**:
  each line is followed through playback (its sound has finished AND the player has none left), a line that failed to be made,
  that the person talked over or whose stream went away is read, a line dropped on purpose is never read, and a line still being
  said is not said twice. A machine without its reply voice takes no live line, so that reading says the reply on the device's voice
  as before. Declared gap: a line that fails to play only AFTER the reading of the turn's end was decided is not read.
- **Measured here (2026-11-24).** On the recorded clip (`clip-5s.wav`) over a faint room hiss, the detector fires at the
  ninth unit, **360 ms into the clip** (its first words are at the third unit: about 300 ms of speech). In the panel harness
  (real panel, stream client, speaker, controller and detector; fake machine, microphone and sound) seven loud units change
  nothing and the **eighth stops the sound in that very unit**, with the hush frame sent and the speech reaching the machine
  untouched. The same speech at a tenth of the volume (a faint echo) does not fire.
- **Declared gaps.** Echo is the risk: with the reply on speakers, whether the browser's echo cancellation leaves the
  reply under the bar can only be proved on the owner's laptop and phone (a headless browser has no echo); the two numbers to
  tune are 0.02 and 3×. The detector is energy, not words: a loud noise held for 300 ms stops a reply. The device's own voice
  is not talked over (see above).

### The reply voice (Kokoro, on the machine)

Voice mode's reply voice is **Kokoro-82M (int8, Apache 2.0)**, run by sherpa-onnx's own WebAssembly build for Node and Bun
(`sherpa-onnx` 2.0.3, owner decision O2) in a **worker thread of its own** (`daemon/worker/reply.worker.ts`), so the
speech engine keeps listening while a reply is being made. It is installed **apart from speech to text**
(`GET|POST|DELETE /v1/voice/reply-voice`, the same two grants and the same install/measure/unload rules as the engine's
routes): five pinned, hash-checked files, **164 MB** (`daemon/lib/reply/catalog.ts`), in `state/voice/models/kokoro-82m-int8/`.
Without it voice mode still listens, and the device's own voice reads the reply, with a sentence that says so.

- **Who speaks what.** The browser already knows which lines of a reply are `<voice>` lines (the grammar is Conversation's
  `voice-tag.ts`). It asks the machine to speak each one by sending a **`speak` text frame**: JSON
  `{t:'speak', id, text}` padded with spaces to exactly **1,024 bytes**, so a relay sees one size for every line
  (`encodeSpeakFrame`; a longer line is cut at a space into several frames, `fitSpeakText`). The machine answers in the
  stream it already has: nothing new is opened, nothing is stored, and the text is sealed end to end like the audio.
- **Down: a constant 7,424-byte unit every 200 ms** for a stream that asked: the snapshot slot (now also `reply`:
  `loading` / `ready` / `absent`, and `audio`: which line this slot belongs to, how many of its samples are valid, `last`,
  and `failed` with a fixed code), then **3,200 samples of 16 kHz PCM16**, zero-filled when nothing is being said. Audio
  therefore arrives at exactly the speed it plays (**about 115 MB an hour more downlink**, as the plan guessed), and a relay
  sees nothing of when a reply is spoken beyond what the event stream already shows (design §3.4).
- **How a line is made.** `splitForSpeech` cuts it into sentences, and a sentence of more than 12 words into clauses at its
  commas, so the first sound does not wait for the last word. Each piece is turned into sound (24 kHz, resampled to 16 kHz by
  a windowed-sinc filter, `resample.ts`) and queued; the pieces of one line are packed into consecutive slots so no slot but
  the line's last is part empty. A unit carries one line's sound only. At most 16 lines wait; a 17th is refused for that line
  (`queue_full`), and no more than 30 s of sound waits to be sent before the next line is made.
- **The device voice is the fallback, never both.** A line the machine could not speak (`reply_voice_absent`,
  `reply_voice_failed`, `queue_full`) comes back `failed`, and the browser's `createReplySpeaker` reads it with the device's
  voice **only if no sound of it had begun** (a person would otherwise hear its start twice). Voice mode's panel gets the same
  rule through `createMachineSpeaker` (a whole reading, not one line). `absent` is also what a stream
  is told when the voice is not installed or did not start.
- **Playing it.** `createReplyPlayer` schedules each 200 ms piece to start where the last one ends (a gapless queue on one
  WebAudio context created inside the tap that starts voice mode, because iOS lets sound start only from a gesture), and a
  piece that arrives late leaves the gap the machine itself left. The speaker is one voice: **`af_heart`** (speaker 3); a
  second reply voice, ElevenLabs, is [below](#elevenlabs-as-the-reply-voice-unit-10).
- **Hear it.** Settings › Voice › Voice mode › Reply voice has **Hear it**: it opens a real stream with `reply: 'machine'`
  and a **silent** microphone (the room's sound never leaves the page), sends one sentence, plays what comes back, and says
  how long the first sound took. It is the whole path, so what a person hears and what it costs are the same test.
- **Declared gaps.** The reply voice's English front end is sherpa-onnx's lexicon (sherpa-onnx 2.x dropped espeak-ng): a
  word that is not in the lexicon (a product name such as Kubernetes) is skipped, not spelled out; numbers are written out first
  (`spokenNumbers`: "1,204" is "one thousand two hundred four") because the lexicon has no digits. Voices other than `af_heart` and speed are not here. The
  browser tells the machine to stop with a **`hush`** frame ([Barge-in](#barge-in-talking-over-a-reply)); a line already being made is made to its end and thrown away.

**Measured here (2026-11-24; the same 32-core Linux x64 box, load average 9–12 from other agents, run under `nice`; one
WebAssembly thread; `speak` times include the resample):**

| What                                                                    | Measured                                            |
| ----------------------------------------------------------------------- | --------------------------------------------------- |
| Install, real download from Hugging Face + jsDelivr                     | 164 MB, 5 files (a few seconds on this box)         |
| Load Kokoro in its worker                                               | 1.5–1.9 s; the runtime's own heap **512 MB**        |
| "Let me check the failing test." (1.6 s of speech)                      | 4.6–5.3 s: **real-time factor 2.8–3.3**             |
| A 3.4 s line, three runs                                                | 10.3–10.7 s: real-time factor 3.0–3.2               |
| **First sound of an 11-word, two-clause line, sent over a real stream** | **4.0 s** after the line was sent (3.6 s of speech) |

**The plan's target — first audio for a 12-word line in 1 s or less (a guess) — is NOT met**, and the miss is not close:
the same model through sherpa-onnx's **native** Node addon (not shipped, measured only to size the next step) ran at a
real-time factor of 1.5 on one thread and 1.0 on four, on this same loaded box. So even native is not 1 s here for a whole
clause; the first clause being short is what helps (it is cut first), and a quiet machine, a GPU or a smaller voice would
be the next levers. **A reply is still understandable**, because each piece's sound is queued and played gapless, but on
this box a long reply is spoken **slower than it is made**, so there are pauses between pieces. That is why the device's
own voice is the fallback and why `reply` is reported honestly. The next step, if the owner wants it, is the native
sherpa-onnx path (plan risk 1) — with its NixOS `nix-ld` cost (design §2.3).

Proof: `packages/plugins/voice/tests/realworld/reply-voice.realworld.test.ts` (`FY_REPLY_VOICE_REAL=1`, and
`FY_REPLY_VOICE_DIR` to keep the files between runs) refuses a file with a wrong pinned hash, then installs the real files,
loads Kokoro in its worker, speaks a line (audible level, a length a person would take to say it) and asks for the same line
over a real `VoiceStream`, measuring the first sound.

### ElevenLabs as the reply voice (unit 10)

**Built:** an optional second reply voice. Kokoro stays the default; ElevenLabs is **off until the owner chooses it**, adds
`ELEVENLABS_API_KEY` and picks a voice. Settings › Voice › Voice mode › **Reply voice source** holds the choice (On this
machine | ElevenLabs), the key row (the Speed-ups one: write-only, Test is a free read of `/v1/models`), **Load my voices**,
the voice picker, the day's use, and its own **Hear it**.

- **The key stays in the Vault's outbound holder, and the holder answers only JSON** (owner decision O4: no widening for raw
  audio; [secrets.md](secrets.md)). So a line is ONE `POST https://api.elevenlabs.io/v1/text-to-speech/<voice>/with-timestamps
?output_format=pcm_16000` through `authorizeFetch` with the `xi-api-key` placement. The answer is JSON whose `audio_base64`
  is 16 kHz PCM16: **already the stream's own sample rate, so there is no decoder and no resampling** (the same endpoint Create's
  `generate_speech` uses, which asks for MP3). A reply that is not JSON (raw audio, or one that echoes the key) is the holder's
  `unreadable`: **no sound, the device's voice reads the line**, and the failure is logged as a code, never the text.
- **Where the choice lives.** `voice.yaml` › `replyVoice` (`provider: kokoro | elevenlabs`, `elevenlabs: { voiceId, voiceName,
model, dailyChars }`). It is read **at each line**, so a change is heard from the next one with no stream reopened. **No key
  lives in the file**: a key-shaped field is refused by the schema, and a voice id must be 8–40 letters or digits before it is
  put in a URL path.
- **What loosens is held for the owner** (docs/config-files.md rule 2): moving the lines to ElevenLabs (they leave this machine
  and are billed per character), a different model, and a higher `dailyChars`. The page says "Saved, but not in effect until you
  confirm it" and keeps speaking in Kokoro (and keeps Kokoro's Hear it) until then.
- **What leaves the machine:** the text of each `<voice>` line, to ElevenLabs. Never audio, never the chat. Nothing is sent
  unless the provider is `elevenlabs`, a key is in the store and a voice is chosen; otherwise the stream says `absent` and the
  device reads.
- **Spend: a daily character cap.** Characters are **counted before the call** and kept in `state/voice/reply-spend.json`
  (a day and a count, never a word; the machine's own calendar day). Default **20,000 characters** a day; **about 20 minutes of
  speech, roughly $0.7 on the fast model (a guess from ElevenLabs' $0.036/min list price, 2026-11-23)**. Past it a line is refused
  without a call and the device reads it. Characters are given back only when the call **definitely billed nothing** (no key,
  401, 403, 429, any 4xx); a timeout, a dropped connection, a 5xx or an unreadable answer stays counted, as Create's ledger does.
  Lines are made one at a time, so two cannot both pass the same cap. This is a separate counter from Create's $5/day.
- **Routes** (`/v1/voice/reply-voice/elevenlabs`): `GET` (voice.use) answers the chosen voice, the model, whether a key
  **name** exists, and today's count: free, the key is not opened. `GET …/voices` (a **person's** `secrets.use`, audited as
  `secrets.used`, so no ferret or warden can spend the key unattended) reads the account's first 100 voices through the holder and
  keeps only id, name and kind; a row whose id is not a plain id is dropped.
- **Declared gaps.** **No real call has been made** (no key yet): the endpoint, the `pcm_16000` format on `/with-timestamps`
  and the `/v2/voices` shape are read from ElevenLabs' documentation and proved only against a fake server; the owner's first
  real line ("one line spoken, about $0.01") is the proof still owed, and a miss would change only the request or the reply
  parser. The first sound's latency is **not measured** (one round trip per piece, plus ElevenLabs' own time). Only the first
  100 voices are listed. A voice's preview and settings (stability, speed) are not offered. The per-line key use is not written
  to the audit log (a line a minute would drown it): counts and milliseconds only go to the daemon log. The model and the daily
  limit are edited in `voice.yaml`, not on the page.

### Setting voice mode up on first run (the Voice step)

First-run onboarding's **Voice** step (a client step: it configures this browser) carries a **Voice mode** section under
"Test your audio", so a fresh install walks the whole of it: **install** the machine's speech engine, **pick the reply
voice** (Kokoro on the machine is the default; ElevenLabs shows only with the person's own key) and a **Talk to test that
stops by itself after 10 seconds**. It is not a second implementation: it is Settings › Voice › Voice mode drawn inside the
step (`features/onboarding/voice-mode-setup.tsx`, handed to the step as its `voiceMode` slot), so what Install calls is the
engine's own public route (`POST /v1/voice/engine/install`), and a machine whose engine is fetched natively or falls back to
WebAssembly needs nothing different here.

It is **optional and skippable**. The section says so ("Finish later in Settings › Voice"); the step's Next never waits for
it (the machine downloads on its own, and the step is not held busy), and the frame's **Later** leaves the whole step for
Settings. It writes nothing to this device: each press is the machine's own install or setting, and what Next saves
(this device's dictation engine) is exactly what it was without the section. Talk to test takes `limitMs` (10 s here, and
none in Settings): at the limit it ends the stream, tells the machine, and says "Stopped after 10 s."

Proof: `tests/integration/app/voice-mode-setup.visual.test.ts` over a fake machine (`fixtures/fake-machine.ts`) at 390 and
1440 px, light and dark: install is one call and ends Ready, the reply voice installs and Hear it speaks, the device is
written nothing and Next's commit is unchanged, the test stops itself in about 10 s, no sideways scroll, 44 px controls.

## Speed: which path each engine runs on

**Short version.** On-device speech runs on single-thread WebAssembly today, and the app picks that for
every device. Two faster paths exist in principle — WebGPU and multi-thread WebAssembly — and this section
says what each needs, what was measured, and why neither is switched on. The code that chooses between them
automatically, remembers a failure, and shows the result in Settings **is** shipped; it simply has nothing
faster to choose until the owner decides on the one trade-off below.

### What is true today (read from the code, 2026-11-05)

| Question                                | Answer                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What does ONNX Runtime Web 1.24.1 ship? | Two builds. The default entry is **WebGPU + WebAssembly** (`ort-wasm-simd-threaded.asyncify.wasm`, 27,084,114 bytes). `onnxruntime-web/wasm` is **WebAssembly only** (`ort-wasm-simd-threaded.wasm`, ~12 MB). The wasm file is threads-capable; threads need `SharedArrayBuffer`.                                                  |
| Which one does this app ship?           | **WebAssembly only.** `vite.config.ts` aliases the WebGPU entry away because its binary is over Cloudflare Pages' 25 MiB per-file limit (every Pages deploy failed 2026-10-23 → 10-24). `scripts/ci/build-pwa.sh` fails any build that emits a file over 24 MiB.                                                                   |
| What do the workers ask for?            | Parakeet 0.6B: `executionProviders: ['wasm']`; Whisper (transformers.js): `device: 'wasm'`; Parakeet 110M and the other sherpa models: sherpa-onnx's prebuilt `asr.wasm` (no pthreads, no WebGPU); Vosk: Kaldi WebAssembly. Thread count is now the page's request (below).                                                        |
| Is the PWA cross-origin isolated?       | **No.** `public/_headers` has no `Cross-Origin-Opener-Policy` or `Cross-Origin-Embedder-Policy`, so `crossOriginIsolated` is `false` and `SharedArrayBuffer` does not exist.                                                                                                                                                       |
| Can the host set those headers?         | **Yes.** The hosted app is on **Cloudflare Pages**, which applies `public/_headers` (GitHub Pages could not). The signed-release service worker re-applies the same header rules to what it serves. The daemon does not serve the PWA, so there is no second place.                                                                |
| Does WebGPU help the engines we have?   | **Not the pinned files.** The int8 Parakeet encoder cannot run on ONNX Runtime's WebGPU provider (parakeet.js swaps to a 2.5 GB fp32 encoder to use it); the q8 Whisper graphs are quantized the same way and are expected to hit the same limit (not measured — there is no GPU here); sherpa-onnx and Vosk have no WebGPU build. |

So **WebGPU needs three things at once** — a runtime binary that fits the host, fp32/q4 model files (a
bigger download) and a device with an adapter — and none of the three exists in this build. It is wired
(`WhisperWorkerCore` is WebGPU-first and `speed-plan.ts` knows the path) and inert.

### Measured, on this machine

Box: Linux x64, **32 logical cores, 32 GB**, headless Chrome 154, **no GPU adapter** (`navigator.gpu`
answers none, so WebGPU was **not** measured at all). Clip: one fixed **5.000 s synthetic voice** (eSpeak
NG, no real person; `speed-bench/clip-5s.wav`). Each row is a fresh worker (cold load, which includes
re-hashing the installed bytes), one warm-up decode that is dropped, then the median of three. The page is
served with the app's real `_headers` (CSP, Trusted Types); the threaded rows add COOP `same-origin` + COEP
`require-corp` and nothing else. "Last audio → text" is what is left to wait after the last audio arrives;
RTF is decode time over audio time (below 1 is faster than speaking).

| Engine               | Path                      | Load   | Last audio → text                    | RTF  | After early finish (1.5 s pause) |
| -------------------- | ------------------------- | ------ | ------------------------------------ | ---- | -------------------------------- |
| Parakeet 0.6B        | single thread (**today**) | 11.9 s | **1.76 s**                           | 0.35 | **0.22 s**                       |
| Parakeet 0.6B        | 4 threads (isolated)      | 10.4 s | 0.65 s                               | 0.13 | 0 s                              |
| Parakeet 110M        | single thread (**today**) | 3.3 s  | **0.42 s**                           | 0.08 | 0 s                              |
| Whisper base.en (q8) | single thread (**today**) | 2.7 s  | **3.22 s**                           | 0.64 | **1.79 s**                       |
| Whisper base.en (q8) | 4 threads (isolated)      | 2.4 s  | 1.34 s                               | 0.27 | 0 s                              |
| Vosk small           | single thread (**today**) | 1.8 s  | **0.05 s** (streams while you speak) | —    | —                                |

- **Threads are worth ~2.5–2.8×** for the two ONNX Runtime engines on this CPU. Parakeet 110M (sherpa) and
  Vosk cannot use them.
- **"After early finish"** is the benchmark result for the new `beginFinish()` API (below), measured by calling
  it directly; no shipped code calls it yet (the countdown integration lands with the Live loop, slice 4). The
  decode starts when speech stops, so by the time a 1.5 s countdown ends only the remainder is left to wait
  for. Parakeet 0.6B drops from 1.76 s to
  0.22 s after the pause is confirmed (0.22–0.40 s over three runs), Whisper from 3.22 s to 1.79 s, with no
  change to the model, the headers or the audio. Run-to-run noise on this box is about ±5 %.
- **Not measured, and the numbers must not be assumed for them:** phones (the defaults assume a phone-speed
  CPU is several times slower — `research-numbers.ts` measured Parakeet 110M at 1.7 s there), any real GPU or
  WebGPU at all, Safari, Firefox, Windows, macOS, low-memory devices. The harness below measures them in one
  click.

### Why threads did not simply work: two layers, only one of them header-shaped

1. **Isolation.** Without COOP + COEP the page has no `SharedArrayBuffer`, so ONNX Runtime asks for one
   thread whatever the page asks.
2. **Trusted Types.** With isolation on, a threaded run **still fell back to one thread** under the real
   policy — measured: `Failed to construct 'Worker': This document requires 'TrustedScriptURL' assignment`.
   `worker-src 'self'` is **not** the problem (ONNX Runtime starts each sub-worker from the speech worker's
   own `/assets/parakeet-worker-<hash>.js`, which `'self'` allows), and `blob:` is **not** needed (a run
   with `blob:` added fell back identically). The sub-worker constructor is a script sink, and the page
   requires a `TrustedScriptURL` at every one. `lib/stt/pthread-workers.ts` fixes exactly that, inside the
   speech workers: a `Worker` URL that is one of the app's own speech worker scripts on this origin goes
   through the page's existing `fy-worker` policy; every other URL is handed on unchanged and refused as
   before. No policy name is added and the CSP is unchanged. A single-thread run never builds a worker, so
   this changes nothing until threads are asked for.

### What turning isolation on would break

Isolation is two headers on **every** response: `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. Read from the code, not all exercised in a browser:

| Thing                                                                                        | What happens under `require-corp`                                                                                                                                                                                                                                                      | Matters?                                                                            |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **`fy-render` `video` and `audio` with `src: https://…`** (`components/fy-render-media.tsx`) | A no-CORS cross-origin media load is blocked unless the host sends `Cross-Origin-Resource-Policy: cross-origin`. Most hosts do not. The `<video>`/`<audio>` tags carry no `crossorigin` attribute.                                                                                     | **Yes** — a documented feature stops working for arbitrary https media.             |
| **`fy-render` maps** (OpenStreetMap tiles, `fy-render-map-engine.ts`)                        | **Fixed.** The tile layer loads in anonymous CORS mode (`crossOrigin: ''`), and OSM answers `Access-Control-Allow-Origin: *`, so `require-corp` admits the tiles with no CORP header. Costs nothing without isolation, and the per-image `referrerPolicy` still sends OSM its Referer. | No — maps keep working.                                                             |
| **The `fy-render` sandbox frames** (`/fy-render-sandbox`, `/fy-render-html`, opaque origin)  | Under COEP every framed document must itself send COEP. `_headers` gives those two paths their own rules (with a `!` line to keep `frame-ancestors`), so each would need COEP added, then `fy-render-pages.e2e` and the Safari harness re-run.                                         | **Yes** — Mermaid, Lottie and interactive `html` blocks. Doable, must be re-proved. |
| **Cross-origin popups and OAuth**                                                            | COOP `same-origin` severs `window.opener` for any cross-origin popup. The app's only `window.open` is `noopener` (`composer.tsx`) and the MCP sign-in is a navigation plus a same-origin `BroadcastChannel`, which COOP does not affect.                                               | Low — but a provider that needs `window.opener` would break.                        |
| **Safari / iPhone**                                                                          | Safari supports `require-corp` isolation but, as far as this was checked, **not** `credentialless`, the milder COEP that would spare the media row (Chrome and Firefox have it). The phone is the device that most needs speed and the one that cannot take the shortcut.              | **Yes** for the design.                                                             |
| **Third-party iframes** (in-app browser)                                                     | A framed site must send COEP/CORP. The page's CSP has no `frame-src`, so `default-src 'self'` already refuses third-party frames; COEP is a second reason, not a new loss.                                                                                                             | No (already refused).                                                               |
| **Service worker**                                                                           | It re-applies `_headers` rules, so a header change reaches what it serves — but a copy cached before the change keeps the old headers until the release is re-verified, so the rollout needs a release cycle.                                                                          | Care, not a blocker.                                                                |
| **WebSocket, WebRTC, `fetch` to a daemon or relay at any https origin**                      | Unaffected: they are CORS or non-resource connections, not no-CORS subresource loads. The relay carriers and the hosted-PWA-to-your-daemon path keep working.                                                                                                                          | No.                                                                                 |
| **Fonts, scripts, styles, images from the app itself**                                       | Same origin: always allowed.                                                                                                                                                                                                                                                           | No.                                                                                 |

**`coi-serviceworker`** (the trick that adds the headers from a service worker on hosts that cannot set
them) is **not** the answer here, for three reasons: this deployment CAN set headers; the app already runs
one signed service worker per scope and a second would collide with it, and with the signed-release check;
and it needs a reload on first visit. On a host that cannot set headers (a self-hosted GitHub Pages copy)
the page stays non-isolated and runs single-thread, which is correct and silent.

### Decision for the owner (not made in this change)

**Shipped: single-thread everywhere, and everything needed to switch.** Turning isolation on gets
Parakeet 0.6B from 1.76 s to 0.65 s and Whisper from 3.22 s to 1.34 s on a fast desktop, but it breaks
https media, needs the sandbox frames re-proved, and the phone cannot use the milder variant. Maps no
longer blank under it: the tile layer loads in anonymous CORS mode (the row above is fixed).
The early-finish API (`beginFinish()`) is built to hide most of the wait without any of that — the benchmark
above measured Parakeet 1.76 s → 0.22 s after the pause — but nothing calls it yet: the countdown integration
lands with the Live loop (slice 4).

The work to enable it, if wanted: add the two headers to `/*` in `public/_headers`; add COEP to the two
sandbox-frame rules; decide what `fy-render` does with a video or audio host that sends no CORP (proxy it,
or show a link); re-run `fy-render-pages.e2e` and the Safari harness; then watch that a new release reaches
installed copies. The map tile layer already loads in anonymous CORS mode (`crossOrigin: ''`), so that row
asks for nothing. Until then the chooser reads
`crossOriginIsolated`, sees `false`, and keeps one thread.

### The automatic choice, and the line in Settings

`lib/stt/speed-plan.ts` is a pure, total function: `chooseSpeedPlan(model, signals, memory, now)`. A path is
a candidate only when **the build ships it**, **the model's files can run on it** and **the device offers
it** (`navigator.gpu` adapter, `crossOriginIsolated`, `hardwareConcurrency`, `deviceMemory`); the fastest
candidate wins. Threads are half the cores, between 2 and 4, and not at all at or below 4 GB. `wasm-single`
is always a candidate, so there is no input for which nothing is chosen.

- **A failure is remembered, never shown as an error.** If threads do not start or a threaded decode fails, the worker
  answers `threads-failed`, the engine starts a **fresh** worker on one thread and repeats the audio still
  waiting (ONNX Runtime initialises once per worker, so it cannot retry in place), and the device records
  the failure. The person sees a slightly slower take. The thread count is **pinned per worker** by its first
  message: a worker keeps the audio of every request while it is threaded, whatever the planner says later,
  and a request that cannot be repeated is rejected with an error rather than left waiting.
- **Remembered per device** in `fy-stt-speed-v1` (`lib/stt/speed-memory.ts`): zod-parsed, versioned, at
  most 24 entries, one per model and path, forgotten after a week so a fixed driver or a new header is tried
  again. It holds a model id, a path and a time — no words.
- **Settings › Voice** shows a read-only block under the engine list, in plain words (no technical names on
  screen): **"Speech speed: standard (one core)"** or **"Speech speed: fast (several cores)"**, one sentence
  of what that means ("Your words appear a moment after you stop talking." — or, for the fast mode, "sooner…
  about 2–3 times faster than standard on a desktop we tested", the only number, from the table above), and one
  sentence of why. When a faster mode was left out the sentence names it and says which it is: "A faster mode
  (several cores) is not available on this site yet: it needs a browser setting the site has not switched
  on." (this page is not isolated) or "…is available on this device but turned off for now, because it did
  not work here last time." (a failure is remembered). The words live in `SPEED_PATH_LABEL`,
  `SPEED_CONSEQUENCE_TEXT` and `SPEED_REASON_TEXT`; a test keeps WebAssembly, WebGPU and thread talk out of
  them. There is nothing to press and no link to the speed test page. There is no manual override: with one
  path available it would be a switch that does nothing.

### Starting to transcribe during the send countdown

Live voice sends a message 1.5 s after the last word, with a visible countdown. `beginFinish()`
(`lib/stt/tentative-take.ts`, an optional method on the session contract) lets the caller start decoding
**while the pause is still being confirmed**:

```ts
const take = session.beginFinish(); // null when this engine cannot, or the mic is not open
// speech resumed:  take?.discard()          // instant; the recording is still open
// the pause held:  await session.finish()   // reuses the decode when only quiet followed it
```

`finish()` reuses the early answer only when **every 20 ms frame** of the audio since the snapshot is quiet
(RMS under 0.01) — a short burst of resumed speech followed by a long pause is not averaged away — and the
attempt was not discarded, replaced or cleared meanwhile; otherwise it decodes the whole take afresh, so the words are always those of the audio that was said. It
never stops the microphone and never sends anything. Offered by the whole-take engines (Parakeet 0.6B and
110M, the other sherpa batch models, Whisper); not by Vosk (already ~0.05 s), Browser voice, or Parakeet
with near-live words on. Slice 4 (the Live loop) will call it; nothing ships calling it yet, in dictation or elsewhere.

### Measuring your own device

```sh
# one click, any device — the dev server serves a page that prints a JSON result (timings only, no words):
cd packages/pwa && bunx vite              # then open http://localhost:5173/speed-bench/
FY_DEV_ISOLATED=1 bunx vite               # the same, with COOP/COEP, to measure threads (dev server only)
adb reverse tcp:5173 tcp:5173             # a phone then reaches it as localhost, which is a secure context

# headless, under the app's real policy (downloads the models; manual, never in CI):
bunx vite build && bun harness/stt-speed-bench.ts [--isolated] [--blob-workers] [--engines parakeet,whisper-base-en]
```

The result is parsed against a strict schema before it is shown: it can hold timings, a device class
(browser family, cores, memory, isolation, a WebGPU adapter's vendor/architecture) and a failure **code** —
never a transcript, an address or an error message. `FY_DEV_ISOLATED` is read by the dev server only; the
deployed site's headers are `public/_headers`, which this change does not touch.

## Clean-up: prompts you can edit

Clean-up runs once, after Stop, and only on a dictation you made. **Where it runs** depends on where the key is:

- **A key on this device** (Settings › This device › Speed-up keys): the browser calls Groq or Cerebras
  itself — no round trip through a machine, which is the fast path. The key is encrypted in this browser
  and never sent to any machine or agent ([secrets.md](secrets.md#device-held-speed-up-keys)).
- **Otherwise, the machine's key** (Settings › This machine › Speed-ups): the browser asks the daemon, which
  spends the key from its secret store.
- **Neither:** the raw words are kept, and the review box says to add a key in Settings › This device.

Either way the request is built, and the reply judged, by the same shared code (`@ferretry/protocol`
`stt-cleanup*.ts`), and the conversation it reads is the one the session page already shows.

What it does is configured in the machine's `voice.yaml` (Settings › Dictation edits it; so can you, or `fy config`):

```yaml
postProcessing:
  provider: groq # off | groq | cerebras
  model: openai/gpt-oss-120b # Groq default; openai/gpt-oss-20b is the faster one
  style: fix # off | fix | polish
  prompts: # optional: your own wording; a style you do not list uses the shipped prompt
    fix: 'Fix transcription errors; keep my wording.'
  useConversation: false # send the last few messages as read-only reference
  conversationMessages: 8 # 1–10
```

- **Styles are prompts.** _Fix mistakes only_ corrects transcription errors, punctuation and casing and keeps
  your wording; _Polish_ rewrites into clear sentences with the same meaning; _Off_ does nothing. The shipped
  wording is `DEFAULT_VOICE_CLEANUP_PROMPTS` in `@ferretry/protocol`. **Reset to default** deletes the override
  key, so a later change of the shipped wording reaches you.
- **Use the conversation for context** (off by default) sends the newest N messages of the current session so
  names and terms are spelled right. The machine decides: a device cannot send more than `voice.yaml` allows.
  Turning it on is a loosening, so it waits for the owner to confirm like switching clean-up on.
- **The guard cannot be edited away.** Whichever prompt runs is wrapped in a fixed system message
  (`@ferretry/protocol` `stt-cleanup-guard.ts`, on both paths): only the text in `<dictation>` is corrected, it is never answered or
  continued, and conversation and vocabulary are read-only reference that is never merged in. Your prompt is
  placed under it as a style hint and cannot outrank it. Text inside a block cannot close it.
- **The reply is checked.** If its length diverges grossly from the dictation (Fix is stricter than Polish), it
  repeats a run of five words found only in the conversation, or it leaks the wrapper's tags, clean-up returns
  your raw transcript, marked `kept: "raw"`. A failed check costs nothing but the call.
- **gpt-oss reasoning.** For a `gpt-oss` model the request asks for `reasoning_effort: low` (and Groq's
  `include_reasoning: false`); the reply's separate `reasoning` field is never read.
- Neither the API key nor a transcript is ever logged.

## Seeing what clean-up sent and got back

Two device-local tools, both in Settings › This device. Neither is synced, and neither is ever sent to a daemon.

### Dictation debug (off by default, in memory only)

Switch it on and every clean-up call this tab makes leaves one **debug record**: the provider, model and
endpoint host; timings and token usage; the full request (the always-on guard wrapper, your Fix/Polish
prompt, the conversation that went along, the raw transcript); the provider's raw reply, reasoning included;
each post-processing step (reasoning stripped, the guard's decision and reason, the kept-raw fallback); and
the final text. The review box then shows a **Details** link that opens the record, and Settings lists the
**Recent calls**.

- **Only the last 10 are kept, in this tab's memory.** A reload or switching it off empties them; nothing is
  written to disk (`lib/stt/dictation-debug.ts`). Only the switch itself is remembered.
- **The key is never in a record.** Request headers are redacted by name (`TRACE_REDACTED`), and the
  device path never reads the key at all — it shows a placeholder. A record does hold dictated words and the
  conversation sent with them, which is why it is opt-in and never leaves the tab.
- **Through the daemon** the browser asks for the echo with `debug: true` on `POST /v1/stt/enhance`; the
  reply carries `debug` (a `CleanupTrace`) for that call only, on success and on failure. The daemon does
  not log or keep it. Its raw reply is the parsed JSON re-printed, and it has no first-byte time.
- The record's shape and its redaction are `@ferretry/protocol` `stt-cleanup-debug.ts`.

### Transcription log (on by default)

Every dictation is kept as one entry in this browser's IndexedDB (`lib/stt/transcription-log*.ts`) so words
are never lost to a mis-tap: the time, the conversation it was for, the engine (Parakeet in-browser / Web
Speech), the duration, the raw transcript, the cleaned text, which prompt ran, and whether it was inserted or
discarded. **No audio is stored.** It keeps the newest 200 entries, none older than 30 days. You can search it,
copy from it, put an entry back into the open composer, and clear it with **Clear log**; an off switch stops recording
(what is kept stays until the log is cleared). If the browser refuses storage the log keeps working for the tab and says it
is not saved. An entry links to its debug record while that record is still held.

### Timing: which stage is slow

"Is it transcription or the Groq call?" The two are different stages, and the **speech to text** step is not
the Groq call at all: Parakeet and Browser speech run on this device, and Groq or Cerebras is the **cleanup**
that follows. Every dictation therefore carries a **timeline** of numbers (`lib/stt/dictation-timeline.ts`, the
owner of the shape and the arithmetic), measured on `performance.now()` from the moment you press Stop:

- the recording's length and size, and the time to stop the recorder and decode it (Parakeet);
- **speech to text**: engine, model, wall time, and the one-time model load on the dictation that paid for it;
- reading the conversation a hosted cleanup may see;
- **cleanup**: provider, model, wall time, when the response head arrived, how many attempts, and the tokens the
  provider reported. A call through the daemon also carries the provider time the daemon reported, and its
  attempts and tokens when the debug echo came back;
- the time to put the words into the composer, and how long the review box stayed open.

`Stop to review` is the pipeline's total; `Stop to composer` adds the insertion and leaves out the time you spent
reading. The timeline holds **numbers only**: no words, no audio. It lives on the log entry (this device only,
same switch as the log) and on the debug record while that is held, and is never sent anywhere.

It is shown as a stacked bar (speech to text, cleanup, other) with the milliseconds beside it and the slowest
stage named in words as well as outlined, on each log entry and in the debug sheet's **Timeline** section. The top
of the transcription log summarises the newest 20 timed dictations: median and p90 for speech per engine and for
cleanup per provider and path (nearest-rank percentiles).

What it does **not** have, because it does not exist on these paths: time to first token (the cleanup request is
not streamed, so "first byte" is the response head), key rotation or provider fallback (one provider is chosen per
device), and a cooldown wait (a rate-limited call fails and keeps the raw words; nothing sleeps and retries). The
one retry is the same call without the conversation after the provider found it too big, shown as two attempts.
Browser speech cannot see inside the browser's recogniser, so it reports only how long Stop waited.

## Read aloud: hearing a reply

The button is **opt-in** (r11 S12): it is hidden until this device turns on **Settings › Voice › Show Read aloud on each reply** (off by default; stored with the other device voice settings, independent of Auto-read). With it on, every assistant message has a **Read aloud** button (icon and words, never an emoji alone). Press it and the device's own voice reads
the reply; the same button becomes **Stop** (it is the same element, so keyboard focus stays on it). It is the first slice of live voice
chat (F137): reading on request now, hands-free turns later. Nothing is read by itself, and the microphone is not
involved.

- **Captions.** While it reads, a block under the message shows the sentences, the one being spoken marked with a tint, an underline and a
  heavier weight (colour is never the only signal) and scrolled into view. With reduced motion the scroll is instant and nothing fades.
- **Words for the state.** A visible note and a polite live region say **Reading**, **Stopped**, **Finished**, **Couldn't read this
  aloud** or **No on-device voice, reading unavailable**. The reply text is never put in the live region: a screen reader would say it twice over the voice.
- **One voice at a time.** Pressing Read aloud on another message moves the reading there; leaving the conversation stops it.
- **Nothing is shown** where the browser has no speech, or where a message has nothing worth saying (markup only).

### What is read, and what is described

`lib/voice-chat/speakable.ts` is pure and total (any text in, a list of sentences out, never an exception). Prose is read; things that
are for the eyes are **described** and left on screen.

**It walks the screen's own tree.** The reply is parsed by `remark-parse` + `remark-gfm` — the same pair `components/markdown.tsx`
draws from — so what the screen shows as code, a table, a quote or a diagram is what the voice describes, **at every depth**: a
`~~~fy-render` block inside a quote says its `alt`, and four-space-indented code, or a fence inside a list item, is "Code block, N
lines" — never read. A fence is a diagram exactly when the renderer says so (`fy-render` and nothing after the language).

| In the reply                          | Said as                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Paragraphs, headings                  | Read a sentence at a time; a heading ends with a stop                                                                                       |
| Lists                                 | Each item; more than 8 items reads the first 5, then "and 6 more"                                                                           |
| **Bold**, _italic_, links `[text](u)` | The plain words, and the link text                                                                                                          |
| A bare URL                            | "a link to github.com"                                                                                                                      |
| Inline code                           | Short word-like code is read ("use dictation"); a path as its file name; a hash or UUID as "a commit" / "an ID"; otherwise "a code snippet" |
| Code block (fenced or indented)       | "Code block, 14 lines of TypeScript. It's on screen." — never the code                                                                      |
| Table                                 | "A table with 4 rows. Columns: name, status, cost."                                                                                         |
| `fy-render` block                     | Its required `alt`: "A diagram: login flow from browser to daemon." (a broken block is a code block)                                        |
| Image                                 | "An image: {alt}"                                                                                                                           |
| `@file`, `:agent`, `&F12`, `^A3`      | "file.ts", "ferret dev", "task F12", "agenda item A3" — the one reference grammar, not a second one                                         |
| Commit hashes, UUIDs                  | "a commit", "an ID"; numbers and versions ("4.277.0") are read as they are                                                                  |
| Emoji, HTML, comments                 | Dropped; tags stripped; `<!-- … -->` is silent                                                                                              |
| Blockquote                            | "Quote:" then the words                                                                                                                     |

**One reading is capped at about a minute** (≈ 900 characters at normal speed, scaled with the rate), then it says "There's more on
screen." and stops. Code, tables and pictures count toward the minute, so a code-heavy reply is not a lecture either.

**Hostile text stays cheap.** A reading looks only at the first 12,000 characters and 400 lines of a reply (past that it says there is
more on screen), and before parsing overwrites — one character for one, so every `sourceRange` offset still slices the original — runs of
more than 24 identical `*`, `_`, `.` or `~` and list or quote markers nested past 8 on one line. The parser is linear on prose but not on
those, and no real reply has them. Tens of thousands of unmatched backticks, brackets or tildes are read in tens of milliseconds
(`tests/unit/voice-chat-speakable.test.ts` pins under 100 ms). `sourceRange` is in UTF-16 units, so text after an emoji in a hidden
comment still slices correctly.

### Which voice

Free voices **built into the device** (`speechSynthesis`): no paid or cloud voice, no new secret, no download.

- **Remote voices are NEVER chosen automatically** (owner rule). The browser says which voices are `localService` (they keep the text
  on the device). The order is: **a local voice that matches the reply's language, then any local voice** (the device's own pick first;
  it reads with an accent), **then none**. With none the reading is **unavailable**: nothing is spoken, the row says
  "No on-device voice, reading unavailable" in words, and the reply stays text. Voices a browser lists as remote (Chrome's "Google …",
  Edge's "Microsoft … Online") are skipped even when they are the only ones, and even when they are the browser's default.
- **A remote voice speaks only when the person explicitly picks it in the voice picker** (`ReadAloudDeps.pickedVoice`; the picker itself
  arrives with the settings slice). It is then labelled in words wherever it is shown — "Google US English (sends text to Google)" in the
  list, "… sends text to Google to be spoken." on the row; the vendor is read off the voice's name, and an unknown one says "its maker".
  A picked voice that is no longer on the device is ignored and the automatic order above applies.
  The warning is a boxed notice with a warning icon and full-size text (not a small grey line), shown **next to the button before
  Read aloud is pressed** (`ReadAloudController.previewVoiceNote()`) as well as while reading.
- **Captions** show **whole lines only**: the box grows with the reply to six lines and then scrolls a line at a time, resting on line
  boundaries (`caption-scroll.ts`), with padding outside the scrolling part so no line touches a border. The sentence being said has a
  tinted background, a solid bar on its left, an underline and a heavier weight, and no trailing highlight past its last word.
  Read aloud and Stop are at least 44 px tall (48 px on a phone or touch screen).
- **A voice is always named, never the browser's unset default** (which can be a remote voice, and would send the reply away with no
  warning). If the device lists no voices yet (browsers load them late; the speaker asks as soon as the page makes it, so by a tap they
  are there), the same "unavailable" words show; pressing Read aloud again works once they have loaded.
- **Something else cancelling the speech** (another tab of the page, a browser extension) ends the reading as **Stopped** — the button
  does not stay on Stop forever. A cancel Ferretry itself caused (Stop, or a newer reading replacing this one) is told apart by a
  generation number and never reported twice.
- **Rate** is 1.1 by default and always kept between 0.8 and 2.0. The voice, rate and length are the device's own choices, made in
  [Settings › Voice › Read replies aloud](#auto-read-replies-a-finished-turn-read-aloud); the Read aloud button uses them too.
- **Chrome stops long speech** after about fifteen seconds, so each sentence is spoken as short pieces, one at a time
  (`speech-chunks.ts`); the captions still move one sentence at a time.
- **iOS** only lets speech start from a tap. Read aloud starts inside the tap itself, and `SpeakerPort.unlock()` (a silent, zero-volume
  space, once) is there for the later slices that speak without a fresh tap.

### Privacy

- The text is handed to the browser's speech engine and **nothing else**: it is not sent to the daemon, not logged, not written to
  storage, not put in a test snapshot or a screenshot (committed captures use fake replies).
- The controller (`lib/voice-chat/read-aloud.ts`) keeps only the sentences being read, in memory, until the next reading.
- The microphone stays off: Read aloud never opens it.

### Where it lives

`lib/voice-chat/` — `speakable.ts` (markdown → sentences), `ports.ts` (`SpeakerPort` and its events), `speech-synthesis.ts` (the adapter
over `speechSynthesis`, with the browser objects injected so every path is tested with a fake and no audio), `speech-chunks.ts`,
`voice-choice.ts` (voice and rate, pure), `read-aloud.ts` (which message is being read and which sentence). `hooks/use-read-aloud.ts` is
the composition point and `components/read-aloud.tsx` is the control and captions, drawn by `TranscriptTextRow` for assistant text.

### `<voice>` lines: the words a reply marks as spoken

A reply can mark the words meant to be heard: `<voice>Let me check.</voice>`. The grammar and its parser are Conversation's
(`packages/plugins/conversation/contract/voice-tag.ts`: `splitVoice`, `spokenLines`), so the chat and the voice cannot disagree on what a
spoken line is.

- **Drawn:** the chat shows each line as a **speaker line** (a speaker mark, an accent tint with a soft outline, italic words) and never the tag
  (`app/hypermedia/voice-line.tsx`). A line is plain text, never Markdown or HTML.
- **Said:** when a reply holds at least one **closed** line, Read aloud and Auto-read say **only those lines** (same sentence splitting,
  same one-minute cap) and none of the written work around them. A reply with no closed line is read exactly as before.
- **What is not a line:** a tag inside a code fence, an indented block or an inline `code span` (a reply that _teaches_ the tag); an
  opening tag whose closing tag is not in the same paragraph; a stray closing tag; an empty line (the tags are dropped). Nested opening
  tags fold into one line that ends at the first closing tag.
- **Still arriving:** an unclosed tag at the very end of a message that is streaming is drawn as an open line (with "…") and never
  said; in a finished message it stays visible as the text it was.

## Auto-read replies: a finished turn, read aloud

The same reading, started by itself: when a ferret's turn ends, this device reads the reply. It is the second slice of live voice chat
(F137) — "talk by typing, listen to answers". **Off by default**, and a device choice: Settings › This device › Voice › **Read replies
aloud** (badge "This device"; the palette finds it by "read aloud", "voice chat", "hands-free", "auto-read"). Nothing is read unless the
switch is on, and the microphone is never involved.

### What is read

`lib/voice-chat/reply-picker.ts` is pure and total (rows in, one pick out, never an exception).

| The turn ended…                | Read                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| with text (`your-turn`)        | **Only the last message of the turn** — or every message of it, if "What to read" is "Every message"        |
| with no text                   | "Done. No message." (a silent turn is not mistaken for a broken one)                                        |
| waiting on you (`needs-input`) | The question, and its options numbered ("Options: one, Postgres; two, SQLite"). **Never answered by voice** |

"Waiting on you" is every shape the page can show it in, read from the same read-only data: a **permission prompt** (the tool and its
question, with its options), a **harness dialog** (its title and rows), the agent's own **question**, or the daemon's one-line **reason**,
in that order. Only when none has readable words does it say "The ferret needs your answer. It is on screen."

Never read: the person's own messages, **other ferrets' messages**, agenda and system rows, notices, thinking and tool calls (they are not
assistant text at all), a message the ferret _sent to another ferret_, and Pack commands. The turn is what came after the person's last
message, so a silent turn can never fall back to the previous turn's reply. The reply to a send from this page is **the last
assistant text after THAT SEND'S OWN message** ("Done. No message." when there is none): the row the transcript joined to the send's id, else a
row of the person's with the ledger's words dated no earlier than the daemon accepted the send. While that row is not in the transcript
yet — a slow read — the reading **waits** (up to five seconds, then the usual quiet guard once it shows) and, if it never shows, **stays
silent**: it never falls back to "the last answer in the transcript", which on a transcript that has not caught up is the previous turn's. A turn that was only watched is cut by its start time: the last message of the
person's at or before the start (a later one moves it only when the clock is skewed, it is the first, and the agent has not answered before it).
Code, tables and pictures are described, not read (the
speakable rules above), and one reading stops at the **longest reading** setting with "There's more on screen."

### When a turn has "ended"

`lib/voice-chat/auto-read.ts` is a small pure state machine over what the page can see; it has no clock and no browser object, so every rule is a plain test.

**It works only on the daemon's own word.** Every date it uses is the daemon's `turnStateAt`, on the daemon's clock; nothing is ever compared
with the browser's clock. A machine that sends no `turnState` gives it nothing to work with, so **nothing is auto-read there** — the settings
row says so in plain words ("Auto-read needs a newer Ferretry on your computer") — **only when it applies**: the connected machine has live ferrets and none of them carries a turn (`machineIsOlder` in `hooks/use-machine-dates-turns.ts`); a machine that does date its turns shows no note — and **Read aloud** on a message still works. There is
deliberately no guess for an old daemon: a guess timed by "3 seconds of quiet" read history three reviews in a row.

0. **Only the daemon's live word counts.** The page draws this device's cached copy first (the fleet's seeded view, a transcript from the
   local cache). A cached snapshot is not the daemon's word about the session now: it is not looked at, raises no watermark and arms
   nothing. The page tells the hook so (`authoritative`), and the hook never arms a send off a cached copy either.
1. **The watermark.** The newest turn-state date the page has looked at. The first **live** snapshot seeds it: a session already at
   `your-turn` when the page opens, or when the switch is turned on, reads nothing. A `working` only starts a watch when it is dated
   **after** everything already seen, so a replay of an older working → your-turn pair (a reconnect, a snapshot arriving late) is at or
   below the watermark and arms nothing. Whatever is read, skipped or merely looked at raises it: consumed is consumed.
2. **A watched turn** is one seen `working` after the watermark. It ends at the next `your-turn` or `needs-input` dated after its `working`.
3. **A send is a token taken when the press happens**, before the request is awaited, remembering the watermark (the floor) and whether a
   turn was already running (the newest `working` with no completion after it). When the request comes back the token is **bound to the
   send's own id**, and the daemon's send ledger says when the daemon **accepted** it. A completion is the send's own only if the
   **daemon dated it after that acceptance** — daemon against daemon, never the browser's clock — and either (a) a `working` of the
   new turn was seen and is itself dated at or after the acceptance, with the end after it, or (b) none was seen (a short turn can flip
   faster than the page renders it) and the turn that was running at the press has already ended — that earlier end is the old turn's
   and is consumed, never read. A previous completion that turns up late is dated before the acceptance; a replayed older `working` is
   at or below the floor. Until the ledger shows the send, nothing is read (a turn that was fast enough to finish first is read the moment
   it does). A newer send drops whatever was waiting on the older one, and a send whose request failed drops its token. The press itself
   reads nothing, and the acknowledgement of a press the composer already announced stops nothing — above all not a fast reply already
   being read. A message sent without going through the composer's press (answering a form) stops a reading and is followed like any
   other turn. **The old turn's end is remembered:** once the end of the turn that was running at the press has been consumed, only a
   completion dated **after** it can be the send's own — the same completion looked at again (the last row of the old turn arriving, a
   snapshot replayed) is still the old turn's and reads nothing.
4. **Hidden before the ledger answers.** A completion seen while the tab is hidden is remembered by the send's token even when the
   ledger has not yet shown the send; once it has, that completion (and anything dated at or before it) is consumed silently and the
   token is spent — so coming back and the acknowledgement arriving can never read it.
5. **Text-settled guard:** the last words and the whose-turn flip arrive separately, in either order, so it waits for 500 ms with
   nothing new before it reads.
6. A turn that ends while the tab is **hidden** is never read: it is judged when it is seen (and the moment the tab hides cancels a
   pending reading), not when the timer would have fired, so coming back changes nothing.
7. **History is never a fresh arrival.** The page draws this device's cached transcript first and replaces it with the authoritative log;
   rows are only ever _picked from_, never counted as arrivals, so that hydration reads nothing.

A turn that was only watched, and whose `working` the page never saw (it finished between two looks), is not read — silent rather than
risk the wrong reply. A **send** whose `working` was never rendered is read, because the daemon's own dates prove it.

### What stops it

A **tap anywhere**, **any key**, a new send from this page, the tab going to the background, leaving the conversation, switching the
setting off, or the **Stop** button on the "Reading the reply" chip above the composer. The mic is off while it reads, so interrupting is
by hand only. A tap or key stops only a reading the auto-reader started: pressing Read aloud on a message is not undone by that tap.
One reading at a time — a new reading replaces any other.

### The settings

Kept in this browser under its own key, `fy-live-voice-v1` (`lib/voice-chat/live-settings.ts`): zod-parsed field by field, versioned,
capped (a voice id is at most 200 characters), a bad field falls back by itself, a payload from another version is discarded, and
refused storage keeps the choice in memory and says so. Nothing in it is a secret and no reply text is stored.

| Setting           | Choices                                              | Default                  |
| ----------------- | ---------------------------------------------------- | ------------------------ |
| Auto-read replies | On / Off                                             | **Off**                  |
| Voice             | the device's voices, or "Best voice for this device" | Best voice               |
| Speed             | 0.8× – 2.0×                                          | 1.1×                     |
| Longest reading   | 30 seconds · 1 · 2 · 5 minutes · No limit            | 1 minute                 |
| What to read      | Last message of the turn · Every message             | Last message of the turn |

The voice is chosen from a **picker** (`features/settings/voice-picker.tsx`), not a native `<select>`: a closed select shows one line and cuts what
does not fit, and the words that matter most are the voice's name and who gets the text. The button shows the voice in use — its name, then a
second line saying where it speaks ("Speaks on this device" / "Sends text to Google", with a warning icon and bold words for a remote one). It
opens a list of radio rows grouped **On this device** and **Sends text away** (a voice the browser does not mark `localService`, such as
Chrome's "Google …" ones); a row carries the name and the vendor line separately, **both wrap, neither is ever clipped**, and the chosen row
says **Selected**. A remote voice also warns in a full sentence when chosen. **Preview voice** speaks one sentence with the chosen voice and
speed (a remote voice shows its warning while it is previewed).

**Auto-read replies** is a real switch (`role="switch"`, `aria-checked`) in a full-width row: the name, the state **in words**, and a track
with a thumb that moves. Every control — the switch row, the voice button and its rows, Preview, the speed slider (a 48 px hit area around a
32 px thumb), the Longest-reading select and the What-to-read rows — is at least 44 px tall, and 48 px on a phone or any touch screen. Free voices built into the device only: no paid or cloud voice and no new secret.

### Accessibility

State is always in words: the switch says **On**/**Off**, the chip says **Reading the reply** and how to stop, and a polite live region
says only "Reading the reply" — never the reply itself, which the voice already says. Targets are 44 px (48 px on a phone); nothing moves (there is no
animation to turn off); the settings carry no autofocus.

### Where it lives

`lib/voice-chat/` — `reply-picker.ts`, `auto-read.ts`, `live-settings.ts`. `hooks/use-auto-read.ts` is the composition point (one timer and a few
document events). In 5.0 it is mounted by Voice's `auto-read` panel in Conversation's `conversation.above-composer` slot (`surfaces.tsx`), which is handed the rows, the turn (`live` = the daemon's own word), what the ferret waits on and the daemon's send ledger (ids and accepted times, never the browser's outbox or a send's words). The slot carries no send callbacks, so `beginSend` / `sent` / `failed` are not called from it: a reply to a message typed in this chat is read as a watched turn (cut by the turn's dated start), and a tap or key still stops a reading. The turn's date is the ferret summary's `stateAt` (`chatSessionOf`); `hooks/use-live-voice-settings.ts` binds the store; `hooks/use-live-voice-settings.ts` binds the store; `components/auto-read-chip.tsx` is the chip;
`features/settings/auto-read-settings.tsx` is the settings section inside Settings › Voice, `voice-picker.tsx` its voice list, and the styles are in `components/read-aloud.css` (`.fy-auto-read*`, `.fy-ar*`).

## Pause detection (the end of a spoken turn)

**Dropped by the owner (!A525).** v4 built a turn endpointer (_has this person finished their turn?_) and
a scoring helper for it, but never mounted either on a screen, and 5.0 has no live voice mode to run them
in. Both files, their tests and the noise harness are deleted; nothing replaces them yet. The shared
loudness math in `lib/stt/energy.ts` stays, used by `near-live.ts`. A future live voice mode designs its
own end-of-turn rule from [the voice modes design](design/voice-modes.md).

### Archived measurements (the deleted endpointer)

Kept as history only: the harness that produced these numbers (`turn-endpointer-noise.ts`) is deleted, and
the rest of this section is not a description of anything built. Its audio was generated, so no
recording of any person was ever involved.

- **Speech** is synthetic: harmonic voices with vowel formants, syllable envelopes with shallow valleys,
  fricative bursts, breaths between words, phrase pauses, and a last word that trails off in 30 % of
  turns. Every word's true start and end is known. Talkers are 75 % normal (voiced RMS 0.05–0.12) and
  25 % soft (0.025–0.05).
- **Noise beds** are synthetic too: an empty room; a fan (low-passed noise, a 100/200/300 Hz hum and a slow
  wobble); a café (distant babble and clinks); a TV (a competing voice and a steady chord).
- **Fixtures** are three scripted pause habits: _steady_ (reads a prepared sentence), _coding_ (mostly
  short, some thinking pauses) and _hesitant_ (long hesitations are common). The pause lengths are
  **invented** to span those habits.
- Each turn is 1.5 s of bed, the turn mixed into it, then 6 s of bed. The audio is cut into 20 ms
  frames by the shipped `energy.ts` and fed to the real endpointer with all three presets.
- **False send (noise)** — the turn ended although the person had really been quiet for **less than the
  configured pause**. This is scored **strictly**: a real gap of 1,400 ms at Normal (1,500 ms) is a false
  send, not a cut-off. It is the endpointer's own error and what the 2 % target is about. A word's onset
  or tail can sit under the loudness threshold, so a **second, tolerant column** forgives a real gap within
  **150 ms** of the setting (a "near miss"); both rates are published, and the strict one is the headline.
  **Cut-off (by design)** — the person really paused at least as long as the setting, then spoke. Nothing
  is wrong; it is the price of a setting, and it depends only on the invented pause habits.
  **Late** — the turn ended more than 1 s after the last word plus the pause. **Missed** — it never ended
  in the 6 s after the last word. The nobody-talking rate runs exactly 10 minutes of bed per row and is
  divided by the audio actually fed.

**Normal (1.5 s), 200 turns per row, seed 7, 0.03 ceiling, strict scoring:**

| Bed (RMS)  | False sends, strict | False sends, ±150 ms forgiven | Cut-offs (by design, _coding_) | Late > 1 s | Missed | Ended vs. last word + 1.5 s, p50 / p95 | False starts per hour, nobody talking |
| ---------- | ------------------: | ----------------------------: | -----------------------------: | ---------: | -----: | -------------------------------------: | ------------------------------------: |
| room 0.002 |                0.0% |                          0.0% |                          22.5% |       0.0% |   0.0% |                            +5 / +17 ms |                                     0 |
| fan 0.004  |                0.0% |                          0.0% |                          17.5% |       0.0% |   0.0% |                            −1 / +14 ms |                                     0 |
| fan 0.008  |                1.5% |                          0.0% |                          23.5% |       0.0% |   0.5% |                           −13 / +13 ms |                                     0 |
| fan 0.012  |                1.0% |                          0.5% |                          22.5% |       0.0% |   2.5% |                            −22 / +6 ms |                                     0 |
| fan 0.02   |                1.0% |                          0.5% |                          23.5% |       0.5% |   0.5% |                           −20 / +10 ms |                                     0 |
| café 0.008 |                0.0% |                          0.0% |                           0.5% |       3.0% |  95.0% |                       +2125 / +4136 ms |                                   222 |
| café 0.015 |                0.0% |                          0.0% |                           0.0% |       8.5% |  87.0% |                       +1705 / +3597 ms |                                   258 |
| café 0.025 |                0.0% |                          0.0% |                           0.0% |       0.0% | 100.0% |                                      – |                                    48 |
| TV 0.01    |                0.0% |                          0.0% |                           0.0% |       0.0% | 100.0% |                                      – |                                    30 |
| TV 0.02    |                0.0% |                          0.0% |                           0.0% |       0.0% | 100.0% |                                      – |                                    30 |

**Is the < 2 % false-send target met at Normal? Yes for the room and fan beds, under strict scoring — with
little margin.** Across the five room and fan rows the endpointer cut someone off early in **7 of 1,000**
turns (0.7 %; the 95 % upper bound is about 1.4 %); the worst single row is 1.5 % (fan 0.008). The
tolerant column (forgiving a real gap within 150 ms of the setting) gives **2 of 1,000** (0.2 %). An earlier
version of this page reported only the tolerant figure, with the slack undocumented; the strict figure is
the honest one. Of the 7, five were near misses (a real gap of 1,440–1,495 ms against a 1,500 ms
setting), and two were soft talkers (RMS 0.036–0.038) under the two loudest fans, where a voice about as
loud as the noise is not separable by loudness. The target is **not** met in café and TV babble (see
below), though there it fails by waiting, not by cutting off.

- Ending lands within about ±25 ms of the ideal in the room and fan rows, and at most 0.5 % of those turns
  are late.
- **Quick is not as safe**: strict false sends are 7.0 % at fan 0.012 and 5.5 % at fan 0.02 (2.8 % across
  the five room and fan rows; about 60 % are near misses). Thinker is 0.6 % across the same rows (worst
  row 1.5 %). The 2 % target is for Normal.
- **The ceiling** (fans only, 150 turns per row, Normal, strict scoring). With near-live's 0.015 ceiling a
  0.012 fan ended 30 % of turns more than a second late and a 0.02 fan never ended one (100 % missed). At
  0.05 a 0.02 fan left 24 % of turns unfinished and strict false sends rose to 2.7 % (1.3 % at fan 0.008
  and 0.012). At 0.03 the same fans were 1.0 % false sends with 0.5 % missed at fan 0.02, so 0.03 is the
  best of the three.
- **Café and TV babble is a known gap.** Babble is speech-shaped, so no loudness rule can tell it from
  you: turns end late (3–8.5 % over a second) or never (87–100 %), and an unattended room starts 30–258
  phantom "speech" an hour. It fails in the **safe direction**: it does not send early, it
  waits, and the 120 s cap, **Send now** and the **End** button still work. A real fix needs a speech
  detector rather than a loudness one (a small Silero VAD in the speech worker, plan §4.1) or a spoken
  "send it" mode for noisy rooms. Neither is built.

### Why 1.5 s is the default

| Fixture (fan 0.008)           | Quick 0.9 s | Normal 1.5 s | Thinker 2.5 s |
| ----------------------------- | ----------: | -----------: | ------------: |
| _steady_ (prepared sentence)  |        9.0% |         0.0% |          0.0% |
| _coding_ (thinking pauses)    |       54.0% |        23.5% |          5.5% |
| _hesitant_ (long hesitations) |       79.0% |        51.5% |         26.0% |

Cut-offs here are **properties of the three invented scripts, not measurements of people**; read them
as the shape of the trade-off. Quick cuts off more than half of the _coding_ turns (54 %), which is why it is
not the default. Thinker costs one extra second on **every** turn to bring the _coding_ cut-offs from 23.5 % to
5.5 %, and Normal is the point where a prepared sentence is never cut (0 %). A cut-off is
also recoverable: after the pause comes the 1.5 s send countdown (**Hold** / **Send now**), and
speaking again during it cancels the send. Total time from your last word to "sent" is therefore the
pause plus the countdown plus STT and clean-up, an estimated 3.4–5.5 s at the defaults.

### Still to do

- **Real-device proof.** Everything above is synthetic audio. A real fan, a real café, accents and real
  microphones (browser noise suppression and auto-gain change the levels) need an on-device check with
  the in-app timing numbers (pause → STT done, countdown held/used), which tune the defaults.
- **Café/TV** — see above.
- **No screen yet.** The Live bar, the countdown and the loop that uses these events come in later slices.

## The agent gate: do ferrets speak `<voice>` lines?

Voice mode only works if the agent answers in `<voice>` lines ([the tag](#voice-lines-the-words-a-reply-marks-as-spoken) is the
grammar; the words a lead ferret reads are `packages/plugins/voice/instructions/voice.md`). **Unit 9 measured it** on real ferrets,
2026-11-24 (PST evening), against the design's pass mark A3: **at least 90 % of tool-needing voice turns per harness**.

**Result.** Claude Code on `claude-sonnet-5-5`, 20 turns each run:

| Wording                                                                                                   | (a) a line before the first tool | (b) a final line of 1-3 sentences | (c) nothing code-like in a line | All three                   |
| --------------------------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------- | ------------------------------- | --------------------------- |
| The merged text (PR 2475): "Before any tool, …"                                                           | 16 / 20                          | 19 / 20                           | 20 / 20                         | **15 / 20 (75 %), fails**   |
| The changed text (this change): "Your very first output must be …, before you call any tool, even a read" | 20 / 20                          | 20 / 20                           | 20 / 20                         | **20 / 20 (100 %), passes** |

**Codex: not run.** Ferretry 5.0 cannot use a host Codex login yet (`store: host` answers "not in 5.0 yet", and a Ferretry-kept login
refuses a linked or hard-linked sign-in file), so the only way in was to copy the owner's `codex-personal` sign-in file into the test
home. That was refused on purpose (a copied sign-in can rotate its refresh token and sign the owner out). **A real gap:** the Codex
half of A3 stays unmeasured until a Codex login can be added to a test daemon without copying a credential. Until then nothing here
says Codex follows the teaching.

**The five misses of the merged wording** (the exact lines are in the gate folder, `u9-gate/run1-current-wording/`, kept with the unit briefs and not in this repo):

- **Turns 14, 17, 18 and 20** (dependencies, default port, run the build script, total stock): the ferret went straight to its tools and
  said nothing first, so the first spoken line came after the work. In turn 14 the line it finally said started with the instruction's
  own words ("Before any tool, one moment while I check …"), so the wording itself was being echoed.
- **Turn 10** (what the docs notes say): the final line was **four** sentences ("… And ask Dana about the supplier contract.").
- No turn put code, a path, a file name, an id, a list or a tag inside a line (c: 20 / 20 in both runs).

**The change (one sentence in the instruction, no code):** "Before any tool, reply with `<voice>one short line</voice>`" became "Your very
first output must be `<voice>one short line</voice>`, before you call any tool, even a read", and "`1-3 plain sentences`" gained
", never more than three". Same size class (447 characters, under the 450 the unit test allows). One re-run, as the plan allows: 20 / 20.
**The numbers are small (20 turns a run) and one model:** 20 / 20 says the wording works on Sonnet 5.5 on these tasks, not that it
always will; the fall-back for a reply with no closed line is still Read aloud of the whole reply (see [the tag](#voice-lines-the-words-a-reply-marks-as-spoken)).

**How it was run.** A throwaway 5.0 daemon on port 7480 (its own `FY_HOME`, limits off, outside `ferretry_fleet.slice`), built from this
branch so the ferret got the real `voice` instruction section; one fresh lead ferret per turn on `claude-atomi`, working in a tiny
synthetic project (a CSV, a small TypeScript service, a log, notes, a two-commit git repo). Each ferret first answered a plain "reply
ready" opener, then `fy send` typed `(voice) <words>` into it verbatim, exactly as the voice stream sends it
(`daemon/lib/stream/session.ts`). The harness transcript was then read and each turn scored with the merged grammar, `splitVoice`
(`conversation/contract/voice-tag.ts`):

- **(a)** a **closed** line in a text block before the first tool call of the turn;
- **(b)** the turn's last message, after the last tool, ends in a closed line of **1-3 sentences**;
- **(c)** no line holds a backtick, angle bracket or brace, a path, a file name with an extension, a hex id or uuid, a snake or camel
  case name, a call or flag, or a list marker.

A turn passes only if all three hold. Two of the first twenty prompts (the last commit, today's date) were answered from the context the
ferret was handed, with no tool, so they were not tool-needing; they were replaced by "how many bytes is the stock csv" and "which version of
bun is installed here" and the first pass is kept apart in `u9-gate/pass0-excluded-first-pass/`. The scorer and the prompts are in
`u9-gate/` (`score.ts`, `utterances.txt`); the raw spoken lines for every turn are `u9-gate/<run>/raw/NN-claude.voice.txt`. **Not covered:** a
voice turn to a ferret deep in a long typed conversation, a second voice turn in the same ferret, a helper ferret (it never talks to the
person and is not given the section), and any model other than Sonnet 5.5.

## Not built yet

- **Live voice** (listen, notice the pause, send after a visible countdown, read the reply aloud):
  nothing of it exists (its end-of-turn detector was dropped by the owner, !A525 — see
  [Pause detection](#pause-detection-the-end-of-a-spoken-turn)). There is no Live button, bar or loop.
- **Codex and the voice teaching:** unmeasured. 5.0 cannot yet use a host Codex login in a test daemon, so the agent gate
  ([above](#the-agent-gate-do-ferrets-speak-voice-lines)) ran on Claude only.
- **Voice mode on your machine** (hands-free chat): the machine's speech engine, the audio stream to it, the panel and the
  machine's reply voice are built and measured (see [Voice mode: the machine's speech engine](#voice-mode-the-machines-speech-engine),
  [The voice mode panel](#the-voice-mode-panel) and [The reply voice](#the-reply-voice-kokoro-on-the-machine)); the panel does not
  speak its replies in the machine's voice (the device voice reads when the machine has none) and can be talked over; the phone
  fallback (unit 8) is not built.
- ~~A machine-wide default chosen during onboarding~~ — done: New machine setup's Voice step renders
  `VoiceEngineChoice` and saves the choice as `voice.yaml`'s `defaultEngine`; a device that has not picked an
  engine dictates with it until it picks its own. Settings › Dictation still shows the device's own choice
  (none) rather than the machine default it is using.
