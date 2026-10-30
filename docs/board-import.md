# Importing the old per-session task files into the project boards

The v1 task store kept one `tasks.json` per session. The project boards (one board per project, cards are
`BoardTask`s) replace it. This import moves what is in those files onto the boards. It is one-time, idempotent and
read-only on the old files.

## What it does

For every `<state home>/sessions/<id>/tasks.json`:

- **Card:** one card per old task, with a new machine id and `legacyRef: '<sessionId>:<oldId>'`. A task whose
  `legacyRef` already has a card is left exactly as it is, so re-running only fills in what is missing.
- **History:** the old activity is mapped to board events, then one final `migrated` event is added.
- **People:** the owner is the session. The assignee is the old assignee when it names exactly one session, else
  the owner, with the old string kept in a note.
- **Lane:** chosen by lane _category_ from the project's lane set (`todo` backlog; `researched`/`designed` first
  active lane; `in_progress` the implement lane; `built` review when a PR is linked, else implement; `live`
  shipped; `done` closed; `dropped` dropped). A lane set missing a category falls back to the nearest one.
- **Blocked:** a reason naming another task becomes a `dependsOn`; a reason about the owner becomes a blocking
  agenda link when the session has open agenda items and exactly one owner-blocked card; anything else is an
  external `blocked`. When unsure: external.
- **Projects with no lane set:** an inferred template is proposed, UNCONFIRMED, with one agenda choice for the
  owner. A repository with `v*` tags gets `pr-release-verify`, a repository without gets `pr`, a folder with no
  repository gets `quick` (`inferLaneTemplate`).
- **Agenda items:** open items that name no card get one: the single owner-blocked card, else the session's single
  in-progress card, else an auto-created "Untriaged asks" card for that session.

A bad file or a task that cannot become a card is skipped and reported in the summary. The import never fails
daemon start and never writes to the old `tasks.json`.

## How it runs

- **At daemon start**, about two seconds after boot, once. The marker `<home>/board-import.json` records the run;
  while it exists the boot import is a no-op. The marker is withheld when something transient failed (the store
  or an agenda would not answer), so the next start retries.
- **By hand**, `fy board import [--dry-run] [--json]`. A hand run ignores the marker. `--dry-run` counts what would
  happen and changes nothing: no card, no lane proposal, no agenda link, no marker.
- **Wire:** `POST /v1/board/import` with `{ "dryRun": boolean }` answers `BoardImportSummary`
  (`packages/protocol/src/lib/board-import.ts`). Owner only: a ferret gets 403.

## Finding the card an old reference became

`GET /v1/board/tasks?legacyRef=<session>:<oldId>` answers the card, or 404. The old id may carry a sigil and any
case (`abc123:&f12`). A malformed value is 400. Rendering old `&F12` references with this lookup is the PWA's job.
