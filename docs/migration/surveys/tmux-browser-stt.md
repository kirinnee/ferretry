# Survey — tmux controller, browser service, STT worker client

What kteam's three largest runtime subsystems own, and where each capability lives in Ferretry
today. Produced by unit AUDITTMUX. Every row is either a Ferretry path or an explicit **GAP**.

Source files audited (paths relative to `modules/kteam-ts/src/` in the home-manager repo):

| Source                 | Lines | Verdict                                                                |
| ---------------------- | ----- | ---------------------------------------------------------------------- |
| `tmux-controller.ts`   | 2,371 | Partially ported — the pane-reading half was carried in narrowed form  |
| `browser-service.ts`   | 882   | NOT PORTED — blocked, and the blocker is declared                      |
| `stt-worker-client.ts` | 916   | REMOVED — ported, then deleted when recognition moved into the browser |

Filenames do not match: Ferretry splits large files into small subject-named modules, so this map
is symbol-by-symbol against the code, not against names.

---

## 1. `tmux-controller.ts`

### 1.1 Pane reading — pure functions (lines 12–1343)

| Source symbol                                               | Ferretry                                                       |
| ----------------------------------------------------------- | -------------------------------------------------------------- |
| `PaneState`, `PaneMetadata`                                 | `lib/tmux/contracts.ts`                                        |
| `parsePaneMetadata`                                         | `lib/tmux/pane.ts`                                             |
| `paneShowsActiveWork`                                       | `lib/tmux/pane.ts` — **was narrowed; widened by this PR**      |
| `STARTUP_BLOCKERS` (14 markers)                             | `lib/tmux/pane.ts` — **was 3 markers; widened by this PR**     |
| `INTERRUPTED_BANNER`                                        | `lib/tmux/pane.ts`                                             |
| `promptReady` (method)                                      | `lib/tmux/pane.ts` `promptIsReady`                             |
| `backgroundTerminalCount`                                   | `lib/migrate/background-terminals.ts`                          |
| `composerEvidence`, `composerHolds`, `LandingEvidence`      | `lib/tmux/composer.ts` — **ported by this PR**                 |
| `PASTE_TRANSPORT_CHARS`, `PASTE_PLACEHOLDER`                | `lib/tmux/composer.ts` — **ported by this PR**                 |
| `paneShowsModelSelector`                                    | `lib/tmux/composer.ts` — **ported by this PR**                 |
| `InjectionOutcome`                                          | `lib/tmux/delivery.ts` — **ported by this PR**                 |
| `startupDialogAction`, `resumeMenuAction`, `StartupDialog*` | `lib/tmux/startup.ts` — **ported by this PR**                  |
| `paneWorkCounters`, `workCountersAdvanced`                  | **GAP** — see below                                            |
| `foldStallLiveness`, `StallLivenessState`                   | **GAP** — see below                                            |
| `paneActivityLine`                                          | **GAP** — see below                                            |
| `contextPercentUsed`                                        | **GAP** — see below                                            |
| `INTERACTIVE/AUTOMODE/DEFAULT/LAUNCH_READY_TIMEOUT_MS`      | **GAP (partial)** — Ferretry counts readiness attempts, not ms |

**The pane-poller group — GAP, all four, and for the same reason.** `paneWorkCounters`,
`workCountersAdvanced`, `foldStallLiveness`, `paneActivityLine` and `contextPercentUsed` are all
readings that only mean something ACROSS FRAMES: a stall is proven by an elapsed clock or a token
count that failed to advance between two polls, and an activity line is only worth showing while it
is being refreshed. Ferretry captures a pane on demand — at launch, at revive, at a migration
preflight — and never on an interval, so there is no second frame to compare against and nowhere to
mount any of them. They belong with the unit that builds the poller (the same one that would revive
`lib/warden/detect.ts`, which is itself unmounted).

Two of them have a partial home already. `lib/core/context-window.ts` computes a context percentage
from transcript TOKEN COUNTS, which is a different and better source of truth than the statusline
scrape — but it goes blank when the transcript has not flushed, which is exactly when a human wants
it. `lib/session/health/wedge.ts` classifies a wedged session from self-check ticks rather than from
pane counters.

### 1.2 Structured-question drive — pure functions (lines 384–1343)

The source's full matcher family remains **GAP**. Ferretry carries a deliberately narrower, fail-closed
subset in `adapters/session/question/tmux-structured-question-driver.ts`: it positively binds the visible
question text (including hard wraps), all transcript options, a harness-rendered implicit `Other…`, and the
cursor before sending any answer key, then requires visible form advance. Unknown menus, free-text pages that
cannot be bound, and unreadable selection origins refuse rather than guess.

The remaining source capabilities are:

`STRUCTURED_ANSWER_NOT_VISIBLE`, `distinctiveOptionFragment`, `optionVisibleOnPane`,
`exactOptionRowVisible`, `exactHeaderRowVisible`, `questionRowIndex`, `MenuBlockRow`,
`LiveMenuBlock`, `liveMenuBlock`, `blockOptionRowVisible`, `blockBindsOptions`,
`structuredQuestionPaneMatch`, `questionVisibleOnPane`, `resolveVisibleQuestion`,
`visibleQuestionIndex`, `anyQuestionVisible`, `structuredMenuVisible`, `visibleMultiSelectState`,
`blockMultiSelectState`, `paneShowsFreeformComposer`, `freeformComposerLine`, `FreeTextRegion`,
`freeTextQuestionRegion`, `freeTextPageShowsQuestion`, `StructuredAnswerOutcome`,
`structuredAnswerRefusal`.

**Why the full family is still not ported.** These exist to answer a harness's own multiple-choice /
multi-select / free-text question by keystroke, and they refuse rather than guess when the pane does
not provably show the question being answered.

The reason recorded here originally — that Ferretry had no structured-question surface at all, no
`PendingQuestion`, no answer route and nothing that recorded a question — **stopped being true and
this paragraph did not.** All three exist: `PendingQuestionSchema` in `packages/protocol/src/lib/session.ts`,
`POST /v1/sessions/:sessionId/answer` in `packages/daemon/src/lib/runtime/mounts/session-answer.ts`,
and `projectStructuredQuestion` writing the question into durable state on every session read.

What is actually left is the matcher family above for the public **bound abandon** (see §1.3 and the
map's `interrupt` row), which must identify an arbitrary live question before pressing Escape.
Answer-failure recovery no longer waits on that family: the driver already owns the exact pending
tool and can re-bind that same form. It snapshots through the existing last-snapshot store and
attempts at most one Escape, and only after that positive bind. What happens next turns entirely on
whether the release was CONFIRMED, and the two branches are deliberately different:

- **Confirmed release** — cancellation was positively observed, or the form had already visibly
  advanced. The exact durable question is atomically released to prose, and the receipt settles as
  `failed` when no answer input could have landed or `quarantined` when it may have. Prose is
  permitted from that point.
- **Unconfirmed cancellation, or a release that could not be committed** — the receipt stays
  `accepted`, the honest name for "keys may or may not have landed", and the exact binding (the
  pending question and the answers driven against it) is retained rather than released. Prose is
  REFUSED, because fallback prose could answer a still-live native selector, and the answer is
  never re-driven either.

**Monitor evidence reconciles those `accepted` rows without re-driving anything.**
`reconcileAnswerEvidence` promotes a receipt to `confirmed` only on the authoritative
`lastAnsweredQuestionToolUseId` stamp, and to `quarantined` when the transcript proves the form
advanced without proving which answer landed; an unchanged active form stays `accepted` and
therefore remains a hard quarantine. No answer key is ever sent a second time on ledger or monitor
evidence alone.

**The released advisory persists across prose.** `structured-answer-released-unconfirmed` is
advisory rather than an input modal — `authorizeSend` and the resume policy both exempt that one
attention kind, so prose continues while it stands, and the projection re-asserts it on every
subsequent read instead of letting ordinary traffic erase it. It clears on exactly two things:
authoritative confirmation of that answer, or an explicit durable human relaunch/clear (an
`admin-cli` / `admin-ui` revive or preserve, which appends an `acknowledged` ledger record before
clearing the state). Pane death, cancellation failure, and restart replay remain fail-closed and
never authorize a second drive.

The nearest thing Ferretry does have is `lib/session/harness/picker-screen.ts` +
`dismiss.ts` — the same discipline (classify the pane, re-verify immediately before every send,
refuse on an unknown screen) applied to Codex's model picker rather than to agent questions.

### 1.3 `TmuxController` methods (lines 1344–2371)

| Source method     | Ferretry                                                                                                                                                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `alive`           | `lib/tmux/controller.ts`                                                                                                                                                                                                                           |
| `listSessions`    | `lib/tmux/controller.ts`                                                                                                                                                                                                                           |
| `capture`         | `lib/tmux/controller.ts` (`capture(session, history)`)                                                                                                                                                                                             |
| `captureVisible`  | `lib/tmux/controller.ts` (`capture(session, false)`)                                                                                                                                                                                               |
| `promptReady`     | `lib/tmux/pane.ts` — pure, out of the class                                                                                                                                                                                                        |
| `state`           | `lib/tmux/controller.ts`                                                                                                                                                                                                                           |
| `launch`          | `lib/tmux/controller.ts` + `adapters/session/lifecycle/…-launcher.ts`                                                                                                                                                                              |
| `stop`            | `lib/tmux/controller.ts`                                                                                                                                                                                                                           |
| `waitReady`       | `lib/tmux/delivery.ts` + `adapters/tmux/pane-delivery.ts` — **this PR**                                                                                                                                                                            |
| `inject`          | `lib/tmux/delivery.ts` + `adapters/tmux/pane-delivery.ts` — **this PR**                                                                                                                                                                            |
| `send`            | `adapters/…/tmux-session-lifecycle-launcher.ts` `deliver` — **this PR**                                                                                                                                                                            |
| `paneProcessId`   | **GAP** — `#{pane_pid}` args exist (`panePidArguments`), no caller                                                                                                                                                                                 |
| `processTreePids` | **GAP** — process-tree walk; see `lib/migrate/process-table.ts` (adjacent)                                                                                                                                                                         |
| `subprocessAlive` | **GAP** — depends on `processTreePids`                                                                                                                                                                                                             |
| `typeIntoQueue`   | **GAP** — mid-turn native-queue typing (`tab to queue`)                                                                                                                                                                                            |
| `interrupt`       | PARTIAL — turn-stop is served by `SessionSendService.interrupt`; public bound abandon still answers `501`                                                                                                                                          |
| `answerQuestion`  | PORTED for the bound shapes in §1.2 — durably idempotent and monitor-reconciled; a confirmed release settles `failed`/`quarantined` and permits prose, while an unconfirmed one stays `accepted` with the exact binding retained and prose refused |
| `cancelQuestion`  | PARTIAL — the answer-failure path re-binds the exact owned form and sends at most one Escape, releasing to prose only when that cancellation is confirmed; the public arbitrary-form bound-abandon path remains GAP                                |
| `snapshot`        | Partly — `adapters/session/resume/tmux-resume-launcher.ts` `snapshot`                                                                                                                                                                              |

**`paneProcessId` / `subprocessAlive` — GAP with a live consequence.** kteam uses the pane pid and
its process tree to tell "the harness exited but tmux kept the pane" from "the harness is running a
long child". Ferretry's `lib/session/health/zombie.ts` answers a related question from journal
timestamps instead. `panePidArguments` is already built in `lib/tmux/commands.ts` and has no
caller — the ingredients are there, the consumer is not.

**`interrupt` — GAP.** kteam's interrupt is not one keystroke: it checks the pane is genuinely
mid-turn, sends Escape/C-c per harness, and re-reads to confirm the turn stopped — because a second
interrupt into an already-stopped Codex quits the TUI. Ferretry has no interrupt surface, so there
is nothing to mount it behind.

---

## 2. `browser-service.ts` — NOT PORTED, blocker already declared

`BrowserService` is the per-session browser lifecycle: launch a Chrome per session over a leased
profile, hold agent and human viewers on it, arbitrate who is driving, sweep idle browsers, and
close everything for the human login window.

| Source capability                                              | Ferretry                                            |
| -------------------------------------------------------------- | --------------------------------------------------- |
| `ManagedBrowserRuntime` (navigate/click/type/read/screenshot…) | `lib/browser/transport/automation-contracts.ts`     |
| `BrowserViewerAttachment` / `BrowserViewerTerminal`            | `lib/browser/transport/viewer-contracts.ts`         |
| screencast frame pacing + acknowledgement                      | `lib/browser/transport/frame-governor.ts`           |
| human input bounding (`boundHumanInput`)                       | `lib/browser/transport/input.ts`                    |
| viewer socket lifecycle                                        | `lib/browser/transport/viewer-stream.ts`            |
| worker request/response protocol                               | `lib/browser/transport/worker-protocol.ts`          |
| `browser-playwright-worker.mjs` persistent CDP worker          | `packages/daemon/bin/browser-worker.ts`             |
| profile lease + Chrome version checks                          | `lib/browser/control/profile.ts`                    |
| Chrome argv, viewport normalisation, VNC login window          | `lib/browser/control/policy.ts`, `control/login.ts` |
| `start`/`stop`/`status`/`act`/`attachViewer`/`sweepIdle`       | **GAP** — no per-session browser service            |
| `closeForLoginWindow` (close agents' browsers to free profile) | **GAP**                                             |
| `resolveSession`, `BrowserSessionRegistry`                     | **GAP**                                             |
| unexpected-exit handling, failure memory                       | **GAP**                                             |

The pieces are all real and tested; the thing that would own them is not. `DaemonWorld.browserTransport`
carries the blocker in `scripts/validate/invocation-blocked.txt`: `connectWorker` spawns a worker
PROGRAM this repository does not contain, and nothing implements `BrowserViewerHost`. This audit
confirms that line and sharpens it — the missing piece is not only the worker but `BrowserService`
itself, which is what would hold a `BrowserViewerHost` and decide when a browser starts, who may
drive it, and when it is swept.

`packages/daemon/bin/browser-worker.ts` now carries the source worker's cross-platform CDP
connection, page model, JPEG screencast and human mouse/key/text dispatch. It connects only to the
parent-launched Chrome endpoint, so it never attaches to an operator's own Chrome profile. The
per-session `BrowserService` / `BrowserViewerHost` remains the mount gap: until it owns a profile
lease and starts this executable, `/v1/sessions/:id/browser` must continue to answer
`501 browser_automation_not_mounted` rather than pretending a partner browser exists.

The Linux VNC login window must stay in place until that mount gap closes. Removing it immediately
would leave no reachable browser-drive surface despite the worker executable existing. Once the
host is mounted, remove the VNC route and update the doctor verdict that currently describes the
macOS login window as unavailable by design.

---

## 3. `stt-worker-client.ts` — REMOVED, not ported

This section previously recorded a ported-and-improved daemon worker supervisor. That subsystem no
longer exists. One squash merge (`ac6b8a35`) made all four changes at once: recognition moved into
the browser's own Web Speech API, the PWA's record-then-upload pipeline and its PCM16 worklet were
deleted with it, the CLI kept only text enhancement, and the daemon's recogniser, model store and
worker supervisor were deleted. The rows are kept rather than dropped, because "we ported this,
then deleted it, and here is why" is the fact a later reader needs.

Where a capability has a browser-side counterpart, the row names it. Where the source capability
existed only to serve a daemon-resident model, the row says **MOOT** — there is nothing left for it
to be a gap in.

| Source symbol                                   | Ferretry                                                                                                                                        |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `SttWorkerClient` (status/ensureReady/…)        | **REMOVED** — `adapters/stt/worker-client.ts` deleted; the daemon has no recogniser                                                             |
| `SttWorkerClientLike`, `SttWorkerTranscription` | **REMOVED** with it                                                                                                                             |
| `spawnSttWorker`, `SttChildHandle`              | **REMOVED** — `adapters/stt/bun-worker-spawner.ts` deleted                                                                                      |
| generation-guarded child ownership              | **REMOVED**; the surviving equivalent is the generation token in `packages/pwa/src/hooks/use-dictation.ts`                                      |
| SIGTERM → SIGKILL → give-up escalation          | **REMOVED** — there is no child process to reap                                                                                                 |
| load/decode deadlines that reap the child       | **REMOVED**; the surviving equivalent is the 10 s stop timeout in `packages/pwa/src/lib/stt/browser-recognition.ts`                             |
| bounded stderr tail on crash                    | **REMOVED**                                                                                                                                     |
| single-flight `busy` refusal                    | **REMOVED**; the browser session refuses a second start by phase (`packages/pwa/src/hooks/use-dictation.ts`)                                    |
| protocol parsing / error codes                  | **REMOVED** (`lib/stt/worker-protocol.ts`); the surviving daemon error type is `SttEnhancementError` in `packages/daemon/src/lib/stt/errors.ts` |
| `resolveSttWorkerEntry`                         | **REMOVED** — no worker entry to resolve                                                                                                        |
| `compareVersions`, `versionParts`               | `lib/browser/control/profile.ts` `compareChromeVersions` (unrelated, unchanged)                                                                 |
| `resolveSherpaAddonDirectory`                   | **MOOT** — was a declared GAP; nothing loads a native addon now                                                                                 |
| `discoverNixLibstdcxx`                          | **MOOT** — see the rewritten paragraph below                                                                                                    |
| `buildSttWorkerEnvironment`                     | **MOOT** — the unfilled seam (`BunSttWorkerSpawnerOptions.environment`) is deleted                                                              |
| `createBoundedSttLogSink`                       | **MOOT** — `SttPaths.workerLog` was declared and never written; `lib/stt/paths.ts` is deleted                                                   |
| idle worker shutdown (`scheduleIdle`)           | **MOOT** — there is no resident model to release                                                                                                |

**Native library discovery — MOOT, and it was the strongest argument for the removal.** kteam finds
the newest `libstdc++` in `/nix/store` and puts it on the child's `LD_LIBRARY_PATH`
(`discoverNixLibstdcxx` + `buildSttWorkerEnvironment`), because the sherpa-onnx native addon will not
`dlopen` against the system one on NixOS. Ferretry classified the resulting failure correctly
(`classifyLoadFailure` mapped `libstdc++`/`dlopen` to `native_missing`) and never tried to prevent
it, and `sherpa-onnx-node` appeared in no `package.json`, no `bun.lock` and no `nix/*.nix` — it was
a dynamic `import(specifier)`. On this fleet the daemon batch transcriber therefore could not load at
all. The removal deletes a capability that never ran here.

**Idle worker shutdown — MOOT.** The idle release existed so a loaded speech model did not sit
resident in a long-lived daemon. With recognition in the browser there is no model and no child, so
the whole class of leak is gone rather than managed.

**What survived on the daemon: one route.** `POST /v1/stt/enhance`, scope `admin`, an ordinary JSON
`ApiRoute` (`packages/daemon/src/lib/runtime/mounts/stt.ts`). It takes an already-transcribed
transcript and returns a repaired one, and it stays daemon-side for one reason: the outbound hosted
call is authenticated with `GROQ_API_KEY`, read from the daemon's own environment
(`packages/daemon/src/lib/stt/enhancement.ts`), and a static public browser bundle has no way to
carry an operator's key. It is **text in, text out** — no audio crosses the daemon boundary at all.
The browser's default is still the local deterministic enhancer
(`packages/pwa/src/lib/stt/enhancement.ts`), so the Groq path is opt-in.

**Where recognition happens now, stated precisely.** `packages/pwa/src/lib/stt/browser-recognition.ts`
drives the browser's `SpeechRecognition` / `webkitSpeechRecognition`. That is the BROWSER's engine,
not Ferretry's, and depending on the browser and its settings it may send the audio to the vendor's
own online speech service — so this is **not** device-local recognition and must not be described as
such. What is true, and is what the shipped copy says, is narrower: Ferretry neither uploads nor
stores microphone audio, and none reaches a paired daemon.

**Nothing fails silently, and the refusals are data rather than an absent button.**
`readBrowserRecognitionSupport` is a pure function of an injected global returning
`{available, availability, implementation, reason?}`, where `availability` is `available`,
`insecure-context`, `ios-home-screen` or `unsupported` and `reason` is ready-to-render, actionable
copy. The microphone control stays visible when recognition is unavailable and opens the panel with
that reason, because hiding it read as a broken click path. The probes are ordered secure context →
installed iOS Home Screen shell → constructor, and the iOS probe exists because WebKit can expose the
prefixed constructor in an installed Home Screen app while `start()` still answers
`service-not-allowed` — constructor-only detection lies there.

Once a session is running, the failure vocabulary is `permission-denied`, `no-microphone`,
`recognition-network`, `recognition-unavailable`, `bad-audio`, `recognition-failed` and `aborted`
(`browserRecognitionErrorFrom`). Permission refusal, a missing or busy microphone, an unreachable
vendor speech service, a vendor engine that refuses the language or the request, and the 10 s stop
timeout all land in that vocabulary and reach the panel; `aborted` (Cancel, or the tab going hidden)
returns to idle rather than showing a failure, because a cancelled take is not a failed one.

Two behaviours are worth stating exactly, because "fails visibly" is easy to over-claim:

- **`no-speech` is deliberately NOT a failure while recording.** Engines emit it routinely during
  ordinary pauses, so the session ignores it. A finish that produces no words and heard no speech
  simply returns to idle with nothing inserted — silence is not an error.
- **A finish that heard speech but produced no words IS a visible failure**, `bad-audio`: "Speech was
  heard, but this browser could not turn it into words."

**Raw words survive an enhancement failure.** Enhancement is a separate, optional step after the
transcript settles. If it fails, the raw recognised words are still committed to the composer and the
reason is surfaced beside them under an `enhancement-`-prefixed code, so a correction failure can
never be mistaken for a recognition failure and can never cost the reader their words.

**GAP — the amplitude meter.** `packages/pwa/src/components/input-waveform.tsx` survives with its
noise gate, RMS mapping and transition-only no-signal detector, and nothing in production hands it a
tap: the Web Speech API owns its own microphone and exposes no analyser stream. Opening a SECOND
microphone purely to paint a meter beside browser-owned recognition would be a worse lie than showing
no meter, so the component is production-unreachable by decision. This is a real GAP, not a
regression — in kteam `ui/src/components/InputWaveform.tsx` was imported by nothing but its own test,
and `ui/src/components/DictationSheet.tsx` declared `inputMonitor` without ever using it.

### 3.1 The rest of the daemon's STT source, for completeness

`stt-worker-client.ts` did not stand alone. Its seven siblings are audited here so no examined source
capability is left without a disposition.

| Source               | Lines | Ferretry                                                                                                             | State                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ----: | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stt-types.ts`       |   194 | `packages/protocol/src/lib/stt.ts`                                                                                   | **SPLIT — enhancement KEPT, recognition REMOVED.** The protocol module now holds five enhancement schemas (provider, request, result, error code, error view), their five inferred types, and the shared `MAX_STT_DICTIONARY_ENTRIES` request bound. Every audio-, model-, install-, worker- and transcript-shaped wire contract lost its last consumer and went with the recogniser. |
| `stt-audio.ts`       |   219 | —                                                                                                                    | **REMOVED** (`ac6b8a35`). PCM16LE/WAV decode under a duration budget existed only for `transcribe`. No audio crosses the daemon boundary now.                                                                                                                                                                                                                                         |
| `stt-model.ts`       |   667 | —                                                                                                                    | **REMOVED** (`ac6b8a35`) — catalogue, `.stt-model.json` manifests, download + sha256 verify + extract, install plans, and the `/stt-models/` browser feed. `tar` was the installer's only spawned process and `fy doctor` never checked for it, so an unchecked host dependency disappears with it.                                                                                   |
| `stt-paths.ts`       |    30 | —                                                                                                                    | **REMOVED** (`ac6b8a35`). Models directory, STT state directory and `workerLog`; nothing survives that needs a path.                                                                                                                                                                                                                                                                  |
| `stt-service.ts`     |   563 | `packages/daemon/src/lib/runtime/mounts/stt.ts`                                                                      | **REMOVED except the enhance branch.** That branch is now an ordinary `ApiRoute`, `POST /v1/stt/enhance`, scope `admin`: parse JSON, call the enhancer, project a thrown `SttEnhancementError` through the domain's own status/view pair. All recognition, status, and model routes are gone, and with them the daemon's raw route table, which had no members left.                  |
| `stt-worker.ts`      |   229 | —                                                                                                                    | **REMOVED** (`ac6b8a35`). It was never a packaged artifact: the daemon's `bin` map ships `fyd` and the browser worker, and the release compile step takes only the first `bin` entry.                                                                                                                                                                                                 |
| `stt-enhancement.ts` |   407 | `packages/daemon/src/lib/stt/{enhancement,enhancer,errors,ports}.ts` + `adapters/stt/fetch-enhancement-transport.ts` | **KEPT — the only survivor**, for the reason stated above: the provider key is read from the daemon's own environment and is never returned, logged or attached to an error cause, and a static public bundle cannot hold it.                                                                                                                                                         |

Route surface, before → after:

    GET  /v1/stt/status                    REMOVED
    GET  /v1/stt/models                    REMOVED
    GET  /v1/stt/models/:modelId           REMOVED   (never had a client)
    GET  /v1/stt/models/:modelId/install   REMOVED
    POST /v1/stt/models/:modelId/install   REMOVED
    POST /v1/stt/transcribe                REMOVED
    GET|HEAD /stt-models/:modelId/:file    REMOVED   (matched, never mounted)
    POST /v1/stt/enhance                   KEPT — ordinary JSON ApiRoute, scope admin

`fy stt`, before → after: `status | models | install | transcribe | enhance` → **`enhance` only**
(`ac6b8a35`), where `enhance` is the group's default command and takes already-transcribed TEXT.

---

## What this PR changed

Only §1.1, the readiness/delivery path, and one leak in §3 — the places where the absence was a
correctness or safety problem rather than a missing feature:

1. `paneShowsActiveWork` and the startup-blocker list had been carried in NARROWED form. A busy
   Claude pane (`✻ Lollygagging… (34s · 2.1k tokens)`) matched none of the three markers Ferretry
   kept, so `promptIsReady` returned true mid-turn and the daemon would type into a live turn.
2. Neither launcher answered a startup dialog. A session started in a directory the harness has not
   seen sits on a trust prompt, which is never `promptReady`, so `deliver` burned its whole retry
   budget and threw — reading as "the agent was given no work".
3. `deliver` pressed Enter with no proof the payload reached the composer, and sent a multi-line
   turn brief as literal keystrokes rather than a bracketed paste.
4. The STT worker was never released, so a loaded speech model stayed resident for the life of the
   daemon. **That fix has since been superseded:** the worker itself was deleted when recognition
   moved into the browser, so §3 now records a removal rather than a leak.

Everything else above stays a declared GAP.
