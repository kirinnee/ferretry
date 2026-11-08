# Session archive

A daemon keeps every session it ever ran, and nearly all of them are finished. **Automatic archiving is off by
default.** When enabled with a 24-hour age, finished autonomous sessions older than a day leave the live set: the
session store's index and the live ferret list (`GET /v1/ferrets`). They are archived, not deleted, and
`GET /v1/archived-sessions` lists them while the automatic pass is off too.

In 5.0 the saving is narrower than the name suggests: the ferret **registry** still holds every ferret's record, so
whatever walks the registry (the ancestry snapshot, the restart drain, the sweeps, the roster other plugins read through
Ferrets) still walks an archived ferret, as a stopped one. What the archive takes out is the session store's live index
and the live list. See **Declared gaps**.

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

A session that is revived, resumed, pinned, or written to for any reason comes back (below), so none of these is
decided once and for ever. (One that is only **forked from** is read, not written, so it stays archived: see **Declared
gaps**.)

## Where an archived session is

**Nothing moves.** The session's directory stays under `state/sessions/<id>/` with its documents, journal, agenda,
channel and media. The only new fact is one document, Ferrets' `archive.json` (`{ format: 1, sessions }`), written atomically: which ids
have left, when, the agent name each answered to, and the index row each had. Archiving in place was chosen over moving directories because every
subsystem that writes into a session directory (the agenda, the channel, the board's stamps) keeps working with no
second path to teach it, a crash can never strand half a move, and losing the registry only makes every session live
again at the next boot's reconcile — the safe direction.

An archived session is **out of**: the session store's index and the live ferret list, `GET /v1/ferrets` (a stopped ferret is in
exactly one of `GET /v1/ferrets` and `GET /v1/archived-sessions`; one whose record says it is running is listed live even
while the archive still names it, see **Coming back**). Nothing is deleted to do it: the list leaves out what the archive
document names for a stopped ferret, so a revival puts it back with no other write.

An archived session is **still in** the ferret registry (its record is untouched) and therefore in every walk of the
registry — see **Declared gaps**.

An archived session **still answers**:

- `GET /v1/ferrets/:id` (by id or by name), its transcript, journal replay and history — lazily, from disk. A read
  does not bring it back.
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
- **Session credentials** do not resolve for an archived session, because an archived ferret is a STOPPED one and a
  stopped ferret's token authenticates nobody (`bearers:ferret`). The archive itself cuts nothing: the token directory
  is not touched, and a resume issues the ferret a fresh credential.

## Coming back

A **write** brings an archived session back into the live set: an event appended, its state or config written or
updated. That covers resume, revive, send and any other path that writes the session's own documents.
**Adopting a live pane back into a ferret** (`attach`, the Ferrets port's way for another plugin to hand one over) is not
one of them: it writes only the ferret's registry record (`working`), and the session's documents follow the registry
afterwards, on their own lane. `GET /v1/ferrets` therefore does not wait for that write: it leaves out an archived ferret
only while its record says **stopped**, so a ferret that is starting, working or idle is always listed, whatever the
archive says. The live index row is rebuilt first, then the registry entry is removed. If rebuilding any session or
ancestor fails, archive membership stays available for retry. Retention also repairs a missing live row when the
session has no registry entry, so a retry can recover an incomplete restoration.

**Pinning an archived ferret also restores live membership** (`POST /v1/ferrets/:id/pin`), including its ancestors,
through the same idempotent storage revival path, after the pin is saved. The journal index is rebuilt, so the ferret
returns to `GET /v1/ferrets` without another session write. If revival fails after the pin was saved, the pin answers
the failure, and pinning the same ferret again retries the revival without rewriting the pin document.

**A card or an agenda item does NOT revive an archived ferret in 5.0**: Board and Agenda publish nothing Ferrets
hears when one is attached. A card still in flight and an open agenda item keep a ferret from being archived in the
first place (`session.archive-keeps`); one attached after it left the live set leaves it archived until a write or a
pin brings it back. A keep that appears while a pass is committing is caught by the pass's own re-check of the keep
signals (below), not by the publisher.

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
  during registry IO. That re-check, a write and a pin are the only revivals in 5.0 (Board and Agenda publish none).
- The registry is changed by a **read-modify-write inside its own queue**: the new map is derived from the registry as
  it is when the change's turn comes, then written durably, then published. A revival and an archive pass on different
  sessions therefore never overwrite one another's change.
  Reconciliation and full index rebuilds use that same lane after taking their document barrier, so neither can
  erase a live row between restoration and registry removal. Retention takes no document lanes and remains safe
  when a board publisher already holds them.
- Archiving **closes the file watches** held on the session's marker, config and state documents and recounts the
  cache and watch bound for the smaller live set. A later read of an archived session may watch again, within the bound.

## Seeing it

- `GET /v1/archived-sessions?limit=N` — `{ count, sessions }`: how many, and the newest `N` (default 100, at most 500)
  as ordinary session views. `limit=0` asks only the count. It is a separate route so an archived session can never
  slip into the hot live list. Like `GET /v1/ferrets`, it is not narrowed per caller (as today's route).
- `fy daemon status`, `GET /v1/health` and the app's "K older finished sessions archived" footer do not show the
  archive in 5.0 yet (declared below).

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
"keep live", never "archive". **Every answer is parsed** at the Ferrets boundary: Board's must be a list of exactly
`{ owner, assignee, dropped, category? }` with ferret ids (never callsigns) and a boolean `dropped`, Agenda's must be a
boolean, and an answer of any other shape, one that throws and one that does not come within 10 seconds all read as
"unreadable", which keeps every ferret it was asked about. The 10 seconds is one deadline for a WHOLE check (however many
ferrets it asks about), not one per question, and it also ends when the daemon stops the job: every ferret the check had
not yet heard about is kept, and the session lanes the commit-boundary check holds are released at that deadline. A contributed item that is not a keep source is refused by
the hook and counts as that half not answering. A ferret the daemon still holds as running is kept too, whatever its
state document says, and so is one whose registry record does not say `mode: auto`.

## Declared gaps

- **A ferret that stopped before it was stamped is kept.** A stop writes `finishedAt` on the ferret's state document, which
  is what its age is measured from; a ferret stopped by an earlier build has none, so its age is not known and it stays
  live (an ended session with no end time is always kept).
- **Switch and account sections are not compared.** `restart --outdated` and the per-ferret `outdated` mark on
  `GET /v1/ferrets` and `GET /v1/ferrets/:id` (`{ sections }`, kept 5 s, as today) compare the instruction entries a
  launch tells a ferret (the words, by fingerprint); a section a switch turns on (hypermedia, Pack, Agenda, Lessons) or an
  account's own variables are not. `GET /v1/restarts` asks afresh on every request, as today.
- **The registry still holds an archived ferret.** Its record stays (that is what keeps it reversible), so the
  registry-walking jobs (the ancestry snapshot, the restart drain, the sweeps) and the roster other plugins read through
  Ferrets still see it as a stopped ferret. Only `GET /v1/ferrets` and the session store's index leave it out.
- **Board and Agenda do not revive.** A card or an agenda item attached to an archived ferret does not bring it back
  (above); a write or a pin does.
- **Who answers is not checked.** The hook says which KIND of keep a contribution is, not which plugin sent it: the
  kernel names no contributor, so any plugin that contributes `kind: 'board'` counts as Board for "both have answered".
  It cannot remove the real Board's keeps (the answers are a union), but it can let passes run while the real Board is
  absent. Plugins are installed by the owner; binding a kind to a plugin needs the kernel to name the contributor.
- **No status surface.** `fy daemon status`, `GET /v1/health` and the app's archive footer do not count archived
  sessions yet; `GET /v1/archived-sessions` is the only reader.

- **Forking from an archived session** reads it and writes only the new one, so the source stays archived. It is
  still readable, which is all a fork needs.
- **A direct write into an archived session's files** (a hand edit or a channel append) does not revive it: it
  changes the files, not the live set. It does no harm — the session stays readable — and a session with an open
  agenda item is kept in the first place.
- **Opening an archived ferret** reads it through `GET /v1/ferrets/:id`, which writes nothing, so it stays archived;
  a resume, a message or any other write brings it back.
- **Scratch**: archiving reclaims none of a session's scratch files (snapshots, turn captures); whatever collects them
  does so on its own terms. They are the bulk of an archived session's directory, so they are the first thing to
  reclaim if disk matters.
- **No reclaim of the session's own weight**: archiving takes a session out of the live set. It does not delete
  directories, transcripts, worktrees or panes.
- **Memory**: the registry holds one small row per archived session in memory. It is a few hundred bytes each, against
  the full index (event pointers included) that it replaces.

## Where it is in the code

| Part                              | File                                                                 |
| --------------------------------- | -------------------------------------------------------------------- |
| The rule (pure)                   | `packages/core/ferrets/daemon/lib/session/archive/policy.ts`         |
| Keep signals                      | `.../archive/keeps.ts`, `.../archive/open-cards.ts`                  |
| The pass                          | `.../archive/service.ts`                                             |
| The registry document             | `.../archive/registry.ts`                                            |
| Archive, revive, fallback reads   | `packages/core/ferrets/daemon/adapters/storage/session-storage.ts`   |
| The session ports and the factory | `packages/core/ferrets/daemon/adapters/session/archive/`             |
| `GET /v1/archived-sessions`       | `packages/core/ferrets/daemon/lib/runtime/mounts/session-archive.ts` |
| The job, the answer parsing       | `packages/core/ferrets/daemon/modules/archive.ts`                    |
| The keep hook                     | `packages/core/ferrets/contract/hooks.ts` (`ArchiveKeeps`)           |
| The live list and the pin revival | `packages/core/ferrets/daemon/index.ts`                              |
