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
