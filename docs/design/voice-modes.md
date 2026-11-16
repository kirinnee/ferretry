# Voice modes and the daemon speech engine

Status: **plan, not built.** Nothing in this document is implemented by the change that adds it. It
plans two cards: **&F1268 Live Chat Voice Mode** and **&F1269 Daemon Streams Voice Engine**, on top of
the &F137 live-voice slices already merged or in review. Section 10 lists the choices only the owner
makes; everything else here is a proposal a slice may correct when it measures something.

The owner's words (2026-11-05, !A410), verbatim — first the request, then the refinement that sets the
shape of this plan:

> _"allow for on-device, or stream from daemon, which opens up the possibility of US just RTC-ing voice
> to a livestream model in the daemon, which injects "send" for us, so there's nothing that happens here
> (for live-chat mode). for non-livechat mode, the transcription will have to return back to the
> browser, for injection. even for "real-time transcription"_
> _so there are couple of modes: 1. transcribe 2. live-transcribe 3. live-chat_
> _live chat can be triggered by a button, which the conversation just stops using the composer, and
> goes into live-chat mode, and the ferret agents will need to inject <voice> or wtv output, to
> summarioze what needs to be replied to the user concisely, and make them always reply something FIRST
> then do some tasks. like say "like me check" or something."_

> _"for multi-CPU and GPU mode, please make it such that it is opt in and user is aware that it will
> break embed. users can also choose to do daemon-transcript (for voice mode) and on-device for ad-hoc
> transcription. so there are two settings here: 1. ad-hoc 2. voice chat. for ad-hoc, it can be realtime
> or non-real time (real-time can use REAL real-time model, or chunking technic). voicec-chat always
> happen on daemon-side -- there's no reason not to, right? ad-hoc, users can choose daemonside, or
> on-device, and if they choose on-device, ask them if they wanna use GPU/multi-CPU."_

Carried over from !A395 and the &F137 slices, and **not reopened here**: auto-send after a **1.5 s
countdown** with **Hold** / **Send now**; read **only the last message**, describe code, tables and
pictures, stop after **~60 s**; interrupt **by tap or key only**, **mic off while reading**; **free device
voices** only; clean-up **Fix** style only in voice chat. And: _"use multiple GPU and CPU ... and how to
let it not affect the main agent"_.

Paths are relative to the repository root. "Measured" means a number from a run cited here; everything
else is an estimate and says so.

---

## 0. The plan in one screen

1. **Two settings groups** in Settings › Voice:
   - **Dictation (ad hoc)** — the mic button. **Where:** on my machine, or on this device. **When words
     appear:** after you stop, or in real time — real time by a **true streaming model** or by
     **chunking** a batch model. **On this device only:** an opt-in **Faster on this device** (several
     cores and/or the GPU), with a plain warning about what it breaks.
   - **Voice chat** — the hands-free conversation. **Always on your machine.** The daemon listens,
     transcribes, counts down and presses send.
2. **Text goes back to the browser for dictation**, whichever engine runs; the browser puts it in the
   draft, as the owner said. **In voice chat the daemon sends**; the browser carries the microphone, the
   countdown, the buttons and the read-aloud.
3. **Voice chat never silently falls back to the device.** Unreachable, busy, not installed, out of
   memory: the panel says which, and what to do (§1.4).
4. **Transport: audio inside the existing end-to-end session**, as a new §14 stream session
   (`/v1/voice/stream`), not a WebRTC media track: it works on every carrier, stays sealed end to end,
   never conceals or invents audio, and has a fixed shape on the wire (§3).
5. **The daemon engine is one separate worker process** (native sherpa-onnx), never the daemon itself:
   hard-capped in its own systemd scope on Linux beside the I36 fleet slice, best effort elsewhere, and
   only loaded while used (§2).
6. **A ninth grant capability, `voice`**, person-only on every route. Every browser stays governed, on
   the host too. The privacy sentence changes to **"only to your own machine, encrypted end to end; never
   stored"** (§4).
7. **Faster on this device is per device**: the app's own signed service worker adds the isolation
   headers only for a device that opted in, after one reload (§6). It is the answer to !A411.
8. **Ferrets learn one tag, `<say>`**: a one-line acknowledgement written first ("Let me check."), and a
   1–3 sentence spoken summary at the end. Voice chat reads only that, with the &F137 reply picker as
   the fallback (§5).
9. **Nothing in flight is stopped.** &F137 slices 1–5 merge; slice 4's on-device take path is later
   replaced by the daemon for voice chat, and keeps serving on-device dictation (§7).

---

## 1. The two settings groups

### 1.1 Dictation (ad hoc): the mic button

| Setting                   | Choices                                                                                                                                          | Default                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| **Where it runs**         | **On my machine** · **On this device** (Parakeet, Whisper, Vosk) · Phone/browser voice (sent to Google/Apple)                                    | none until chosen — the mic asks, as today (`docs/voice.md`: nothing is chosen for you) |
| **When words appear**     | **After I stop** (review box or Insert straight away, as today) · **In real time** (words go into the draft at each pause; you still press Send) | After I stop                                                                            |
| **How real time works**   | **Streaming model** (words while you speak; less accurate) · **Chunked** (an accurate batch model re-run on pauses: `near-live.ts`'s rule)       | Chunked on my machine; on this device, whatever the chosen model can do (below)         |
| **Faster on this device** | Off · **Several cores** · **GPU** — only shown when Where = On this device, and only the parts this device can use (§6)                          | Off                                                                                     |

- **Real time never sends.** Committed words go into the draft at the caret as they settle; interim
  words show greyed in the strip; **Stop** commits the tail. One optional **Fix** pass then runs over
  the dictated span, with **Undo**, and is skipped if you edited that span.
- **Which engines can do which real-time style:** on this device, Vosk and Phone/browser voice stream;
  Parakeet and Whisper chunk (Parakeet's near-live already ships; Whisper's is new); the sherpa batch
  models chunk. On my machine, Chunked is Parakeet; Streaming is a streaming Zipformer if installed (D1).
- **Retired:** the per-device "Live words (experimental)" switch. "In real time · Chunked" is that
  feature finished.

### 1.2 Voice chat: always on my machine

- **Started by** a **Voice chat** button beside the composer (today's &F137 "Live" button, renamed), the
  palette entry **Voice chat**, or its shortcut.
- **The composer is replaced.** Its text box, attachments and send button hide, and the voice-chat panel
  takes the same slot: phone — one 96 px button (Listening / Hold / Stop reading), this turn's words
  above it, **End** beside it; desktop — a strip the composer's height. The draft you had is kept
  untouched and comes back on **End**.
- **The loop:** you speak → a 1.5 s pause → the words, visible → a 1.5 s countdown (**Hold** / **Send
  now**) → **the daemon sends** → the ferret's `<say>` acknowledgement is read → … → its `<say>`
  summary is read → listening again. Every &F137 rule holds: words on screen at least 500 ms before an
  automatic send; speech during the countdown cancels it; mic closed while reading; Space / Esc / S / R
  / H / Enter as slices 4 and 5 define; needs-input is read and then voice chat stops at the normal
  prompt UI; nothing is ever approved by voice.
- **Settings for voice chat** are few: the pause length (Normal 1.5 s · Quick · Thinker, from the
  endpointer), the read-aloud voice and speed (slice 2's), sounds (slice 5's). There is no engine
  choice.

### 1.3 Where audio and text go

| What                           | Audio goes                                                                      | Text goes                                                                  | Who presses Send |
| ------------------------------ | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------- |
| Dictation, on this device      | nowhere (Parakeet, Whisper, Vosk) · Google/Apple (Phone/browser voice)          | stays in the browser                                                       | you              |
| Dictation, on my machine       | to your daemon, while you speak (decoding overlaps speaking), sealed end to end | back to the browser: the review box (after stop) or the draft (real time)  | you              |
| Voice chat                     | to your daemon, sealed end to end                                               | the daemon sends it as the message; the browser shows it and the countdown | **the daemon**   |
| The ferret's reply, read aloud | —                                                                               | ordinary session events → read on the device with its own free voices      | —                |

Clean-up keeps its two paths (`docs/voice.md` › Clean-up). With the machine engine and a **machine**
key, the daemon may run Fix itself before answering, saving a round trip. A device-held key is never
sent to the daemon, so with a device key the browser still calls the provider.

### 1.4 "Voice chat always on the daemon — there's no reason not to, right?"

**Right, with four honest costs**, none of which is a reason to fall back silently:

- **It needs the machine to be reachable.** Away from home that is the relay or WebRTC, which is fine
  on most networks; offline it is impossible.
- **It needs the engine installed** (~490 MB once) and the memory to load it (~1 GB).
- **It uses data:** about 190 MB an hour on a phone's connection (PCM; §3.1), about a quarter of that
  once B6's Opus lands.
- **The relay sees that a voice chat is happening** and roughly when turns are sent (§3.4) — never
  the audio or the words.

**When the machine cannot do it, voice chat says so and stops; it never falls back to the device:**

| What happened                                               | What the panel says (and offers)                                                                                                                                                                           |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the machine is unreachable when you press Voice chat        | "Voice chat runs on **<machine>**, and it can't be reached right now." The connection's own reason. The composer stays.                                                                                    |
| the connection drops mid-chat                               | "Lost **<machine>** — trying again." Any countdown is cancelled (§1.5). Reconnected within 30 s: listening resumes. Otherwise voice chat ends and the composer returns with the unsent words offered back. |
| the engine is not installed / the device lacks `voice.use`  | "Voice chat needs speech on **<machine>**." **Install** (or "ask the machine's owner") — the grant's way-back sentence.                                                                                    |
| busy (`429 voice_busy`), another device holds this ferret   | "Busy: **<device>** is in voice chat with this ferret." / "**<machine>** is already serving 2 voice chats."                                                                                                |
| not enough memory to load (`503 voice_no_memory`)           | "**<machine>** doesn't have ~1.5 GB free to load speech."                                                                                                                                                  |
| the engine falls behind (`engine_behind`, `engine_timeout`) | "**<machine>** is too busy to keep up — that turn was lost. Say it again." Three in a row: voice chat ends and says the machine is overloaded.                                                             |

Dictation on my machine follows the same rule: an unreachable or busy machine is an error that names
the cause and links Settings › Voice; it never switches engines by itself.

### 1.5 Voice chat, step by step

```
browser                                  daemon (voice stream)                   ferret
 │ open /v1/voice/stream {sessionId}
 │ ── fixed units, every 40 ms ────────▶ endpointer + STT (worker)
 │ ◀── fixed snapshot, every 200 ms: listening / interim words / nonce
 │                                       pause held 1.5 s → final words
 │ ◀── snapshot: countdown {turnId, revision, sendAt}
 │ ── unit control slot: shown {turnId, revision}, echo {nonce} ──▶
 │    [Hold] → slot: hold {turnId} ────▶ countdown cancelled, words kept
 │                                       countdown ends, phone fresh → send service ──▶ message typed
 │ ◀── snapshot: sent {sendId}                                                   <say>Let me check.</say>
 │ ◀── (session event stream) assistant text with <say> → read aloud, mic closed
 │                                       ...turn ends → <say> summary read → listening again
```

- **`shown` is bound to the words.** The daemon sends only after `shown {turnId, revision}` for that
  turn **and that transcript revision**, and 500 ms after it. If speech resumed and the words changed, a
  new `shown` is needed.
- **The phone must be provably alive, not just the socket.** Received audio is not proof — up to ~1.3
  s of already-sent units can still arrive after a phone dies (§3.1's window). So every downlink
  snapshot carries a fresh **nonce**, and every uplink unit echoes the newest nonce it has seen in its
  control slot. The daemon sends only if it has received an echo of a nonce it issued **within the last
  1 s**. An echo proves the phone was running after that nonce left the daemon, so a silent phone
  (airplane mode, a tunnel, a dead socket) cancels the send. **The honest window:** a phone that dies
  within about the last second can still send — words that had been on screen for at least 500 ms. A
  close, a stream error, or the device's `voice.use` being narrowed also cancels.
- **Kept words are narrow.** Words from a cancelled send are kept only for the **same device and the
  same ferret**, for **10 minutes**, and offered again — never sent — when that device reopens.
- **The send is an ordinary send**: the same send service, ledger, audit and delivery path as
  `POST /v1/ferrets/:ferretId/send`, as the device that opened the stream, with `origin: 'voice-chat'`
  and a **stable send id** (`<streamId>:<turnId>`), so a lost acknowledgement or a retry can never
  deliver twice. At the moment of sending the daemon re-checks that the device is still paired and holds
  `voice.use`.
- **Mic off while reading** still holds: the browser sends `muted` and then **zero samples** at the same
  rate, so the stream's shape does not change; the endpointer pauses. Interrupt is tap or key.
- **One voice chat per ferret.** A second device is refused `409 voice_busy`, naming the device that
  holds it — the machine-wide twin of slice 4's Web Lock.

---

## 2. The daemon engine

### 2.1 Prior art in this repository

The daemon had a speech engine once: `bin/stt-worker.ts`, a Bun worker spawner, a sherpa-onnx
recognizer loaded as `sherpa-onnx-node`, a model store with hashed downloads (no resume: a plain fetch
into a fresh file) and an audio decoder. #273 (`ac6b8a35a`) removed it when dictation moved to the
browser. Its shape was right — **the native addon and the model live only in a child process, so a
decode cannot block the daemon's event loop and a native crash cannot take the daemon down** — and slice
B2 reuses that shape from `ac6b8a35a^`. What it lacked, and is **new work** here: the spawner ran
`process.execPath` on a **source `.ts` path** and loaded the addon from `node_modules` — neither exists
beside a compiled `fyd`; it was batch only; downloads did not resume; and it ran uncapped.

### 2.2 Which models

| Candidate                                        | Used for                                                       | Accuracy (published / measured here)                                                             | Disk                                                | Memory (approx.) | Languages    |
| ------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------- | ---------------- | ------------ |
| **Parakeet TDT 0.6B v3, int8** (sherpa-onnx)     | voice chat; dictation after stop; dictation real time, chunked | the most accurate measured in this app (`research-numbers.ts`)                                   | 487,170,055-byte archive (sherpa-onnx `asr-models`) | ~1 GB            | multilingual |
| Parakeet TDT 0.6B v2, int8                       | (alternative to v3)                                            | similar; English only                                                                            | 482,468,385-byte archive                            | ~1 GB            | English      |
| Streaming Zipformer (sherpa-onnx, English, int8) | dictation real time, streaming                                 | lower; the 20M variant dropped the first second of 26 of 33 utterances through this app's worker | tens of MB (per variant¹)                           | ~100–300 MB      | English      |
| whisper.cpp base.en / small.en                   | not proposed: a second native runtime for no gain              | good; hallucinates on silence without a VAD                                                      | 140–470 MB¹                                         | ~0.3–1 GB        | per model    |
| Silero VAD (sherpa-onnx)                         | a **trial** beside the loudness endpointer                     | a candidate for café clatter; it cannot tell the owner's voice from a TV's, which is speech      | ~2 MB¹                                              | small            | any          |

¹ Not measured in this repository; B2 measures and pins exact sizes and hashes. The two Parakeet sizes
are the release assets' byte counts on `k2-fsa/sherpa-onnx`'s `asr-models` release.

**Parakeet v3 is the default (D1).** It is the model the browser already ships and measured best, it is
multilingual, and the expensive part of chunking — a full re-decode every pass — is what a native
multi-threaded runtime is good at. The browser runs it on **one WebAssembly thread** (1.76 s for 5 s of
speech, measured, `docs/voice.md` › Speed); native ONNX Runtime uses SIMD and several threads, so a pass
every ~0.5 s should be affordable (B2 measures it). The streaming Zipformer is an optional second
install for the "Streaming" style (D1), not the default, because of the dropped-first-second result.
Silero is kept only if it passes the existing café/TV harness (`turn-endpointer-noise.ts`) with no rise
in false sends.

### 2.3 How the native code gets onto the machine, and how the worker runs

`fyd` is one compiled Bun executable per target (linux-x64, linux-arm64, darwin-arm64).
`node-datachannel` is embedded in it because its prebuild is a single `.node` linking only libc
(`docs/relay-protocol.md` §16 › The engine). **sherpa-onnx is not like that**: its Node addon links
`libsherpa-onnx-c-api` and `libonnxruntime` as sibling shared libraries, and a Bun-embedded `.node` is
extracted alone, so the siblings would not be found without a custom static build (expected from the
package layout; B1 verifies).

**Proposal (D2): download the native runtime on Install, like the model.** Settings › Voice › **Install
on my machine** (or `fy voice install`) fetches, at pinned versions and SHA-256s, one archive per target
holding the addon and its libraries, plus the model(s), into the state home (`voice/runtime/<version>/`,
`voice/models/<id>/`). Verified on arrival and again when the worker loads them, removable; resuming a
partial download (HTTP `Range`, as the browser's store does) is new code. **No model and no native
library is embedded in `fyd`**; it grows only by the worker's own code and sherpa-onnx's small
JavaScript wrapper (B2 reports the bytes). Nobody who never uses the machine engine downloads anything.

**How the worker runs inside a compiled `fyd`** (all of it B2, proved by a smoke on the release AND Nix
binaries with no Bun and no `node_modules` on `PATH`):

- **A hidden subcommand of the same binary**, `fyd voice-worker`, spawned as `process.execPath
voice-worker` with Bun's advanced IPC — not a source path, which a compiled install does not have.
- **The JavaScript half is bundled into `fyd`.** sherpa-onnx's `OfflineRecognizer` / `OnlineRecognizer`
  are JS wrappers over the raw addon exports (`scripts/node-addon-api/lib/*.js` upstream); that wrapper,
  at the pinned version, is compiled into `fyd`, and only the `.node` and its libraries come from the
  download. The worker loads the `.node` by absolute path (`process.dlopen`).
- **Library lookup per target:** the addon's `$ORIGIN` / `@loader_path` run-path if the prebuild has
  one, otherwise the worker is spawned with `LD_LIBRARY_PATH` / `DYLD_LIBRARY_PATH` set to the runtime
  directory — for that child only. B1 reads the prebuilds' run-paths and records which.
- **Nix.** The flake's `fyd` is unchanged. The downloaded Linux prebuilds link glibc and libstdc++
  dynamically, which runs on a normal distribution and under Nix on one, but **not on NixOS** without
  `nix-ld` or a Nix-built sherpa-onnx. B1 checks for a nixpkgs `sherpa-onnx`; if it exists, `voice.yaml`
  may point `engine.runtimePath` at it and the download is skipped. Until then NixOS is a declared gap.
- **macOS: unverified.** There is no `codesign` step in `scripts/release` today, so library validation
  is not expected to refuse downloaded dylibs, and a file fetched by this process is not expected to
  carry a quarantine attribute — but neither is proved. B2's Apple Silicon smoke loads the real release
  artifact and checks both; if `fyd` is ever signed with the hardened runtime, it would need the
  `disable-library-validation` entitlement or signed runtime libraries.
- **`fyd --check`** gets a `voice` line: not installed / installed, version, last self-test (decode one
  bundled synthetic clip), and whether it is hard-capped on this host.

### 2.4 CPU, GPU and memory on the machine

- **CPU, Linux x64 and arm64, macOS arm64:** ONNX Runtime's CPU provider, int8, SIMD (AVX2/AVX-512 on
  x64, NEON on arm64). This is where "use multiple CPU" is answered for voice chat: the daemon has no
  cross-origin-isolation problem, so threads cost nothing to switch on.
- **GPU: not in v1, and opt-in if ever (B7).** CUDA needs `onnxruntime-gpu` plus CUDA and cuDNN
  libraries (well over a gigabyte, driver-matched); CoreML on macOS is supported by sherpa-onnx for some
  models but is unproven for Parakeet's int8 graph. A Parakeet decode on a modern CPU is expected to be
  a small fraction of real time already (B2 measures it), so a GPU buys little for one speaker. Unlike
  the browser, the machine's GPU breaks nothing in the page.
- **Memory:** ~1 GB while loaded (Parakeet). The worker loads on the first stream — warm-up begins the
  moment voice chat or the mic opens, so loading overlaps speaking — and **exits after 10 minutes with
  no stream**, which frees all of it, as the WebRTC engine already hands its threads back when idle. It
  **does not load** when the host's available memory is under the model's size plus 1 GB of headroom
  (`503 voice_no_memory`, §1.4).

### 2.5 Keeping the agents and the daemon fed (ties to &I36)

The daemon already places agents in cgroups (`packages/daemon/src/lib/cgroups/`, I36, built in
`docs/ferret-limits.md`): a transient systemd **user** scope per agent under `<product>_fleet.slice`,
**on by default**, with `CPUWeight=50` on the slice, memory limits computed from the user's real budget
(`packages/protocol/src/lib/limits.ts`) and **no CPU quota by default**, and the daemon itself in
`app.slice`, never capped.
The voice worker joins that layout as a **sibling** slice, built by the same `scope.ts` / `limits.ts`
code so there is one owner of the unit format:

```text
user@UID.service
├── app.slice/…                         the daemon — never capped
├── <product>_fleet.slice               agents (I36): CPUWeight=50
│   └── <product>-agent-<id>-<n>.scope
└── <product>_voice.slice               the speech worker; CPUWeight=200 (D3 (b)) — above the fleet's 50
    └── <product>-voice-<n>.scope       CPUQuota = C × 100 %, MemoryMax = 1.5 GB
```

**One number, C, the voice cores:** `min(4, max(1, floor(cores / 4)))` — 2 on an 8-core laptop, 4 on the
32-core box. Everything below is stated in C.

**One worker, one queue.** There is exactly one worker process for the whole machine. It holds one
recognizer per installed model; Parakeet's recognizer is **three ONNX Runtime sessions** (encoder,
decoder, joiner — sherpa-onnx's NeMo transducer), each built with the same thread options, so a thread
count alone does not bound the process: idle pools may spin. Two things do:

1. **Decodes run one at a time.** Every stream's audio goes through one queue in the worker; within a
   decode the encoder, decoder and joiner run one after another, so about C threads are busy at once.
   Each session gets `numThreads = C`, with spinning turned off where sherpa-onnx exposes ONNX Runtime's
   option (B2 checks, and measures the process's real CPU when idle and when decoding).
2. **On Linux, the kernel enforces it.** When `cgroupsSupported` (Linux and the unified hierarchy; that
   function does not check that a user manager answers, so the launch itself is the test), the scope
   gets a hard `CPUQuota` of C cores — whatever threads exist, the worker gets at most C cores of CPU
   time — and a `MemoryMax` of 1.5 GB. **Who wins under contention (D3) is a weight on the slice, not the
   scope**: siblings share CPU by their own weights, and the scope is the only child of
   `<product>_voice.slice`, so a weight on it would decide nothing. The owner chose D3 (b): `<product>_voice.slice`
   is `CPUWeight=200`, against the fleet slice's **50** (it was 100 before I36 made the fleet's weight explicit)
   and `app.slice`'s default 100, so **voice sits above the ferrets** and the daemon above them too. B2's contention
   test runs against these real units. A worker over its memory is killed by the kernel; the daemon sees the exit, says so on the stream, and
   the next stream starts a fresh worker.

**Where cgroups cannot be used** (macOS; Linux without cgroup v2; a user manager that refuses
`systemd-run`): the worker still starts — unlike an agent launch, which fails — with the thread count,
`setpriority` nice +5 and an RSS watchdog in the daemon that stops it over 1.5 GB. **These are best
effort, not hard reservations**: nice only lowers priority, and a watchdog acts after the fact. Settings
and `fyd --check` say "not hard-capped on this machine" with the reason. (Refusing voice instead is a
one-line change if the owner prefers it.) macOS's `taskpolicy -b` is not used: it throttles far below
real time.

B2 proves it: a contention test (a CPU-bound build on every core while two streams talk) records the
build's slowdown and the voice lag, and an over-memory test proves the kill and the message.

The daemon's own event loop never runs a decode: audio crosses to the worker by IPC (Bun's advanced
IPC, `Float32Array` without a JSON copy, as the old worker did) and only text comes back. At most **2
streams** at once and **1 per device** by default; more are refused `429 voice_busy`.

---

## 3. Transport

### 3.1 The voice stream

A new route on the daemon's socket table, `/v1/voice/stream`, opened as a **§14 stream session**
(`docs/relay-protocol.md` § Stream sessions) — so it is dispatched through the same route table, the
same capability guard and the same device proof on every carrier, and the rendezvous changes **zero
code**. One stream serves dictation (on my machine) and voice chat; `start {purpose, sessionId,
style}` is its first record.

**Both directions are fixed-size binary units in `bytes` records.** A §14 `text` record is JSON-escaped
again inside the tunnel envelope, so a padded text snapshot still varies in sealed length with its
content (measured by the round-2 review: two 1,024-byte snapshots sealed to 1,056 and 1,136 bytes). A
`bytes` record's base64url length depends only on its byte count. And a `bytes` record is a run of an
ordered byte stream whose boundaries are **not** preserved, so each side re-assembles units from bytes
and never relies on record boundaries:

- **Uplink: one 1,344-byte unit every 40 ms** — 1,280 bytes of **PCM, 16 kHz mono, 16-bit
  little-endian** (640 samples), then a 64-byte **control slot**: the newest nonce echo, plus at most one
  short control (`shown {turnId, revision}`, `hold`, `send-now`, `muted`, `unmuted`, `end`), zero-padded.
  **Constant rate for as long as the stream is open**: silence and muted time are zero samples, so the
  shape never changes with speech. The browser writes one whole unit per record.
- **Downlink: one 1,024-byte unit every 200 ms** — a 2-byte length, then UTF-8 JSON of at most 1,022
  bytes, zero-padded. Every unit is **complete and parseable on its own** and always carries the state,
  countdown, `sent` / `error`, and a fresh nonce. The turn's words travel in a **bounded fragment** in
  the same unit: `{turnId, revision, offset, total, text}`, with `text` capped so the unit fits (about
  700 bytes). A transcript longer than that — 240 words is already ~1.3 KB, and a turn may run 120 s —
  arrives over consecutive ticks at increasing offsets; the browser reassembles by `(turnId, revision)`,
  drops a revision once a newer one starts, and refuses one whose `total` is over 16 KB (far above 120 s
  of speech). **`shown {turnId, revision}` is sent only after the whole revision is on screen**, so a
  long turn's countdown waits for its last fragment. Changes wait for the next tick (≤ 200 ms added to
  interim words). ~5 KB/s.
- **Malformed is fatal:** a control slot or unit that does not parse, a length past the unit, a fragment
  whose offset or total is inconsistent, or a stream that ends mid-unit closes the stream with a protocol
  error.
- **B3 tests the shape at the right layer**: the sealed frame sizes and gaps on the wire, both
  directions, not the plaintext.

**Bounds, and the failure contract** (the §8 window bounds frames _in flight_, not audio already
accepted, so the stream needs its own):

- **Credit is returned only when the worker has accepted the audio** into its queue. The window (32
  frames) is then ~1.3 s of audio in flight.
- **The worker's queue holds at most 2 s of unprocessed audio per stream.** Past that, or when a final
  decode has not answered within 5 s, **the turn fails out loud** (`engine_behind` / `engine_timeout`,
  §1.4), its audio is dropped, and the next turn starts clean. Audio is never silently skipped inside a
  turn.
- **The browser holds at most 2 s** of audio it has no credit to send; past that it ends the turn with
  "your machine isn't keeping up".
- **Rates and sizes:** a stream that sends more than 1.25× the nominal unit rate over any 5 s is closed;
  a turn ends at 120 s (the endpointer's cap); a stream ends after 2 hours and the browser reopens it.
  Admission: 1 stream per device, 2 per machine (§2.5).

**Bandwidth:** 33.6 KB/s of units up, ~46 KB/s on the wire after base64url and framing, plus ~7 KB/s
down (5 KB/s of units) — **~190 MB an hour**. Against the hosted relay's per-daemon ceilings (512 MiB a minute, 20 GiB a
day, §13) an hour is about 1 % of a day. **Slice B6 (Opus)** gives the uplink its own fixed unit: a
2-byte length, one constant-bitrate packet of 120 bytes (24 kbit/s × 40 ms), the 64-byte slot — 186
bytes, about **7× less uplink** (~4.7 KB/s before framing), downlink unchanged; ~45 MB an hour on the
wire. It uses WebCodecs `AudioEncoder` where the browser has it, probes CBR support per browser rather
than assuming it, and adds an Opus decoder on the daemon (a WebAssembly decoder in the worker). It must
be CBR, because variable-bitrate packet sizes are known to leak what was said.

### 3.2 Why not a WebRTC media track

| Question              | Audio units in the session (proposed)                                                                                         | WebRTC audio track (RTP/Opus)                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Works over the relay? | **Yes**, and direct, and on the WebRTC data channel when that carrier won                                                     | **No.** The rendezvous is a WebSocket; it cannot carry RTP. The default carrier is Relay, which never reaches WebRTC (§16). |
| Needs TURN?           | No                                                                                                                            | Yes, for any network where ICE fails (§16 has no TURN, on purpose: it would need a credential the config must never hold)   |
| Lost packet           | Retransmitted (reliable session): a round trip of delay, nothing concealed; a stream that falls too far behind fails the turn | Concealed: the jitter buffer invents or drops audio — fine for a call, **bad for recognition**                              |
| End-to-end encryption | The session's own AES-256-GCM, keyed by the §6 handshake pinned to the QR fingerprint                                         | DTLS-SRTP, keyed by a fingerprint that travels in the sealed SDP — sound, but a second key system to reason about           |
| Daemon-side cost      | None new: the session already exists                                                                                          | RTP depacketizing (libdatachannel can) **plus an Opus decoder** (a second native library)                                   |
| Latency               | 40 ms units + the carrier's path (one leg on direct/WebRTC, two on relay)                                                     | ~20 ms framing + the path, but only where a peer-to-peer path exists                                                        |

Speech recognition wants every sample more than it wants the last 20 ms. The owner's "RTC-ing voice"
is satisfied in spirit — real-time audio to the machine — and when the WebRTC carrier wins, the voice
stream **does** ride a peer-to-peer UDP path, as one more data channel.

### 3.3 Latency, estimated

- **Interim words:** unit (40 ms) + one-way path (direct LAN ~5 ms; relay tens of ms; §16 measured a
  60 ms WAN round trip at ~72–76 ms per keystroke) + a chunked pass (target ≤ 300 ms at C threads, B2
  measures) + up to one 200 ms downlink tick.
- **Voice chat, last word → sent:** pause (1.5 s) + countdown (1.5 s), with the final decode hidden
  inside the countdown exactly as `beginFinish()` hides it in the browser (slice 4 computed ≈ 3.0 s for
  the on-device engines). The machine should match it on any phone, because the phone no longer decodes.

### 3.4 What a relay can and cannot see

Added to `docs/relay-protocol.md` §10 by slice B3:

- **Can:** that a stream session was opened, when, for how long, and its constant record sizes and
  cadence both ways. Because silence, muted time and control travel inside identical units, and the
  downlink is a fixed tick, the voice stream itself does not show when you speak, pause or press Hold.
  What remains visible is **elsewhere**: a voice-chat send makes the ordinary event stream move, and the
  ferret's reply arrives on it, exactly as when typing — so the relay can see roughly **when a turn was
  sent**. §10 says so plainly.
- **Cannot:** any audio, any word, the session or ferret it is for, or the device.
- **Pairing is not changed.** A voice stream is an authenticated session a paired device's key opened; a
  device with no grant cannot open one. Pairing sessions keep their own rules — including that they may
  cross the relay, sealed to the QR-pinned identity (§14 › Pairing sessions) — and never carry voice.

---

## 4. Security and privacy

### 4.1 A ninth capability: `voice`

`docs/grants.md`'s three questions, answered:

1. **What does somebody reach for this switch to STOP?** A paired device streaming audio to this
   machine and using its CPU and memory for recognition (`use`), or installing, removing and retuning
   the engine — a ~500 MB download and a native library loaded on the host (`configure`).
2. **Does switching it off also stop the thing that undoes it?** No. Turning `voice` off for remote
   callers touches no credential and no device; revoking a lost phone is still `pairing`.
3. **The way back on the control** is the sentence every capability carries: the host command
   `fy daemon config set voice --use`.

- **Every voice route is person-only.** The stream (`voice` / `use`) and every mutation — install,
  remove, threads, caps, the `voice.yaml` engine block (`voice` / `configure`) — is `operator` with
  **`caller: 'person'`**. A ferret's own session credential (and the warden's) is ungoverned by grants,
  so a capability demand alone would let a ferret install a native runtime or stream audio by simply not
  being a grant caller; `caller: 'person'` refuses it `403 owner_only`. B1 tests the session and warden
  refusals. A `configure` act needs a passkey step-up from a governed device, as every `configure`
  demand does (`demandNeedsStepUp`).
- **The voice-chat send is not a new power.** Today's `POST /v1/ferrets/:ferretId/send` is
  `operator`, `caller: 'any'`, no capability. The daemon-side send goes through the same send service,
  as the device that opened the stream, re-checking at that moment that the device is still paired and
  holds `voice.use` (§1.5).
- **Who is governed is unchanged** (`docs/grants.md` › A browser on the host is an ordinary device):
  **every browser is a governed device, on the host too.** Only the host's admin token over a loopback
  peer is ungoverned (`arrivedOnHost`, `packages/daemon/src/lib/api/http.ts`) — a loopback peer alone
  proves nothing, because `ssh -L`, `cloudflared` or `tailscale serve` arrive from loopback too. A
  relayed or WebRTC caller is remote whatever address it came from (§16 › Authority). B3 tests a
  forwarded-loopback browser against `voice.use`. Narrowing `voice` on a device closes its open streams
  at once.
- **Existing devices start with `voice` OFF** — the closed-set rule every new capability follows (a
  record written before a capability existed reads it as off, `StatePairingRepository`). Whether to
  widen them once, as Sharing did, is **D5**.
- **Adding `voice` must not break Sharing's repair.** `sharing-follows-pairing.ts` asks that **every
  capability except Sharing** be fully on, computed from today's `DAEMON_CAPABILITIES`. Once `voice`
  exists (and is off), a device upgrading straight from before Sharing would fail that test, and a
  voice repair that required Sharing would fail too, so neither would fire. B1 therefore **pins
  Sharing's predicate to the seven capabilities that existed before it**, runs the Sharing repair
  before any voice repair, and adds an upgrade test from a pre-Sharing `devices.json` straight to a
  build with `voice`.

### 4.2 The privacy promise, reworded

`docs/voice.md` today says **"Ferretry never sends microphone audio to your daemon."** That sentence is
replaced, and the UI follows the engine:

| Engine              | What the UI says                                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| On this device      | "Audio never leaves this device." (unchanged)                                                                                                 |
| On my machine       | "Your audio goes only to **<machine name>**, encrypted end to end — even through Ferretry's relay, which cannot hear it. It is never stored." |
| Phone/browser voice | "Your audio goes to Google/Apple to be transcribed." (unchanged)                                                                              |

Voice chat shows the "On my machine" sentence the first time it is opened on a device.

### 4.3 No audio stored, by default and by construction

- The worker keeps audio **only in memory, only for the turn in progress** (chunking needs the
  uncommitted tail), and drops it when the turn ends or the stream closes.
- No audio and no words are written to the daemon's logs, journal or audit. The audit records that a
  voice stream was opened, by which device, for how long — never what was said.
- The **transcription log stays on the device** (`lib/stt/transcription-log*.ts`, IndexedDB, no
  audio): the daemon returns text and the browser logs it as it does today.
- There is no "keep audio for debugging" switch. If one is ever wanted it is a separate, explicit owner
  decision.

---

## 5. How a ferret speaks: `<say>`

### 5.1 The tag

```text
<say>Let me check the failing test.</say>
…tool calls…
<say>Fixed it: the clock was read twice. The test passes; I pushed to the PR.</say>
```

- **First, always, before any tool call:** one short line acknowledging the ask ("Let me check.",
  "On it — looking at the logs.").
- **Last:** 1–3 plain spoken sentences: the answer, or what the ferret needs from the person. No code,
  paths, hashes, tables or lists inside `<say>` — those stay in the written reply, where `speakable.ts`
  already describes them.

`<say>` is proposed over `<voice>` (D4): it is a verb, so the model reads it as "say this", and "voice"
already names the feature, the settings page and the grant.

**One grammar, one owner.** The parser lives in `@ferretry/protocol` (`voice-say.ts`, pure and total),
used by the PWA's chat renderer and reply picker and by the CLI's transcript printing. The chat renders a
`<say>` block as a quiet speaker-icon line, not as raw tags; text inside cannot close the block.

### 5.2 Teaching it — the fixed layer

A new **per-ferret section** of the appended system prompt, `voice`
(`packages/fleet/src/lib/account/fixed-layer.ts` › `FERRET_SECTIONS`, switched by `FY_VOICE`, on by
default), worded for both harnesses (Claude's `--append-system-prompt`, Codex's
`developer_instructions`). About 60 tokens:

> Voice chat: a message that begins `(voice)` was spoken. Reply first with `<say>one short line, e.g.
Let me check.</say>` before any tool call; end with `<say>1–3 plain sentences: the answer or what you
need</say>`. No code, paths, lists or IDs inside `<say>`. Write everything else as usual.

- **The `(voice)` marker** is a plain ASCII prefix the daemon's delivery adds when it types a
  `origin: 'voice-chat'` message into the composer. ASCII, because emoji are a known hazard when typing
  into a terminal composer. The chat shows a mic chip instead of the marker.
- **A running ferret launched before the section existed** does not have it: a launch's system prompt is
  fixed. The daemon knows which sections a session was launched with (`SessionLaunchInstructions`), so
  the **first** voice-chat message to such a ferret carries the teaching inline, once. Every later one
  carries only the marker.
- **Tokens are spent only where used:** the reply style appears only in voice-chat turns; typed chats
  are unchanged.

### 5.3 What voice chat reads, and the fallback

| What arrives                                     | What is read                                                                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| a `<say>` in the turn's **first** assistant text | read **at once**, while the ferret works (mic stays closed; the panel shows "Working")                                             |
| a `<say>` in the turn's **last** assistant text  | read at turn end, then listen again                                                                                                |
| no `<say>` at all                                | the &F137 reply picker: the last assistant text of the turn, through `speakable.ts` (code/tables/pictures described, ~60 s cap)    |
| no acknowledgement within 4 s of the send        | the "sent" earcon only — **no invented words**. The panel counts "replies without a spoken line" so a teaching failure is visible. |
| `needs-input`                                    | unchanged: the question and options are read, voice chat stops at the normal prompt UI                                             |

**Claude and Codex: what is promised, and what is measured.**

- **The ferret writes the acknowledgement first.** Both harnesses record assistant text in the
  transcript: Claude as a text block of the assistant message, Codex as an assistant `message` response
  item. The teaching makes the `<say>` line the first thing in the turn, before the first tool call.
- **The person hears it early.** The daemon does not see a harness's execution; it observes transcript
  files through file events and polls (`packages/daemon/src/adapters/transcript/file-source.ts`), so the
  acknowledgement reaches the browser some time after it was written, and the first tool may already be
  running. The honest promise is **"heard early in the turn, usually while the first tool runs"** — not
  "before any tool runs".

Slice A3 makes the second a **measured gate** for each harness: a real Claude and a real Codex ferret,
twenty voice-chat turns that need a tool, recording the time from send to the acknowledgement on the
event stream and to the first tool result. The gate: the acknowledgement arrives before the first tool
result in at least 90 % of turns. If a harness misses it, the 4 s earcon is what the person gets, and A3
says so in `docs/voice.md` rather than claiming more.

---

## 6. Faster on this device: the opt-in

### 6.1 What it is, and the warning

Only for **dictation on this device**. Two independent parts, each shown only when this device can use
it:

| Part              | What it needs                                                                                                                                                                               | What it breaks                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Several cores** | cross-origin isolation for **this device** (§6.2), and enough memory (`speed-plan.ts` refuses threads at a known ≤ 4 GB; an unknown figure on a touch-first device is refused too, from C2) | **Outside videos and audio in chat stop loading** (a host that sends no `Cross-Origin-Resource-Policy`), and the sandboxed blocks (Mermaid, Lottie, interactive `html`) until they are re-proved under isolation. |
| **GPU**           | WebGPU with an adapter; the WebGPU engine file (27,084,114 bytes) **fetched from the model CDN** on opt-in (it is over Cloudflare Pages' 25 MiB limit); fp16 or fp32 model files            | **Nothing in the page.** WebGPU needs no isolation. The cost is the download: Parakeet's fp32 encoder is about 2.5 GB (`docs/voice.md`); an fp16 export would be about half, and must be found or made.           |

The switch's own words, before it is turned on: _"Several cores makes on-device dictation about 2–3×
faster on a desktop we tested. While it is on, videos and audio from other websites won't play in
chats on this device. You can turn it off at any time."_ The 2–3× is the measured figure
(`docs/voice.md` › Speed: Parakeet 1.76 s → 0.65 s, Whisper 3.22 s → 1.34 s). **Map tiles do not need to
break**: OpenStreetMap already answers with `Access-Control-Allow-Origin: *`, so slice C1 gives the tile
layer `crossOrigin` and maps keep working under isolation.

**"Why not embed Google Maps instead?"** It would not help, and it adds costs: a Google Maps embed is a
third-party iframe, which the page's CSP refuses today (no `frame-src`), and under isolation a framed
page must itself opt in with COEP or CORP — not something Google's embed is known to send (unverified),
and the milder `credentialless` iframe Safari lacks. It also needs an API key and tells Google every map
a chat shows. The OpenStreetMap fix above keeps maps working without any of that.

### 6.2 Per-device isolation when headers are site-wide

Isolation is two response headers, `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, and `public/_headers` applies them to everyone. Three ways
to make it **this device only**:

| Way                                                                                                                                                                                                                                                                                           | Good                                                                                                                                                                | Bad                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) The app's own signed service worker adds the two headers for this device** (recommended, D6). It already rebuilds every response with the `_headers` rules (`src/worker/service-worker.ts`, `__FY_RELEASE_HEADERS__`); a device flag in its own storage adds two more, then one reload. | No second service worker, no new URL, same origin and storage (pairing keys untouched), off is one switch and a reload; the flag can only make the page _stricter_. | The first load after install or after site data is cleared is not isolated until the worker controls the page (one reload, said on screen). Needs proof per browser (below). |
| (b) An isolated path (`/fast/*` with its own `_headers` rule)                                                                                                                                                                                                                                 | Plain server headers; no service-worker logic                                                                                                                       | Every in-app link and the installed app's start URL must stay under the prefix; deep links and shared links split in two.                                                    |
| (c) An isolated subdomain                                                                                                                                                                                                                                                                     | Cleanest headers                                                                                                                                                    | **A different origin: different storage**, so the device's non-extractable pairing key is not there — the device must pair again. Not proposed.                              |

`coi-serviceworker` is still not the answer (`docs/voice.md` › Speed): it is a second service worker
beside the signed one. Option (a) is the same idea done inside the worker that already exists.

**Safari and iPhone.** Safari supports `require-corp` isolation but not `credentialless`
(`docs/voice.md`), so on Safari the "outside videos and audio" warning is fully true. Whether Safari
honours COOP/COEP on a navigation response **its service worker constructed** is **not proved**; C2's
Safari harness run decides it, and if Safari does not, "Several cores" is simply not offered there.
**Memory on Safari is unknown, not small.** Safari does not expose `navigator.deviceMemory`;
`speed-signals.ts` reads that as `null`, and `speed-plan.ts` refuses threads only for a KNOWN value at
or below 4 GB — so today an isolated iPhone would be planned at 2–4 threads. Parakeet 0.6B already takes
about 1 GB on one thread, and threads add buffers, so C2 adds a conservative rule: **unknown memory on a
touch-first device gets no threads** unless the harness measures that model at that thread count on a
real iPhone. On an iPhone the realistic speed-ups are therefore **the GPU part** (WebGPU, if the Safari in
use offers an adapter — unmeasured here) or **dictation on my machine**, which needs neither.

---

## 7. How this fits the running &F137 slices

| Slice                                 | State (2026-11-05)      | Under this plan                                                                                                                                                                                                     |
| ------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| s1 Read aloud (#1488)                 | in review               | **Stays.** `speakable.ts` is the fallback reader.                                                                                                                                                                   |
| s2 Auto-read (#1491)                  | in review               | **Stays.** Its reply picker learns to prefer `<say>` (A2).                                                                                                                                                          |
| s3 Turn endpointer (#1489)            | merged                  | **Stays**, and **moves** to `@ferretry/protocol` with `energy.ts` (B0) so the daemon runs the same rules for voice chat.                                                                                            |
| s3b Speed / `beginFinish()` (#1495)   | merged                  | **Stays** for dictation on this device. Its isolation question (!A411) becomes the per-device opt-in (§6), not a site-wide switch.                                                                                  |
| s3c Test-speed link (#1499)           | in review               | Stays; it belongs beside the Faster on this device switch.                                                                                                                                                          |
| s4 Live loop (#1497)                  | in review               | **Merge it.** Its panel, countdown, keys, Web Lock, wake lock and machine are what voice chat needs. Its **on-device take path** is replaced by the daemon stream in B5; until then the button is labelled preview. |
| s5 Live reads aloud (#1501)           | in review               | **Stays.** Reading learns `<say>` and the early acknowledgement (A2).                                                                                                                                               |
| s6 Settings + docs                    | not started             | **Becomes A1**: the two settings groups.                                                                                                                                                                            |
| Near-live "Live words (experimental)" | shipped, off by default | **Retired by A4**: "In real time · Chunked" is the finished version.                                                                                                                                                |

**Nothing needs stopping.** Avoid starting more on-device work for voice chat (a browser VAD, more Live
loop engines): voice chat is moving to the machine.

---

## 8. Slices

Each is one PR. Phase A needs no machine engine and can start now; B builds the machine engine and
voice chat on it; C is the on-device speed opt-in and is independent of B.

### Phase A — settings, `<say>` and real-time dictation (cards &F1268, &F1269)

| #      | Outcome (one line)                                                                                                                                                         | How the owner tries it                                                                                               |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **A1** | Settings › Voice has the two groups, Dictation and Voice chat; the Live button is **Voice chat (preview)**.                                                                | Open Settings › Voice: two groups, each explained in one line.                                                       |
| **A2** | `<say>` is parsed (protocol), shown as a speaker line in chat, and read — the early ack at once, the summary at the end — with the fallback.                               | A test ferret's reply with `<say>`: the chat shows a speaker line, and voice chat reads only that.                   |
| **A3** | The fixed layer teaches `<say>` (`FY_VOICE`); voice-chat messages carry `(voice)`; old ferrets get it inline once; the measured early-ack gate for Claude and Codex.       | Voice chat a ferret "what's in the README?": you hear "Let me check." early, usually while it reads, then a summary. |
| **A4** | Dictation "In real time" on this device: streaming (Vosk, browser voice) or chunked (Parakeet, Whisper, sherpa) into the draft; Fix on Stop with Undo; old switch retired. | Pick In real time, talk: words appear in the composer as you pause. Nothing is sent.                                 |

### Phase B — the machine engine and voice chat (cards &F1269, &F1268)

| #      | Outcome (one line)                                                                                                                                                                                                                                                     | How the owner tries it                                                                                                                                      |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B0** | The endpointer, energy math and Live machine move to `@ferretry/protocol`; no behaviour change.                                                                                                                                                                        | Nothing visible.                                                                                                                                            |
| **B1** | The `voice` capability (person-only routes, Sharing's predicate pinned, upgrade test), `voice.yaml` engine block, **Install on my machine** (pinned, hashed, resumable), `fy voice status`, `fyd --check` voice line.                                                  | Settings › Voice › On my machine › Install. `fy voice status` says installed, with sizes.                                                                   |
| **B2** | The worker: `fyd voice-worker`, sherpa from the install dir, C threads, `<product>_voice.slice` (Linux) / best effort elsewhere, idle exit, contention and over-memory tests, Silero trial; `fy voice test <file.wav>`; numbers on Linux x64, arm64 and Apple Silicon. | `fy voice test clip.wav` prints the words and the time. `systemctl --user status <product>_voice.slice` shows the caps while it runs.                       |
| **B3** | `/v1/voice/stream` (fixed-shape units, bounds) and **dictation on my machine, after stop**; relay §10 and the privacy wording updated; forwarded-loopback test.                                                                                                        | On the phone over the relay, pick On my machine, dictate, Stop: the review box shows the words.                                                             |
| **B4** | **Dictation on my machine, in real time** (chunked Parakeet; streaming Zipformer if installed).                                                                                                                                                                        | In real time with On my machine: words appear as you pause, as fast on the phone as on the desktop.                                                         |
| **B5** | **Voice chat on the machine**: the panel replaces the composer; the daemon endpoints, counts down and sends (nonce freshness, stable send id); §1.4's states; the on-device take path removed from voice chat; "preview" dropped.                                      | Voice chat: talk, watch the countdown, hear the reply. Airplane mode early in a countdown: nothing is sent, and the words are offered back when you reopen. |
| B6     | Constant-bitrate Opus uplink where WebCodecs has it (about 7× less uplink).                                                                                                                                                                                            | Settings › Machine › Performance shows the voice stream's bytes per minute drop.                                                                            |
| B7     | Optional machine GPU (CUDA / CoreML), only if B2's numbers say it matters.                                                                                                                                                                                             | —                                                                                                                                                           |

### Phase C — Faster on this device (card &F1269)

| #      | Outcome (one line)                                                                                                                                                      | How the owner tries it                                                                                                            |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **C1** | Isolation-ready page: map tiles get `crossOrigin`; the sandbox frames get COEP and are re-proved; outside media shows a link instead of a broken player when isolated.  | Nothing changes for anyone yet; a map renders under a dev isolated build.                                                         |
| **C2** | **Several cores**, per device: the signed service worker adds COOP/COEP for an opted-in device after one reload; the warning; the Safari harness decides Safari.        | Settings › Voice › Faster on this device › Several cores → reload: the speed line says "fast (several cores)". Turn off → normal. |
| **C3** | **GPU**, per device: the WebGPU engine file fetched from the model CDN on opt-in (pinned, hashed), fp16/fp32 models, the existing WebGPU-first worker path switched on. | On a desktop with a GPU: turn on GPU, accept the download, dictate: the timing line names WebGPU.                                 |

B6, B7 and C3 are optional; the plan is complete at B5 plus C2.

---

## 9. Declared gaps and risks

- **NixOS** cannot load the downloaded Linux prebuilds without `nix-ld` or a Nix-built sherpa-onnx (§2.3).
- **CPU and memory caps are hard only on Linux with a working user manager.** Elsewhere: thread count,
  nice and a watchdog — best effort, and said so in Settings and `fyd --check`.
- **iOS** keeps the &F137 limits: no background mic, half-duplex, Listen tap after each reply.
- **Babble** (café, TV) still fails the loudness endpointer, on device and on the machine; Silero is a
  trial for café clatter only.
- **Traffic shape:** the voice stream is fixed-shape, but a voice-chat send and its reply move the
  ordinary event stream, so a relay can see roughly when turns are sent (§3.4).
- **The early acknowledgement** is heard "usually while the first tool runs", not before it (§5.3).
- **Freshness window:** a phone that dies within about the last second of a countdown can still send
  words that were on screen (§1.5).
- **Safari isolation via a service worker** is unproved until C2's harness (§6.2).
- **Every number marked approximate is unmeasured here.** B2 publishes the real ones before B3 relies on
  them.

---

## 10. Owner decisions

Short. Each has a recommendation; none is decided by this plan.

**D1 — Which speech models go on your machine?**

- (a) **Parakeet v3 (487 MB) for everything; a small streaming model only if you pick "Streaming" for dictation.** ← **recommended**: one accurate model does voice chat and most dictation; the streaming one is there for whoever wants words mid-sentence.
- (b) Parakeet only; real-time dictation is always chunked.

**D2 — How does the engine get onto your machine?**

- (a) **Downloaded when you press Install** (pinned and checked). ← **recommended**: only people who use it pay for it; `fyd` gains a little code, no model and no native library.
- (b) Built into every `fyd` release (bigger for everyone, and needs a custom static build).

**D3 — When the machine is busy, who gets the CPU?**

- (a) **Your ferrets.** Voice gets a smaller share under load (a weight on its slice), so voice chat may lag during heavy builds; it is limited to C cores (2 on a laptop, 4 on the big box) either way. ← **recommended**: matches "don't affect the main agent".
- (b) Your voice. Builds slow slightly while you talk.

**D4 — What do ferrets write for the spoken part?**

- (a) **`<say>…</say>`** ← **recommended**: reads as "say this"; no clash with the "voice" feature name.
- (b) `<voice>…</voice>`.

**D5 — Should devices you already paired get `voice` turned on?**

- (a) **Yes, once, only for devices that already hold every other capability** (the same one-time, journalled repair Sharing got; a device anyone restricted by hand is left alone). ← **recommended**: your phone works on day one; restricted devices stay restricted.
- (b) No: each device starts off; turn it on in Settings › Devices or with `fy device grant <device> voice --use`.

**D6 — How does "Several cores" switch on for just one device?**

- (a) **The app's own service worker adds the headers for that device, after one reload.** ← **recommended**: same address, same pairing, one switch to undo.
- (b) A separate `/fast/` part of the site (links and the installed app's start page must stay inside it).
