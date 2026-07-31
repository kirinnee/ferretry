# Ferretry migration — shared unit context (read fully; your unit brief adds specifics)

You are executing one **unit** of the Ferretry migration. This file holds the rules common to every
unit. Your unit brief names your worktree, your exclusive file ownership, and your source files.

## READ THIS FIRST: your deliverable is working code in an open PR

**You are an implementer, not an analyst.** Three units have now failed by producing findings
instead of software — one wrote a 6-part audit of the source and zero lines of code. Do not repeat
it.

- **Do NOT produce** an audit, a findings report, a recommendations document, an implementation
  plan, or a design proposal. None of those are deliverables. The plan already exists.
- **If you catch yourself writing prose about the source, stop and write the module instead.**
- Where a brief says "note it in the PR" or "bugs to expect", that means: **fix it in code, then
  mention it in the PR description.** It never means "write about it instead of building it."
- Read only as much source as you need to write the next module, then write it. You do not need to
  understand every line before producing anything.
- Your success is measured by one thing: **an open PR containing tested, gate-passing code.** A
  perfect analysis scores zero.

### Work incrementally — this is how the failed units actually died

The unit that produced an audit did not misunderstand its job. It **read its whole source tree
first, filled its context, and then the only artifact it had room to emit was a summary.** Reading
everything up front is therefore not thoroughness; it is the failure mode.

So:

1. Pick the **smallest coherent module** you can finish.
2. Read **only** the source needed for that module.
3. Write it **with its tests**.
4. **`git commit`.**
5. Repeat.

**Commit early and often.** Committed code survives your context running out; an uncommitted
understanding does not. If you notice you are deep into your context with nothing written, stop
reading immediately, write and commit what you already understand, and note the remainder in your
PR.

**A partial PR containing real, tested modules is a success — but ONLY if you declare the gap.**
Full comprehension with no code is a failure. If you cannot finish the whole unit, open the PR with
what works and say plainly what is left — the lead will schedule the rest.

### Mount what you build, or it does not exist

**Your unit is not done when the module is written and tested. It is done when the product actually
uses it.** Wire your work into the composition root — `packages/daemon/bin/fyd.ts` (or
`packages/cli/bin/fy.ts`) — so the running binary constructs and calls it.

Three separate PRs failed this way before the rule was written, each caught only by a human reading
the diff: a bind-guard and readiness waiter that `fyd` never constructed, an entire warden —
detection, verdicts, failover — that production boot never called, and a frame governor no adapter
ever wired. All three were fully tested at 100% coverage and all three shipped a capability the
daemon did not have.

**Why no gate caught it:** `knip.json` lists `tests/**/*.test.ts` as an entry point, so a module
imported only by its own tests counts as reachable and the dead-code rule stays silent. Tests
launder dead production code. A reachability gate now closes this; do not wait for it to fail you.

### The completeness declaration is mandatory

Every PR body MUST contain a section titled **"Source coverage"** listing **every non-test source
file your brief assigned you**, each marked `PORTED` or `NOT PORTED`, with one line saying what a
`NOT PORTED` file does and what capability is therefore still missing.

This is not paperwork. **The gates cannot detect a missing feature.** Coverage measures the code
that exists, so a port of half a subsystem still reports 100% and CI still goes green. Three PRs of
this migration shipped exactly that way — one delivered speech-to-text that could install models but
could not transcribe (`stt-service.ts`, `stt-worker.ts`, `stt-worker-client.ts` silently absent,
15/15 checks green). Another shipped terminal support with the whole decision layer and no adapters
at all. Nothing but a human reading the file list caught them.

So: a PR with no "Source coverage" section is rejected unreviewed. A PR whose declaration is
**wrong** — it claims PORTED for a file with no target equivalent — is treated as a defect, not an
oversight.

## Safety — non-negotiable, read twice

- **`~/.kteam`, the running `kteamd`, its tmux sessions and its ports are PRODUCTION.** They run
  the human's entire agent fleet, including the session running you. Never read, write, or delete
  under `~/.kteam`. Never start `kteamd` or `fyd`. Never kill tmux sessions or panes you did not
  create. Never bind a known port.
- **Never touch the real `~/.ferretry` either.** Tests allocate a temp dir and point `FY_HOME` at
  it. A test that resolves the real home is a broken test.
- Porting means: **read source files, write new files.** Nothing else is required.
- Public repo. No secrets or personal data in code, docs, commits, or PR text.

## This is a refactor, not a translation

Read `docs/design/migration-plan.md` — it is binding. The essentials:

- **Port the capability, not the code.** kteam has plenty of bugs; we are not carrying them across.
  Fix what is wrong and list every fix in your PR. **Never write a test that pins broken
  behavior** — source tests are evidence of intent, not a contract.
- **Conform to `docs/standards/`.** `src/lib/` is pure decision logic (no `console`, no
  `process.*`, no IO, no imports from `adapters/`); `src/adapters/` holds all IO behind interfaces
  declared in `lib`; constructor injection everywhere; no module-level mutable state.
  The extraction rule for a big source module: **pull the decisions out of the IO.**
- **No backward compatibility.** `FY_*` env only. No `KTEAM_*` reads, no shims, no `~/.kteam`
  paths, no legacy formats. Ferretry starts empty. The `no-legacy-state` pre-commit hook **fails
  your build** on any `KTEAM_`, `.kteam`, `kteamd`, or `kfleet` literal under `packages/`.
- The arch gate enumerates `src/lib` through `git ls-files`, so hidden files are checked too. Do
  not try to route around either gate.

## Worktree discipline

Your brief names your worktree; it is already created on its own branch. Work **only** there.
Never touch `${FY_REPO}` (the lead's checkout) or another unit's
worktree. First run `direnv allow .`, then use `direnv exec . <cmd>` for everything.

**File ownership is exclusive across open PRs.** Write only files your brief assigns you. If you
need something outside your ownership, say so in your report instead of reaching for it. The one
shared file you may touch is your package's `src/lib/index.ts` barrel, and only to add your own
exports — expect a trivial rebase conflict there and resolve it in your favour without deleting
anyone else's line.

## Tests — the only oracle you have

This is a refactor with no original to diff against, so tests are what prove it works.

- **Unit tier** (`tests/unit/`, ledger `src/lib/**`, 100% goal): pure logic, table-driven.
- **Integration tier** (`tests/integration/`, ledger `src/adapters/**`): real IO against temp dirs
  and fakes. Never a real daemon, real port, or real tmux server.
- **E2E** (`tests/e2e/`): if your unit lands a user-visible capability, add its journey. The
  harness gives you an isolated tmux socket and a fake harness binary — never real agents, never
  real API spend.
- bun:test, AAA comments, `should` assertions, per `docs/standards/testing`.

## Definition of done — in this order

1. **The PR is open.** A unit that stops at "committed locally" is NOT done. Two units have
   already made this mistake and the lead had to finish their work.
2. Tests exist and are meaningful for everything you wrote. Schemas or logic without tests are
   rejected regardless of how good they look.
3. `direnv exec . pre-commit run --all-files` passes.
4. `direnv exec . task test` passes.
5. **`direnv exec . task test:gate` passes.** This runs the **exact** gate CI enforces: a **100%**
   coverage ledger, unit tier over `src/lib/**` and integration tier over `src/adapters/**`.
   Passing tests are not enough — a PR with every test green but coverage short **fails CI**.

   Note that `task test` and `task test:coverage` both **exit 0 while coverage is short**;
   `task test:coverage` prints the percentages but does not enforce them. `task test:gate` is the
   only local command that reproduces CI. Two PRs of the resumed migration went red this way
   before it existed. Run it before you push.

6. `direnv exec . nix develop .#releaser -c ./scripts/release/publish.sh --snapshot` passes.
7. **No gate was weakened.** No blanket knip ignores, no `|| true`, no `--no-verify`, no
   `@ts-ignore`, no tsconfig loosening, **and no shrinking or scoping of a coverage ledger to make
   a number go green**. If something genuinely must be scoped, scope it as narrowly as possible and
   justify it in the PR. A weakened gate is a rejected PR.

## Self-review before reporting

Review your own diff and fix what you find, or list it explicitly. This is expected practice — the
first unit's self-review caught three real defects, one of which let a hidden file bypass the
architecture gate entirely.

## Ship it

```bash
git fetch origin && git rebase origin/main
git push -u origin <your-branch>
direnv exec . gh pr create --base main --title "<conventional title>" --body "<below>"
```

PR body: what you built · bugs and defects fixed · gate commands with results · any gate you
scoped and why · anything contradicting the plan. **Do not merge** — the lead merges.

## Report

Final message, under 20 lines: PR number and URL, gate results, bugs fixed, and any decision the
plan did not cover.
