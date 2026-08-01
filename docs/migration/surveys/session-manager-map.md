# Survey — `session-manager.ts` against the Ferretry daemon

`~/.config/home-manager/modules/kteam-ts/src/session-manager.ts` is 9,232 lines and 135 methods. It
is the core of kteam. Ferretry deliberately splits it across `packages/daemon/src/lib/**` under
subject names, so no filename comparison can tell us what is carried — this document is that
comparison, done symbol by symbol.

**How to read it.** Every row names a source symbol (with its line in the source at the time of the
audit), then either the Ferretry path that carries it or **GAP** with what is missing. A row marked
**GAP (unmounted)** means the module exists and passes its tests but no route or timer reaches it, so
the product does not have the capability — the distinction the reachability allowlist header makes.

**What was verified how.** The symbol inventory is complete: it was extracted mechanically from the
source, not sampled. The Ferretry side was established from the module tree, the mounted route table
(`lib/runtime/mounts/index.ts`), the protocol client's own call sites
(`packages/protocol/src/adapters/fy-api-client.ts`), and the reachability allowlist. Where a row says
PORTED, the named Ferretry module was opened; where it says GAP, the absence was established by
searching for the capability under every name it plausibly travels under, not by one grep. **Method
BODIES were not read line by line** — this map answers "is the capability carried", not "is it
carried identically". Rows where the shape is known to differ say so.

## The headline: the daemon serves 3 of the 8 session verbs the client speaks

`IFyApiClient` posts eight actions to `/v1/sessions/:id/<action>`. The daemon's route table answers
`unknown_route` to five of them.

| Client action | Daemon route                           | State                   |
| ------------- | -------------------------------------- | ----------------------- |
| `stop`        | `POST /v1/sessions/:sessionId/stop`    | PORTED                  |
| `resume`      | `POST /v1/sessions/:sessionId/resume`  | PORTED                  |
| `migrate`     | `POST /v1/sessions/:sessionId/migrate` | PORTED                  |
| `signal`      | `POST /v1/sessions/:sessionId/signal`  | **PORTED BY THIS UNIT** |
| `send`        | —                                      | **GAP**                 |
| `answer`      | —                                      | **GAP**                 |
| `interrupt`   | —                                      | **GAP**                 |
| `rename`      | —                                      | **GAP**                 |

And of the GET surface the client reads: `snapshot`, `logs`, `events`, `attachments`, `gc`,
`warden/status`, `warden/run`, `warden/config`, `cgroups/config` and `pwa/config` are all unserved.

## A. Session lifecycle

| Source                                                                           | Line             | Ferretry                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start`                                                                          | 2183             | PORTED — `lib/session/lifecycle/service.ts`, `mounts/session-control.ts`, `adapters/session/lifecycle/*`                                                                                                   |
| `bootstrap`, `awaitBootstrap`, `bootstrapSession`                                | 1412, 2472, 2519 | PARTIAL — `lib/runtime/boot.ts`, `adapters/runtime/daemon-boot.ts` cover daemon boot; the per-session bootstrap PHASE with its timeout (`BOOTSTRAP_PHASE_TIMEOUT_MS`) is **GAP**                           |
| `launchWithRetry`                                                                | 7673             | PORTED — `lib/session/resume/retry.ts` + `adapters/session/resume/in-memory-launch-gate.ts`                                                                                                                |
| `stop`                                                                           | 3690             | PORTED — `mounts/session-control.ts`                                                                                                                                                                       |
| `stopManagedSession`, `stopTmuxWithEvidence`                                     | 7421, 7434       | PARTIAL — `adapters/session/lifecycle/tmux-session-lifecycle-launcher.ts` stops a pane; the EVIDENCE path (snapshot + journalled proof of the kill) is **GAP** outside the completion path this unit added |
| `remove`                                                                         | 4398             | **GAP** — no `DELETE /v1/sessions/:id`; `storage.forgetFromIndex` exists, nothing calls it from a route                                                                                                    |
| `rename`, `resolveRenameTeammate`                                                | 4370, 4338       | **GAP** — `lib/names/allocator.ts` can claim a callsign, no rename route                                                                                                                                   |
| `migrate`                                                                        | 4072             | PORTED — `lib/migrate/*`, `mounts/session-migrate.ts`                                                                                                                                                      |
| `close`                                                                          | 1497             | PORTED — `storage.close()`, `untilShutdown` in `bin/fyd.ts`                                                                                                                                                |
| `health`                                                                         | 1534             | PORTED — `lib/session/health/*`, `mounts/health.ts`                                                                                                                                                        |
| `resolveRef`                                                                     | 2063             | PORTED — `lib/names/policy.ts` `resolveSessionReference`                                                                                                                                                   |
| `teammateNameUsage`, `assignTeammateName`, `resolveTeammateName`, `suggestNames` | 2083–2152        | PORTED — `lib/names/allocator.ts`, `lib/names/policy.ts`, `mounts/names.ts`                                                                                                                                |
| `wrappers`, `projects`                                                           | 8729, 8733       | PORTED — `lib/core/catalog.ts`, `mounts/catalogs.ts` (`GET /v1/projects`)                                                                                                                                  |
| `list`, `get`                                                                    | 1579, 1586       | PORTED — `mounts/sessions.ts`                                                                                                                                                                              |

## B. Messaging — the largest gap in the daemon

| Source                                                          | Line             | Ferretry                                                                                                                                                                                                                                 |
| --------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send`                                                          | 2642             | **GAP** — `mounts/index.ts` states it outright: "A SEND is not here — the lifecycle delivers turn one and has no method for a later turn." `packages/cli/src/lib/session/send-controller.ts` and `send-plan.ts` are built and call a 404 |
| `sendUnlocked`                                                  | 7166             | **GAP**                                                                                                                                                                                                                                  |
| `listSends`, `sendDisposition`                                  | 1615, 1705       | **GAP** — `SendDispositionSchema` exists in the protocol; no send ledger anywhere in the daemon                                                                                                                                          |
| `queueNativeSend`                                               | 3106             | **GAP**                                                                                                                                                                                                                                  |
| `deliverToIdlePrompt`                                           | 3294             | PARTIAL — `ResumeLauncher.deliver` types into a prompt-ready pane, but only as part of a resume                                                                                                                                          |
| `reviveWithMessage`, `queueForExplicitRevive`, `withAutoRevive` | 3179, 3240, 3410 | PARTIAL — `lib/session/resume/policy.ts` `planResume` chooses send-vs-relaunch; the auto-revive-on-send wrapper is **GAP**                                                                                                               |
| `answer`                                                        | 3438             | **GAP** — `packages/cli/src/lib/session/answer-controller.ts` and `answer-plan.ts` are built and call a 404                                                                                                                              |
| `interrupt`                                                     | 3557             | **GAP**                                                                                                                                                                                                                                  |
| `scheduleTerminalSendFinalization`, `finalizeTerminalSends`     | 6316, 6377       | **GAP**                                                                                                                                                                                                                                  |
| `isDirectPayload`, `systemPrompt`, `promptInstruction`          | 7543, 7508, 7534 | PARTIAL — `lib/session/resume/policy.ts` composes the resume turn document and its instruction; the start's own system prompt lives in `lib/session/lifecycle/policy.ts`                                                                 |
| `peerPreamble` (module fn, 800)                                 | 800              | **GAP** — peer attribution on a send. `packages/cli/src/lib/session/ports.ts` documents that the Ferretry pane is what makes it possible                                                                                                 |

## C. Signals and declared waits — **this unit**

| Source                                | Line       | Ferretry                                                                                                                                                                                                       |
| ------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signal`                              | 4461       | PORTED — `lib/session/signal/service.ts`, `mounts/session-signal.ts`                                                                                                                                           |
| `doneMarkerTurn`, `doneMarkerForTurn` | 4447, 4456 | PARTIAL — the WRITER is ported (`adapters/session/signal/file-signal-artifacts.ts`, turn-certified). The READER that refuses a marker from an older turn belongs to the monitor loop, which is **GAP** (see F) |
| `applyWaitingSignal`                  | 4538       | PORTED — `SessionSignalService.park`                                                                                                                                                                           |
| `parseDeadline` (module fn)           | 814        | PORTED — `lib/session/signal/policy.ts`, including the anchored ISO guard and the backstop clamp                                                                                                               |
| `clearWaiting`                        | 4608       | PORTED — `SessionSignalService.clearWait`, with the credit and the activity re-anchor                                                                                                                          |
| `endPeerWait`                         | 4599       | **GAP** — it fires from `send`, which does not exist. A park with a `peer` therefore ends only at its deadline                                                                                                 |
| `serviceWaiting`                      | 4640       | **GAP** — the heartbeat, the deadline wake and the `waiting` status hold are one monitor tick, and there is no monitor. `lib/warden/detect.ts` already DETECTS a stale wait; nothing wakes one                 |

Two divergences worth recording:

- **Marker filename.** kteam writes `markers/done.json`; Ferretry writes `<session>/done.marker`,
  because `adapters/session/resume/file-resume-turn-store.ts` already deletes that exact name before
  every relaunch. The JSON payload (`at`, `type`, `turn`) is kteam's.
- **`stalled` is protected here.** `PROTECTED_SIGNAL_STATUSES` includes `stalled`, matching kteam's
  `protectedStatuses`, while the resume domain's `TERMINAL_RESUME_STATUSES` deliberately excludes it.
  The two answer different questions — see the note in `lib/session/signal/types.ts`.

## D. Resume and recovery

| Source                                                           | Line             | Ferretry                                                                                                                                                                                             |
| ---------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resume`                                                         | 3792             | PORTED — `lib/session/resume/service.ts`, `mounts/session-resume.ts`                                                                                                                                 |
| `recover`, `recoverSession`                                      | 5090, 5146       | PARTIAL — `adapters/session/resume/storage-consistency-pass.ts`, `storage-health-inventory.ts`, `unmounted-repair.ts` exist; the daemon-restart readoption sweep is not driven by a route or a timer |
| `confirmHarnessExit`, `harnessExitReason`, `resumeFailureReason` | 3721–3778        | PORTED — `ResumeLauncher.confirmExit` and the false-terminal path in `resume/service.ts`                                                                                                             |
| `liveRecoveryScopeConflictFor`                                   | 3778             | PORTED — `authorizeResume` + `ReviveDedupeConflict`                                                                                                                                                  |
| `scheduleTransientRetry`, `cancelRetry`                          | 7391, 7415       | PARTIAL — `lib/session/resume/retry.ts` PLANS a retry and returns the delay; nothing fires the timer                                                                                                 |
| `implicitResumePolicy` (module fn)                               | 479              | PORTED — `resolveResumePolicy` in `lib/session/resume/policy.ts`                                                                                                                                     |
| `serialized`, `serializedBootstrap`, `serializedRuntimeControl`  | 7700, 7691, 7716 | PORTED — `KeyedSerialExecutor` and the `SerialExecutor` port                                                                                                                                         |
| `gitFingerprint`, `computeGitFingerprint`                        | 7477, 7496       | PARTIAL — `adapters/worktrees/git-gateway.ts` runs git; the cached per-cwd fingerprint is **GAP**                                                                                                    |

## E. Runtime control and harness quirks

| Source                                                           | Line       | Ferretry                                                                                                                                                     |
| ---------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runtime`, `runtimeModels`                                       | 2855, 2828 | PARTIAL — `lib/session/harness/runtime-switch.ts` and `lib/core/catalog.ts` carry the model/effort switch; no `POST /v1/sessions/:id/runtime` route          |
| `dismissCodexPicker`, `dismissCodexPickerInTmux` (module fns)    | 236, 265   | PORTED — `lib/session/harness/dismiss.ts`, `picker-screen.ts`, `adapters/session/harness/tmux-codex-picker-pane.ts`                                          |
| `quarantineUnconfirmedCodexPicker`                               | 3039       | PORTED — `lib/session/harness/quarantine.ts`                                                                                                                 |
| `rejectKillFailedPaneInput`, `rejectUnconfirmedCodexPickerInput` | 542, 548   | PARTIAL — `lib/session/harness/quirks.ts` models the per-harness quirks these refusals come from; the refusals themselves guard `send`, which does not exist |
| `CodexPickerCleanup` (kteam: the quarantine sweep)               | 3039       | PORTED — `lib/session/harness/cleanup.ts`                                                                                                                    |
| `claimedCodexSessionIds`                                         | 7659       | **GAP** — the harness mints its own ids (`quirks.mintsOwnSessionIds`), and nothing in the daemon inventories which session has claimed which                 |
| `runSessionCommand`                                              | 3091       | **GAP**                                                                                                                                                      |

## F. The monitor loop — absent in full

Nothing in `packages/daemon` runs a per-session watcher. This is the single largest missing subsystem
and several other GAPs above are downstream of it.

| Source                                                                                       | Line             | Ferretry                                                                                                                                 |
| -------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `startMonitor`, `stopMonitor`                                                                | 5271, 5410       | **GAP** — `adapters/session/resume/no-monitor-supervision.ts` is a deliberate no-op stub the resume service calls                        |
| `monitorLoop`                                                                                | 5620             | **GAP** (687 lines)                                                                                                                      |
| `startTranscriptWatcher`, `ensureCodexTranscript`, `armCodexTranscript`                      | 5301, 5340, 5350 | **GAP** — the PARSERS are ported (`lib/transcript/claude.ts`, `codex.ts`, `adapters/transcript/file-source.ts`); nothing tails them live |
| `handleClaudeEvents`, `handleCodexEvents`                                                    | 6458, 6685       | **GAP**                                                                                                                                  |
| `transition`                                                                                 | 6924             | PARTIAL — each domain has its own narrow transition (resume, signal); the general one is **GAP**                                         |
| `handleObservedInputs`                                                                       | 6307             | PARTIAL — `lib/transcript/observed-input.ts` classifies them; nothing feeds it                                                           |
| `reconcileStructuredQuestionFrame`                                                           | 5437             | **GAP**                                                                                                                                  |
| `ingestTerminalAnalytics`, `setTerminalAnalyticsIngestor`                                    | 6353, 1120       | **GAP** — `lib/analytics/*` holds the durable record and the fleet read; the per-session ingest is absent                                |
| `reconcileNeedsHuman`, `clearNeedsHuman`                                                     | 8740, 8834       | PARTIAL — `lib/attention/state-machine.ts` + `mounts/attention.ts` serve the ledger; the reconciliation sweep is **GAP**                 |
| `launchingRecently`, `hasLiveWarden`                                                         | 941, 7743        | PARTIAL — `InMemoryLaunchGate` covers the first; the second needs the warden runtime                                                     |
| Self-check: `SELF_CHECK_INTERVAL_MS`, `eventLoopLagMs`, `wedgeCount`, `selfRestartRequested` | 575–1045         | PORTED — `lib/session/health/self-check.ts`, `wedge.ts`, `self-restart.ts`, `incoherence.ts`, `zombie.ts`, `mounts/health.ts`            |

## G. Quota, usage and failover

| Source                                                              | Line       | Ferretry                                                                                                                       |
| ------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `updateQuota`, `fetchQuota`                                         | 7196, 7263 | PARTIAL — `lib/usage/quota.ts` maps an account row onto the session's quota patch and its labels; nothing polls it per session |
| `fetchUsageAccounts`, `usage`                                       | 7275, 8879 | PORTED — `lib/usage/feed-policy.ts`, `account-health.ts`, `adapters/usage/*`, `GET /v1/usage`                                  |
| `attemptFailover`                                                   | 7283       | **GAP (unmounted)** — `lib/warden/failover.ts` is on the reachability allowlist                                                |
| `waitForQuotaAndResume`, `scheduleQuotaWaiter`, `cancelQuotaWaiter` | 7341–7384  | **GAP**                                                                                                                        |

## H. Chat, transcript and snapshots

| Source                                                                                             | Line       | Ferretry                                                                                                           |
| -------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------ |
| `chatHistory`, `readChatWindow`, `chatNormalizer`                                                  | 4730–4803  | **GAP** — no chat route; the parsers exist                                                                         |
| `ensureChatIndex`, `rebuildChatIndex`, `verifyChatIndexes`, `chatTailResolves`, `indexChatRecords` | 4821–6994  | **GAP** — `adapters/storage/sqlite-index.ts` indexes EVENTS, not chat records                                      |
| `indexHarnessTranscript`, `chatHistoryFromLegacyFile`                                              | 4910, 4977 | PARTIAL — `adapters/transcript/file-source.ts` reads a harness transcript on demand                                |
| `broadcastChat`                                                                                    | 7034       | **GAP**                                                                                                            |
| `snapshot`, `lastSnapshot`                                                                         | 4702, 4721 | **GAP** — `TmuxController.state().visible` and `TmuxResumeLauncher.finalFrame` capture frames; no route serves one |
| `logs`                                                                                             | 4997       | **GAP**                                                                                                            |
| `search`                                                                                           | 8889       | PARTIAL — `lib/transcript/search.ts` is wired into the world (`searchTranscript`); no route                        |

## I. Events

| Source                                                | Line             | Ferretry                                                                                        |
| ----------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------- |
| `emit`, `emitDeferred`, `flushEmits`, `emitTransient` | 7082–8701        | PARTIAL — `storage.append` journals durably; the deferred/transient in-memory tiers are **GAP** |
| `replay`, `fromStored`, `turnFromDisk`                | 5003, 7150, 7146 | PARTIAL — `storage.replay` exists; `GET /v1/sessions/:id/events` is **GAP**                     |
| `subscribe`                                           | 5027             | **GAP** — no fleet event subscription; `lib/api/socket.ts` streams terminals only               |

## J. Attachments and the file browser

| Source                                             | Line             | Ferretry                                                                                                                                                                                              |
| -------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addAttachment`, `getAttachment`, `attachmentView` | 5032, 5043, 7554 | **GAP (unmounted)** — `lib/attachments/*` and `adapters/attachments/session-attachment-store.ts` exist and are used by the START's `initialAttachments`; the per-session attachment ROUTES are absent |
| `unlockAttachment`, `lockAttachment`               | 5056, 5064       | **GAP**                                                                                                                                                                                               |
| `fsList`, `fsFile`, `fsChanges`, `fsDiff`          | 5070–5085        | **GAP** — kteam's `./fs` module has no Ferretry counterpart                                                                                                                                           |

## K. Warden — built, not mounted

Every module below is in `packages/daemon/src/lib/warden/`. None of the `/v1/warden/*` routes the
client speaks is served, and no sweep timer exists; `world.wardenReports` is a factory nothing calls.

| Source                                                           | Line             | Ferretry                                                                                         |
| ---------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------ |
| `startWarden`, `runSweep`, `sweepOnce`, `wardenRun`              | 7866–9179        | **GAP** — no sweep runtime                                                                       |
| `pickWardenAccount`, `recordWardenSpawnFailure`                  | 8072, 8138       | **GAP (unmounted)** — `lib/warden/provenance.ts`, `lib/warden/failover.ts`                       |
| `spawnAssignedWardens`, `decideAssignedWardens`                  | 8165             | **GAP (unmounted)** — `lib/warden/concurrency.ts` (allowlisted)                                  |
| `buildAssignedWardenPrompt`, `buildWardenPrompt`                 | 8408, 8590       | **GAP (unmounted)** — `lib/warden/attention.ts` (allowlisted)                                    |
| `maybeEscalate`                                                  | 8477             | **GAP (unmounted)** — `lib/warden/bless.ts` (allowlisted)                                        |
| `wardenMayStop`                                                  | 8403             | PORTED — `lib/warden/types.ts` capability model                                                  |
| `wardenVerdicts`, `wardenReport`, `latestReport`                 | 8862, 8952, 8714 | PARTIAL — `lib/warden/verdicts.ts`, `lib/warden/reports.ts`, `adapters/warden/*` exist; no route |
| `wardenStatus`, `wardenAnomalies`, `wardenFailoverStatus`        | 8965–9005        | PARTIAL — `lib/warden/detect.ts`, `sus.ts` compute them; no route                                |
| `wardenConfigView`, `describeWardenConfig`, `updateWardenConfig` | 9051–9149        | **GAP** — no `/v1/warden/config`                                                                 |
| `saveWardenState`                                                | 8694             | **GAP**                                                                                          |

## L. Housekeeping and configuration

| Source                                                            | Line       | Ferretry                                                                                                                                                             |
| ----------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `planScratchSweep`, `scratchPlan`, `scratchSweep`, `sweepScratch` | 7756–7817  | **GAP** — kteam's `./scratch-gc` has no counterpart. `GET /v1/gc` and `POST /v1/gc` are declared in the protocol and unserved, so the state home grows without bound |
| `cgroupConfigView`, `updateCgroupConfig`, `liveCgroupTargets`     | 9055–9081  | **GAP** — no cgroup model in the daemon at all                                                                                                                       |
| `pwaConfigView`, `updatePwaConfig`                                | 9103, 9110 | **GAP** — `/v1/pwa/config` unserved                                                                                                                                  |
| `number` (bounded-number helper)                                  | 7653       | PORTED — zod schemas at every boundary                                                                                                                               |

## What to take next, in the brief's own order of preference

1. **`send` + `interrupt` + `answer`** (B). The absence is a correctness problem, not a missing
   convenience: the CLI ships three controllers that call 404s, and `endPeerWait` — already ported in
   spirit — cannot fire without a send. `send` is also what makes a declared peer wait terminable.
2. **Scratch GC** (L). Unbounded disk growth on the operator's machine, with the protocol shape
   already agreed.
3. **The monitor loop** (F). The largest single piece, and the prerequisite for `serviceWaiting`,
   quota polling, transient retry firing, chat broadcast and the stale-marker refusal. It should be
   attacked as its own unit, not as part of another.
4. **The warden sweep runtime** (K). Six modules are built and four are on the reachability
   allowlist; mounting them is mostly wiring plus a timer.
