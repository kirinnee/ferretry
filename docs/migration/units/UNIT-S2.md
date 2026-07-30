# UNIT S2 — `packages/protocol`: wire schemas + typed client SDK

You are implementing **unit S2** of the Ferretry migration. `packages/cli` and `packages/pwa` will
both depend on what you build, so its shape matters more than its size.

## Where you work

**Worktree:** `<your-worktree>`, branch `port/s2-protocol`, already
created. Work ONLY there. Never touch `/home/kirin/Workspace/personal/ferretry` (the lead's) or the
other worktrees. Use `direnv exec . <cmd>` for everything.

## Read first

- `docs/design/migration-plan.md` — binding. Your unit is §8.2's S2 row; §1.1 (fix bugs, do not
  reproduce them), §1.2 (three-layer), §1.3 (no back-compat), §4 (why protocol owns these things).
- `docs/standards/`: `validation` (parse-don't-validate), `three-layer-architecture`, `testing`,
  `contracts`.
- `packages/protocol/` as it stands — `package.json` (`@ferretry/protocol`, exports
  `./src/lib/index.ts`), the placeholder entry, and its test.
- `packages/cli/src` for the house style you must match.

## Safety

- **Never touch the live installation**: `~/.kteam`, running `kteamd`, its tmux sessions, its
  ports. You only read source files.
- Public repo. No secrets in code, docs, commits, or PR text.

## Source → destination

Read-only source: `/home/kirin/.config/home-manager/modules/kteam-ts/src`. Your **exclusive**
ownership is everything under `packages/protocol/`. Do not create or edit files in any other
package.

**The type layer (3,039 lines, 295 exports, zero IO and zero module state in all of them):**

| Source                 | LOC | Exports |
| ---------------------- | --: | ------: |
| `types.ts`             | 545 |      22 |
| `tasks-types.ts`       | 556 |      62 |
| `task-boards-types.ts` | 339 |      25 |
| `attention-types.ts`   | 333 |      37 |
| `browser-types.ts`     | 234 |      31 |
| `push-types.ts`        | 217 |      19 |
| `learning-types.ts`    | 208 |      16 |
| `stt-types.ts`         | 194 |      29 |
| `analytics-types.ts`   | 174 |      16 |
| `pins-types.ts`        | 131 |      17 |
| `terminal-types.ts`    | 108 |      21 |

Plus `api-client.ts` (508 lines, 33 methods) → the typed client SDK.

Verify these line counts against the source before you start; if one disagrees, trust the source
and say so in your report.

## What to build

1. **Zod schemas for every type that crosses the wire.** `zod@4.4.3` is already a dependency.
   Schemas are the source of truth; derive TypeScript types from them (`z.infer`) rather than
   hand-maintaining parallel declarations. Not every exported type is a wire type — types used
   purely internally by the daemon do not belong here. Judge from usage and justify exclusions in
   the PR.
2. **Schemas live in `src/lib/`** — they are pure, so the arch gate applies: no `console`, no
   `process.*`, no IO, no imports from `adapters/`. (That gate now enumerates via `git ls-files`,
   so hidden files are caught too — do not try to work around it.)
3. **The client SDK performs network IO, so it belongs in `src/adapters/`,** behind an interface
   declared in `src/lib/`. It must validate every response through the schemas — parse, don't
   trust. Keep the 33-method surface but group it coherently.
4. **Version skew detection** — kteam sent a version header and reacted to mismatch. Carry the
   capability across with the `fy` naming, and make the mismatch behavior explicit and tested.
5. **Renames** — `KTeamEvent` → `FyEvent`, and so on for anything carrying the old brand. The
   `no-legacy-state` gate **will fail your build** on any `KTEAM_`, `.kteam`, `kteamd`, or
   `kfleet` literal under `packages/`, so this is enforced, not optional.
6. **Barrel export** — `src/lib/index.ts` is the package's public surface. Keep it deliberate;
   knip runs in production mode from this entry and will flag anything unreachable.

## A structural bonus you should confirm

The daemon has exactly two import cycles — `core.ts ↔ usage.ts` and
`service.ts ↔ session-manager.ts` — and in both the back-edge is **type-only**. Moving these types
into `packages/protocol` should dissolve both. Confirm that from the source and note it in your
PR; a later unit depends on it being true.

## Bugs

Per §1.1: fix what is wrong rather than reproducing it. Types that lie about optionality, unions
that permit impossible states, fields the server never sends — tighten them and list every change
in the PR. **Do not write a test that pins broken behavior.** Where the wire format is genuinely
ambiguous, pick the reasonable reading, note it, and move on.

## Tests

- **Unit tier** (`tests/unit/`, ledger `src/lib/**`): schema round-trips, rejection of malformed
  input, and every discriminated union resolving to the right member. This is where the 100% goal
  applies.
- **Integration tier** (`tests/integration/`, ledger `src/adapters/**`): the client against a fake
  transport — never a real daemon, never a real port.
- bun:test, AAA comments, `should` assertions, per `docs/standards/testing`.

## Definition of done

1. `direnv exec . pre-commit run --all-files` — all hooks pass.
2. `direnv exec . task test` — green.
3. `direnv exec . nix develop .#releaser -c ./scripts/release/publish.sh --snapshot` — green.
4. **Do not weaken a gate to pass.** No blanket knip ignores, no `|| true`, no `@ts-ignore`, no
   tsconfig loosening. If something must be scoped, scope it minimally and justify it in the PR.

## Then — and this is required, not optional

Self-review your own diff before reporting; the previous unit's self-review caught three real
defects and that is now expected practice. Fix what you find, or list it explicitly.

Then **push and open the PR yourself**:

```bash
git fetch origin && git rebase origin/main
git push -u origin port/s2-protocol
direnv exec . gh pr create --base main --title "feat(protocol): add wire schemas and the typed client SDK" --body "..."
```

PR body: what you built, which exported types you excluded from the wire surface and why, bugs
fixed, the cycle finding, the exact gate commands with results, and anything contradicting the plan.

**A unit that stops at "committed locally" is not done.** The previous unit made that mistake and
the lead had to finish it. Do not merge — the lead merges.

## Report

Final message: the PR number and URL, gate results, bugs fixed, and any decision the plan did not
cover. Keep it tight.
