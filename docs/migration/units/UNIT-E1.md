# UNIT E1 — the E2E harness

**Read `docs/migration/units/UNIT-CONTEXT.md` fully first.** It holds the safety rules, the
refactor doctrine, the definition of done, and the PR requirement. This brief adds only specifics.

**Worktree:** `<your-worktree>`, branch `port/e1-e2e-harness`.

**You own:** `tests/e2e/**` at the repo root, `scripts/test/` (new, for the harness stubs),
`bunfig.e2e.toml` (new), and the E2E entries in `tasks/Taskfile.test.yaml`. Nothing else.

## Why you exist

Read `docs/design/migration-plan.md` §9.1 — it is your specification. This migration is a refactor
with **no oracle**: the result cannot be diffed against kteam. Unit tests prove pieces; only E2E
proves the product works. You are built early and deliberately, because every later unit adds its
journey to your harness — if the harness arrives late, nothing gets E2E'd.

## Build these four isolation mechanisms — all mandatory

1. **A dedicated tmux server.** Each run gets its own socket (`tmux -L fy-e2e-<run>` or
   `-S <tmpdir>/tmux.sock`) so Ferretry's panes cannot see or touch the live tmux server running
   the human's fleet. This is _real but isolated_ tmux — distinct from the integration tier's fake
   tmux (which asserts issued commands). Both exist; neither replaces the other. Guarantee cleanup:
   the server is killed on success, failure, and interrupt, and never leaks a session.
2. **A fake harness binary.** A stub placed on `PATH` that impersonates a Claude/Codex agent
   wrapper: it accepts the arguments a real wrapper takes and emits scripted transcript output.
   This makes session-lifecycle journeys runnable with **zero API spend and no real agent**. Make
   the script it replays declarative, so a journey can specify "the agent says X, then asks a
   question, then exits" without new stub code.
3. **Temp `FY_HOME` + ephemeral ports.** Per-run temp state home; ports drawn from an ephemeral
   range and probed for availability, never a fixed number. Parallel E2E runs must not collide.
4. **A no-live-state runtime assertion.** The run fails loudly if any resolved path falls under
   `~/.kteam` or the real `~/.ferretry`. The `no-legacy-state` gate catches literals; this catches
   runtime resolution, which is the failure that would actually hurt.

## Also deliver

- **Fixture helpers** a journey author uses: spin up the isolated environment, start/stop the
  daemon under test, run the compiled `fy` against it, await an event on the WebSocket, and tear
  everything down. Ergonomics matter — every later unit depends on this being pleasant.
- **`bunfig.e2e.toml`** and a `task test:e2e` target, following the existing tier configs' shape
  (read `bunfig.{unit,int,sit}.toml` and `tasks/Taskfile.test.yaml`). E2E is its own tier, not
  folded into the unit/int matrix. Follow `docs/standards/taskfile` rules.
- **One real proving journey.** The daemon does not exist yet (F3 is landing the foundation), so
  you cannot write a session journey. Instead prove the harness itself: a journey that starts the
  isolated tmux server, puts the fake harness on `PATH`, drives the existing compiled `fy` binary,
  asserts on `{code, out, err}`, and verifies the no-live-state assertion fires when deliberately
  pointed at a forbidden path. A harness with no passing journey is not a harness.
- **A short `tests/e2e/README.md`** telling later units how to add a journey. This is the interface
  a dozen agents will read.

## Notes

`playwright` will be needed later for PWA journeys (kteam ships `browser-playwright-client.ts`, so
it is a known quantity) — do **not** add it now. Leave a clear seam and say so in the PR.

CI wiring is explicitly **not** yours: the lead adds the E2E job to `.github/workflows/ci.yaml`
after this merges, to avoid a conflict with other in-flight units. Note in your PR that it is
pending.
