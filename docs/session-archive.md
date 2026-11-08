# Session archive

A daemon keeps every session it ever ran, and nearly all of them are finished. Dozens of jobs walk the whole set on
every tick — the sweeps, the watchers, the session list the app polls, the board's roster — so the cost of a finished
session never stopped. **Automatic archiving is off by default.** When enabled with a 24-hour age, finished autonomous
sessions older than a day leave the live set. They are archived, not deleted. Archive routes, revival, `fy` commands
and the app's archive footer remain available while the automatic pass is off.

## What it does

- A session is archived when **all** of these hold:
  1. It is **autonomous** — `mode: auto`, the same fact the app's Agents filter uses. A session a person drove
     (`mode: interactive`) is never touched, whatever its age.
  2. It has **ended** (`completed`, `failed`, `stalled` or `stopped`) and records when (`finishedAt`). An ended
     session with no end time is kept: its age is not known.
  3. It ended **at least 24 hours ago**.
  4. Nothing outside it keeps it (below).
  5. Every session that names it as `parent` is itself archived or archivable in the same pass. A lead outlives its
     sub-ferrets in the live set.
- **When unsure, it keeps the session.** A session whose documents cannot be read, and a keep signal that cannot be
  read, both keep it.
- **Unknown is never "no parent".** A live session whose config cannot be read, or whose `parent` means nothing, has an
  _unknown lineage_: whose child it is cannot be said, so any lead might be its lead. While one remains live,
  the pass archives nothing, even if its state says it ended long ago. Recovering its lineage allows a later pass.

## What keeps a session live

| Signal                          | Source                                                                      |
| ------------------------------- | --------------------------------------------------------------------------- |
| Pinned by the owner             | the agent pins                                                              |
| Owns or is assigned a live card | the board: not dropped, lane not `closed` or `shipped`; unknown lane = live |
| An open agenda item             | the session's own agenda board                                              |
| A live child, in any form       | the rule itself (5 above)                                                   |

A session that is revived, resumed, forked from, or written to for any reason comes back (below), so none of these is
decided once and for ever.

## Where an archived session is

**Nothing moves.** The session's directory stays under `state/sessions/<id>/` with its documents, journal, agenda,
channel and media. The only new fact is one document, `state/archived-sessions.json`, written atomically: which ids
have left, when, the agent name each answered to, and the index row each had. Archiving in place was chosen over moving directories because every
subsystem that writes into a session directory (the agenda, the channel, the board's stamps) keeps working with no
second path to teach it, a crash can never strand half a move, and losing the registry only makes every session live
again at the next boot's reconcile — the safe direction.

An archived session is **out of**: the session index (memory and SQLite), `GET /v1/sessions`, the sessions-directory
walks (reconcile, rebuild, survey, permission repair, legacy upgrade), the fleet sweeps and the board's roster.

An archived session **still answers**:

- `GET /v1/sessions/:id`, its transcript, journal replay and `fy` history — lazily, from disk. A read does not bring
  it back.
- Task-card links and the app's "open session": they name the id, and the id resolves.
- `findSession`: an archived id is a session that exists, so references to it (a card's owner, an agenda owner) do not
  go stale.
- A name: the registry keeps each session's agent name, so `fy history <name>` finds it and `fy send <name>` resumes it,
  as they did when it was live, with no read of its documents.

## What the archive deliberately still honours

Three facts were derived from the live list, and would have changed silently when a session left it:

- **Callsigns.** A name is held for five days after its session ends. The registry keeps the configuration times that
  hold is measured from, so an archived session keeps its name for the same five days and `fy send <name>` never meets
  a second session of that name.
- **Analytics.** Ingestion forgets a stored row whose session is not in its candidate list. Archived sessions are named to
  it, so the rows ingested when they ended stay; one that was never ingested (the store was rebuilt) is read on demand.
- **Session credentials** stop resolving for an archived session. It ended more than a day ago, so nothing can use one
  legitimately, and a revive launches the session afresh.

## Coming back

A **write** brings an archived session back into the live set: an event appended, its state or config written or
updated. That covers resume, revive, send and any other path that changes it — they all write through the
same storage. The live index row is rebuilt first, then the registry entry is removed. If rebuilding any session or
ancestor fails, archive membership stays available for retry. Retention also repairs a missing live row when the
session has no registry entry, so a retry can recover an incomplete restoration.

**Attaching a pin, a card still in progress, or an agenda item also restores live membership**, including the
session's ancestors. Each publisher uses the same idempotent storage revival path after its own write. The journal
index is rebuilt, so the session returns to the default list without another session write. A keep published during
an archive's verification or registry IO cancels that commit; one published after the commit revives it.
If pin retention fails after the pin was saved, pinning that same session again retries retention without rewriting
the pin document or changing its place or time.

## When it runs

The following schedule runs only after explicitly enabling the automatic pass (see **Setting**). The owner plans to
enable it on **2026-11-07**, after a clean day; that is a rollout plan, not a scheduled or automatic activation.

- **One kernel job**, `ferrets.archive-pass`, ticks every 60 seconds and runs a pass only when one is **due**: at once the
  first time, an hour after a pass that finished everything, and an hour after a pass that failed (every session it did not
  finish stays live). There is no dynamic timer: a pass can never be overtaken by its own next tick, and a tick that is
  not due reads nothing.
- **Bounded**: at most 200 sessions a pass. A pass that left qualifying sessions behind is followed one tick (a minute) later, not
  an hour later, so a first run over two thousand sessions finishes in a few passes without holding the event loop.
- Documents are read paced (25 at a time, the loop handed back between batches) and through the storage's document
  cache. The registry is normally written once per pass; a canceled commit or late revival writes its correction.
- Archiving holds the lineage root gates and sessions' lanes and re-reads each one as it is **now** before it goes, so a session revived
  between the decision and the act stays live.
- That check is of the **whole group**, not of each session alone. At the commit boundary the roster is rebuilt (the
  whole current live roster, every configuration read afresh in paced batches) and the keep signals are asked again; a lead
  goes only when every session naming it as lead has gone before it in the same commit. A child that revived, or was
  started, between the decision and the locks keeps its lead live; a pin, card or agenda item that appeared meanwhile
  keeps its session live. Every config write and the commit share one keyed gate per current lineage root: a writer
  already publishing finishes before verification; a writer queued behind the commit restores archived membership
  through the normal write path. Unrelated roots do not wait for each other. Child creation retains its lead and
  lets the config writer take the gate, so nested config writes never wait on a creation gate they already hold.
- **Reparenting has one revive-after window.** A config write holds only its current root gate. If publication changes
  its parent, it releases that gate and then retains the new parent and its ancestors through the ordinary keep path.
  A new parent archived during that window is immediately restored before the config write returns. Two roots are
  never held by a config writer at once, avoiding a lock-order cycle between opposite reparentings.
  A failed post-write config proof or parent restoration returns an error saying the config is already committed.
  Retrying the same write repairs any archived session in its parent's lineage, even when the parent is unchanged.
- A queued config writer or commit rechecks its root after acquiring the gate. If another write moved it, it releases
  the stale gate and queues again. Four unsuccessful acquisitions stop with an explicit retry error; a later archive
  pass can retry, so continual reparenting cannot trap a pass in a retry loop.
- The keep signals are also checked after the commit, with no document lanes held, to reconcile a signal that landed
  during registry IO. Normal signal publishers revive on publication, even when no archive pass is running.
- The registry is changed by a **read-modify-write inside its own queue**: the new map is derived from the registry as
  it is when the change's turn comes, then written durably, then published. A revival and an archive pass on different
  sessions therefore never overwrite one another's change.
  Reconciliation and full index rebuilds use that same lane after taking their document barrier, so neither can
  erase a live row between restoration and registry removal. Retention takes no document lanes and remains safe
  when a board publisher already holds them.
- Archiving **closes the file watches** held on the session's marker, config and state documents and recounts the
  cache and watch bound for the smaller live set. A later read of an archived session may watch again, within the bound.

## Seeing it

- `fy daemon status` — `sessions 622 live (31 running, 0 unmonitored), 1796 archived`.
- `GET /v1/health` — `archivedSessions`.
- The app's session list ends with "**K older finished sessions archived**" and a way to show them.
- `GET /v1/archived-sessions?limit=N` — `{ count, sessions }`: how many, and the newest `N` (default 100, at most 500)
  as ordinary session views. `limit=0` asks only the count. It is a separate route so an archived session can never
  slip into the hot live list.

## Setting

One file, `config/archive.yaml` (the app and `fy config` edit it like any other config file):

```yaml
afterHours: 24
```

| Value           | Meaning                                                                                 |
| --------------- | --------------------------------------------------------------------------------------- |
| `afterHours: N` | Whole hours (1 or more) a finished autonomous ferret stays live; `24` is the daily age. |
| absent, `off`   | **Default off**: no pass runs; existing archives remain readable and revivable.         |

It is read at every tick of the archive job, so an edit takes effect within a minute, and a bad value is refused by the
config writer (the last good file stays in effect). No edit of it widens authority or spend, so none is held for the owner.
It replaces the `FYD_SESSION_ARCHIVE_AFTER_HOURS` variable: no plugin reads the environment.

**Board and Agenda must both have answered.** A pass runs only while Board (which ferrets own or hold a card still in
flight) and Agenda (which ferrets have an open agenda item) have each contributed their half of the `session.archive-keeps`
hook. While either is missing no pass runs, and a half that fails keeps every ferret it was asked about: an absent answer is
"keep live", never "archive". A ferret the daemon still holds as running is kept too, whatever its state document says.

## Declared gaps

- **A ferret that stopped before it was stamped is kept.** A stop writes `finishedAt` on the ferret's state document, which
  is what its age is measured from; a ferret stopped by an earlier build has none, so its age is not known and it stays
  live (an ended session with no end time is always kept).
- **Switch and account sections are not compared.** `restart --outdated` compares the instruction entries a launch tells a
  ferret (the words, by fingerprint); a section a switch turns on (hypermedia, Pack, Agenda, Lessons) or an account's own
  variables are not, and the per-ferret `outdated` mark on the list is not served: read it from `GET /v1/restarts`.

- **Forking from an archived session** reads it and writes only the new one, so the source stays archived. It is
  still readable, which is all a fork needs.
- **A direct write into an archived session's files** (a hand edit or a channel append) does not revive it: it
  changes the files, not the live set. It does no harm — the session stays readable — and a session with an open
  agenda item is kept in the first place.
- **Opening an archived session in the app** reads its documents through `GET /v1/sessions/:id`, whose transcript
  projection may write a document if the transcript moved; that write revives it.
- **Scratch**: the scratch collector walks the live list, with the same 24-hour age as the archive. A session archived
  before the collector's sweep reached it keeps its small scratch files (snapshots, turn captures) until a write revives
  it. They are the bulk of an archived session's directory, so they are the first thing to reclaim if disk matters.
- **No reclaim of the session's own weight**: archiving takes a session out of the live set. It does not delete
  directories, transcripts, worktrees or panes.
- **Memory**: the registry holds one small row per archived session in memory. It is a few hundred bytes each, against
  the full index (event pointers included) that it replaces.

## Where it is in the code

| Part                              | File                                                               |
| --------------------------------- | ------------------------------------------------------------------ |
| The rule (pure)                   | `packages/daemon/src/lib/session/archive/policy.ts`                |
| Keep signals                      | `.../archive/keeps.ts`, `.../archive/open-cards.ts`                |
| The pass                          | `.../archive/service.ts`                                           |
| The registry document             | `.../archive/registry.ts`                                          |
| Archive, revive, fallback reads   | `packages/daemon/src/adapters/storage/session-storage.ts`          |
| The session ports and the factory | `packages/daemon/src/adapters/session/archive/`                    |
| `GET /v1/archived-sessions`       | `packages/daemon/src/lib/runtime/mounts/session-archive.ts`        |
| The job and the keep hook         | `packages/core/ferrets/daemon/modules/archive.ts` (`ArchiveKeeps`) |
