# Lessons

Ferretry learns from its ferrets. A **lesson** is one short rule about how the owner wants work done —
"Use bun, not Python, for scripts" — that the owner reviews and, if they agree, writes into an
instruction file every later ferret reads. This page is the contract; the code is the `lessons` plugin,
`packages/plugins/lessons/` (`contract/` is the wire, `daemon/lib/` the pure part, `daemon/adapters/` the
kernel-port adapters, `app/` the screens, `cli/` the `fy lesson` verbs).

## Two producers, one inbox

| Source      | How a lesson is made                                                                                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Passive** | A ferret that is instructed to learn runs `fy lesson suggest "<rule>" --scope global\|repo` (or the `lessons_suggest` tool) when the owner corrects it.                       |
| **Scan**    | The owner asks for an estimate, sees it, and starts a scan; a miner ferret reads older transcripts and proposes lessons whose every quote is verified against the transcript. |

Both land on the Lessons screen as **To review**. A lesson carries its **type** — **Global** (every
ferret) or **Repo** (that project's AGENTS.md / CLAUDE.md) — which the ferret or the miner picks and the
owner may change, its strength (how many times it was filed: `9×`) and its evidence.

## The passive switch

The **only** thing the passive switch controls is whether a ferret is _instructed_ to file lessons.

- `lessons.yaml` `passiveDefault` (default `true`) decides it for every NEW ferret; Settings › Lessons
  edits that choice. A miner or a warden is never instructed. The daemon keeps the owner's choice in its
  own state, which wins over the file (the config port is read-only; GAP).
- `PATCH /v1/ferrets/:ferretId/lessons {passive}` switches one ferret.
- The teaching is a per-ferret part of the launch, contributed through the `launch.parts` hook: Lessons
  answers the hook with the teaching when the ferret is instructed, and nothing otherwise.
- A ferret's launch is fixed once it runs, so switching a RUNNING ferret also sends it a queued message
  that does **not** interrupt it. Reading it costs the ferret one turn; the answer says so. A ferret that
  is not running learns the switch at its next launch, and nothing is sent.

## Filing a lesson can't be forged

`POST /v1/lessons/suggest` is admitted by Gate for a ferret's own credential. The call carries the rule
and the scope and nothing else: the daemon derives the ferret from the credential (`ferretOf`) and
attaches the evidence itself — the owner's latest message in that ferret's own transcript (read through
the Conversation contract) and the turn it was on (or, when the owner has said nothing yet, the rule
itself, marked as the ferret's). A ferret cannot file a lesson in another ferret's name or invent what the
owner said. A call with no ferret credential is refused (`403 forbidden`).

**Duplicates merge.** A filing whose meaningful words match an open lesson of the same type (and, for
Repo, the same project) adds its evidence and raises the count. The same ferret filing the same thing
again from the same message adds nothing. A rule the owner rejected is not filed again.

## Accept never writes; Apply is a separate act

Accept, Edit, Reject, a type change and Back to review change only the plugin's own board in its state
folder. **Apply** is the one write outside it, and it is guarded twice:

1. `GET /v1/lessons/proposals/:id/apply-preview` answers the exact unified diff, the target path, notes
   and an **etag** of the file as it is.
2. `POST /v1/lessons/proposals/:id/apply {etag}` writes exactly that change, only if the file still has
   that etag; otherwise `409 apply_conflict` and the owner looks at the new diff.

| Type   | Target                                                                                                                                              | Grant                                                        |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Global | the global lessons document, the `instructions/lessons` item (kept in the plugin's state; the first Apply creates it)                               | `fleet.configure`                                            |
| Repo   | the project root's `AGENTS.md` if present, else `CLAUDE.md` if present, else the one the ferret's CLI reads (Claude → CLAUDE.md, Codex → AGENTS.md) | `filesystem.configure`, and a remote device proves a passkey |

The lesson is appended as a bullet under a `## Lessons` heading (created when absent); nothing else in
the file moves. A ferret can never apply a lesson. The project root is the ferret's working folder's git
root. The Repo write goes through the `work` root handle.

## Scan

`POST /v1/lessons/scan/estimate` answers how many ferrets the scope selects, how many have no transcript
to read, how many fall beyond one scan's limit (`maxFerretsPerRun`), the tokens a miner would read and
write, and the equivalent cost — absent when the model is not priced, never a guess (Lessons holds no
price list of its own; GAP). It spends nothing. Scopes: ferrets without passive lessons (default), a date
range, projects, or specific ferrets.

`POST /v1/lessons/scan` starts it — only that request starts one, only a person asks for one, and one at a
time (`409 scan_running`). Each batch of `batchSize` ferrets gets one miner. `GET /v1/lessons/scan`
reports progress and folds in any miner that has finished (also on `turn.ended`);
`POST /v1/lessons/scan/cancel` stops the miners still running, and what already landed stays. Results
carry the **scan** source chip and the same Global/Repo type.

## Routes

| Route                                                                   | Who                                  |
| ----------------------------------------------------------------------- | ------------------------------------ |
| `GET /v1/lessons/status`, `config`, `proposals`, `ferrets`, `directory` | operator                             |
| `PATCH /v1/lessons/config`                                              | operator, `fleet.configure`          |
| `POST /v1/lessons/proposals/:id`                                        | operator                             |
| `GET /v1/lessons/proposals/:id/apply-preview`, `patch`                  | operator                             |
| `POST /v1/lessons/proposals/:id/apply`                                  | operator; the target's grant (above) |
| `PATCH /v1/ferrets/:ferretId/lessons`                                   | operator                             |
| `POST /v1/lessons/run`                                                  | operator                             |
| `POST /v1/lessons/scan/estimate`, `scan`, `cancel`                      | operator (a person)                  |
| `GET /v1/lessons/scan`                                                  | operator                             |
| `POST /v1/lessons/suggest`                                              | a ferret, by its own credential only |
