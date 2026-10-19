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

**Info › Runtime › Settings** says whether a restart would change anything: "Running with older settings —
Restart to apply", with the reason, and a one-tap Restart. It compares two things
(`GET /v1/sessions/:id/relaunch-settings`):

- **arguments** — the daemon-owned launch arguments a relaunch would build now differ from the ones the
  process runs with (a `Read(...)` rule it predates, the remote-control surface, the owner's flags);
- **settings** — a digest of the login's wrapper and fixed settings file differs from the one recorded when
  the process was launched (a permission-mode, profile or fixed-layer change since).

## Only new ferrets

| Setting                                                                                                                 | Decided                                |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| The default runtime for new agents                                                                                      | when a start names no runtime          |
| The machine's passive-learning default                                                                                  | at start ([learning.md](learning.md))  |
| What the start asked for: mode, board access, remote control, the owner's harness flags, name, parent, folder, timeouts | at start, then kept for every relaunch |

## How a launch is built

One builder (`buildLaunchArgv`, `packages/daemon/src/lib/session/launch/`) makes every launch argv, in this
order: the login's wrapper; the remote-control arguments if the ferret has that surface; the arguments that
name its conversation (`--session-id`, turned into `--resume` once the CLI has written it); the `Read(...)`
rules for its hand-off folders; `--model` and the effort; the owner's harness flags last, so an explicit
flag still wins.

A start builds it from the request. A revive and a restart build it from the ferret's own documents and the
fleet **as it is now** — never by replaying the argv the start recorded — and record what they built and
the settings digest they launched under, which is what the Settings row compares against.

Fast mode is built the same way, and only when it was ever decided: a ferret launched with `fast` (or switched
since) has its state named on the argv — Codex `-c service_tier=…`, Claude an inline `--settings` that carries the
login's fixed overlay with it — and one that never decided asserts nothing ([fast-mode.md](fast-mode.md)).

The model a relaunch asks for is the one the ferret is on: the CLI's own report when it is newer than the
daemon's last decision (start, migration, or the previous relaunch) and names a model the login serves;
otherwise the recorded decision. A model the login has stopped serving falls back to its default.

## Declared gaps

- A forked ferret's first launch records no settings digest, so its Settings row cannot report a fleet
  change until its first restart; its arguments are still compared.
- A ferret whose documents do not parse, or whose login the fleet no longer publishes, is relaunched from its
  recorded argv as before, and its Settings row claims nothing.
- The digest covers the wrapper and the fixed settings file. An MCP server, skill or instruction file
  changed inside the harness home or the project is not detected; restart the ferret to load it.
