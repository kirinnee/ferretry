# Human journey map

This is an end-to-end audit of the capabilities a person would name, rather
than a reachability ledger of individual modules. It was checked against the
current `docs/journeys` worktree on 2026-08-03, including the merged PR
declarations for #126, #134, #137, #144, #153, #177 and #184.

`CLI only` means a person can perform the action from a configured shell, but
the remote PWA journey is incomplete. It is **not** counted as a complete
remote-product journey. `Partial` similarly names a useful sub-path, not a
claim that the requested capability works.

| Journey a human names                                                   | CLI path                                                                                                                                                                                                                                          | Daemon path                                                                                                                                                                          | PWA path                                                                                                                                                                                         | Works end to end?                                                                                                                              | What is missing / the limiting fact                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Codex and Claude can talk to each other                                 | `fy ps` and `fy send :callsign` can address peers without an ambient session id. On the daemon host, the session connector defaults to loopback and reads the owner-only daemon token file when `FY_TOKEN` is absent (the `fix/ship-fyd` change). | `POST /v1/sessions/:id/send` is mounted; it delivers, queues, or revives. A sender tagged with a session id can also end the recipient's declared peer wait (#153).                  | No conversation workspace is mounted at a session route.                                                                                                                                         | **CLI only.** An in-pane agent can message a named peer after the token-file fallback is released; the remote PWA journey remains unavailable. | `FY_SESSION_ID` is a refinement, not the addressing blocker: it supplies journal attribution (`peer:<id>` instead of `admin-cli`), makes `endPeerWait` know which peer replied, and permits self-reference without an explicit id. The PWA still has no send UI.                                                                                                               |
| Remotely create and talk with Codex and Claude in different directories | `fy start` accepts the account, cwd, mode, model and opening prompt; a shell with `FY_URL` and `FY_TOKEN` can subsequently use `fy send`.                                                                                                         | `POST /v1/sessions` launches a configured account in its resolved cwd; `POST /send` is live.                                                                                         | `NewSessionPage` accepts Account, Project, Model, Mode, Label and prompt and calls `start`. It then navigates to the session route.                                                              | **Partial, not a usable remote conversation.** Remote creation works; remote conversation does not.                                            | `App.tsx` fetches the session then intentionally renders “The conversation workspace is not assembled in this build yet.” It mounts no transcript, composer, send action, panes, or session controls.                                                                                                                                                                          |
| Remotely use terminal, browser, and file system                         | CLI has local attach/read commands plus `fy fs ls/cat/changes/diff` and browser command verbs.                                                                                                                                                    | Filesystem read routes and terminal lifecycle/socket routes are mounted. Attach is explicitly loopback-only. Browser login is mounted, but per-session browser GET/POST returns 501. | Files, terminal snapshot, terminal stream, remote-browser and unified-browser components exist, but no production session workspace mounts them.                                                 | **No.** Filesystem reads are CLI-only; none of the requested remote workbench is usable from the PWA.                                          | Terminal streaming needs a daemon-issued stream ticket endpoint; the PWA accepts a ticket but no endpoint mints one. Browser automation additionally lacks its browser worker and viewer host, so `/v1/sessions/:id/browser` is an intentional 501. A workspace host is the first common missing link for files and terminal UI.                                               |
| Manage multiple accounts                                                | `fy fleet ls/apply/usage/recommend` provisions and inspects local fleet accounts.                                                                                                                                                                 | The daemon resolves configured accounts when starting/migrating; `/v1/usage` supplies quota data.                                                                                    | The PWA can pair and select multiple **daemons**, and shows per-daemon quota/usage, but has no fleet-account management surface.                                                                 | **CLI only.** Account management is usable at the host shell, not from the remote product.                                                     | No PWA account provisioning/configuration route or screen. Pairing more daemons is not account management.                                                                                                                                                                                                                                                                     |
| An agent spawning system                                                | A human — and, after the local token-file fallback, an in-pane agent — can invoke `fy start`. Child/parent and board-access choices are represented in the start request.                                                                         | The session-control/lifecycle path creates the record, starts tmux and delivers the first prompt.                                                                                    | `NewSessionPage` is a real, daemon-scoped create form.                                                                                                                                           | **Partial.** Basic spawning works, but an agent cannot automatically preserve all of the intended lineage and board semantics.                 | `FY_SESSION_ID` is absent, so automatic parentage is lost unless the agent names `--parent`. The launcher writes `FY_SESSION_BOARD_CAPABILITY`, while the session-start command currently reads `FY_BOARD_CAPABILITY` for `--board-access`; that contract mismatch blocks a child board grant. The PWA cannot yet guide or observe the resulting child in a session workspace. |
| Work orchestration built in                                             | `fy task` and `fy task board` command groups are wired; task records, dependencies, status moves and file claims have mounted routes. An agent can use explicit `--session` targeting.                                                            | `/v1/tasks` and `/v1/sessions/:id/tasks` are mounted and backed by the task subsystem.                                                                                               | Task projection, board, graph, row and filter components exist, but no task page is routed or mounted; `/tasks` is a legacy redirect to sessions.                                                | **CLI only.** The orchestration core can be operated from the shell.                                                                           | No PWA task-board host. `FY_SESSION_ID` would make agent self-scoping and lineage ergonomic, but is not required for an agent that names its target session explicitly; do not mistake that refinement for the PWA's real reachability gap.                                                                                                                                    |
| Cost tracking                                                           | `fy analytics` queries spend, tokens, duration and outcomes; `fy fleet usage` reports account quota.                                                                                                                                              | Analytics is mounted and indexes session evidence. Its pricing catalog is deliberately empty.                                                                                        | The routed Global Analytics page has query, table and time-series UI; session dashboards show quota.                                                                                             | **Partial.** Token/usage reporting works; actual cost tracking does not yet have authoritative prices.                                         | The daemon returns unpriced cost where no operator pricing catalog exists. The PWA correctly labels this as equivalent/public-API cost rather than subscription spend, so it must not be read as actual fleet cost.                                                                                                                                                            |
| Render rich content directly in text                                    | No rich CLI renderer is part of the session journey.                                                                                                                                                                                              | The daemon serves raw transcript/event evidence.                                                                                                                                     | Markdown, attachment gallery, tool group, composer highlighting and file Markdown renderers exist as components.                                                                                 | **No.** The current session route renders none of those components.                                                                            | `TranscriptRow` still renders ordinary text in a `<p>` and explicitly leaves richer Markdown and attachments to later ports. Until the session workspace composes the transcript and renderer, the component inventory is unreachable.                                                                                                                                         |
| Speech to text / browser-local dictation                                | `fy stt status/models/install/transcribe/enhance` is wired and can transcribe a supplied audio file.                                                                                                                                              | The STT worker, model install, transcription and enhancement routes are mounted.                                                                                                     | Daemon-bound microphone capture, dictation settings and a dictation control exist, but the browser-local Parakeet/local-agreement engine is not ported and no mounted composer owns the control. | **CLI only for STT; no for browser-local dictation.**                                                                                          | PWA dictation sends recording to the paired daemon by design. It cannot appear in the unassembled session workspace, and the requested browser-local engine is explicitly absent.                                                                                                                                                                                              |
| Migrate when an account runs out of tokens                              | `fy migrate` describes migration to another same-kind account.                                                                                                                                                                                    | `POST /v1/sessions/:id/migrate` is mounted with preflight, handoff report, replay protection and relaunch.                                                                           | A migration sheet exists in the component set but cannot be reached from the placeholder session route.                                                                                          | **No.** The safety operation exists, but the advertised quota-failover journey is not complete.                                                | `createSessionMigrateSubsystem` records the target account's harness but never enforces that it matches the source harness, despite the CLI saying same-kind. There is also no automatic “quota exhausted + confirmed same-kind headroom” failover, and no mounted PWA migration UI.                                                                                           |

## The evidence behind the statuses

- PR #153 made send/interrupt and peer-wait completion real, but deliberately
  left structured answer downstream of the monitor loop. The local CLI's
  owner-only token fallback makes named peer messaging possible without
  `FY_SESSION_ID`; the session id improves attribution and peer waits. The
  absent PWA session workspace remains the remote messaging blocker.
- PR #137 honestly ported terminal/files/browser _panes_. Its own declaration
  says the unified-browser surface lacked a host; the current daemon has since
  also made the browser-runtime gap explicit with the 501 route.
- PRs #126 and #134 explicitly say the PWA dictation engine is daemon-bound
  and that the browser-local engine was not ported. They are not evidence of
  browser-local dictation working.
- PR #144 supplied dashboard and migration-sheet components, but component
  reachability does not change the session-route placeholder.
- PR #184 closed remote live-event authentication with one-use socket tickets.
  That helps fleet events; it does not mint the distinct terminal/browser stream
  tickets the display panes need.

## Recommended order of work

1. **Assemble the PWA session workspace.** Mount the conversation transcript,
   composer/send path, side panes, file browser, terminal snapshot and the
   already-portable controls at `SessionRoute`. This is the widest single
   unblocker: remote steering, files, terminal presentation, rich text,
   daemon-bound dictation, and the existing migration sheet all need this
   owner. It does _not_ make browser automation work by itself.
2. **Make launched-agent identity and board capability semantics consistent.**
   The loopback token-file fallback already makes the local CLI usable, so do
   not add credentials merely to make peer addressing work. Supply
   `FY_SESSION_ID` where parentage, self-reference, journal attribution and
   peer waits need it; align the launcher’s `FY_SESSION_BOARD_CAPABILITY` with
   the start command’s board-capability input. This is an ergonomics and
   correctness improvement, not the PWA's remote-workspace dependency.
3. **Finish remote terminal and live-session transport.** Add the narrowly
   scoped ticket minting path the PWA terminal stream requires, then connect it
   from the assembled workspace. This turns an already-mounted terminal socket
   into an actual remote terminal.
4. **Port the per-session browser runtime before its display.** Implement the
   browser worker and `BrowserViewerHost`, then add the browser-stream ticket
   path and mount the existing UI. The present 501 makes this a distinct,
   larger dependency from the workspace work.
5. **Complete the orchestration surface.** Mount a PWA task board (the route
   currently redirects away), then verify parent/child and task-board actions
   from a launched agent after step 2.
6. **Make migration truthful and operable.** Enforce same-harness targets in
   the daemon, mount the sheet, then add opt-in quota-triggered failover only
   after same-kind headroom is verified.
7. **Close the remaining independently valuable gaps.** Supply operator-owned
   pricing data for cost totals, then decide whether browser-local STT is a
   product requirement and port its engine if it is.

## Trust boundary: a launched agent is a daemon administrator

The local token fallback reads the same owner-only `api-token` that authenticates
the human operator. Therefore every daemon-launched agent able to run `fy` on
that host has the daemon's full `admin` scope: it can inspect, stop, migrate, or
message any session that the daemon serves. A supplied `FY_SESSION_ID` changes
the journal actor; it is not an authorization boundary, and the daemon resolves
that header only after the bearer is already authorized.

**This is the intended design, decided 2026-08-04, not an accident of the token
fallback.** Agents spawning agents and stopping their children is the product;
restricting it would be theatre. Every agent already runs as the operator, on
the operator's machine, with the operator's filesystem — an agent denied an API
call can read `api-token` directly or bypass the daemon entirely. A boundary
between processes sharing a UID enforces nothing against an adversary and
obstructs the legitimate case.

Meaningful per-agent permissions would need a real capability system: who may
spawn what, who may stop whom, how authority delegates down a spawn chain, how
it is revoked when a parent dies, what becomes of orphans. That is a large
subsystem, subtly wrong for years at a time, defending a threat a single-user
tool does not have.

The one exception is already in place and is the right level:
`FY_SESSION_BOARD_CAPABILITY`, where a start receives only the `--board-access`
it asked for (PR #120). A shared task board is collaborative state, so two
agents' interests can genuinely diverge there — unlike a process one of them
owns.

So: full admin over sessions and processes; narrow capabilities only where state
is genuinely shared. Anyone revisiting this should change it deliberately rather
than because the full-admin scope looked like an oversight.

The principal correction to the previous reachability measure is therefore:
the PWA session workspace is the biggest shared presentation gap. Agent identity
is a separate control-quality improvement, and the local-token design has an
explicit full-admin trust boundary. None can be credited merely because its
components and daemon routes are mounted.
