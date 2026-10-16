# Lessons

Ferretry learns from its ferrets. A **lesson** is one short rule about how the owner wants work done —
"Use bun, not Python, for scripts" — that the owner reviews and, if they agree, writes into an
instruction file every later ferret reads. This page is the contract; the code is
`packages/daemon/src/lib/learning/` (pure), `packages/daemon/src/lib/runtime/mounts/learning.ts` (routes),
`packages/daemon/src/adapters/learning/` and `packages/protocol/src/lib/{learning,agent-tools-lessons}.ts`.

## Two producers, one inbox

| Source      | How a lesson is made                                                                                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Passive** | A ferret that is instructed to learn runs `fy lesson suggest "<rule>" --scope global\|repo` (or the `lessons_suggest` MCP tool) when the owner corrects it.                 |
| **Scan**    | The owner asks for an estimate, sees it, and starts a scan; a miner ferret reads older transcripts and proposes lessons whose every quote is verified against the transcript. |

Both land in the Learning hub (Insights › Learning) as **To review**. A lesson carries its **type** —
**Global** (every ferret) or **Repo** (that project's AGENTS.md / CLAUDE.md) — which the ferret or the miner
picks and the owner may change, its strength (how many times it was filed: `9×`) and its evidence.

## The passive switch

The **only** thing the passive switch controls is whether a ferret is _instructed_ to file lessons.

- `learning.yaml` `passiveDefault` (default `true`) decides it for every NEW ferret; Settings › Learning
  edits that key. A miner or a warden is never instructed.
- `PATCH /v1/sessions/:sessionId/learning {passive}` switches one ferret.
- The teaching rides the fixed layer's tools server, not a launch argument, because one runtime wrapper
  serves many ferrets. The daemon writes `FY_LEARNING_PASSIVE=1` (or `0`) into the ferret's launch
  environment and `fy mcp serve` adds the teaching to its MCP `initialize` instructions when it is `1`.
- A ferret's environment is fixed once it runs, so switching a RUNNING ferret also sends it a queued
  message that does **not** interrupt it. Reading it costs the ferret one turn; the answer says so. A
  ferret that is not running learns the switch at its next launch, and nothing is sent.

## Filing a lesson can't be forged

`POST /v1/agent/lessons` is authenticated by the session credential alone and served only over a
privileged loopback carrier. The call carries the rule and the scope and nothing else: the daemon derives
the session from the credential and attaches the evidence itself — the owner's latest message in that
session's own transcript and the turn it was on (or, when the owner has said nothing yet, the rule itself,
marked as the ferret's). A ferret cannot file a lesson in another ferret's name or invent what the owner
said.

**Duplicates merge.** A filing whose meaningful words match an open lesson of the same type (and, for Repo,
the same project) adds its evidence and raises the count. The same session filing the same thing again from
the same message adds nothing. A rule the owner rejected is not filed again.

## Accept never writes; Apply is a separate act

Accept, Edit, Reject, a type change and Back to review change only the daemon's own board under
`<state>/learning/`. **Apply** is the one write outside the state home, and it is guarded twice:

1. `GET /v1/learning/proposals/:id/apply-preview` answers the exact unified diff, the target path, notes
   (for example that no profile includes the global component yet) and an **etag** of the file as it is.
2. `POST /v1/learning/proposals/:id/apply {etag}` writes exactly that change, only if the file still has
   that etag; otherwise `409 apply_conflict` and the owner looks at the new diff.

| Type   | Target                                                                                                                                     | Grant                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Global | the fleet's `instructions/lessons` component: `<FY_HOME>/fleet/assets/instructions/lessons.md` (the component file is created on first use) | `fleet.configure`                                               |
| Repo   | the project root's `AGENTS.md` if present, else `CLAUDE.md` if present, else the one the ferret's CLI reads (Claude → CLAUDE.md, Codex → AGENTS.md) | `filesystem.configure`, and a remote device proves a passkey |

The lesson is appended as a bullet under a `## Lessons` heading (created when absent); nothing else in the
file moves. A ferret can never apply a lesson. The project root is the session's working folder's git root.

## Scan

`POST /v1/learning/scan/estimate` answers how many ferrets the scope selects, how many have no transcript to
read, how many fall beyond one scan's limit (`maxSessionsPerRun`), the tokens a miner would read and write,
and the equivalent cost from the operator's own price list — absent when the model is not priced, never a
guess. It spends nothing. Scopes: ferrets without passive learning (default), a date range, projects, or
specific ferrets.

`POST /v1/learning/scan` starts it — only that request starts one, and one at a time (`409 scan_running`).
Each batch of `batchSize` ferrets gets one miner. `GET /v1/learning/scan` reports progress and folds in any
miner that has finished; `POST /v1/learning/scan/cancel` stops the miners still running, and what already
landed stays. Results carry the **scan** source chip and the same Global/Repo type.

## Routes

| Route                                                | Who                                       |
| ---------------------------------------------------- | ----------------------------------------- |
| `GET /v1/learning/status`, `config`, `proposals`     | operator                                  |
| `PATCH /v1/learning/config`                          | operator, `fleet.configure`               |
| `POST /v1/learning/proposals/:id`                    | operator                                  |
| `GET /v1/learning/proposals/:id/apply-preview`       | operator                                  |
| `POST /v1/learning/proposals/:id/apply`              | operator; the target's grant (above)      |
| `GET /v1/learning/sessions`                          | operator                                  |
| `PATCH /v1/sessions/:sessionId/learning`             | operator                                  |
| `POST /v1/learning/scan/estimate`, `scan`, `cancel`  | operator                                  |
| `GET /v1/learning/scan`                              | operator                                  |
| `POST /v1/agent/lessons`                             | a ferret, by its session credential only  |
