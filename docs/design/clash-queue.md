# Clashing work waits its turn

Status: **built** (owner decision taken: merge only) · Date: 2026-11-06 · Card: &I38 · Owner's Go on !A423, verbatim: _"make sure that features that
will conflcit gets "queued up", and add depends on on the board, and wait for that feature to be built before
merging."_

Paths are relative to `packages/daemon/` unless they start with `packages/`, `scripts/` or `docs/`.

## 0. The plan, in one screen

1. **A card says what it will touch with the claims it already has.** Every card has `files` (advisory claims,
   `fy task create --file <path>`, `fy task file <id> <path>`). Nothing new is stored.
2. **Two claims clash when one path is the other, or sits inside it.** `packages/daemon/` clashes with
   `packages/daemon/bin/fyd.ts`; `packages/daemon` does not clash with `packages/daemon-x`.
3. **The daemon adds the depends-on itself**, the moment a claim lands: the card that claimed LATER depends on
   every open card on the same board that already claims a clashing path (on the card whose PR ships that work,
   §2), `until: shipped`, with a history note that names the path. First come, first merged.
4. **Work still runs in parallel; only the merge waits** (the one owner decision, §6). The dependent card is
   built and reviewed as usual. Its PR does not merge until the card it waits on has merged.
5. **The merger checks the board.** A new read, `fy task merge-gate <pr-url>`, exits 0 when the cards the PR ships wait
   on nothing, 1 (with the blockers) when it does, 2 when it cannot tell. `merge-all.sh` merges only on 0. The patch is
   `/tmp/claude-1000/merge-all-clash-gate.patch`; the script itself is not edited here.

## 1. Declaring the area

Claims stay what they are: repo-relative paths on the card (`files`, max 256, each once). Two additions:

- **A path may name a folder.** `packages/pwa/src/features/board/` claims everything under it. A trailing `/`
  is allowed but not required; the match below is by path segments either way.
- **The card's holder may claim files.** Today only the lead can (`file` is not in `subFerretMay`). The ferret
  building the card knows best what it touches, so `file` joins `holderOnly`: a sub-ferret may claim and release
  files on a card it holds, like its status and How to test. The lead still claims at brief time.

Known hot files are claimed like any other file. `fy task file --help`, `fy task create --help` and
[board.md](../board.md#clashing-claims-queue-the-later-card) tell a lead to claim them when the work will touch them: `packages/daemon/bin/fyd.ts`, `knip.json`,
`packages/protocol/src/lib/daemon-features.ts`. The daemon does not guess claims a card did not make.

## 2. Detecting a clash

One pure function, `claimsClash(a, b)` in `src/lib/board/clash-queue.ts`:

- normalise each path segment by segment: drop empty and `.` segments, fold a `..` into the segment before it
  (one that would climb out of the repository is kept, so it matches only itself); `.` and `./` are the whole
  repository, which clashes with every path;
- clash when the paths are equal, or one starts with the other followed by `/`.

A card's claims **count** when it is on the same board and not dropped, and its shipping card (below) has not
shipped: `isBlockerDone(category, 'shipped', …)` is false. A shipping card on a board whose lanes the claim's read
does not hold (a lead on another board) counts too: dismissing it would hide a real clash, and a wait on a card that
did ship reads as done wherever its lanes are known. A backlog card counts: it claimed the area
first, and a lead who wants the other card first removes the dependency (§4).

**Shipping units** (`src/lib/board/shipping-unit.ts`, the ONE definition the queue and the gate share):

- A card **ships its own work** when it links a PR that is open, not polled yet, or merged. Otherwise it is PR-free
  (the test `isPrFreeHelper` closes a helper by, plus a just-linked PR): a helper, or an umbrella lead.
- Its **shipping card** is itself when it ships its own work or has no parent, else its parent's shipping card: a
  helper's work merges in its lead's PR. Waiting on the helper instead would end the wait when the helper closes (as
  soon as its ferret finishes), not when the work merges.
- A card **rides** its shipping card's unit; a PR-free card also rides the units of everything under it, because an
  umbrella lead's claims are touched by whichever child PR merges.
- Shipping cards that link a PR in common that is still in flight merge together, so they are **one unit** with one
  key (the first such card in store order). A merged or closed PR both kept from earlier says nothing about the next
  merge. Ancestry alone is not a unit: a child with its own PR is a separate merge from its lead's.
- Two cards are in the **same unit** when they ride a unit key in common.

**Who is waited on:** the clashing card's shipping card. A helper that already closed still counts while that shipping
card has not shipped.

Skipped, so the rule never deadlocks:

- the card itself, and any card in the same shipping unit (they merge together, and the gate would hold the PR on
  itself) — judged per clashing card before its shipping card is taken, so the store order never decides;
- a card it already depends on (no second entry), and a card it took out of its queue with `fy task undepend`
  (a re-claim does not put back what the lead removed on purpose);
- a card past the most dependencies a card may hold (128): noted, not added;
- a wait that would close a cycle, between cards (`dependencyCycle`) or between shipping units (one unit's PR already
  waits, through any card riding it, on this card's unit — two helpers of two PRs crossing their claims): the history
  notes the clash instead, so a lead still sees it. The waits a claim adds count for its next clash.

## 3. Who adds the depends-on, and when

The daemon, in the same card write as the claim (the `file` action, and `create` with `--file`). The claim and
its dependencies land together or not at all. The new history events carry the daemon as actor:

- `depended` on `&F18`, `until: shipped`;
- a note: `queued behind &F18 to merge: both claim packages/daemon/bin/fyd.ts. It can be built now; its PR merges
after &F18 ships.`

The authority rule "a ferret may add a dependency only from its own card" is not bent: the dependency is on the
claimer's own card, and the daemon writes it.

Releasing a claim (`fy task file --remove`) does not remove a dependency. Removing one is a deliberate act (§4).

## 4. What a lead sees

- **At claim time**, `fy task file` and `fy task create` print the daemon's note on stderr:
  `&F20 queued behind &F18 to merge: both claim knip.json. It can be built now; its PR merges after &F18 ships.`
- **On the board**, the card's existing `blockedBy` shows the wait, and `&F18`'s `blocks` shows the queue.
- **When the wait ends**, the existing notice arrives on the next message: `&F20 unblocked: &F18 merged`. The lead
  rebases the PR; the merger takes it on its next pass.
- **To jump the queue**, the lead runs `fy task undepend F20 F18 --reason "<why>"`, or the owner overrides it
  (`fy task depend --override`). Both are already there.

The existing rule still holds: a ferret cannot move a blocked card ON by hand. Facts (a PR opened, CI green) still
move it, so the card shows its real progress while it waits.

## 5. The merge gate

`fy task merge-gate <pr-url>` asks the daemon, `GET /v1/board/merge-gate?pr=<url>` (`src/lib/board/merge-gate.ts`),
which answers from ONE read of the board — paging through the board view could miss a card that moved between pages:

1. the PR's **merge unit**: every card not dropped that links it, and every card not dropped that rides one of those
   cards' shipping units (§2): a helper of a linking card, finished or not, and an umbrella lead above one;
2. the unit's **waits**, derived from the board as it is now, because units change after a claim lands (a card
   opens its PR, a helper finishes, a card is reparented) and the daemon's claim-time depends-on can go stale:
   - the **live clash order**: for every other unit whose claims clash with this unit's, the unit whose own cards
     claimed first (the last `file-claimed` of each path, else the card's creation) merges first. A card riding both
     units, an umbrella lead, sits out that pair. One rule decides both sides of every pair, so two PRs never wait
     on each other through it. A unit that shipped or was dropped holds nothing, and neither does an umbrella lead's
     own unit once it has child units (it never ships by itself; its claims count through them). A unit card that
     removed a wait on that unit's shipping card with `fy task undepend` waives it;
   - the **dependencies a person added**: each unfinished `blockedBy` of a unit card on a card outside the unit
     that does not link the same PR, except the daemon's own claim-time ones (their latest `depended` is the
     daemon's), which the live order stands in for;
3. the **unreadable** cards: quarantined cards could link the PR, so the gate cannot call it free.

The CLI exits **0** and prints nothing when there are no waits and nothing unreadable; **1** and
`&F20 waits on &F18 (until shipped)` per waiting card; **2** when the daemon cannot answer (down, or older than the
route), a card is unreadable, or the URL is not a PR. The merger treats 2 like 1: **it fails closed** and merges nothing it
cannot check.

The patch to `/tmp/claude-1000/merge-all.sh` adds one check after the approval check, and tells the lead once per
PR (the same `merge-conflict-told` pattern) that an approved PR is queued behind a card. **Apply it only after the
release carrying `fy task merge-gate` is installed**: on an older `fy` the command is unknown, which fails closed
and would hold every PR.

## 6. The owner decision

**Does a clash hold the START of the later card, or only its MERGE?**

- **Pick: only the merge.** Both cards are built at once; the later one merges after the first and rebases on it.
  Merge conflicts on shared files are cheap to fix after a rebase; idle ferrets are not.
- The other choice: the daemon also refuses to start a ferret on a card that waits (`Start` and `fy new --card`).
  That serialises the work, which is slower, but it means the later card is always written against the finished
  first one. It would be one extra check in `SessionCards.open`.

## 7. Gaps

- **Claims are advisory.** A card that touches a file it never claimed is not queued. The merger's existing
  `CONFLICTING` notice still catches the rest.
- **No race between two claims.** Dependency writes are already serialised board-wide (`DEPENDENCY_SECTION` in
  `service.ts`); a claim and a create with claims join that section, so two clashing claims cannot miss each other.
- **Another machine's cards** are not seen (the board's existing GAP).
- **A queued helper keeps waiting on its lead's shipping card** even if it later opens a PR of its own: the
  dependency was decided at claim time. Its lead removes it with `fy task undepend` when that matters.
- **A hand-made dependency can still cross two PRs into a cycle**, and so can one against the live clash order.
  The merger names both waits and the lead undepends one.
- **The board's depends-on is the claim-time view.** It is not rewritten when units change later; the gate's live
  order is what holds a merge. A wait the gate names with no depends-on behind it is waived by `fy task depend`
  then `fy task undepend`.
- **`fy task undepend` matches a dependency by id alone** (pre-existing, `card-actions.ts`): naming another
  machine's card with a local id removes the local one. The gate's waiver reads local refs only, so this cannot
  free a clash, but it is worth fixing on its own.
- **An umbrella lead's wait holds every child PR**, and a finished helper's wait holds its lead's next PR too: the
  board cannot tell which PR carried a helper's work, so it keeps the wait until the blocker ships.
- **One unreadable card holds every PR.** Fail closed is the point; the merger's note names the card.

## 8. The build (one PR)

- `src/lib/board/shipping-unit.ts`: `ShippingUnits` (pure), the one definition of what merges together.
- `src/lib/board/clash-queue.ts`: `claimsClash`, `planClashes` (with the unit cycle check), `queueBehindClashes`.
- `src/lib/board/merge-gate.ts`: `mergeGateOf` (pure); `BoardService.mergeGate` and the `GET /v1/board/merge-gate`
  route (`runtime/mounts/board.ts`); `BoardMergeGateResponseSchema` in `packages/protocol`.
- `src/lib/board/card-actions.ts`: the `file` action queues; `service.ts`: a claim runs in the dependency section,
  a create with claims re-reads the board in it and queues, and `file` joins `holderOnly`.
- `packages/cli`: `fy task merge-gate` (`lib/board/merge-gate.ts`, `adapters/board/fy-merge-gate-gateway.ts`), and
  `file`/`create` print the queue notes (`lib/board/clash-notes.ts`).
- `docs/board.md` § Clashing claims queue the later card; this doc; the merge-all patch (outside the repo).
- Not changed: the ferrets' Board rules line. Its size is pinned by the system-prompt budget tests; the help
  texts and board.md carry the rule instead.
- Tests: `packages/daemon/tests/unit/board/{clash-queue,merge-gate}.test.ts`, the route in
  `tests/unit/runtime/mounts/board.test.ts`, and `packages/cli/tests/unit/board/clash-queue.test.ts`.
