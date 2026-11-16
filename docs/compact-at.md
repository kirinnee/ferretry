# Compact memory at

A ferret re-reads its whole conversation on every step. The longer it is, the more every step costs, so a
long-running lead that is allowed to grow to the model's full window pays for a very large context on almost
every call. **Compact memory at** moves the point where the harness squeezes ("compacts") its own conversation:
smaller means cheaper steps, and the ferret keeps less detail between squeezes.

The value is `auto` (the harness's own trigger — the default, no change in behaviour) or a number of tokens.

## Where it is set

| Where                                  | How                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| One ferret, at start                   | `fy start --compact-at 250k …`, `fy new --compact-at 250k …`, or `compactAt` on `POST /v1/ferrets`     |
| One ferret, later                      | `fy session compact-at <session> 250k` (`auto` for the harness's own, `inherit` to drop it)            |
| One ferret, in the app                 | Actions › **Compact memory at**: Auto, 200k, 250k, 400k or a custom size                               |
| Every ferret on a runtime or a profile | `compactAt:` in `runtimes/<name>.yaml` or `profiles/<name>.yaml` ([config-files.md](config-files.md))  |
| Read it                                | `fy status <session>` (the ferret's own value), `fy session compact-at <session>` (the value in force) |

A size is `250k`, `1m`, `250000` or `auto`. The runtime's value wins over its profile's, and the ferret's own
value wins over both. A ferret with no value of its own follows the default; an explicit `auto` on the ferret
overrides a login default, and `inherit` drops the ferret's own value so the default applies again.

## What is checked

- At least **100,000 tokens** — the smallest value Claude Code accepts for its own `/autocompact`. A smaller
  trigger would compact over and over without leaving room for work.
- At most the **model's context window**, when the daemon can tell it. A larger value could never trigger.

The value that would be **in force** is checked, not only one a person typed. A login default larger than a
ferret's model window is not used: the launch falls back to Auto rather than refuse to start, and the ferret's
compact-at answer says so. A request that would leave a ferret on such a value — a number above the window, or
`inherit` onto a default the model cannot honour — is refused. A **start**'s own number above its model's window is refused the same way, before anything is written
(`fy start --compact-at 500k` on a 128k model); only a login default, or a value on a later relaunch after the model changed,
falls back to Auto. `--compact-at` takes `auto`, or a count such as `250k`, `1m`, `0.4m` or `250000` (v4's grammar); one
it cannot read is refused before anything is sent.

A refused value says which rule it broke and what is allowed. The config check (`fy config check`) applies the
floor to YAML; the window is checked when a ferret is started or changed, because it depends on the model.

## When it takes effect

It is a **launch setting** ([launch-settings.md](launch-settings.md)): it reaches a ferret when its CLI is next
launched — **Restart CLI**, a revive, a restart after `fy daemon restart` or a migration all build it again from
the ferret's saved config. A change on a running ferret says so ("takes effect when the ferret restarts"), and keeps saying so — on a read
and on a repeat of the same change — for as long as the process still runs on the value it launched with (read
from the launch arguments the daemon recorded). That value is the one the process actually uses, so the
last word wins: an owner's own `harnessFlags` come last, and a later Codex `-c` pair or a later Claude
`--settings` replaces the one the daemon wrote. A
ferret that is not running takes it at its next launch.

It is **not** sent to a running harness. Claude Code's `/autocompact` would do that, but it writes the login's
_shared_ settings file, so one ferret's choice would change every other ferret on that login. A value given at
launch overrides that file anyway.

| Harness             | How the launch carries it                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code 2.1.281 | `autoCompactWindow` in the one `--settings` overlay the launch builds (shared with fast mode; Claude honours only one `--settings`) |
| Codex 0.166.0       | `-c model_auto_compact_token_limit=<tokens>`                                                                                        |

`auto` passes nothing, so the harness's own trigger and the login's own environment stay in charge.

### An environment variable beats it

Claude Code reads `CLAUDE_CODE_AUTO_COMPACT_WINDOW` from the environment before its settings. A login that sets
it — the Kimi provider preset does, to `1000000` — overrides `compactAt`. Remove the variable from that login's
`env` to let `compactAt` through.

## What does not change

`auto` is the default, so nothing changes until someone sets a value. The value is not a quota or a limit: the
harness still compacts on its own at its usual trigger if the conversation reaches it first.
