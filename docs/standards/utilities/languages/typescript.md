---
id: utilities-typescript
title: Utilities in TypeScript/Bun
---

# Utilities in TypeScript/Bun

Use the Bun and TypeScript platform first. Ferretry's CLI currently depends on Zod for runtime
parsing and validation, and its only shared lib helper is the semver utility in
packages/cli/src/lib/version.ts. It does not currently include a general-purpose utility package
or a shared Result or Option module.

## Current catalog

| Need                                     | Current choice                                  |
| ---------------------------------------- | ----------------------------------------------- |
| Array transforms and searches            | Native Array methods                            |
| Keyed lookup and uniqueness              | Map and Set                                     |
| Object and string basics                 | Object and String methods                       |
| Runtime parsing of unknown input         | Zod                                             |
| Semver validation                        | isSemver and assertSemver in src/lib/version.ts |
| Generic Result or Option values          | Not shipped yet                                 |
| Generic collection or functional package | Not installed                                   |

Do not add an import for a package that is not in packages/cli/package.json. If a feature needs
one, make the dependency decision in that feature's change and install it from the CLI workspace.

## Native collection and object operations

For ordinary transforms, native code is clearer and keeps the dependency surface small.

```typescript
export interface SessionTask {
  readonly id: string;
  readonly title: string;
  readonly state: 'queued' | 'active' | 'done';
}

export function activeTaskTitles(tasks: readonly SessionTask[]): string[] {
  return tasks.filter(task => task.state === 'active').map(task => task.title);
}

export function indexTasks(tasks: readonly SessionTask[]): Map<string, SessionTask> {
  return new Map(tasks.map(task => [task.id, task]));
}

export function taskStates(tasks: readonly SessionTask[]): Set<SessionTask['state']> {
  return new Set(tasks.map(task => task.state));
}
```

Do not call sort directly on a caller-owned array because it mutates the array. Copy first.

```typescript
export function sortTasksByTitle(tasks: readonly SessionTask[]): SessionTask[] {
  return [...tasks].sort((left, right) => left.title.localeCompare(right.title));
}
```

Use Object.keys, Object.values, Object.entries, and Object.fromEntries for simple object
operations. Prefer object spread for shallow immutable updates.

## Zod is the boundary utility

Zod parses unknown input into trusted data. Prefer safeParse when invalid input is an expected
user-facing outcome.

```typescript
import { z } from 'zod';

const TaskInputSchema = z.object({
  title: z.string().trim().min(1),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
});

export type TaskInput = z.infer<typeof TaskInputSchema>;

export function parseTaskInput(
  input: unknown,
): { readonly ok: true; readonly value: TaskInput } | { readonly ok: false; readonly message: string } {
  const parsed = TaskInputSchema.safeParse(input);

  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: parsed.error.message };
}
```

This local discriminated union demonstrates a boundary result. If multiple domains need the same
behavior, replace repeated local shapes with one reviewed Result module under src/lib. Do not
claim that module exists before it is added.

## Strings, dates, and formatting

Use native String methods for trim, split, join, includes, replace, and simple normalization.
Use Intl for locale-aware presentation. Pass dates and timezones explicitly into a formatter
rather than reading the clock inside a pure domain transform.

```typescript
export function displayTaskCount(count: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(count) + ' tasks';
}
```

Keep parsing and product rules separate: Zod can establish that an input is a string, while a
domain function decides whether that string is a valid task title for the operation.

## Adding a package

An external utility package may be appropriate for a complex, repeated operation that native APIs
do not express clearly. No package is pre-approved or currently installed for that role.

When the need is proven:

```bash
cd packages/cli
direnv exec . bun add <approved-esm-utility>
```

- Run the install from packages/cli, never the monorepo root.
- Choose ESM-compatible imports and import only the functions used.
- Read the mutation semantics before passing in caller-owned values.
- Keep the package's use behind a small, clear domain or adapter boundary when appropriate.
- Update tests for the product behavior, not the package's internal implementation.

## Result and Option utilities

Ferretry does not currently vendor Result or Option types. Expected validation and operation
failures can use Zod safeParse or a local discriminated union until more than one domain needs a
shared abstraction. At that point, add a single module under packages/cli/src/lib that owns:

- the Result<T, E> and, if justified, Option<T> shapes;
- constructors and narrow predicates;
- map, mapErr, andThen, and match combinators;
- examples and unit tests for the public contract.

Do not define competing versions in each controller or adapter. See
[Functional Practices](../../functional-practices/index.md) for the behavior the shared module
must preserve.

## TypeScript checklist

- [ ] Start with native Array, Map, Set, Object, String, Promise, and Intl APIs.
- [ ] Use Zod for unknown input at a boundary.
- [ ] Copy before sorting or otherwise calling a mutating operation on caller-owned data.
- [ ] Put reusable, product-neutral code in src/lib only after a real shared need appears.
- [ ] Add packages inside packages/cli and import only the operations used.
- [ ] Keep one shared Result or Option implementation when the repository adopts one.

## Related articles

- [Utilities](../index.md)
- [Functional Practices](../../functional-practices/index.md)
- [Testing](../../testing/index.md)
- [Stateless OOP and Dependency Injection](../../stateless-oop-di/index.md)
