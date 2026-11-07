# v4 → v5 home converter (one-time tool)

Carries a stopped Ferretry **4.291.x** home into a **new** Ferretry 5 home with all data and every ferret kept. It is
run by the agent following [`docs/migration/v4-to-v5-prompt.md`](../../docs/migration/v4-to-v5-prompt.md), once per
machine. What it reads is [`docs/migration/v4-formats.md`](../../docs/migration/v4-formats.md).

## It is not part of the product

- Not a workspace member (the root globs are `packages/*`, `packages/core/*`, `packages/plugins/*`), never imported by
  any package, never bundled, compiled or released. `scripts/validate/migration-isolated.sh` enforces this on every
  commit, with its own planted-violation self-test.
- Its v4 parsers are its own (`src/v4/`). No v4 type or reader exists in `packages/`, and none may be added there.
- It writes v5 files only through the v5 schemas, imported from the v5 contracts (`@ferretry/<pkg>/contract`, mapped
  in `tsconfig.json`), so it can only produce files the v5 readers accept.
- **It is deleted from the repository once all three machines are on v5**, together with
  `scripts/validate/migration-isolated.sh` and its wiring.

## Use

```bash
cd migration/v4-to-v5 && bun install
bun src/main.ts --from <stopped v4 home> --to <new folder> [--report <file>] [--dry-run]
```

| Exit | Meaning                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------- |
| 0    | complete: every step converted and `home.json` written last                                          |
| 3    | ran, but a step is pending or failed: no `home.json`, so v5 refuses the folder (by design)           |
| 2    | refused before writing: not a stopped 4.291.x home, v4 daemon still holds its lock, target not empty |
| 64   | usage                                                                                                |

The report (`<to>.conversion-report.json`, beside the new home, never inside it) holds counts, ids and names only.

## Safety properties

- The v4 home is only read; the new home must not exist or be empty and must not overlap the source.
- `home.json` is written **last**, only when every step finished, so a half-converted folder can never be booted.
- Sealed and secret files (vault, its key, the identity key, push keys, harness sign-ins, the message-token key) are
  moved with `copyFile` + mode + times (`src/sealed.ts`): their bytes never become a value in this program, and the
  report names a file and its size, never content.
- The live tmux socket is given a second name in the new home with `link(2)`, so v5 reaches the same running server.

## State (Phase B)

The preflight, sealed mover, report and ordered step table (`src/steps/index.ts`) exist. Vault, identity, ferrets,
terminals and harness-homes have real conversions. The other steps remain `pending`, so the default conversion
still exits 3. Each step names what it waits for. Fixture homes built from the real 4.291.5 release are in
`fixtures/` (CI-only on shared boxes).

Ferret records keep ids, parent edges, names, runtime, work folder, resume ids, pane handles and credential hashes.
Declared files without a v5 schema are **not written**: history, names (including former runtime names), archive,
worktrees, forks, moves, auto-resume, restarts and terminals.json. Other missing fields are listed in `notCarried`.
In particular, there are no v5 record fields for provenance, transfer edges, project/card references or rewritten
transcript home/file pointers.

Harness files are copied unopened under `state/<claude-code|codex>/agent-homes/`: runtime UUID directories hold
runtime-owned files; `_shared` holds each shared transcript pool (including Codex SQLite). Modes and times of these
opaque files are preserved. Links are omitted, never followed or re-made: the contracts do not yet declare a link
policy or a runtime-to-ferret home mapping. Those are explicit gaps; these copies alone do not make resume ready.
Sign-in files and `fleet/credentials/` belong to the pending Logins step.

## Tests

`bun test tests` (unit; temp folders only, never a real home).
