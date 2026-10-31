# Work search

One search over every **board card** and every **agenda item**, across all projects and sessions. The PWA
finder, `fy search`, the `search_work` agent tool and the related check that `fy task create` and
`fy agenda add` run before filing all ask the same daemon index, so they agree on what matches and what
counts as a duplicate.

The contract is `packages/protocol/src/lib/work-search.ts`. The daemon side is
`packages/daemon/src/lib/work-search/`, served by `lib/runtime/mounts/work-search.ts`.

## Routes

| Route                     | Does                                                                    |
| ------------------------- | ----------------------------------------------------------------------- |
| `GET /v1/search`          | `q`, optional `kind` (`task`/`agenda`), `open=true`, `project`, `limit` |
| `POST /v1/search/related` | `{kind, title, ask?}` → up to 5 matches, each `strong` or `weak`        |

Both have **the board's grants**: `operator` minimum plus the `fleet` capability for a caller off this host
([grants.md](grants.md)). A paired device the owner keeps off the fleet gets `403` from both. A shared-catalog
member's session never reaches this route table at all. Both answers are `no-store` and are never compressed.
The related check is a `POST` only because a title and an ask do not fit in a URL. It reads and changes
nothing.

Daemons that have these routes report `work.search.1` in `GET /v1/health` features. Against an older daemon,
the app keeps searching only what it has already loaded, and the CLI files without the check.

A hit carries:

- `kind`, `id` and `sessionId`. An agenda id such as `A3` is unique only within its session.
- `title`.
- `state`: `open`, `closed` or `dropped`.
- `standing`: the lane's name, or the item's `open` / `snoozed` / `replied` / `in discussion` / `needs info` /
  `addressed` / `dismissed`.
- `projectId`, for cards only.
- `updatedAt`.
- `match`: the field that matched and the one line it matched on.

A hit never carries the whole card or item. Reading it is the job of that card's or item's own route.

## What is indexed

The fields are a **whitelist**. A field added to a schema later is not searchable until
`lib/work-search/documents.ts` names it.

- **Card:** id, title, summary, ask and clarifications, premise, context, brief, how to test, and the text
  of its notes.
- **Agenda item:** id, title, the ask line, premise, context, and its body. The body is made of why, how to
  resolve, decided, still open, impact, the recommendation and the questions. Also indexed: its history
  notes, and once it is addressed, the resolution note and the owner's worded answer.
- **Plain notifications** (`fy notify`) are not agenda items and are not indexed.
- **An input request's card** carries its label. Values are never stored anywhere.

**Window:** all open work, plus work closed, dropped or addressed within the last 30 days.

**Secrets.** Every text passes the daemon's secret redactor (vault values and saved-login values) before it
enters the index, and every answer is scrubbed again on the way out. The index rebuilds itself when the vault
or the saved-login file changes, so text containing a newly registered secret value stops being findable by
that value on the next search.

**Declared gap:** values the daemon has only just typed into a terminal (`EphemeralValues`) are masked only in
answers and in text indexed while they are held. Text written before then keeps its words in the index. Those
words never reach an answer unscrubbed while the value is held.

## Matching and ranking

A token is a run of letters or digits, lower-cased, with accents removed and a plural `s` dropped. Queries
are ranked in this order:

1. **An exact id** wins: `F303`, `&F303`, `#F303`, `A3`, `!A3`.
2. **Every word must match somewhere.** The last word matches as a prefix, so a half-typed word already finds
   results. A word scores by the best field it appears in: title, then summary and ask, then premise and
   context, then everything else. The whole query found as a phrase in a title scores extra.
3. **Open work and recent work are lifted.** Open work scores ×1.25. Recency adds up to 50%, with a 14-day
   half-life.

## The related check

The check scores a new title and ask against each card and item in two ways. Each shared word counts by how
rare it is across the index.

- **Title similarity** is weighted Jaccard between the two titles: the share of both titles' words they have
  in common.
- **Body similarity** is cosine similarity between the new title plus ask and the document's title, summary
  and ask.

A match is `strong` when either is true:

- the titles are the same, or title similarity is at least 0.6;
- body similarity is at least 0.45 and title similarity is at least 0.25.

Otherwise it is `weak` if title similarity is at least 0.3 or body similarity is at least 0.25.

Closed work is at most `weak`, because a near copy of finished work is more often a follow-up than a mistake.

These thresholds were tuned on a real board of about 480 cards and 290 agenda items. On that board the check
flags pairs like "Agenda focus view" and "Agenda item focus view", or "Phone scroll and header" and "Phone
Scroll Header Broken". A long ask that only mentions a short title's words stays `weak`.

## Freshness

The files are the truth. The index is an in-memory copy that is rebuilt at every boot and built about 5 s
after boot, away from the boot's own reads.

| Change                          | How the index sees it                                                                                                                                                                                                                                                                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A card written by the daemon    | On every search, the service checks each card in the board store's in-memory list. A card whose object changed is re-indexed. This is a pointer comparison with no I/O.                                                                                                                                                                             |
| A card file edited by hand      | The board store watches `board/tasks/` and re-reads files whose identity moved. A file that no longer parses is quarantined, as at boot. A removed file leaves the board. Search then sees the new object. A daemon write checks the file first (one stat), so it is decided on a hand edit the watch has not reported yet and never overwrites it. |
| An agenda change                | Committed changes reach the agenda change fan-out, and the next search re-reads that session's ledger first.                                                                                                                                                                                                                                        |
| An agenda ledger edited by hand | Every 5 s, a search starts a background sweep of every ledger. The ledger repository answers it from its cache, which it checks against each file's identity. The edit is found within one sweep.                                                                                                                                                   |
| A lane renamed or recategorized | The same sweep re-reads lane sets and re-indexes that board's cards.                                                                                                                                                                                                                                                                                |
| A new secret                    | The vault's identity changes. The next search rebuilds the whole index before it answers.                                                                                                                                                                                                                                                           |

**Known limits.**

- An editor that truncates a file and then writes it can be caught half-saved. The card is quarantined, and writes to it are refused, until the finished save is read moments later.
- A sweep checks every session's ledger: one directory listing and at least one stat per session, every 5 s while anyone is searching. Past the ledger cache's 2,048 sessions, each sweep re-parses every ledger. At this machine's ~880 sessions that is well inside the budget. Sweeping only recently changed ledgers is the next step if it is not.

## Budget

On a synthetic 2,000-card plus 500-item index, the p95 for a mixed search must stay under **30 ms**
(`tests/unit/work-search/service.test.ts`). On this machine's real data (about 480 cards and 290 items), a full
build takes about 230 ms. A search takes about 7 ms at p95 and a related check about 9 ms.
