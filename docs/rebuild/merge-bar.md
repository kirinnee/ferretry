# The 5.0 merge bar

The written rule for when `rebuild/5.0` may merge into `main`, and what may stay open after it. Approved by the owner
on !A477 (merge early: security and core proven, the rest after merge, replacing the full-coverage-before-merge rule)
and !A480 (this bar, with no paid macOS run).

Target: merge-ready about **Sat 2026-11-14**, the after-merge list empty by **Sun 2026-11-22**, at a cap of 6 builders
(!A479).

## Before merge

Every line must hold. A line the owner defers goes by name into the after-merge list below; nothing else moves.

1. **Appendix D.** Every kept row of `docs/design/redesign.md` Appendix D (the kept rows and the kept half of each split
   row) has a test whose name starts with its id, and that test PASSES: `bun scripts/validate/guarantees.ts --strict`
   against the JUnit reports. 213 were missing when this bar was written.
2. **Security work merged on READY:** kernel-contract lanes S and K; kernel-caller-write; the held-edit regression
   fix; the send path (BG-051, BG-052, BG-053); `LOG_TOKENS` cleared in `fy` and `fyd`; the token-shape digit
   residual; the `pipefail` sites; effectiveLimits (`limits.yaml` read at launch).
3. **The v4-to-v5 converter**, including the J-0052 prompt, green on the two-release fixture, plus one dry run on a
   COPY of a v4 home on the preview.
4. **The differential harness (A)** landed with its mutation check, green on every row filled by then. No red row:
   fix it, or the owner defers it by name.
5. **The preview smoke list** (rules of !A469), each step pass or fail:

   | #   | Step                                                        |
   | --- | ----------------------------------------------------------- |
   | 1   | pair a fresh browser (on the owner's screen)                |
   | 2   | start, send, `--wait`, resume and stop a ferret             |
   | 3   | a peer send                                                 |
   | 4   | board card create, move and link                            |
   | 5   | agenda ask and answer                                       |
   | 6   | secrets set, used in a child, never readable                |
   | 7   | a config edit that loosens is held, then the owner confirms |
   | 8   | terminals open, type and close (own tmux socket)            |
   | 9   | browsers open, navigate and close                           |
   | 10  | catalogs install                                            |
   | 11  | `fy check`                                                  |
   | 12  | a daemon restart keeps the ferrets                          |

6. **CI green**, including the coverage ledgers, `fy check`, the nix build and the release guards.
7. **No paid macOS run** (owner, !A480). The darwin smoke and the FFI descriptor verify line are after-merge items.

## After merge

What 5.0 merges without is [after-merge.json](after-merge.json): three counts and the named items, each with an owner.

- `parityOpen`: parity rows outside Appendix D still `[ ]` in `docs/design/rebuild-parity.tsv`.
- `portsPendingLines`: the open-gap lines in `ports-pending.json`.
- `guaranteesMissing`: kept Appendix D rows with no id-named test. Before-merge line 1 needs it at 0, so the change
  that closes the last row lowers it to 0, and from then on it stays 0.
- `items`: lane P of the kernel contract, the Ferrets/Conversation seam lanes F1 and F2, the review follow-up sweep,
  the (D) S render diff, launch renewal, the darwin smoke and the FFI descriptor verify line.

### Honesty rules

- **The list only goes down.** The `after-merge` check (`bun scripts/validate/after-merge.ts`, part of `fy check`)
  fails when a count or the end date grows against the base ref, when an item is added, when the tree holds more than
  the baseline says, or when an item has no owner. Closing work lowers the numbers in the same change. When 5.0
  merges, the base default (`origin/rebuild/5.0`, shared with `ports-pending`) moves to `origin/main`. CI runs
  the against-base rules too: `scripts/ci/check-base.sh` fetches the pull request's base once it holds this list,
  otherwise the commit before the update, and names it as `FY_CHECK_BASE`; a named base CI cannot find is a finding.
  A run with no earlier commit (a label event) says so and holds the tree to its baseline only.
- Every row and item keeps its owner.
- One end date, `end` in the file. Only the owner moves it.
- A daily report to the lead: parity settled and total, the Appendix D missing count, the smoke list pass and fail.
- No new feature pull requests to `main` until the list is empty, or the end date passes and the owner reviews it.
- Release notes carry `known gaps: N`, where N is the sum of the three counts plus the open items.
