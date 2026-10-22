# Session workers — stage 3 of the event-driven daemon

Status: **in progress** — 3a shipped (#712); 3b adds the workers (turn part only) · Date: 2026-10-22 · Parent: [event-driven-daemon.md](event-driven-daemon.md) (stage 3) ·
Owner directive, verbatim: _"use things like inotify, 1 thread per agent, fan into the daemon (daemon should
just communicate)"_.

This is the research and the design for stage 3: one Bun Worker per RUNNING session that takes over that
session's observation, while the main thread keeps every durable write and every client-facing view. It
changes no behaviour; it moves where the work happens and replaces timers with events.

Paths are relative to `packages/daemon/` unless they start with `scripts/` or `docs/`. Line numbers are
`origin/main` at `6a332332c` (4.66.4). Stage 1a/1c/2 references name their branch (`perf/state-document-cache`,
`perf/tmux-child-processes`, `perf/fs-event-hub`) as they stood on 2026-10-22, 1c and 2 still uncommitted.

## 0. The decisions, in one screen

1. **A worker observes; the main thread writes.** The worker holds no storage, opens no SQLite, writes no file.
   It posts _patches_ (a CAS'd field change plus the journal line it implies). The main thread applies them
   through the same `DaemonStorage.updateState`/`append` path the turn watcher uses today, so the session lock,
   the index row, the in-process event listeners (Warden triggers, `/v1/events`) and the journal stay exactly
   where they are. This is forced, not chosen — see §2.4.
2. **The worker derives; nobody else does.** For a session with a live worker, turn state, the open-question
   projection, the observed-runtime fields and the liveness sample are derived ONLY by that worker. The
   main-thread loops that derive them today are skipped for that session (3c) and deleted (3d).
3. **The main thread tells the worker the session's durable facts.** Because the main thread is the only
   writer of `state.json`, it knows every change; it pushes the few fields the observer needs (`status`,
   `pendingQuestion`, `turnState`, …) instead of the worker re-reading and re-parsing the document every 2 s.
   This is what lets the worker carry **no zod** (§3.4).
4. **Pane events are owned by the worker; file events are owned by the hub.** Each worker spawns and owns the
   one read-only `tmux -C` client ATTACHED to its session (the only client that receives `%output` for it) and
   runs its own in-band `capture-pane` over it. The main thread keeps the ONE shared query client (1c) and the
   ONE `FileEventHub` (2) and forwards per-path "changed" notices (a path and a stamp, never content).
5. **The observer is a pure per-session fold with ports; the thread is a transport.** `InlineObserverHost`
   (main thread) and `WorkerObserverHost` (Bun Worker) implement one port; every existing test runs against
   both (§4).
6. **Cap: one dedicated worker per running session up to 8, then 8 workers shared by least load.** A shipped
   lean worker measured **≈4 MB** each; one that drags zod/protocol in measured **15–19 MB** (§3.4).
7. **Order is kept inside the worker.** Each observation step runs question reconcile before turn derivation
   and posts in that order; the main thread applies one session's patches serially — the #689 invariant per
   session instead of per boot (§6.1).

## 1. Inventory — what runs per session on the main thread today

Legend: **R** = per RUNNING session (moves to the worker), **F** = fleet-wide (stays on main; stage 4 owns
moving it to a housekeeping worker), **C** = per command (bounded, user-initiated; stays in stage 3).

### 1.1 Turn watcher — R (the biggest single cost)

- Built: `StorageTurnPorts` at `bin/fyd.ts:8589-8595`; `turns: new SessionTurnWatcher(turnPorts)` at
  `bin/fyd.ts:8974`. Armed `bin/fyd.ts:9924-9929` (first tick unawaited, then `setInterval`).
- Cadence: `TURN_WATCH_INTERVAL_MS = 2_000` (`src/lib/session/turn/service.ts:18`); non-overlapping via a
  `running` flag (`service.ts:92`).
- Reads, **every session every tick**: `storage.listSessions()` (SQLite index), then `readState` for all of them
  in parallel — `session-version` + `state.json` + `SessionStateSchema` parse (`storage-turn-ports.ts:56-64`).
  Ended sessions are not filtered out before the read.
- Reads, **per live session** (`TURN_STATUSES` = running, thinking, tool_running, awaiting_user,
  awaiting_question, interrupted — `src/lib/session/turn/policy.ts:58-65`; checked at `service.ts:123`), one
  session at a time:
  - transcript: `transcriptFileOf(id)` reads `config.json` (`bin/fyd.ts:6770-6775`); an undiscovered Codex
    session walks the rollout index and every other session's `config.json` (`storage-transcript-provenance.ts:48-60`)
    and may write `config.json` (`:33`); then `stat`, and on (file,size,mtime) change `tail(id, 80)`, which
    re-resolves, re-reads `config.json`, `stat`s again and goes through the shared `TranscriptTailCache`
    (`bin/fyd.ts:6836-6860`, `src/lib/session/transcript/tail-cache.ts:51`), reading 512 KiB → 2 MiB → 16 MiB
    windows (`reader.ts:59,75,86`).
  - pane: `config.json` for `tmuxSession` (`storage-turn-ports.ts:82-87`), `has-session`, then in parallel a
    metadata `display-message` and **two `capture-pane`s, one of them full scrollback `-S -` that is thrown
    away** (`src/lib/tmux/controller.ts:50-56`, `commands.ts:4-21`). Parsed by `paneShowsActiveWork`,
    `paneShowsPermissionPrompt`, `paneBlockingPrompt`, `promptIsReady` (`src/lib/tmux/pane.ts:119-176`),
    `parsePermissionPrompt` (`permission-prompt.ts:216`), `parseHarnessDialog` (`harness-dialog.ts:225`).
  - Stage 1c (`perf/tmux-child-processes`) replaces this with one in-band activity query and a visible capture
    only when `capturedFrameIsCurrent` fails (`storage-turn-ports.ts:100-113` on that branch), no scrollback.
- Writes: `record()` → `storage.updateState` CAS on `turnState === change.from`, refusing a set when status is no
  longer live (`storage-turn-ports.ts:105-130`): `turnState`, `turnStateAt`, `turnPrompt`, `permissionRequest`,
  `harnessDialog`. `updateDocument` (`src/adapters/storage/session-storage.ts:893-912`) then re-syncs the index
  row, re-reading the **whole `events.jsonl`** (`:320,382`).
- Publishes: `storage.append(id, 'turn.state' | 'turn.prompt', …)` (`storage-turn-ports.ts:135-142`) →
  in-process listeners (`session-storage.ts:988-992`): the Warden trigger (`bin/fyd.ts:3917-3925`,
  `src/lib/warden/triggers.ts:23-25`) and the `/v1/events` feed (`bin/fyd.ts:9196-9222`). No attention, no push:
  turn notifications are computed by the PWA from `turnState`/`turnStateAt`
  (`packages/pwa/src/lib/notification-ledger.ts:54-67`).
- In-memory across ticks: `SessionTurnWatcher.previous` (two-frame confirmation, `service.ts:85`),
  `StorageTurnPorts.tails` (`storage-turn-ports.ts:45`), the shared `TranscriptTailCache`.

### 1.2 Declared-wait / question-reconcile monitor — split: parks **F**, questions **R**

- Built: `SessionMonitorService` `bin/fyd.ts:7865-7904`, wrapped by `MonitorTickRunner` at `:8973`. Armed
  `:9910`, first run **awaited** `:9917` (#689), timer `:9918-9921`, `close()` `:9930-9933`.
- Cadence: `tickIntervalMs 15_000`, `heartbeatIntervalMs 300_000`, `tickGraceMs 30_000`
  (`src/lib/session/monitor/settings.ts:45-50`).
- **Parks pass (F)**: every indexed session's config + state through `StorageSignalRepository.read`
  (`storage-monitor-waits.ts:40-51`); expiry/hold writes `state.json` (`signal/service.ts:109,138,249`), journals
  `session.waiting_cleared`/`_held`, writes `<session>/checks/waiting.json` (`file-wait-heartbeat.ts:33`), and
  nudges through the send slice (`send-monitor-nudge.ts:24`). No tmux, no transcript. Stays on main (cheap
  after 1a; it reads only documents main itself wrote).
- **Question pass (R)**: live sessions only (status ∉ `ENDED_SESSION_STATUSES` = completed, failed, stalled,
  stopped — `bin/fyd.ts:5123`), one at a time with `setImmediate` yields, under `answerSerial.runIfIdle(id)`.
  `projectSessionEvidence` (`bin/fyd.ts:7666-7716`): 400-event transcript tail, `state.json`, the answer ledger
  `channel/answers.jsonl`; `projectStructuredQuestion` (`question/projection.ts:161`), `reconcileAnswerEvidence`
  (`answer-ledger.ts:282`), `projectObservedRuntime` (`harness/observation.ts:143`). Writes settlements to
  `answers.jsonl` and an `updateState` patch (`bin/fyd.ts:7688-7714`): `pendingQuestion`, `status`
  (awaiting_question/awaiting_user/running), `lastAnsweredQuestionToolUseId`, **`needsHuman`/`needsHumanKind`**
  (attention is these fields), `reason`, observed-runtime model fields.
- The **same `projectSessionEvidence` also runs on the read path** for every session on every
  `GET /v1/sessions` and `GET /v1/sessions/:id` (`bin/fyd.ts:1695`, wired `:7721`) — a client read can parse
  400 events and write `state.json`.
- Health record: `<home>/monitor.json` (`monitor-tick-runner.ts:61-91`); written every tick, read by nobody in
  the daemon.

### 1.3 Liveness — the per-session probe is **R**; the self-check, lag meter and watchdog are **F**

- **Warden liveness monitor (R)**: built `bin/fyd.ts:3630`, timer `:3931-3945` inside `warden.arm()`,
  `WARDEN_LIVENESS_TICK_SECONDS = 30` (`:3552`). Scope `ACTIVE_MONITORED` = running, thinking, tool_running
  (`src/lib/warden/detect.ts:132`). Per session (`bin/fyd.ts:3648-3661`): a pane capture through
  `OperatorReadService.snapshot` (`src/lib/session/reads/service.ts:447`), a 20-line transcript tail
  (`WARDEN_LIVENESS_TAIL`, `:3555`), and the process tree via `PaneProcessInventory.collect`
  (`src/adapters/migrate/bun-process-inventory.ts:72`): `tmux display pane_pid`, **`ps -Ao pid=,ppid=,etime=,args=`**
  (`:16,34`), `readlink /proc/<pid>/cwd` per descendant (`:51`), `<cwd>/.mcp.json`. This is the "`ps` every
  2.5 s" in the parent doc: one `ps` per working session per 30 s. Folds: `foldLivenessSample`, `reflexStep`
  (`src/lib/warden/liveness.ts:98,204`); publishes reflex nudge/frozen through `service.reflex`
  (`src/lib/warden/sweep.ts:933`), which can nudge and `loop.trigger()` a sweep. In-memory `tracks`/`sampledAt`
  (`liveness-monitor.ts:63-65`). Stage 1c adds a 10 s process-table TTL and a `/proc/<pid>/task/*/children`
  walk (`bun-process-inventory.ts:21,73` on that branch).
- **Self-check (F)**: `bin/fyd.ts:9540-9541`, timer `:9886-9888`, 30 s (`healthIntervalSeconds`,
  `src/lib/runtime/config.ts:239`). Inventory from the index, a consistency pass, and the **exit observer**
  `TmuxSessionExitObserver` (`src/adapters/session/lifecycle/tmux-session-exit-observer.ts:115`): for every
  `terminal-pane.json`, `readState`; for running ones `has-session` + two `display-message`s (`:196-219`); CAS of
  `state` to a terminal status + `session.exited` journal + lease release (`:154-181`); `missingStatus` map
  (`:47,126`). The exit detection part is per running session and becomes event-driven in 3d (§5).
- **Event-loop lag meter / watchdog (F)**: `bin/fyd.ts:9305-9313`, 250 ms (`src/lib/runtime/liveness.ts:332`).
  Stays; it is the thing measuring the main thread.

### 1.4 Delivery confirmation (send tracker) — **R** evidence, **C** policy

- Built `SendTracker` `bin/fyd.ts:7809-7832` (`src/lib/session/send/tracker.ts:107`); armed `:10087`
  (one sequential roster walk at boot, `tracker.ts:126`).
- Event-driven per send: `track(id)` after `send`/`reattempt`/`releaseHeld`/`submit`; `TimerSendScheduler` holds
  one unref'd `setTimeout` per session (`src/adapters/session/send/timer-send-scheduler.ts:11-27`).
  `firstCheckMs 2_000`, deadlines human [60,60] s / agent [15,15,30,15] s / daemon [60] s, `typedStableMs 4_000`
  (`src/lib/session/send/tracking.ts:46-57`).
- Each look (`tracker.ts:184-225`): `channel/sends.jsonl`, a transcript window through `TranscriptSendEvidence`
  (`view.ts:88`, caches 64 windows/4096 inputs), a pane frame via `TmuxSendTerminal.heldAt`
  (`src/adapters/session/send/tmux-send-terminal.ts:107`, a capture); at a deadline also `terminal.observe` and
  `repository.read`.
- Writes `sends.jsonl` settlements; journals `control.send_delivered|_queued|_typed_not_sent|_timed_out|_unaccounted`
  (`storage-send-repository.ts:77`); `AgentSendFailureNotifier` (`bin/fyd.ts:7852`); reattempt re-types
  (a tmux mutation).
- **Also writes `turnState = working` on send** (`storage-send-repository.ts:105-111`) — a second producer of a
  turn-watcher field (§2.4).

### 1.5 Per-command pane polling — **C** (stays in stage 3)

`TmuxPaneDelivery` readiness/fill/submit polls at 250 ms (`src/adapters/tmux/pane-delivery.ts:49-57`),
`TmuxPaneQueue` (`pane-queue.ts:31-37`), composer keys (`tmux-send-terminal.ts:47`), `interrupt`/`send --now`
(`src/lib/session/send/service.ts:341-400`), and the structured answer driver (12 × 250 ms,
`src/adapters/session/question/tmux-structured-question-driver.ts:66,220`). Bounded, user-initiated, and they
need `send-keys`; they do not appear in an idle profile. They move to the shared control client's in-band reads
under 1c; subscribing them to the worker's frames is a later option (§8 Q5).

### 1.6 Live activity readout — **R** while a client watches

`?live=1` on `/v1/events` samples the working turn every `LIVE_SAMPLE_MS = 500`
(`src/lib/session/events/service.ts:24,288-322`) through `StorageLiveActivitySource`, which reuses
`turnPorts.paneState` (`bin/fyd.ts:8599`, `storage-live-activity.ts:80,111`) — a capture per half second per
viewed session. Moves to the worker's latest frame (§2.2).

### 1.7 Fleet-wide jobs that stay on main in stage 3 (stage 4 territory)

| Job                                                     | Where                                                                                                   | Cadence                         | Why it does not move                                                                                                                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Terminal reaper                                         | `bin/fyd.ts:10017-10020`, `src/lib/session/reap-service.ts:49`, `durable-terminal-pane-reap.ts:118,197` | 5 s on the lane                 | Touches every `terminal-pane.json` — mostly STOPPED sessions (the "stopped session asked its pane identity every 5 s"). 1c narrows it to finished sessions; 3d makes it react to a worker's `exited` (§5.3). |
| Warden sweep                                            | `bin/fyd.ts:9126-9162`, `src/lib/warden/runtime.ts:142`, `sweep.ts:865`                                 | ≥60 s, default 120 s            | Fleet decision; fed by journal events the main thread still emits.                                                                                                                                           |
| Quota failover                                          | `bin/fyd.ts:8977,9951-9955`, `src/lib/quota-failover/service.ts:115`                                    | ≥60 s, default 300 s, off       | Reads `sessions.list()` only; no per-session observation.                                                                                                                                                    |
| Handover reconcile                                      | `bin/fyd.ts:8991,10075`, `src/lib/handover/reconcile.ts:40`                                             | 15 s                            | Reads one receipt per session directory; stage 4.                                                                                                                                                            |
| Auto-resume                                             | `bin/fyd.ts:7244,9893`                                                                                  | once after boot                 | Not periodic.                                                                                                                                                                                                |
| Config watcher, analytics, audit, fleet refresh, update | `src/lib/config-files/watcher.ts:18`, `bin/fyd.ts:10011,10024,9981,10081`                               | 1 s / 60 s / 60 s / usage / 6 h | Not per session; config watcher already moves to the hub in stage 2.                                                                                                                                         |
| Session list/get projection                             | `bin/fyd.ts:1695,7721`                                                                                  | per request                     | Read path; for live sessions it is replaced by a worker barrier (§2.5); for ended sessions it stays (cached by 1a/2).                                                                                        |

## 2. Worker boundary

### 2.1 What moves into `bin/session.worker.ts`

One **SessionObserver** per live session, hosted by the worker, doing exactly the derivations that are R above:

| Observer part       | Replaces                                                                   | Inputs inside the worker                                                        |
| ------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `turn`              | `SessionTurnWatcher` + `StorageTurnPorts.transcript/pane` for this session | pane frames (own control client), transcript tail (own reader), facts           |
| `question`          | the monitor's question pass + the read-path `projectSessionEvidence`       | transcript tail (same parse), answer-ledger rows, facts                         |
| `runtime`           | `projectObservedRuntime` (rides in the question patch, as today)           | transcript tail                                                                 |
| `liveness`          | `WardenLivenessMonitor`'s sample collection (not its fold or reflex)       | pane digest/counters, transcript digest, process tree (Linux `/proc`, mac `ps`) |
| `delivery evidence` | `TranscriptSendEvidence` + `TmuxSendTerminal.heldAt/observe` reads         | the already-parsed tail and the latest frame                                    |
| `live activity`     | `StorageLiveActivitySource` captures                                       | the latest frame                                                                |
| `exit` (3d)         | the exit observer's tmux calls for this session                            | `%exit`/`%session-changed`/pane-exited from the attached client                 |

Stays on main: every durable write and journal append; the send tracker's policy and ledger; the parks pass;
the Warden liveness fold and reflex (pure and cheap, fed samples); the exit settle (CAS, lease release); all
fleet jobs of §1.7; transcript **resolution** (Codex rollout discovery needs every session's claims — main
resolves and tells the worker which file to read, §8 Q3).

**The worker parses one tail, once, for every part.** Today the turn watcher (80 events), the question pass
(400 events), the send evidence window, the liveness digest (20 lines) and the read path each read the same file
through four readers. The worker keeps one rolling window (the larger of 400 events and the oldest watched send)
and feeds all parts from it — identical projections, a quarter of the parsing.

### 2.2 Protocol — main → worker

Types live in `src/lib/session/observer/protocol.ts` as a closed discriminated union with an exhaustive `switch`
on both sides (type-only imports of `@ferretry/protocol`; no zod — §3.4). Every message carries the session id
and the worker **generation** it is addressed to.

| Message      | Payload                                                                                                             | Sent when                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `probe`      | `{probe: true}`                                                                                                     | `fyd --check` / smoke (the `bundled-worker.ts` contract)                                                                                                                        |
| `attach`     | `{session, generation, facts, transcript?, tmux: {socket, target}, settings}`                                       | worker (or pool slot) adopts a session                                                                                                                                          |
| `facts`      | `{session, revision, status, pendingQuestion?, turnState?, turnStateAt?, lastAnsweredQuestionToolUseId?, waiting?}` | after ANY main-thread write to that session's `state.json` that changes one of these fields (a hook in `DaemonStorage.updateDocument`), and after every applied patch (the ack) |
| `transcript` | `{session, file, harness}`                                                                                          | the resolver binds or re-binds the transcript (Codex discovery, relaunch)                                                                                                       |
| `file`       | `{session, path, stamp}`                                                                                            | the hub reports a real stamp change for a path the worker subscribed (`transcript`, `answers.jsonl`)                                                                            |
| `answers`    | `{session, rows}` (only settlements newer than the worker's cursor)                                                 | the answer ledger was appended by the answer path (main is its writer)                                                                                                          |
| `settings`   | `{turnIntervalMs, livenessTickMs, …}`                                                                               | config reload                                                                                                                                                                   |
| `request`    | `{id, session, kind: 'barrier' \| 'send-evidence' \| 'observe-now' \| 'live-sample', args}`                         | a route, the send tracker or the live feed needs an answer now                                                                                                                  |
| `detach`     | `{session, reason}`                                                                                                 | the session left the live set; drain and drop                                                                                                                                   |

`file` is a notice, not content: the worker reads the transcript itself, so no transcript bytes ever cross the
boundary in either direction.

### 2.3 Protocol — worker → main

| Message          | Payload (all small; the largest is a question)                                                                        | Main thread does                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ready`          | `{generation}` / `{probe: true}`                                                                                      | marks the host live                                                                                                    |
| `patch.turn`     | `{session, generation, seq, from, to, at, prompt?, permissionRequest?, harnessDialog?}`                               | runs today's `StorageTurnPorts.record` CAS verbatim, appends `turn.state`/`turn.prompt`, acks with fresh `facts`       |
| `patch.question` | `{session, generation, seq, question, settlements[], runtime?}` — the exact patch `bin/fyd.ts:7688-7714` builds today | appends settlements to `answers.jsonl`, `updateState` with the same merge, acks                                        |
| `liveness`       | `{session, sample: {paneDigest, transcriptDigest, counters, subprocessAlive, sampledAt}}`                             | `foldLivenessSample` + `reflexStep` exactly as `WardenLivenessMonitor.tick` does with a collected sample               |
| `exited` (3d)    | `{session, paneId, exitStatus?}`                                                                                      | runs the exit settle for this one session (`TmuxSessionExitObserver` logic), which then `detach`es                     |
| `response`       | `{id, ok, value \| error}`                                                                                            | resolves the pending request (barrier, send evidence verdict, live sample)                                             |
| `metrics`        | `{spawns: {program→count}, fileOps, parseMs, capturedFrames, posted: {count, bytes}}` — deltas                        | feeds the stage-0 recorder (`src/lib/performance/recorder.ts:156` `worker()` gauge and the child/file counters) — §6.5 |
| `fault`          | `{session?, message, fatal}`                                                                                          | journals once; a fatal fault triggers the restart policy (§3.3)                                                        |

**Diffs, never derived events.** A patch is the change to the session view; the tail, the frames and the
parsed events stay in the worker. `send-evidence` answers a verdict (`delivered | queued | typedNotSent | absent |
unreadable(reason)`) per send id, never the transcript window it was decided from. Measured in #690: cloning
parsed events back costs about what parsing them does.

### 2.4 Who owns each write

The fact-ownership rule is "one document, one writer". The evidence settles who that writer is:

- `DaemonStorage` keeps the session lock (`serial`, an in-process `KeyedSerialExecutor`), the SQLite index handle,
  the home lock and the per-process `eventListeners` (`session-storage.ts:167`). A worker with its own storage
  would hold none of them: its `updateState` would race main's under no lock, and its `append` would reach
  neither the Warden trigger nor `/v1/events`.
- `state.json` already has nine writers on main (turn record, send repository, lifecycle repository, exit
  observer, signal repository, resume repository, three answer paths, the projection, runtime quarantine). All of
  them serialize through main's lock today.

So:

| Document / fact                                                                                                                 | Writer (the only one)         | Producer of the value                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `state.json`, `config.json`, `events.jsonl`, the SQLite index                                                                   | main thread (`DaemonStorage`) | unchanged, plus worker patches through one `SessionObservationApplier`                                                             |
| turn fields (`turnState`, `turnStateAt`, `turnPrompt`, `permissionRequest`, `harnessDialog`)                                    | main (applier)                | the session's worker; **plus** the send repository's optimistic `working` (existing second producer — kept, CAS'd, declared below) |
| question fields (`pendingQuestion`, `needsHuman*`, question `status`, `lastAnsweredQuestionToolUseId`), observed-runtime fields | main (applier)                | the session's worker while it is live; the answer paths (unchanged)                                                                |
| `channel/answers.jsonl` settlements                                                                                             | main                          | worker computes them in `patch.question`; the answer driver as today                                                               |
| `channel/sends.jsonl`                                                                                                           | main (send tracker)           | worker supplies evidence verdicts                                                                                                  |
| `monitor.json`, `checks/waiting.json`, warden state                                                                             | main                          | unchanged                                                                                                                          |
| anything on disk                                                                                                                | **never the worker**          | —                                                                                                                                  |

**Declared, not fixed in stage 3:**

- _Two producers of `turnState`._ The send repository sets `working` on send so the UI flips before the next
  observation. It stays: the applier's CAS on `from` makes the two commute exactly as today, and the worker learns
  the new value from the `facts` ack. Recorded in the observer's docblock as the one sanctioned second producer.
- _A pre-existing lost-update window._ `StorageSessionLifecycleRepository.write`
  (`storage-session-lifecycle-repository.ts:200-203`) reads config+state, then `writeConfig`/`writeState` a
  merge **outside one locked read-modify-write**. A turn write that lands between the read and the write is
  reverted. Workers make patch arrival asynchronous and widen that window. **Fixed in #700**: `write` now goes through locked `upsertConfig`/`upsertState` (was: fix it before 3c, one
  `updateDocument` per document).

### 2.5 How the main thread stays the single source for clients

- **Durable view**: unchanged — `state.json` + index + journal, written only by main, read by every route.
- **Read-your-writes**: a `GET /v1/sessions[/:id]` that today runs `projectSessionEvidence` sends a `barrier`
  request to that session's worker instead. The worker answers after it has processed every input received
  before the barrier (it runs an observation step if a `file`/frame notice is pending) and its patches have been
  acked. The route then reads `state.json`. This is the same guarantee the read-path projection gives today —
  "what the transcript says is in the document I return" — without parsing on main. Barrier timeout: the existing
  3 s bounded-read budget (`tracker.ts:387-405`); on timeout the route serves the durable state and reports the
  read as `stale-observation` in the profile, not as an error. A session without a live worker keeps today's
  read-path projection.
- **Live readout**: `?live=1` reads the worker's latest frame through `live-sample` (one message per 500 ms per
  viewer, no capture) — or, simpler and cheaper, the worker pushes a `live` delta when the frame changes and the
  feed sends it. Pick the push in 3c.
- **Journal and event feed**: unchanged; patches are appended by main, so `/v1/events`, the Warden trigger and the
  PWA's notification ledger see the same events in the same shape.

## 3. Lifecycle

### 3.1 Which sessions get a worker

The **live set** = sessions whose status ∉ `ENDED_SESSION_STATUSES` AND that have a registered tmux target. It is
the question pass's set, a superset of `TURN_STATUSES` (a `waiting` or `kill_failed` session has a pane worth
observing for questions; the turn part stays dormant outside `TURN_STATUSES`, exactly as today).

A pure planner, `planSessionWorkers(live, hosted, cap) → {attach[], detach[], moves[]}` in
`src/lib/session/observer/plan.ts`, decides. The supervisor (`src/adapters/session/observer/worker-supervisor.ts`)
executes. Triggers:

- **Start**: main writes every status, so the `facts` hook in `updateDocument` sees a transition into the live set
  and calls `supervisor.reconcile(id)`. No polling for new sessions.
- **Stop**: a transition out of the live set (stop, finish, fail, exit settle) → `detach`. The worker closes the
  attached client, drops its hub subscriptions, posts its last patch and `detach`ed; the host terminates a dedicated
  worker after a 2 s drain.
- **Daemon boot / re-adoption**: after the index opens, `reconcile()` over `listSessions()` attaches every live
  session, at most 2 at a time (the tail cache's daemon-wide parse limit, `tail-cache.ts:25`) so a 16 MiB tail does
  not land on 8 workers at once. Nothing is persisted for the observer: today `previous` and `tails` are in memory
  too, so a restarted daemon re-derives from the transcript and the pane exactly as now (the restart re-derivation
  test at `tests/integration/session/turn/storage-turn-ports.test.ts:407` must stay green against the worker host).
- **What a stopped session costs: nothing.** No worker, no control client, no hub subscription, no timer, no read.
  (The reaper and self-check still look at stopped sessions until stage 4; §1.7.)

### 3.2 Inside a worker: events first, a slow backstop always

- **Pane**: the attached client (`tmux -C attach-session -t =<session> -f ignore-size,read-only`) delivers
  `%output` for that session's pane. A notice arms a **settle** (150 ms), then an in-band `activity` query
  and a visible `capture-pane` on the SAME client. Verified on tmux 3.6a (2026-10-22, private socket): in-band
  `capture-pane -p` and `display-message -p` answer on a `read-only` control client; `%output` arrives for the
  attached session's pane and never for another session's; killing the session yields `%sessions-changed` then
  `%exit`. **`read-only` did NOT refuse an in-band `send-keys`** — the flag guards keyboard input, not control
  commands — so the worker's control adapter sends only commands on 1c's read allowlist
  (`controlCommandLine`, `src/lib/tmux/control-protocol.ts:123-146` on that branch) and mutations stay on main. Captures are throttled to one per `TURN_WATCH_INTERVAL_MS`
  (2 s) so a spinner that prints continuously costs what one tick costs today and two-frame confirmation sees
  frames as far apart as now.
- **Two-frame confirmation** (`service.ts:85`): when a step proposes a change, the worker schedules a confirming
  observation at +2 s even if no event arrives — so a turn that ends and goes silent still confirms.
- **Transcript**: a `file` notice → read the appended bytes from the last offset (the tail reader's windows only on
  a rewrite/rotation) → step.
- **Backstop**: one observation every 30 s regardless (pane + `stat`), so a missed event delays a transition by at
  most one backstop, never forever. The profile's `limitations` names any session whose hub subscription is
  `live() === false` (polled) or whose attached client is down (falling back to a 2 s in-band poll).
- **Liveness**: every 30 s (`WARDEN_LIVENESS_TICK_SECONDS`) a sample from data the worker already holds, plus the
  process tree: Linux walks `/proc/<pid>/task/*/children` (no exec, 1c's `descendants`); macOS runs one
  `ps -o pid=,ppid=,etime=,args= -g <pgid>` per ACTIVE session (§6.4).

### 3.3 Crash and restart

Modelled on `WorkerTranscriptFolds` (`src/adapters/analytics/worker-transcript-folds.ts:92-116`) but long-lived:

- `onerror`, an unexpected `close`, or a `request` timeout → the host bumps the session's **generation**, rejects
  its pending requests (callers fall back to today's main-thread path for that one call — the read path projects,
  the tracker reads), and ignores any later message from the old generation.
- Restart with back-off 1 s, 2 s, 4 s … capped at 60 s. Five crashes of one session within 10 minutes → that
  session is hosted by `InlineObserverHost` on the main thread (the 3a code, kept) until the next daemon start, and
  the daemon raises one notice naming the session and the last fault. Behaviour stays correct; only the cost
  moves back. A crash of a pooled worker restarts every session it hosted under the same policy.
- A patch is applied at most once: `seq` is monotonic per generation and the applier drops a `seq` it has applied.

### 3.4 Memory, cap and pooling — measured

Measured on the Linux dev box (Bun 1.3.13, 2026-10-22), RSS delta of the daemon-like host per spawned worker,
after GC:

| Worker program                                                                                               | From source (`bun fyd.ts`)            | Bundled (what the compiled binary ships) |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------- | ---------------------------------------- |
| bare (`postMessage` only)                                                                                    | 9.4 MB first, 3.3–3.7 MB each at 8–16 | —                                        |
| **lean**: turn policy, pane/permission/dialog parsers, tail reader, question projection — type-only protocol | 61 MB each                            | **3.9 MB each** (12 KB bundle)           |
| the same + `SessionStateSchema` (pulls zod + the protocol schemas)                                           | 62 MB each                            | 15 MB each (370 KB bundle)               |
| the whole `session/{turn,question,send,monitor,transcript}` + `tmux` + `transcript` barrels + schema         | 61–64 MB each                         | 19 MB each (500 KB bundle)               |
| zod alone                                                                                                    | 15 MB each                            | —                                        |

Readiness: ≈6 ms bundled-lean, ≈55 ms bundled-heavy, ≈140 ms from source.

Consequences:

- **The worker carries no zod and no value import of `@ferretry/protocol`.** That is why main pushes parsed
  `facts` (§2.2) and why `protocol.ts` is hand-typed. Every module the worker imports already uses
  `import type` for protocol (`turn/policy.ts:25-31`, `tmux/permission-prompt.ts:1-7`, `question/projection.ts:1`,
  `transcript/reader.ts:14`) — keep it so, enforced by the diet test (§4.4).
- **Estimate for the real worker**: lean + the observer + the control-protocol parser + a transcript window of up
  to 400 events ≈ **5–10 MB** shipped. From source (dev, tests) ≈ 60 MB, which is why integration tests share one
  worker across cases where they can.
- **Cap: 8 dedicated workers** (`daemon.json` `sessionWorkers.max`, default 8, min 1). Up to 8 live sessions get one
  thread each — the owner's "1 thread per agent". Above 8, no new threads: session 9+ is attached to the
  least-loaded existing worker (load = hosted sessions, ties by recent parse ms). A worker hosts a
  `Map<session, ObserverState>`, so pooled and dedicated are the same program. When live sessions fall back to ≤ 8,
  the planner moves pooled sessions to fresh dedicated workers one at a time (a move is `detach` + `attach` with a
  new generation; the observer re-derives, which is what a restart does today).
- Budget at the cap: 8 × ≈8 MB ≈ 64 MB worst case shipped, held by a memory budget in the idle-budget test (§5).

## 4. Testability

### 4.1 The domain is a pure service; the thread is a transport

- `src/lib/session/observer/` (unit ledger):
  - `SessionObserver` — a stateless service. `step(state: ObserverState, input: ObserverInput, now) →
{state, patches[], samples[], answers[]}`; `ObserverState` is a frozen record (previous observation, tail
    window + offset, frame digest, pending confirmation, send watches). This is the doctrine's "every changing value
    through parameters and return values" (`docs/standards/stateless-oop-di/index.md`), and it is what makes pooling
    free: a host is a map of states.
  - Its reads are ports: `ObserverPane` (`activity()`, `visible()`), `ObserverTranscript` (`appended(from)`,
    `window(limit)`), `ObserverProcesses` (`tree(panePid)`), `ClockPort`. The 3a extraction reuses the existing
    pure functions unchanged — `observeTurn`/`settleTurnState`/`turnStatePatch` (`turn/policy.ts`),
    `projectStructuredQuestion`, `reconcileAnswerEvidence`, `projectObservedRuntime`, `foldLivenessSample`'s
    sample shape, `TranscriptSendEvidence`'s matching.
  - `plan.ts` (`planSessionWorkers`) and `protocol.ts`.
- `src/adapters/session/observer/` (integration ledger): `InlineObserverHost`, `WorkerObserverHost`,
  `WorkerSupervisor`, `SessionObservationApplier` (the CAS + journal code moved out of `StorageTurnPorts.record`
  and `bin/fyd.ts:7688-7714`, unchanged in behaviour), and the worker-side adapters (`ControlClientPane` over 1c's
  `control-protocol.ts`, `TailFileTranscript`, `ProcTree`/`PsTree`).
- `bin/session.worker.ts`: wiring only — construct ports, hold `Map<session, ObserverState>`, `self.onmessage`
  dispatch, catch everything and post `fault` (the `analytics-fold.worker.ts:30-44` shape). Excluded from coverage
  like every `bin/`.

### 4.2 Unit tests drive the domain without threads

`tests/unit/session/observer/*.test.ts` call `step()` with scripted inputs and fake ports and assert the patches —
including every case `tests/unit/session/turn/service.test.ts` covers today (interval, dialog, permission,
harness-dialog, two-frame confirmation, clear-when-not-live, failure isolation, refusal, pruning, no-overlap) and the
question/monitor cases of `tests/unit/session/monitor/service.test.ts`. The supervisor and host are tested with the
`ScriptedWorker` pattern (`tests/integration/analytics/worker-transcript-folds.test.ts:43-63`): crash → generation
bump → back-off; late reply from an old generation ignored; request timeout falls back; five crashes → inline.

### 4.3 Parity: today's tests, unchanged, against the worker host

- **The composition root uses `WorkerObserverHost` by default from 3b on**, so every test that boots `start()` —
  `tests/integration/runtime/answer-journey.test.ts` (including the #689 case at `:861`), `stall-attribution.test.ts`,
  the SIT journeys — runs against workers without edits.
- The adapter-level suites that exercise the moved behaviour — `tests/integration/session/turn/storage-turn-ports.test.ts`
  (real tmux, real parsers, restart re-derivation `:407`), `tests/integration/session/monitor/monitor-adapters.test.ts`,
  `tests/integration/session/send/send-tracking.test.ts`, `tests/integration/session/live/storage-live-activity.test.ts`
  — get a `describe.each([['inline', inlineHost], ['worker', workerHost]])` wrapper around their existing bodies.
  The bodies do not change; a body that has to change says why in the PR.
- A **parity suite** (`tests/integration/session/observer/parity.test.ts`) replays recorded scenarios (a Claude turn,
  a Codex turn, a structured question answered/unanswered, a permission prompt, a send delivered/queued/typed) into
  both hosts against real storage and real tmux and asserts the same `turn.*`/`interaction.*`/`control.send_*` journal
  sequence and the same final `state.json`.

### 4.4 Compiled-binary embedding

- `bin/session.worker.ts` is picked up by the existing glob of `*.worker.ts` beside the entry
  (`scripts/release/compile-executable.ts:39-43,184-188`); add `'session'` to `BundledWorkerName`
  (`src/adapters/runtime/bundled-worker.ts:17`) and resolve it with `bundledWorkerUrl('session')` (`:23`).
- It answers `{probe: true}`; `fyd --check` probes it beside analytics and pdf-decrypt (`bin/fyd.ts:7553-7556`), so
  `scripts/release/smoke.sh:136-142` fails a binary whose `workers` line does not end in `ready`.
- **Diet test** (`tests/integration/session/observer/worker-diet.test.ts`): `Bun.build` the worker entry with the
  release options and fail if the bundle contains zod, `bun:sqlite`, `session-storage`, or exceeds 256 KB — so the
  4 MB worker cannot silently become a 19 MB one, and the worker cannot grow a storage handle.
- **Smoke beyond probe**: the probe only proves the module loads. `fyd --check` also attaches the worker to a
  synthetic session over a throwaway tmux socket and requires one `patch.turn` back, so a binary whose worker cannot
  spawn tmux or read a file fails CI, not a user.

## 5. Staging — four PRs, each behaviour-identical

Numbers below are the expected shape on the owner-scale fixture (36 sessions, 5 running) and are **to be measured**
by each PR with `fy daemon profile` (the parent doc's rule). "After 1c/2" is the assumed baseline when stage 3 starts.

| PR     | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                | Ships behind                                          | Expected idle delta (5 running)                                                                                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pre-3c | Fix the lifecycle repository's unlocked merge (§2.4). Tiny, independent; can land first.                                                                                                                                                                                                                                                                                                                                                               | nothing                                               | none                                                                                                                                                                                                       |
| **3a** | Extract `SessionObserver` (turn + question + runtime + liveness sample + send evidence) as a pure per-session fold with ports; `SessionObservationApplier` owns the CAS/journal writes; the `facts` hook in `updateDocument`; `InlineObserverHost` drives it from the EXISTING timers (2 s turn, 15 s monitor question pass, 30 s liveness). Main pushes facts, so the turn loop stops `readState`-ing all 36 sessions every 2 s.                      | nothing (same timers, same thread)                    | state-doc reads −36×0.5/s; one tail parse instead of 3–4 readers; main CPU slightly down; children unchanged                                                                                               |
| **3b** | `bin/session.worker.ts`, `WorkerObserverHost`, `WorkerSupervisor` (cap 8 + pooling + back-off + inline fallback), probe + diet test + smoke. **Turn part only** runs in workers; each worker owns its session's attached `tmux -C` client and captures in-band, still on the 2 s cadence. Question/liveness stay inline.                                                                                                                               | `sessionWorkers.enabled` default **on**; `false` = 3a | turn-watcher children → 0 (5 long-lived `tmux -C` clients instead); main-thread profile loses every `capture`/pane-parse frame; RSS +≈40 MB (5 workers) — memory budget added                              |
| **3c** | Event-driven inside the worker: `%output` settle + 2 s throttle + confirmation re-look + 30 s backstop; `file` notices from the hub; question/runtime, liveness sample, send-evidence and live readout move in; read-path `barrier`; main's monitor keeps the parks pass only.                                                                                                                                                                         | same flag                                             | transcript `stat`/tail parse on main: 0/s idle; `ps` per active session per 30 s off main (Linux: 0 execs); syscalls/s down by the per-session `statx`/`read` loop; an idle agent (no output) costs ≈0 CPU |
| **3d** | Delete the main-thread loops: the turn `setInterval`, the monitor question pass, the Warden liveness collection, the live capture sampler; the exit observer's per-running-session tmux calls replaced by the worker's `exited` (self-check keeps the sessions without a worker); the reaper sweeps on `exited` with a slow backstop. Inline host kept only as the crash fallback. Tighten budgets: main-thread profile "no parse/capture frame idle". | flag removed                                          | main-thread CPU idle ≈ carriers + lag meter only; children/min idle ≈ 0 on Linux (≤ 10/min on Mac from `ps`); per-worker CPU visible in the profile                                                        |

Every PR keeps the full suite green against the default host, and 3b–3d also against `sessionWorkers.enabled:
false`, until 3d deletes the inline loops (the inline host stays tested as the fallback).

Baseline arithmetic for the table: today a running session costs, every 2 s, `has-session` + `display-message` +
2 `capture-pane` = 120 children/min, ×5 = 600/min from the turn watcher alone, plus 1 `ps` per working session per
30 s, plus the reaper's per-registration `display-message` every 5 s. 1c removes the scrollback capture and most of
the rest; 3b removes the remainder for running sessions by making captures in-band on a client that already exists.

### 5.1 What 3b shipped, and where it differs from the table

- `bin/session.worker.ts` (≈160 KB unminified, ≈83 KB minified; no zod, protocol schemas, storage, vault or
  redactor — held by `tests/integration/session/observer/worker-diet.test.ts`), `WorkerSupervisor` (cap 8 then
  least-load pooling, probe-ready, generations, 1 s → 60 s back-off, five crashes in ten minutes → inline) and
  `WorkerObserverHost` over the 3a inline host. `sessionWorkers: { enabled: true, max: 8 }` in `daemon.json`.
- **Which sessions get a worker**: the turn statuses (running, thinking, tool_running, awaiting_user,
  awaiting_question, interrupted) with an attachable tmux session — not yet the wider live set of §3.1, which
  matters only once the question part moves (3c).
- **The attached client is `ignore-size,read-only,no-output`** and refuses every non-read command itself
  (`ControlModeTmuxProcess` with `mutations: 'refuse'`). `no-output` until 3c reacts to `%output`.
- **The turn tick still drives the workers** (main sends one `look` per hosted session per 2 s tick and writes
  the answers); the worker owns the pane client, the frame cache, the parsed tail and the two-frame state.
- **Per-worker memory is not attributable in Bun**: `heapStats()` is shared across worker VMs and `rss` is
  process-wide (measured). The memory budget is therefore on the shipped bundle — five bundled workers add
  ≈7.4 MB each (≤ 15 MB held by the diet test); run from source a worker costs ≈67 MB.
- Not in 3b: the `fyd --check` synthetic-attach smoke (§4.4), a per-worker CPU reading (§8 Q6), the read-path
  barrier and `%output` settle (3c).

## 6. Risks

### 6.1 Ordering (#689)

The invariant #689 restored: on boot, question reprojection must land before the turn watcher writes turn state
over the same `state.json`, or a read just after an unconfirmed answer misses `needsHuman` (CI case
`answer-journey.test.ts:861`). With workers:

- Inside one observer step, `question` runs before `turn`, and the worker posts `patch.question` before
  `patch.turn`. `postMessage` is FIFO per worker; the applier applies one session's patches serially under the
  storage lock. So the order holds for every step, not only the first.
- The first step after `attach` is always a full question projection, posted before any turn patch.
- The boot `await` at `bin/fyd.ts:9917` becomes "await every attached worker's first `patch.question` ack, or 5 s".
  It keeps the boot-progress semantics (`progress.enter('declared-wait watcher')`) and the 200 ms boot-loop budget
  from #690, because the main thread only waits; it parses nothing.
- The read barrier (§2.5) gives the CI read what the read-path projection gives it today.

### 6.2 Backpressure

- Coalesce at the source: at most one un-acked patch per (session, kind). A newer turn observation while one is in
  flight replaces the pending one (today's 2 s poll drops intermediate transitions the same way). The ack carries
  fresh `facts`, so the next patch's `from` is current and the CAS rarely refuses.
- Main never queues unboundedly: patches per session are applied serially; a worker that out-produces the
  applier simply holds one pending patch per kind.
- Requests are bounded by the existing 3 s read budget; a slow worker degrades a read to durable state, it does not
  stall a route.
- `%output` floods (a build log): the worker's settle + 2 s throttle caps captures; the bytes themselves are dropped
  after a "dirty" bit is set — the worker never buffers pane output.

### 6.3 Structured-clone cost

Every message is a few hundred bytes; the biggest is a structured question with its options. The `metrics` message
reports `posted.bytes` so the profile shows it; the budget test fails if idle traffic exceeds 10 KB/s for 5 running
sessions. No message carries transcript events, pane text, or a whole document — the diet of §2.3 is the rule the
reviewer checks.

### 6.4 macOS

- **Exec cost**: each `ps` is an endpoint-security inspected exec. The design spends one long-lived `tmux -C`
  process per running session (one exec at attach, not per tick) and, on Mac only, one `ps -g` per ACTIVE session
  per 30 s (≤ 10/min at 5 running). If that is still too much on the corporate Mac, the fallback is one fleet `ps`
  per 30 s on the housekeeping worker (stage 4) answering every session worker — §8 Q4.
- **File events**: the hub runs on main and uses Bun `fs.watch` (FSEvents/kqueue) on macOS; names starting with `.`
  or `~` are reported as unreported (`bun-file-event-source.ts`), falling back to the 5 s poll. Transcripts are not
  dot-files, but the Mac coalescing behaviour still has to be verified before 3c relies on it (the parent doc's
  open item for stage 2).
- **Worker memory** was measured on Linux only; measure the compiled binary on the owner's Mac before 3b ships the
  cap.
- `tmux -C attach -r` behaviour on the Mac's tmux (Homebrew 3.5/3.6) must be verified to deliver `%output` for the
  attached session exactly as tmux 3.6a does here.

### 6.5 The profiler must still see the work

- Verified 2026-10-22: `process.cpuUsage()` includes worker threads (a worker spinning 1 s shows ≈1,034 ms of process
  CPU on main), so the CPU budget keeps counting. But the stage-0 `Bun.spawn` counting wrapper **is not visible
  inside a worker** (a worker's `Bun.spawn` is its own global), and neither is the state-port counting proxy. The
  worker therefore installs the same instruments from `src/adapters/runtime/performance-instruments.ts` and reports
  deltas in `metrics`; without that, moving the work would hide it from `fy daemon profile` and make the budgets lie.
  This is a 3b exit criterion.
- The main-thread CPU profile (the sampled stacks) is main-only by construction; that is the stage-3 exit criterion
  ("no parse or capture frame"). Per-worker CPU on Linux can be read from `/proc/self/task/<tid>/stat` by name;
  report it under `workers` (§8 Q6).

### 6.6 Other risks

- **An extra attached tmux client** keeps a session "attached" in tmux's eyes. Nothing in the daemon reads
  `session_attached`/`list-clients` (checked), and `ignore-size` keeps the window size the human's client chose. A
  user tmux config with `destroy-unattached` would see different behaviour; the daemon owns its tmux server and its
  config, so pin the option off there.
- **A control client can mutate the pane.** Because `read-only` does not stop in-band `send-keys` (§3.2), a bug in
  the worker could type into an agent. The allowlist is the guard; a unit test feeds every non-read command to
  the worker's control adapter and requires a refusal.
- **Shutdown order**: workers drain (≤ 1 s) and terminate before storage closes; cleanups are registered after the
  storage open, so they run first. A patch arriving after storage closed is dropped and logged, never written.
- **Transcript resolution stays on main** (Codex rollout discovery reads every session's claims). It runs only until
  a session's transcript is bound, then never again for that session; it moves to the housekeeping worker in stage 4.
- **Pooled sessions share a fault domain**: one pathological transcript can crash the up-to-k sessions in its pool
  worker. The back-off restarts them; the five-crash rule isolates the offender to inline hosting.

## 7. What each in-flight stage provides, and what stage 3 needs from it

| Stage                                 | Provides (as of 2026-10-22)                                                                                                                                                                                                                                                                                                      | Stage 3 needs                                                                                                                                                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1a `perf/state-document-cache` (#693) | `FileSystemPort.readTextIdentified?`/`identity?` (`src/lib/ports.ts:64-85`), `DaemonStorage`'s private identity cache (`session-storage.ts:190,897-953`)                                                                                                                                                                         | Nothing new: main keeps reading documents; the `facts` hook sits beside `forgetDocument` in `updateDocument`.                                                                                                                          |
| 1b #691 (merged)                      | shared-walk prover for the session file index                                                                                                                                                                                                                                                                                    | Nothing; main-only.                                                                                                                                                                                                                    |
| 1c `perf/tmux-child-processes`        | ONE shared `ControlModeTmuxProcess` (`attach-session -f ignore-size,no-output` to the first non-terminal session); `TmuxControlNotification` kinds `output`, `sessions-changed`, `session-changed`, `window-close`, `pane-mode-changed`, `subscription-changed`, `exit`, `other`; `TmuxEventSource.subscribe(listener, filter?)` | **Per-session attached read-only clients are not built yet** — stage 3b builds them in the worker from 1c's `control-protocol.ts` parser. **`%pane-exited` is untyped (`other`)** — 3d needs it typed. The shared client stays main's. |
| 2 `perf/fs-event-hub`                 | `FileEventHub.subscribe(path, listener) → {live(), close()}` with re-stat on any event, refcounted directory watches, 5 s poll fallback, `fallbacks()` (`src/lib/file-events/hub.ts:113-194`)                                                                                                                                    | Main subscribes each live session's transcript and `answers.jsonl` on the worker's behalf and forwards `file` notices; `fallbacks()` must reach the profile's `limitations` (nothing reports it yet).                                  |

## 8. Open questions for the owner

1. **Cap**: 8 dedicated threads then pooling into those 8 — or a higher cap now that a lean shipped worker is ≈4 MB
   (16 would cost ≈ 130 MB worst case)?
2. **Exit detection speed**: 3d makes a dead pane settle within ~1 s (the attached client's `%exit`) instead of up to
   30 s. That is a visible behaviour change (faster `session.exited`, faster Warden `paneDied`). Accept it in 3d, or
   keep the 30 s cadence for parity and change it separately?
3. **Transcript resolution** (Codex rollout discovery) stays on main in stage 3 and moves to the housekeeping worker
   in stage 4 — agreed, or pull it into stage 3?
4. **Mac subprocess liveness**: per-session `ps -g` from each worker (≤ 10/min at 5 running), or one fleet `ps` per
   30 s answered by the housekeeping worker (needs stage 4 first)?
5. **Command-time pane polling** (send delivery, answer driver, interrupt: 250 ms polls while a command runs) stays
   on main in stage 3. Should a later PR feed it from the worker's frames, or is user-initiated bounded polling fine?
6. **Per-worker CPU in the profile**: worth reading `/proc/self/task/*/stat` on Linux to attribute CPU per session
   worker, or is process CPU + main-thread profile enough?
7. **Flag**: 3b ships workers **on** by default with `sessionWorkers.enabled: false` as the escape hatch. Do you want
   it off by default for one release instead?
