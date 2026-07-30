# UNIT D1 — transcript parsers (Claude + Codex)

**Read `docs/migration/units/UNIT-CONTEXT.md` fully first.** It holds the safety rules, the
refactor doctrine, the definition of done, and the PR requirement. This brief adds only specifics.

**Worktree:** `<your-worktree>`, branch `port/d1-transcripts`.

**You own:** `packages/daemon/src/lib/transcript/**`, `packages/daemon/src/adapters/transcript/**`,
`packages/daemon/tests/{unit,integration}/transcript/**`, and your own export lines in
`packages/daemon/src/lib/index.ts`. **Nothing else under `packages/daemon/`** — another unit owns
the state-home/storage foundation right now, and a third owns names/worktrees. Do not create
`paths`, `io`, `storage`, or `fs` modules; if you need them, define a narrow interface in your own
`lib` and note the dependency in your PR.

## Source (read-only)

`/home/kirin/.config/home-manager/modules/kteam-ts/src`:

| File                   |   LOC | What                                        |
| ---------------------- | ----: | ------------------------------------------- |
| `codex-transcript.ts`  | ~1.6k | Codex transcript parsing (with its sibling) |
| `claude-transcript.ts` | 1,044 | Claude transcript parsing                   |
| `transcript-search.ts` |    65 | search over parsed transcripts              |

Verify these against the source and trust the source if they differ. Read their `*.test.ts`
siblings for intent — but remember source tests are evidence, not a contract, and any test that
pins broken behavior is deleted and its intent re-expressed correctly.

## Why this unit is a good fit for the doctrine

Transcript parsing is **almost entirely pure**: bytes in, structured messages out. That means the
overwhelming majority of this belongs in `src/lib/` with a full unit-tier ledger, and only file
reading and directory watching belong in `src/adapters/`. If you find yourself putting parsing
logic in an adapter, the split is wrong.

## What to build

- **Pure parsers in `src/lib/transcript/`** for both harnesses, behind a common interface so callers
  do not branch on harness kind. Model the message shapes explicitly (roles, tool calls, tool
  results, reasoning, attachments, errors, usage) rather than passing loose records around.
- **Adapters in `src/adapters/transcript/`** for reading transcript files and following them as they
  grow. Behind interfaces declared in `lib`. Never read from `~/.kteam`.
- **Search** over parsed transcripts — pure, in `lib`.
- **Malformed input is a first-class case.** Transcripts are appended live, so a parser will see
  truncated trailing lines, interleaved writes, and partial JSON. It must never throw on
  ill-formed input; it returns what it could parse plus a structured note about what it could not.
  Assert this explicitly — an unchecked `JSON.parse` here is a daemon crash in production.

## Fixtures

Copy a handful of representative transcript samples into
`packages/daemon/tests/fixtures/transcript/` and **redact them**: no API keys, no tokens, no
personal content, no real file paths from the human's machine. Hand-authored synthetic fixtures are
strongly preferred over copied real ones — this is a **public repo**. If you copy anything real,
scrub it and say exactly what you scrubbed in your PR.

## Bugs to expect

Unchecked `JSON.parse`, assumptions that a line is complete, silent `catch {}` that hides parse
failures, and harness-version drift handled by string sniffing. Fix them and list every fix.
