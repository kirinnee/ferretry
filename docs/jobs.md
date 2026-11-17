# Background jobs (the job keeper)

A **job** is a non-interactive command that Ferretry keeps for a ferret, so a long watcher or build survives the agent being moved,
restarted or killed. This is parts 1 and 2 of three: the keeper and the `fy job` verbs (1), and how moves and restarts treat jobs (2, [below](#moves-and-restarts)).
The agent instructions are part 3 (see [What is not here yet](#what-is-not-here-yet)). **There are no hooks of any kind** — no Claude
PreToolUse rewrite, no TaskStop/KillShell hook, no Codex hook: agents are taught to use `fy job run` by instruction alone.

## Who owns what

| Thing               | Owner                                                                                                                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The **process**     | The **keeper**: a tmux session of its own on the daemon-owned tmux server, inside the ferret's limits scope (the same server, limiter and login shell as a [terminal](./processes.md); no second runtime) |
| The **exit record** | A small wrapper script running in that pane — **not the daemon**. It writes `exit.json` atomically when the job ends, so an exit is recorded even while the daemon is down                                |
| The **attachment**  | A `fy job attach` process (what `fy job run` becomes after it starts the job). It only streams the log. It can be broken at any time without touching the job                                             |
| The **registry**    | The daemon, in `job-attachments.json`: one `{pid, process start, job, Claude task id}` entry per live attachment                                                                                          |

A move keeps the session id and the tmux server outlives the daemon, so a moved or restarted ferret simply attaches again.
Everything the daemon reports about a job is **derived from the files and the tmux listing**, so a fresh daemon reads what the old
one did (the integration tests build a second service over the same folder to prove it).

## Where the files are

`<home>/state/terminals/jobs/<ferret>/<job id>/` (the kernel's state port owns the folder; the paths are not hard-coded):

| File         | Written by | Holds                                                                             |
| ------------ | ---------- | --------------------------------------------------------------------------------- |
| `job.json`   | daemon     | `{id, name, command, cwd, startedAt, startedBy}`, once, before the command starts |
| `output.log` | wrapper    | stdout and stderr of the job, appended, **capped at 64 MiB** (below)              |
| `exit.json`  | wrapper    | `{code, signal?, endedAt}`, atomic (temp file + `mv`)                             |
| `stop`       | daemon     | an empty file: "stop this job". The wrapper's watcher turns it into SIGTERM       |
| `tracked`    | wrapper    | the incarnations (`pid=start`) of the job's tree; the daemon's fallback reads it  |

State is **derived**: an `exit.json` means `exited`; otherwise a live tmux session means `running`; neither means `lost` (the host
rebooted or tmux was killed under it).

## Semantics

- The command runs as `<login shell> -l -c '<command>'` (the shell terminals use), in the caller's folder (the CLI sends its cwd),
  with stdin closed. The folder is never handed to tmux (tmux expands `#(…)` formats in `new-session -c`, so a folder named
  `#(cmd)` would run `cmd`): the session starts in `/` and the wrapper does `cd -- "$cwd"`, the folder arriving as a plain argv
  value. If the `cd` fails the job does not run; the error is in the log and the exit is recorded.
- **The log is capped at 64 MiB per job** (`JOB_LOG_CAP_BYTES`). stdout and stderr go through a bounded writer in the wrapper; once
  the log reaches the cap it appends ONE marker line (`[fy: output log reached N bytes; further output is dropped]`) and drops
  everything after, still draining the pipe so **the job keeps running and is never blocked**. The cap can be passed by at most
  one 64 KiB read. Retention (below) bounds the number of finished jobs; the cap bounds each one, so a runaway `yes` cannot fill
  the disk.
- After it exits the pane closes. The files stay (retention below).
- **A job is never idle-reaped.** The terminal idle deadline is not applied to jobs at all; a job ends when it ends, is stopped, or its
  ferret is removed from the machine's point of view (files age out).
- **Stopping** (`fy job stop`): the daemon writes `stop`; within about a fifth of a second the wrapper takes ONE snapshot of the job's
  whole **process tree** (children read from `/proc/<pid>/task/*/children` on Linux, `pgrep -P` elsewhere; no per-subtree re-walk), sends
  SIGTERM to every process in it, and **starts the 5 s KILL clock at that moment** — a slow host cannot push the deadline out, and
  the daemon's fallback below cannot be the thing that ends the job. At the deadline it looks once more for descendants born since
  (while their parent still lives) and sends SIGKILL to all of them. Each is tracked by its **incarnation** (pid plus start time: `/proc/<pid>/stat` on Linux,
  `ps -o lstart=` elsewhere; the wrapper keeps them in `<job>/tracked`), so a descendant reparented to any subreaper (init,
  `systemd --user`) is still followed and a reused pid is never signalled. **The wrapper does not record the exit while any tracked
  descendant is alive**, so a shell that dies on TERM cannot leave a child that ignored TERM running behind a recorded exit; if one
  survives even SIGKILL the wrapper keeps the job running, says so in the log once, and records the exit only when it is gone. A job
  that ignores TERM ends with code 137 / signal KILL.
  If the wrapper has not recorded the exit after 9 s (it is wedged, not slow), the daemon SIGKILLs every tracked process that is still
  the same incarnation, waits up to 2 s, and only then takes the pane down and records a KILL exit. If a tracked process is still alive after
  that, `fy job stop` fails saying which pids survived SIGKILL, the job stays `running`, and **no exit is recorded**.
  - **Escape boundary.** Out of reach: a process that detached itself (setsid, double fork) before the stop; and a child
    born DURING the stop window whose parent then exits before the next look (it is orphaned between two walks, so no walk from a live process
    finds it). A child born after the snapshot whose parent is still alive at the next look (the deadline, or the wrapper's own loop once
    the job shell is gone) IS found and killed — pinned by a test.
  - **macOS.** `ps -o lstart=` has one-second resolution and does not exclude zombies, so the incarnation check there is
    weaker than on Linux (where the start time is the kernel's tick count): a pid reused within the same second would pass as
    the same process, and a zombie reads as alive. It is not an absolute pid-reuse guarantee. The daemon's fallback acts
    only on Linux tick-count readings; on a start it cannot compare it never signals, and reports the process as still running.
  - Where the start time cannot be read the process is not tracked (and so not signalled): a documented degrade, never a guess.
- A signal death is recorded as the shell reports it: **128 + the signal's number**, and `exit.json` also names the signal
  (`"signal":"TERM"`). A command that itself exits 143 reads the same; the code is the fact, the name a convenience.
- Redaction: a command line and a log are text a secret can ride in, so every route that returns either is built inside one
  `Redaction.read`. A log is cut on line boundaries while the job runs, so a secret is never split between two polls (a secret that
  spans two lines is a declared gap, as for terminals).

## Caps and retention

| Limit                         | Value  | Notes                                                                                                                                                    |
| ----------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Running jobs per ferret       | 8      | Refused with a sentence naming the cap and `fy job stop`                                                                                                 |
| Running jobs on the machine   | 48     |                                                                                                                                                          |
| Terminal slots used           | 0      | Jobs are separate tmux sessions (`fy-job-…`, never listed as terminals); the terminal caps (6 / 24) are untouched, and a job does not count against them |
| Finished jobs kept per ferret | 50     | The newest 50 are kept…                                                                                                                                  |
| Finished jobs kept for        | 7 days | …and none older than 7 days. A sweep runs every 10 minutes and after each start                                                                          |

A **running** job is never deleted. The numbers are constants in `contract/jobs.ts` (not yet owner configuration).

## The verbs

```
fy job run [--name <n>] [-s <session>] -- <cmd…>   start, then behave exactly like attach (from the start of the log)
fy job attach <id|name> [--from-start | --tail N]    stream the log; default: its last 100 lines, then follow
fy job logs <id|name> [--tail N]                     print the log, do not follow
fy job wait <id|name> [--timeout <dur>]              block, no streaming; print how it ended
fy job stop <id|name>                                SIGTERM the tree, grace, SIGKILL
fy job ls [--all] [--json]                           running + the latest 10 finished, with exit codes and ages
```

**The command.** After `--`, ONE word is a shell command line as written (`fy job run -- 'make test | tee out'`); several words are
an argv and each is quoted so it arrives as typed.

**Exit codes.**

| Code           | Meaning                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| the job's code | `run` / `attach` / `wait` after the job ended (a signal death is already `128 + n`)                                         |
| **75**         | **detached**: the attachment broke, the job is untouched (a signal, the daemon asking it to let go, or no daemon for ~75 s) |
| 124            | `wait --timeout` ran out                                                                                                    |
| 70             | the job ended without an exit record (`lost`)                                                                               |
| 2              | the command line was wrong                                                                                                  |
| 1              | anything else (job not found, daemon refused)                                                                               |

**Detach semantics.** On SIGTERM, SIGHUP or SIGINT an attachment **only detaches**: it prints
`detached from job <id> (<name>); it is still running — re-attach with: fy job attach <id>` to stderr and exits 75. It never forwards
the signal. It must finish inside about a second (Claude Code 2.1 follows its TERM with a KILL about 1.5 s later), so every
call carries the signal's abort, the in-flight poll is raced against it, the registry cleanup gets a 300 ms deadline, and the
process then ends itself with `process.exit(75)` (a request left open must not keep it alive): **no network call stands between a
signal and the message, and none keeps the process past 1 s.** A TERM that lands while `fy job run`'s start request is in flight
detaches the same way (the job may or may not have started; `fy job ls` shows it). Giving up on a silent daemon takes 40 failed
polls with a growing pause (about 75 s). The daemon can ask attachments to let go too (`detach` flag on the next poll; a move does, see [Moves and restarts](#moves-and-restarts)).

## Attachment registry

The registry holds one entry per (ferret, job, pid) — registering again replaces it — and at most 16 per job (the oldest is pushed out).
Each live attachment registers `{jobId, pid, claudeTaskId?}`. The daemon records the pid's **start** at registration; an entry is
proved dead by pid + start (a reused pid reads as a different start), and a reading the host cannot take never prunes. The Claude
Code task id is read from `/proc/self/fd/1` when stdout is `…/tasks/<id>.output` (Linux only; skipped on macOS), parsed by
`claudeTaskId()` in `contract/jobs.ts` — the same function the Processes view uses.

Daemon side (`JobService`): `listAttachments(ferret)`, `detachAll(ferret, job?)`. The HTTP routes are
`GET|POST /v1/ferrets/:id/job-attachments`, `DELETE …/:attachmentId`, `POST …/detach`.

## Who may do what

The job routes sit on the same `terminal` capability as terminals ([grants](./grants.md)). A **ferret** acts only on its own jobs (a path
naming another ferret is `403`); a person acts for any ferret subject to their device's grants. Jobs started by a ferret are placed
in the ferret's limits scope like a terminal an agent opened.

## How agents are told

Agents learn to use the keeper from their system prompt **alone**. There are no hooks of any kind: no Claude PreToolUse rewrite, no
TaskStop/KillShell hook, no Codex hook. The words are the always-on **`jobs`** section (`JOBS_INSTRUCTION` in
`plugins/runtimes/daemon/lib/account/fixed-layer.ts`), appended to the prompt of every agent runtime, Claude and Codex, interactive or auto,
lead or sub-ferret, rendered with the binary's own name. It teaches four things in one paragraph:

1. Start a long or watch-style command (dev server, watcher, tail, a build or tests over about 2 minutes) as a BACKGROUND
   `fy job run --name <x> -- <cmd>` (Claude: Bash with `run_in_background`; Codex: instead of a background terminal). Short commands stay as they are.
2. That background command is only an attachment: the job keeps running if it ends. Read output with `fy job logs <id>`; wait with `fy job wait <id>`.
3. After a move or restart, re-attach with a new background `fy job attach <id>` (`fy job ls` lists the jobs; the restart notice lists them under "Your jobs").
4. Stop a job with `fy job stop <id>`. Stopping the background command (TaskStop, or closing the terminal) only detaches.

Why the prompt can do this alone: on a move or restart Claude TERM→KILLs its background shells about 1.45 s after the pane dies, and Codex SIGKILLs its
background terminals 60 s after the client leaves; a job the keeper holds is neither's child, so only the attachment dies, and the agent re-attaches.

It is a section of its own (not part of `tools`) so a running ferret is told the new words once, by the instruction-refresh note
([launch-settings.md](launch-settings.md#instructions-that-changed-since-the-launch)); its id is `jobs`, shown as "Jobs" in that note and
"background jobs" on the outdated mark. A text change to it is picked up the same way.

## Measuring it

Whether agents obey is a **hand check**, not a dashboard. **Obedience** is the share of a ferret's long or watch-style _background_ commands that went
through `fy job run`. Count, from a ferret's transcript, the background commands (Claude: Bash with `run_in_background`; Codex: background terminals)
that are long or watch-style by the section's own test, and how many of them were `fy job run`; cross-check against the keeper's list (`fy job ls --all`). Short
background commands are not counted either way. The bar is **70%**: below it the words need work (shorter, an example, a stronger verb), not a hook.
There is nothing to build or schedule for this; do the check when a change to the section ships, and when the move gate keeps naming un-kept jobs.

## The app

The Processes tab shows a **Background jobs** group under the process list: name, state (`running`, `exit N`, `lost`), age, command;
pressing a row opens the tail of its log (polled while the job runs).

## Moves and restarts

A restart and a move onto another login are ONE relaunch (`relaunchInPlace`, `modules/restart-in-place.ts`; `modules/move-login.ts` calls it), so both run the same jobs step: `handOffJobs` (`lib/moves/jobs-move.ts`) just before the relaunch kills the pane, and `markJobsTold` after it reported `revived`. There is no pane-killing path that skips it. The facts it rests on
(a spike on Claude Code 2.1.317 and Codex): on a pane kill Claude SIGTERMs each background job's process group and SIGKILLs it ~1.45 s later;
`--resume` keeps the session id and the `tasks/` folder; Codex's unified-exec jobs live under `codex app-server --managed-daemon` and are
SIGKILLed 60 s after the client leaves. A job the keeper holds is none of those processes' child, so the move cannot reach it.

**The gate knows attachments.** Ferrets imports no plugin, so the keeper reaches it through the `jobs.keeper` hook (`JobKeeperSource`,
`core-ferrets/contract/job-keeping.ts`; Terminals contributes it). A process is a `job-attachment` (a `KnownProcess`, `safe_to_kill`) only when
**all** hold: the keeper's registry lists its **pid** (the keeper has already pruned any entry whose pid now has another start), its own
command line is `<fy> job attach|run …` (`isJobAttachCommand` in `@ferretry/std`, the one reading the keeper also uses), **and** it sits in this
pane's tree. The keeper lists a registry entry only while the process **runs the `fy` executable the daemon knows**: a command line is text any
program can set (`exec -a "fy job attach x" sleep 600`, or a perl that sets `$0`), so the FILE is proved, not the text. On Linux that is
`dev:ino` of what `/proc/<pid>/exe` reaches; on macOS the first text mapping `lsof -a -p <pid> -d txt -Fn` reports (resolved); under a JavaScript runtime
(`bun fy.ts`, a source checkout) the runtime's file plus the real path of the script it was handed, which must be this checkout's own CLI entry. The
trusted identities are the `fy` installed beside the daemon's own executable and the one on the daemon's search path (a bare runtime is never trusted).
The identity is stored in the entry when it registers and re-read, and re-compared, every time the gate asks; an entry with none (an earlier daemon wrote
it), an executable that cannot be read, or one that changed, is not an attachment (fail closed). Neither check alone is enough: the registry takes any running
pid the ferret's credential names, so a forged entry for another program stays whatever the classifier says; and an `fy job attach` the registry does not
list stays whatever the classifier says too. The keeper itself refuses to register a pid whose command line is not `fy job attach|run` or whose executable is not
proved, and refuses when it cannot read either. The Claude tool shell around an attachment
(`zsh -c … eval 'fy job attach x'`) is safe too, but only when everything that shell started is the attachment or another command shell AND the rest of
each such shell's own program, with the attach call taken out, classifies safe (the rule of `requester-call.ts`): `fy job attach x && make` has not
started `make` yet, so that shell keeps its own verdict. An attachment to a job that has already ended is listed as exiting, not as "kept;
re-attach after the move". A keeper that cannot answer within 5 s proves nothing, and the classifier decides alone (fail closed).

**Declared residual: a same-uid forgery inside the real `fy`.** Proving the file does not prove the code it runs. `fy` is a Bun
standalone, and Bun can be told to load other code inside that same file: a `bunfig.toml` `preload` in the working directory,
`BUN_OPTIONS=--preload …`, or `BUN_BE_BUN=1`. A process started that way with the argv `fy job attach <id>` has the trusted
identity, so the gate lists it as a kept attachment and a move kills it. This is accepted (lead decision, F4316): it takes a
deliberate forgery with the ferret's own credential and uid, and the only harm is the move killing the forger's own disguised
process; no other ferret's or the owner's work is reachable through it. The compiled `fy` turns off bunfig and `.env` autoloading
(a separate change), which closes the accidental case; a check of the attachment's environment is not built (see below).

**Detach before the kill.** After the gate passes and before the pane is killed, the move asks the keeper to detach every attachment of
the ferret (each prints its detach message and exits 75), then waits for them to be gone: 4 s IN TOTAL on the move's clock, the keeper questions included
(each is bounded to 1.5 s), so a slow keeper cannot stretch it. The jobs are untouched. A keeper that fails or hangs, or an attachment that will not
leave, is logged and the move goes on: the kill breaks the attachment anyway.

**Un-kept background jobs are named, never silently lost, and a foreground command is never called one.** Whether they BLOCK is still the
classifier's verdict; only the words the move shows change. CLAUDE WRITES EVERY BASH CALL'S STDOUT TO `tasks/<id>.output`, foreground calls included, so
that path never proves a call was backgrounded.

| Harness | What is recognised                                                                                                                                                                                                                                                                                        |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude  | A tool shell with that stdout (`claudeTaskId`, in `@ferretry/std`) that no open Bash call accounts for, **and only when the state RECORDS the open tool calls and every one is identified** (name known; a Bash call's command known) — or the session is at its prompt, where no foreground call can run |
| Codex   | The direct children of any `codex app-server` visible in the pane's tree, plus the footer's background-terminal count less those children (no job is counted twice)                                                                                                                                       |

Each recognised one reads: `<command> — a background job Ferretry is not keeping; it stops when the ferret moves. Start long jobs with `fy job run` so they survive.`
A tool shell that cannot be ruled foreground (the state records no open tool calls at all, which is the case on this base: **unrecorded is unknown,
never "none"**; or some open call is unidentified) reads `<command> — a command the agent is running; it stops when the ferret moves.` and is left out of the hand-over's
stopped list. The same items are in the refusal, the terminal table and the forensic report (`move-inflight.md`, "Background jobs Ferretry is
not keeping"); a kept job's attachment is listed as `attachment to job <name> (kept; re-attach after the move)`.

**The hand-over** (the new session's turn message) gets a **Your jobs** section when the ferret has kept jobs. Each subsection is worded on its
own: **Ferretry kept these background jobs running through the move** lists each running job with its name, id, age and the exact line
`re-attach: run `fy job attach <id>` as a background Bash`; **These background jobs finished since you last saw them** lists each job that ended
unseen with its exit code and `fy job logs <id>`; **The move stopped these background jobs, which Ferretry was not keeping** lists the recognised
un-kept ones (Codex terminals included), each with "re-run it with `fy job run …` if you still need it". The section **never** claims "nothing was
stopped": that list holds only the background jobs positively recognised, while a move also stops foreground commands and processes Ferretry cannot
name, and the restart notice above it owns the whole account of what was stopped.

_Seen_ is a record in the job's folder (an empty `reported` file, gone with the job): it is written when a live attachment is served the end of
the log (it prints the exit itself), when the hand-over told the new session, or when the backstop queued its message. A job that ended
with no attachment live is therefore listed exactly once.

**The completion backstop.** When a kept job ends, is unreported and has **no live attachment**, Ferrets queues ONE message to the owning ferret
on the session message queue — `job <name> (<id>) ended with <code>; `fy job logs <id>`` — with a per-job dedupe id (`job-ended-<id>`), then marks the
job told. The keeper leaves out any job an attachment is live on (that attachment reports the exit) and any job that ended in the last 10 s (its
attachment is about to). The pass runs every 15 s. The message goes through the send Ferrets already owns for the monitor's wakes
(`FerretMonitorSend`: typed when the pane is idle, queued under the job's id when it is busy), bound in `features/moves.feature.ts` (`bindBackstopAsk`);
it is deliberately NOT `movesDeps`' `askAgent`, which would also switch on the ask-to-stop-jobs route. A ferret that is not held right now is
skipped quietly (nothing marked, no warning) and tried again next pass. **Flood guard:** a job that ended before the backstop FIRST EVER ran is
history (the hand-over and `fy job list` show it): the first pass marks it told without a message, so an upgrade never messages every old job.
That cut-over is ONE instant, written by the keeper into its own state (`backstopCutOverMs`, in the attachment registry's document) on the first run and never
moved, so a daemon restart or update does not make it forget: a job that ends while the daemon is down is told after the next start. With no cut-over the
pass does nothing. A message queued behind a busy pane is marked told at queue time (the send answers nothing more than "done", so delivery cannot be told
apart); a daemon restart before the pane takes it may lose it, and the ferret still sees the job in `fy job list`.

**Orphaned attachments.** An attachment records the harness CLI above it (pid + start, found through procfs; Linux only) when it registers. A harness
that was SIGKILLed leaves the tool shell and the attachment running, reparented to init; every 15 s the keeper asks such an attachment to detach
(it exits 75), so nothing streams to nobody. An attachment under no harness (a person's own terminal) is never an orphan.

## What is not here yet

- Agent instructions telling agents to start long jobs with `fy job run` and re-attach after a move (part 3).
- `detach` also asks an attachment in a person's own terminal (outside the pane) to let go.
- During a move the hand-over and the backstop can both tell the same job if it ends in that window (the two are not atomic).
- The detach runs before the relaunch, and a relaunch that then refuses (the pane changed, the spawn failed) leaves the attachments already let go.
- A pipeline (`fy job attach x | tee log`) is read as the attach call as a whole; only wording is affected (a live pipeline child still blocks).
- The backstop re-reads every ended job of a ferret that is gone for good, every 15 s, until retention deletes it.
- Jobs of a ferret that finished or was removed are not yet closed with its terminals; they end on their own or are stopped.
- Limits are constants, not owner configuration.
- The executable proof does not read the attachment's environment: `BUN_OPTIONS`, `BUN_BE_BUN`, `NODE_OPTIONS`, `LD_PRELOAD`, `LD_AUDIT`
  or `LD_LIBRARY_PATH` (`DYLD_INSERT_LIBRARIES` on macOS) set on a real `fy` is not refused (the declared residual above).
- The trusted `fy` on the daemon's search path is whatever resolves first, even from a directory the user can write; on nix, where
  `fy` and the daemon are separate store paths, trust rests on that search path alone.
- After a daemon update moves `fy` to a new path, attachments still running the old one are no longer trusted, so a move of
  that ferret blocks ("a program Ferretry doesn't recognise") until it re-attaches (fail closed).
- Orphan detection needs procfs; on macOS an attachment records no harness and is never swept.
