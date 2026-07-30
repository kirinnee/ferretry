# UNIT F3 — daemon foundation: state home, paths, IO, storage

You are implementing **unit F3** of the Ferretry migration: the daemon's foundation layer. Every
later daemon unit sits on this, and you get to **design the on-disk layout** rather than inherit
one.

## Where you work

**Worktree:** `<your-worktree>`, branch `port/f3-foundation`,
already created. Work ONLY there. Never touch `/home/kirin/Workspace/personal/ferretry` (the
lead's) or the other worktrees. Use `direnv exec . <cmd>` for everything.

## Read first

- `docs/design/migration-plan.md` — binding. Your unit is §8.2's F3 row. §5 is your specification.
  Also §1.1 (fix bugs), §1.2 (three-layer), §1.3 (no back-compat, **Ferretry starts empty**),
  §9 (verification without touching the live fleet).
- `docs/standards/`: `three-layer-architecture`, `stateless-oop-di`, `testing`, `validation`.
- `packages/daemon/` as it stands (`@ferretry/daemon`, placeholder entry + test).
- `packages/cli/src` for house style.

## Safety — read this twice, it is the highest-risk unit so far

- **`~/.kteam` and the running `kteamd` are production** for the human's entire agent fleet,
  including the teammate running this brief. You are writing filesystem and SQLite code, so a
  careless default path is a real hazard.
- **Never** read, write, list, or delete anything under `~/.kteam`. Never start `kteamd` or `fyd`.
- **Never touch the real `~/.ferretry` either.** Every test allocates a temporary directory and
  points `FY_HOME` at it. A test that resolves the real home is a bug in the test.
- Public repo. No secrets in code, docs, commits, or PR text.

## Source → destination

Read-only source: `/home/kirin/.config/home-manager/modules/kteam-ts/src`. Your **exclusive**
ownership is everything under `packages/daemon/` _except_ nothing — you are the first daemon unit,
so the whole package is yours for now. Do not create or edit files in other packages.

| Source       |   LOC | Character                       |
| ------------ | ----: | ------------------------------- |
| `paths.ts`   |   101 | env-driven path resolution      |
| `io.ts`      |    35 | atomic write / run helpers      |
| `version.ts` |    15 | version constant                |
| `storage.ts` | 1,792 | filesystem + SQLite index + env |

Verify these against the source first; trust the source over this table and say so if they differ.

## What to build

### 1. The state home layout — design it, then document it

Per plan §5, and now unambiguous because **Kirin confirmed Ferretry starts empty**: there is no
import path, no legacy format, and no migration tooling. You support exactly one layout.

Requirements:

- **Files are authoritative; SQLite is a disposable index.** Deleting the index and rebuilding it
  from the files must be a supported, tested operation. This is the philosophy that survives from
  kteam and it must be real, not aspirational.
- A **`layout-version` marker** at the root. On an unknown version the daemon **refuses to start**
  rather than half-migrating. One version exists today.
- **Configuration separate from runtime state**, so config can be version-controlled without
  dragging state along.
- `FY_HOME` overrides the root; default `~/.ferretry`. **`FY_*` only** — the `no-legacy-state`
  gate fails the build on any `KTEAM_` literal.
- Reserve `~/.ferretry/fleet/manifest.json` (plan §7.1) — you do not implement the manifest, just
  do not collide with it.
- **Document the resulting tree in your PR body.** It becomes the reference every later unit uses.

### 2. Three-layer split

Read kteam's `storage.ts` critically: at 1,792 lines mixing filesystem, SQLite, and env, it is
exactly the kind of module plan §1.2 says to decompose. Pull the **decisions** into `src/lib/`
(path computation, layout rules, index-vs-file resolution policy, rebuild planning) and keep the
**IO** in `src/adapters/` behind interfaces (filesystem, SQLite, clock, env). Constructor
injection, no module-level mutable state — `docs/standards/stateless-oop-di` is binding.

The arch gate enumerates `src/lib` through `git ls-files` (hidden files included) and rejects
`console`, `process.*`, terminal deps, and relative `adapters/` imports. Do not work around it.

### 3. Bugs

Per §1.1, fix rather than reproduce, and list every change in the PR. Look especially for:
non-atomic writes that can truncate on interrupt, unchecked `JSON.parse`, index and files able to
drift with no reconciliation, and paths built by string concatenation. **Never write a test that
pins broken behavior.**

## Tests

- **Unit tier** (ledger `src/lib/**`): layout rules, path computation, rebuild planning — all pure,
  all table-testable. 100% goal.
- **Integration tier** (ledger `src/adapters/**`): real filesystem and real SQLite, but **always**
  under a temp `FY_HOME`. Include an explicit test that deleting the index and rebuilding from
  files yields the same logical state.
- Add a test asserting the daemon refuses an unknown `layout-version`.
- bun:test, AAA comments, `should` assertions.

## Definition of done

1. `direnv exec . pre-commit run --all-files` — all hooks pass.
2. `direnv exec . task test` — green.
3. `direnv exec . nix develop .#releaser -c ./scripts/release/publish.sh --snapshot` — green.
4. **Do not weaken a gate to pass.** No blanket knip ignores, no `|| true`, no `@ts-ignore`, no
   tsconfig loosening. Scope minimally and justify in the PR if truly unavoidable.

## Then — and this is required, not optional

Self-review your own diff before reporting; the previous unit's self-review caught three real
defects and that is now expected practice. Fix what you find, or list it explicitly.

Then **push and open the PR yourself**:

```bash
git fetch origin && git rebase origin/main
git push -u origin port/f3-foundation
direnv exec . gh pr create --base main --title "feat(daemon): add the state home, path, and storage foundation" --body "..."
```

PR body must include the documented state-home tree, the lib/adapters split you chose, bugs fixed,
the exact gate commands with results, and anything contradicting the plan.

**A unit that stops at "committed locally" is not done.** The previous unit made that mistake and
the lead had to finish it. Do not merge — the lead merges.

## Report

Final message: the PR number and URL, gate results, the layout you designed, bugs fixed, and any
decision the plan did not cover. Keep it tight.
