# The 5.0 merge bar

The written rule for when `rebuild/5.0` may merge into `main`, and what may stay open after it. Approved by the owner
on !A477 (merge early: security and core proven, the rest after merge, replacing the full-coverage-before-merge rule)
and !A480 (this bar, with no paid macOS run). On !A481 the owner moved the differential harness after merge.

Target (!A481): merge-ready by the end of **Wed 2026-11-11** UTC, **Thu 2026-11-12** as the fallback; the after-merge
list empty by **Sun 2026-11-22**.

## Before merge

Every line must hold. A line the owner defers goes by name into the after-merge list below; nothing else moves.

1. **Appendix D.** Every kept row of `docs/design/redesign.md` Appendix D (the kept rows and the kept half of each split
   row) has a test whose name starts with its id, and that test PASSES: `bun scripts/validate/guarantees.ts --strict`
   against the JUnit reports. 213 were missing when this bar was written.
2. **Security work merged on READY:** kernel-contract lanes S and K; kernel-caller-write; the held-edit regression
   fix; the send path (BG-051, BG-052, BG-053); `LOG_TOKENS` cleared in `fy` and `fyd`; the token-shape digit
   residual; the `pipefail` sites; effectiveLimits (`limits.yaml` read at launch).
3. **The v4-to-v5 converter**, including the J-0052 prompt, green on a real v4 fixture home in CI (the
   `migration-v4-to-v5.yaml` job "v4 fixture home and converter": it builds a 4.291.5 home, dry-runs and converts it,
   then boots v5 on the result; green on 5.0 in
   [run 42824937527](https://github.com/kirinnee/ferretry/actions/runs/42824937527)), plus one dry run on a COPY of a
   v4 home on the preview.
4. **The preview smoke list** (rules of !A469), each step pass or fail:

   | #   | Step                                                                        |
   | --- | --------------------------------------------------------------------------- |
   | 1   | pair a fresh browser (on the owner's screen)                                |
   | 2   | start, send, `--wait`, resume and stop a ferret                             |
   | 3   | a peer send                                                                 |
   | 4   | board card create, move and link                                            |
   | 5   | agenda ask and answer                                                       |
   | 6   | secrets set, used in a child, never readable                                |
   | 7   | a config edit that loosens is held, then the owner confirms                 |
   | 8   | terminals open, type and close (own tmux socket)                            |
   | 9   | browsers open, navigate and close                                           |
   | 10  | catalogs install                                                            |
   | 11  | `fy check`                                                                  |
   | 12  | a daemon restart keeps the ferrets                                          |
   | 13  | answer a permission prompt and a dialog from the app                        |
   | 14  | the same on a Codex ferret (if the Codex sign-in lands)                     |
   | 15  | the chat view of a running ferret: its tool calls, thinking and older pages |
   | 16  | `/messages` of that ferret: rows, then a cursor to the end                  |
   | 17  | log search inside that ferret finds a word and masks a secret               |
   | 18  | a transcript image from that chat opens                                     |

5. **CI green**, including the coverage ledgers, `fy check`, the nix build and the release guards.
6. **No paid macOS run** (owner, !A480). The darwin smoke and the FFI descriptor verify line are after-merge items.
7. **A ferret authenticates end to end** in CI: `packages/core/ferrets/tests/integration/daemon/ferret-auth/ferret-auth.test.ts` — a
   Claude OAuth login (fake `.credentials.json`), a Claude env login (dummy base URL and token, also secret-backed) and a
   Codex login (fake `auth.json`) each start a ferret through the daemon's real launch path, its first request reaches a
   fake provider server with the expected auth header, and the reply is seen. No real credential. Owner ask via
   lizzette, 2026-11-11.
8. **`fy pair` gives a link on a loopback daemon**: `packages/plugins/access/tests/integration/daemon/pair-link/pair-link.test.ts`
   (smoke step 1) boots a REAL `fyd` on a temp home and an ephemeral loopback port (chosen by `FY_PORT=0`)
   with a relay source on and no `connections.yaml` port, then asks for a code through the real `fy pair` and through
   `POST /v1/pair/code`: a `local-only` link on the port the daemon really bound must come back, and is cancelled
   (`DELETE /v1/pair/code/:pairingId`). A wildcard bind still refuses with `wildcard-bind`. Owner block !A472, 2026-11-12.
   No code is ever printed.
9. **A start by runtime reaches the provider signed in**: the `merge bar 9` cases in
   `packages/core/ferrets/tests/integration/daemon/ferret-auth/ferret-auth.test.ts` (smoke step 2) start a ferret on a
   REAL `fyd` on a temp home and an ephemeral loopback port (stand-in harness, no network) whose runtime `rt` is
   configured from FILES ONLY (`login: oauth`, a real profile; no `fy runtime add`, no apply, nothing published). The fake
   provider is strict: it replies only to a request carrying the signed-in login's credential, so a signed-out launch gets
   no reply. Each case reads that reply back and checks the launch's non-secret login facts (auth kind and the login's
   credential store). Cases: `fy start --harness claude-code --login oauth` (control); `fy new --runtime rt` (the command
   the owner types), which must reach the provider signed in; the app's own `startFerret` request builder (body and
   request-id header) sent over a loopback HTTP client that applies the shared `allowedCallHeaders` list, which must
   reach it too (the app's `DaemonClient` and its route guard and inventory check, the sealed browser session and
   carrier, and the React page are NOT in this case: the real New ferret screen is checked in a browser on the preview);
   a STOPPED ferret as the v4 -> v5 converter writes it (a runtime, no login) resumed through `POST
/v1/ferrets/<name>/resume`, which must resume signed in on its runtime's login (restart and automatic resume are the
   same `service.resume`), and one whose runtime cannot serve, which must not launch; a runtime named beside another
   login, which is refused, and beside its own, which starts; a login the owner switched off, named directly or through
   its runtime, which is refused with nothing spent; a start whose reply was lost and is submitted again, which starts
   ONE ferret; and a runtime that does not exist or whose login needs sign-in, which must be refused with a sentence
   naming it and start nothing. The 5.0 preview refused every `fy new` / `fy start` with "a start must carry x-fy-request-id"
   because the CLI shell dropped the header a half set (and the app's start sent none), and a start by runtime then
   launched signed out because nothing turned the runtime into its login; every other start test named the login in a
   raw `POST /v1/ferrets`. No credential is printed.

## After merge

What 5.0 merges without is [after-merge.json](after-merge.json): three counts and the named items, each with an owner.

- `parityOpen`: parity rows outside Appendix D still `[ ]` in `docs/design/rebuild-parity.tsv`.
- `portsPendingLines`: the open-gap lines in `ports-pending.json`.
- `guaranteesMissing`: kept Appendix D rows with no id-named test. Before-merge line 1 needs it at 0, so the change
  that closes the last row lowers it to 0, and from then on it stays 0.
- `items`: lane P of the kernel contract, the Ferrets/Conversation seam lanes F1 and F2, the review follow-up sweep,
  the (D) S render diff, launch renewal, the differential harness (moved here on !A481), the darwin smoke and the FFI
  descriptor verify line. An item enters after the baseline only by a named owner decision (`OWNER_MOVED_ITEMS` in the
  check).

### Honesty rules

- **The list only goes down.** The `after-merge` check (`bun scripts/validate/after-merge.ts`, part of `fy check`)
  fails when a count or the end date grows against the base ref, when an item is added, when the tree holds more than
  the baseline says, or when an item has no owner. Closing work lowers the numbers in the same change. When 5.0
  merges, the base default (`origin/rebuild/5.0`, shared with `ports-pending`) moves to `origin/main`. CI runs
  the against-base rules too: `scripts/ci/check-base.sh` fetches the pull request's base once it holds this list
  (or the commit before a push to main), and otherwise the anchor commit that set this baseline, and names it as
  `FY_CHECK_BASE`. A base CI cannot fetch fails the job, and `after-merge` fails on a named base it cannot read.
  Before merge, CI therefore holds 5.0 to the approved baseline itself; the commit hook holds each commit to the last fetched
  `origin/rebuild/5.0` tip.
- Every row and item keeps its owner.
- One end date, `end` in the file. Only the owner moves it.
- A daily report to the lead: parity settled and total, the Appendix D missing count, the smoke list pass and fail.
- No new feature pull requests to `main` until the list is empty, or the end date passes and the owner reviews it.
- Release notes carry `known gaps: N`, where N is the sum of the three counts plus the open items.
