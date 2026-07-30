---
id: functional-practices-typescript
title: Functional Practices in TypeScript/Bun
---

# Functional Practices in TypeScript/Bun

Ferretry uses Bun, strict TypeScript, and Zod. The current CLI exposes a small semver helper in
packages/cli/src/lib/version.ts and uses Zod for runtime validation; it does not yet provide a
shared Result or Option implementation. This guide describes the conventions for code added to
that foundation.

## Immutability

Use readonly properties and return a fresh value for every update.

```typescript
export interface SessionTask {
  readonly id: string;
  readonly title: string;
  readonly state: 'queued' | 'active' | 'done';
}

export function renameTask(task: SessionTask, title: string): SessionTask {
  return { ...task, title };
}

export function completeTask(task: SessionTask): SessionTask {
  return { ...task, state: 'done' };
}
```

Use readonly T[] or ReadonlyArray<T> for inputs that a function must not mutate. The spread
operator is the normal way to express a shallow immutable update. Be deliberate about nested
values: replace the nested structure rather than changing it in place.

## Pure functions

A function or instance method is pure when its output follows only from its arguments and
readonly configuration, with no IO or clock access.

```typescript
export class TaskLabelFormatter {
  constructor(private readonly prefix: string) {}

  format(title: string): string {
    return this.prefix + ': ' + title.trim();
  }
}

export function hasOpenTasks(tasks: readonly SessionTask[]): boolean {
  return tasks.some(task => task.state !== 'done');
}
```

By contrast, this method is impure because it consults the clock:

```typescript
export class TimestampFormatter {
  format(title: string): string {
    return title + ' at ' + new Date().toISOString();
  }
}
```

Keep the clock, console, process, shell, and other IO behind adapters or explicit ports.
Pass a timestamp or port into a calculation when its behavior needs that fact.

## Total functions and Zod boundaries

For an expected validation failure, use Zod safeParse instead of throwing. The following is the
shape of a small shared result module to introduce under packages/cli/src/lib when a domain needs
it; it is not an existing Ferretry import.

```typescript
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
```

Use an error value as a Result error; do not throw it for an ordinary invalid argument.

```typescript
import { z } from 'zod';

export class SessionIdError extends Error {
  constructor(readonly value: unknown) {
    super('session id must be a non-empty string');
    this.name = 'SessionIdError';
  }
}

const SessionIdSchema = z.string().trim().min(1);

export function parseSessionId(input: unknown): Result<string, SessionIdError> {
  const parsed = SessionIdSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err(new SessionIdError(input));
}
```

The existing assertSemver helper is a deliberately throwing assertion for checked package
metadata at the CLI bootstrap boundary. It is not the model for expected user input: controllers
should use safeParse and map the failure to their explicit return or presentation error.

## Result composition

Once a shared module exists, give it the small, predictable set of combinators needed for
railway-oriented programming: map, mapErr, andThen, and match. Whether they are methods or
functions is less important than their behavior: success transformations run only on success,
and expected failures pass through unchanged until a boundary handles them.

```typescript
export function andThen<T, E, U>(result: Result<T, E>, next: (value: T) => Result<U, E>): Result<U, E> {
  return result.ok ? next(result.value) : result;
}

export function match<T, E, U>(result: Result<T, E>, onOk: (value: T) => U, onErr: (error: E) => U): U {
  return result.ok ? onOk(result.value) : onErr(result.error);
}
```

Do not make every nullable value a Result. Use a precise type for the actual domain: an optional
lookup can be SessionTask | null, while a validation or operation with an expected error benefits
from Result<T, E>. If an Option abstraction becomes useful across more than one domain, add it to
the same shared module rather than duplicating it.

## Repository layout

```text
packages/cli/
  bin/
    fy.ts                    Composition root and command registration
  src/
    lib/
      version.ts             Existing pure semver validation
      <domain>/              Future pure structures, ports, and behavior
    adapters/
      terminal/              Console, prompt, spinner, and progress IO
      system/                Bun shell IO
```

The domain remains free of imports from adapters. A controller parses raw arguments with Zod,
calls pure behavior or a stateless injected service, and uses terminal adapters only at the
presentation edge.

## TypeScript checklist

- [ ] Use readonly data shapes and immutable updates.
- [ ] Pass time, randomness, and IO through explicit inputs or ports when behavior depends on
      them.
- [ ] Use Zod safeParse for expected raw-input failures.
- [ ] Add one shared Result or Option module only when more than one domain needs it.
- [ ] Return expected failures as values and map them at a layer boundary.
- [ ] Keep imports from packages/cli/src/adapters out of packages/cli/src/lib.

## Related articles

- [Functional Practices](../index.md)
- [Stateless OOP and Dependency Injection](../../stateless-oop-di/index.md)
- [Utilities](../../utilities/index.md)
- [Three-Layer Architecture](../../three-layer-architecture/index.md)
