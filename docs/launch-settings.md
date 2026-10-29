# When a setting reaches a running ferret

A ferret is a CLI process — Claude Code or Codex — and a process keeps what it read when it started. So
every setting reaches a ferret at one of three moments: **live** (the next thing the ferret does already
uses it), **on restart** (its CLI has to be relaunched), or **only for new ferrets** (it is decided once,
when a ferret is created).

## Live

| Setting                                                           | Why it is live                                                                           |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Model and effort switched from Info › Change, `/model`, `/effort` | sent to the running CLI; the daemon records what the CLI then reports                    |
| Fast mode, from the ⚡ switch or `/fast`                          | sent to the running CLI and confirmed by what it reports ([fast-mode.md](fast-mode.md))  |
| What other devices may do (grants, operator password)             | the daemon decides every request with the document as it is now ([grants.md](grants.md)) |
| What agents may control (terminals, browsers, files, …)           | the daemon asks the policy on every agent call ([agent-tools.md](agent-tools.md))        |
| Passive learning, per ferret (Actions)                            | re-instructs the running ferret with a queued message ([learning.md](learning.md))       |
| Warden, speed-up keys, secrets in the secret store                | the daemon reads them when it uses them, never the CLI                                   |

## On restart

Everything the CLI itself reads at launch. **Restart CLI** (Actions, or Info › Runtime's Settings row), a
revive of a stopped ferret, the relaunch of a pane that died with `fy daemon restart`, and a migration onto
another login all apply them, because all four build the launch the same way:

| Setting                                                           | Where it lives                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| The login's agent permission mode                                 | the generated wrapper (`--permission-mode`)                        |
| The login's profile: its environment and credential               | the generated wrapper, and the credential resolved again at launch |
| The fixed layer: Ferretry tools, its instructions, fixed settings | the generated wrapper and `<harness home>/.fy/fixed.json`          |
| MCP servers, skills and instruction files the CLI loads           | the harness home and the project, read by the CLI when it starts   |
| The arguments Ferretry launches with                              | built by the daemon at every launch (below)                        |
| Resource limits                                                   | the saved resource-limit document, read at launch                  |

A restart **keeps the conversation, the model, the effort and fast mode** the ferret is on — including a model the
owner switched to with `/model` — unless the person restarting it picks another.

### The conversation

Restart CLI, and a move onto another login of the **same harness**, relaunch the CLI into the conversation the
ferret is bound to — as if only the process had restarted:

- Claude relaunches with `--resume <the same id>`; Codex with `resume <the same thread>`.
- Moving to another login copies the transcript into that login's harness home first, at the path its CLI
  resumes from (`projects/<folder>/<id>.jsonl` for Claude, the same `sessions/…` path for Codex). It is a copy,
  never a link, so the login left behind keeps only what it had.
- When the conversation **cannot** go with it — nothing records one, Codex has not yet proved which rollout
  is this ferret's, or the target login declares no harness home — the daemon refuses with
  `409 conversation_unresumable` and changes nothing. It never quietly starts a new conversation.
  **Start fresh** (`conversation: "fresh"`, `fy migrate … --conversation fresh`) is the person's explicit way
  past.
- **Go back to the earlier conversation** (Actions, or `--conversation previous`) repairs a ferret an earlier
  Restart moved onto a new, empty conversation: it rebinds to the newest other transcript in the same
  harness home that names the ferret's own directory — every turn Ferretry hands an agent does — and
  resumes that one.

Moving between harnesses is not a restart: a plain move stays refused (`harness_mismatch`). It is done by
**converting** the conversation (Move to Codex…/Move to Claude…, `--convert`) — see
[migration-cross-harness.md](migration-cross-harness.md).

**Info › Runtime › Settings** says whether a restart would change anything: "Running with older settings —
Restart to apply", with the reason, and a one-tap Restart. It compares two things
(`GET /v1/sessions/:id/relaunch-settings`):

- **arguments** — the daemon-owned launch arguments a relaunch would build now differ from the ones the
  process runs with (a `Read(...)` rule it predates, the remote-control surface, the owner's flags);
- **settings** — a digest of the login's wrapper and fixed settings file differs from the one recorded when
  the process was launched (a permission-mode, profile or fixed-layer change since).

**Info › Runtime › Instructions** says what the running process was told: which Ferretry sections of its
appended system prompt it carries (the tools, the settings rules, the Attention rule, and each of Hypermedia, Pack mode and
Learning whose switch was on) with each one's size, its mode, and whether it may ask the owner a question.
It reads `state.launchInstructions` (`SessionLaunchInstructionsSchema`), which the daemon records from the
environment each pane is launched with — at every start, restart and revive — so a switch flipped since
shows in its own row and here only after the next launch. It holds section names and sizes, never the
prompt text. A ferret last launched before the field existed has none, and the row says "Recorded from the
next launch".

### Instructions that changed since the launch

A harness reads its appended system prompt once, at launch, and neither Claude Code nor Codex can re-read
it mid-conversation. So a rule Ferretry tightens would otherwise reach a long-running ferret only when it
restarted. The three sections every agent gets (the tools, the settings rules and the Attention rule,
`ALWAYS_ON_SECTIONS` in `@ferretry/fleet`) depend on nothing but the binary's name. Each launch now records
a fingerprint of each one (`digest`, `instructionDigest`) beside its size.

When the owner next writes to a ferret, the daemon compares those fingerprints with the words every agent
is told now (`packages/daemon/src/lib/session/launch/instruction-refresh.ts`). For each section that
changed, it queues the new words once, under `[instructions updated]`, as a replacement for the matching
part of the system prompt. Once the note is durably queued, the launch record marks those sections as told,
so the next message queues nothing. The Instructions row then shows the new sizes.

- **The owner's message triggers it and goes out exactly as typed.** The note is its own message in the
  ferret's attention outbox, under the key `instructions~<digest>` (a key made from the note's words, so
  the same note is never queued twice). It rides the same quiet window and the same hold while the ferret
  is mid-turn as the owner's answers ([attention.md](attention.md)), and joins a batch of them as one
  message. Only an owner's message triggers it: a release must not start a turn for every ferret on the
  machine, and a teammate's message never does. If the note cannot be queued it is not marked as told, so
  the next owner message offers it again.
- **A record with no fingerprint** (launched before they were kept) compares sizes. A session with no
  record at all is told nothing, because nothing says what it has.
- **The per-ferret sections** (Hypermedia, Pack mode, Learning) still change only at a restart. They depend
  on switches and on the routing prompt. The Settings row's "Running with older settings — Restart to apply"
  still covers every change, because the wrapper that carries all the sections is part of its digest.

## Only new ferrets

| Setting                                                                                                                 | Decided                                |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| The default runtime for new agents                                                                                      | when a start names no runtime          |
| The machine's passive-learning default                                                                                  | at start ([learning.md](learning.md))  |
| What the start asked for: mode, board access, remote control, the owner's harness flags, name, parent, folder, timeouts | at start, then kept for every relaunch |

## How a launch is built

One builder (`buildLaunchArgv`, `packages/daemon/src/lib/session/launch/`) makes every launch argv, in this
order: the login's wrapper; the remote-control arguments if the ferret has that surface; the arguments that
name its conversation (Claude `--session-id`, turned into `--resume` once the CLI has written it; Codex
`resume <thread>` once its rollout is known); the `Read(...)`
rules for its hand-off folders; `--model` and the effort; the owner's harness flags last, so an explicit
flag still wins.

A start builds it from the request. A revive and a restart build it from the ferret's own documents and the
fleet **as it is now** — never by replaying the argv the start recorded — and record what they built and
the settings digest they launched under, which is what the Settings row compares against.

Fast mode is built the same way, and only when it was ever decided: a ferret launched with `fast` (or switched
since) has its state named on the argv — Codex `-c service_tier=…`, Claude an inline `--settings` that carries the
login's fixed overlay with it — and one that never decided asserts nothing ([fast-mode.md](fast-mode.md)).

## Remote Control is off unless asked for

Claude Code publishes a session to claude.ai/code and the Claude app (Remote Control) when
`remoteControlAtStartup` is true. It reads that from, in order, org policy, the `--settings` file, the
config dir's `settings.json`, the legacy global config, and finally the account's own default. A runtime
imported from an owner who turned it on, or an account with the default on, therefore started every ferret
with it on. Ferretry's **fixed layer** now writes `remoteControlAtStartup: false` into the overlay it passes
as `--settings` (and fast mode's replacement overlay carries it), which outranks everything but org policy.

The one thing that turns it on is the ferret's own `remoteControl` field, set by **New session › Advanced
options › Start with Remote Control on** (or `fy start --rc`): that adds `--chrome --rc …` to the argv. Info ›
Runtime › Remote control shows which it is. A change takes effect at the next launch, and the fixed layer's
change shows up as "Running with older settings" on ferrets launched before it. Codex has no Remote Control to
switch, so its form box is disabled and its Info row says so.

Declared gap: an org-policy lock on Remote Control outranks the overlay, and `--rc` is ignored by Claude Code
for a login whose organisation it cannot determine; the contract test therefore pins the off switch against
the user-settings control and the `--rc` argv in the unit tests.

The model a relaunch asks for is the one the ferret is on: the CLI's own report when it is newer than the
daemon's last decision (start, migration, or the previous relaunch) and names a model the login serves;
otherwise the recorded decision. A model the login has stopped serving falls back to its default.

## Declared gaps

- A forked ferret's first launch records no settings digest, so its Settings row cannot report a fleet
  change until its first restart; its arguments are still compared.
- A ferret whose documents do not parse, or whose login the fleet no longer publishes, is relaunched from its
  recorded argv as before, and its Settings row claims nothing.
- Going back to the earlier conversation searches only the harness home the ferret is bound to now. A ferret
  that a broken Restart also moved to another login has its earlier conversation in the old login's home;
  move it back first, then go back.
- Only the transcript file is carried between logins. Claude's per-conversation side folders (file history,
  todos) stay in the home that wrote them.
- The digest covers the wrapper and the fixed settings file. An MCP server, skill or instruction file
  changed inside the harness home or the project is not detected; restart the ferret to load it.
