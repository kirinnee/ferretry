# The event-driven daemon — staged plan

Status: **adopted target design** · Date: 2026-10-21 · Owner directive, verbatim: _"use things like
inotify, 1 thread per agent, fan into the daemon (daemon should just communicate)"_.

The daemon lags because its main thread does everything: it serves every carrier, AND it polls every
session on timers — tmux capture, `ps`, transcript tails, state documents — parsing on the same loop
that should be answering the phone. This document is the target shape and the order of the stages
that get there. Every stage keeps behaviour identical (all tests and ledgers green) and reports
before/after numbers from `fy daemon profile` on the owner-scale fixture and on a live daemon.

## 1. Measured starting point (4.66.3)

A live daemon on the Linux dev box (~45 sessions, ~5 running), traced read-only for 20 s:

| What                   | Rate                                                                                                                                                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CPU, children included | ~19% of one core, idle                                                                                                                                                                                                                                           |
| Child processes        | ~23/s (~1,400/min): `tmux display-message` 12.7/s, `capture-pane` 7/s (half of them **full scrollback**, `-S -`), `has-session` 3.5/s, `ps -Ao` every 2.5 s                                                                                                      |
| File system calls      | ~8,800/s. ~40% are the dynamic linker loading tmux for those children; ~35% are `statx` of the state home's ancestors (`~/.ferretry`, `state`, `sessions`, `<session>`) for every document read; the rest re-read `session-version`, `config.json`, `state.json` |

Per running session every ~2 s the turn watcher runs `has-session` + a metadata `display-message` +
two `capture-pane` (full history and visible). Per stopped session every ~5 s something still asks for
its pane identity. On the owner's corporate Mac, where endpoint security inspects every exec and every
file open, the same work blocked the loop for up to 10.6 s.

## 2. Target shape

```text
                 ┌──────────────── main thread: COMMUNICATES ────────────────┐
  carriers  ───► │ HTTP · relay · WebRTC · tunnel · auth/grants · routing     │
                 │ fan-in of worker diffs → session index → event broadcast   │
                 │ owns ONE shared tmux -C query client + ONE fs-event hub    │
                 └───────┬───────────────────────┬──────────────────┬─────────┘
                         │ per-pane events,       │ compact state    │ jobs
                         │ per-path events        │ diffs / events   │
                 ┌───────▼────────┐  ┌────────────┴───┐     ┌────────▼────────┐
                 │ session worker │  │ session worker │ …   │ housekeeping    │
                 │ (one per       │  │                │     │ worker(s):      │
                 │  RUNNING agent)│  │                │     │ analytics, fleet│
                 │ tail parse,    │  │                │     │ refresh, pricing│
                 │ turn/question/ │  │                │     │ catalog         │
                 │ declared-wait, │  │                │     └─────────────────┘
                 │ liveness, pane │  │                │
                 │ observation,   │  │                │
                 │ delivery check │  │                │
                 └────────────────┘  └────────────────┘
```

- **No polling.** Files are watched with OS events (inotify on Linux, FSEvents/kqueue on macOS, through
  Bun's `fs.watch`). Terminals are observed through tmux control mode (`tmux -C`: `%output`,
  `%pane-exited`, `%window-close`, `%session-changed`, `%exit`) rather than periodic `capture-pane` and
  `ps`. A slow poll survives only where events are unsupported, and says so in the profile.
- **One Worker per RUNNING session.** It owns that session's watchers, transcript tail parsing,
  turn/question/declared-wait detection, liveness, pane observation and delivery confirmation, and posts
  compact diffs to the main thread. A stopped session has no worker.
- **The main thread only communicates.** No file parsing, no child-process loops. The budget test asserts
  it from the sampled CPU profile: no parse frame on the main thread while idle.
- **Housekeeping in its own worker(s)**, extending the `analytics-fold` worker (#690).

### Facts this plan rests on (measured 2026-10-21)

- A bare Bun Worker costs **3–10 MB RSS** (10 MB for the first, 3.2 MB each at 36). A session worker
  loading the transcript parsers and zod will cost more — stage 3 measures it and pools above a cap
  (start: one worker per running session up to 8, then a pool of 8).
- Linux `fs.watch` (inotify) delivers one `change` per append to a JSONL transcript, but an **atomic
  write** (write a temp file, rename it over) reports only `rename:<temp name>` — never the final name.
  Watchers therefore treat any `rename` in a watched directory as "re-stat what you care about here".
  macOS behaviour (FSEvents coalescing, kqueue's one descriptor per file) must be verified on a Mac
  before stage 2 relies on it; the default inotify limits here are 1,048,576 watches / 1,024 instances.
- A tmux control client receives `%output` notifications, and `refresh-client -B` subscriptions, only
  for panes of the session it is ATTACHED to (verified on tmux 3.6a by stage 1c; subscribing a pane of
  another session never fires). So the event source per agent is **one read-only, `ignore-size`
  control client attached to that session**, owned by that session's worker; one shared control client
  serves in-band queries for the whole server, and spawning remains only for mutations that need stdin.
- Every child process in Bun goes through `Bun.spawn`/`Bun.spawnSync` (including `node:child_process`),
  so the profiler counts children exactly. `node:fs` cannot be intercepted (named and namespace imports
  bind past any patch, and neither the runtime nor the bundler plugin API sees builtins), so file
  operations are counted at the daemon's own file ports and, from outside, by `--trace-syscalls`.

## 3. Stages

Each stage is one PR (or a short series) to `main`, merged before the next where they share files.

| #   | Stage                                                                                                                                                                                                                                                                                                                                         | Owner                                  | Exit criterion                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------- |
| 0   | **Measure**: `fy daemon profile`, the diagnostics route, the PWA recorder, the owner-scale fixture, CI budgets                                                                                                                                                                                                                                | perf-program lead                      | the owner can send a report; CI fails over budget          |
| 1a  | **State documents**: identity cache for marker/config/state reads, live-only watchers, pane-scan cache                                                                                                                                                                                                                                        | carry (`perf/state-document-cache`)    | state-doc opens ~0/s idle                                  |
| 1b  | **Prove once**: shared directory walk for the session file index (#691)                                                                                                                                                                                                                                                                       | tenley (`perf/mac-file-ops`)           | no per-file ancestor proof in a tick                       |
| 1c  | **tmux control mode**: one `tmux -C` client as the command transport AND a typed per-pane event stream; batched `list-panes`; no full-scrollback per tick; `ps` off the timer                                                                                                                                                                 | eleonora (`perf/tmux-child-processes`) | idle child processes ≤ 30/min (target ~0)                  |
| 1d  | **PWA idle**: polling → the event feed, hidden-tab back-off, idle budget test                                                                                                                                                                                                                                                                 | takara (`perf/pwa-idle-requests`)      | idle PWA ≤ 6–10 requests/min                               |
| 2   | **File events**: an fs-event hub on the main thread (one watcher per directory, refcounted, rename ⇒ re-stat, slow-poll fallback that reports itself); transcript and state readers become "read on event"                                                                                                                                    | next                                   | no timer reads a file whose watcher is live                |
| 3   | **Session workers**: a `session.worker.ts` (bundled like `analytics-fold`) per running session that takes over the turn watcher, declared-wait, question reconcile, liveness and pane observation for that session; the main thread forwards pane and file events and applies diffs. Design: [session-workers.md](session-workers.md) (3a–3d) | next                                   | idle main-thread CPU profile has no parse or capture frame |
| 4   | **Housekeeping worker**: analytics, fleet refresh, pricing and catalog on a worker; the background lane schedules it. Design: [housekeeping-worker.md](housekeeping-worker.md) (PR 0–4)                                                                                                                                                       | next                                   | housekeeping never appears in a main-thread stall          |
| 5   | **Budgets tightened** to the event-driven numbers (CPU, syscalls/s, children/min, max block, worker memory)                                                                                                                                                                                                                                   | lead                                   | CI holds the final numbers                                 |

Stages 1a–1d run in parallel because they own disjoint files. Stage 2 needs 1a (the document cache is
what "read on event" invalidates). Stage 3 needs 1c and 2: a session worker is fed the pane and file
events those stages produce, and carry's cache and tenley's prover slot into it as that worker's
readers.

**Session documents, read on event** (`perf/document-identity-on-events`). Stage 1a's identity cache answers an
unchanged `session-version`, `config.json` or `state.json` with one `stat` per read. A document read more
than once is now also watched through the file-event hub. While its watch is live and has heard nothing since
the identity was taken, the read costs no system call. The `stat` stays whenever the watch cannot vouch: the
directory is polled, or no hub is wired, as in the CLI. The daemon's own writes invalidate at once, before and
after the rename, so a read that ran alongside a write cannot keep the old file. An edit from outside the
daemon is seen once the hub hears it, within its 25 ms settle, where before it was seen on the next read. At
most 1,024 documents are watched.
On the idle fixture (`bench-idle-daemon.ts --small --trace --syscall-summary --seconds 60`), compared with
`origin/main` `9e456c0f0`:

- `statx` dropped from 55/s to 14/s: `session-version` from 16/s to 0, and `config.json` from 14.5/s to 1.8/s
  (what is left is the hub re-checking a running session's directory on its own writes).
- strace file calls dropped from 44.9/s to 14.7/s.
- Read/write system calls dropped from 100.5/s to 69/s.
- CPU did not change beyond noise.

## 4. Rules for every stage

- **Behaviour is identical.** Every existing test passes unchanged; a test that changes says why.
- **Numbers or it did not happen.** Each PR body carries a before/after table from `fy daemon profile`
  on the owner-scale fixture (36 sessions, 5 running, 3×200 MB transcripts, 2k Codex rollouts, 6
  runtimes) and on a live daemon.
- **A fallback is visible.** Wherever events are unavailable and a poll is kept, the profile's
  `limitations` says which and why.
- **Workers post diffs, not documents.** Structured-cloning parsed transcripts back to the main thread
  costs about what parsing does (#690); a worker sends the change to the session view, never the events
  it derived it from.
