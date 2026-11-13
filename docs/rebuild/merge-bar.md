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
9. **A converted home's fleet configuration loads** the way `fy runtimes` loads it:
   `migration/v4-to-v5/tests/unit/converted-fleet-loads.test.ts` runs the real Settings and Logins steps over a v4-shaped
   home that mirrors a real machine (profiles layering an instructions component, a model set and an MCP server; Claude
   host-store, Ferretry-store and environment-preset logins; a Codex login), then reads the result through the kernel's
   configuration service and `runtimesConfigFiles(...).load()`. `load()` must resolve, every v4 runtime must be in the
   model, and `instructions` must hold each document's text. One unreadable reference makes the WHOLE fleet
   configuration unreadable, and the converter once wrote instructions as `<name>.md` where 5.0 reads `<name>.yaml`. CASE 1
   (every login carried) is in; CASE 2 (logins held out of the preview) is line 12.
10. **An unreadable derived fleet manifest is regenerated, never refuses every start**:
    `packages/plugins/runtimes/tests/integration/daemon/manifest-regen.test.ts` — a `fleet/manifest.json` with an unknown key
    on an account row (the v4 4.291.12 shape) or truncated JSON is rebuilt from the configuration once after the daemon
    starts and by every apply, and ALSO when the damage happens after a healthy boot: a launch reader that meets it asks
    the repair job to run (the read itself never publishes; a healthy manifest never causes a publish), so the next start
    after a moment passes. A repair that fails throws, so the job runner retries it with its backoff until it works (proved
    with the real runner over a driven clock); the repair has ONE owner across its running and backoff states, so refused
    reads while it waits add neither an attempt nor a second retry timer. The start boundary (`LaunchGate.decide`) says the manifest is being rebuilt
    and to try again. The damaged bytes are kept in ONE aside file beside it,
    `manifest.json.unreadable` (owner-only, a self-describing JSON envelope named by a zod schema, at most 4 MiB of damage),
    one aside file, created once (exclusively, only when the name is free), never replaced or deleted: the kernel gained
    no delete operation for it and the aside is never published over. Anything already at that name (our own earlier
    aside, a foreign file, a link, a folder, a hard-linked file) is left untouched, and the manifest is STILL regenerated.
    One plain line per repair says what happened, and when the old file could not be kept aside it names the aside path
    (the files are named, never their contents). A start resolves its runtime from the rebuilt file with the same
    harness homes, and a valid manifest is left alone. Live v4 outage, 2026-11-12.
11. **A start by runtime reaches the provider signed in**: the `merge bar 11` cases in
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
12. **The preview stage loads its whole fleet configuration** (case 2 of the converter's fleet-load check):
    `migration/v4-to-v5/tests/unit/converted-fleet-loads-preview.test.ts` runs the preview stage (logins carried as
    signed-out shells, Codex held) and reads its fleet configuration through the very path `fy runtimes` takes (the
    kernel's `createConfigFiles` plus `runtimesConfigFiles(...).load()`). It must resolve, every carried runtime must be
    in the model, and every runtime the preview did not carry must be named in the report's hold list with one plain
    line; never `fleet_catalog_unreadable`. Each login's status is read from the REAL logins status service (not a
    hardcoded word): a signed-out store is `not_signed_in`, and an environment login whose `${secret:NAME}` is not in the
    empty preview vault is `secret_not_stored`, both "Needs sign-in". Lead ask, 2026-11-12.
    `migration/v4-to-v5/tests/unit/preview-logins-leaks.test.ts` holds the shells to it: built from an allowlist, no login
    file staged, no marker (comment, credential path, literal key, webhook token) in any `.ferretry-v5*` path after a
    passing or a failing `prepare`.
13. **A converted home keeps its v4 spend caps, enforced** (lead ruling on #F3703; 5.0's Usage plugin enforces a budget
    ONLY from `config/usage.yaml` `budgets.<login>`, so the converter moves each login's cap there, rebuilt from numbers):
    `migration/v4-to-v5/tests/unit/preview-logins-usage.test.ts` converts a home (the real converter AND the preview, owner
    and non-owner, with and without an unrelated held deletion), reads it back through the kernel's configuration service
    and runs the REAL Usage `start.decide` on a synthetic meter reading. It must hold these lines:
    - (a) a converted home stops a start at the login's v4 hard cap, and a later harmless login label apply keeps it;
    - (b) an unaccepted v4 raise stays held: the start is judged at the ACCEPTED cap until the owner accepts, then at the
      new one, and the migration report says "held: accepted X, pending Y" in numbers only;
    - (c) every period and level v4 had (daily, weekly; trigger and hard) carries: past a trigger nothing new starts
      (docs/budgets.md), and past the hard limit nothing new starts either.
    - (d) an unaccepted v4 time-zone change is held: starts are judged in the ACCEPTED zone until the owner accepts (v4
      holds EVERY zone change, the first one set and one removed included; Usage's `usageLoosens` holds it, and the
      held edit says "budgets now reset in X instead of Y");
    - (e) a login v4 accepted with a budget, whose file is now gone and which a runtime still uses, stays a held deletion
      (`preview-logins-deletion.test.ts`): the unrelated runtime still loads, no unrelated login or runtime is held.
      The whole-artifact scan (every `<HOME>/.ferretry-v5*` path, a passing and a throwing `prepare`) finds no comment, key,
      path or token marker in `usage.yaml` or its accepted-config snapshot beside a credential-shaped comment on the budget.
14. **A paired device on a same-commit daemon opens the fleet, not the reload block** (preview rehearsal #F3708 step 3c: an
    app and a daemon of one commit, a device paired, and every screen on "Reload to get the new app."):
    `packages/app/tests/integration/real-registry/paired-device-opens.test.ts` boots the REAL daemon over the real generated
    registry (all 31 packages, the hashes `fyd` reads), pairs a full device and a limited one over the real direct carrier,
    and feeds the app's own `standings()` / `wholeDaemonBlocked()` the inventory the daemon answered, over the app's real
    compiled registry. Every core piece must be allowed, no full-screen line or reason may show, a full device must see every
    package, and a limited device must still lose what its grants do not reach (never a core piece). The two registries
    must also carry one effective hash per package. The reading side is held by
    `packages/app/tests/unit/client/inventory-reread.test.ts` (a plugin list that failed to read is asked again, not left as
    the verdict) and `packages/app/tests/unit/shell/whole-daemon-line.test.ts` (a failed read is not the "reload" sentence;
    a different core contract names the piece). The same file then runs the **registered production Connections carrier
    router with its real default preference** (`registeredConnect` over the real generated registry, not `carriers: []`):
    the unchosen default falls back to the address the device paired over when no relay is discovered or the relay does not
    answer, says so, and flips back when the relay answers; a chosen "Relay only" stays blocked with the relay named as the
    cause and Settings › This device › Connection reachable from the block; a record without the positive "paired over direct" mark (every older record, a
    relayed pairing) has no direct address to fall back to, and the fallback notice holds while any lane of the same app
    still sends direct.

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

### Declared gaps

- **The root writer's descriptor-less rename fallback** (`packages/core/kernel/host/roots.ts` 634-636, with
  `host/adapters/node-fs.ts` 301-302 and 317-324). A `RootHandle.publish` and the other writes that rename onto a name
  hold the parent folder through a descriptor. When the host has neither descriptor mechanism (no `descriptorFolder`,
  and the C library's descriptor calls cannot be loaded, which `node-fs.ts` swallows on purpose), the root falls back
  to an absolute pathname: the parent is checked, then the create or rename goes by path, so a parent that is swapped
  for a link after the check could make the final call resolve through a different folder. It applies only on such a
  host, and the fixed-leaf look-then-rename concession does not constrain it. It is pre-existing: the fallback is in the
  root writer as of the 5.0 base and no manifest-regeneration change introduced it. The fleet manifest's aside no
  longer publishes over an existing entry, so it is not made worse; the kernel is not changed here, and an after-merge
  kernel card owns closing it.

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
