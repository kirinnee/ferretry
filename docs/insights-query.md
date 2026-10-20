# Insights query language

Insights › Analytics › Query, `fy analytics` and `GET /v1/analytics?q=…` all take one small query
language. It is shaped like PromQL: an aggregation over a metric, grouped by labels, filtered by a
selector, over a time range. This page is the contract. Anything that writes or reads a query
implements against it, not against the code.

The code: the grammar is `packages/protocol/src/lib/analytics-query.ts`, the wire shapes are
`packages/protocol/src/lib/analytics.ts`, the fleet merge is
`packages/protocol/src/lib/analytics-merge.ts`, and the daemon's execution is
`packages/daemon/src/lib/analytics/results.ts` over rows that `usage-fold.ts` and `session-record.ts`
derive.

## At a glance

```text
sum(cost_usd) by (model) {harness=claude, model=claude-opus-5-5} [7d]
└┬┘ └──┬───┘ └───┬────┘ └───────────────┬──────────────────────┘ └┬┘
 aggregation  metric  grouping                selector                range
```

| Query                                                | Answers                                          |
| ---------------------------------------------------- | ------------------------------------------------ |
| `sum(cost_usd) by (day) [30d]`                       | equivalent API cost per day, last 30 days        |
| `sum(tokens) by (model, harness)`                    | every token, by model and harness, all time      |
| `avg(duration_active_seconds) by (runtime) [7d]`     | mean active time per session, by runtime         |
| `sum(duration_active_seconds_per_turn) by (project)` | active time per turn, by project                 |
| `count by (machine) [24h]`                           | sessions per machine in the last day             |
| `max(duration_wall_seconds) {status=failed}`         | the longest failed run                           |
| `cost_usd [7d]`                                      | the week's sessions, most expensive first (raw)  |
| `{session=ms8kkfyd}`                                 | one session's row (raw)                          |
| `sum by (week) [2026-09-01..2026-09-30]`             | every measure per week across September (legacy) |

## Grammar

Whitespace may appear between any two tokens. Aggregations and `by` are case-insensitive; metric and
label names are not.

```ebnf
query       = [ head ] [ selector ] [ range ] ;
head        = aggregation [ "(" metric ")" ] [ grouping ]
            | aggregation [ grouping ] "(" metric [ selector ] [ range ] ")" [ grouping ]
            | metric ;
aggregation = "sum" | "avg" | "min" | "max" | "count" ;
grouping    = "by" "(" label { "," label } ")" ;           (* 1 to 4 distinct labels *)
selector    = "{" [ matcher { "," matcher } ] "}" ;
matcher     = label ( "=" | "==" | "=~" ) value ;
value       = bare | '"' json-string-body '"' | "'" single-quoted-body "'" ;
bare        = { letter | digit | "_" | "." | "/" | ":" | "@" | "+" | "*" | "?" | "-" } ;
range       = "[" ( relative | absolute ) "]" ;
relative    = integer unit ;                                (* unit: s m h d w *)
absolute    = bound ".." bound ;
bound       = date | instant ;                              (* 2026-10-01 | 2026-10-01T06:00:00+02:00 *)
```

- **An empty query** is the default, `sum by (day)`. **Every session, raw** is written `{}`.
- **Head forms.** `sum(cost_usd) by (model)` is canonical. The PromQL nesting
  `sum by (model) (cost_usd{…}[7d])` and `sum(cost_usd{…}[7d]) by (model)` are accepted and rewritten
  into the canonical form. The selector and the range may each appear only once, inside the call or
  after it. `by` may appear once.
- **No metric** (`sum by (day)`) is the legacy form. It still parses, keeps its old canonical spelling,
  and means the same thing: every measure in one table.
- **A bare metric** (`cost_usd {…} [7d]`) is a raw query: session rows, ranked by that metric, highest
  first. It cannot take `by`.
- **`by` needs an aggregation.** `sum(cost_usd)` with no `by` is valid and gives one fleet-wide row.
- **Matchers.** `label=value` matches exactly, unless the value contains `*` (any run) or `?` (one
  character), which makes it a glob. `label==value` is always exact, even with `*` or `?` in it.
  `label=~glob` is always a glob. Every matcher must hold (AND). A null label never matches. `tree` takes
  one exact session id.
- **Values.** A bare value is trimmed. A double-quoted value is a JSON string (`\n`, `\u0000` and
  surrogate pairs decode exactly). A single-quoted value supports `\n`, `\t` and `\<char>`.
- **Bounds.** A query is at most 2,048 characters, both as typed and once written canonically.
  Escaping can lengthen a value, so a query whose canonical form would pass the bound is refused. This
  is what guarantees every accepted query's canonical form parses back.

### One canonical spelling

`canonical` (in `parsed`, in the response's `query`, and from `formatAnalyticsQuery(parts)`) is the
only spelling written back: lower-case aggregation, `agg(metric)`, `by (a, b)`, `{a=b, c=d}` with a
value quoted only when it needs to be, and the range last. Two spellings of one query get the same
canonical form, and the canonical form parses to the same query (property-tested). Editors that change
a query (metric picker, range chips, group chips) call `formatAnalyticsQuery` instead of writing text.
It re-parses its own output, so it cannot emit a query the grammar refuses.

A relative range is written in the largest unit of `d`, `h`, `m`, `s` that divides it exactly. Weeks
are read but never written: `[4w]` becomes `[28d]`, and `[14d]` stays `[14d]` rather than turning into
`[2w]` under a chip. An absolute range is written as dates where both ends fall on UTC midnight, with
the last day inclusive. Otherwise it is written as ISO instants in UTC.

## Metrics

A metric is what a query is about. Each one maps to one field of the aggregate result
(`ANALYTICS_METRIC_MEASURES`). `analyticsMetricValue(result, metric)` and
`analyticsRawMetricValue(row, metric)` return it in the metric's unit. Every response still carries
every measure, so a table can show them all while a chart plots the chosen one.

| Metric                             | Unit    | Exact definition (per session, then aggregated)                                                         |
| ---------------------------------- | ------- | ------------------------------------------------------------------------------------------------------- |
| `tokens`                           | tokens  | gross input + output, summed over every request in the transcript (one per Claude `message.id`)         |
| `tokens_input`                     | tokens  | gross input: uncached + cache read + cache write (Claude); the prompt total (Codex)                     |
| `tokens_output`                    | tokens  | output, reasoning included                                                                              |
| `tokens_cache_read`                | tokens  | input served from cache, a subset of `tokens_input`                                                     |
| `tokens_cache_write`               | tokens  | input written to cache, a subset of `tokens_input`                                                      |
| `tokens_reasoning`                 | tokens  | the part of output a harness names as reasoning (Codex); null where it names none (Claude)              |
| `cost_usd`                         | USD     | equivalent API cost at the rate in force when the row was ingested, **not** a bill (subscriptions)      |
| `turns`                            | turns   | owner prompts in the transcript (see [Turns](#turns)); the daemon's send counter when none was readable |
| `sessions`                         | count   | the group's session count; `sum(sessions)` = `count`                                                    |
| `duration_active_seconds`          | seconds | active time, [defined below](#duration)                                                                 |
| `duration_wall_seconds`            | seconds | wall time: session finish − session start                                                               |
| `duration_active_seconds_per_turn` | seconds | Σ active time ÷ Σ turns over the group: a **ratio of sums**                                             |

Token, cost and duration figures are **evidence or null**. A session whose transcript could not be
found, read whole or accounted for has null token columns and a recorded refusal. It is never counted
as zero (see the analytics mount's contract in `packages/daemon/src/lib/runtime/mounts/analytics.ts`).
For why costs read "Unpriced" and where prices come from, see
[the model catalog's Prices section](model-catalog.md).

### The ratio metric

`duration_active_seconds_per_turn` is Σ active ÷ Σ turns over the group's sessions. It is never the
mean of per-session ratios, which would weigh a one-turn session the same as a hundred-turn one.

- **Aggregations.** Only `sum` and `avg` take it, and they give the same number:
  avg(a) ÷ avg(b) = sum(a) ÷ sum(b) whenever both are known for every session. `min`, `max` and `count`
  refuse it (`ANALYTICS_RATIO_METRICS`).
- **Partial knowledge.** The ratio is known only when both the active-time and the turns measure are
  known for **every** session in the group (each measure's `known === total`) and the turn sum is not
  zero. Otherwise it is null. One session with unreadable timestamps therefore makes its group's ratio
  unknown. Dropping that session would quietly change what the number is about.
- **Raw rows.** A session's own active time ÷ its own turns, or null.

## Labels

Labels group and filter. A label whose value is null groups as its own row (sorted last) and never
matches a matcher.

| Label            | Value                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------- |
| `runtime`        | the session's runtime (its configured `agent`); alias of `agent`                        |
| `model`          | the selected model, normalised to its catalog identity                                  |
| `pricing_model`  | the model the transcript was priced against (may differ from `model`)                   |
| `harness`        | `claude` or `codex`                                                                     |
| `machine`        | the answering daemon's name: the one pairing gave it, which is what the app shows       |
| `project`        | the session's working directory; alias of `repo` (and of `cwd`)                         |
| `session`        | the session id; alias of `id`                                                           |
| `day`            | creation day, UTC, `YYYY-MM-DD`                                                         |
| `week`           | the Monday starting the creation week, UTC, `YYYY-MM-DD`                                |
| `status`         | terminal status: `completed`, `failed`, `stalled`, `stopped`                            |
| `mode`, `label`  | the session's mode and its label                                                        |
| `parent`, `tree` | the parent session id; the root session id of the session's tree (`tree` is exact-only) |
| `context_window` | the context window, in tokens                                                           |
| `token_data`     | `known` when the session has a proven token total, else `unknown`                       |

`machine` is stamped when the query runs, not stored. The index belongs to one daemon, and a renamed
machine's history follows the new name. A daemon that names no machine answers `machine: null`. The
app may still show its own local label for a connection.

## Aggregations

`sum`, `avg`, `min` and `max` fold each measure over the group's sessions. A group's measure has
`known` (sessions that stated the figure) and `total` (sessions in the group), and its `value` is
stated **only when every session stated one** (`known === total`). A partial sum would read as a
smaller total. `count` gives the session count (`sessions`) and no measure values. Each group also
carries `rates` (stall, failure, completion, as percentages of its sessions). Groups are sorted label by
label, nulls last.

A query with no aggregation is **raw**: up to 100 session rows, newest first, or ranked by the metric
for a bare-metric query (unknown last, then newest, then id, then machine), with `truncated` when more
matched.

## Ranges

A range keeps the sessions whose **creation instant** falls inside it. A session with no creation
instant is in no range.

- **Relative** `[24h]`, `[7d]`, `[4w]`: the window ending at the instant the daemon answers, which is
  the ingestion clock's reading when the query ran. At most 3,660 days.
- **Absolute** `[2026-10-01..2026-10-20]`: half-open, `from` inclusive and `to` exclusive, so adjacent
  ranges never count a session twice. A date is a UTC day, and a date as the end includes that whole
  day. Instants need a timezone. Both ends fall in 1970..9999, and the end is after the start.

The response echoes `parsed.range` and states the resolved instants in `scope.window`, so a chart can
draw a relative range's axis without guessing the daemon's clock.

## Duration

Both durations come from finished sessions only.

### Turns

A **turn** starts at an **owner prompt**. It runs to its **last work record** before whatever ends it:
the next prompt, input the harness wrote into the user channel, the harness's own turn-complete record
(Codex `task_complete` or `turn_aborted`, Claude `stop_reason: end_turn`), or the end of the
transcript.

**Work** is an assistant message, reasoning, a tool call or tool result, a usage record or an error.
Nothing else moves a turn's end: not a settings record (`turn_context`), not a turn-started marker
(`task_started`), not developer or system context. Codex writes `task_started` and `turn_context`
just before each new prompt, sometimes hours after the last turn ended, so letting them extend the turn
would count that idle time as active.

An owner prompt is a user-channel message the owner sent (`isOwnerMessage`). The following are **not**
prompts:

- a tool result (Claude's `tool_result` block, Codex's `function_call_output`). It is a different
  event kind altogether, and it is work.
- a record the harness wrote into the user channel itself. For Claude that is `isMeta`,
  `isCompactSummary`, `isVisibleInTranscriptOnly` or a non-human `origin`: background-task
  notifications, subagent messages, the "This session is being continued…" compaction summary.
- the context Codex injects as user messages: `# AGENTS.md instructions` / `<INSTRUCTIONS>` (current
  builds, two blocks of one message, so the whole message is injected), `<user_instructions>` and
  `<environment_context>`.
- what Claude Code records for a slash command (`<command-name>`, `<command-message>`,
  `<command-args>`), its local output (`<local-command-stdout>`, `<local-command-stderr>`), and an
  interrupt (`[Request interrupted by user…]`).

These are **input**. Input closes the open turn and opens an **uncounted segment**: the work it provokes,
such as the model replying to a task notification or continuing after a compaction, is active time, but
it is not a turn. One prompt record split into several content blocks is one prompt. Claude records are
`user` lines with text, and Codex records are `response_item` messages with role `user`. Both parsers
normalise to the same events, so one definition holds for both.

`turns` counts the transcript's prompts. The daemon's send counter (`state.turn`) answers only when no
transcript could be read, because it never sees a prompt typed straight into the harness, and the
per-turn metric must divide by the turns the active time was measured over.

### Active time

**Active time** = Σ over turns and uncounted segments of (last work − start), from the transcript
records' own `timestamp` fields.

- A segment starts no earlier than the previous one ended: start = max(prompt, previous end). Records
  written slightly out of order (a queued prompt stamped before the last record of the turn it
  interrupts) never count the same time twice, and no segment is negative.
- The wait between one turn's last work and the next prompt or input is not counted. That is a person
  reading, thinking or away, or a session idle until a notification.
- Active time never exceeds wall time: the session row clamps it to `durationMs`.

Active time is **null** (unknown, never zero) when the transcript is unresolved, unreadable, damaged
(any byte never parsed) or read mid-record, when any prompt has no readable timestamp, or when the
transcript shows no prompt at all. Every session starts from one, so a transcript with none uses a
grammar the fold does not recognise. In those cases `turns` falls back to the send counter. Input with
no readable timestamp opens nothing: its segment is skipped.

### Wall time

**Wall time** (`duration_wall_seconds`, stored as `durationMs`) = session finish − session start.
Start is the recorded `startedAt`, falling back to creation. Finish is the durable `finishedAt`.

## Across machines

The app sends a query to every connected daemon and merges the answers with
`mergeAnalyticsResponses(responses)`. It is exact for `sum`, `count`, `min` and `max`, and for `avg`
up to floating-point rounding (property-tested against one answer over every machine's sessions,
commutative, associative):

- aggregate rows merge only when **every grouping label matches**. `known` and `total` add. `sum`
  adds, `min` and `max` take the extreme, and `avg` is weighted by `known`. A null part makes the
  merged value null, the same "partial = unknown" rule as one daemon. A measure with `total: 0` on a
  row that has sessions is an older daemon's defaulted `activeDurationMs`. It merges as unknown for
  those sessions (`{ value: null, known: 0, total: sessions }`), so the fleet figure turns unknown
  instead of silently describing only the machines that sent it;
- rates are weighted by sessions; `scope` counts add; `scope.window` spans the earliest `from` to the
  latest `to`; the index account adds, `schemaVersion` is the **oldest** in the fleet, and `refreshing`
  is true if any machine is;
- a ratio metric is read **after** the merge, from the merged numerator and denominator, and is null
  unless both cover the same sessions (equal `total`);
- raw answers concatenate under the one shared ordering (`compareAnalyticsRawSessions`), cut to the
  largest limit, with `truncated` if any part was or the concatenation exceeds it;
- an empty list, mixed kinds, or answers aggregated, grouped or measured differently are refused
  (`AnalyticsMergeError`).

A daemon older than this contract omits `activeDurationMs` and `machine`. The schemas default them
(`{ value: null, known: 0, total: 0 }` and `null`), so its answer still parses, and it merges as
sessions whose active time is unknown.

## Declared gaps

- **A wait inside a turn counts as active.** A permission prompt or an `AskUserQuestion` answered
  hours later comes back as a tool result, which is work. So the whole wait between the question and
  the answer is active time, up to the session's wall time.
- **One Claude API response is counted once, by `message.id`.** Claude Code writes a line per content
  block, each repeating the response's usage, and the fold keeps the last line for each id. A
  transcript that reused one id across two responses would under-count.

- **Only finished sessions are indexed.** A session is ingested at a durable terminal state, so a
  running session is in no query. A revived session leaves the index until it ends again.
- **Ranges filter on creation**, not on when the tokens were spent. A session that ran across midnight
  counts wholly on the day it was created.
- **Active time trusts the transcript's clock.** Records written with a skewed clock skew the turn. A
  harness that stamps nothing yields null.
- **A relative range uses each daemon's own clock.** Merged windows can differ by the machines' clock
  skew; `scope.window` shows the span.
- **No arithmetic between metrics** beyond the one declared ratio, and no `topk`. A bare-metric raw
  query ranks sessions, and grouping plus sorting happen in the app.
- **`project` is the working directory**, not a repository identity. Two checkouts of one repository
  are two projects.
- **A `}` inside an unquoted value** now ends the selector, because a range may follow it. Quote such
  a value. The canonical form always does.
