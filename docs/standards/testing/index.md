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

**No E2E tier.** E2E means driving a real browser against a real frontend (Playwright, Cypress).
`packages/pwa` is a placeholder, so there is nothing to drive. When the PWA lands it gets an E2E
tier of its own — kept deliberately minimal, because browser tests are the most brittle and
expensive tests there are: cover the critical happy path and leave edge cases to the tiers below.

**No load or performance tier.** Throughput and latency testing belongs with the daemon
(`fyd`), which is also a placeholder today.

Do not add a tier speculatively. A tier that exists but is empty is worse than no tier: it
implies coverage that is not there.

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
