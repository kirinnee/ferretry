# Voice modes and the daemon speech engine

Status: **plan, not built.** Nothing in this document is implemented by the change that adds it. It
plans two cards: **&F1268 Live Chat Voice Mode** and **&F1269 Daemon Streams Voice Engine**, on top of
the &F137 live-voice slices already merged or in review. Section 9 lists the choices only the owner
makes; everything else here is a proposal a slice may correct when it measures something.

The owner's words (2026-11-05, !A410), verbatim:

> _"allow for on-device, or stream from daemon, which opens up the possibility of US just RTC-ing voice
> to a livestream model in the daemon, which injects "send" for us, so there's nothing that happens here
> (for live-chat mode). for non-livechat mode, the transcription will have to return back to the
> browser, for injection. even for "real-time transcription"_
> _so there are couple of modes: 1. transcribe 2. live-transcribe 3. live-chat_
> _live chat can be triggered by a button, which the conversation just stops using the composer, and
> goes into live-chat mode, and the ferret agents will need to inject <voice> or wtv output, to
> summarioze what needs to be replied to the user concisely, and make them always reply something FIRST
> then do some tasks. like say "like me check" or something."_

Carried over from !A395 and the &F137 slices, and **not reopened here**: auto-send after a **1.5 s
countdown** with **Hold** / **Send now**; read **only the last message**, describe code, tables and
pictures, stop after **~60 s**; interrupt **by tap or key only**, **mic off while reading**; **free device
voices** only; clean-up **Fix** style only in Live. And: _"use multiple GPU and CPU ... and how to let it
not affect the main agent"_.

Paths are relative to the repository root. "Measured" means a number from a run cited here; everything
else is an estimate and says so.

---

## 0. The plan in one screen

1. **Three modes, one mic.** **Transcribe** (today's dictation: speak, stop, review, Insert),
   **Live transcribe** (words land in the composer while you speak; you press Send), **Live chat** (the
   composer is replaced by a hands-free panel; turns are sent for you after the countdown; the ferret
   answers in short speech).
2. **Two engine locations, chosen per device as today.** The existing on-device engines stay. A new
   engine, **"On my machine"**, runs on the daemon. Neither is a fallback for the other — the rule
   `docs/voice.md` already states.
3. **Text goes back to the browser** in Transcribe and Live transcribe, whichever engine runs — the
   browser puts it in the draft, as the owner said. **In Live chat on the machine's engine, the daemon
   presses send itself**: the browser only carries the microphone, the countdown and the buttons.
4. **Transport: audio frames inside the existing end-to-end session**, as a new §14 stream session
   (`/v1/voice/stream`) — **not** a WebRTC media track. It works on every carrier (direct, relay, the
   WebRTC data channel), keeps every byte sealed end to end, and loses no audio. Section 4 says why
   RTP was rejected.
5. **The daemon engine is a separate worker process**, never the daemon itself: native sherpa-onnx with
   a fixed thread count, inside its own capped systemd scope on Linux (a sibling of the I36 fleet
   slice, built from the same `lib/cgroups` code), and niced with a memory watchdog on macOS. It
   loads on the first voice stream and unloads when idle.
6. **A new grant capability, `voice`** (use: stream audio to this machine; configure: install, remove
   and tune the engine). Relayed and WebRTC callers are remote, as always. The privacy promise changes
   from "never to your daemon" to **"only to your own machine, encrypted end to end; never stored"**.
7. **Ferrets learn one tag, `<say>`** (name is decision D4): a one-line acknowledgement **before any
   tool call** ("Let me check.") and a 1–3 sentence spoken summary at the end. The PWA speaks only
   `<say>` text in Live chat and falls back to the &F137 reply picker when a ferret does not emit it.
8. **Nothing in flight is stopped.** &F137 slices 1–5 merge as they are. The pure voice logic moves to
   `@ferretry/protocol` so the daemon runs the same rules. Browser cross-origin isolation (!A411) is
   worth parking until the daemon engine is measured.

---

## 1. The three modes

### 1.1 What the person sees

| Mode                | Started by                                                                                                     | While speaking                                                                                                        | When the turn ends                                                                                                                                    | Who presses Send                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Transcribe**      | the mic button or push-to-talk (unchanged)                                                                     | the strip shows the level bars; live words only where the engine has them                                             | **Stop** → review box → **Insert** (or Insert straight away, per device). Never sends.                                                                | **The person**, in the composer                                                     |
| **Live transcribe** | the mic button's menu: **Live transcribe** (and its own shortcut)                                              | interim words greyed in the strip; **committed words go straight into the draft at the caret**, at each pause         | **Stop**: the tail is committed; one optional **Fix** pass over the dictated span, with **Undo**. Never sends.                                        | **The person**, in the composer                                                     |
| **Live chat**       | a **Live chat** button beside the composer (today's &F137 "Live" button, renamed); palette entry **Live chat** | **the composer is gone**: a Live panel shows the level, the words of this turn, and **Hold** / **Send now** / **End** | pause 1.5 s → visible 1.5 s countdown → sent; the ferret's `<say>` acknowledgement is read; at turn end its `<say>` summary is read; it listens again | **Nobody** — the browser (on-device engine) or the daemon (machine engine) sends it |

Live chat keeps every &F137 rule: the words are on screen at least 500 ms before an automatic send,
speech during the countdown cancels it, the mic is closed while reading, Space / Esc / S / R / H / Enter
work as slice 4 and 5 define, needs-input questions are read and then Live stops at the normal prompt
UI, and nothing is ever approved by voice.

**What replaces the composer.** In Live chat the composer's text box, attachments and send button are
hidden, and the Live panel takes their place in the same slot: phone — one 96 px button (Listening /
Hold / Stop reading), the turn's words above it, **End** on the side; desktop — a strip the composer's
height. The draft the person had is kept untouched and comes back on **End**. Leaving the page, hiding
the tab past the pause rule, or another tab taking the Web Lock ends Live chat the way slice 4 already
does.

### 1.2 Where the audio and the text go

| Mode            | Engine on this device                                                                                                    | Engine on my machine                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transcribe      | Audio stays in the browser (Parakeet, Whisper, Vosk) or goes to the browser vendor (Phone/browser voice). Text: browser. | Audio streams to the daemon **while you speak** (so decoding overlaps speaking); on Stop the daemon answers the final text **to the browser**, which shows the review box. Nothing reaches the draft without Insert. |
| Live transcribe | Streaming engines only: Vosk, Phone/browser voice, Parakeet near-live. Committed words go into the draft.                | Audio streams to the daemon; it sends back `interim` and `committed` words; **the browser** puts committed words in the draft.                                                                                       |
| Live chat       | The browser endpoints, transcribes, counts down and sends through the composer's own `submit()` (slice 4 as built).      | The browser streams audio and shows state. **The daemon** endpoints, transcribes, runs the countdown, and sends through its own send service. The browser never holds the words it sends.                            |

Read-aloud is **always on the device** (free device voices, owner rule): the reply arrives through the
ordinary session event stream in every row, so neither engine location changes how a reply is read.

Clean-up keeps its two paths (`docs/voice.md` › Clean-up). One addition: with the machine engine and a
**machine** key, the daemon may run Fix itself before answering, which saves a round trip. A device-held
key is never sent to the daemon, so with a device key the browser still calls the provider.

### 1.3 Live chat on the machine engine, step by step

```
browser                                  daemon (voice stream)                   ferret
 │ open /v1/voice/stream {mode: live-chat, sessionId}
 │ ── PCM frames, constant rate ───────▶ endpointer + STT (worker)
 │ ◀── state: listening / interim words
 │                                       pause held 1.5 s → final words
 │ ◀── countdown {words, sendAt}
 │ ── shown {turnId} ─────────────────▶  (words are on screen: the 500 ms rule can start)
 │    [Hold] → hold {turnId} ──────────▶ countdown cancelled, words kept
 │                                       countdown ends → send service ─────────▶ message typed
 │ ◀── sent {sendId}                                                              <say>Let me check.</say>
 │ ◀── (session event stream) assistant text with <say> → read aloud, mic closed
 │                                       ...turn ends → <say> summary read → listen again
```

- **The daemon sends only after the browser said `shown`** for that turn and the 500 ms has passed. A
  stream that drops during the countdown **cancels the send** and keeps the words for the next stream —
  a dropped phone never sends words nobody saw.
- **The send is an ordinary send**: the same send ledger, the same audit, the same delivery path as
  `POST /v1/sessions/:sessionId/send`, attributed to the device that opened the stream, with
  `origin: 'live-chat'`. It is no more than that device could have sent by pressing Send.
- **Mic off while reading** still holds: the browser stops sending frames while it reads (it sends
  `muted`), and the daemon's endpointer pauses. Interrupt is tap or key, as today.
- **One live-chat stream per ferret.** A second device that opens one for the same session is refused
  `409 voice_busy` naming the device that holds it — the machine-wide twin of slice 4's Web Lock.

---

## 2. The daemon engine

### 2.1 Prior art in this repository

The daemon had a speech engine once: `bin/stt-worker.ts`, a Bun worker spawner, a sherpa-onnx
recognizer loaded as `sherpa-onnx-node`, a model store with hashed resumable downloads and an audio
decoder. #273 (`ac6b8a35a`) removed it when dictation moved to the browser. Its shape was right — **the
native addon and the model live only in a child process, so a decode cannot block the daemon's event
loop and a native crash cannot take the daemon down** — and slice B2 starts from `ac6b8a35a^`. What it
lacked: it loaded the addon from `node_modules` (absent in a compiled `fyd`), it was batch only, and it
ran uncapped.

### 2.2 Which model

| Candidate                                        | Streaming?                                                                                                    | Accuracy (published / measured here)                                                             | Disk (approx.)                 | Memory (approx.) | Languages    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------ | ---------------- | ------------ |
| **Parakeet TDT 0.6B v3, int8** (sherpa-onnx)     | No — near-live: re-decode windows that start in a pause, LocalAgreement-2 (the browser's `near-live.ts` rule) | the most accurate measured in this app (`research-numbers.ts`)                                   | ~460–480 MB archive¹           | ~1 GB            | multilingual |
| Parakeet TDT 0.6B v2, int8                       | No (same)                                                                                                     | similar; English only                                                                            | ~460 MB archive (kteam's)      | ~1 GB            | English      |
| Streaming Zipformer (sherpa-onnx, English, int8) | **Yes**, true streaming with built-in endpoint rules                                                          | lower; the 20M variant dropped the first second of 26 of 33 utterances through this app's worker | tens of MB (size per variant¹) | ~100–300 MB      | English      |
| whisper.cpp base.en / small.en                   | No                                                                                                            | good; hallucinates on silence without a VAD                                                      | 140–470 MB                     | ~0.3–1 GB        | per model    |
| Silero VAD (sherpa-onnx)                         | n/a — speech/no-speech                                                                                        | fixes the café/TV babble gap the loudness endpointer has                                         | ~2 MB                          | small            | any          |

¹ Not measured in this repository; B2 measures and pins exact sizes and hashes.

**Proposal (decision D1):** Parakeet TDT 0.6B v3 int8 as the machine engine, run near-live, plus
Silero VAD as the speech detector the endpointer lacks in babble. Reason: it is the model the browser
already ships and measured best, it is multilingual, and the expensive part of near-live — a full
re-decode every pass — is what a native multi-threaded runtime is good at. The browser runs it on **one
WebAssembly thread** (1.76 s for 5 s of speech, measured, `docs/voice.md` › Speed); native ONNX Runtime
uses SIMD and several threads, so passes every ~0.5 s should be affordable (B2 measures it). A true
streaming Zipformer stays an option for very small machines, not the default, because of the
dropped-first-second result.

whisper.cpp is not proposed: a second runtime (ggml) beside ONNX Runtime doubles the native surface for
no accuracy gain over Parakeet.

### 2.3 How the native code gets onto the machine

`fyd` is one compiled Bun executable per target (linux-x64, linux-arm64, darwin-arm64).
`node-datachannel` is embedded in it because its prebuild is a single `.node` linking only libc
(`docs/relay-protocol.md` §16 › The engine). **sherpa-onnx is not like that**: its Node addon links
`libsherpa-onnx-c-api` and `libonnxruntime` as sibling shared libraries, and a Bun-embedded `.node` is
extracted alone, so the siblings would not be found without a custom static build (expected from the
package layout; B1 verifies).

**Proposal (decision D2): download the native runtime on Install, like the model.** Settings ›
Voice › **Install on my machine** (or `fy voice install`) fetches, at pinned versions and SHA-256s, one
archive per target holding the addon and its libraries, plus the model, into the state home
(`voice/runtime/<version>/`, `voice/models/<id>/`). Resumable, verified on arrival and again when the
worker loads them, removable — the same rules the browser's Install follows. `fyd` grows by nothing and
nobody who never uses the machine engine downloads anything. The worker loads the addon by absolute
path (`process.dlopen`).

- **Nix.** The flake's `fyd` is unchanged. The downloaded Linux prebuilds link glibc and libstdc++
  dynamically, which runs on a normal distribution and under Nix on one, but **not on NixOS** without
  `nix-ld` or a Nix-built sherpa-onnx. B1 checks for a nixpkgs `sherpa-onnx`; if it exists, `voice.yaml`
  may point `engine.runtimePath` at it and the download is skipped. Until then NixOS is a declared gap.
- **macOS.** `fyd` is not code-signed with library validation today (no `codesign` step in
  `scripts/release`), so loading downloaded dylibs is allowed; a file this process downloads carries no
  quarantine attribute. B2 proves it on an Apple Silicon runner; if `fyd` is ever signed with the
  hardened runtime, this needs the `disable-library-validation` entitlement.
- **`fyd --check`** gets a `voice` line: not installed / installed, version, last self-test (decode one
  bundled synthetic clip), like the `webrtc` line.

### 2.4 CPU, GPU and memory

- **CPU, Linux x64 and arm64, macOS arm64:** ONNX Runtime's CPU provider, int8, SIMD (AVX2/AVX-512 on
  x64, NEON on arm64), `numThreads` from configuration. This is where "use multiple CPU" is answered:
  the daemon has no cross-origin-isolation problem, so threads are free.
- **GPU: not in v1.** CUDA needs `onnxruntime-gpu` plus CUDA and cuDNN libraries (well over a gigabyte,
  driver-matched); CoreML on macOS is supported by sherpa-onnx for some models but is unproven for
  Parakeet's int8 graph. A Parakeet decode on a modern CPU is expected to be a small fraction of real
  time already (B2 measures it), so the GPU buys little for one speaker. Slice B7 makes it an opt-in if
  measurements say it matters.
- **Memory:** ~1 GB while loaded (Parakeet). The worker loads on the first voice stream — warm-up
  begins the moment Live chat or the mic opens, so loading overlaps speaking — and **exits after 10
  minutes with no stream**, which frees all of it, as the WebRTC engine already hands its threads back
  when idle.

### 2.5 Never starving the agents or the daemon (ties to &I36)

The daemon already places agents in cgroups (`packages/daemon/src/lib/cgroups/`, I36): a transient
systemd **user** scope per agent under `<product>-fleet.slice`, with `CPUQuota` and `MemoryMax`
computed as shares of the whole host (`limits.ts`), and the daemon itself in `app.slice`, never capped.
The voice worker joins that layout as a **sibling** slice, built by the same `scope.ts` / `limits.ts`
code so there is one owner of the unit format:

```text
user@UID.service
├── app.slice/…                         the daemon — never capped
├── <product>-fleet.slice               agents (I36)
│   └── <product>-agent-<id>-<n>.scope
└── <product>-voice.slice               the speech worker
    └── <product>-voice-<n>.scope       CPUQuota = threads × 100 %, MemoryMax = 1.5 GB, CPUWeight per D3
```

Three independent caps, so no single failure starves anything:

1. **Threads.** `numThreads` defaults to `min(4, max(1, floor(cores / 4)))` — 2 on an 8-core laptop, 4
   on the 32-core box. The worker can never use more cores than that, on any platform.
2. **Linux cgroup** (when `cgroupsSupported` — unified hierarchy and a user manager): a hard `CPUQuota`
   equal to the thread count, a `MemoryMax`, and a `CPUWeight` that decides who wins under contention
   (D3). A worker over its memory is killed by the kernel; the daemon sees the exit, says so on the
   stream, and the next stream starts a fresh worker.
3. **Everywhere else** (macOS, Linux without a user manager): `setpriority` nice +5 on the worker and
   an RSS watchdog in the daemon that stops a worker over the memory cap. macOS's `taskpolicy -b`
   (background) is not used: it throttles far below real time.

The daemon's own event loop never runs a decode: audio crosses to the worker by IPC (Bun's advanced
IPC, `Float32Array` without a JSON copy, as the old worker did) and only text comes back. At most **2
voice streams** at once by default; a third is refused `429 voice_busy`.

---

## 3. Transport

### 3.1 The voice stream

A new route on the daemon's socket table, `/v1/voice/stream`, opened as a **§14 stream session**
(`docs/relay-protocol.md` § Stream sessions) — so it is dispatched through the same route table, the
same capability guard and the same device proof on every carrier, and the rendezvous changes **zero
code**.

- **Uplink:** `bytes` records carrying **PCM, 16 kHz mono, 16-bit**, in **40 ms** chunks (1,280 bytes,
  ~1.7 KB as base64url in a record — far under the 64 KiB frame), sent **at a constant rate for as long
  as the mic is open**, silence included; `text` records for control: `start {mode, sessionId,
engine}`, `shown`, `hold`, `send-now`, `muted`, `unmuted`, `end`.
- **Downlink:** `text` records: `state`, `interim`, `committed`, `final`, `countdown`, `sent`, `error`,
  each **padded to a fixed size bucket** (512 bytes) so a relay cannot read word counts off record
  sizes.
- **Credit:** 25 chunks a second against the §8 window of 32 frames is well inside it; the receiver
  returns credit at half a window as for any session.
- **Bandwidth:** 32 KB/s of PCM, ~45 KB/s on the wire after base64url and framing — **~160 MB an
  hour**. Against the hosted relay's per-daemon ceilings (512 MiB a minute, 20 GiB a day, §13) an hour
  of Live chat is under 1 % of a day. Slice B6 adds **constant-bitrate Opus** (WebCodecs
  `AudioEncoder`, ~24 kbit/s, ~10× smaller) where the browser has it; it must be CBR, because
  variable-bitrate packet sizes are known to leak what was said.

### 3.2 Why not a WebRTC media track

| Question              | Audio frames in the session (proposed)                                                | WebRTC audio track (RTP/Opus)                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Works over the relay? | **Yes**, and direct, and on the WebRTC data channel when that carrier won             | **No.** The rendezvous is a WebSocket; it cannot carry RTP. The default carrier is Relay, which never reaches WebRTC (§16). |
| Needs TURN?           | No                                                                                    | Yes, for any network where ICE fails (§16 has no TURN, on purpose: it would need a credential the config must never hold)   |
| Lost packet           | Retransmitted (reliable session); costs one round trip of delay, **no missing audio** | Concealed: the jitter buffer invents or drops audio — fine for a call, **bad for recognition**                              |
| End-to-end encryption | The session's own AES-256-GCM, keyed by the §6 handshake pinned to the QR fingerprint | DTLS-SRTP, keyed by a fingerprint that travels in the sealed SDP — sound, but a second key system to reason about           |
| Daemon-side cost      | None new: the session already exists                                                  | RTP depacketizing (libdatachannel can) **plus an Opus decoder** (a second native library)                                   |
| Latency               | 40 ms chunking + the carrier's path (one leg on direct/WebRTC, two on relay)          | ~20 ms framing + the path, but only where a peer-to-peer path exists                                                        |

Speech recognition wants every sample more than it wants the last 20 ms. The owner's "RTC-ing voice"
is satisfied in spirit — real-time audio to the machine — and when the WebRTC carrier wins, the voice
stream **does** ride a peer-to-peer UDP path, as one more data channel.

### 3.3 Latency, estimated

- **Interim words:** chunk (40 ms) + one-way path (direct LAN ~5 ms; relay tens of ms; §16 measured a
  60 ms WAN round trip at ~72–76 ms per keystroke) + a near-live pass (target ≤ 300 ms on 2–4 threads,
  B2 measures).
- **Live chat, last word → sent:** pause (1.5 s) + countdown (1.5 s), with the final decode hidden
  inside the countdown exactly as `beginFinish()` hides it in the browser (slice 4 computed ≈ 3.0 s for
  the on-device engines). The machine engine should match it on any phone, because the phone no longer
  decodes.

### 3.4 What a relay can and cannot see

Added to `docs/relay-protocol.md` §10 by slice B3:

- **Can:** that a stream session was opened, when, for how long, and its **constant** byte rate (~45
  KB/s up). Because silence is sent too, it **cannot** tell when you speak or pause. Downlink records
  are size-bucketed, so it cannot count words. It can see that Live chat sent a message, because a send
  produces downlink records and the event stream moves — the same as typing a message.
- **Cannot:** any audio, any word, the session or ferret it is for, or the device.
- **Pairing is untouched:** a voice stream needs a paired device's session; pairing is never relayed
  and never carries voice.

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

- **Live chat's send is not a new power.** The send itself stays what it is today — `operator`, no
  capability, `caller: 'person'` — and is attributed to the device. A device without `voice.use` can
  still use Live chat with an **on-device** engine, because then no audio reaches the machine.
- **Locality, unchanged:** a loopback caller is ungoverned; a **relayed or WebRTC caller is remote**
  whatever address it came from (§16 › Authority). Narrowing `voice` on a device closes its open voice
  streams at once.
- **Existing devices** get `voice` the way they got `sharing`: a device that holds every other
  capability fully on is given `voice` once at boot, recorded in the grant journal; a device that held
  less is never widened.

### 4.2 The privacy promise, reworded

`docs/voice.md` today says **"Ferretry never sends microphone audio to your daemon."** That sentence is
replaced, and the UI follows the engine:

| Active engine       | What the UI says                                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| On this device      | "Audio never leaves this device." (unchanged)                                                                                                 |
| On my machine       | "Your audio goes only to **<machine name>**, encrypted end to end — even through Ferretry's relay, which cannot hear it. It is never stored." |
| Phone/browser voice | "Your audio goes to Google/Apple to be transcribed." (unchanged)                                                                              |

### 4.3 No audio stored, by default and by construction

- The worker keeps audio **only in memory, only for the turn in progress** (near-live needs the
  uncommitted tail), and drops it when the turn ends or the stream closes.
- No audio and no words are written to the daemon's logs, journal or audit. The audit records that a
  voice stream was opened, by which device, for how long — never what was said.
- The **transcription log stays on the device** (`lib/stt/transcription-log*.ts`, IndexedDB, no
  audio): the daemon returns text and the browser logs it as it does today.
- There is no "keep audio for debugging" switch. If one is ever wanted it is a separate, explicit
  owner decision.

---

## 5. How a ferret speaks: `<say>`

### 5.1 The tag

Two kinds of spoken text, both one tag:

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

`<say>` is proposed over `<voice>` (decision D4): it is a verb, so the model reads it as "say this", and
"voice" already names the feature, the settings page and the grant, which makes the tag hard to search
for and talk about.

**One grammar, one owner.** The parser lives in `@ferretry/protocol` (`voice-say.ts`, pure and total),
used by the PWA's chat renderer and reply picker and by the CLI's transcript printing. The chat renders
a `<say>` block as a quiet speaker-icon line, not as raw tags; text inside cannot close the block.

### 5.2 Teaching it — the fixed layer

The teaching is a new **per-ferret section** of the appended system prompt, `voice`
(`packages/fleet/src/lib/account/fixed-layer.ts` › `FERRET_SECTIONS`, switched by `FY_VOICE`, on by
default), worded for both harnesses (Claude's `--append-system-prompt`, Codex's
`developer_instructions`). About 60 tokens:

> Live chat: a message that begins `(voice)` was spoken. Reply first with `<say>one short line, e.g. Let me
check.</say>` before any tool call; end with `<say>1–3 plain sentences: the answer or what you need</say>`.
> No code, paths, lists or IDs inside `<say>`. Write everything else as usual.

- **The `(voice)` marker** is a plain ASCII prefix the daemon's delivery adds when it types a Live chat
  message into the composer (both engine locations, because both sends go through the ledger with
  `origin: 'live-chat'`). ASCII, because emoji are a known hazard when typing into a terminal composer.
  The chat shows a mic chip instead of the marker.
- **A running ferret launched before the section existed** does not have it: a launch's system prompt is
  fixed. The daemon knows which sections a session was launched with (`SessionLaunchInstructions`), so
  the **first** Live chat message to such a ferret carries the teaching inline, once. Every later one
  carries only the marker.
- **Tokens are spent only where used:** the marker and the reply style appear only in Live chat turns;
  ordinary typed chats are unchanged ("let me check" does not start appearing in every written reply).

### 5.3 What the PWA reads, and the fallback

| What arrives                                     | What is read                                                                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| a `<say>` in the turn's **first** assistant text | read **at once**, while the ferret works (mic stays closed; the panel shows "Working")                                             |
| a `<say>` in the turn's **last** assistant text  | read at turn end, then listen again                                                                                                |
| no `<say>` at all                                | the &F137 reply picker: the last assistant text of the turn, through `speakable.ts` (code/tables/pictures described, ~60 s cap)    |
| no acknowledgement within 4 s of the send        | the "sent" earcon only — **no invented words**. The panel counts "replies without a spoken line" so a teaching failure is visible. |
| `needs-input`                                    | unchanged: the question and options are read, Live stops at the normal prompt UI                                                   |

**Claude and Codex both work**, because both write each assistant text into the transcript the daemon
already reads before the next tool call runs: Claude as a text block of the assistant message, Codex as
an assistant `message` response item. Slice A4's contract tests prove the acknowledgement reaches the
event stream **before** the first tool result for each harness; if a harness batches it later, the 4 s
earcon fallback still holds.

---

## 6. How this fits the running &F137 slices

| Slice                                 | State (2026-11-05)      | Under this plan                                                                                                                                                          |
| ------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| s1 Read aloud (#1488)                 | in review               | **Stays.** `speakable.ts` is the fallback reader.                                                                                                                        |
| s2 Auto-read (#1491)                  | in review               | **Stays.** Its reply picker learns to prefer `<say>` (A3).                                                                                                               |
| s3 Turn endpointer (#1489)            | merged                  | **Stays**, and **moves** to `@ferretry/protocol` with `energy.ts` (B0) so the daemon runs the same rules. Silero VAD later sharpens it in babble (B2).                   |
| s3b Speed / `beginFinish()` (#1495)   | merged                  | **Stays.** Isolation (!A411) is worth parking: the machine engine answers "use more CPU" without breaking media, maps and sandbox frames.                                |
| s3c Test-speed link (#1499)           | in review               | Stays.                                                                                                                                                                   |
| s4 Live loop (#1497)                  | in review               | **Stays** as "Live chat on this device". The button is renamed **Live chat** and the bar becomes the composer replacement (A2). Its pure machine moves to protocol (B0). |
| s5 Live reads aloud (#1501)           | in review               | **Stays.** Reading learns `<say>` and the early acknowledgement (A3).                                                                                                    |
| s6 Settings + docs                    | not started             | **Folds into A1**: the Settings › Voice page names the three modes and the engine locations.                                                                             |
| Near-live "Live words (experimental)" | shipped, off by default | **Retired by A5**: Live transcribe is the real version of it.                                                                                                            |

**Nothing needs stopping.** The only thing to avoid starting is more on-device-only speed work (a
browser Silero VAD, the isolation switch) until B2's numbers say whether the machine engine makes it
unnecessary.

---

## 7. Slices

Each is one PR. Phase A works with the on-device engines only and can start now; phase B builds the
machine engine. A and B can run in parallel after A1 and B0.

### Phase A — the modes (card &F1268)

| #      | Outcome (one line)                                                                                                                                        | How the owner tries it                                                                                                        |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **A1** | The mic menu and Settings › Voice name the three modes; the Live button is **Live chat**.                                                                 | Long-press the mic: Transcribe / Live transcribe / Live chat. Settings › Voice explains each in one line.                     |
| **A2** | Live chat replaces the composer with the Live panel; **End** brings the untouched draft back.                                                             | Type a half draft, press Live chat, talk a turn, press End: the draft is still there.                                         |
| **A3** | `<say>` is parsed (protocol), shown as a speaker line in chat, and read in Live chat — the early ack at once, the summary at the end — with the fallback. | Paste a fake reply with `<say>` into a test ferret, or use A4: the ack is read while the ferret works.                        |
| **A4** | The fixed layer teaches `<say>` (`FY_VOICE`); Live chat messages carry `(voice)`; old ferrets get it inline once; contract tests for Claude and Codex.    | Start a ferret, press Live chat, ask "what's in the README?": you hear "Let me check." before it reads files, then a summary. |
| **A5** | Live transcribe on device: committed words go into the draft while you speak; Fix once on Stop with Undo; "Live words" toggle retired.                    | Choose Vosk or Parakeet, pick Live transcribe, talk: words appear in the composer as you pause. Nothing is sent.              |

### Phase B — the machine engine (card &F1269)

| #      | Outcome (one line)                                                                                                                                                                                                          | How the owner tries it                                                                                                                             |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B0** | The endpointer, energy math and Live machine move to `@ferretry/protocol`; no behaviour change.                                                                                                                             | Nothing visible; Live chat works exactly as before.                                                                                                |
| **B1** | The `voice` capability, `voice.yaml` engine block, and **Install on my machine**: pinned, hashed, resumable download of runtime + model; `fy voice status`; `fyd --check` voice line.                                       | Settings › Voice › On my machine › Install. `fy voice status` says installed, with sizes.                                                          |
| **B2** | The voice worker: separate process, thread cap, `<product>-voice.slice` scope (Linux) / nice + watchdog (macOS), idle exit, Silero VAD; `fy voice test <file.wav>`; measured numbers on Linux x64, arm64 and Apple Silicon. | `fy voice test clip.wav` prints the words and the time. `systemctl --user status <product>-voice.slice` shows the caps while it runs.              |
| **B3** | `/v1/voice/stream` (§14 stream session) and the PWA's **On my machine** engine for **Transcribe**; relay §10 and the privacy wording updated.                                                                               | On the phone over the relay, pick On my machine, dictate, Stop: the review box shows the words; Settings says the audio goes only to your machine. |
| **B4** | **Live transcribe** on the machine engine: interim and committed words come back over the stream.                                                                                                                           | Live transcribe with On my machine: words appear as you pause, as fast on the phone as on the desktop.                                             |
| **B5** | **Live chat** on the machine engine: the daemon endpoints, counts down (with `shown` / Hold / Send now / End) and sends; a dropped stream cancels the send; one stream per ferret.                                          | Live chat with On my machine: talk, watch the countdown, hear the reply. Put the phone in airplane mode during a countdown: nothing is sent.       |
| B6     | Constant-bitrate Opus uplink where WebCodecs has it (~10× less traffic).                                                                                                                                                    | Settings › Machine › Performance shows the voice stream's bytes per minute drop.                                                                   |
| B7     | Optional GPU (CUDA / CoreML), only if B2's numbers show it matters.                                                                                                                                                         | —                                                                                                                                                  |

B6 and B7 are optional; the plan is complete at B5.

---

## 8. Declared gaps and risks

- **NixOS** cannot load the downloaded Linux prebuilds without `nix-ld` or a Nix-built sherpa-onnx (§2.3).
- **iOS** keeps the &F137 limits: no background mic, half-duplex, Listen tap after each reply. The machine
  engine does not change capture.
- **Babble** (café, TV) still fails the loudness endpointer on device; Silero VAD fixes it only on the
  machine engine until a browser VAD is built.
- **Every number marked approximate is unmeasured here.** B2 publishes the real ones (load, RTF per
  thread count, memory) before B3 relies on them.
- **A ferret that ignores the teaching** is spoken by the fallback; the panel counts it.

---

## 9. Owner decisions

Short list. Each has a recommendation; none is decided by this plan.

**D1 — Which model runs on your machine?**

- (a) **Parakeet 0.6B v3** (~470 MB, ~1 GB memory, most accurate, many languages), words near-live. ← **recommended**: the same model your browser already uses best, and the machine has the CPU to run it often.
- (b) A streaming Zipformer (small, true live words, English only, less accurate; the small one dropped first words in our test).
- (c) Both: Zipformer for live words, Parakeet for the final text (twice the download and memory).

**D2 — How does the engine get onto your machine?**

- (a) **Downloaded when you press Install** (runtime + model, pinned and checked). ← **recommended**: nobody pays for it unless they use it, and `fyd` stays the same size.
- (b) Built into every `fyd` release (bigger download for everyone, and needs a custom static build).

**D3 — When the machine is busy, who gets the CPU?**

- (a) **Your ferrets.** Voice is capped at 2–4 cores and yields under load; Live chat may lag a little during heavy builds. ← **recommended**: matches "don't affect the main agent", and the hard cap means voice can never take more than its cores anyway.
- (b) Your voice. Builds slow slightly while you talk; Live chat stays snappy.

**D4 — What do ferrets write for the spoken part?**

- (a) **`<say>…</say>`**, taught to every ferret and used only in Live chat turns. ← **recommended**: short, reads as "say this", and does not clash with the "voice" feature name.
- (b) `<voice>…</voice>`, the same otherwise.
- (c) Teach it only inside Live chat messages (no change to ferrets' prompts; a little more text per spoken message).

Also already on your agenda and affected: **!A411 (browser isolation for faster on-device speech)** —
worth parking until the machine engine is measured (B2).
