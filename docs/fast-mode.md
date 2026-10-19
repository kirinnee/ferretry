# Fast mode

Both CLIs have a **fast mode**: faster output, billed differently, and only on some models. Ferretry
switches it per ferret — at launch and on a running one — with the CLI's own command, and says what the
CLI reported rather than what was asked for.

|                            | Claude Code (2.1.281)                         | Codex (0.156.1)                                           |
| -------------------------- | --------------------------------------------- | --------------------------------------------------------- |
| Which models               | the id contains `opus-4-8` or `opus-5`        | the account lists a `priority` service tier for the model |
| Launch on / off            | `--settings '{"fastMode":true\|false}'`       | `-c service_tier="priority"` / `"default"`                |
| Live                       | `/fast on`, `/fast off`                       | bare `/fast` — it **flips**; there is no argument         |
| What it prints             | `↯ Fast mode ON · …`, `Fast mode OFF`         | `Service tier set to priority` / `default`                |
| Evidence in the transcript | the printed answer (`<local-command-stdout>`) | `thread_settings_applied.thread_settings.service_tier`    |
| The CLI saves it           | `settings.json` `fastMode`                    | `config.toml` `service_tier`                              |

These were measured on the pinned releases against fake backends, not read from documentation; the
captures behind the unit fixtures are `tests/fixtures/transcript/claude-fast-mode.jsonl`,
`codex-fast-mode.jsonl` and `tests/fixtures/codex/model-list-service-tiers.json`.

## What a surface can do

- **Start**: `fast: true` launches fast, `fast: false` launches standard, omitted leaves the CLI's own
  setting in charge — which is **not** "off" (see below). `fy start --fast` / `--no-fast`; the New session
  form sends `fast: true` when its ⚡ switch is pressed and nothing otherwise.
- **Running**: `POST /v1/sessions/:id/runtime` with `{"action":"fast","fast":true|false}`, from the ⚡
  switch beside the model and reasoning chips. It needs an idle prompt, like every runtime control.
- **Restart keeps it.** A relaunch asserts the state the ferret is in — what the CLI last reported, else
  what it launched with — through the same launch builder as Restart CLI, a revive and a restart after
  `fy daemon restart` (docs/launch-settings.md). A ferret that never decided anything asserts nothing.

## Where each fact is owned

| Fact                                                          | Owner                                                                                                 |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Does this Codex model have a fast tier, and is it the default | the live account (`model/list` `serviceTiers` / `defaultServiceTier`), parsed into the catalog        |
| Does this Claude model have fast mode                         | `claudeFastSupport` (`lib/session/harness/fast-mode.ts`) — a mirror of the CLI's name rule, kept once |
| Is fast mode on now                                           | the CLI's report (`state.observedFast`), else `config.launchFast`, else the model's default           |
| What a launch asserts                                         | `buildLaunchArgv` (`fastLaunchArguments`)                                                             |

`observedFast` moves `observedModelAt`, the same freshness token a model switch uses, so a switch is
confirmed by any new report — including a re-report of the same value — and the chip reads "switching…" then
"unconfirmed" after 20 seconds exactly like the model chip.

## Why the launch carries the whole overlay (Claude)

Claude honours **one** `--settings`, the last. The fleet wrapper already passes the login's fixed overlay
(`<harness home>/.fy/fixed.json`: the permission mode and the prompts it skips), so naming fast mode
**replaces** it. The launch therefore reads that file, adds `fastMode`, and passes the whole object inline.
If the file exists but is not a JSON object the launch is refused: dropping it would start an unattended
agent without its permission mode. An owner's own `--settings` in `harnessFlags` still wins, being last.

## Things that are easy to get wrong

- **Codex `/fast on` is a message.** Typed at the prompt it is sent to the model and costs a turn. The only
  safe keystrokes are the bare `/fast`, sent only when the known state differs from the one asked for;
  when the state is not known the switch is refused instead of guessed.
- **Claude's bare `/fast`, or `/fast` with any other word, opens a picker** and waits for a person. Only
  `/fast on` and `/fast off` are ever typed.
- **`/fast on` on a model with no fast mode changes the model** (Claude switches it to Opus). A switch is
  refused before a key is pressed when the model has none.
- **The CLI saves what it is switched to.** A live `/fast` rewrites the login's settings file, so a ferret
  started later on that login **without** naming fast mode starts the way the last switch left it. That is
  why the composer reads the saved value at launch (`launchFast`), and why a surface that wants a known
  state should name it.
- **Both launch forms are explicit in both directions.** `fast: false` is asserted, not omitted, so a login
  that saved fast mode earlier does not make a ferret that asked for standard speed run fast.

## Declared gaps

- A Codex ferret that has taken no turn, whose login saved a service tier the model's default disagrees
  with, is assumed to be on the model's default until the CLI reports. A flip refused as "not known yet" is
  the safe answer when even that is unavailable.
- Moving a ferret to another login drops its launch state: the target is another login, often another
  harness, and its model may have no fast mode.
- A forked ferret starts on its login's own fast setting; the fork binder builds its own launch.
- Codex's **Ultrafast** tier (`ultrafast`, on some models) is a different service tier that `/fast` does
  not select and Ferretry does not switch. A ferret on it reports neither fast nor standard.
- Claude's gate is the name rule above. A catalog entry's own `fast_mode` flag, which the CLI honours first
  when its server sends one, is not visible to the daemon; a wrong guess is answered by the CLI itself
  (`Fast mode unavailable: …`) and the switch stays unconfirmed.
- No `fy` command switches model or effort on a running ferret today, so there is no fast flag to add
  there; the running switch is the `runtime` route above.
