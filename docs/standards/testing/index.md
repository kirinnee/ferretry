---
id: testing
title: Testing Conventions
---

# Testing Conventions

Testing is how we know the code works. Not all tests serve the same purpose. This page defines
the tiers Ferretry actually runs, what each one is allowed to know, and which code each one is
accountable for.

This article builds on [Software Design Philosophy](../software-design-philosophy/index.md),
[SOLID Principles](../solid-principles/index.md), and
[Stateless OOP and Dependency Injection](../stateless-oop-di/index.md). The patterns in those
articles — visible dependencies, stateless services, constructor injection — are what make
testing tractable. Without them, everything below degenerates into mocking frameworks and
guesswork.

---

## The Test Pyramid

```text
                    ┌─────────────────────┐
                    │        SIT          │   Whole CLI, operator's eye
                    │    (Black-box)      │   Compiled binary, {code, out, err}
                    └──────────┬──────────┘
                               │
                    ┌──────────┴──────────┐
                    │    Integration      │   Adapters against real collaborators
                    │    (White-box)      │   src/adapters/** ledger
                    └──────────┬──────────┘
                               │
           ┌───────────────────┴───────────────────┐
           │                                       │
    ┌──────┴──────┐                        ┌───────┴───────┐
    │  Contract   │                        │     Unit      │
    │ (Black-box) │                        │  (White-box)  │
    │  LSP tests  │                        │ src/lib/**    │
    └─────────────┘                        └───────────────┘
```

The shape is deliberate: tests at the bottom are fast, cheap, and numerous. Tests at the top are
slow, expensive, and few. A healthy codebase has many unit tests, some contract tests, fewer
integration tests, and a small number of SIT journeys covering the paths an operator actually
takes.

### The three tiers, concretely

| Tier            | Lives in             | Coverage ledger (100% goal)     | Config             | Command          |
| --------------- | -------------------- | ------------------------------- | ------------------ | ---------------- |
| unit + contract | `tests/unit/`        | `src/lib/**` only               | `bunfig.unit.toml` | `task test:unit` |
| integration     | `tests/integration/` | `src/adapters/**` only          | `bunfig.int.toml`  | `task test:int`  |
| SIT             | `tests/sit/`         | full system (in-process driver) | `bunfig.sit.toml`  | `task test:sit`  |

`task test` runs all three. `task test:coverage` runs every coverage-capable suite and writes
lcov + text reports under `coverage/<tier>/`.

**The ledgers are disjoint on purpose.** Each `bunfig.*.toml` sets
`coveragePathIgnorePatterns` so a tier is only ever credited for the code it is responsible for:
the unit config ignores `src/adapters/**`, the integration config ignores `src/lib/**`, and
every config ignores `bin/**` and `tests/**`. This means a number cannot be inflated by
accident — you cannot reach 100% on the domain by exercising it through an adapter test, and an
adapter cannot borrow coverage from the domain. If a line is uncovered in its own ledger, it is
genuinely untested.

**CI runs the unit and integration tiers in test groups, judged per file.** `config/test-groups.json`
splits each tier into shares that run on parallel runners (`./scripts/ci/test.sh <unit|int> <group>`); each test
file belongs to the first group with a prefix of its path. Each group writes its own ledger and the
`Unit Tests` / `Integration Tests` job holds them together to the 100% gate
(`./scripts/ci/coverage-ledger.sh <unit|int> --groups <dir>`). **A source file passes only when one group
alone covers it 100%.** Line counts cannot be added up across groups: Bun reports a function it
never ran as one coarse range, blank and comment lines included, so groups disagree about which
lines exist — a union of lines is always red, and an intersection, measured, hid real misses. One
group's 100% is exactly what one serial run would conclude. If a file is only covered across
groups, the job names it with each group's hit/found count; give it a test in the group that owns
it. Locally, `task test` still runs each tier serially and judges it the same way.

---

## Unit Tests (White-Box)

Unit tests are **white-box tests** that examine the internal implementation of a single class or
function. They know about its collaborators (which, in this codebase, are always injected
interfaces) and they aim for **100% coverage of `src/lib/**`\*\*.

### Characteristics

- **Scope:** Single class or function
- **Visibility:** White-box — knows the dependencies and internal structure
- **Speed:** Milliseconds
- **Coverage goal:** 100% of branches and paths in the domain ledger
- **Dependencies:** All collaborators are test doubles

Because `src/lib/` is pure by contract (no console, no `process.*`, no terminal libraries, no
imports from `adapters/` — enforced by `scripts/validate/cli-contracts.sh arch`), unit tests
never need a filesystem, a network, or a TTY.

### The AAA Pattern

Every unit test follows the same structure: **Arrange, Act, Assert** — with those words as
comments, so the phases are visible at a glance.

```typescript
it('should sum the prices of every line item', () => {
  // Arrange
  const pricing: IPricing = { sum: items => items.reduce((a, b) => a + b.price, 0) };
  const subject = new QuoteService(pricing);
  const input = [
    { id: '1', name: 'Widget', price: 10 },
    { id: '2', name: 'Gadget', price: 20 },
  ];
  const expected = 30;

  // Act
  const actual = subject.total(input);

  // Assert
  should(actual).equal(expected);
});
```

Short tests may collapse phases (`// Act + Assert` for a throw assertion), but the comments stay.

### Standard Variable Names

| Variable   | Purpose                       |
| ---------- | ----------------------------- |
| `subject`  | The class/function under test |
| `input`    | Input parameters              |
| `expected` | Expected result               |
| `actual`   | Actual result from the call   |

These names are not decoration. They make the AAA phases self-describing and let a reviewer
diff two tests without reading them closely.

### Triangulation: Test Multiple Values

One test case might pass by accident. Multiple cases prove the logic.

```typescript
// WRONG - single case, might pass by luck
it('should format status', () => {
  should(formatStatus('pending')).equal('Pending');
});

// RIGHT - multiple cases prove the mapping
it.each([
  ['pending', 'Pending'],
  ['running', 'Running'],
  ['completed', 'Completed'],
])('should format status (%s -> %s)', (input, expected) => {
  should(formatStatus(input)).equal(expected);
});
```

### Spies for Side Effects

Pure functions need no spies — check the return value. When code has side effects (output,
IO, exit codes), pass a double that records what happened and assert on the recording.

```typescript
// Arrange
const logs: string[] = [];
const spyIo = { success: (msg: string) => logs.push(msg) };
const subject = new Service(spyIo);

// Act
subject.run();

// Assert
should(logs).deepEqual(['done']);
```

### Deterministic and Fast

Tests must be:

- **Deterministic** — no random values, no real wall-clock time
- **Fast** — no sleeps, no real IO
- **Isolated** — no dependence on test order or on state left by another test

```typescript
// WRONG - reads the real clock: slow and non-deterministic
it('should time out after one second', async () => {
  const start = Date.now();
  await subject.run();
  should(Date.now() - start).be.above(1000);
});

// RIGHT - injected clock: instant and deterministic
it('should time out once the deadline passes', () => {
  const clock = new FakeClock();
  const subject = new Service(clock);
  clock.tick(1001);
  should(subject.hasTimedOut()).be.true();
});
```

A test that reads the real clock, the real filesystem, or the real environment is a test that
will fail on someone else's machine at some point. Inject the dependency instead — that is what
[Stateless OOP and Dependency Injection](../stateless-oop-di/index.md) is for.

---

## Contract Tests (Black-Box)

Contract tests are **black-box tests** that verify behaviour through an interface. They know
nothing about internal implementation — only inputs, outputs, and the contract the interface
promises.

### Characteristics

- **Scope:** One interface contract
- **Visibility:** Black-box — tests the interface, not the implementation
- **Speed:** Fast (collaborators are still doubles)
- **Coverage goal:** Every documented behaviour of the interface
- **Key property:** Verifies LSP (the Liskov Substitution Principle)

### Why they matter

A contract test is written once against the interface and then run against **every**
implementation. If a new implementation passes, it is substitutable; if it fails, the
substitution was a lie. That is LSP, made executable.

```typescript
// The port
interface ITaskStore {
  save(task: Task): Promise<void>;
  findById(id: string): Promise<Task | null>;
}

// One contract, run against every implementation
function taskStoreContract(name: string, create: () => ITaskStore) {
  describe(`ITaskStore contract: ${name}`, () => {
    it('should round-trip a saved task', async () => {
      // Arrange
      const subject = create();
      const input = makeTask({ id: 'abc' });

      // Act
      await subject.save(input);
      const actual = await subject.findById('abc');

      // Assert
      should(actual).not.be.null();
      should(actual?.id).equal('abc');
    });

    it('should return null for an unknown id', async () => {
      // Act
      const actual = await create().findById('missing');

      // Assert
      should(actual).be.null();
    });
  });
}

taskStoreContract('memory', () => new MemoryTaskStore());
taskStoreContract('file', () => new FileTaskStore(memoryFs, '/tmp/tasks.json'));
```

Contract tests also apply to things that are not classes. `tests/unit/install-contract.test.ts`
is a contract test over `scripts/release/install.sh`: it reads the binary name back out of the
script, builds a fake `PATH` and a fixture archive, and asserts the installer's observable
behaviour — without knowing how the script is written. See
[Contracts](../contracts/README.md) for the release-contract gates this belongs to.

### Unit vs Contract: same folder, different purpose

Both live in `tests/unit/`. They are still different tests:

| Aspect      | Unit Test                  | Contract Test        |
| ----------- | -------------------------- | -------------------- |
| Knows about | Internal dependencies      | Interface only       |
| Doubles     | All collaborators          | All collaborators    |
| Validates   | Implementation correctness | Contract correctness |
| Fails when  | The code has a bug         | LSP is violated      |

---

## Integration Tests (White-Box)

Integration tests verify that **adapters** work against their real collaborators. They are
white-box: the test knows it is testing an adapter and sets up whatever that adapter bridges to.

### Characteristics

- **Scope:** One adapter plus its real collaborator
- **Visibility:** White-box — knows it is testing an adapter
- **Speed:** Slower than unit tests (real IO, real libraries); `bunfig.int.toml` allows a
  120-second timeout
- **Coverage goal:** 100% of `src/adapters/**`

### Why white-box

Adapters are the code that bridges the pure domain to the outside world — the terminal, the
shell, the filesystem, a socket. When testing `ConsoleIo`, you know it writes to `console.log`
and `console.error`, and you assert on exactly that. This is fundamentally different from SIT,
which treats the whole binary as a box with three observable outputs.

### Example: a terminal adapter against the real library

```typescript
it('should route presentation output and exit state through ConsoleIo', () => {
  // Arrange
  const log = spyOn(console, 'log').mockImplementation(() => undefined);
  const error = spyOn(console, 'error').mockImplementation(() => undefined);
  const subject = new ConsoleIo();

  // Act
  subject.success('saved');
  subject.warn('careful');
  subject.error('failed');
  subject.setExitCode(7);

  // Assert
  expect(log).toHaveBeenCalledTimes(2);
  expect(error).toHaveBeenCalledTimes(1);
  expect(process.exitCode).toBe(7);
});
```

Integration tests test **one adapter at a time**, not the assembled system. An adapter test
uses the real collaborator the adapter exists to wrap, and doubles anything beyond it.

When an adapter fronts a genuinely external service (a database, a broker, an HTTP API), start
it for real rather than mocking it — a container per test run, torn down in `afterEach`. Nothing
in Ferretry needs that today, so no container tooling is vendored; add the dependency in the
same change that adds the adapter.

---

## SIT (System Integration Testing)

SIT tests the **whole CLI from the operator's perspective**. It is fully black-box: the test has
no access to internals, only to what a person at a terminal can see.

### Characteristics

- **Scope:** The entire assembled CLI
- **Visibility:** Black-box — operator's eye view
- **Speed:** Slow (spawns a compiled binary per journey)
- **Coverage goal:** The journeys operators actually take
- **Assertion surface:** `{ code, out, err }` and nothing else

### Why SIT

Unit and integration tests verify the parts. SIT verifies that the parts, once wired together
and compiled, behave. It is the only tier that catches:

- Composition-root wiring mistakes
- Argument parsing and help/usage regressions
- Exit codes that do not match the message on stderr
- Anything that breaks only in a compiled standalone binary

### The dual-driver setup

SIT journeys are written once against a `CliDriver` seam and run through either of two drivers:

| Driver               | What it does                                                                        | Coverage           |
| -------------------- | ----------------------------------------------------------------------------------- | ------------------ |
| `BinaryCliDriver`    | Spawns the compiled standalone binary — the true black box. **The default.**        | None possible      |
| `InProcessCliDriver` | Runs the same journey through `createProgram()`/`registerDomain()` with captured IO | Full-system ledger |

`SIT_DRIVER=binary` (what `task test:sit` and CI use, after `task compile`) is the tier as
specified. `SIT_DRIVER=inprocess` (`task test:sit:coverage`) exists for one reason: a spawned
process cannot be instrumented, so the in-process driver replays the identical journeys through
the composition factories to produce the full-system coverage ledger. With `SIT_DRIVER` unset,
the suite prefers the compiled binary when one exists and falls back to in-process, so a bare
`bun test` stays green without a compile step.

The in-process driver injects doubles for the whole `CliWorld` — `ICliIo`, `ISpinner`,
`IProgressBar`, `IPrompt`, `IShellRunner` — capturing output into strings, mirroring the real
binary's stream choices (ora writes status to stderr, so the double does too). That mirroring is
the contract that makes the two drivers interchangeable: **if a journey passes under one driver
and fails under the other, the double is wrong, not the test.**

### Assert on the transport, not the internals

```typescript
it('shows a usage banner naming the binary with --help', async () => {
  // Act
  const actual = await cli(['--help']);

  // Assert
  should(actual.code).equal(0);
  should(actual.out).containEql('Usage:');
  should(actual.out).containEql(binaryName);
});
```

Note `binaryName` — it is read from `packages/cli/package.json`'s `bin` key, never written as a
literal. A SIT journey that hardcodes `fy` breaks the moment the binary is renamed, which
defeats the [two-name model](../architecture/index.md).

### No coverage metrics from the real tier

The binary driver cannot report coverage, and that is correct: SIT is black-box. Judge it on
behaviour — exit codes, stdout/stderr content, and journeys completing — not on a percentage.

---

## What Ferretry Does Not Test (Yet)

**No required E2E gate yet.** The E2E tier exists (`tests/e2e/`, [its README](../../../tests/e2e/README.md)):
it drives the compiled binaries, the real PWA bundle and a real Chrome through the product journeys,
and CI runs it as the advisory `E2E` workflow. It is not a required check until two weeks of runs
have measured its flake rate ([CI/CD](../ci-cd/index.md#e2e-tier)). Browser tests are the most
brittle and expensive tests there are, so its journeys cover what only a whole product can show and
leave edge cases to the tiers below.

**No load or performance tier.** Throughput and latency testing belongs with the daemon
(`fyd`), which is also a placeholder today.

**One budget lives in the integration tier instead.** `packages/daemon/tests/integration/runtime/boot-stalls.test.ts`
boots a real `fyd` over a fleet built at the size of the one that stalled in production
(`tests/integration/support/scaled-fleet.ts`: 36 sessions, three 200 MB transcripts, 2,000 Codex
rollouts) and fails if the event loop is ever blocked for more than 200 ms. A failure carries the
stacks the runtime sampled during the block. It is an integration test because it asserts a property
of the composed daemon, not throughput; it is not the start of a performance tier.

Do not add a tier speculatively. A tier that exists but is empty is worse than no tier: it
implies coverage that is not there.

---

## Flaky Tests and the Quarantine

A flaky test is a defect in the test, and the remedy is to fix it. What the quarantine does is stop
a known flake from holding a release hostage **while** it is being fixed.

**Fix the cause, not the budget.** The flakes fixed so far were all one of three shapes, and none
was "the machine is slow":

- **Asserting a moment that can be skipped.** A 5ms poll can move a sign-in from "awaiting approval"
  to "complete" before the test looks. Script the fake daemon to hold the state until the test has
  seen it, then release it.
- **A fixed sleep standing in for an event.** `await sleep(20)` and then reading a frame that WebCrypto
  produces off the event loop. Wait for the frame itself, with a bounded deadline that names what
  never arrived (`never shown: the Codex login awaiting approval`).
- **A question that can never be answered.** A deadline checked between polls bounds nothing if one
  poll never returns. Playwright never settles an `evaluate` sent to a service worker the browser has
  stopped but not yet closed, not even with an error, so its `.catch` never runs; an update stops the
  worker it replaces a few milliseconds before closing it. Race the call against the thing going
  away (`worker.once('close')`) so every poll settles.

Raising a timeout is legitimate only when you can say why the old budget was wrong, measured.

**The quarantine list.** `config/test-quarantine.json` names each known-flaky test by `tier`, `file`,
its full `describe > … > it` name, the GitHub `issue` tracking the fix, and the date it was `added`.
An entry with no issue is refused: a quarantine nobody is tracking is a deletion.

**What it does in CI.** `scripts/ci/quarantine.ts` runs after the unit and int tiers. A red tier is
rerun only when **every** failing test is on the list, Bun's own failure count agrees with the JUnit
report, and Bun reported no error outside a test. Then only the files holding those tests run once
more; if they pass, the tier is green with a `::warning::` annotation per test and a line in the job
summary naming its issue. Anything else — one unlisted failure, an unhandled error, a file that would
not load, a quarantined test that fails twice — leaves the tier exactly as red as it was. This is why
a blanket `bun test --retry` is not used: it would excuse every new flake too, silently.

**The coverage ledger stays whole.** A failed test executed only part of what it covers, so the first
run's ledger can be short of lines only that test reaches. The rerun's hits are merged into the first
run's line set, and the 100% gate runs on the merged ledger. It is not a plain union: Bun reports a
function a run loaded but never called coarsely (every line of it as missed, blanks included), and a
rerun of one file loads many such modules, so its unhit lines are dropped rather than added. The rerun is
a passing run of the same files at the same commit, so this proves nothing a green run would not.

**Leaving the quarantine.** Fix the test, delete its entry, and close the issue in the same PR. An
entry older than 14 days still works, and its warning says it has outstayed the budget.

---

## Test Organization

The real layout:

```text
packages/cli/
  bin/fy.ts                              # composition root (no tier's ledger)
  src/
    lib/                                 # pure domain      → unit ledger
    adapters/                            # all IO           → integration ledger
  tests/
    unit/
      version.test.ts                    # unit (white-box, src/lib)
      install-contract.test.ts           # contract (black-box, over install.sh)
    integration/
      terminal-adapters.test.ts          # integration (adapters + real libraries)
    sit/
      driver.ts                          # the CliDriver seam + both drivers
      cli.sit.test.ts                    # SIT journeys
```

`bin/` is excluded from every ledger. It is glue — a few lines of wiring with no branching
logic of its own — and it is exercised end to end by the SIT in-process driver, which imports
`createProgram()` and `registerDomain()` directly.

---

## Running Tests

```bash
task test                # unit + integration + SIT (SIT compiles first)
task test:unit           # fast inner loop
task test:int
task test:sit            # compiles, then drives the binary black-box
task test:watch          # watch the unit suite
task test:coverage       # every coverage-capable suite, lcov + text
task test:unit:coverage
task test:int:coverage
task test:sit:coverage   # in-process driver, full-system ledger
```

The tiers exist as separate configs precisely so the inner loop stays fast: `task test:watch`
never compiles a binary. See [Taskfile Conventions](../taskfile/index.md) for the task surface
and [CI/CD](../ci-cd/index.md) for how these run in the pipeline.

### No test launches a real harness, and no test outlives its tmux server

On 2026-10-19 the dev box held 92 tmux servers left by test runs, some four days old, and three of
them ran the owner's real Claude Code — a leaked e2e daemon whose runtime wrapper ran `exec claude`
by name against the host `PATH`. Three rules now hold, and each has a mechanism behind it:

- **Fakes first.** A test that starts a session puts a fake `claude` and `codex` first on the
  daemon's `PATH` and names its harness explicitly (`FY_CLAUDE_BIN` / `FY_CODEX_BIN` or an absolute
  wrapper). The e2e fixture does it for every journey (`paths.harnessBin`).
- **The daemon refuses a real one.** A daemon whose `FY_HOME` is under a temporary directory, or that
  was started with `FERRETRY_TEST=1`, checks every pane launch: if the program, `claude` or `codex`
  resolves into a real install, the launch fails with `test mode refused to launch a real harness`
  (`packages/daemon/src/lib/tmux/harness-guard.ts`).
- **A leak fails the run.** `scripts/ci/test.sh` and the `task test*` targets run every unit, int and
  SIT invocation through
  `scripts/test/swept.sh`, which gives the run its own `TMPDIR`, exports `FERRETRY_TEST=1`, and kills
  — then fails on — any tmux server still running under that directory when the run ends. The e2e
  runner does the same for its run root. Killing is by process (`scripts/test/tmux-sweep.ts`), not by
  socket, because a leaked server usually outlived the socket file its test deleted. A run whose test
  process died on a signal (a Bun crash) is already red and never reached its teardown, so its
  leftovers are swept and reported as the crash's, not as a fixture leak. A fixture that
  creates a tmux socket still kills its own server in `afterAll`/`finally`; the sweep is the net, not
  the cleanup. A fixture that also booted a daemon on that socket waits for the daemon to EXIT before
  `kill-server`: tmux 3.6a, told to exit in the same instant a daemon's control client loses its
  daemon, keeps both the server and the client running for good
  (`packages/cli/tests/integration/support/supervised-daemon-teardown.ts` owns that order).
- **A silent run is killed and described.** `scripts/ci/test.sh` runs the unit and integration
  `bun test` under `scripts/test/stall-watch.ts`. If the run prints nothing for
  `FY_TEST_STALL_SECONDS` (default 300), a test is wedged or the finished run is not exiting. A test
  whose main thread is stuck in a synchronous call cannot fire its own timeout, because the timer runs
  on that thread. The watchdog prints the last line, the live processes and each thread with what it
  waits in (a `Worker` is a thread), then kills the tree and exits 124.
- **No `Bun.gc(true)` in the test process, and no measured threads either.** `Bun.gc(true)` is
  synchronous. On 2026-10-29 it wedged the daemon integration group twice, in two different files.
  Each time it ran just after earlier files had terminated real `Worker`s, and `terminate()` returns
  before the thread has gone. So a test that forces a collection, or starts real `Worker`s to measure
  them, does it in a child process with a kill deadline: `tests/integration/support/worker-rss.ts`,
  `session-worker-rss.ts` and `parse-window-finalization.ts`. The runner process is shared by every
  file in the run. Wedged there, it takes the whole group down and no timeout can end it; in a child,
  the test kills it and fails with the reason.

### No test runs inside the agent session that started it

On 2026-10-29 every live agent on the dev box lost its pane in the same two seconds while agents were
running the integration tier from inside their own panes. An agent's pane carries the live daemon's
`FY_HOME` (the owner's real state home) and a `TMUX` naming the server every agent on the machine
runs under; a suite started there inherits both, a fixture that "restores the previous `FY_HOME`"
hands the real home back to whatever a timed-out test is still running, and any `tmux` without `-S`
reaches the live server. Three rules hold:

- **The session is shed first.** `packages/daemon/tests/support/ambient-session.ts` removes `FY_HOME`,
  `TMUX`, `TMUX_PANE` and the `FY_SESSION_*`/pack variables before any test file loads — from the
  preload every `bunfig.*.toml` names, and again from the integration support modules so a suite
  started without its preload (`bun test tests/integration` inside a package) is shed too. What they
  named is recorded in `FY_TEST_PROTECTED_PATHS`, with the account's default state home, and a run
  whose `TMPDIR` lies inside one refuses to start.
- **A teardown touches only what is disposable.** Before a socket is killed or a root removed,
  `assertDisposable` requires it strictly inside a temporary directory and clear of every protected
  path. `scripts/test/tmux-sweep.ts` refuses such a root with exit 2 and kills nothing, and never
  sweeps a server whose socket resolves into a protected path.
- **Never by pattern.** Test code kills by pid, or a tmux process whose argv names `-S` and its own
  socket verbatim — never `pkill`/`killall`, which match every command line on the machine
  (`scripts/validate/no-pattern-kill.sh`).

The product keeps the same line: `fy daemon stop`'s escalation is `systemctl --user kill
--kill-who=main`, because the unit's control group also holds the tmux server, and a kill of the whole
group ends every agent.

---

## Quick Checklist

**Unit tests:**

- [ ] AAA phases marked with comments
- [ ] Variable names: `subject`, `input`, `expected`, `actual`
- [ ] Multiple cases (triangulation), not one lucky example
- [ ] Doubles that record, for side effects
- [ ] Deterministic — no random values, no real clock
- [ ] Fast — no sleeps, no real IO
- [ ] Lives in `tests/unit/`, credited against `src/lib/**`

**Contract tests:**

- [ ] Written against the interface, not an implementation
- [ ] The same contract runs against every implementation
- [ ] Failure means LSP was violated

**Integration tests:**

- [ ] One adapter plus its real collaborator
- [ ] White-box: asserts on what the adapter actually does
- [ ] Doubles anything beyond the adapter under test
- [ ] Lives in `tests/integration/`, credited against `src/adapters/**`

**SIT:**

- [ ] Journey written against the `CliDriver` seam, not a driver
- [ ] Asserts only on `{ code, out, err }`
- [ ] Passes identically under both drivers
- [ ] Binary name derived from `package.json`, never hardcoded
- [ ] Judged on behaviour, not on a coverage number

---

## Language Implementations

- [Testing in TypeScript](languages/typescript.md) — `bun:test`, `should`, doubles, and the
  driver seam

## Related Articles

- [Software Design Philosophy](../software-design-philosophy/index.md) — the foundational "why"
- [SOLID Principles](../solid-principles/index.md) — LSP, which contract tests verify
- [Stateless OOP and Dependency Injection](../stateless-oop-di/index.md) — how code becomes testable
- [Three-Layer Architecture](../three-layer-architecture/index.md) — why the ledgers split where they do
- [Contracts](../contracts/README.md) — the release-contract gates
- [Taskfile Conventions](../taskfile/index.md) — the commands above
