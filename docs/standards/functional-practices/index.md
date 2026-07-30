---
id: functional-practices
title: Functional Practices
---

# Functional Practices

[SOLID Principles](../solid-principles/index.md) make dependencies manageable. Functional
practices constrain the code further, preventing whole categories of bugs by limiting what
behavior may do. In Ferretry, immutability, pure functions, total functions, and
railway-oriented programming apply to domain code regardless of the package that owns it.

This standard builds on [Software Design Philosophy](../software-design-philosophy/index.md) and
[SOLID Principles](../solid-principles/index.md). It supports
[Three-Layer Architecture](../three-layer-architecture/index.md), where errors are mapped
between layers, and [Stateless OOP and Dependency Injection](../stateless-oop-di/index.md),
where services and structures are wired explicitly.

## Immutability

Immutability means never changing an existing value. A transformation returns a new value
instead.

```typescript
export interface SessionTask {
  readonly id: string;
  readonly state: 'queued' | 'active' | 'done';
}

// Wrong: mutates a value still owned by the caller.
function markDoneInPlace(task: { id: string; state: string }): void {
  task.state = 'done';
}

// Right: leaves the input intact and returns the next value.
function markDone(task: SessionTask): SessionTask {
  return { ...task, state: 'done' };
}
```

The original task remains available for comparison, logging, retry, or another calculation.
There is no mutation history to reconstruct.

Benefits:

- **Predictable:** a value does not change behind a caller's back.
- **Safe under concurrency:** immutable inputs do not need coordination locks.
- **Debuggable:** old and new values can be inspected side by side.
- **Audit-friendly:** snapshots, undo flows, and event histories become simpler.

## Pure functions

A pure function depends only on its inputs and produces no side effect. It does not consult
global configuration, read the clock, write a database, or print a log line.

```typescript
export interface Attention {
  readonly dueAtMs: number;
}

// Pure: every fact used to calculate the answer is a parameter.
function isOverdue(attention: Attention, nowMs: number): boolean {
  return attention.dueAtMs <= nowMs;
}

// Impure: both the current clock and console output are hidden inputs/effects.
function isOverdueNow(attention: Attention): boolean {
  console.log('checking attention');
  return attention.dueAtMs <= Date.now();
}
```

Pure functions are easy to test, cache, run independently, and understand locally. Put
calculation and validation that need no IO in the domain layer. Keep console, process, shell,
network, and persistence effects in adapters or entry-level coordinators, where their ports are
visible.

## Total functions

A total function returns a valid result for every valid input in its declared domain. Expected
failure is part of the return type rather than a surprise exception.

```typescript
type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

type DivisionError = { readonly kind: 'division-by-zero' };

function divide(numerator: number, denominator: number): Result<number, DivisionError> {
  if (denominator === 0) {
    return err({ kind: 'division-by-zero' });
  }

  return ok(numerator / denominator);
}
```

The type tells callers that a calculation can fail in an expected way. Exceptions remain
appropriate for faults that are not a routine domain outcome, such as an invariant breach that
cannot be recovered from at this layer.

Ferretry does not currently ship a shared Result or Option module. When a domain needs this
pattern, add one reviewed, reusable module under packages/cli/src/lib rather than defining
slightly different result types in each feature.

## Railway-oriented programming

Railway-oriented programming makes total functions composable. A Result has a success rail and
an error rail: success transforms continue, while an expected error short-circuits to the
caller.

| Combinator | Purpose                                                              |
| ---------- | -------------------------------------------------------------------- |
| map        | Transform the success value; errors pass through.                    |
| mapErr     | Transform the error value; successes pass through.                   |
| andThen    | Chain another operation that returns a Result; errors short-circuit. |
| match      | Handle success and error explicitly at a terminal boundary.          |

The shared module can expose methods or standalone functions. The important behavior is the
same:

```typescript
function map<T, E, U>(result: Result<T, E>, transform: (value: T) => U): Result<U, E> {
  return result.ok ? ok(transform(result.value)) : result;
}

function mapErr<T, E, F>(result: Result<T, E>, transform: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(transform(result.error));
}

function andThen<T, E, U>(result: Result<T, E>, next: (value: T) => Result<U, E>): Result<U, E> {
  return result.ok ? next(result.value) : result;
}
```

Use Zod safeParse at a raw-input boundary, then keep expected validation failures on the error
rail:

```typescript
import { z } from 'zod';

const TaskInputSchema = z.object({
  title: z.string().trim(),
});

type TaskInput = z.infer<typeof TaskInputSchema>;

type CreateTaskError = { readonly kind: 'invalid-input'; readonly message: string } | { readonly kind: 'empty-title' };

function parseTaskInput(input: unknown): Result<TaskInput, CreateTaskError> {
  const parsed = TaskInputSchema.safeParse(input);

  if (!parsed.success) {
    return err({ kind: 'invalid-input', message: parsed.error.message });
  }

  return ok(parsed.data);
}

function requireTitle(input: TaskInput): Result<TaskInput, CreateTaskError> {
  return input.title.length === 0 ? err({ kind: 'empty-title' }) : ok(input);
}

function validateTaskInput(input: unknown): Result<TaskInput, CreateTaskError> {
  return andThen(parseTaskInput(input), requireTitle);
}
```

Any validation error follows the error rail automatically; a caller does not need to remember a
separate try/catch after every step. At a layer boundary, map a domain error into the error shape
the next layer understands, just as data is mapped between layers.

## Grouping, not concealment

Prefer grouping code by the concept and reason it changes over hiding behavior behind a large
object with opaque internal state.

- Group structures, ports, validation, and behavior that form one domain concept.
- Keep dependencies visible in constructors and function parameters.
- Use private members to protect a small local invariant, not to conceal business behavior a
  test or reader must understand.
- Avoid utility classes or service registries that turn related code into a hidden global.

## Quick checklist

### Immutability

- [ ] Functions do not mutate input values.
- [ ] Structures use readonly properties and readonly arrays where appropriate.
- [ ] Updates return a replacement value.

### Pure functions

- [ ] Domain calculations depend only on explicit inputs.
- [ ] IO is confined to adapters and entry-level orchestration.

### Total functions

- [ ] Expected failure is represented in a return type, not thrown.
- [ ] The signature honestly describes every routine outcome.

### Railway-oriented programming

- [ ] Results compose through map, andThen, and mapErr equivalents.
- [ ] Errors are mapped at layer boundaries.
- [ ] Raw input is parsed with Zod before it enters the domain.

### Grouping

- [ ] Related code lives together by reason to change.
- [ ] Dependencies remain visible.
- [ ] No hidden mutable state determines a result.

## Language guidance

See [Functional Practices in TypeScript/Bun](languages/typescript.md) for TypeScript-specific
conventions and the current repository reality.

## Related articles

- [Software Design Philosophy](../software-design-philosophy/index.md)
- [SOLID Principles](../solid-principles/index.md)
- [Domain-Driven Design](../domain-driven-design/index.md)
- [Three-Layer Architecture](../three-layer-architecture/index.md)
- [Stateless OOP and Dependency Injection](../stateless-oop-di/index.md)
- [Utilities](../utilities/index.md)
