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
Pack mode: hand self-contained parts of your task to sub-ferrets (each on the model that suits it). Prefer them to built-in subagents for real work; do small things yourself. Pick models by the Routing line.
1. `fy recommend` lists usable models, most quota first, with start commands.
2. `fy new --runtime <runtime> --model <model> [--effort <level>] --name "<short task title>" "<complete brief>"` starts one (`fy new --auto "<brief>"`: Ferretry chooses). Always pass `--name` (2–5 Title Case words). The brief is all it knows: what to do, where, what to report.
3. If refused (out_of_quota, not_logged_in, cli_missing, probe_failed, …), read the reason, try the next. limit_reached or depth_exceeded: do it yourself.
4. `fy wait <id>` prints its result; check it, then combine. Label sends: `--kind blocker|action|fyi` (fyi rarely).
Check your children with `fy status --subtree` instead of asking them. Delegate screenshot review to a sub-agent and keep only its verdict.
Stop unneeded sub-ferrets: `fy stop children <your id> --yes`.
```

The Pack section then ends with the **whole routing prompt** ([The routing prompt](#the-routing-prompt)) as
one line of its own, `Routing: …` — the same text Jev decides with. The daemon renders it into
`FY_PACK_ROUTING` at **every launch** and never stores it, so a restart hears the prompt saved now. The rendered
line is shared, not re-derived per ferret: it is kept while the configuration load in effect holds (a saved
file replaces it) and for 30 s at most, because every running ferret's "outdated" mark builds the environment a
relaunch would, and deriving the line reads the whole runtime catalogue. Each line is
trimmed and its bullet dropped, lines are joined with a space after a sentence's end and `; ` otherwise, a
double quote becomes a single one, and a backslash or control character is deleted. The wrapper appends it
only when `FY_PACK=1`, and deletes any quote, backslash or control character again first, so a value nobody
checked cannot break either harness's quoting.

Built-in subagents are **discouraged, not blocked**: nothing is taken away from the harness.

**Size.** Every Ferretry instruction together is at most about 8 KB (≈ 2,000 tokens) with every section on
and the longest routing prompt:

| Section                                  | Characters | ≈ tokens | When                        |
| ---------------------------------------- | ---------- | -------- | --------------------------- |
| Tools (terminals, browser pages)         | 1,294      | 324      | every agent runtime         |
| Ferretry settings (short "Set up" skill) | 493        | 123      | every agent runtime         |
| Notify (`fy notify`, the Inbox)          | 303        | 76       | every agent runtime         |
| Board (opt-in; `fy task`, cards)         | 757        | 189      | every agent runtime         |
| Agenda (`fy agenda`, with answer shapes) | 1,289      | 322      | `FY_AGENDA=1`               |
| Hypermedia                               | 1,320      | 330      | `FY_HYPERMEDIA=1`           |
| Pack mode                                | 1,038      | 260      | `FY_PACK=1`                 |
| Its routing line                         | ≤ 1,210    | ≤ 303    | `FY_PACK=1`                 |
| Lessons                                  | 238        | 60       | `FY_LEARNING_PASSIVE=1`     |
| The tools server's MCP instructions      | 112        | 28       | always — one line, no rules |

The full "Set up Ferretry" skill (4.2 KB) is no longer in any prompt; the settings section points at
`fy config guide`, which prints it. A test keeps the whole prompt, with the longest routing prompt, under
8 KB (the Tools section grew by 351 to teach the login rule and `terminal_request_input`: do the login or website step yourself, ask the owner only for the one secret value, then by 6 more, its wording tightened, to teach `browser_request_input` and to never create a passkey; the old always-on Agenda section became the short Notify rule, and its words moved into the Agenda section, which only a ferret in agenda mode carries — [notifications.md](notifications.md#agenda-mode); Hypermedia grew by 335 to teach `chart`) and the Pack section itself under 1,050 characters. The always-on Board
section (749, with the card-writing rule, How to test and the lane-by-category rule) was paid for, not added on top: the tools are named by prefix (`terminal_*`, `browser_*`), map, media
and chart's full spec moved behind `fy render guide <type>`, and the lessons rule was compressed. The measured total
is 7,246 without the Tools growth above (the Board rule teaches How to test and which lane by the kind of work, in tightened words, the lane rule paid for by tightening Hypermedia; the Agenda section carries the required `--premise` and `--context`, the self-contained, full-Markdown, hypermedia rule, the reply-rests-the-item rule — `agenda answer` brings it back, `agenda rest` takes it on, `done` closes it once nothing is left (it replaced the older `edit --back`, in one character less) — and the rule that an owner's question about an item is answered ON it (`agenda answer`, options kept) and an unanswered question is closed only with `done --reason`, paid for in its own words and by raising the cap from 7.9 to 8 KB; its one kind → answer-shape line, `AGENDA_SHAPE_LINE` from `@ferretry/protocol`, replaced the old per-kind flag hints and was paid for by tightening the section's own wording, leaving 6 characters under the cap; the `form=` clause for agenda forms, added after, was paid for by trimming the Lessons rule, so the measured total is 7,841), and the test keeps at least 150 characters of headroom under the 8 KB cap. The routing line grew from a 150-character
summary to the whole prompt when the use-case guide became one routing prompt, so the agent decides with
exactly what Jev is told. The agenda-first model (2026-11-03) rewrote the Agenda section to teach what an agenda
is — one channel of the owner's attention, the three-part test, search-check-open, the states, the type stages,
splitting and chat discussion — and the Board section to say a card shows progress only, its asks ride its agenda,
and there are no umbrella cards. It was paid for by the Board section's gate words and its full `fy task create`
example, and by tightening the Agenda section's own wording: agenda 1,237 → 1,285, board 802 → 638, the measured total
7,841 → 7,725. That leaves 125 characters under the cap for the agenda verbs that ship next (`answer`, `rest`, `log`,
`split`, `merge`), which join the section when they exist. Review round 1 restored the owner's two standing rules —
"Bug batch: ONE agenda, line each + where tracked." and "Owner Q: answer ON it, options stay; no item: ONE `-k info`." —
paid for by tightening the Agenda section's other lines: agenda 1,285 → 1,276, the measured total 7,725 → 7,716
(7,730 counting the 14 section-separator characters), leaving 134 characters under the 7,850 cap (120 counting the
separators). The agenda body rule (keep the body a one-screen summary; link the full report) then took the agenda
section 1,276 → 1,319 (cap 1,290 → 1,330). With the send-label rule that took Pack to 1,026, the measured total is 7,814
(7,828 counting the separators), leaving 36 characters under the 7,850 cap (22 counting the separators). The
pack-status rule (`fy status --subtree`, screenshot review by a sub-agent) then took Pack to 1,166 and the total to 7,954, over both
caps; the Pack wording was tightened (1,166 → 1,046, no rule dropped), so the measured total is 7,834 (7,848 counting the
separators), leaving 16 characters under the 7,850 cap (2 counting the separators). The merge of that with the agenda model tightened
the Agenda section's own wording (the repeated "unsure: closest", `done <id>` → `done`, `"<the ask>"` → `"<ask>"`, the form's
"text in the reply", which the help already says, "on it" in the chat line, "say so" and "your"): agenda 1,319 → 1,230, the measured
total 7,745 (7,759 counting the separators), leaving 105 characters under the 7,850 cap (91 counting the separators).
Final review then restored "on it" in the chat line (the owner's words go ON the agenda item): agenda 1,230 → 1,236, the measured total
7,751 (7,765 counting the separators), 99 characters under the 7,850 cap (85 counting the separators).
PR 3's conversation verbs then joined it — `log <id> --reply|--rest` in the chat line, and `split` and `merge`
in the splitting sentence — partly paid for by `answer <id> "<text>"` → `answer <id> "…"`: agenda 1,236 → 1,266 (cap
1,270), the total then 7,781.
The Hypermedia line then learned `card` and `board` (live board cards) on main, 1,288 → 1,320. Together with PR 3's agenda the measured total is
7,813 (7,827 counting the separators), 37 characters under the 7,850 cap (23 counting the separators). The card-asks PR then
reworded the Board section ("Before it's ready to try:", "lane by work", "add to one") and kept "show progress only": board 638 → 631, the
measured total 7,806 (7,820 counting the separators), 44 characters under the 7,850 cap (30 counting the separators).
PR 10 (teach round 2) re-read the Agenda and Board text against the spec and found every rule and verb (`answer`, `rest`, `log`, `split`, `merge`, the stages) already taught except the `done` verb and "say so" when unsure. Review round 1 added both, paid for by "logs their words verbatim" in place of "puts their words on it verbatim"; round 2 put the chat reply's teaching "link it" back and paid for it with "unsure→closest" in place of "unsure: closest": agenda 1,266 → 1,269 (cap 1,270), the measured total 7,806 → 7,809 (7,823 counting the separators), 41 characters under the 7,850 cap (27 counting the separators). `teaching-spec.test.ts` now holds each verb and the stage chain to the spec.
The body as the live document (F909, the owner on !A332: "the chat is the stream of log, the body is the DB") then replaced the body rule above: `--where`=short status on the open line, and "Body=live doc (report/plan/status): rewrite it whole (`edit --body-file`); chat points at it." on the state line, paid for in part by the old "(rest: `--body`, one-screen summary; full report: `--link`)", ", `--where`=now" and "Keep current (`edit`)": agenda 1,269 → 1,289 (cap 1,270 → 1,300), the measured total 7,809 → 7,829 (7,843 counting the separators), 21 characters under the 7,850 cap (7 counting the separators). The whole-prompt cap is unchanged.
The owner's asks are public cards (the owner, 2026-11-04: "when user ask for ticket or tickets, make sure they are not internal. the board should answer 'What's the current status of all the things I asked you to do'") added one Board sentence, 631 → 757 (cap 700 → 760). It was paid for in part by Pack (1,046 → 1,038: "agents, ") and Tools (1,299 → 1,294); the Agenda, Pack and Hypermedia wording that is left is pinned by tests, so the **whole-prompt cap was raised 7,850 → 7,950** (`8_000 - 50`), the measured total 7,942 (7,956 counting the separators, as every earlier figure here is counted: the cap is on the section text, and 44 characters remain under 8,000).

The tabs (&F923) then made the main tab, "Where we are now", the first and default tab, as long and rich as it needs to be, and let a ferret add tabs of its own: the open line dropped ", `--where`=short status", and the state line became "Live doc=tabs, rewrite each whole: `edit --where-file` (main), `--body-file`, `--tab-file Name=f`; chat points at it.": agenda 1,289 → 1,289, the measured total unchanged.

The owner then asked for the body to be split by content type (&F946: _"split by content type, unless there's no serial dependency … a long continuous report should STILL be 1 tab"_): the state line became "Live doc=tabs by content kind (serial stays one), rewrite each whole: …", paid for in part by the open line's placeholders (`--premise "<now>" --context "<facts>"`) and an unquoted `--term X=meaning`: agenda 1,289 → 1,311 (cap 1,300 → 1,320). The rest of the wording is pinned by tests, so the **whole-prompt cap was raised 7,950 → 7,970** (`8_000 - 30`), the measured total 7,964 — still under 8 KB.

The owner's board-and-agenda teaching (&C48, 2026-11-04) then added five rules and paid for them inside the 8 KB:

- **Board** (757 → 814, cap 760 → 820): the board runs itself (_"TASK no longer have user interactivity anymore! agenda
  tracks all those"_: a card never asks; only an agenda item asks, and its answer moves the card — 2026-11-06, &B165, at 817), public = the owner's
  asks and private = the ferret's sub-cards, planning is a phase, the title and summary read as a sitrep, and the card's
  status (`--status-{now,done,next}`), and **read → edit** (the owner: _"we need to read to know what needs to be
  updated, else there might be many segments that might be outdated!"_: `fy task show` whole, then edit every stale
  part). Paid for by "(`fy board lanes show`)", which the move's
  help and refusals already print, and by tighter words for the umbrella, related-card and agenda sentences.
- **Agenda** (1,311 → 1,380, cap 1,320 → 1,390): every update reads the item whole (`show`) and edits every stale part
  — premise, context, the ask, its options and kind (how to reply), still-open and each tab (!A358); the tabs
  hold any kind of content (to-dos, steps, explainers, results) and steps and explainers stay there. Paid for by the
  stage chain and `--stage` (the owner: _"now agenda doesn't have a "main" type any more"_; the stage stays in the
  daemon and in `--stage`'s help) by `--where-file|--body-file|--tab-file` written as one flag list. Review kept the open line's value
  placeholders, so a copied command runs.
- **Hypermedia** (1,320 → 1,209): the owner's explainer rule — ADHD-friendly, said in those words, an example for each
  point, and interactive visuals the reader changes, never steppers (_"interactive should not be steppers -- there's no
  need for steppers"_) — paid for by tightening the section's first lines and its
  mermaid, svg and html lines. Its last line now says where fy-render draws (chat, agenda tabs and cards), which the
  old "Chat only" contradicted.

The cap now **counts the blank line between sections** (14 characters), as the composed prompt has it — every earlier
figure above left them out. The measured total is 7,993 with them, so the **whole-prompt cap is now `8_000`**: the 8 KB
itself, 7 characters of headroom. The next rule must be paid for in words. The sub-ferret section grew 759 → 840 (cap 760 → 880) for its card line (read it, then edit its status and How
to test; the old "Your final report says how the owner tests it" went, since the holder now writes it); it is not in
the lead's total, and the sub-ferret prompt (2,631) stays smaller than the lead's (2,910).

## The routing prompt

ONE setting says which model runs which kind of sub-task: `prompt` in `config/models-guide.yaml`, plain text of
at most **1,200 characters**. Both deciders read the same text, in either mode:

- **The asking ferret** reads it whole in the Pack section of its system prompt, and again in `fy recommend`.
- **Jev** is given it as its guidance when Jev decides.
- **`fy new --auto`** tries the models it **names**, in the order it names them.

```yaml
# yaml-language-server: $schema=.schema/modelsGuide.json
prompt: |
  Planning, review and security-sensitive code: claude-opus-5-5 at max; gpt-6-astra for a second opinion.
  Everyday coding: claude-sonnet-5-5. Chores and bulk edits: claude-haiku-5-5 at low.
  When claude-work is low on quota, prefer glm-5.3.
```

- **A model is named** by its id or its catalog label, ignoring case — `claude-opus-5-5`, `Claude Opus 5.5` —
  exactly as the editor highlights it (`packages/protocol/src/lib/pack-mentions.ts` is the one recogniser both
  use), so the highlighter and the router never disagree about which word named which model. An **effort**
  written right after a name — `claude-opus-5-5 at max`, `@max`, `(max)` — is that model's effort for
  `--auto`, when it is one of the model's own.
- **No `prompt`: the default.** A machine that never wrote one gets one rendered from the catalogs in effect:
  the strongest tier at its highest effort for planning, review and the hardest code (with another family's
  strongest for a second opinion), the balanced tier for everyday coding, the fast tier at its lowest effort
  for chores — a model a runtime here runs before one nothing here runs, providers in the order Anthropic,
  OpenAI, Z.ai, DeepSeek, Kimi, MiniMax, Qwen, Ollama, then the rest. It moves with the catalogs without a
  release.
- **A model the prompt names that nothing here runs is kept**, never removed: a prompt is portable between
  machines. `--auto` skips it; the editor shows it muted, and an unknown model-like word red.
- **Where it came from.** `suggested: {by, via, at, acceptedAt, mode?}` records the model that rewrote an accepted
  clean-up, or wrote one (`mode: generate`); `fy recommend` and the settings page say so. Saving the prompt by hand drops it — the text is the
  owner's own words again.
- **Tolerant read, strict write.** A prompt longer than 1,200 characters does not check, and the last good
  version stays in effect. A routing prompt never loosens anything (it widens nothing a ferret may do or
  spend), so an edit is never held.

### Migration

The prompt replaced a **models guide** of use cases (each with ranked candidates, keywords and reasons),
per-model descriptions, the builder's `routingPreferences` in `pack.yaml` and a one-line `routing.short`. The
first daemon start with this version renders an old guide into one prompt, **once**:

1. Both files are copied whole, as they were, into `state/pack-routing-migration-<when>.json` — first, so
   nothing is lost even if a write after it fails.
2. `models-guide.yaml` gets `prompt`: the old use cases, each with its first three candidates and their
   efforts, best first (a guide that named none ran on the catalogs' guide, so the default prompt stands in),
   then the old routing prompt, then the routing preferences. When that is longer than 1,200 characters the
   use cases are kept whole and the prose is cut at a sentence, and the daemon's log says so. The old keys
   (`useCases`, `routing`, `models`) and the old `suggested` are removed.
3. `pack.yaml` loses `routingPreferences`.

Until it runs, an old file still loads (the old keys are read, never written) and is rendered the same way on
the fly. A start that finds none of the old keys does nothing. An undo kept from an accepted use-case guide no
longer reads and is dropped. Clean up turns a migrated prompt into a short one.

## `fy recommend ["<task>"]`

`POST /v1/pack/recommend {task?}` — `operator`, `fleet.use`. It prints the **routing prompt** in effect (and
where it came from) and a **live list of the models usable now** — one row per model a runtime here offers:
the runtime with the most headroom that could start it, whether it can (and why not), its quota, where the
prompt names it and the effort it names, and the command that starts it. Nothing is matched against the task:
the asking ferret decides with the prompt and the list. `next` is the command `--auto` would try first.
`--json` prints the payload. `fy guide show [--json]` prints the prompt alone.

Each runtime is checked **now**, in the order a person would fix it:

| Check                               | Refusal code        |
| ----------------------------------- | ------------------- |
| An agent runtime                    | `not_agent`         |
| Its CLI is installed                | `cli_missing`       |
| Its login is within its budget      | `over_budget`       |
| A start can run its launcher        | `cli_missing`       |
| Every secret its login names is set | `not_logged_in`     |
| Its login is signed in              | `not_logged_in`     |
| Its quota is not used up            | `out_of_quota`      |
| It can launch at all                | `not_logged_in`     |
| It offers the model                 | `model_unavailable` |

What a runtime offers is its login's catalog's models, else its profile's model set's available ones; a
runtime on the harness default offers no named model and is not listed. The same model resold by another
catalog (Claude Opus 5.5 through Bedrock) is **one row**, served by whichever runtime has the most headroom.

### Quota

Quota changes hour by hour, so it is applied **at routing time**, from the fleet's own last reading of each
login (the windows the app shows as "5h 2% · wk 46%", `packages/daemon/src/lib/pack/quota.ts`), with no LLM
call and no extra request:

- Each row carries its login's **headroom**, banded by the tightest window measured: _plenty_ (half or
  more left), _some_ (a fifth to a half), _low_ (less than a fifth), _exhausted_ (refused `out_of_quota`).
  A login nothing measured is _unknown_ and is not held against a model.
- The list is **sorted**: ready first, then by band (plenty or unknown, some, low), then by the share left;
  the prompt's order, then the tier, then the label break a tie.
- Of the runtimes that could serve one model, the one with the most headroom is chosen.
- A window whose **reset time has passed** since it was measured counts as fresh, so a login that ran out is
  offered again once its window resets, without anybody reading its usage again. (The older `fy fleet recommend` — a team recommender over a routing
  catalog an operator writes — is unchanged and separate.)

## `fy new`

`POST /v1/pack/new` — `operator`. `fy new` without `--continue` (with it, it still continues an existing
conversation). Inside a ferret's pane the asking ferret becomes the parent. On its own credential (what its
`fy` presents) the **daemon** reads the parent from the credential — a `--parent` naming another session is
`403 parent_mismatch` — so nothing the agent's shell does can change it. With an older `fy` on the admin token,
`FY_SESSION_ID` names it (the `x-ferretry-session-id` header), and the daemon applies the same rule to that session, and when the shell dropped that (a subshell, a sandbox) the CLI reads the pane's tmux
session's own copy (`tmux show-environment FY_SESSION_ID`), so the parent is recorded either way.

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
2. **Order**: the named runtime — checked as `recommend` checks it — or, with `--auto`, the ready models the
   routing prompt **names, in the order it names them** (each at the effort written after it, unless
   `--effort` says otherwise), then the ready model with the most headroom it does not name — or **Jev's**
   order when Jev decides.
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
   the brief followed by a footer telling the sub-ferret to finish with `fy signal done "<result>"`. The
   sub-ferret gets a **board card** with the session when the lead's board is on, or when the lead holds a card
   to put it under (the brief names it, or the lead's focus) or hands one over (`--card`): owned by the lead,
   assigned to the child, and the footer names it (`Your card is &F413 on the Ferretry board`). On a board that
   is off ([board.md](board.md#the-board-is-opt-in)) and with no card in hand, the child starts with none and
   `fy new` says so. The start no longer forces board access
   `none`: authority on the board is ownership and lineage. A board failure never fails the start; `fy new`
   prints what it could not do. A
   harness that exits before it is ready fails the start with its exit status **and its last output lines**
   (`the interactive harness exited (2): its last output was "…"`), so the card says why — the wrapper's
   refusal naming a missing secret, or the harness rejecting an argument the one-shot probe does not pass.

The answer is never an HTTP error for a refusal: it is `{outcome: 'refused', refusal: {code, message,
remedy}, attempts}`, every attempt listed, so a ferret falls back on the code. `fy new` exits **2** on a
refusal (a failure of the command itself is 1).

| Code                                  | Means                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `pack_off`                            | the machine's or this ferret's switch is off                                                            |
| `limit_reached` / `depth_exceeded`    | see Limits; do the work yourself                                                                        |
| `unknown_runtime` / `not_agent`       | no such runtime / one that cannot run sessions                                                          |
| `cli_missing` / `not_logged_in`       | the CLI or its launcher is missing / the login needs signing in                                         |
| `out_of_quota` / `model_unavailable`  | quota used up / the runtime does not offer the model                                                    |
| `disabled`                            | the runtime or its login is switched off; pick another or `enable` it                                   |
| `over_budget`                         | its login spent its budget trigger here ([budgets.md](budgets.md))                                      |
| `probe_failed`                        | the "reply OK" check did not answer OK in time                                                          |
| `no_candidate`                        | no model a runtime here offers can run now                                                              |
| `scratch_cwd`                         | the named folder is temporary; leave `--cwd` out or `--allow-scratch`                                   |
| `start_failed`                        | the start was accepted but its session came back `failed`; its reason is the message (`fy status <id>`) |
| `jev_unavailable` / `jev_cap_reached` | reserved; today both fall back to the prompt's order, with a note                                       |

## Who decides

`pack.yaml` `decision`:

- **`agent`** (default) — the asking ferret picks, reading the routing prompt in its system prompt and the live
  list from `fy recommend`, and names `--runtime/--model/--effort`. `--auto` takes the routing prompt's order.
- **`jev`** — `fy new --auto` asks Jev (TypeSafe AI's System One model, the Warden's guard) to rank the ready
  models for the task, **guided by the same routing prompt**: one cheap question per start, only when a ferret asks, within `jev.usdPerDay`
  (default $0.25 per UTC day, counted at the Warden's `guard.usdPerMillionInputTokens` (default $0.042 per million), separate from the
  Warden's own cap). Jev sees the task text (bounded), the routing prompt, and up to twelve ready models — the prompt's
  order first, then the most headroom — each with its runtime, label, tier, where the prompt names it and its
  login quota; nothing else. With one ready model Jev is not asked. When Jev cannot answer (no key, a refusal, a
  timeout, an unreadable answer) or the cap is reached, the routing prompt's order is used and the answer's `note`
  says why: a broken Jev never stops a sub-ferret starting. Switching to `jev` is a loosening, held for the
  owner's confirmation ([config-files.md](config-files.md)).

## Limits

Enforced by the daemon on **every** start that names a parent — `fy new` and a plain `fy start` inside a pane
alike — before anything is claimed or written. A warden's own spawns are the Warden's to bound.

**The lineage is the credential's.** A start on a ferret's own credential is ALWAYS that ferret's child —
`fy start` (interactive too) and `fy new` alike: a parent left out is filled in, and one naming another session
is `403 parent_mismatch`. So the limits are always charged to the ferret that asked, and a ferret cannot step
out of them by starting a top-level session, nor by giving its start the Warden's label (`403`; the limits are
skipped only for a session that descends from a real warden). The starts that could only make one — a fork,
adopting a conversation, a Warden investigation or a run with `spawn`, a learning scan, `fy learning run
--spawn` — are a person's, and a ferret may hand over only its own session
([agent-tools.md](agent-tools.md#who-a-ferret-may-be-every-route-says)). A sub-ferret never inherits its
parent's credential: it is minted its own.

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

## Checking on your sub-ferrets

A lead does not need its children to message it progress. A sub-ferret keeps its card's **Status** current (read it with `fy task show
<id>`, then `fy task edit <id> --status-now|--status-done|--status-next`; [board.md](board.md#the-cards-status)), puts
routine progress on its card (`fy task note`) and messages its lead only for a result, a blocker or a decision the lead must make; the lead
**looks when it wants to**:

```text
$ fy status --subtree
rhett (mvzxdjv2-58f11bc0): 3 descendants
SESSION  MODEL        STATE      CARD             PR               LAST
ada      sonnet-5-5   running    &F767 Implement  #321 CI pending  [2m] route and table done, writing tests
  bo     glm-5.3      needs-you  &F770 Review     -                [14m] which lane should review move to?
cy       gpt-6.1-sol  ended 25m  &F768 Done       #320 merged      [25m] merged; nothing left
```

- **One call.** `fy status --subtree [<id>]` asks `GET /v1/sessions/:sessionId/subtree` once (default: the calling
  session; the owner outside a pane names an id). The daemon builds every row from what it already holds — the
  sessions registry, one read of the board's cards, the PR cache the board keeps, and the end of each
  descendant's outbox. It never calls GitHub per row, so fifty descendants cost one request.
- **Rows.** One per live descendant, plus any that ended in the last two hours (`ended 25m`), in tree order: a
  ferret, then its own sub-ferrets indented beneath it, then the next sibling (by callsign). Lineage is the
  registry's `parent` links (the shared `subtreeDepths` walk `fy stop` also uses), never the request.
- **State.** `running`; `waiting` (parked or rate limited); `needs-you` (an open question, an agenda item or a
  flagged need — painted amber); `ended`.
- **Card and PR.** The card a session works on (`&F767`) and its lane; the card's open PR (else its newest) with CI
  as the board's PR cache last read it (`CI passing|failing|pending`, or `merged`/`closed`). `-` where there is none.
- **Last line.** The newer of the card's last note and the ferret's last message to the asking ferret, cut to one line
  of at most 100 characters (`…`; an emoji counts as one). A tie goes to the note. "The asking ferret" is the caller the
  daemon derives from its credential, not the id in the path: when lead A asks for `--subtree B`, a grandchild's result
  sent to A shows, not only what was sent to B. The owner outside a pane has no such caller, so it sees messages sent to the
  named root. The outbox is read backwards in 64 KiB chunks, whole records at a time, up to 1 MiB: a long report never
  hides the message under it, and only a message older than the last megabyte falls back to the card's note.
- **Secrets never reach the line.** The whole note or message is run through the same fail-closed redactor the
  operator transcript reads use (the vault, logins and just-typed values) **before** it is cut to a line, in one batch
  per table, so a secret that straddles the 100-character cut is masked whole. If the redactor cannot run, every
  excerpt reads `[excerpt withheld]` — the raw text is never shown.
- **Bounded work.** A large tree cannot make the daemon scan without limit: at most 4 outbox files are open at once,
  at most 64 rows get an excerpt (live rows first; at most 8 of them recently ended), and at most 8 MiB of outbox is
  read for the table (1 MiB per row), live rows spending it before ended ones. A read that fails keeps its whole
  share of that budget, since it may already have read it. A row past a budget is still listed — state, card and PR intact — with no
  last line, so `-` in that column on a very large table means "not read", not "silent". A failed outbox read does
  the same for its row.
- **`--json`** prints the same view (`root`, `at`, `endedWindowMs`, `rows` with `depth`, `state`, `status`, `card`, `pr`,
  `last`, `endedAt`).

The route is `fleet.use` ([grants.md](grants.md)). The lead's instruction line is: check your children with
`fy status --subtree` instead of asking them; delegate screenshot review to a sub-agent and keep only its verdict.

## Sub-ferret limits

The owner's decision (2026-10-30): **only lead ferrets raise agenda items and move cards; sub-ferrets report to
their lead.** A _sub-ferret_ is a session another session started (`config.parent`); a _lead_ has none. Many sub-ferrets
are weaker models, writing to the board and agenda becomes a coordination problem, and what they need is mostly
to report back. Enforced by the daemon from the caller's session identity, not by the prompt:

- **Refused** (`forbidden`, saying what to do instead): every agenda write (`add`, `edit`, `surface`, `done`, `dismiss`),
  `fy notify`, every card verb except the three below, and editing a project's lanes. The message reads
  `You are a sub-ferret, so you can't <this>. You may <what it may>. For anything else ask your lead: fy send <lead-callsign> "…"`.
  For a `move`, `focus` or commit/doc `link` on a card its lead holds the last sentence is "Your lead holds this card: claim it first: fy task claim <id>": `fy task claim` takes the card (only from an ancestor, never a sibling's or cousin's), and the holder may then do exactly those, not `drop` or re-plan it ([board.md](board.md#claiming-a-card-your-lead-holds)). A sub-ferret that leads a subtree may still `drop` and `assign` cards in it ([board.md](board.md#authority)).
- **Allowed:** `fy send` to the lead (and peers it names); `fy task note`, and `fy task link --pr` / `--branch`, on a card;
  `fy task edit <id>` naming only the status (`--status-now|--status-done|--status-next|--status-file`) and How to test
  (`--how-to-test`), on the card it holds;
  reading the board and the agenda. `fy new` still makes the sub-ferret's card where it makes one at all.
- **A lead looks after its sub-ferrets' agenda.** The lead — and any ancestor — may `edit`, `surface`, `done` and
  `dismiss` items on a session it started: `fy agenda done !A1 -s <sub-session>`. The daemon proves it by lineage
  (walking `config.parent` up from the target session, fail-closed on a cycle, a missing session or an unreadable
  registry) and attributes the change to the lead, not the sub-ferret. A sibling, an unrelated lead and a
  descendant acting on its ancestor stay refused; `add`, `progress`, `answer` and the owner's snooze/reply verbs
  are not covered, and the daemon's warden-escalation items are never the lead's to close. A sub-ferret that
  itself started a deeper session holds the same authority over that one.
- **The daemon asks through the lead's agenda.** What the daemon raises about a sub-ferret (a gate item, a Not good
  follow-up, a Warden escalation) goes on its **agenda home**, the owner's own ferret, never on the sub-ferret
  ([agenda.md](agenda.md#the-agenda-home)). Only a hands-on card (a password, code or approval the daemon asks for) stays
  on the sub-ferret.
- **Prompt:** a sub-ferret's fixed layer is the tools and settings rules plus two lines (`SUB_FERRET_INSTRUCTION`):
  never raise agenda items or notify the owner, report to your lead with `fy send` and label every send (`--kind blocker|action|fyi`, [message-delivery.md](message-delivery.md#labels-and-combined-delivery)); at each step it reads its card and rewrites the stale parts of its status and How to test (`fy task edit`), routine progress goes on its card (`fy task note`), and its lead is messaged only for a result, a blocker or a decision; if it has a card, link its PR to it, and the card moves itself (the daemon enters its working lane when the session starts); with none, make none. The Notify, Board and Agenda mode paragraphs are left
  out. Sizes with the default binary name: **lead 2910 characters** (4292 with Agenda mode on), **sub-ferret 2631**.
  `FY_SUB_FERRET=1` is derived from `parent` at each launch; a running ferret is told the changed always-on section on the
  owner's next message like any other ([launch-settings.md](launch-settings.md#instructions-that-changed-since-the-launch)).
- **Nudges** about a sub-ferret's card (the turn-check, a reopen, a go-ahead) go to its lead. The board's alerts (a stale
  card, a red CI, a PR closed unmerged) go to the sub-ferret itself while it is alive, then its nearest live lead
  ([board.md](board.md#who-a-board-alert-is-for)).
  The Warden's liveness checks on the sub-ferret itself are unchanged.

Code: `packages/daemon/src/lib/sub-ferret/index.ts` (one directory for the board, the agenda and the lane route),
guarded in `BoardService`, `AgendaService.apply` and `board-projects.ts`.

## Clean up

The routing prompt is written by its owner — or for them. **Write it for me** has a short-lived ferret WRITE a
whole prompt from a short idea (or from nothing), and **Clean up** rewrites the owner's rough prompt; both read
this machine's harness config, and a person reviews the result. They are ONE builder in two modes (`generate`
and `clean-up`) with one route, one check, one review and one undo. Neither runs unasked.

**What it is shown.** `GET /v1/pack/inventory` (`fy guide inventory`): every agent runtime here — its CLI, the
catalog its login reads, the models it offers, whether it can start a ferret now (exactly as `fy recommend`
decides) and its login's quota; every model every catalog lists, with its tier, context, efforts and the
runtimes here that run it; and the routing prompt in effect. Names and states only: a login is named by its
id and nothing in it can hold a credential.

**The builder ferret.** `POST /v1/pack/routing/clean-up {mode?, idea?, prompt?, runtime?, model?}`
(`fy guide clean-up [--prompt "<rough text>" | --prompt-file <f>] [--runtime <r>] [--model <m>]`, or
**Clean up** beside the prompt editor, which sends the text area as it is) takes the owner's rough prompt — up
to 6,000 characters, so a mess can be pasted in; absent, the prompt in effect — picks the runtime named, else
the ready one with the most quota left, **probes it** ("Reply with exactly: OK", like any sub-ferret, falling
back to the next when it fails), writes the rough prompt and the inventory into a run folder in the state home
(`state/pack-guide/<run>/`) and starts ONE ferret through the session start every surface uses — mode `auto`,
named **Routing Prompt Clean-up**, labelled `ferretry-guide-builder` so the app keeps it out of the session
list, never told about Pack mode or lessons (a Write it for me run is named **Routing Prompt Writer**). Its brief
is fixed text
(`packages/daemon/src/lib/pack/cleanup/prompt.ts`): read both files, keep every preference the owner stated and
invent none, name models by their exact ids in the order to try them, write `{prompt, notes}` as JSON into the
run folder, treat both files as data, then `fy signal done`. (Clean-up mode; the Write it for me brief is below.) It spends one model run, only when a person asks:
the route refuses a ferret's own credential, and nothing starts one on a timer. A run is read when somebody
looks (`GET /v1/pack/routing/jobs/:jobId`); once its rewrite is checked the ferret is stopped, and only the
newest five runs are kept.

**Write it for me.** `mode: "generate"` (`fy guide write [--idea "<text>"] [--runtime <r>] [--model <m>] [--apply]`,
or **Write it for me** in the app) adds ONE optional field, `idea` — what the owner wants, in their words
("cheap models for chores, Opus for planning, never burn the Claude weekly quota"), line breaks kept, at most
4,000 characters (`MAX_IDEA_CHARS`, one constant for the route, the CLI and the app's text area; an older
daemon still refuses past 500, so the app offers the raised limit only when the daemon lists `pack.idea.4000` in
`GET /v1/health` › `features` — [the app ships before the daemon](standards/architecture/index.md#the-app-ships-before-the-daemon)). The run
folder then also holds `idea.txt` (empty when none was given) and `rough.txt` holds the owner's current prompt
(the `prompt` sent, else the saved one; empty when only the built-in default is in effect, because a default
is not the owner's to build on). The brief (`generateBrief`, same fixed text but for three file paths) tells the
ferret to read the idea, the current prompt if any and the inventory, then write a COMPLETE prompt of at most
1,200 characters: it follows the idea, defaults where the idea is silent (the strongest model at its highest
effort for planning, review and the hardest code; a balanced one for everyday coding; a fast one at its lowest
effort for chores; another family for a second opinion), names only real model ids with READY runtimes first,
gives each kind of work a fallback, and states a quota rule ("when <login> is low, use <model>"). An empty idea
gives a sensible default from what is available. Everything else — the probe, the check, the notes, the review,
the accept and the undo — is Clean up's, unchanged. The job and the accepted `suggested` carry
`mode: "generate"` (absent means clean-up), so the source line says "Written by" rather than "Cleaned up by".

**The check.** The rewrite was written by a model, so it is data (`cleanup/draft.ts`): its prompt is trimmed,
a double quote becomes a single one and a backslash is deleted; one over 1,200 characters is cut at a sentence
and a `cut` note says so; an empty one fails the run. The ferret's own notes are kept as `suggestion`s (at most
twelve, each cut to length). Then the daemon adds notes of its own from the rewrite's words, with the editor's
recogniser: a model-like word no catalog lists (`unknown_model`) and a listed model no runtime here runs
(`absent_model`).

**Review, never auto-apply.** The rewrite is shown as a **before/after word diff** (just the new prompt, with no diff marks, when there was
no prompt to build on — `before` is then empty) (`diffText` in
`packages/protocol/src/lib/pack-cleanup.ts`, the one diff the CLI and the app both render), then its notes.

- `fy guide clean-up` and `fy guide write` wait for the result and print it (the diff, or the plain new prompt) and
  the notes; `--apply` (`-y`) accepts it; `fy guide accept <run>` accepts it later.
- The app shows it under the editor with **Accept** and **Discard**.

An accept (`POST /v1/pack/routing/accept {prompt, suggested}`) writes the prompt and `suggested` (where it came
from) through the configuration writer every editor uses, keeping comments. The file it replaces is kept
(`state/pack-guide-replaced.json`), so **one undo** (`fy guide undo`, Undo in the editor,
`POST /v1/pack/routing/undo`) puts it back exactly — "no prompt of my own" included. A prompt never loosens
anything, so an accept is never held; it is a `fleet.configure` act, and a ferret's own credential is refused.

## The settings page

Settings › Pack mode (phone first): the switch, who decides, the limits and the probe, then ONE card —
**Routing prompt — ferrets use this to pick which model runs each sub-task**:

- where the prompt came from (your words, an accepted clean-up or written prompt and by whom, or the default);
- **first run — the nudge.** While no prompt has been saved the card says "Not written yet" instead of showing an
  empty box: the "Your idea (optional)" field, a big **Write it for me** button and "Or write it by hand", which
  opens the box;
- once a prompt is saved, **Write it for me** sits above the buttons with the same idea field (it builds on the
  saved prompt); disabled with the reason when no runtime can start a ferret;
- a text area in which model names are recognised as you type: a model any catalog in the fleet lists is
  highlighted (muted when no runtime here offers it), an unknown model-like word is red and underlined, and an
  autocomplete offers every model across every runtime and provider; a counter against 1,200 characters;
- **Clean up** (sends the text area as it is; disabled with the reason when no runtime can start a ferret; a
  running clean-up shows its name, runtime and elapsed time with a link to its session, and the page looks at
  the run every few seconds only while it is open), **Save** (writes `prompt` through the configuration-file
  routes and drops `suggested`; an empty text area removes `prompt`, so the default applies; disabled over the
  limit, with the reason) and **Undo** (while an accepted clean-up or written prompt can be undone);
- the review (the diff, or just the new prompt; the notes; Accept, Edit first and Discard), when one has arrived;
- **Available now**, read-only: the live list `fy recommend` prints.

It reads `GET /v1/pack` (`fleet.use`: the settings, the routing prompt in effect, every model the fleet knows
with the runtimes here that run each, the models usable now, the undo and Clean up's state). Clean-up ferrets
are kept out of the session list and the palette, though a link to one still opens it.

## Declared gaps

- **The probe is one-shot, the start is interactive.** The probe carries the start's model and effort, but
  not its `--session-id`, hand-off `Read(...)` rules, fast-mode overlay or remote-control arguments, so a
  harness that refuses only one of those passes the probe and fails the start — with its own words on the card.
- **A probe leaves a one-line conversation** in the runtime's history, as any one-shot run of the CLI does.
- **A clean-up's session stays on record.** Once its rewrite is read the ferret is stopped and its run folder
  is pruned after five newer runs, but the session itself is kept like any stopped ferret, only hidden from the
  list.
- **`--auto` reads names, not meaning.** It tries the models the prompt names in the order they first appear;
  "never use claude-opus-5-5 for chores" still names Opus first. Write the prompt in the order to try, or let
  Clean up reorder it; Jev and the asking ferret read the meaning.
- **No burn rate.** Headroom is what is left now; how fast a login is spending is not measured, so two logins
  with the same share left rank alike however fast one is draining.
- **Quota is what the fleet last read.** `recommend` and `new` do not ask a provider for fresh quota; an
  environment login whose quota nobody has watched reads as not exhausted, and the probe is what catches it.
