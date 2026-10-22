# Pack mode

A ferret can hand self-contained parts of its work to **sub-ferrets** — other ferrets, each running on the
model that suits its part: the strongest model for a plan or a review, a fast cheap one for a mechanical
sweep, another family for a second opinion. **Pack mode** is the switch that tells a ferret it may, how to
pick the model, and the limits it is held to.

This page is the contract. The wire shapes are `packages/protocol/src/lib/pack.ts`; the daemon's logic is
`packages/daemon/src/lib/pack/`; the instruction text is `PACK_INSTRUCTION` in
`packages/fleet/src/lib/account/fixed-layer.ts`.

## The switches

| Switch          | Where                                                               | Default |
| --------------- | ------------------------------------------------------------------- | ------- |
| The machine's   | `pack.yaml` `enabled`; Settings › Pack mode                         | on      |
| One ferret's    | `config.pack` on its session document (absent = on); `PATCH …/pack` | on      |
| What it is told | `FY_PACK=1` or `0` in its launch environment, written at its start  | —       |

A ferret whose environment holds no `FY_PACK` — one started before Pack mode existed, or whose start could
not write it — is given what its record says at every launch (the same rule, from `config.pack`, the
machine's switch and its depth) rather than nothing; a stored value still wins.

- A new ferret gets `FY_PACK=1` when the machine's switch is on **and** it sits shallow enough to start a
  sub-ferret of its own. A ferret at the deepest level is never told about a door it cannot open. A
  learning miner or a warden is never told; an adopted conversation (`fy new --continue`, Import) is a
  top-level ferret and is.
- `PATCH /v1/sessions/:sessionId/pack {enabled}` (`operator`) switches one ferret. Like Hypermedia, a running
  ferret is not re-instructed — the change is in its system prompt from its next launch, and the answer's
  `note` says so — but switching it **off** makes `fy new` refuse it `pack_off` at once.
- Switching the machine off makes every `fy new` refuse `pack_off` at once; ferrets already running keep
  their instruction until their next launch. The sub-ferret **limits** hold either way.

## What a ferret is told

Pack mode is a section of the **appended system prompt** (Claude `--append-system-prompt`, Codex
`developer_instructions`), never the tools server's MCP instructions: a harness weighs the system prompt
far above a server's text. The runtime wrapper composes it per ferret at exec time
([hypermedia.md](hypermedia.md#delivered-as-system-instructions-per-ferret)). Exactly this, for a binary
called `fy`:

```text
Pack mode: you may hand self-contained parts of your task to sub-ferrets — other agents, each on the model that suits its part. Prefer them over your built-in subagents for real work; do small things yourself.
1. `fy recommend "<part>"` lists the models usable now, best first, with the command to start each.
2. `fy new --runtime <runtime> --model <model> [--effort <level>] --name "<short task title>" "<complete brief>"` starts one (`fy new --auto "<brief>"` lets Ferretry choose). Always pass `--name` (2–5 Title Case words). The brief is all it knows: say what to do, where, and what to report.
3. If it refuses (out_of_quota, not_logged_in, cli_missing, probe_failed, …), read the reason and start the next candidate. limit_reached or depth_exceeded: do the work yourself.
4. `fy wait <id>` blocks until it finishes and prints its result. Check it, then combine the results yourself.
Stop sub-ferrets you no longer need (`fy stop children <your id> --yes`).
```

When the models guide is in effect (always — its own, or one built from the catalogs), the Pack section ends
with its **routing line** on a line of its own, e.g. `Routing: plan-review → claude-opus-5-5 max; everyday →
claude-sonnet-5-5.` — the guide's `routing.short` ([The models guide](#the-models-guide)). The daemon puts it in
`FY_PACK_ROUTING` at **every launch** and never stores it, so a restart hears the guide saved now; the wrapper
appends it only when `FY_PACK=1`, and deletes any quote, backslash or control character first, so a value
nobody checked cannot break either harness's quoting. The whole guidance is in `fy recommend` and
`fy guide show`, read live.

Built-in subagents are **discouraged, not blocked**: nothing is taken away from the harness.

**Size.** Every Ferretry instruction together is about 4.4 KB (≈ 1,100 tokens) with every section on:

| Section                                  | Characters | ≈ tokens | When                        |
| ---------------------------------------- | ---------- | -------- | --------------------------- |
| Tools (terminals, browser pages)         | 1,001      | 250      | every agent runtime         |
| Ferretry settings (short "Set up" skill) | 478        | 120      | every agent runtime         |
| Hypermedia                               | 1,597      | 399      | `FY_HYPERMEDIA=1`           |
| Pack mode                                | 963        | 241      | `FY_PACK=1`                 |
| Its routing line                         | ≤ 151      | ≤ 38     | `FY_PACK=1`, a guide        |
| Lessons                                  | 413        | 104      | `FY_LEARNING_PASSIVE=1`     |
| The tools server's MCP instructions      | 112        | 28       | always — one line, no rules |

The full "Set up Ferretry" skill (4.2 KB) is no longer in any prompt; the settings section points at
`fy config guide`, which prints it. A test keeps the whole prompt, with the longest routing line, under 4.5 KB. The tools section grew from 620 characters when it began
telling agents to hand the owner a terminal or page for every step only they can do
([agent-tools.md](agent-tools.md#handing-a-surface-to-the-owner)).

## The models guide

`config/models-guide.yaml` maps **use cases** to the models that suit each, best first. It is a
configuration file like any other ([config-files.md](config-files.md)): human-edited, checked, last good
wins, live in every open app, and edited in Settings › Pack mode.

```yaml
# yaml-language-server: $schema=.schema/modelsGuide.json
useCases:
  - id: plan-review
    title: Hard planning, review and critical code
    description: Designing an approach and reviewing a change. claude-opus-5-5 first, gpt-6-astra for a second family.
    keywords: [plan, design, review, security]
    candidates:
      - provider: anthropic
        model: claude-opus-5-5
        effort: max
        why: The strongest planner and reviewer.
      - provider: openai
        model: gpt-6-astra
        harness: codex
        effort: high
        why: A different family, for a plan Claude wrote.
```

- `provider` is a **model catalog** id (`anthropic`, `openai`, `zai`, `deepseek`, `kimi`, …,
  [model-catalog.md](model-catalog.md)) and `model` an id that catalog lists, so a candidate may be any model
  anywhere in the fleet. `harness` says which CLI when a catalog lists the model for both.
- **No `useCases` key: the derived guide.** A machine that never wrote a guide gets five use cases built from
  the catalogs in effect — _Hard planning, review and critical code_ (`best` tier, highest effort), _Everyday
  coding_ (`balanced`), _Mechanical bulk edits_ (`fast`, lowest effort), _Second opinion_ (`best`, another
  family), _Long-context reading_ (largest context) — so it moves with the catalogs without a release.
  Providers are ordered Anthropic, OpenAI, Z.ai, DeepSeek, Kimi, MiniMax, Qwen, Ollama, then the rest, and the
  same model resold by Bedrock, Vertex or a gateway is listed once.
- **A model the guide names that no runtime here offers is still listed**, flagged, never removed: a guide
  is portable between machines. A candidate is also served by a runtime whose catalog lists a model with the
  **same label** (Claude Opus 5.5 through Bedrock), so a guide written for `anthropic` works on a Bedrock login.
- **Routing guidance.** `routing: {prompt, short}` says in plain words how to pick a model and effort for a
  sub-ferret's job — "planning or review → …; mass chores → …; when X is low on quota → …". `prompt` (up to
  6,000 characters) is printed by `fy recommend` and `fy guide show` and given to **Jev** as its guidance;
  `short` (one line, up to 150 characters, no quote or backslash) rides in the Pack section of every ferret's
  system prompt. A guide with no `routing` gets one **rendered from its use cases** — each use case and its
  first three candidates — so it never says anything the guide does not. Hand-written, generated or derived,
  Pack mode reads whatever is saved.
- **Where it came from.** `suggested: {by, via, at, acceptedAt, partial?}` records the model that drafted an
  accepted guide; `fy recommend` then says so ("your guide, suggested by gpt-oss-120b on 2026-10-22 and
  accepted"). A hand-written guide has none.
- **Tolerant read, strict write.** An unknown model is a warning in the editor and a `model_unavailable`
  candidate, never a broken file; a file that does not match the schema keeps its last good version.
  The guide never loosens anything (it widens nothing a ferret may do or spend), so an edit is never held.

## `fy recommend "<task>"`

`POST /v1/pack/recommend {task, useCase?}` — `operator`, `fleet.use`. The use case is the one named
(`--use-case`), else the one whose keywords and title words the task uses most, else `everyday`. Each of its
candidates is resolved to a runtime on this machine and checked **now**, in the order a person would fix it:

| Check                               | Refusal code        |
| ----------------------------------- | ------------------- |
| An agent runtime                    | `not_agent`         |
| Its CLI is installed                | `cli_missing`       |
| A start can run its launcher        | `cli_missing`       |
| Every secret its login names is set | `not_logged_in`     |
| Its login is signed in              | `not_logged_in`     |
| Its quota is not used up            | `out_of_quota`      |
| It can launch at all                | `not_logged_in`     |
| It offers the model                 | `model_unavailable` |

Ready candidates come first, and `next` is the command that starts the first. The answer names the guide it
used and ends with the guide's routing prompt. `--json` prints the payload. `fy guide show [--json]` prints the
guide in effect: where it came from, its routing prompt and short line, and every use case.

### Quota

Quota changes hour by hour, so it is applied **at routing time**, from the fleet's own last reading of each
login (the windows the app shows as "5h 2% · wk 46%", `packages/daemon/src/lib/pack/quota.ts`), with no LLM
call and no extra request:

- Each candidate carries its login's **headroom**, banded by the tightest window measured: _plenty_ (half or
  more left), _some_ (a fifth to a half), _low_ (less than a fifth), _exhausted_ (refused `out_of_quota`).
  A login nothing measured is _unknown_ and is not held against a candidate.
- The ready candidates are **re-ranked** by band — plenty or unknown, then some, then low — the guide's order
  breaking every tie, and a candidate that ends below one the guide put after it says why
  (`moved down: claude-kirin, 91% of the week used, resets 18:00Z`).
- Of the runtimes that could serve one candidate, the one with the most headroom is chosen.
- A window whose **reset time has passed** since it was measured counts as fresh, so a login that ran out is
  offered again once its window resets, without anybody reading its usage again. (The older `fy fleet recommend` — a team recommender over a routing
  catalog an operator writes — is unchanged and separate.)

## `fy new`

`POST /v1/pack/new` — `operator`. `fy new` without `--continue` (with it, it still continues an existing
conversation). Inside a ferret's pane, `FY_SESSION_ID` names the asking ferret, which becomes the parent —
and when the agent's shell dropped it (a subshell, a sandbox), the CLI reads the pane's tmux session's own
copy (`tmux show-environment FY_SESSION_ID`), so the parent is recorded either way.

**Where it runs.** A sub-ferret runs in its **parent's folder** — the parent session's recorded working
folder, so it lands in the parent's project group — never where the agent's shell happens to be (often its
harness's scratch folder, `/tmp/claude-…`). Only `--cwd` moves it (made absolute against where `fy` ran; only a
caller at this machine may name one). A **named** temporary folder — an explicit `--cwd`, or a top-level start
from a person's shell — under `/tmp`, `/private/tmp`, `/var/tmp`, `/var/folders` or the daemon's `TMPDIR` is
refused `scratch_cwd` unless `--allow-scratch` says it is meant. A parent's own folder is never refused.

```text
fy new --runtime claude-auto-work --model claude-opus-5-5 --effort high --name "Fix Login Redirect" "<complete brief>"
fy new --auto --name "Fix Login Redirect" "<complete brief>"   # the decision mode picks
```

1. **Admission**: Pack mode on for the machine and the parent; the parent's limits (below).
2. **Order**: the named runtime — checked as `recommend` checks it — or, with `--auto`, the guide's ready
   candidates in the guide's order, or **Jev's** order when Jev decides.
3. **Probe — always, in both modes.** Each candidate in turn is asked to "Reply with exactly: OK" — a real round
   trip to the model, not a check that a CLI exists — through its
   own wrapper — resolved exactly as the start resolves it, the published absolute launcher in
   `$FY_HOME/fleet/bin` and never a name looked up on `PATH`, with the same login environment — in its CLI's one-shot mode (`claude -p` with the start's own `--model` and `--effort`, `codex exec` at `low`
   effort), bounded by
   `probe.timeoutSeconds` (45 s). A probe spends a token or two, and only when a ferret asked for a start —
   never on a timer. A **pass** is kept per runtime, model and effort for `probe.cacheSeconds` (180 s) and probes
   already running are shared, so twenty sub-ferrets started at once probe once; a failure is not kept, so the
   next start asks again. A failed probe refuses that candidate and the next is tried; nothing is launched for
   it. The CLI's own words say which failure it was — `out_of_quota`, `not_logged_in` or `model_unavailable` —
   and anything else is `probe_failed`; the words themselves are never repeated. The start line shows the
   check: `started claude-work (probe OK 640 ms)`, `(probe OK, cached)`, `refused … (probe failed 3436 ms)`.
4. **Start**: the same session start every surface uses (callsign, launch, audit), with `parent` recorded and
   the brief followed by a footer telling the sub-ferret to finish with `fy signal done "<result>"`. A
   harness that exits before it is ready fails the start with its exit status **and its last output lines**
   (`the interactive harness exited (2): its last output was "…"`), so the card says why — the wrapper's
   refusal naming a missing secret, or the harness rejecting an argument the one-shot probe does not pass.

The answer is never an HTTP error for a refusal: it is `{outcome: 'refused', refusal: {code, message,
remedy}, attempts}`, every attempt listed, so a ferret falls back on the code. `fy new` exits **2** on a
refusal (a failure of the command itself is 1).

| Code                                  | Means                                                                 |
| ------------------------------------- | --------------------------------------------------------------------- |
| `pack_off`                            | the machine's or this ferret's switch is off                          |
| `limit_reached` / `depth_exceeded`    | see Limits; do the work yourself                                      |
| `unknown_runtime` / `not_agent`       | no such runtime / one that cannot run sessions                        |
| `cli_missing` / `not_logged_in`       | the CLI or its launcher is missing / the login needs signing in       |
| `out_of_quota` / `model_unavailable`  | quota used up / the runtime does not offer the model                  |
| `probe_failed`                        | the "reply OK" check did not answer OK in time                        |
| `no_candidate`                        | nothing in the guide can run here now                                 |
| `scratch_cwd`                         | the named folder is temporary; leave `--cwd` out or `--allow-scratch` |
| `jev_unavailable` / `jev_cap_reached` | reserved; today both fall back to the guide's order, with a note      |

## Who decides

`pack.yaml` `decision`:

- **`agent`** (default) — the asking ferret picks, from `fy recommend`, and names `--runtime/--model/--effort`.
  `--auto` takes the guide's first ready candidate.
- **`jev`** — `fy new --auto` asks Jev (TypeSafe AI's System One model, the Warden's guard) to rank the ready
  candidates for the task, **guided by the models guide**: one cheap question per start, only when a ferret asks, within `jev.usdPerDay`
  (default $0.25 per UTC day, counted at the Warden's `guard.usdPerMillionInputTokens`, separate from the
  Warden's own cap). Jev sees the task text (bounded), the guide's routing prompt and the use case the task
  matched (bounded), and each candidate's model, runtime, reason and login quota — nothing else. With one ready candidate Jev is not asked. When Jev cannot answer (no key, a refusal, a
  timeout, an unreadable answer) or the cap is reached, the guide's order is used and the answer's `note`
  says why: a broken Jev never stops a sub-ferret starting. Switching to `jev` is a loosening, held for the
  owner's confirmation ([config-files.md](config-files.md)).

## Limits

Enforced by the daemon on **every** start that names a parent — `fy new` and a plain `fy start` inside a pane
alike — before anything is claimed or written. A warden's own spawns are the Warden's to bound.

| Limit                                           | `pack.yaml`                  | Default |
| ----------------------------------------------- | ---------------------------- | ------- |
| Running sub-ferrets of an interactive ferret    | `limits.interactiveChildren` | 20      |
| Running sub-ferrets of an unattended ferret     | `limits.autoChildren`        | 4       |
| Depth (a top-level ferret is 0; a sub-ferret 1) | `limits.maxDepth`            | 2       |

With depth 2 a sub-ferret may start its own and those may not. A child counts until it is completed,
failed, stalled or stopped. A plain `fy start` refused here answers `409 limit_reached` or
`409 depth_exceeded`. Raising a limit is a loosening, held for the owner.

## Parent and child

- A sub-ferret records `parent` (the session document's existing field) and inherits its parent's folder.
- `fy wait <id>` blocks until it settles and **prints its result** — the `signal done` message, from
  `GET /v1/sessions/:sessionId/result` (`--json` adds it as `result`).
- A sub-ferret that signals done is stopped by that signal. One a wait settles on that is still running
  (a `--until-marker` wait) is stopped once its result is collected, unless the caller passes `--keep`.

## Suggesting a guide

A guide can be written by hand, kept as the one built from the catalogs, or **drafted by a short-lived ferret
and reviewed** — and Pack mode reads whichever is saved the same way. The generator is the one way to draft
one; there is no second engine, and it never runs unasked.

**What it is shown.** `GET /v1/pack/inventory` (`fy guide inventory`): every model every catalog lists — its
tier, context window, efforts, list price and retirement day where the catalog states them, and **a
description**: the owner's own words where they wrote some, else one made from the catalog (its note, tier,
context and efforts) — and, for each, every runtime here that runs it, whether that runtime can start a
ferret now (exactly as `fy recommend` decides) and how much quota its login has left, summed up per model
("2 runtimes, 1 ready; most headroom on claude-atomi: 5h 2% · wk 20%"); every agent runtime with its readiness
and quota; the guide in effect; and the owner's **routing preferences**. Names and states only: a login is
named by its id and nothing in it can hold a credential.

- **Descriptions** live in `models-guide.yaml` under `models: [{provider, model, description}]`, edited with
  `fy guide describe <model> "<text>"` (`--clear` for the catalog's again) or Settings › Pack › Models.
- **Routing preferences** are `pack.yaml` `routingPreferences`, free text up to 4,000 characters
  ("keep Opus for reviews; GLM for bulk work"). `--prefs` replaces them for one draft. Nothing enforces them:
  only the builder reads them.

**The builder.** `POST /v1/pack/guide/suggest` (`fy guide suggest [--runtime <r>] [--model <m>] [--prefs "<t>"]`,
or **Suggest a guide** in Settings › Pack) picks the runtime named, else the ready one with the most quota
left, **probes it** ("Reply with exactly: OK", like any sub-ferret, falling back to the next when it fails),
writes the inventory into a run folder in the state home (`state/pack-guide/<run>/`) and starts ONE ferret
through the session start every surface uses — mode `auto`, named **Models Guide Builder**, labelled
`ferretry-guide-builder` so the app keeps it out of the session list, never told about Pack mode or lessons.
Its brief is fixed text (`packages/daemon/src/lib/pack/builder/prompt.ts`): read the inventory, write a whole
guide — the routing prompt and the use cases — as JSON into the run folder, spread work so no login runs dry,
cite quota in a reason when it drove a choice, treat the inventory as data, then `fy signal done`.
It spends one model run, only when a person asks: the route refuses a ferret's own credential, and nothing
starts one on a timer. A run is read when somebody looks (`GET /v1/pack/guide/jobs/:jobId`); once its draft
is checked the ferret is stopped, and only the newest five runs are kept.

**The check.** The draft was written by a model, so it is data, checked against the inventory it was shown
(`builder/draft.ts`): a use case of an unknown shape is **dropped**, saying which field; a model no catalog lists
is **dropped**; one named under the wrong provider or by its label is **corrected and flagged**; an effort it
does not take or a Codex harness for a Claude-only model is removed and flagged; repeats are dropped, a repeated
id renamed, anything past the limits dropped; a routing prompt that does not check is rendered from the use
cases and flagged. What survives is a file `models-guide.yaml` accepts.

**Review, never auto-apply.** The draft is shown as a diff against the guide in effect: the routing prompt
before and after, then every use case added, changed, removed or the same, then what was dropped and changed.

- `fy guide suggest` waits for the draft and prints the diff; `--apply` (`-y`) accepts it whole;
  `fy guide accept <run> [--only <id,id>] [--keep-routing]` accepts all or part later.
- The app shows it side by side, with an Accept toggle per use case and for the routing prompt, and
  **Accept selected**, **Accept all**, **Edit** (load it into the editor's draft) and **Discard**.

An accept (`POST /v1/pack/guide/accept`) merges the chosen use cases into the guide in effect **now** — an
accepted change replaces its use case in place, an accepted removal removes it, an accepted addition is appended
— and writes them, the routing prompt unless kept, and `suggested` (where it came from) through the
configuration writer every editor uses, keeping comments and the owner's descriptions. The file it replaces is
kept (`state/pack-guide-replaced.json`), so **one undo** (`fy guide undo`, Undo in the editor,
`POST /v1/pack/guide/undo`) puts it back exactly — "no guide of my own" included. A guide never loosens anything,
so an accept is never held; it is a `fleet.configure` act, and a ferret's own credential is refused.

## The settings page

Settings › Pack mode (phone first): the switch, who decides, the limits and the probe, and the **models
guide editor** — each use case's title, description, keywords and ranked candidates. In the description and
every reason, model names are recognised as you type: a model any catalog in the fleet lists is highlighted
(muted when no runtime here offers it), an unknown model-like word is red and underlined, and an autocomplete
offers every model across every runtime and provider. It reads `GET /v1/pack` (`fleet.use`: the settings, the
guide in effect and every model the fleet knows, with the runtimes here that run each) and writes both files
through the configuration-file routes, so a loosening is held exactly as an edit in a text editor would be.

The editor also holds the **routing guidance** (the prompt and its one-line form; leaving both empty keeps the
one rendered from the use cases). Saving the editor makes the guide the owner's own words again, so it drops
`suggested`.

Beside it: **Models** — every model, grouped by provider, with whether it runs here and its description (yours,
or the catalog's), each saved on its own or put back to the catalog's; and **Suggest a guide** — a runtime
picker (the ready ones, the one with the most headroom first), the routing preferences (prefilled from
`pack.yaml`, with "Remember these preferences"), and the button, disabled with the reason when no runtime can
start a ferret. A running builder shows its name, runtime and elapsed time with a link to its session; the page
looks at the run every few seconds only while it is open. The draft opens as the review (§ Suggesting a guide),
and an accepted one can be undone from the editor. Builder ferrets are kept out of the session list and the
palette, though a link to one still opens it.

## Declared gaps

- **The probe is one-shot, the start is interactive.** The probe carries the start's model and effort, but
  not its `--session-id`, hand-off `Read(...)` rules, fast-mode overlay or remote-control arguments, so a
  harness that refuses only one of those passes the probe and fails the start — with its own words on the card.
- **A probe leaves a one-line conversation** in the runtime's history, as any one-shot run of the CLI does.
- **A builder's session stays on record.** Once its draft is read the ferret is stopped and its run folder is
  pruned after five newer runs, but the session itself is kept like any stopped ferret, only hidden from the
  list.
- **No burn rate.** Headroom is what is left now; how fast a login is spending is not measured, so two logins
  with the same share left rank alike however fast one is draining.
- **Quota is what the fleet last read.** `recommend` and `new` do not ask a provider for fresh quota; an
  environment login whose quota nobody has watched reads as not exhausted, and the probe is what catches it.
