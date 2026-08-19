# Human journey map

This is an end-to-end audit of the capabilities a person would name, rather
than a reachability ledger of individual modules. It was re-audited against
`main` on 2026-08-05, including the shipped relay, session-answer, attachment,
file-preview, session-search, fleet, health, secret and doctor work through
#277. A row is promoted only where the human path is actually mounted.

`CLI only` means a person can perform the action from a configured shell, but
the remote PWA journey is incomplete. It is **not** counted as a complete
remote-product journey. `Partial` similarly names a useful sub-path, not a
claim that the requested capability works.

| Journey a human names                                                   | CLI path                                                                                                                                                                                         | Daemon path                                                                                                                                                                                                                                                          | PWA path                                                                                                                                                                                                                                                                                                                                            | Works end to end?                                                                                                                                                                                                                                                                                                                  | What is missing / the limiting fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex and Claude can talk to each other                                 | `fy ps` and `fy send :callsign` address named peers. On the daemon host, the session connector defaults to loopback and reads the owner-only daemon token file when `FY_TOKEN` is absent.        | `POST /v1/sessions/:id/send` delivers, queues, or revives. A sender tagged with a session id can also end the recipient's declared peer wait (#153).                                                                                                                 | The mounted session workspace lets a human read and send within one visible session. It does not present a cross-session, agent-authored peer exchange or preserve peer sender attribution in its logs-text projection.                                                                                                                             | **CLI only for agent-to-agent conversation; partial human steering in the PWA.**                                                                                                                                                                                                                                                   | A PWA send is an operator steering one session, not one agent addressing another. The current 3-second logs projection collapses non-message records to notices, so it cannot present the durable peer attribution/ledger needed to claim the named peer journey remotely.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Remotely create and talk with Codex and Claude in different directories | `fy start` accepts the account, cwd, mode, model and opening prompt; a shell with `FY_URL` and `FY_TOKEN` can subsequently use `fy send` and `fy answer`.                                        | `POST /v1/sessions`, `/send` and `/answer` are mounted. Answer refuses until the exact visible question is bound and only returns after the pane visibly advances; the relay carries the same dispatcher as direct access.                                           | `NewSessionPage` creates the session; `SessionChatPage` mounts the transcript, composer, runtime model/effort controls and `QuestionForm`. A paired browser reaches the daemon directly or over the encrypted relay carrier.                                                                                                                        | **Yes for remote creation, conversation and supported structured answers.**                                                                                                                                                                                                                                                        | The workspace still polls an uncursored logs tail rather than mounted paged history/live events. Unsupported or no-longer-provable question shapes deliberately require human prose instead of guessing. Attachment upload and the durable attachment/gallery projection are not composed into this session route.                                                                                                                                                                                                                                                                                                                                                                                        |
| Remotely use terminal, browser, and file system                         | CLI has local attach/read commands plus `fy fs ls/cat/changes/diff` and browser command verbs.                                                                                                   | Filesystem reads, terminal lifecycle/socket routes and terminal-scoped one-use ticket minting are mounted. Per-session browser GET/POST intentionally returns 501: the worker and transport exist, but no per-session runtime composes them.                         | `FilesTab` safely previews rich files. `SessionTerminalDeck` mounts an `@xterm/xterm` co-control surface with daemon-bound one-use tickets; the agent pane snapshot remains read-only. File requests and the terminal stream can both relay; the stream is a §14 relayed session rather than a direct socket.                                       | **Partial.** Remote file browsing/previewing and interactive terminal co-control work; browser automation does not yet work end to end.                                                                                                                                                                                            | A relayed terminal consumes one §14 stream session and the browser still does not render the rendezvous session-ceiling refusal in words. Browser panes are merged but unproven, and the session host still lacks the composition from session id to launched worker and production `BrowserViewerHost`; its route remains an honest 501.                                                                                                                                                                                                                                                                                                                                                                 |
| Manage multiple accounts                                                | `fy fleet init/ls/apply/usage/health/login/recommend` prepares, provisions and inspects local fleet accounts.                                                                                    | `GET /v1/fleet/{accounts,config,environment,plan,usage,health}` and body-less `POST /v1/fleet/apply` are mounted, admin-scoped and no-store; the daemon resolves configured accounts when starting or migrating.                                                     | The mounted **Fleet** Settings sub-tab reads the daemon-keyed manifest/configuration and renders a roster only from a positively parsed manifest.                                                                                                                                                                                                   | **Yes for seeing the fleet.** A person can see which accounts a paired daemon actually has from the product.                                                                                                                                                                                                                       | Missing configuration, damaged configuration, declared-but-never-applied host, refused credential and unreachable daemon remain distinct states. Launchability evidence is still only `GET /v1/doctor`, so the roster says what the manifest declares, not what can start.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Configure my fleet from the UI                                          | `fy fleet init` and `fy fleet apply` operate locally. There is no authorize verb: the fleet is governed by the `fleet` capability like every other surface.                                      | `POST /v1/fleet/proposals` holds a derived, revision-bound `initialize`, `create-account` or `edit-account` proposal; permissions, asset reads and application are mounted, each declaring its `fleet` axis.                                                         | The Fleet sub-tab prepares a host or creates/edits an account layer, previews the numbered change manifest, applies it, and renders each parsed outcome. Switching daemon drops draft, proposal and result.                                                                                                                                         | **Yes, with the authority condition stated before the first click.** `GET /v1/fleet/permissions` reports `mayApply`, the shared `GrantRefusal` behind it, and whether applying will ask for the operator password. An ungoverned caller — the host, or a browser on this machine that has unlocked — applies with no further step. | No account removal or harness/wrapper/home edits. `profiles`, `variants`, `commands`, `aliases`, `defaultHomes`, `sharedHistory`, `health` and `usage` remain hand edits of `config.yaml`; per-profile environment is read-only in the browser. Applying rewrites parsed YAML, inline settings merge but cannot delete a key, and only text assets are editable.                                                                                                                                                                                                                                                                                                                                          |
| An agent spawning system                                                | A human — and an in-pane agent — can invoke `fy start`. `FY_SESSION_ID` supplies the caller identity, so parentage is automatic unless `--parent` overrides it; board access remains explicit.   | The lifecycle path records the parent, creates the child pane and exports its own `FY_SESSION_ID` and session board capability.                                                                                                                                      | `NewSessionPage` is daemon-scoped, and the routed session/lineage surfaces let a person open the result and follow its parent/child relationship.                                                                                                                                                                                                   | **Yes for starting and following a child session.**                                                                                                                                                                                                                                                                                | Board collaboration is deliberately not inherited: `--board-access` needs the caller's current `FY_BOARD_CAPABILITY`, and an invited child must use its separately issued session capability. Resource governance is still a separate GAP: the cgroup controller is unmounted.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Work orchestration built in                                             | `fy task` and `fy task board` command groups are wired; task records, dependencies, status moves and file claims have mounted routes. An agent can use explicit `--session` targeting.           | `/v1/tasks` and `/v1/sessions/:id/tasks` are mounted and backed by the task subsystem.                                                                                                                                                                               | The session workspace can search its files and tasks, but task projection, board, graph, row and filter components have no routed task-board host; `/tasks` is a legacy redirect to sessions.                                                                                                                                                       | **CLI only.** The orchestration core can be operated from the shell.                                                                                                                                                                                                                                                               | Session-local search improves discovery but cannot create, change or organise tasks remotely. The real gap is still a mounted PWA task-board host; `FY_SESSION_ID` remains an ergonomics refinement, not that reachability dependency.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Cost tracking                                                           | `fy analytics` queries spend, tokens, duration and outcomes; `fy fleet usage` reports account quota.                                                                                             | Analytics is mounted and folds each finished session's own transcript into a token total, priced against that daemon's operator-owned `analyticsPricing` catalog in `config/daemon.json`.                                                                            | The routed Global Analytics page has query, table and time-series UI; session dashboards show quota.                                                                                                                                                                                                                                                | **Yes for token cost once the operator supplies rates; no for subscription spend.** The daemon ships no rates, so an operator who configures none still sees tokens without money.                                                                                                                                                 | Cost is API-equivalent: what the usage would cost at the rates the operator configured. Most fleet accounts are subscriptions, where that is not the bill, and every surface says so. An unpriced model, a session under several models and unreadable or damaged transcript evidence all report unknown rather than zero; a malformed or ambiguous catalog refuses daemon startup.                                                                                                                                                                                                                                                                                                                       |
| Render rich content directly in text                                    | No rich CLI renderer is part of the session journey.                                                                                                                                             | The daemon serves raw transcript/event evidence and safe file reads.                                                                                                                                                                                                 | Assistant Markdown renders in the session route; the Files pane safely previews admitted text, JSON, CSV, image and PDF content.                                                                                                                                                                                                                    | **Partial.** Markdown and rich file previews work in their mounted paths.                                                                                                                                                                                                                                                          | The logs-text projection still emits only user, assistant and notice rows. Tool calls/results, thinking blocks, durable send-ledger evidence and attachment upload/gallery composition remain flattened or unreachable in the transcript.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Speech to text / dictation from a phone                                 | `fy stt enhance` forwards already-transcribed TEXT to the enhancement provider. The CLI never records or recognises audio; `status`, `models`, `install` and `transcribe` are gone (`ac6b8a35`). | One text-only route: `POST /v1/stt/enhance`, scope `admin`, an ordinary JSON `ApiRoute` that makes an outbound hosted-model call authenticated with a key only the daemon holds. There is no recogniser, no model store and no audio route (same merge, `ac6b8a35`). | The composer mounts `DictationControl` (`packages/pwa/src/components/composer.tsx:313-326`); `lib/stt/browser-recognition.ts` drives the browser's own `SpeechRecognition`/`webkitSpeechRecognition`, shows interim words, and inserts the settled transcript at the caret through `onDraft`. Optional correction is local-by-default, Groq opt-in. | **Yes, in a browser that exposes SpeechRecognition on a secure page.** Firefox (preference-gated) and an installed iOS Home Screen app say so on screen with actionable copy instead of failing silently.                                                                                                                          | Recognition quality, offline behaviour and privacy belong to the browser vendor: some engines send the audio to the vendor's hosted speech service, so this is **not** device-local recognition. What Ferretry can state is narrower and true — Ferretry neither uploads nor stores microphone audio, and no audio reaches a daemon. GAPs: no amplitude meter (Web Speech exposes no analyser stream, see `surveys/tmux-browser-stt.md` §3 and `surveys/pwa-shape.md` §8); Groq correction is direct-only and unavailable over a relay carrier (`docs/relay-protocol.md` §13); no browser-local ONNX engine, so nothing is recognised by Ferretry's own code on the device.                               |
| Migrate when an account runs out of tokens                              | `fy migrate` describes migration to another same-kind account.                                                                                                                                   | `POST /v1/sessions/:id/migrate` is mounted with preflight, handoff report, replay protection and relaunch; #190 refuses a cross-family target.                                                                                                                       | The migration sheet is reachable from the session workspace and runs the existing daemon-bound destructive flow.                                                                                                                                                                                                                                    | **Yes on the daemon, opt-in.** A person can move a session by hand from the PWA, and a daemon whose operator has pooled its interchangeable accounts moves one automatically when the account it is on measurably runs out.                                                                                                        | The failover loop (`packages/daemon/src/lib/quota-failover`) is mounted and goes through the SAME preflight the manual sheet does — the migrator port it holds has no force flag and refuses a context downgrade outright. Exhaustion must be measured (a failed probe, an absent row or a rejected credential are never exhaustion) and headroom positively confirmed below a ceiling; a stale or never-collected usage snapshot halts the tick. GAPs: opt-in is per ACCOUNT (a pooled list in the state home), not per session, and there is no route, so an operator configures and reads it through `quota-failover/config.json` and `quota-failover/state.json` rather than through `fy` or the PWA. |

## The evidence behind the statuses

- PR #153 made send/interrupt and peer-wait completion real. The local CLI's
  owner-only token fallback makes named peer messaging possible without an
  ambient session id; sender attribution is server-derived rather than accepted
  from the caller body. The PWA still steers one visible session rather than
  presenting a cross-session agent exchange.
- PR #277 mounted `POST /v1/sessions/:id/answer` and the session `QuestionForm`.
  The route refuses an unbound or changed question and returns only after the
  native pane visibly advances. The source's broader matcher family remains a
  declared GAP, so an unsupported shape never receives a guessed answer.
- PRs #225 and #235 put the encrypted relay carrier on both ends. It carries
  the same daemon dispatcher as direct access, so remote reach is no longer
  restricted to a reachable LAN address.
- PR #268 mounted daemon-keyed encrypted attachment routes. The PWA has the
  gallery and unlock primitives, but the chat route still does not compose
  upload, unlock or durable attachment rendering; #272's safe rich previews
  are instead mounted in the Files pane.
- The workspace now mounts `SessionTerminalDeck` as the real, interactive
  terminal surface; its cached agent-pane snapshot is deliberately separate and
  read-only. The terminal stream is no longer direct-only: `docs/relay-protocol.md`
  §14 gives it a relayed stream session, and the composition root hands the deck the
  carrier-aware fetcher, so a relayed terminal opens and takes keystrokes. What the
  relay still does not carry is a session-ceiling refusal rendered in words (§13).
  The browser runtime remains an explicit 501 despite the merged pane components.
- PRs #126 and #134 described a daemon-bound dictation engine. That engine is
  gone. One squash merge (`ac6b8a35`) carried three distinct removals: it moved
  recognition into the browser's SpeechRecognition API, deleted the
  record-then-upload pipeline (`audio-capture.ts`, `pcm.ts`,
  `silence-segmenter.ts`, `utterance.ts`, `daemon-engine.ts`, `capabilities.ts`,
  `capture-error.ts`, `ort-precache.ts`), and removed the PCM16 worklet that fed
  that pipeline. Browser dictation is the shipped path now. A
  browser-local ONNX engine — recognition that provably never leaves the device
  — remains deliberately unported and is a different claim, because the Web
  Speech API does not make that promise.
- PR #144 supplied dashboard and migration-sheet components. The workspace
  mounts the sheet, and its model/effort controls are now composed; the broader
  dashboard is still separate.
- PR #184 closed remote live-event authentication with one-use socket tickets.
  #189 separately completed terminal-scoped ticket minting. This workspace still
  polls normalized logs and has no interactive terminal renderer.
- PR #276 mounted the Fleet Settings sub-tab and its host-authorized proposal
  flow. `packages/daemon/src/lib/fleet/{mutations,proposals,assets,asset-store}.ts`
  backs proposal routes in `runtime/mounts/fleet.ts`, and
  `packages/pwa/src/features/fleet/` is mounted through `daemonSettingsTabs` in
  `App.tsx`. The host half was `fy fleet authorize`; it and the approval flow it
  served are DELETED, and authority is now the capability layer
  (`docs/design/fleet-authority-unification.md`).
- The apply outcome is a **body, not a message**. Ordinary provisioning now
  captures undo evidence, unwinds in reverse and reports which of four states
  the host is in: committed; committed with only shared history failing after
  the manifest was published; rolled back with nothing of anybody else's moved;
  or rollback-incomplete, naming the exact paths whose restoration could not be
  verified. Moved-aside backups and an unreleasable apply lock are reported as
  **residue on success**, because undoing a committed apply to tidy up would
  delete the state the manifest now describes. What is **not** claimed: crash
  transactionality. The boundary covers a thrown error, not a killed task, and
  there is no journal-backed recovery.
- **Preparing a host is a separate outcome from applying one**, and the rows do
  not blur them. Initialization publishes **no manifest** — a just-prepared host
  has a configuration and an assets tree and still no accounts — so reporting it
  as a committed apply of zero accounts would tell a person their fleet is empty
  rather than that it is now ready. It has its own two outcomes: `initialized`,
  carrying the created, kept and directory lists plus the `pathEntry` a person
  adds to their shell profile so the wrappers are runnable at all; and
  `initialization-partial`, carrying those lists as they stood plus the reason
  and the exact path where preparation stopped, and deliberately no `pathEntry`
  because the host is not ready. Neither is a rollback: every file preparation
  writes is one that was absent, so removing them again could not be told apart
  from removing files somebody else had just created. Re-running completes the
  remainder and keeps what is there. Both reach the browser through the **same**
  `FleetApplyOutcomeSchema` the daemon parses its own response through, so the
  two ends cannot hold different ideas of what happened, and each gets its own
  words: a prepared host is told no manifest exists yet, and a partly prepared
  one is told where it stopped and that running it again is safe.
- **Publication refuses rather than overwrites**, and the cost is stated rather
  than hidden. A staged file is published with `link(2)`, which fails instead of
  replacing; a staged directory has no no-replace rename, so the tree is
  published with primitives exclusive at every level — a non-recursive `mkdir`
  per directory and a `link` per file. The tree therefore becomes visible entry
  by entry rather than all at once, which is acceptable only because a
  part-finished publish leaves the operation unsealed, and an unsealed
  destination is reported rather than deleted on a guess.
- No fidelity claim is made for any of these screens, because there is no
  original screen. `kfleet` has no create verb, no mutation API and no dry run
  (`apply` takes only `--prune`; its `list` re-derives a summary from the
  config), and the session daemon deliberately never wrote the fleet — its
  learning path emits a patch file for a human to paste. See
  [surveys/kfleet-map.md](surveys/kfleet-map.md#m--change-it-without-a-shell).
- Source coverage for this audit: kteam's `SessionManager.answer` and
  `api-server` answer route map to `packages/daemon/src/lib/session/question/`,
  `runtime/mounts/session-answer.ts` and PWA `question-form.tsx` (**PORTED with
  the matcher GAP above**). Its `addAttachment`/`getAttachment`/unlock paths map
  to daemon `lib/attachments/` and `runtime/mounts/session-attachments.ts`
  (**PORTED**), while PWA chat composition remains **GAP**. Its
  `BrowserService.attachViewer` maps to Ferretry's browser worker/relay
  transport (**PORTED**) but has no session runtime or production viewer host
  (**GAP**).

## Recommended order of work

1. **Finish the PWA session data plane.** Replace the uncursored logs poll with
   mounted paged history plus live events, then compose durable send-ledger,
   tool, attachment and thinking surfaces. Dictation and runtime controls are no longer on
   this list: the composer mounts it and it runs in the browser.
   The workspace host, plain-text steering, files, snapshot, Markdown and
   manual migration are now present; browser automation remains separate.
2. **Make launched-agent identity and board capability semantics consistent.**
   The loopback token-file fallback already makes the local CLI usable, so do
   not add credentials merely to make peer addressing work. Supply
   `FY_SESSION_ID` where parentage, self-reference, journal attribution and
   peer waits need it; align the launcher’s `FY_SESSION_BOARD_CAPABILITY` with
   the start command’s board-capability input. This is an ergonomics and
   correctness improvement, not the PWA's remote-workspace dependency.
3. **Render what a relayed stream refuses.** The terminal's relay reach was the
   open question here and is now decided: the PWA `@xterm/xterm` deck, ticket
   minting and socket bridge are mounted, the cached session-pane snapshot is
   deliberately a separate read-only fallback, and a relayed terminal is a §14
   stream session rather than a direct socket. What is left is the refusal:
   `docs/relay-protocol.md` §14 requires a rendezvous session-ceiling `4429` to be
   told to the reader in words, no surface says it, and a live event feed refused
   that way is swallowed by `App.tsx` without a retry.
4. **Compose the per-session browser runtime before its display.** The worker
   program and its transport already exist; build the runtime that turns a
   session id into a launched worker and a production `BrowserViewerHost`, then
   add the browser-stream ticket path and mount the existing UI. The present 501
   makes this a distinct, larger dependency from the workspace work.
5. **Complete the orchestration surface.** Mount a PWA task board (the route
   currently redirects away), then verify parent/child and task-board actions
   from a launched agent after step 2.
6. **Surface the automatic failover an operator already has.** Same-family
   enforcement, the manual PWA sheet and the opt-in quota-triggered failover
   loop are all mounted; the loop acts only on measured exhaustion and
   positively confirmed same-kind headroom, and goes through the preflight.
   What is left is reach, not safety: give it a route so `fy` and the PWA can
   configure the pool and read the tick's account, and decide whether consent
   should also be per session rather than only per account.
7. **Finish the fleet editor where it stops at accounts.** Creating an account
   and editing its layer are mounted, and so is preparing a fresh host; removing
   an account, moving one, and editing `profiles`, `variants`, `commands`,
   `aliases`, `defaultHomes`, `sharedHistory`, `health` and `usage` are still
   hand edits of `config.yaml`. The mutation grammar already has the shape for
   it — one more named intent per change, derived server-side and reviewed the
   same way — so this is reach rather than design. Two smaller items belong with
   it: carry launchability evidence on a fleet route instead of only on
   `GET /v1/doctor`, and decide whether per-profile environment gets a
   proposal-shaped editor or stays a host concern.
8. **Close the remaining independently valuable gaps.** Supply operator-owned
   pricing data for cost totals. Dictation itself is done through the browser's
   SpeechRecognition API, so what is left under STT is a narrower product
   question: whether recognition that provably never leaves the device is worth
   a ~640 MB model and ~25 MB of WASM per profile, since the browser engine does
   not promise it. The amplitude-meter GAP belongs with that decision — a real
   analyser stream only exists for a host that owns its own audio graph.

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

Fleet configuration is narrowed too, and on a **different axis** — worth stating
so the two are not confused. The boundary above is about processes sharing a UID
on the host, where a restriction enforces nothing. A paired browser is not on the
host: it holds a device-class token minted by pairing, it can be a phone somebody
left on a train, and a fleet apply writes executables onto `PATH`. So reads and
composing a change are open to it, and changing the host is governed: `fleet`/
`configure` is decided by the operator's grants, and where the machine has an
operator password a governed caller proves it again against that one exact staged
change. That is a real boundary because the two sides are genuinely different
principals, unlike an agent that could read `api-token` itself.

So: full admin over sessions and processes; narrow capabilities only where state
is genuinely shared or the principal is genuinely remote. Anyone revisiting this
should change it deliberately rather than because the full-admin scope looked like
an oversight.

The second correction, from this revision: fleet management is no longer
CLI-only. A person can see their fleet and change it from the product, under an
authority the surface states before it offers a control — but the editor stops at
accounts, and everything else about a fleet is still a hand edit of `config.yaml`.

The principal correction to the previous reachability measure is therefore:
the PWA session workspace is no longer a placeholder, but its structured/live
data plane and several already-ported controls remain uncomposed. Agent identity
is a separate control-quality improvement, and the local-token design has an
explicit full-admin trust boundary. A component or route is still not credited
until the human journey actually reaches it.
