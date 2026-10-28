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

The converter is **gated to the versions it was measured on** and refuses anything else, on either side,
in plain words (`packages/daemon/src/lib/transcript/convert/versions.ts`):

- Claude Code **2.1.2xx and 2.1.3xx** (measured: 2.1.281, 2.1.304)
- Codex **0.145, 0.156, 0.163, 0.164** (measured: 0.145.0, 0.156.1, 0.163.0, 0.164.0)

Codex 0.164.0's rollout is the 0.163.0 shape with one additive key (`content_item_metadata[].provenance` on
developer messages, which the writer neither needs nor emits), so the writer and `CONVERTER_VERSION` are
unchanged; its recorded fixture, the real-CLI `exec resume` contract and a by-hand TUI `codex resume` of a
converted conversation all pass.

### Adding a harness version

1. Record its transcripts: `bun scripts/local/record-conversion-fixtures.ts --claude <path>` or
   `--codex <path>` (a scripted loopback model, throwaway homes, no network). They land in
   `packages/daemon/tests/fixtures/transcript/convert/`.
2. Add them to the round trips in `packages/daemon/tests/unit/transcript/convert.test.ts` and to `SOURCES`
   in `packages/daemon/tests/contract/conversion-acceptance.test.ts`, and run the contract suite against the
   new CLI (`packages/fleet/tests/contract/run.sh`, or the env it sets).
3. Resume a converted file in the new version's TUI once by hand.
4. Add the band in `versions.ts` and bump `CONVERTER_VERSION` if what the converter writes changed.

## Where it lives

| Part                                             | File                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| Neutral conversation, readers, bounding, writers | `packages/daemon/src/lib/transcript/convert/`                                  |
| The move's plan and its ports                    | `packages/daemon/src/lib/migrate/conversation-convert.ts`                      |
| The validation run and the loopback model        | `packages/daemon/src/adapters/transcript/`                                     |
| Wiring into migrate and the preview              | `packages/daemon/bin/fyd.ts` (`planConversion`, `convertRelaunchConversation`) |
| The preview route                                | `packages/daemon/src/lib/runtime/mounts/session-migrate.ts`                    |
| CLI                                              | `packages/cli/src/lib/migration/`                                              |
