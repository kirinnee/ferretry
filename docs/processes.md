# Processes — every subprocess a ferret runs, and what it prints

The **Processes** tab sits beside Chat and Console on every ferret. It lists each process running under that
ferret's own pane — the commands the agent is running, the ones it left running in the background, the servers
they started and the helpers the harness keeps — and shows what a process is printing, live, where that can be
read without taking it away from anyone. A process the agent started can be stopped from there.

The contract is `packages/protocol/src/lib/session-processes.ts`; the daemon side is
`packages/daemon/src/lib/session/processes/` (rules) and `packages/daemon/src/adapters/session/processes/`
(the operating system).

## What is listed

The daemon walks **one subtree**: the pane the attach proof names — the session's single registration,
matched on pane id, pid and process start — and everything below it. A process of another ferret, of the
daemon or of the machine can never appear, because the walk never starts anywhere else. The harness itself
(the Claude or Codex CLI the pane runs) is the root and is not listed: it is the Chat and the Console.

Which process is what is decided by the Warden's rules (`lib/warden/pane-processes.ts`), not a name list:

| kind         | what it is                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------- |
| `command`    | a tool command the agent is running — a shell the harness started, and everything below it    |
| `background` | a tool command started with Claude Code's `run_in_background` (the transcript names its task) |
| `server`     | a process inside a command holding a LISTEN socket — a dev server the agent meant to keep up  |
| `helper`     | anything else the harness started: Ferretry's tools server, MCP and language servers, Chrome  |

Each row carries the pid, the command line **as the kernel reports it** (and, when the harness wrapped it,
the command the agent actually wrote as `label`), the state, when it started, CPU (a rate between looks) and
resident memory. A process's identity is `<pid>.<start>` — its pid and its start time — so a pid the
kernel later hands to another process is a different id.

**Recently ended commands stay listed** for 15 minutes (at most 30 per ferret), with their exit status where
the harness recorded one: Claude Code's `<task-notification>` for a background task, and the tool result
(`Exit code N`, or an error result) for a foreground one. That memory is the daemon's, in memory only; a
daemon restart forgets it.

## Where output comes from

Nothing is ever opened that another reader owns. In order:

1. **A regular file.** Claude Code (verified on 2.1.x) redirects stdout and stderr of _every_ Bash tool
   command — foreground and background — to `/tmp/claude-<uid>/<project-slug>/<session-uuid>/tasks/<id>.output`,
   and a command redirected with `>`/`>>` writes to its own file. The daemon finds that file by `readlink` on
   `/proc/<pid>/fd/1` (then `/2`) — which names the target without opening it — and reads the **path**, never
   the descriptor's alias. A background task's file outlives the task, so its output stays readable after it
   ends; a foreground command's file is deleted when the command returns.
2. **The transcript.** An ended command whose file is gone shows the result the harness recorded.
3. **Nothing, with the reason.** A terminal ("Writes to the terminal — see Console"), a pipe or socket (its
   reader — often the agent — would lose what this read took), `/dev/null`, or a platform that cannot see
   descriptors.

Reads are **bounded**: the first read is the file's last 256 KiB, then each read returns what was written
after the previous one. A reader that fell further behind skips the gap and is told (`skipped`); a file that
shrank or was replaced starts again from its tail (`reset`). While the process runs, only **whole lines**
are delivered (`\n`, or the `\r` a progress bar redraws with), so a character — or a secret value — is never
split across two reads; a fragment longer than 64 KiB is delivered anyway.

The file reader opens only what `lstat` proved is a regular file, non-blocking and without following a
symlink, then checks the opened descriptor is that same regular file. A FIFO, terminal or socket swapped in
at the path is refused — never opened, blocked on or drained. A file inside the daemon's state home is never
served, whatever a process's output points at, so this route cannot become a way to read Ferretry's own
credentials.

## Stop

Stop sends **SIGTERM** to the process and everything below it, deepest first, so a parent does not respawn a
child it just lost. Helpers are not stoppable here — stopping the tools server or an MCP server breaks the
ferret, not a command — and neither is a zombie, which has already exited.

**No pid-reuse kill.** The daemon looks again at the proved pane, requires the id's pid to be in that
subtree _with the same start time_, and then, immediately before signalling each process, reads its start
time once more and skips any whose start changed. A process that ended and whose pid the kernel handed on is
left alone, and Stop answers `409 process_changed` when the process itself is gone.

## Who may do this

All three routes are **`terminal` / `use`** (see [grants.md](grants.md#seven-capabilities-two-axes)): the list
is every command line under the pane, an output read is what those commands print, and Stop is less than
typing Ctrl-C into the Console. So a caller at the machine is ungoverned, and a paired device, a browser
across the network or a relayed session needs the `terminal` grant and a current step-up — which the unlock
holds by default. Stop is audited as `terminal.input` with `detail.mode: 'process-stop'`, never naming the
process.

## Secrets

Command lines, labels and output text all pass through the vault redactor before they leave the daemon, so
the value of any stored secret is shown as `[redacted:NAME]`; a vault that cannot be opened refuses the read
rather than serving unscrubbed text ([secrets.md](secrets.md#redaction)). **Environment variables are never
read or shown** — only argv.

What that does **not** guarantee, stated rather than discovered:

- A value the process **transformed** (base64, URL-encoded, a substring) is not recognisable and is not masked.
- A value that contains a **line break** and lands across two live reads is masked in neither, because each
  read is scrubbed on its own and live reads are cut at line ends. A finished process's output is read whole.
- Only **stored** secrets are known. A token an agent fetched some other way is ordinary text.

## Declared GAPs

- **macOS: no output, no servers.** The tree, states, CPU and memory come from one `ps` table, but a process's
  descriptors cannot be read without `lsof`, so every row says "Reading output is not supported on macOS yet",
  and a listening server is not told apart from a command.
- **Codex foreground commands** write into a pipe Codex itself reads, so their output shows only once the
  command ends and the transcript records it.
- **A signalling window remains.** Between the final start-time check and `kill(2)` a pid could, in principle,
  be reused; Bun offers no `pidfd`, which would close it. The window is microseconds and needs the kernel to
  cycle through every pid in between.
- **Exit status** is known only where the harness recorded it; a process the agent started outside a tool
  call (a daemon a command forked) ends with no recorded status.
