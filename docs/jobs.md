# Background jobs (the job keeper)

A **job** is a non-interactive command that Ferretry keeps for a ferret, so a long watcher or build survives the agent being moved,
restarted or killed. This is part 1 of three: the keeper and the `fy job` verbs. The move gate, the hand-over, the Claude/Codex
hooks and the agent instructions are later parts (see [What is not here yet](#what-is-not-here-yet)).

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
- **Stopping** (`fy job stop`): the daemon writes `stop`; within a second the wrapper sends SIGTERM to the job's whole **process
  tree** (children found with `pgrep -P`), then, after 5 s, SIGKILL to the tree walked again from the job's pid at that moment (plus earlier finds that were orphaned to init), so a pid that was reused meanwhile is not hit. A job that ignores TERM ends with code 137 /
  signal KILL. If the wrapper itself does not finish in time the pane is taken down and a KILL exit is recorded by the daemon.
  A process that detached itself (setsid, double fork) before the stop is out of reach.
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
polls with a growing pause (about 75 s). The daemon can ask attachments to let go too (`detach` flag on the next poll; the move gate will use it).

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

## The app

The Processes tab shows a **Background jobs** group under the process list: name, state (`running`, `exit N`, `lost`), age, command;
pressing a row opens the tail of its log (polled while the job runs).

## What is not here yet

- Gating a move on attachments, detaching them first, and listing jobs in the hand-over (part 2).
- Claude `run_in_background` → `fy job run` rewrite, TaskStop → `fy job stop`, Codex hooks, agent instructions (part 3).
- Spotting an attachment whose harness was SIGKILLed (the orphan keeps a live pid): needs the harness pid, a part-2 concern.
- Jobs of a ferret that finished or was removed are not yet closed with its terminals; they end on their own or are stopped.
- Limits are constants, not owner configuration.
