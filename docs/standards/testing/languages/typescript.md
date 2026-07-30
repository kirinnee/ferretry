---
id: testing-typescript
title: Testing in TypeScript
---

# Testing in TypeScript

The language-agnostic tiers, ledgers, and rules live in [Testing Conventions](../index.md).
This page is the implementation guide: the runner, the assertion library, and the double
patterns used in this repository.

## Framework: `bun:test` + `should`

`bun:test` is the runner (no Jest, no Vitest — Bun is already the toolchain). `should` is the
assertion library, declared once in the root `package.json` `devDependencies` and available to
every workspace package.

There is no shared test setup file to import. A test file imports what it needs and nothing else.

## Test Structure: describe / it

```typescript
import { beforeEach, describe, it } from 'bun:test';
import should from 'should';
import { QuoteService } from '../../src/lib/quote';

describe('QuoteService', () => {
  let pricing: IPricing;
  let subject: QuoteService;

  beforeEach(() => {
    pricing = { sum: items => items.reduce((a, b) => a + b.price, 0) };
    subject = new QuoteService(pricing);
  });

  it('should total every line item', () => {
    // Arrange
    const input = [
      { id: '1', price: 10 },
      { id: '2', price: 20 },
    ];
    const expected = 30;

    // Act
    const actual = subject.total(input);

    // Assert
    should(actual).equal(expected);
  });
});
```

`it` names read as a sentence starting with "should". `beforeEach` rebuilds the subject so no
test inherits another's state.

## Assertions

### Prefer the wrapper form

`should` supports two call styles. **Use the wrapper form, `should(actual)`.**

```typescript
should(actual).equal(expected); // house style
actual.should.equal(expected); // works, but see below
```

The prototype form reads slightly better but cannot be used on `null` or `undefined` (there is no
prototype to reach), which means it breaks exactly on the values a test most wants to assert
about — and it forces a non-null assertion on anything typed `T | null`. The wrapper form works
uniformly, so the codebase uses it everywhere.

### The catalogue

```typescript
import should from 'should';

// Equality
should(actual).equal(expected); // strict equality
should(actual).deepEqual(expected); // structural equality

// Boolean
should(result).be.true();
should(result).be.false();

// Null / undefined
should(value).be.null();
should(value).be.undefined();
should(value).not.be.undefined();

// Truthiness
should(value).be.ok(); // truthy
should(value).not.be.ok(); // falsy

// Numbers
should(count).be.above(5);
should(count).be.below(10);
should(count).be.within(1, 10);

// Strings
should(text).containEql('substring');
should(text).startWith('prefix');
should(text).endWith('suffix');
should(text).match(/^\d+\.\d+\.\d+/);

// Arrays
should(items).have.length(3);
should(items).containEql('item');
should(items).be.an.Array();

// Objects
should(obj).have.property('key');
should(obj).have.property('key', 'value');

// Types
should(value).be.a.String();
should(value).be.a.Number();
should(value).be.an.Object();
should(value).be.a.Function();

// Throws
should(() => fn()).throw();
should(() => fn()).throw('message');
should(() => fn()).throw(Error);

// Async
await should(promise).be.resolved();
await should(promise).be.resolvedWith(value);
await should(promise).be.rejected();
await should(promise).be.rejectedWith(Error);

// Negation
should(actual).not.equal(other);
```

### When to reach for `expect`

`bun:test`'s `expect` is used for one thing `should` does not do: asserting on **spy call
records** from `spyOn`/`mock`. Integration tests that wrap a real library use it:

```typescript
import { expect, spyOn } from 'bun:test';

const log = spyOn(console, 'log').mockImplementation(() => undefined);
// ...
expect(log).toHaveBeenCalledTimes(2);
```

Everything else uses `should`. Do not mix the two styles for the same kind of assertion within
one file.

## Parameterized Tests — `it.each`

```typescript
import { describe, it } from 'bun:test';
import should from 'should';

describe('StatusFormatter', () => {
  it.each([
    { input: 'pending', expected: 'Pending' },
    { input: 'running', expected: 'Running' },
    { input: 'completed', expected: 'Completed' },
  ])('should format status "$input" as "$expected"', ({ input, expected }) => {
    // Arrange
    const subject = new StatusFormatter();

    // Act
    const actual = subject.format(input);

    // Assert
    should(actual).equal(expected);
  });
});
```

An in-test loop is acceptable for a homogeneous rejection list, where per-case reporting adds
nothing:

```typescript
it('should reject non-semver strings', () => {
  // Act + Assert
  for (const value of ['', 'v1.2.3', '1.2', '01.2.3', '1.2.3.4', 'latest']) {
    should(isSemver(value)).be.false();
  }
});
```

Use `it.each` when a failure should name which case failed; use a loop when the cases are
interchangeable.

## Manual Mocks

There is no mocking framework. Implement the interface — it is a handful of lines, it typechecks,
and it fails to compile when the port changes (which a `jest.mock` silently would not).

```typescript
class MemoryFileSystem implements IFileSystemAdapter {
  private readonly files = new Map<string, string>();

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`File not found: ${path}`);
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
}
```

For a single-method port, an object literal is enough:

```typescript
const pricing: IPricing = { sum: items => items.length };
```

## Spy Patterns

Three shapes cover nearly everything:

```typescript
// 1. Collect calls in order
const logged: string[] = [];
const spyIo: Pick<ICliIo, 'success'> = { success: msg => logged.push(msg) };
// Assert: should(logged).deepEqual(['msg1', 'msg2']);

// 2. Capture the argument for inspection
let captured: Payload | null = null;
const spySender: ISender = {
  send: payload => {
    captured = payload;
  },
};
// Assert: should(captured).have.property('id', '123');

// 3. Count calls (and drive a retry path)
let count = 0;
const stubClient: IClient = {
  fetch: () => {
    count++;
    throw new Error('fail');
  },
};
// Assert: should(count).equal(3);
```

Prefer shape 1. A recorded list of calls asserts on _order and content_ in one `deepEqual`,
which is stricter than a call count and reads better in a failure message.

## Contract Test

One function, parameterized by a factory, invoked once per implementation:

```typescript
import { beforeEach, describe, it } from 'bun:test';
import should from 'should';

function taskStoreContract(name: string, create: () => ITaskStore) {
  describe(`ITaskStore contract: ${name}`, () => {
    let subject: ITaskStore;

    beforeEach(() => {
      subject = create();
    });

    it('should save and retrieve by id', async () => {
      // Arrange
      const input = makeTask({ id: 'abc' });

      // Act
      await subject.save(input);
      const actual = await subject.findById(input.id);

      // Assert
      should(actual).not.be.null();
      should(actual?.id).equal(input.id);
    });

    it('should return null for an unknown id', async () => {
      // Act
      const actual = await subject.findById('missing');

      // Assert
      should(actual).be.null();
    });
  });
}

taskStoreContract('memory', () => new MemoryTaskStore());
taskStoreContract('file', () => new FileTaskStore(new MemoryFileSystem(), '/tmp/tasks.json'));
```

Adding an implementation means adding one line. If the new line fails, the implementation is not
substitutable.

## Integration Test — an adapter against its real library

Integration tests exercise `src/adapters/**` against the library the adapter exists to wrap. The
pattern is: spy on the real sink, or inject the library's own object so its calls can be
recorded.

```typescript
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { SingleBar } from 'cli-progress';
import { CliProgressBar } from '../../src/adapters/terminal/progress';
import { ConsoleIo } from '../../src/adapters/terminal/console-io';

describe('terminal adapters', () => {
  afterEach(() => {
    mock.restore();
    process.exitCode = 0;
  });

  it('should route presentation output through console', () => {
    // Arrange
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    const subject = new ConsoleIo();

    // Act
    subject.success('saved');
    subject.warn('careful');

    // Assert
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('should delegate progress state to cli-progress', () => {
    // Arrange
    const events: string[] = [];
    const bar = {
      start: (total: number, current: number) => events.push(`start:${total}:${current}`),
      increment: () => events.push('tick'),
      stop: () => events.push('stop'),
    } as unknown as SingleBar;
    const subject = new CliProgressBar(bar);

    // Act
    subject.start(3);
    subject.tick();
    subject.stop();

    // Assert
    expect(events).toEqual(['start:3:0', 'tick', 'stop']);
  });
});
```

Two rules make this tier survivable:

1. **Every adapter takes its collaborator as an optional constructor argument** whose default is
   the production object. That is what makes `new CliProgressBar(bar)` testable and
   `new CliProgressBar()` shippable.
2. **`afterEach` restores global state.** `mock.restore()` undoes every `spyOn`, and
   `process.exitCode = 0` stops one test's exit code from leaking into the runner's own result.

An adapter fronting a real external service (database, broker, HTTP API) should start that
service for real and tear it down in `afterEach` — container tooling is not vendored today, so
add it in the same change that adds such an adapter.

## SIT — the driver seam

SIT journeys never talk to a process or a program object. They talk to `CliDriver`:

```typescript
export interface CliResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

export interface CliDriver {
  run(args: string[], env?: Record<string, string>): Promise<CliResult>;
}
```

`BinaryCliDriver` spawns the compiled binary with `Bun.spawn` (with `NO_COLOR=1`, a timeout, and
`SIGKILL` as the kill signal, so a hung journey cannot hang the suite).
`InProcessCliDriver` builds the program with `createProgram()`, wires a fully doubled `CliWorld`
through `registerDomain()`, redirects commander's output with `configureOutput`, and calls
`exitOverride()` so a `--help` or a parse error throws a `CommanderError` instead of killing the
test process.

Journeys select the driver once, in `beforeAll`, and are otherwise identical:

```typescript
import { beforeAll, describe, it } from 'bun:test';
import should from 'should';
import pkg from '../../package.json' with { type: 'json' };
import { BinaryCliDriver, type CliDriver, InProcessCliDriver } from './driver';

const binaryName = Object.keys(pkg.bin)[0] ?? pkg.name;
const useInProcess = process.env.SIT_DRIVER === 'inprocess'; /* ...or no binary on disk */

let driver: CliDriver;
beforeAll(() => {
  driver = useInProcess ? new InProcessCliDriver() : new BinaryCliDriver(binaryPath);
});

describe(`cli (SIT, ${useInProcess ? 'in-process' : 'compiled binary'})`, () => {
  it('prints a semver with --version', async () => {
    // Act
    const actual = await driver.run(['--version']);

    // Assert
    should(actual.code).equal(0);
    should(actual.out.trim()).match(/^\d+\.\d+\.\d+/);
  });
});
```

Three things are load-bearing here:

- **`binaryName` is read from `package.json`**, never written as a literal — the binary can be
  renamed without touching a test.
- **The in-process driver restores `process.exitCode`** in a `finally`. A journey's exit code
  must never leak into the test runner's own exit code.
- **The in-process doubles mirror the real binary's stream choices.** ora renders status on
  stderr, so the `ISpinner` double appends to `err`, not `out`. Get this wrong and the two
  drivers disagree — which is a bug in the double, not in the journey.

## Test Folder Structure

| Test type   | Location             | Ledger                   | Config             |
| ----------- | -------------------- | ------------------------ | ------------------ |
| Unit        | `tests/unit/`        | `src/lib/**`             | `bunfig.unit.toml` |
| Contract    | `tests/unit/`        | `src/lib/**`             | `bunfig.unit.toml` |
| Integration | `tests/integration/` | `src/adapters/**`        | `bunfig.int.toml`  |
| SIT         | `tests/sit/`         | full system (in-process) | `bunfig.sit.toml`  |

Each `bunfig` sets its own `root`, so a suite can only see its own directory — a test in the
wrong folder is not "in the wrong style", it simply does not run. Coverage lands in
`coverage/<tier>/` as text plus lcov.

## Running

```bash
task test:unit           # fast inner loop
task test:watch          # unit suite in watch mode
task test:int
task test:sit            # compiles, then drives the binary black-box
task test                # all three
task test:coverage       # every coverage-capable suite
```

## Related Articles

- [Testing Conventions](../index.md) — tiers, ledgers, and the rules these patterns implement
- [Stateless OOP and Dependency Injection](../../stateless-oop-di/index.md) — the injection that
  makes doubles possible
- [Three-Layer Architecture](../../three-layer-architecture/index.md) — why `lib`/`adapters`/`bin`
  are tested differently
- [Validation](../../validation/index.md) — testing schema boundaries
