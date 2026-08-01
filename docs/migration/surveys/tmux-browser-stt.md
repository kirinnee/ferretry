# Survey — tmux controller, browser service, STT worker client

What kteam's three largest runtime subsystems own, and where each capability lives in Ferretry
today. Produced by unit AUDITTMUX. Every row is either a Ferretry path or an explicit **GAP**.

Source files audited (paths relative to `modules/kteam-ts/src/` in the home-manager repo):

| Source                 | Lines | Verdict                                                               |
| ---------------------- | ----- | --------------------------------------------------------------------- |
| `tmux-controller.ts`   | 2,371 | Partially ported — the pane-reading half was carried in narrowed form |
| `browser-service.ts`   | 882   | NOT PORTED — blocked, and the blocker is declared                     |
| `stt-worker-client.ts` | 916   | Ported and improved; two capabilities dropped                         |

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

Everything in this group is **GAP**, and the gap is a whole subsystem, not a set of helpers:

`STRUCTURED_ANSWER_NOT_VISIBLE`, `distinctiveOptionFragment`, `optionVisibleOnPane`,
`exactOptionRowVisible`, `exactHeaderRowVisible`, `questionRowIndex`, `MenuBlockRow`,
`LiveMenuBlock`, `liveMenuBlock`, `blockOptionRowVisible`, `blockBindsOptions`,
`structuredQuestionPaneMatch`, `questionVisibleOnPane`, `resolveVisibleQuestion`,
`visibleQuestionIndex`, `anyQuestionVisible`, `structuredMenuVisible`, `visibleMultiSelectState`,
`blockMultiSelectState`, `paneShowsFreeformComposer`, `freeformComposerLine`, `FreeTextRegion`,
`freeTextQuestionRegion`, `freeTextPageShowsQuestion`, `StructuredAnswerOutcome`,
`StructuredQuestionDriveError`, `structuredAnswerRefusal`.

**Why it is not ported here.** These exist to answer a harness's own multiple-choice / multi-select
/ free-text question by keystroke, and they refuse rather than guess when the pane does not
provably show the question being answered. Ferretry has no structured-question surface at all:
there is no `PendingQuestion` in `@ferretry/protocol`, no `/v1/sessions/:id/answer` route, and
nothing that records a question. Porting the readers with no question to read would put ~900 lines
of unmountable code in the tree, which both repo gates correctly refuse. It is one unit's work:
the protocol type, the store, the route, and then these readers.

The nearest thing Ferretry does have is `lib/session/harness/picker-screen.ts` +
`dismiss.ts` — the same discipline (classify the pane, re-verify immediately before every send,
refuse on an unknown screen) applied to Codex's model picker rather than to agent questions.

### 1.3 `TmuxController` methods (lines 1344–2371)

| Source method     | Ferretry                                                                   |
| ----------------- | -------------------------------------------------------------------------- |
| `alive`           | `lib/tmux/controller.ts`                                                   |
| `listSessions`    | `lib/tmux/controller.ts`                                                   |
| `capture`         | `lib/tmux/controller.ts` (`capture(session, history)`)                     |
| `captureVisible`  | `lib/tmux/controller.ts` (`capture(session, false)`)                       |
| `promptReady`     | `lib/tmux/pane.ts` — pure, out of the class                                |
| `state`           | `lib/tmux/controller.ts`                                                   |
| `launch`          | `lib/tmux/controller.ts` + `adapters/session/lifecycle/…-launcher.ts`      |
| `stop`            | `lib/tmux/controller.ts`                                                   |
| `waitReady`       | `lib/tmux/delivery.ts` + `adapters/tmux/pane-delivery.ts` — **this PR**    |
| `inject`          | `lib/tmux/delivery.ts` + `adapters/tmux/pane-delivery.ts` — **this PR**    |
| `send`            | `adapters/…/tmux-session-lifecycle-launcher.ts` `deliver` — **this PR**    |
| `paneProcessId`   | **GAP** — `#{pane_pid}` args exist (`panePidArguments`), no caller         |
| `processTreePids` | **GAP** — process-tree walk; see `lib/migrate/process-table.ts` (adjacent) |
| `subprocessAlive` | **GAP** — depends on `processTreePids`                                     |
| `typeIntoQueue`   | **GAP** — mid-turn native-queue typing (`tab to queue`)                    |
| `interrupt`       | **GAP** — no interrupt route exists                                        |
| `answerQuestion`  | **GAP** — see §1.2                                                         |
| `cancelQuestion`  | **GAP** — see §1.2                                                         |
| `snapshot`        | Partly — `adapters/session/resume/tmux-resume-launcher.ts` `snapshot`      |

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

`/v1/sessions/:id/browser` already answers `501 browser_automation_not_mounted` rather than 404,
which is the honest state.

---

## 3. `stt-worker-client.ts` — ported, and improved

| Source symbol                                   | Ferretry                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `SttWorkerClient` (status/ensureReady/…)        | `adapters/stt/worker-client.ts`                                                            |
| `SttWorkerClientLike`, `SttWorkerTranscription` | `adapters/stt/worker-client.ts`                                                            |
| `spawnSttWorker`, `SttChildHandle`              | `adapters/stt/bun-worker-spawner.ts`                                                       |
| generation-guarded child ownership              | `adapters/stt/worker-client.ts` (`generation`, `discard`)                                  |
| SIGTERM → SIGKILL → give-up escalation          | `adapters/stt/worker-client.ts` `stop`                                                     |
| load/decode deadlines that reap the child       | `adapters/stt/worker-client.ts` `exchange`                                                 |
| bounded stderr tail on crash                    | `adapters/stt/worker-client.ts` (`STDERR_TAIL_CHARS`)                                      |
| single-flight `busy` refusal                    | `adapters/stt/worker-client.ts`                                                            |
| protocol parsing / error codes                  | `lib/stt/worker-protocol.ts`, `lib/stt/errors.ts`                                          |
| `resolveSttWorkerEntry`                         | `adapters/stt/bun-worker-spawner.ts` `defaultWorkerEntry`                                  |
| `compareVersions`, `versionParts`               | `lib/browser/control/profile.ts` `compareChromeVersions` (browser-side equivalent)         |
| `resolveSherpaAddonDirectory`                   | **GAP**                                                                                    |
| `discoverNixLibstdcxx`                          | **GAP**                                                                                    |
| `buildSttWorkerEnvironment`                     | **GAP (partial)** — `BunSttWorkerSpawnerOptions.environment` is the seam, nothing fills it |
| `createBoundedSttLogSink`                       | **GAP**                                                                                    |
| idle worker shutdown (`scheduleIdle`)           | **GAP** — see below                                                                        |

**Native library discovery — GAP, and it is a Nix-specific one.** kteam finds the newest
`libstdc++` in `/nix/store` and puts it on the child's `LD_LIBRARY_PATH`, because the sherpa-onnx
native addon will not `dlopen` against the system one on NixOS. Ferretry's worker classifies the
resulting failure correctly (`classifyLoadFailure` maps `libstdc++`/`dlopen` to `native_missing`)
but never tries to prevent it. On a Nix host the batch transcriber therefore fails to load with a
clear message instead of working. The seam exists (`BunSttWorkerSpawnerOptions.environment`); what
is missing is the discovery.

**Idle worker shutdown — GAP with a memory consequence.** kteam releases the worker child after an
idle period (`scheduleIdle` → `stopChild(false)`) so a loaded speech model does not sit resident.
Ferretry's client keeps the child until `close()`. A loaded sherpa model is hundreds of megabytes,
and the daemon is long-lived.

---

## What this PR changed

Only §1.1 and the readiness/delivery path — the places where the absence was a correctness or
safety problem rather than a missing feature:

1. `paneShowsActiveWork` and the startup-blocker list had been carried in NARROWED form. A busy
   Claude pane (`✻ Lollygagging… (34s · 2.1k tokens)`) matched none of the three markers Ferretry
   kept, so `promptIsReady` returned true mid-turn and the daemon would type into a live turn.
2. Neither launcher answered a startup dialog. A session started in a directory the harness has not
   seen sits on a trust prompt, which is never `promptReady`, so `deliver` burned its whole retry
   budget and threw — reading as "the agent was given no work".
3. `deliver` pressed Enter with no proof the payload reached the composer, and sent a multi-line
   turn brief as literal keystrokes rather than a bracketed paste.

Everything else above stays a declared GAP.
