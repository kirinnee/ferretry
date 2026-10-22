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

## The review box: nothing reaches the draft without Insert

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
`onDraft`, so the draft cannot change without the person pressing Insert.

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
