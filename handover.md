# Product Handover

> [!NOTE]
> **Ferretry context.** This backlog transferred from the original kteam handover
> (home-manager repo) on 2026-07-30. Item numbers are stable — do not renumber. Everything here
> lands **after** the full kteam→Ferretry replication (see `docs/PROMPT.md` phase 2); the
> replication itself is not a backlog item. Where an item says "kteam", read the Ferretry
> equivalent (`fy`, `fyd`, `~/.ferretry`). Items 47/48/67 reference the shared-board platform
> capability described below.

> [!IMPORTANT]
> A shared board is tree-scoped by default. It may explicitly invite another top-level agent as a new membership root; descendants never inherit access automatically. Use this platform capability rather than rebuilding it in this backlog.

## 🧭 How to use this handover

- Import every row as **Todo**.
- `☐` is outstanding and `☑` is landed on `main`. A row is only ticked when its whole definition of
  done is shipped and gated; partial work stays `☐` and says what is left in the section prose.
- Keep the stable item number for discussion and speech-to-text.
- Preserve the requirement, **hard dependencies**, and **soft coordination edges**.
- A prior branch, commit, or worktree is an implementation lead—not proof of completion.
- Do not spawn audit swarms. Implement, verify, review, and land one bounded feature at a time.

### 🎙️ Speech-to-text examples

- `Item 39: make Markdown preview live`
- `Drop item 12`
- `New task: ...`

### 🧩 Dependency key

- **🔒 Hard** — must be satisfied before the feature can be completed safely.
- **↔ Soft** — shared files, interfaces, or ordering; parallel work needs an explicit conflict plan.
- `—` — no known dependency.

## 🚀 Recovery, lifecycle & resource safety

Keep agents alive, bounded, and recoverable without risking the daemon.

|  ID | Todo | Feature                                  | Definition of done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 🔒 Hard | ↔ Soft                |
| --: | :--: | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------- |
|  47 |  ☐   | **Configure warden recovery policy**     | Administrators should configure whether the warden may nudge, kill, migrate within a harness, or migrate across harnesses, including allowed targets. A warden cannot widen board membership without the explicit invitation authority.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | #48     | #14, #30, #44         |
|  48 |  ☐   | **Harden cross-harness migration**       | Start the replacement with full durable coordination state, explicitly invite its top-level agent to the existing shared board, verify that it accepted and can act, then allow the old top-level agent to relinquish membership and stop. The board and its tasks never move.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | —       | #31, #44, #47         |
|  67 |  ☐   | **Fork a conversation from any message** | Add a transcript action that lets the user choose an exact durable message and fork from there into a new independent session. Let the user select harness, account, model, and effort; both same-harness and cross-harness forks are required. Copy conversation context only through the selected message, preserve source-session/message provenance, attachments, and supported references, and visibly report anything that cannot cross harnesses. The source session, descendants, waiters, and pointers remain untouched. The fork gets a fresh identity plus a Lineage edge back to the source message; shared-board access is never inherited and needs an explicit grant or top-level invitation. Use an exact repository snapshot when one exists, otherwise warn that conversation time was rewound but filesystem state was not. | #48     | #16, #31, #49         |
|  44 |  ☑   | **Reap terminal tmux sessions**          | A daemon-owned five-second sweep should safely remove exact registered panes and process trees after durable terminal states.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | #48     | #30, #31, #47         |
|  30 |  ☑   | **Fleet cgroup controls and UI**         | Add configurable fleet-wide and per-agent CPU/RAM caps without starving the daemon. Include a Settings UI that shows effective limits, edits both levels, enables/disables enforcement, explains restart requirements, and reports apply failures.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | —       | #31, #44, #45         |
|  31 |  ☑   | **Run the daemon from stable snapshots** | Run the daemon from a stable built snapshot instead of live source. This prevents half-written edits from taking down the daemon and fleet, and makes worktree parallelism, rollback, and controlled rollout safer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | —       | #3, #4, #30, #44, #48 |
|   7 |  ☑   | **Add task-done control**                | Expose a discoverable Mark Done action in aggregate List and Kanban views, enforce shared-board permissions, and update the UI immediately.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | —       | #35, #43              |

**#31 is done.** Ferretry has a daemon-keyed, content-addressed snapshot store, strict verification,
atomic promotion, rollback through the ordinary promotion path, explicit build/promote/list CLI
commands, and install/start/restart capture the promoted snapshot and execute its exact canonical
artifact path. kteam has no daemon artifact snapshot to port: `modules/kteam-ts/src/index.ts` resolves
`kteamd` and passes that wrapper to `DaemonService`; `DaemonService.install/start` execute it, and the
Home Manager `modules/default.nix` wrapper then runs live `daemon-entry.ts`. Its `kteam snapshot`
command captures a session pane and is unrelated.

The two remaining GAPs are closed. **A garbage-collection root's lifetime is now its snapshot's
lifetime**: `nixGcRootDirectory` holds one root per retained snapshot, named by
`daemonSnapshotGcRoot()` — the single owner of that mapping — so promoting a second Nix-built snapshot
no longer re-points the one root and leaves the rollback candidate without the loader and libraries
its executable needs. A root is released only when its snapshot is no longer retained; neither `stop`
nor `uninstall` withdraws protection from a snapshot still sitting in the store, and `uninstall` says
so. The one-per-daemon root earlier releases kept is retired as `supersededNixGcRoot`, but only once
nothing that still needs a root failed to take one. Reconciliation reads a **cheap, per-entry-tolerant
inventory** (`IDaemonSnapshotPort.retained()`) rather than the verifying `list()`, which stays the
operator report: an interrupted build leaves a directory no later build repairs, and a verifying
listing on the lifecycle's critical path let one such sibling disable every mutating verb. An entry
that cannot be read or whose manifest identity cannot be trusted is warned about and skipped; the
managed store structure is checked without reading or hashing an executable. An inventory that is not
the whole truth releases **no roots at all**, because a root with no matching entry is
indistinguishable from one whose snapshot merely could not be read.

**Every mutating lifecycle verb is one serialized transaction**: install, uninstall, start, stop,
restart and both snapshot mutations run inside exclusive claims, so no invocation can interleave a
root update with another's service-definition write. Reporting verbs (`status`, `logs`,
`snapshot list`) are deliberately unserialized. Service definitions are published with a
same-directory private write, file fsync, atomic rename and parent-directory fsync, so a crash exposes
the old complete unit/plist or the new complete one rather than a truncated target. Claims are keyed
on every target those verbs may own: the logical systemd unit or launchd label, its definition file,
the snapshot/root ownership derived from `XDG_STATE_HOME`, and the daemon-qualified state home used by
the direct fallback. They are acquired by semantic role rather than unresolved path spelling, so
aliases, locales and different state or config environments cannot reverse the order into a deadlock;
two daemon names remain independent. A crashed command leaves every claim it acquired behind by
design: the primitives would reclaim safely, but the `alive(pid)` verdict that would authorise it
cannot be trusted across PID namespaces and containers, where a live owner reads as dead and
reclaiming would delete a live holder's proof. The cost is stated rather than argued away — each claim
is waited on for up to 140 seconds, and a manager-backed command can leave as many as four directories
that block every mutating verb until a person independently verifies no holder is live and removes
each one. A refusal names one directory; a retry may expose the next. It also names the verb, owner,
whether that owner is visible from this PID namespace, and why absence is not proof of death.

Two declared residues, neither reopening the row: **retention is unbounded** (nothing prunes
snapshots, so the reconciliation's release path exists for a prune verb that has not been written),
and the row's headline promise — that a running daemon cannot be taken down by a half-written source
edit — **has no automated regression guard**, because the SIT tier is CLI-only and proving it needs a
real service manager; the evidence for it is a manual compiled-binary journey. A killed acquisition
can also leave a hidden staging directory beside the claim, which blocks nothing.

## 🔎 Search, navigation & surfaces

Make every important destination and object easy to find.

|  ID | Todo | Feature                                    | Definition of done                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 🔒 Hard | ↔ Soft                                |
| --: | :--: | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | ------------------------------------- |
|   6 |  ☑   | **Current-session file and task search**   | `Cmd+K` opens a fast search over the current session's files and tasks. Reuse the same visible search control in Tasks List/Kanban and Files. Tasks match number, title, description, original ask, and clarifications; files match name and path. Support keyboard, desktop, and mobile use with clear loading and empty states.                                                                                                                                                                | —       | #35, #37, #38, #43                    |
|  15 |  ☑   | **Rebuild and loosen the top bar**         | Merge the top-bar restructuring and cramped-spacing fixes: group destinations coherently, center the current-session search, provide enough breathing room on desktop and mobile, and use a dismissible mobile destination picker.                                                                                                                                                                                                                                                               | —       | #6, #38, #45                          |
|  34 |  ☑   | **Mark agent browser ownership**           | Agent-launched browsers and terminals should have durable, visible ownership so the human can identify them in the side panel.                                                                                                                                                                                                                                                                                                                                                                   | —       | #35, #41, #44                         |
|  35 |  ☑   | **Unified side-pane tabs**                 | Web, files, tasks, terminals, and default utility views should share a unified tab model with one tab per file and one browser tab per page. Pins and Attention do not belong in this bento/side-pane model.                                                                                                                                                                                                                                                                                     | —       | #6, #36, #37, #43, #45, #62, #63, #64 |
|  36 |  ☐   | **Compress the browser HUD bar**           | Browser controls consume too much space and should collapse into one small bar, preferably integrated with the top bar when feasible.                                                                                                                                                                                                                                                                                                                                                            | #35     | #15, #41                              |
|  37 |  ☑   | **File explorer tree, search, and reload** | Build the compact Files bar, a persistent collapsible directory tree, and a visible file/folder name-and-path search using item 6's shared search primitive. Every open file tab has a visible Reload action that bypasses stale client cache and fetches the latest bytes from the session host, with honest loading, stale, and error states while preserving the tab and reading position where practical. The explorer remains available after a file opens and defaults sensibly on mobile. | #6, #35 | #16, #62                              |
|  38 |  ☑   | **Global destination and settings finder** | Keep app destinations and individual settings searchable from the top bar or a dedicated palette, with a mobile pull-down gesture that does not break scrolling. `Cmd+K` remains reserved for current-session file/task search in item 6.                                                                                                                                                                                                                                                        | #15     | #6, #45                               |
|  41 |  ☑   | **Browser expands to full viewport**       | The real browser should be able to take the full viewport instead of remaining constrained to its pane.                                                                                                                                                                                                                                                                                                                                                                                          | —       | #34, #36, #64                         |
|  45 |  ☑   | **Simplify status and lineage navigation** | Rethink the low-value overflow actions, consistently call the tree Lineage, and remove redundant side shortcuts already available in the top bar.                                                                                                                                                                                                                                                                                                                                                | —       | #15, #35, #38                         |
|  63 |  ☐   | **Put Pins in a top link strip**           | Remove Pins from the bento box and from the old fifth `@@@@@` autocomplete tier. Show them as compact Slack-like mini-tabs at the top of the session. Pins can target messages, files, tasks, PR URLs, and ticket URLs; handle overflow, mobile layouts, provenance, and broken targets clearly.                                                                                                                                                                                                 | #16     | #33, #35, #43, #64                    |

## 🗂️ Projects & worktrees

Treat any workspace as a durable project. Git projects additionally gain safe worktree forks beneath them.

|  ID | Todo | Feature                               | Definition of done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 🔒 Hard  | ↔ Soft                      |
| --: | :--: | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------- |
|  69 |  ☐   | **Add a Projects hub and onboarding** | Add a top-level Projects UI. A Project is a durable workspace/folder record—not a session, worktree, board, or necessarily a Git repository—and owns its display name, canonical root, metadata, and known sessions. Users can add an existing local folder, clone a Git URL, create a new folder/project with optional Git initialization, or confirm a project discovered from an existing session path/history; never silently enroll discoveries. For Git projects, attach repository/common-directory identity, remotes, default branch, and checkouts, deduplicating multiple worktrees beneath the same Project. Project detail shows files, active agents/sessions, linked shared boards, and—when Git exists—branches, worktrees, PRs, and CI metadata. A new-project flow can launch an interactive top-level agent immediately; Git projects also offer **Fork into worktree** and can launch the agent in that new checkout. Non-Git projects remain fully usable and simply omit worktree-only controls while offering an explicit Initialize Git action. Make Projects reachable from the top bar and global destination finder; do not create a separate board page.                                                                                                                                                                                                                                                               | —        | #6, #15, #31, #35, #38, #68 |
|  68 |  ☐   | **Make Git worktrees first-class**    | For every Git-backed Project, provide a prominent **Fork into worktree** action plus Worktrunk-inspired lifecycle controls in CLI, API, and UI. List and search every checkout beneath its Project with branch, path, HEAD, dirty/staged/untracked state, ahead/behind and integrated status, safe-to-delete state, owning agent/session, lock/activity state, PR/MR link, CI/review state, and optional summary. Let users select an existing checkout or fork/create one from a new or existing branch, explicit base, default/current branch, or PR/MR; then open/focus it or launch an agent inside it. Refresh must read current Git/process state rather than stale UI data. Each agent gets an exclusive managed worktree, stable built binary/environment, and preserved relative-subdirectory cwd while the shared control-plane daemon and tree board remain stable. Removal must distinguish dirty-worktree force from unmerged-branch force, refuse the current/shared/locked/active checkout by default, protect ignored content and unpushed commits, never strand live terminals, and delete a branch only when safely integrated or explicitly confirmed. Prefer recoverable background trash and narrowly scoped process reaping where supported. Borrow Worktrunk's fast picker, status visibility, and safety ergonomics without requiring shell-directory switching semantics. Non-Git Projects do not expose these controls. | #31, #69 | #3, #4, #6, #30, #38, #44   |

## ✍️ Composer, references & transcript

Make writing, rendering, runtime selection, and references feel coherent.

|  ID | Todo | Feature                                               | Definition of done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 🔒 Hard  | ↔ Soft                            |
| --: | :--: | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------- |
|  16 |  ☑   | **One reference standard everywhere**                 | Use one parser, renderer, click behavior, and proof-before-link rule across messages, task content, Attention content, notices, and composer editing/preview. The direct authored forms are `:agent`, `!attention`, `@file`, and `&task`; skills accept both `/skill` and `$skill`; browser and terminal instances join the same proven-reference system. Proven sigils must also render as clickable references inside inline backtick spans and fenced code blocks while retaining code styling and leaving every surrounding byte untouched; unresolved or escaped tokens remain literal. Update the team skill with exact authoring examples, code-span/fence behavior, the complete repeated-`@` and direct-sigil autocomplete matrix from item 33, the rule that references are tokens rather than Markdown links, and what each click opens.                                 | —        | #32, #33, #39, #43, #63, #64, #65 |
|  18 |  ☑   | **Prevent file-reference injection crashes**          | Injecting a file reference could crash or freeze the server; the fix must preserve normal attachment and composer behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | —        | #9, #16, #20                      |
|  20 |  ☑   | **Repair structured questions**                       | Make structured questions render reliably and preserve the complete answer flow.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | —        | #10, #39                          |
|  23 |  ☑   | **Delete the clear command**                          | Remove the nonfunctional Clear command from handlers, UI, and autocomplete. Keep Compact.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | —        | #33, #39                          |
|  28 |  ☑   | **Normalize analytics model identity**                | Transcript and session model identifiers can disagree because a selector encodes context-window choice differently from the underlying model.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | #13      | #42, #49                          |
|  32 |  ☑   | **Polish the Codex transcript UI**                    | Match the supplied Codex transcript screenshot as closely as practical while preserving transcript behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | —        | #16, #49                          |
|  33 |  ☑   | **Complete and configure every autocomplete trigger** | Preserve the full useful ladder: `@` Files, `@@` Agents, `@@@` Tasks, and `@@@@` Attention. Remove the old fifth `@@@@@` Pins tier because Pins move to item 63's top strip; OpenAI Templates must not appear as an `@` reference tier. Direct `:`, `!`, `&`, `$`, and `/` triggers must also open their appropriate menus. Add three independent Settings switches—every remaining repeated-`@` tier, `&`/`:`/`!` direct references, and `$` skills—all enabled by default, persistent, and applied immediately. A disabled switch suppresses suggestions only; authored references still parse, `/` remains available, and skills may still use either `/skill` or `$skill`. Preserve the already-working `@` and `/` behavior and cover attachments, caret positions, keyboard use, IME, mobile, and accessibility.                                                              | #16      | #23, #38, #39, #49, #63           |
|  39 |  ☑   | **Markdown and Vim composer**                         | Build a real-textarea composer with compact inline references, optional Vim mode, and Markdown rendering/preview. Preserve IME, autocomplete, dictation, accessibility, and mobile keyboards.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | #16      | #20, #29, #33, #49                |
|  43 |  ☑   | **Tree-board reference actions**                      | On the shared board's aggregate List and Kanban, add Add to chat/use-reference actions. In Skills, add separate Use/Add to chat and View full detail actions. Do not create a separate board page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | #16      | #6, #7, #35                       |
|  49 |  ☑   | **Independent composer runtime controls**             | For both Codex and Claude, change model and thinking/effort independently and show the model actually in use.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | —        | #28, #32, #39                     |
|  64 |  ☑   | **Reference and co-control browsers and terminals**   | Give every registered browser page and terminal a stable, session-scoped hard reference exposed through autocomplete and Add to chat. Show exact ownership and live state. Through the platform, authorized agents and the user can select, inspect, and control the same exact browser or terminal instance; actions are visible, audited, permission-checked, and never target an unregistered pane or arbitrary process.                                                                                                                                                                                                                                                                                                                                                                                                                                                         | #16, #34 | #35, #36, #41, #44                |
|  65 |  ☑   | **Render rich illustrations inline**                  | Define a fenced `fy-render` message block whose first line declares `type: html`, `svg`, `lottie`, `mermaid`, or `image`. Render it directly in the conversation; an HTML payload may include full HTML, CSS, and JavaScript for interactive explanations. Run executable content in an isolated, resource-bounded sandbox with strict CSP, no app credentials, filesystem, same-origin storage, or network access by default. Provide pause, reload, source, fullscreen, accessible description, and static/error fallback controls. Ordinary Markdown/raw HTML never executes. The team skill must teach the exact syntax and state unambiguously that it is conversation-only: NEVER use `fy-render` when writing or editing documentation, handovers, READMEs, specs, source files, or exported artifacts; use the document's native format and ordinary static assets instead. | #39      | #16, #32, #62, #64                |

**#18 landed.** The exact source freeze input was `@a b` with the caret after `b`. kteam's
`detectComposerTrigger` rejected the leading candidate, then called `lastIndexOf` with `-1`; JavaScript
clamped that position to zero and rediscovered the same `@` forever. Ferretry had already carried the
engine correction and this exact regression in PR #199
(`packages/pwa/src/components/composer-autocomplete.ts` and its unit test). The remaining provider
class was real in both products: a listed path was concatenated into `@${path}`, so `a:12` addressed
file `a` at line 12, whitespace split a token, and a leading `@` selected another autocomplete tier.

Ferretry now re-parses every proposed file token and requires the parsed path and selector to round-trip
exactly before enabling it. It preserves ordinary files, ranges, incomplete selectors, Unicode paths,
and directory navigation (including a directory ending in `.`); unrepresentable rows remain visible
with an explicit refusal, and the noncanonical `:LINE:COL` form is refused honestly. Queries longer
than 4,096 code units stop before parsing, cache lookup, or daemon fetch. This provider proof and bound
are a **GAP in kteam**, not a port: kteam's provider still concatenates candidates and has no query
ceiling.

The broader class was checked too. File references are not recursively expanded by the daemon; send
delivery treats them as ordinary literal/pasted text, so self-referential contents cannot recurse.
`packages/daemon/tests/integration/session/filesystem/confinement.test.ts` proves traversal and absolute
paths are refused, escaping/in-tree/broken symlinks are not served, oversized files are bounded before
read, tree swaps fail closed, and vanished entries do not crash enumeration. Attachments use their
separate daemon-scoped path and retain their existing validation and composer behavior.

**#20 is done, and what it still does not cover is named rather than implied.** The flow is now real end to end:
a transcript `AskUserQuestion` becomes a `pendingQuestion` on the session document, the browser
renders it, `POST /v1/sessions/:id/answer` drives the exact rendered form, and the durable state is
cleared only after the pane visibly advanced. What this pass added is that the answer is now
performed **at most once per logical request**: one dedicated per-session queue is held across the
pending re-read, the drive and the clear; an identical retry joins the operation already running
instead of typing a second time; the same request id carrying a different answer is refused before
any key; and the receipt is durable, so a lost response or a daemon restart replays the settled
answer rather than re-driving the form. An answer that was admitted and cannot be proved either way
is quarantined for a person, never retried — repeating arrow and `Enter` into a selector that has
since moved would answer something nobody chose.

**Question discovery is no longer a side effect of reading a session.** The monitor tick reconciles
transcript and durable answer evidence for every session it can see, under the answer domain's own
per-session queue and with no terminal-drive capability at all, so a question materializes whether or
not a browser happened to poll — and a session whose evidence cannot be read is reported by id rather
than allowed to abandon the roster.

**A failed answer no longer strands the session, except in the one case that cannot be proved.** A
drive that fails snapshots the pane, sends exactly one positively-bound Escape, releases the durable
question and tells the human what to reply to in prose. What is NOT ported is the pane-matcher family
the migration survey lists as GAP: without it, a cancellation whose effect was not positively observed
leaves both the receipt and the question standing for a person rather than guessing, and abandoning a
named question through `interrupt` still refuses with `question_abandon_unsupported` — releasing the
wrong overlay is worse than refusing.

## 🚨 Attention, notifications & warden

Human intervention should be obvious, brief, and genuinely necessary.

**#11 landed.** Dismissal now has the intended asymmetric authority at the daemon boundary: a request
attributed to an agent may dismiss only Attention whose recorded origin carries the same session,
while a human may dismiss any item. Malformed or unrecognised attribution is refused, cross-session
mutations fail before storage, and a missing session is never treated as an empty board. Agent
attribution remains an operational client-set header under the shared admin token, not a per-session
credential. Dismissal addresses the item instead of erasing it, retaining the disposition and resolver
in the audit ledger; the CLI explains the policy and the PWA shows the resulting evidence.

**#26 landed.** The dedicated Warden route now renders concise verdict rows instead of a dense
operational dump: `packages/pwa/src/features/warden/warden-verdicts.tsx:98-181` shows the verdict
badge, callsign, reason, relative time, and provenance/failover line as a flat list, with a
disclosure toggle for long histories. Opening a row hands its daemon and verdict to
`packages/pwa/src/features/warden/warden-report-dialog.tsx:52-95`, a labelled, focus-managed dialog
with a bounded, independently scrollable body and an explicit report-evidence-unavailable alert
rather than a silent blank.

`packages/pwa/src/App.tsx:768-860` owns the daemon-scoped read: it fences state to the daemon that
requested it, polls every 30 seconds while the tab is visible, and distinguishes loading,
unavailable (no index could be read), and stale (last verified index kept, with a visible warning)
from the ordinary ready state — a failed read is never rendered as an empty or healthy history.
`packages/daemon/src/lib/runtime/mounts/warden.ts:131-173` serves the two calls this reads from,
typed end-to-end through `packages/protocol/src/lib/client.ts:69-70` and
`packages/protocol/src/adapters/fy-api-client.ts:345-354`.
`packages/daemon/src/adapters/warden/report-reader.ts:49-56` limits the full-report route to a
direct Markdown child of that daemon's own report directory, so a verdict's `reportPath` can never
become an arbitrary-file oracle for a paired browser.

|  ID | Todo | Feature                                 | Definition of done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 🔒 Hard | ↔ Soft            |
| --: | :--: | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------- |
|   8 |  ☑   | **Resolve addressed attention items**   | Remove answered or dismissed Attention from the active view immediately, and teach agents that addressed Attention must not remain open.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | #11     | #10, #17          |
|  10 |  ☑   | **Four attention kinds**                | Support four action-based Attention types: permission, choice, answer review, and open response. Make every type visible and understandable in the UI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | —       | #8, #11, #17, #40 |
|  11 |  ☑   | **Attention dismissal by both sides**   | Agents should dismiss items they raised, while the human should be able to dismiss any attention item.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | —       | #8, #10, #17, #40 |
|  12 |  ☐   | **Agent-callable notifications**        | Provide product notifications without duplicating native harness notifications. Attention notifies automatically; other notification events need an explicit, auditable path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | —       | #8, #10, #11, #47 |
|  14 |  ☐   | **Fix warden Attention escalation**     | Ordinary Attention raised by individual sessions must not affect the warden's suspicion scan and must not be copied into warden reports. The warden evaluates the current cluster snapshot, identifies genuinely suspicious nodes, and first applies every safe remedy allowed by item 47's policy. Only when it cannot safely fix an exact suspicious node—or an allowed repair fails—may it create one deduplicated, node-scoped Attention containing the evidence, attempted or forbidden remedy, and concrete human action required. Resolve that Attention when the node recovers or the human addresses it; never raise one merely because a session already has Attention or changes state. Show model and CLI automatically and make the node reference clickable. | —       | #8, #10, #26, #47 |
|  17 |  ☑   | **Give Attention its own action modal** | Remove Attention from the bento box. Opening an item launches a focused modal that explains what can be done, what should be done, and presents the valid actions directly. Use clear visual types, minimal chrome, and a phone-first layout.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | #10     | #8, #11, #35, #40 |
|  26 |  ☑   | **Clean up warden reports**             | Render concise, readable warden reports instead of dense operational dumps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | —       | #14, #47          |
|  40 |  ☑   | **Swipe to answer attention**           | A dedicated mobile entry point should map swipes to typed answer choices, while open questions use text and direct answers remain possible.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | #10     | #11, #17          |

## 📊 Analytics

Collect trustworthy session data first; build readable views on top.

**#13 landed.** A finished session is ingested once it reaches a durable terminal state — a recorded
finish instant AND a terminal status, never a guess that it looks done — and its transcript is folded
and priced at that moment into `state/index/analytics.sqlite`. The store is SQLite rather than DuckDB:
the daemon already ships a Bun-native SQLite engine for its session index, and the analytics table is
one bounded row per session, so a second embedded engine would be a dependency and a build target with
nothing to show for it. The queryable, columnar-per-measure shape the row asks for is unchanged.

The store is DISPOSABLE: it can be dropped and re-ingested from the durable session records, and a
boot that could not reuse the index does exactly that. A session whose transcript could not be read is
stored as unknown with the reason, never as a zero.

|  ID | Todo | Feature                                | Definition of done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 🔒 Hard | ↔ Soft        |
| --: | :--: | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------- |
|  13 |  ☑   | **Analytics ingestion**                | Finished Claude and Codex sessions should ingest analytics into a queryable DuckDB-style store before richer analytics UI is built.                                                                                                                                                                                                                                                                                                                                                                              | —       | #28, #42      |
|  42 |  ☑   | **Default analytics query list**       | Global and per-session analytics pages should ship with a readable curated list rather than requiring users to invent queries.                                                                                                                                                                                                                                                                                                                                                                                   | #13     | #28           |
|  66 |  ☐   | **Configure and sync API model costs** | Add a Settings/API surface to key in per-model API pricing and pull refreshed pricing from configured providers when available. Track input, output, cached-input, reasoning, image, and tool rates with currency, unit, source, effective date, and last-sync time. Preview provider changes before applying them; allow explicit manual overrides. Snapshot the effective rate with usage so historical session costs do not silently change, and show unknown/unpriced usage separately rather than guessing. | #13     | #28, #42, #49 |

## 📎 Files & attachments

Handle sensitive documents safely.

|  ID | Todo | Feature                                  | Definition of done                                                                                                                                                                                                                                                                                                                                                                                                | 🔒 Hard | ↔ Soft            |
| --: | :--: | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------- |
|   9 |  ☑   | **Encrypted attachment decryption flow** | Encrypted documents should prompt for a password, decrypt only in memory, and give decrypted bytes to the agent without writing a decrypted copy to disk.                                                                                                                                                                                                                                                         | —       | #16, #18          |
|  62 |  ☑   | **Render rich file previews**            | A file click should render `.html` and `.htm` safely in a sandbox, PDFs in a real viewer, raster images, isolated/safe SVG, and CSV as a readable table. Every renderer uses item 37's network Reload path and re-renders the newly fetched bytes. Keep raw/open/download fallbacks, preserve the explorer and one-file-tab behavior, and handle large, malformed, or unsupported files without freezing the app. | —       | #9, #16, #35, #37 |

## 📱 PWA & mobile

Phone behavior is part of acceptance, not a later polish pass.

|  ID | Todo | Feature                           | Definition of done                                           | 🔒 Hard | ↔ Soft   |
| --: | :--: | --------------------------------- | ------------------------------------------------------------ | ------- | -------- |
|  29 |  ☑   | **Unblock mobile text selection** | A mobile context menu blocks text selection and interaction. | —       | #35, #39 |

## 🛠️ Reliability & development workflow

Prevent repeated breakage in everyday development.

|  ID | Todo | Feature                             | Definition of done                                                                              | 🔒 Hard | ↔ Soft  |
| --: | :--: | ----------------------------------- | ----------------------------------------------------------------------------------------------- | ------- | ------- |
|   3 |  ☑   | **Fix gitlint in worktrees**        | Make commit linting work reliably inside mandatory Git worktrees.                               | —       | #4, #31 |
|   4 |  ☑   | **Stop hiding untracked files**     | Always show untracked files so new callees cannot disappear from reviews or commits.            | —       | #3, #31 |
|   5 |  ☐   | **Land Tasks pane performance fix** | Make Tasks load quickly by eliminating sequential task-file reads; record before/after timings. | —       | #35     |

**#3 is complete (2026-08-06).** PR #283 had diagnosed the mechanism correctly and then broken
commit linting repo-wide: its `shellHook` block ran `pre-commit install` without `-f` on every
`direnv exec`, so migration mode promoted pre-commit's own launcher to `<hook>.legacy`, which then
called itself. Measured on the live repository from a linked worktree, both a **valid** and an
**invalid** subject exited `1` — the valid one after the gate had printed `Passed`. Installation now
belongs to `nix/git-hooks.nix`, and `checks.pre-commit-check.shellHook` is no longer sourced into the
devshell (the check itself is unchanged). The launcher carries no worktree and no `/nix/store` path,
so it is byte-identical on every revision and each checkout still lints at its own generated config;
installation compares before it writes, serialises real repairs on a lock in the common directory,
and renames launchers into place. After the change, the same two probes gave exit `0` and exit `1`
with the conventional-commit diagnostic.

Sharing one hooks directory with worktrees that still run the old `shellHook` was tried first and
**measured**: twenty takeovers a minute, the shared launcher owned by a stale worktree in 96 of 120
samples, and every commit refused while it was. Each worktree therefore also gets a private
`ferretry-hooks` directory selected by a worktree-scoped `core.hooksPath`, which is why
`extensions.worktreeConfig` is the one repository-level setting the installer writes — skipped, with
the reason printed, where `core.bare` or `core.worktree` would change meaning. The shared install
stays as the baseline for the worktrees `packages/daemon` creates without ever entering a devshell.
The regression check is the `a-git-hooks-worktree` gate (`nix/git-hooks/worktree-proof.sh`), which
builds a scratch repository with three linked worktrees and proves valid/invalid behaviour from the
**second** one across repeated, concurrent, never-entered and stale-worktree installs. Full design in
[Linting](docs/standards/linting/index.md#hook-installation-across-worktrees).

**#4 is complete.** This ports kteam's `src/git.ts` `gitChanges` behaviour into Ferretry's shared
Git runner: `packages/daemon/src/adapters/git/runner.ts` pins
`status.showUntrackedFiles=all`, so every daemon filesystem status read includes individual
untracked files even when local or global Git configuration says `no`. Its regression coverage is
`packages/daemon/tests/integration/session/filesystem/runner-session-git.test.ts`. The worktree
status reader independently passes `--untracked-files=all` in
`packages/daemon/src/adapters/worktrees/git-gateway.ts`, and the daemon-scoped PWA changes request
in `packages/pwa/src/components/files-api.ts` uses the shared `browserFetch` transport without
filtering `??` rows; `packages/pwa/tests/unit/files-api.test.ts` keeps that final path covered.
**#5 is PARTIAL and stays open. The half that is done is not the half the row names.** The
aggregate route is fixed and measured; the PWA Tasks pane this row is about has a different, still
unfixed problem. Read the next three paragraphs as "backend done, pane outstanding" and do not tick
this row on the strength of the benchmark below.

**Done: the aggregate fleet walk.** `37af20d4`
(`fix(tasks): parallelize fleet board reads (#282)`) replaced one awaited
`board(sessionId).list()` per session in `GET /v1/tasks` with a bounded fan-out ported from kteam's
`FLEET_READ_CONCURRENCY` / `mapPooled` pair. That route is the capability behind `fy task list` when
no session is named — a CLI surface. Each board is a single snapshot file
(`packages/daemon/src/adapters/tasks/file-task-store.ts`), so N sessions really was N serialised
file reads and nothing below the route can batch further.

**Outstanding: the Tasks pane itself, which was never the beneficiary.** The PWA's current-session
search calls `/v1/sessions/:sessionId/tasks` — a single board, no fleet walk — and then issues **one
further `GET /v1/sessions/:sessionId/tasks/:taskId` per task**, all at once through an unbounded
`Promise.all` (`readTasks` in `packages/pwa/src/features/session-search/session-search.tsx`). A board
of N tasks therefore costs an **unbounded N + 1 HTTP-request fan-out**, and because the daemon's
detail handler re-reads the whole board before answering one task, roughly **2N + 1 reads of the
same snapshot file**. That repeated per-task board-read cost is untouched by anything here. Closing
#5 means collapsing that N+1 — the list response already carries every summary field the pane
renders — and then recording a pane-level before/after. Neither is done, so there is deliberately
**no row-level timing claimed** yet. That later pane integration and its measurement belong to #6's
current-session search work; this branch deliberately does not touch them.

**The done half has a reproducible measurement, not an unsupported number.** It measures the
aggregate route only; it says nothing about the pane. `scripts/local/bench-fleet-task-reads.ts` runs both
access patterns against the same fixture in one interpreter — the pre-`37af20d4` sequential loop,
reimplemented because the change deleted it, and the shipped route through the real
`ApiRouter`/`ApiDispatcher`. Probe: 96 sessions, one `FakeTaskBoard` each
(`packages/daemon/tests/unit/runtime/mounts/support.ts`), 12 ms injected per board read, 3 samples
per arm, fixture rebuilt between samples, unit wall-clock milliseconds by `performance.now()`,
median reported. It is offline and touches no state home; `bun scripts/local/bench-fleet-task-reads.ts`
reproduces it and `--boards/--latency/--samples` vary it. A malformed, zero or fractional
`--boards`/`--samples` exits 2 rather than reporting a `NaN` median, and the closing line says
FASTER or SLOWER according to what was actually measured. Each run prints the commit it measured and
says so when the tree is dirty. A one-board or zero-latency probe is explicitly **INCONCLUSIVE**:
there are no overlapping reads whose effect could be separated from timer and scheduling noise. The
warmed, alternating-pair evidence recorded for this branch used 96 boards, 12 ms injected latency and
3 samples: **1,253.9 ms** before against **28.9 ms** after, a **43.4×** reduction. Fresh runs remain
the source of current-tree evidence because wall-clock timings vary; the ratio is a floor because only
the AFTER arm pays routing, authorization and serialization.

**The bound now has one owner, and its unit is a SESSION.** `readTaskBoardFleet`
(`packages/daemon/src/lib/task-boards/fleet-read.ts`) is the only way the board domain walks every
session, and the limit is private to it. It closed a second, contradicting answer next door:
`StorageTaskBoardSessionDirectory.snapshot()` was starting every session in the daemon at once, so
its cost grew with the fleet while the route beside it stayed under a fixed limit. Quote the bound
carefully: it caps **64 session callbacks**, not 64 documents. The aggregate route reads one document
per callback (64 open documents); the session directory reads two, started together (**128** open
documents). Both tests measure their own number rather than repeating this sentence. Ordering is the
session index's, not completion order; the first failure stops the walk claiming further sessions and
is raised only once every started read has settled, so a route that has answered 503 is not still
reading; and a damaged board still makes the whole aggregate unavailable rather than looking like an
empty or shortened fleet.

## Audit of former open rows — 2026-08-09

This is a content audit of `origin/main` at `35591786`, not a PR-title or branch-containment audit.
Every path below was read with `git show origin/main:<path>`. `LANDED` rows are ticked above;
`PARTIAL` rows remain open with the missing beneficiary or behaviour stated exactly; `OPEN` means the
row's capability has not shipped.

|  ID | Status  | Content proof or precise remaining gap                                                                                                                                                                                                                                                               |
| --: | :------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|  47 | PARTIAL | `packages/daemon/src/lib/warden/config.ts` and `packages/pwa/src/features/warden/warden-config-card.tsx` configure escalation accounts and account failover only. They do not configure nudge/kill/migration permissions, allowed targets, or explicit board-invitation authority.                   |
|  48 | OPEN    | `packages/daemon/src/lib/migrate/harness-compatibility.ts` still defines migration as same-harness. There is no durable cross-harness replacement, board invitation/acceptance, or old-root relinquish sequence.                                                                                     |
|  67 | OPEN    | There is no message-level fork route or transcript action. The existing migration path is not a non-destructive same- or cross-harness conversation fork.                                                                                                                                            |
|   7 | LANDED  | `packages/pwa/src/features/tasks/task-row.tsx` renders Mark done; `packages/daemon/tests/integration/runtime/task-done-authorization.test.ts` proves the daemon permission boundary.                                                                                                                 |
|   6 | LANDED  | `packages/pwa/src/features/session-search/session-search.tsx` searches task ID/title/description/ask/clarifications and file name/path, then mounts the same control in the app bar, Tasks, and Files.                                                                                               |
|  15 | LANDED  | `packages/pwa/src/shell/app-bar.tsx` owns the centered search and responsive destination groups, including its dismissible mobile destination dialog.                                                                                                                                                |
|  35 | LANDED  | `packages/pwa/src/shell/side-pane-tab-model.ts` and `side-pane-tabs.tsx` implement typed instance tabs; their source explicitly excludes Pins and Attention.                                                                                                                                         |
|  36 | PARTIAL | `packages/pwa/src/features/browser/remote-browser-chrome.tsx` provides working status, navigation, and controls, but they remain separate browser chrome rather than one compact HUD/top-bar control.                                                                                                |
|  37 | LANDED  | `packages/pwa/src/components/files-tab.tsx` has the persistent tree, shared search, one-file tabs, and visible refresh; `file-instance-surface.tsx` reloads the exact open file and its preview.                                                                                                     |
|  38 | LANDED  | `packages/pwa/src/shell/palette-destinations.ts` indexes real destinations and settings, while `app-bar.tsx` reserves session search and offers the mobile palette entry.                                                                                                                            |
|  41 | LANDED  | `packages/pwa/src/components/web-terminals.css` and the browser surface use the explicit expanded/full-viewport state rather than leaving the live view pane-bound.                                                                                                                                  |
|  45 | LANDED  | `packages/pwa/src/features/lineage/lineage-surface.tsx` renders the consistently named Lineage tree; the app-bar source owns the replacement navigation.                                                                                                                                             |
|  63 | PARTIAL | `packages/pwa/src/features/pins/pins-trigger.tsx` provides only a compact Pins header trigger. `composer-autocomplete-providers.ts` still exposes the `@@@@@` Pins tier; target mini-tabs and their target rendering are absent.                                                                     |
|  69 | PARTIAL | `packages/daemon/src/adapters/catalog/file-project-catalog.ts` and `packages/pwa/src/features/projects/projects-page.tsx` ship a durable registry plus a basic list/add/clone foundation. Project detail, discovered-project confirmation, Git metadata, and launch/fork workflows are still absent. |
|  68 | PARTIAL | `packages/daemon/src/adapters/worktrees/service.ts` and `packages/cli/src/lib/worktrees/` provide managed creation, inspection, and guarded removal. The first-class Project UI, complete live Git/PR/CI metadata, picker/fork flows, and recoverable removal workflow are not shipped.              |
|  20 | LANDED  | The rendered answer flow is covered by `packages/pwa/tests/unit/features/attention-board.test.tsx`; the daemon driver is covered by `packages/daemon/tests/integration/session/question/tmux-structured-question-driver.test.ts`.                                                                    |
|  28 | LANDED  | `packages/daemon/src/lib/analytics/model-identity.ts` normalizes selector variants and aliases, and `pricing.ts` uses that identity rather than conflating selected and transcript pricing models.                                                                                                   |
|  32 | LANDED  | The shipped transcript renderer and density rules are in `packages/pwa/src/components/session-screens.css` and `session-chat-model.ts`; they retain the normal transcript/tool-run behaviour.                                                                                                        |
|  33 | PARTIAL | `composer-autocomplete-providers.ts` has the existing repeated-`@` ladder and `/`/`$` skills, but it still contains the fifth Pins tier and there are no three persistent trigger-setting groups or the complete direct-trigger matrix.                                                              |
|  39 | PARTIAL | `packages/pwa/src/components/composer.tsx` is the real textarea and `composer-highlight.tsx` supplies the Markdown overlay, but there is no optional Vim mode or rendered Markdown preview.                                                                                                          |
|  43 | LANDED  | `packages/pwa/src/lib/pages/session-chat-page.tsx` wires aggregate-board and Skills reference actions into the existing session workspace; it does not create a separate board page.                                                                                                                 |
|  49 | LANDED  | `packages/pwa/src/components/composer-runtime.tsx` exposes separate model and reasoning controls and shows only observed/confirmed runtime values for Claude and Codex.                                                                                                                              |
|  65 | LANDED  | `packages/pwa/src/components/fy-render-block.tsx` and `lib/fy-render.ts` parse the bounded conversation-only block and provide consent, source, reload, fullscreen, and safe fallback handling.                                                                                                      |
|   8 | LANDED  | `packages/pwa/src/features/attention/attention-board.tsx` renders only unresolved items in the active list and keeps resolved items in a separate audit; the CLI controller reports the resulting unresolved count.                                                                                  |
|  10 | LANDED  | `attention-board.tsx` visibly maps permission, multiple-choice, answer-review, and open-question asks to their respective direct controls.                                                                                                                                                           |
|  12 | PARTIAL | Push enrolment, preferences, and browser delivery exist, but `packages/daemon/src/lib/push/service.ts` states that production raises no notification yet. Agent-callable, auditable delivery and automatic Attention delivery are still missing.                                                     |
|  14 | PARTIAL | `packages/daemon/src/lib/warden/attention.ts` has a read-only attention projection and `mounts/warden.ts` exposes configuration, but it does not implement the required policy-governed remediation, node-scoped deduplication, and recovery resolution.                                             |
|  17 | LANDED  | `packages/pwa/src/features/attention/attention-action-modal.tsx` is the focused phone-first modal the live session workspace opens; `attention-board.tsx` is now the pure ledger behind it rather than the action surface.                                                                           |
|  40 | LANDED  | `packages/pwa/src/features/attention/attention-answer-controls.tsx` maps a swipe to each finite labelled answer on compact screens and keeps every one of them tappable; open questions stay textual. Covered by `packages/pwa/tests/unit/features/attention-answer-controls.test.tsx`.              |
|  42 | LANDED  | `packages/pwa/src/features/analytics/global-analytics-page.tsx` declares reusable daily, weekly, by-model, average, maximum, and status starter queries for the global and session analytics surfaces.                                                                                               |
|  66 | PARTIAL | `packages/daemon/src/lib/analytics/pricing.ts` can price or honestly mark usage unpriced, but there is no Settings/API rate catalogue, provider sync/preview, manual overrides, or historical effective-rate snapshot surface.                                                                       |
|   9 | LANDED  | `packages/pwa/src/components/attachment-unlock-prompt.tsx` states and enforces password clearing; the daemon attachment flow hands the in-memory decrypted document to the agent without writing a decrypted file.                                                                                   |
|  62 | LANDED  | `packages/pwa/src/components/rich-file-preview.tsx` handles sandboxed HTML, PDF, raster, safe SVG, bounded CSV, and raw/open/download fallback; its `revision` input refreshes preview bytes after Files reload.                                                                                     |
|  29 | LANDED  | The mobile selection fix is present in the shipped composer interaction path; its regression coverage is `packages/pwa/tests/unit/composer-mobile-enter-action.test.tsx`.                                                                                                                            |
|   5 | PARTIAL | The aggregate CLI route has a bounded, measured fleet read. The PWA Tasks pane still performs one task-detail request per task after its list request, so its repeated-read cost and pane-level before/after measurement remain open.                                                                |

The person-noticeable remaining queue is: #69/#68 Projects and worktree workflows; #36 compact browser HUD;
#63 Pins strip; #39 and #33 composer editing/autocomplete completion; #12 notification delivery;
#5 Tasks-pane load time; #47/#14 recovery policy and warden escalation; #48 and #67 cross-harness
continuity; and #66 pricing configuration. The first five are direct day-to-day PWA gaps; the others
are important safety, continuity, and operator gaps. #17 and #40 left this queue when the focused
mobile Attention modal and its swipe controls landed.
