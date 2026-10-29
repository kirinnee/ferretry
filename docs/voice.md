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

Every engine is offered side by side in **Settings › Voice**, each card carrying the numbers the on-device
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
- **WebAssembly only, no WebGPU.** The WebGPU-capable build's binary
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

## Phone/browser voice

The browser's own `SpeechRecognition` (`lib/stt/browser-recognition.ts`). Nothing to download, live
words while you speak, and on Chrome, Android and Safari the audio goes to the vendor's speech service,
so it needs a connection and the vendor's privacy policy applies. Firefox does not offer it, and an
installed iPhone/iPad Home Screen app cannot use it.

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
