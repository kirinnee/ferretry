---
id: utilities
title: Utility Libraries
---

# Utility Libraries

Utilities reduce repeated, low-value implementation work for collections, strings, objects,
functions, parsing, and error handling. The goal in Ferretry is not to collect dependencies; it
is to use a small, well-understood utility catalog so product code stays focused on sessions,
tasks, attention, and fleet behavior.

This standard builds on [Software Design Philosophy](../software-design-philosophy/index.md):
write less bespoke plumbing when a native feature, existing dependency, or shared utility already
solves the problem clearly.

## Current repository reality

The CLI package currently has no general-purpose collection or functional utility dependency.
Its relevant utility surface is:

- Native JavaScript and TypeScript collection, string, object, and promise APIs.
- Zod, already installed in packages/cli, for parsing and validating unknown runtime input.
- packages/cli/src/lib/version.ts, which provides the focused isSemver and assertSemver helpers.

There is no shared Result, Option, collection, or string utility module today. Do not claim one
exists or introduce a new library merely because another project uses it. When a repeated
cross-cutting need appears, choose the smallest appropriate home and document the decision.

## Choose the smallest useful tool

Use this order:

1. **Native language or platform feature.** Prefer Array methods, Map, Set, Object helpers,
   URL, Intl, and standard promise primitives for straightforward work.
2. **An existing dependency.** Use Zod at raw-input boundaries instead of hand-rolling runtime
   parsing.
3. **A shared local utility.** If more than one domain needs the same product-neutral behavior,
   add a small module under packages/cli/src/lib with focused tests.
4. **A new external dependency.** Add one only when the behavior is genuinely complex,
   maintained externally, and not adequately covered above.

Avoid a local helper when it has one call site. Avoid a new dependency when one clear native
expression will do. Prefer a small shared module over duplicating the same error/result or
normalization logic across features.

## Native examples

Native methods are readable for common collection work:

```typescript
interface SessionTask {
  readonly id: string;
  readonly title: string;
  readonly state: 'queued' | 'active' | 'done';
}

function describeTasks(tasks: readonly SessionTask[]): {
  readonly activeTasks: SessionTask[];
  readonly titles: string[];
  readonly completedCount: number;
  readonly tasksById: Map<string, SessionTask>;
} {
  const activeTasks = tasks.filter(task => task.state === 'active');
  const titles = tasks.map(task => task.title);
  const completedCount = tasks.reduce((count, task) => count + (task.state === 'done' ? 1 : 0), 0);
  const tasksById = new Map(tasks.map(task => [task.id, task]));

  return { activeTasks, titles, completedCount, tasksById };
}
```

Name an extracted transform when it communicates domain intent. Do not wrap a one-line map or
filter in an abstraction that is harder to read than the native operation.

## Utility categories

### Collections

| Operation                              | Prefer                                                                           |
| -------------------------------------- | -------------------------------------------------------------------------------- |
| map, filter, reduce, find, some, every | Native array methods                                                             |
| lookup by stable key                   | Map                                                                              |
| unique primitive values                | Set                                                                              |
| grouping, chunking, deep transforms    | A focused local or approved external utility when native code is no longer clear |
| sorting                                | A copied array plus sort, so the input remains unchanged                         |

### Strings and identifiers

| Operation                                         | Prefer                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------- |
| trim, split, join, replace, includes              | Native string methods                                                   |
| user-facing formatting                            | Intl where locale behavior matters                                      |
| validation and normalization at an input boundary | Zod schema plus a named domain transform                                |
| product and binary names                          | Derive from package metadata; never create a duplicate utility constant |

### Objects

| Operation                          | Prefer                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| keys, values, entries, fromEntries | Native Object helpers                                                             |
| shallow immutable update           | Object spread                                                                     |
| deep merge or clone                | First question whether the design needs it; use a reviewed helper only if it does |
| unknown object input               | Zod parse or safeParse                                                            |

### Functions and errors

| Operation                                | Prefer                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| straightforward composition              | Small named functions and native promise chaining                            |
| retries, debounce, throttle, memoization | A focused helper only when a concrete boundary needs it                      |
| expected operation failure               | A shared Result or Option module under src/lib once multiple domains need it |
| unexpected failure                       | Let the entry boundary catch, report, and set an exit code                   |

## Share utility code deliberately

A shared utility must be product-neutral, small, and independently testable. A task-specific
transform belongs with the task domain, even if it is only a few lines. A generic helper belongs
under src/lib only when it has a clear contract and more than one consumer.

For example, a future Result module should define one canonical Result<T, E> shape and its
combinators. It should not be introduced as a hidden dependency inside one controller. See
[Functional Practices](../functional-practices/index.md) for the behavior expected from that
module.

Test custom utilities at their public contract. Do not retest the implementation of a maintained
third-party package; test the product behavior built with it instead.

## Adding an external dependency

No generic utility package is currently prescribed for Ferretry. If a new one is justified:

- Choose an ESM-compatible package with a focused, maintained API.
- Install it from the owning workspace, never from the repository root.
- Import only the operations used by the package so the dependency surface remains explicit.
- Check whether its operations mutate inputs; preserve the immutability rules in
  [Functional Practices](../functional-practices/index.md).
- Add the dependency's behavior to the appropriate tests and keep the lockfile current.

```bash
cd packages/cli
direnv exec . bun add <approved-esm-utility>
```

The placeholder is intentional: choose a package only in the change that proves a real need.
This repository does not currently vendor one.

## Quick checklist

### Before adding a utility

- [ ] A native feature does not express the behavior clearly enough.
- [ ] Zod is not already the correct parser or validator.
- [ ] The helper has more than one consumer, or it belongs clearly to one domain instead.
- [ ] The behavior is small enough to explain and test.

### When using utilities

- [ ] Import only the operation that is needed.
- [ ] Preserve immutability; do not pass a caller-owned value to a mutating helper.
- [ ] Keep domain-specific transforms in their domain.
- [ ] Use one shared Result or Option shape rather than local variants.
- [ ] Test business behavior and custom utility contracts, not a package's internal algorithms.

## Language guidance

See [Utilities in TypeScript/Bun](languages/typescript.md) for package-specific guidance and the
actual utility inventory in the CLI today.

## Related articles

- [Software Design Philosophy](../software-design-philosophy/index.md)
- [Functional Practices](../functional-practices/index.md)
- [Testing](../testing/index.md)
- [Domain-Driven Design](../domain-driven-design/index.md)
