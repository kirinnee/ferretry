---
id: validation
title: Data Validation
---

# Data Validation

Every input from outside the process is untrusted: argv, environment variables, file contents,
HTTP bodies, another process's stdout. This page defines where that input becomes trustworthy,
what belongs in that check, and what does not.

This article builds on [Three-Layer Architecture](../three-layer-architecture/index.md) and
[Functional Practices](../functional-practices/index.md). Validation happens at layer boundaries,
and validation failures are errors that follow the error-handling conventions.

---

## Parse, Don't Validate

The single rule everything else follows from.

A **validator** answers a question and throws the answer away — the caller is left holding the
same untyped value plus a promise that it is fine:

```typescript
// WRONG - the check and the value are separate; the type learned nothing
if (!isValidPort(raw)) throw new Error('bad port');
startServer(raw); // still `string`. Is it checked? Who knows, three calls down.
```

A **parser** answers the question by producing a new value whose _type_ carries the answer:

```typescript
// RIGHT - after this line, `port` cannot be invalid; the type says so
const port = PortSchema.parse(raw); // number, 1..65535
startServer(port);
```

The difference is what happens six months later. A validated value can be passed to a function
that never re-checks it, and nothing catches the mistake. A parsed value cannot: the wrong type
does not compile. Parsing pushes the check to a single place and makes the rest of the program
structurally unable to see unchecked data.

Practical consequence: **the boundary returns domain types, not raw input.** If a function
signature accepts `unknown`, `string`, or `Record<string, unknown>` and then checks it, the parse
happened in the wrong place.

---

## Why Use a Validation Library

### Less boilerplate

Hand-rolled checks are verbose, easy to get wrong, and teach the type system nothing:

```typescript
// Manual validation - lots of boilerplate, and `input` is still `unknown` afterwards
function validateUser(input: unknown): User {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Invalid input');
  }
  const candidate = input as Record<string, unknown>;
  if (typeof candidate.name !== 'string' || candidate.name.length < 2) {
    throw new Error('Name must be at least 2 characters');
  }
  if (typeof candidate.email !== 'string' || !candidate.email.includes('@')) {
    throw new Error('Invalid email');
  }
  // ...and every field after this one
  return input as User; // an assertion, i.e. a promise the compiler cannot check
}
```

Declarative is shorter and ends with a real type:

```typescript
const UserSchema = z.object({
  name: z.string().min(2),
  email: z.email(),
});

const user = UserSchema.parse(input); // throws on invalid, returns a typed User
```

### Fewer tests

Validation libraries are battle-tested. Do not write tests asserting that:

- Email or URL format checking works
- `min`/`max` constraints are enforced
- Required fields are required
- Coercion handles edge cases

Test **your** schema's shape and **your** custom refinements. Testing the library is noise that
will fail on its next upgrade for no reason.

### Types that cannot drift

Infer the type from the schema so there is exactly one definition:

```typescript
const UserSchema = z.object({
  name: z.string(),
  age: z.number().int().positive(),
});

type User = z.infer<typeof UserSchema>; // { name: string; age: number }
```

Never write the interface _and_ the schema by hand. The moment they exist separately, they
diverge, and the type will be the one that lies.

---

## Validation at Boundaries

Parse at the edge, once, and hand domain types inward:

```text
argv / env / file / socket → [parse] → controller → domain
```

In this repository that edge is concrete: a command's **controller** takes raw arguments from
commander and parses them with a schema before doing anything else. That is the seam described in
[Three-Layer Architecture](../three-layer-architecture/index.md) — `bin/` wires, the controller
parses, `src/lib/` only ever sees values that are already correct.

### What to parse at the boundary

- **Presence** — required fields
- **Format** — email, URL, identifier shape, date format
- **Range** — numeric bounds, string length, array length
- **Type** — including coercion of the strings that argv and env always give you
- **Structure** — nested objects, arrays, discriminated unions

### What not to parse at the boundary

- **Business rules** — those are domain invariants
- **Cross-entity consistency** — needs more than the input
- **Existence checks** — "does this session id exist" is a lookup, not a parse

### Domain invariants

Business rules live in the domain, enforced by the type that owns them. A domain type is
constructed through a factory that cannot return an invalid instance:

```typescript
export class Budget {
  private constructor(readonly cents: number) {}

  static create(cents: number): Budget {
    // A domain rule, not an input format rule: it holds however the number arrived.
    if (cents < 0) throw new DomainError('budget cannot be negative');
    return new Budget(cents);
  }
}
```

The private constructor is the point. If any caller can write `new Budget(-1)`, the invariant is
a suggestion.

### Input validation vs domain invariants

| Aspect       | Input validation                      | Domain invariants                       |
| ------------ | ------------------------------------- | --------------------------------------- |
| Location     | The boundary (controller, adapter)    | Domain constructors and methods         |
| Purpose      | Make external input trustworthy       | Keep business rules true                |
| Examples     | Required field, numeric range, format | Balance ≥ 0, legal status transitions   |
| Triggered by | A malformed request                   | A request that is well-formed but wrong |
| Enforced by  | A schema                              | Domain code                             |

Both are real, and neither substitutes for the other. A schema cannot know that a task may not
move from `done` back to `running`; the domain cannot know that `--limit banana` was never a
number.

---

## Validation Patterns

### Schema parsing

Define the schema, parse the input, use the result:

```typescript
const CreateTaskSchema = z.object({
  title: z.string().min(1).max(200),
  labels: z.array(z.string()).max(10).default([]),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
});

const task = CreateTaskSchema.parse(rawArgs);
```

### Coerce, then parse

Argv and environment variables are always strings. Coerce inside the schema so the boundary is
the only place that knows this:

```typescript
const ListOptionsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().max(100).default(20),
  query: z.string().trim().optional(),
});

// { page: '2', limit: '50' } -> { page: 2, limit: 50, query: undefined }
```

Coercion is a parse, not a validate: the output type is `number`, so nothing downstream can be
handed the string.

### Cross-field rules

Some constraints involve two fields at once and still belong at the boundary, because they are
about the _shape of the request_ rather than about the domain:

```typescript
const RangeSchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
  })
  .refine(range => range.from <= range.to, {
    message: 'from must not be after to',
    path: ['to'],
  });
```

If the rule needs to know anything beyond the input itself, it is a domain rule, not a
refinement.

---

## Error Messages

A parse failure is a message to a human who is trying to get something done. It must say what
was wrong and what to do instead.

For the CLI, that means a message on **stderr** and a **non-zero exit code** — never a stack
trace, and never a raw dump of the library's internal error object:

```text
$ fy task create --limit banana
error: --limit must be a whole number (got "banana")
```

Guidelines:

- **Name the field.** "validation failed" tells the operator nothing.
- **Show what was received**, quoted, so a shell-quoting mistake is visible.
- **Say what is acceptable**, not just that the input was not.
- **Report every failure at once** where you can. A schema knows about all the bad fields on the
  first pass; making the operator rerun once per mistake is needless.
- **Do not leak internals.** Field paths and constraints, yes; class names, file paths, and
  stack frames, no.
- **Be consistent.** One formatter for parse failures, used by every command.

The same rules apply to any wire surface: report the failing paths and their messages in a
predictable structure, so a client can present them per-field rather than as one opaque string.

```json
{
  "errors": {
    "title": ["must be at least 1 character"],
    "labels[3]": ["must be a string"]
  }
}
```

Exit codes and error types are the subject of
[Functional Practices](../functional-practices/index.md); the rule here is only that a parse
failure is reported as a parse failure — distinguishable from a domain rule violation and from a
crash.

---

## Quick Checklist

**Boundary parsing:**

- [ ] Every external input parsed at the boundary it enters through
- [ ] The boundary returns domain types, never raw input
- [ ] Required fields, formats, ranges, and structure covered by the schema
- [ ] Strings from argv/env coerced inside the schema
- [ ] Types inferred from the schema, never written twice

**Domain invariants:**

- [ ] Business rules live in the domain, not the schema
- [ ] Domain types are constructed through factories that cannot produce an invalid instance
- [ ] Domain rule violations are distinguishable from input parse failures

**Errors:**

- [ ] Field-specific and actionable
- [ ] All failures reported in one pass
- [ ] No stack traces, no internal structure
- [ ] One formatter, used by every command

**General:**

- [ ] Parse, don't validate
- [ ] Use the library; don't hand-roll checks
- [ ] Don't test the library's own validators

---

## Language Implementations

- [Validation in TypeScript](languages/typescript.md) — Zod schemas, parsing, inference, and the
  controller boundary

## Related Articles

- [Three-Layer Architecture](../three-layer-architecture/index.md) — where the boundary is
- [Functional Practices](../functional-practices/index.md) — how failures are represented and returned
- [Domain-Driven Design](../domain-driven-design/index.md) — domain types and their invariants
- [Date/Time Handling](../datetime/index.md) — parsing date and duration inputs
- [Testing Conventions](../testing/index.md) — what to test at a schema boundary
