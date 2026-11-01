# Moving a ferret to the other harness (Claude ↔ Codex)

A ferret running on a Claude login can move onto a Codex login, and back, **keeping its conversation**.
Ferretry does this by **converting** the conversation into the other harness's own transcript format. No
model is involved: the conversion is a pure rewrite, checked by the target CLI before anything switches.

- **PWA:** Actions › **Move to Codex…** (or **Move to Claude…**). The sheet shows a preview first.
- **CLI:** `fy migrate <id> --agent <codex-or-claude runtime> --convert`. Add `--preview` to see the
  preview and change nothing.
- **API:** `POST /v1/sessions/:id/conversion-preview` `{agent, model?}` for the preview; the move is the
  ordinary `POST /v1/sessions/:id/migrate` with `conversation: "convert"`
  (`packages/protocol/src/lib/session.ts`).

A same-harness move or Restart never converts: it resumes the transcript as it is
([launch-settings.md › The conversation](launch-settings.md#the-conversation)). Without `convert`, a
cross-harness move is still refused (`409 harness_mismatch`), and the refusal names `--convert`.

## Who moved it, and a relaunch that fails

- **Who.** `session.migrating` and `session.migrated` (and `session.migrate_failed`) carry `by`: `owner` (the CLI
  or the app), `session:<id>` (a ferret that called the move, by its session id) or `warden` (the Warden's own
  move). The Warden's token cannot call the route; its moves are labelled by the Warden itself.
- **A restart** is the same move onto the same login, so it carries `by` too: the person who asked
  (`owner`) or the ferret that ran `fy restart` (`session:<id>`). A restart that has to wait for a busy
  ferret keeps who asked in the queue and names them when it finally runs.
- **A failed relaunch.** The record is restamped onto the new login before the harness is relaunched, and the
  old pane is stopped before the new one starts, so a harness that is alive after a failed relaunch is usually
  the NEW one. The record is put back only when the pane registered for the session is provably the same one
  that served before the move (same pane id, pid and process start, and that pane is alive now: a registration that names a dead pane, or a
  replacement that started but never registered, proves nothing): then no replacement was ever started and
  the old login is still serving. Only the fields the move restamped are put back (login, harness, model,
  command, conversation lineage, migration history); a rename, the session credential or any other write made
  since stays. If the pane changed, the new harness started but its hand-over message was not delivered: the
  record keeps the new login and the failure says so. If the pane cannot be identified, the record is left and
  the failure says to restart the session. If an automatic retry was scheduled instead, the record keeps the
  new login because that retry needs it.
  GAP: a relaunch that rotated the session credential and then failed before a new pane was registered leaves
  an old pane holding the credential it was launched with; restart that session.

## What stays the same

- The ferret keeps its **id, folder, journal and name**. Only the login, the harness and the conversation file change.
- The **original transcript stays on disk**, untouched. The config records where the converted one came
  from (`config.conversion`: harness, conversation id, file, converter version, turns kept and left out),
  and the journal's `session.migrating` says `conversation: "converted"` with `convertedFrom`.
- **Restart afterwards resumes the converted conversation** (Codex `resume <thread>`, Claude `--resume <id>`).
  The lineage is kept across Restarts and dropped by _Start fresh_ or _Go back to the earlier conversation_.

## What crosses, and how

| In the source                                                                      | In the target                                                                                                                |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| What the person said                                                               | The person's messages, in order, with their timestamps                                                                       |
| What the agent said                                                                | The agent's messages, in order                                                                                               |
| Shell commands (Claude `Bash`, Codex `exec_command`/`shell`) with their output     | The target's **own shell tool call** with its output (`Bash` ↔ `exec_command`), output kept to 6,000 characters              |
| Every other tool call (Read, Edit, apply_patch, MCP tools, web search, subagents…) | A **text line** in the agent's turn: `[ran Read: notes.txt] →` and up to 600 characters of the result                        |
| Images and files the person attached                                               | A reference line. An embedded file is **saved** in the ferret's folder (`conversions/<new id>/`) and the line gives its path |
| Ferretry's turn pointer ("Read the file …/turns/turn-007.md…")                     | The message that file holds, when it is this ferret's own hand-off document                                                  |

The target's history opens with a notice saying it was moved from the other harness, that other tools are
shown as text and may not exist there, and — when history was left out — `[earlier history omitted: N turns]`.

## Honest limits

- **Tool semantics become text.** Only shell commands stay structured. The target can read what happened,
  but it can't re-run or continue a Read, an Edit or an MCP call from the old harness, and tool names in the
  history may not exist in the new one.
- **Thinking is dropped.** Claude's thinking is signed for Anthropic and Codex's reasoning is encrypted for
  OpenAI; neither provider accepts the other's. The preview counts how many were dropped.
- **Subagents and sidechains are dropped.** A subagent's own conversation is not carried. A subagent's
  _result_ that came back into the main conversation (Claude's `<task-notification>`) is carried as a message.
- **Harness notes are dropped.** Reminders, environment and AGENTS.md blocks, skill listings, meta records and
  Codex developer messages — the target injects its own.
- **Compacted history stays compacted.** Like the source CLI itself, a conversion starts from the newest
  compaction: its summary becomes the first message and only what followed it is carried.
- **Size is bounded.** The newest **whole turns** (one thing the person said and everything done about it)
  that fit **60% of the target model's window** are kept; the rest is headroom for the target's own prompt,
  tools and further work. Tokens are estimated at 3 characters each, which errs towards keeping less. If the
  newest turn alone is too big, its opening message is shortened and its newest work kept. The preview shows
  the counts; no separate _context downgrade_ confirmation is asked.
- **Effort, fast mode and extra harness flags reset** to the target login's own settings: the two harnesses
  name them differently.
- **Attachments are references.** An image is not re-sent to the new model as an image; the agent can open
  the saved file with its own tools.
- **Claude's side folders** (file history, todos) and Codex's thread database entries are not converted.

## The validation run — nothing switches until the target accepts it

Before the ferret is touched, the daemon runs the **target harness CLI itself** (the binary harness
discovery finds, `harness.paths` / `FY_<HARNESS>_BIN`) non-interactively on a throwaway copy:
`claude -p --resume <id>` or `codex exec resume <id>`, in a throwaway home under the system temp folder,
with its model pointed at a loopback stub on 127.0.0.1 that answers "OK"
(`packages/daemon/src/adapters/transcript/conversion-check.ts`). No login, no token, no network: every
proxy variable points at a closed port.

It counts as accepted only when the CLI exits cleanly, it sent the stub a request, that request's history
contains **every carried message, tool line and shell result, in order**, and the target declares every
native tool the history uses. If the target doesn't declare its shell tool for the runtime's model, the
conversion is redone with shell commands as text and checked again. Any other doubt is a
`409 conversation_unresumable` with the reason, and **nothing was changed**.

The run checks the non-interactive resume. The interactive TUIs were verified by hand on every gated version
(the rollout's `model_provider` exists because Codex 0.145's TUI refuses a thread without one).

## Versions

The converter is **gated to the versions it was measured on** and, for Claude Code, refuses anything else on
either side, in plain words (`packages/daemon/src/lib/transcript/convert/versions.ts`). Codex has one exception,
below:

- Claude Code **2.1.2xx and 2.1.3xx** (measured: 2.1.281, 2.1.304)
- Codex **0.145, 0.156, 0.163, 0.164, 0.165** (measured: 0.145.0, 0.156.1, 0.163.0, 0.164.0, 0.165.0)

Codex 0.164.0's rollout is the 0.163.0 shape with one additive key (`content_item_metadata[].provenance` on
developer messages, which the writer neither needs nor emits), so the writer and `CONVERTER_VERSION` are
unchanged; its recorded fixture, the real-CLI `exec resume` contract and a by-hand TUI `codex resume` of a
converted conversation all pass.

Codex 0.165.0's rollout has exactly the 0.164.0 key set (it records three fewer `thread_settings_applied`
events, which the converter never reads), so again the writer and `CONVERTER_VERSION` are unchanged; its
recorded fixture and the real-CLI `exec resume` contract pass.

### A Codex outside the table: judged by the format it writes

Codex releases almost daily, and what the converter depends on is the **shape of its rollout**, not its
number. So a Codex version outside the table is not refused outright; it is classified by the records it
actually writes (`rollout-format.ts`, which lists the key paths the converter reads and writes):

- **Target side** — the first time a move targets such a binary, Ferretry runs it once (`codex exec`, one
  turn, a throwaway `CODEX_HOME`, the loopback model on 127.0.0.1, every proxy variable on a closed port,
  no login) and compares the rollout it leaves behind with the validated shape
  (`adapters/transcript/rollout-format-probe.ts`). The answer is remembered per binary path and version; a
  probe that could not run (timeout, the CLI refusing to start) is not remembered.
- **Source side** — a Codex rollout from an untested version is classified from its own text, with no probe.
- **Same shape** — the conversion proceeds, and the preview says so: "Codex X isn't one of the versions the
  converter was tested on; the conversation format it writes is unchanged from the one validated on Codex
  0.165." A key Codex _adds_ is not a difference; only a key the converter needs going missing is.
- **Different shape, or a probe that could not run** — refused, with the version table and what moved
  (`its response_item/message records no longer carry payload.role`).

This is the first line of defence, not the only one: the validation run above still resumes the converted
file in the real CLI before anything is moved. The shape check lets a harmless release through without a
pull request; the resume still proves the writer's output is accepted.

### Adding a harness version

1. Record its transcripts: `bun scripts/local/record-conversion-fixtures.ts --claude <path>` or
   `--codex <path>` (a scripted loopback model, throwaway homes, no network). They land in
   `packages/daemon/tests/fixtures/transcript/convert/`.
2. Add them to the round trips in `packages/daemon/tests/unit/transcript/convert.test.ts` and to `SOURCES`
   in `packages/daemon/tests/contract/conversion-acceptance.test.ts`, and run the contract suite against the
   new CLI (`packages/fleet/tests/contract/run.sh`, or the env it sets).
3. Resume a converted file in the new version's TUI once by hand.
4. Add the band in `versions.ts` and bump `CONVERTER_VERSION` if what the converter writes changed.

For Codex this is no longer urgent when the shape is unchanged: the format gate already lets the release
through (step 4 then just keeps the table, its fixtures and the "validated on" note current). It is needed
when the gate refuses with a changed shape, and the nightly report below is what says so.

### The nightly signal

The scheduled "Harness Contract (latest)" workflow runs the contract suite, including the conversion
acceptance, against the newest published `claude` and `codex`. A Codex outside the table passes there when
its format is the validated one, and fails when it is not. A failed scheduled run files one GitHub issue per
claude/codex version pair, labelled `harness-contract` (`scripts/ci/harness-contract-report.sh`), and later
nights' failures of the same pair are added to that issue as comments rather than as new issues.

## Where it lives

| Part                                             | File                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| Neutral conversation, readers, bounding, writers | `packages/daemon/src/lib/transcript/convert/`                                  |
| The move's plan and its ports                    | `packages/daemon/src/lib/migrate/conversation-convert.ts`                      |
| The validation run and the loopback model        | `packages/daemon/src/adapters/transcript/`                                     |
| The rollout shape the gate compares              | `packages/daemon/src/lib/transcript/convert/rollout-format.ts`                 |
| Wiring into migrate and the preview              | `packages/daemon/bin/fyd.ts` (`planConversion`, `convertRelaunchConversation`) |
| The preview route                                | `packages/daemon/src/lib/runtime/mounts/session-migrate.ts`                    |
| CLI                                              | `packages/cli/src/lib/migration/`                                              |
