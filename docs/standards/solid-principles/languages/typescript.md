---
id: solid-principles-typescript
title: SOLID Principles in TypeScript
---

# SOLID Principles in TypeScript

This is the TypeScript/Bun implementation guide for the language-agnostic
[SOLID Principles](../index.md). It maps each principle onto the real layout of the `packages/cli`
package.

## Folder Structure

The CLI package has three layers. The domain is pure; every side effect lives behind an adapter; the
`bin/` entry is the only place that wires them together.

```text
packages/cli/
  src/
    lib/                    # Domain layer -- pure, no IO
      {domain}/
        structures.ts       # data (value types)
        interfaces.ts       # the ports the domain depends on
        service.ts          # behavior (stateless objects)
    adapters/               # Adapter layer -- all IO lives here
      terminal/             # console-io.ts, spinner, progress, prompt
      system/               # process/shell-facing adapters
  bin/
    fy.ts                   # composition root -- builds the world and wires domain
```

`src/lib/` may not import from `src/adapters/`, and it may not touch `console.*`, `process.*`, or
terminal libraries (`chalk`/`ora`/`cli-progress`/`inquirer`). That boundary is not a convention you
have to remember -- `scripts/validate/cli-contracts.sh arch` fails the build if domain code reaches
for a terminal or an adapter. The composition root `bin/fy.ts` is the only seam allowed to know both
sides.

Except where a snippet names a real package artifact, the domain examples below are illustrative;
they describe a pattern rather than a currently implemented Ferretry feature.

## Single Responsibility (SRP)

Each class has one reason to change. Split validation from persistence -- they change for different
reasons.

```typescript
// BAD -- does validation AND persistence
class SessionService {
  validate(session: Session): boolean {
    /* ... */
  }
  save(session: Session): void {
    /* storage call */
  }
}

// GOOD -- separated responsibilities
class SessionValidator {
  validate(session: Session): ValidationResult {
    /* ... */
  }
}

class SessionService {
  constructor(
    private readonly repo: ISessionRepository,
    private readonly validator: SessionValidator,
  ) {}

  create(record: SessionRecord): Promise<Session> {
    /* ... */
  }
}
```

Note there are no `private` **methods** here -- only injected fields. Any helper you are tempted to
mark `private` becomes its own injectable service instead (the zero-private-methods corollary).

## Open/Closed (OCP)

Open for extension, closed for modification. Parameterize behavior behind an interface rather than
branching on a type inside existing code.

```typescript
interface INotifier {
  notify(message: string): void;
}

class ConsoleNotifier implements INotifier {
  constructor(private readonly io: ICliIo) {}
  notify(message: string): void {
    this.io.success(message);
  }
}

class WebhookNotifier implements INotifier {
  constructor(private readonly client: IHttpClient) {}
  notify(message: string): void {
    /* POST to a webhook */
  }
}
```

Adding a third notifier means adding a class, not editing the ones that already exist.

## Liskov Substitution (LSP)

Any implementation of an interface must be substitutable for another without breaking a caller.
Because we implement interfaces rather than subclass, LSP is about honoring the interface's full
contract. The SIT tier verifies this in practice: the same journeys run against both
`BinaryCliDriver` and `InProcessCliDriver`, so any driver that diverges from the shared contract
fails the suite.

This repository does **not** use `extends` for behavior reuse (the no-subclassing corollary).
Concrete inheritance couples a subclass to a base class's implementation details; implementing a
named interface does not.

## Interface Segregation (ISP)

Small, focused interfaces over large monolithic ones. Design them from the consumer's side.

```typescript
// BAD -- one interface, many unrelated methods
interface ISessionStore {
  find(id: string): Promise<Session>;
  save(session: Session): Promise<void>;
  delete(id: string): Promise<void>;
  archive(id: string): Promise<void>;
  export(format: string): Promise<Uint8Array>;
}

// GOOD -- segregated by how consumers actually use it
interface ISessionReader {
  find(id: string): Promise<Session>;
}

interface ISessionWriter {
  save(session: Session): Promise<void>;
  delete(id: string): Promise<void>;
}
```

The terminal ports follow this rule already: presentation (`ICliIo`), spinner (`ISpinner`), progress
(`IProgressBar`), and prompting (`IPrompt`) are separate interfaces, so a command that only prints
output never has to depend on prompting.

## Dependency Inversion (DIP)

High-level modules depend on abstractions, not concretions. In this package the domain **owns** the
ports it needs, while adapters own ports that expose a concrete IO mechanism. The composition root
bridges structurally compatible ports.

The presentation port `ICliIo` is declared in
`src/adapters/terminal/console-io.ts`, alongside its production implementation `ConsoleIo`:

```typescript
// src/adapters/terminal/console-io.ts -- the port and its production adapter
export interface ICliIo {
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
  interactive(): boolean;
}

export class ConsoleIo implements ICliIo {
  success(message: string): void {
    /* writes to stdout */
  }
  // ...
}
```

A domain controller must not import `ICliIo`, because that would import upward from `src/lib/` into
an adapter. Instead, it defines the smallest domain-facing port it needs:

```typescript
// src/lib/... -- pure domain, no terminal or process access
export interface IGreetingOutput {
  success(message: string): void;
}

class GreetController {
  constructor(private readonly output: IGreetingOutput) {}

  run(name: string): void {
    this.output.success(`hello, ${name}`);
  }
}
```

When such a controller is registered, `bin/fy.ts` can pass `world.io`: `ICliIo` structurally
satisfies `IGreetingOutput` without the domain importing the adapter. In tests, a captured double is
injected in its place, so a journey can assert on the exact `{code, out, err}` a command produced
without a real terminal. Because `src/lib/` is forbidden from importing an adapter or touching
`process.*` (enforced by `scripts/validate/cli-contracts.sh arch`), the dependency can only ever
point domain → domain port ← adapter, never domain → adapter.
