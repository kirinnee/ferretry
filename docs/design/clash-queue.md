# Clashing work waits its turn

Status: **plan** · Date: 2026-11-06 · Card: &I38 · Owner's Go on !A423, verbatim: _"make sure that features that
will conflcit gets "queued up", and add depends on on the board, and wait for that feature to be built before
merging."_

Paths are relative to `packages/daemon/` unless they start with `packages/`, `scripts/` or `docs/`.

## 0. The plan, in one screen

1. **A card says what it will touch with the claims it already has.** Every card has `files` (advisory claims,
   `fy task create --file <path>`, `fy task file <id> <path>`). Nothing new is stored.
2. **Two claims clash when one path is the other, or sits inside it.** `packages/daemon/` clashes with
   `packages/daemon/bin/fyd.ts`; `packages/daemon` does not clash with `packages/daemon-x`.
3. **The daemon adds the depends-on itself**, the moment a claim lands: the card that claimed LATER depends on
   every open card on the same board that already claims a clashing path, `until: shipped`, with a history note
   that names the path. First come, first merged.
4. **Work still runs in parallel; only the merge waits** (the one owner decision, §6). The dependent card is
   built and reviewed as usual. Its PR does not merge until the card it waits on has merged.
5. **The merger checks the board.** A new read, `fy task merge-gate <pr-url>`, exits 0 when the PR's card waits
   on nothing and 1 (with the blockers) when it does. `merge-all.sh` skips a PR that answers 1. The patch is
   `/tmp/claude-1000/merge-all-clash-gate.patch`; the script itself is not edited here.

## 1. Declaring the area

Claims stay what they are: repo-relative paths on the card (`files`, max 256, each once). Two additions:

- **A path may name a folder.** `packages/pwa/src/features/board/` claims everything under it. A trailing `/`
  is allowed but not required; the match below is by path segments either way.
- **The card's holder may claim files.** Today only the lead can (`file` is not in `subFerretMay`). The ferret
  building the card knows best what it touches, so `file` joins `holderOnly`: a sub-ferret may claim and release
  files on a card it holds, like its status and How to test. The lead still claims at brief time.

Known hot files are claimed like any other file. The brief text and the Board rules line tell a lead to claim
them when the work will touch them: `packages/daemon/bin/fyd.ts`, `knip.json`,
`packages/protocol/src/lib/daemon-features.ts`. The daemon does not guess claims a card did not make.

## 2. Detecting a clash

One pure function, `claimsClash(a, b)` in `src/lib/board/claims.ts`:

- normalise each path: drop a leading `./`, a trailing `/`, and repeated `/`;
- clash when the paths are equal, or one starts with the other followed by `/`.

A card is **in the queue** (can hold another card back) when it is on the same board, is not dropped, and its
work has not shipped: `isBlockerDone(category, 'shipped', …)` is false. A backlog card counts: it claimed the area
first, and a lead who wants the other card first removes the dependency (§4).

Skipped, so the rule never deadlocks:

- the card itself, its ancestors and its descendants (a sub-card overlaps its lead's claims by design, and the
  lead ships through it);
- a card it already depends on (no second entry);
- a card whose dependency on it would close a cycle (`dependencyCycle`): the history notes the clash instead, so a
  lead still sees it.

## 3. Who adds the depends-on, and when

The daemon, in the same card write as the claim (the `file` action, and `create` with `--file`). The claim and
its dependencies land together or not at all. The new history events carry the daemon as actor:

- `depended` on `&F18`, `until: shipped`;
- a note: `waits on &F18 to merge: both claim packages/daemon/bin/fyd.ts`.

The authority rule "a ferret may add a dependency only from its own card" is not bent: the dependency is on the
claimer's own card, and the daemon writes it.

Releasing a claim (`fy task file --release`) does not remove a dependency. Removing one is a deliberate act (§4).

## 4. What a lead sees

- **At claim time**, the command's answer says it: `&F20 now waits on &F18 (both claim knip.json): it can be built,
but its PR merges only after &F18 ships.`
- **On the board**, the card's existing `blockedBy` shows the wait, and `&F18`'s `blocks` shows the queue.
- **When the wait ends**, the existing notice arrives on the next message: `&F20 unblocked: &F18 merged`. The lead
  rebases the PR; the merger takes it on its next pass.
- **To jump the queue**, the lead runs `fy task undepend F20 F18 --reason "<why>"`, or the owner overrides it
  (`fy task depend --override`). Both are already there.

The existing rule still holds: a ferret cannot move a blocked card ON by hand. Facts (a PR opened, CI green) still
move it, so the card shows its real progress while it waits.

## 5. The merge gate

`fy task merge-gate <pr-url>` (CLI only, over the board read the CLI already has):

1. read every open card whose links include that PR (paging through the board read, all projects, public and
   private);
2. exit **0** and print nothing when no card waits on anything (or no card links the PR);
3. exit **1** and print `#412 waits on &F18 (until shipped)` when any linked card has an unfinished `blockedBy`;
4. exit **2** when the daemon cannot be read. The merger treats 2 like 1: **it fails closed** and merges nothing it
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

## 8. The build (one PR)

- `src/lib/board/claims.ts`: `claimsClash`, `clashingCards` (pure, unit-tested).
- `src/lib/board/card-actions.ts`: `file` and `create` add the dependencies and notes; `service.ts`: `file` joins
  `holderOnly`.
- `packages/cli`: `fy task merge-gate`, and the claim answer prints the new waits.
- `docs/board.md` §Dependencies and the Board rules line; this doc; the merge-all patch.
- Tests: unit for the clash rule and the skips, the card action, the CLI exit codes.
