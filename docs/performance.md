# Performance reports

When a machine feels slow, measure it, then send the report.

```bash
fy daemon profile                       # 30 s, printed as a readable report
fy daemon profile --seconds 60 --out report.json
fy daemon profile --trace-syscalls      # also count system calls from outside (asks for sudo)
```

Leave the machine idle while it runs if the question is "why is it slow when nothing is happening".

## What the report says

Every number covers only the window it measured.

- **Budgets.** What an idle daemon may cost, with each line marked `ok` or `OVER`.
- **CPU, memory, system calls, context switches** for the daemon process. Children's CPU and read/write
  system calls are measured on Linux only.
- **Event loop.** How late its timer ticks fired (p50, p95, max), and the longest stalls with what was
  running and where the sampled stack spent the time.
- **Hot functions and stacks.** Where the main thread's samples went: what the CPU time was spent on.
- **Child processes** per minute, by program and subcommand (`tmux capture-pane`, `ps`).
- **Timers and background work** (the turn watcher, the declared-wait watcher, analytics, …): how often
  each ran and how long it took.
- **Routes**, by pattern (`GET /v1/sessions/:id`): count, latency, errors and bytes.
- **File operations** through the daemon's state-home port, by path shape.
- **Workers**: how many requests each worker thread held.
- **System calls** (with `--trace-syscalls`): `strace` on Linux or `sudo fs_usage` on macOS, by call and
  path shape, plus every program started.
- **What this report cannot see**, said out loud so a gap is never read as a zero.

## Session workers

Every running session is observed off the daemon's main thread by a **session worker**. The worker
watches the session's pane through its own read-only tmux client, follows its transcript, and works out
its turn, questions and liveness. The main thread only writes what the workers report and serves
requests: it runs no observation loop of its own.

The workers form a **pool**, set in `config/daemon.json`:

```json
{ "sessionWorkers": { "max": 2, "fastExit": false } }
```

- **`max`** is the number of worker threads. The default is **2**. Each running session gets its own
  thread until there are `max` of them. After that, each new session joins the least-loaded thread.
- **One thread per agent:** set `max` at or above the number of sessions you run at once (up to 64).
- **`fastExit`** settles a session whose agent exited as soon as its worker sees the pane die. The default
  is **false**: the exit is settled by the next 30-second self-check, as before session workers.
- **`enabled`** is retired. Every running session has a worker. The main thread observes a session only
  while it has none — starting, backing off, or after its worker crashed five times in ten minutes. A
  daemon that still reads `enabled: false` boots normally and says once that the key can be deleted.

Why 2 is the default: on the owner-scale fleet (36 sessions, 5 running), a thread per session cost +72 MB
of memory over the main thread, because each thread carries about 14 MB of engine. One shared thread cost
+18 MB and the least CPU. Two keep one slow session from holding up all the others, at close to that cost.

`fy daemon status` shows the pool, and so does every performance report:

```
  session workers pool of 2 · 2 threads observing 3, 2 sessions
```

Restart the daemon after changing the setting: `fy daemon restart`.

## A busy disk

When other programs keep the disk busy, writing a file and waiting for it to reach the disk (`fsync`)
can take seconds. The daemon keeps that wait off its main thread, so it stays responsive.

- **The session index** (`state/index/sessions.sqlite`) is read from a copy in memory. A separate
  thread, the **session index writer**, writes changes to the file in batches, a quarter second after
  they happen (later only while the previous batch is still being written). Before this, one write on a
  busy disk froze the daemon for up to 38 s.
- **The analytics index** (`state/index/analytics.sqlite`) works the same way, with its own thread, the
  **analytics writer**. It is read from a copy in memory, and the sweep that ingests finished sessions
  writes its rows there at once. The file is written a quarter second later, a whole batch in one
  transaction, so a batch lands completely or not at all. Before this, one sweep on a busy disk held
  the daemon for the length of its commit (CI saw 307 ms at boot; 1.5 s commits froze it for 1.5 s).
  It is a separate thread from the session index writer on purpose: a slow analytics commit never
  holds up the session index, and a failure in one never retires the other. The thread keeps no file
  open between batches, so it ends itself after a minute without work.
- **What a crash or power cut can lose:** only the index's last few writes, never a session's history.
  Every event is saved in its session's journal first, and that journal is synced to disk. On the next
  start the daemon checks the index against every journal and fills in anything missing.
- **What a crash loses from analytics:** the rows of sessions that finished in the last few seconds.
  The analytics index is disposable. Every row is rebuilt from the session's own records and
  transcript, and the next start's sweep writes again each one that is missing, so a crash costs one
  re-ingestion of those sessions and nothing else.
- **Screenshots in a transcript** are not read into memory. A pasted image is one record of several
  megabytes, nearly all of it base64. The daemon remembers where those bytes are in the file instead of
  loading them; nothing it shows today displays them.
  Asking for one (`GET /v1/sessions/:id/transcript-images/:handle`) reads only that record, proves it
  is a PNG, JPEG, GIF or WebP from its first bytes, and checks the base64 in slices that hand the event
  loop back between them. It remembers the proof (where the bytes are, never the bytes) for the last
  128 handles, and proves at most two at a time. Measured on a 100 MB transcript holding a 2.75 MB
  base64 screenshot (three runs unthrottled, three under `MemoryHigh=250M`): the longest event-loop lag
  was 5–12 ms for a first request and 1–6 ms from a remembered proof, against the 200 ms budget; for
  comparison the transcript window was 23–108 ms and the history listing 26–41 ms. The guard is the
  image case in `io-pressure-transcript.test.ts`.
- **Transcripts are parsed on their own thread**, the **transcript worker**. That covers reading a
  window of a transcript, a whole read, a session's tail, the conversation behind a messages page, an
  image from a transcript, and the history and import listings. The worker runs the same readers the
  main thread used to, and sends the answer back in small pieces, so the main thread only ever receives
  one piece at a time. The conversation index (which proves each message against the bytes it came
  from) is built in the worker too, from the bytes the worker itself read. The thread holds about
  23 MiB on its own. Measured on a 100 MB transcript without a memory cap, the longest the main thread
  was held went from 60–130 ms to under 40 ms. The guard is `io-pressure-transcript.test.ts`, which
  also runs with memory capped and prints each path's longest block on a `TRANSCRIPT-BUDGET` line.
- `fyd --check` lists `session-index`, `analytics-index` and `transcript-parse` with the other workers.
  If one of these threads fails five times in ten minutes, the daemon does its work on the main thread
  instead and says so once in its log.

The guards are `packages/daemon/tests/integration/runtime/io-pressure-index.test.ts` and
`io-pressure-analytics.test.ts`. They make every disk write take 1.5 s, and check that the event loop
(and, for the session index, a health check) stays under 200 ms. For the analytics index the same
test shows the old behaviour first: a 1,500-row sweep committing on the main thread stalled the loop
for 1,520 ms; with the writer thread the longest stall was about 85 ms.

## Safe to share

The report contains no session text, no command arguments, no file contents and no secrets. Each item
is reduced to its shape:

- a file: `~/.ferretry/state/sessions/<session>/state.json`, or `~/…/.mcp.json` for a file in one of your
  own folders;
- a program: `tmux capture-pane`;
- a route: `GET /v1/sessions/:id`;
- a stack: function names and the workspace-relative file they are in.

You can read the whole report before you send it.

## The same report elsewhere

- `GET`/`POST /v1/diagnostics/profile` is the route behind the command. It is operator-scoped, and the
  profile is started first and read afterwards, so a dropped relay connection does not lose the window.
  Schemas live in `packages/protocol/src/lib/performance.ts`.
- `scripts/local/bench-idle-daemon.ts` builds the owner-scale fleet (36 sessions, 5 running in real tmux
  panes, 2,000 Codex rollouts) and measures any `fyd` build from inside and outside. Use it for the
  before/after table in a performance PR.
- `packages/daemon/tests/integration/runtime/idle-budget.test.ts` holds the idle daemon to CI ceilings.
  A PR that makes something cheaper lowers that ceiling in the same commit. Ceilings only go down,
  towards the targets in `packages/daemon/src/lib/performance/budgets.ts`.

The staged plan for meeting the targets is [docs/design/event-driven-daemon.md](design/event-driven-daemon.md).
