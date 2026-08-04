# Human journey map

This is an end-to-end audit of the capabilities a person would name, rather
than a reachability ledger of individual modules. It was checked against the
current `docs/journeys` worktree on 2026-08-03, including the merged PR
declarations for #126, #134, #137, #144, #153, #177 and #184.

`CLI only` means a person can perform the action from a configured shell, but
the remote PWA journey is incomplete. It is **not** counted as a complete
remote-product journey. `Partial` similarly names a useful sub-path, not a
claim that the requested capability works.

| Journey a human names                                                   | CLI path                                                                                                                                                                                  | Daemon path                                                                                                                                                                                                                       | PWA path                                                                                                                                                                                                                          | Works end to end?                                                                                                                                                                  | What is missing / the limiting fact                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex and Claude can talk to each other                                 | `fy ps` and `fy send :callsign` address named peers. On the daemon host, the session connector defaults to loopback and reads the owner-only daemon token file when `FY_TOKEN` is absent. | `POST /v1/sessions/:id/send` delivers, queues, or revives. A sender tagged with a session id can also end the recipient's declared peer wait (#153).                                                                              | The mounted session workspace lets a human read and send within one visible session. It does not present a cross-session, agent-authored peer exchange or preserve peer sender attribution in its logs-text projection.           | **CLI only for agent-to-agent conversation; partial human steering in the PWA.**                                                                                                   | A PWA send is an operator steering one session, not one agent addressing another. The current 3-second logs projection collapses non-message records to notices, so it cannot present the durable peer attribution/ledger needed to claim the named peer journey remotely.                                                                                                          |
| Remotely create and talk with Codex and Claude in different directories | `fy start` accepts the account, cwd, mode, model and opening prompt; a shell with `FY_URL` and `FY_TOKEN` can subsequently use `fy send`.                                                 | `POST /v1/sessions` launches a configured account in its resolved cwd; `POST /send` is live.                                                                                                                                      | `NewSessionPage` creates the session, then `SessionChatPage` mounts its daemon-scoped transcript, composer, visible autocomplete and lifecycle controls. It reads normalized logs immediately and every 3 seconds while visible.  | **Partial.** A person can remotely create, open, read and send plain-text messages in the requested directory.                                                                     | The workspace polls the uncursored logs-text tail rather than consuming mounted paged history/live events. Attachments and runtime model/effort controls are unmounted, and structured answers cannot be claimed because `POST /v1/sessions/:id/answer` is deliberately not mounted.                                                                                                |
| Remotely use terminal, browser, and file system                         | CLI has local attach/read commands plus `fy fs ls/cat/changes/diff` and browser command verbs.                                                                                            | Filesystem reads, terminal lifecycle/socket routes and terminal-scoped one-use ticket minting are mounted. Attach remains loopback-only. Per-session browser GET/POST intentionally returns 501 because no browser worker exists. | The workspace mounts `FilesTab` and a paired-daemon terminal snapshot that refreshes while visible. It filters browser tabs out. The PWA can mint terminal tickets, but no production interactive terminal renderer redeems them. | **Partial.** Remote file browsing and a read-only terminal snapshot work; interactive terminal and browser do not.                                                                 | The terminal transport is complete on both sides; the missing piece is a PWA interactive terminal renderer/deck (there is no `@xterm/*` surface), not ticket minting. Browser automation still lacks its worker/viewer host and remains an honest 501.                                                                                                                              |
| Manage multiple accounts                                                | `fy fleet ls/apply/usage/recommend` provisions and inspects local fleet accounts.                                                                                                         | The daemon resolves configured accounts when starting/migrating; `/v1/usage` supplies quota data.                                                                                                                                 | The PWA can pair and select multiple **daemons**, and shows per-daemon quota/usage, but has no fleet-account management surface.                                                                                                  | **CLI only.** Account management is usable at the host shell, not from the remote product.                                                                                         | No PWA account provisioning/configuration route or screen. Pairing more daemons is not account management.                                                                                                                                                                                                                                                                          |
| An agent spawning system                                                | A human — and, after the local token-file fallback, an in-pane agent — can invoke `fy start`. Child/parent and board-access choices are represented in the start request.                 | The session-control/lifecycle path creates the record, starts tmux and delivers the first prompt.                                                                                                                                 | `NewSessionPage` is a real, daemon-scoped create form.                                                                                                                                                                            | **Partial.** Basic spawning works, but an agent cannot automatically preserve all of the intended lineage and board semantics.                                                     | `FY_SESSION_ID` is absent, so automatic parentage is lost unless the agent names `--parent`. The launcher writes `FY_SESSION_BOARD_CAPABILITY`, while the session-start command currently reads `FY_BOARD_CAPABILITY` for `--board-access`; that contract mismatch blocks a child board grant. The PWA cannot yet guide or observe the resulting child in a session workspace.      |
| Work orchestration built in                                             | `fy task` and `fy task board` command groups are wired; task records, dependencies, status moves and file claims have mounted routes. An agent can use explicit `--session` targeting.    | `/v1/tasks` and `/v1/sessions/:id/tasks` are mounted and backed by the task subsystem.                                                                                                                                            | Task projection, board, graph, row and filter components exist, but no task page is routed or mounted; `/tasks` is a legacy redirect to sessions.                                                                                 | **CLI only.** The orchestration core can be operated from the shell.                                                                                                               | No PWA task-board host. `FY_SESSION_ID` would make agent self-scoping and lineage ergonomic, but is not required for an agent that names its target session explicitly; do not mistake that refinement for the PWA's real reachability gap.                                                                                                                                         |
| Cost tracking                                                           | `fy analytics` queries spend, tokens, duration and outcomes; `fy fleet usage` reports account quota.                                                                                      | Analytics is mounted and folds each finished session's own transcript into a token total, priced against that daemon's operator-owned `analyticsPricing` catalog in `config/daemon.json`.                                         | The routed Global Analytics page has query, table and time-series UI; session dashboards show quota.                                                                                                                              | **Yes for token cost once the operator supplies rates; no for subscription spend.** The daemon ships no rates, so an operator who configures none still sees tokens without money. | Cost is API-equivalent: what the usage would cost at the rates the operator configured. Most fleet accounts are subscriptions, where that is not the bill, and every surface says so. An unpriced model, a session under several models and unreadable or damaged transcript evidence all report unknown rather than zero; a malformed or ambiguous catalog refuses daemon startup. |
| Render rich content directly in text                                    | No rich CLI renderer is part of the session journey.                                                                                                                                      | The daemon serves raw transcript/event evidence.                                                                                                                                                                                  | The mounted transcript sends assistant prose through the shared Markdown renderer, and the composer exposes syntax highlighting and autocomplete.                                                                                 | **Partial.** Assistant Markdown renders in the real session route.                                                                                                                 | The logs-text projection emits only user, assistant and notice rows. Tool calls/results, attachments, thinking blocks and send-ledger records therefore remain flattened or unreachable even though their renderers exist.                                                                                                                                                          |
| Speech to text / browser-local dictation                                | `fy stt status/models/install/transcribe/enhance` is wired and can transcribe a supplied audio file.                                                                                      | The STT worker, model install, transcription and enhancement routes are mounted.                                                                                                                                                  | The session composer is now mounted, but it does not compose the existing daemon-bound dictation control. The browser-local Parakeet/local-agreement engine is still not ported.                                                  | **CLI only for STT; no for browser-local dictation.**                                                                                                                              | PWA dictation remains daemon-bound by design, and neither that control nor a browser-local engine is reachable from the assembled composer.                                                                                                                                                                                                                                         |
| Migrate when an account runs out of tokens                              | `fy migrate` describes migration to another same-kind account.                                                                                                                            | `POST /v1/sessions/:id/migrate` is mounted with preflight, handoff report, replay protection and relaunch; #190 refuses a cross-family target.                                                                                    | The migration sheet is reachable from the session workspace and runs the existing daemon-bound destructive flow.                                                                                                                  | **Partial.** A person can manually move and relaunch a session on a same-kind account from the PWA.                                                                                | Automatic quota-triggered failover is still absent. It must remain opt-in and may choose another account only when exhaustion and same-kind headroom are both positively known.                                                                                                                                                                                                     |

## The evidence behind the statuses

- PR #153 made send/interrupt and peer-wait completion real, but deliberately
  left structured answer downstream of the monitor loop. The local CLI's
  owner-only token fallback makes named peer messaging possible without
  `FY_SESSION_ID`; the session id improves attribution and peer waits. The
  PWA workspace now steers one visible session, but its operator-authored send
  is not an agent-to-agent peer exchange and `/answer` remains unmounted.
- PR #137 honestly ported terminal/files/browser _panes_. Its own declaration
  says the unified-browser surface lacked a host. The workspace now hosts files
  and the cached snapshot; the browser runtime remains an explicit 501.
- PRs #126 and #134 explicitly say the PWA dictation engine is daemon-bound
  and that the browser-local engine was not ported. They are not evidence of
  browser-local dictation working.
- PR #144 supplied dashboard and migration-sheet components. The workspace now
  mounts the sheet; the dashboard/runtime controls remain uncomposed.
- PR #184 closed remote live-event authentication with one-use socket tickets.
  #189 separately completed terminal-scoped ticket minting. This workspace still
  polls normalized logs and has no interactive terminal renderer.

## Recommended order of work

1. **Finish the PWA session data plane.** Replace the uncursored logs poll with
   mounted paged history plus live events, then compose durable send-ledger,
   tool, attachment, thinking, runtime and daemon-bound dictation surfaces.
   The workspace host, plain-text steering, files, snapshot, Markdown and
   manual migration are now present; browser automation remains separate.
2. **Make launched-agent identity and board capability semantics consistent.**
   The loopback token-file fallback already makes the local CLI usable, so do
   not add credentials merely to make peer addressing work. Supply
   `FY_SESSION_ID` where parentage, self-reference, journal attribution and
   peer waits need it; align the launcher’s `FY_SESSION_BOARD_CAPABILITY` with
   the start command’s board-capability input. This is an ergonomics and
   correctness improvement, not the PWA's remote-workspace dependency.
3. **Render the existing remote terminal transport.** Terminal-scoped ticket
   minting and the socket bridge are complete. Add the PWA interactive terminal
   renderer/deck that redeems that ticket; keep the cached snapshot as fallback.
4. **Port the per-session browser runtime before its display.** Implement the
   browser worker and `BrowserViewerHost`, then add the browser-stream ticket
   path and mount the existing UI. The present 501 makes this a distinct,
   larger dependency from the workspace work.
5. **Complete the orchestration surface.** Mount a PWA task board (the route
   currently redirects away), then verify parent/child and task-board actions
   from a launched agent after step 2.
6. **Automate migration only on proved evidence.** Same-family enforcement and
   the manual PWA sheet are mounted. Add opt-in quota-triggered failover only
   after both exhaustion and same-kind headroom are positively verified.
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
the PWA session workspace is no longer a placeholder, but its structured/live
data plane and several already-ported controls remain uncomposed. Agent identity
is a separate control-quality improvement, and the local-token design has an
explicit full-admin trust boundary. A component or route is still not credited
until the human journey actually reaches it.
