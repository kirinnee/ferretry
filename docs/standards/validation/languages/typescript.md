---
id: validation-typescript
title: Validation in TypeScript
---

# Validation in TypeScript

The doctrine — parse don't validate, parse at boundaries, invariants in the domain — lives in
[Data Validation](../index.md). This page is the implementation guide for Zod in this repository.

## Library: Zod

Zod is a TypeScript-first schema library: schemas are values, and the static type is inferred
from the schema rather than declared beside it.

`zod` is **already a dependency of `packages/cli`** (v4). Import it and go:

```typescript
import { z } from 'zod';
```

A package that needs it and does not have it installs it from inside its own directory — never
from the repository root, which would create a root `node_modules` that shadows the workspace
packages:

```bash
cd packages/<pkg> && bun add zod
```

> **This page targets Zod 4.** Several v3 idioms still exist but are deprecated, and two of them
> changed behaviour outright: the issue array is `error.issues` (not `error.errors`), and
> `z.record()` takes both a key and a value type. Snippets copied from v3 material will typecheck
> and then misbehave, so prefer the forms below.

## Schema Definition

### Primitives

```typescript
// Basic types
z.string();
z.number();
z.boolean();
z.bigint();
z.null();
z.undefined();
z.unknown();
z.any(); // avoid — it defeats the point

// String constraints
z.string().min(2);
z.string().max(100);
z.string().length(10);
z.string().regex(/^\d{5}$/);
z.string().trim();
z.string().toLowerCase();
z.string().startsWith('fy-');

// Number constraints
z.number().int();
z.number().positive();
z.number().nonnegative();
z.number().min(0);
z.number().max(100);
z.number().finite();

// Optional / nullable / defaulted
z.string().optional(); // string | undefined
z.string().nullable(); // string | null
z.string().nullish(); // string | null | undefined
z.string().default('fallback'); // never undefined on the output side
```

### String formats are top-level in v4

```typescript
z.email();
z.url();
z.uuid();
z.iso.date(); // '2024-03-15'
z.iso.time(); // '14:30:00'
z.iso.datetime(); // '2024-03-15T14:30:00Z'
z.iso.duration(); // 'PT2H30M'
```

The v3 method forms (`z.string().email()`, `z.string().uuid()`) still work but are deprecated.
Use the top-level functions.

### Coercion — and the boolean trap

argv and environment variables are strings. Coerce inside the schema so nothing downstream has
to know that:

```typescript
z.coerce.number(); // '42' -> 42
z.coerce.date(); // '2024-03-15' -> Date
```

**Never use `z.coerce.boolean()` for a flag or an env var.** It applies JavaScript's `Boolean()`,
so every non-empty string is `true` — including `"false"`, `"0"`, and `"no"`. Use `z.stringbool()`,
which parses the words:

```typescript
z.stringbool().parse('false'); // false
z.stringbool().parse('0'); // false
z.stringbool().parse('yes'); // true
```

### Objects

```typescript
const UserSchema = z.object({
  name: z.string(),
  email: z.email(),
  age: z.number().int().positive().optional(),
});

// Derive, don't redeclare
const PartialUserSchema = UserSchema.partial();
const NameOnlySchema = UserSchema.pick({ name: true });
const WithoutAgeSchema = UserSchema.omit({ age: true });
const AdminSchema = UserSchema.extend({ role: z.literal('admin') });
```

Unknown-key policy is chosen with the constructor, not a modifier:

```typescript
z.object({ name: z.string() }); // unknown keys stripped (the default)
z.strictObject({ name: z.string() }); // unknown keys are an error
z.looseObject({ name: z.string() }); // unknown keys passed through
```

Prefer `z.strictObject` for anything an operator hand-writes (a config file, a request body): a
typo'd key should be an error, not silently ignored. `.strict()` / `.passthrough()` /
`.merge()` are the deprecated v3 spellings of the above; `.extend()` replaces `.merge()`.

### Arrays and tuples

```typescript
z.array(z.string());
z.array(z.string()).min(1); // at least one element
z.array(z.string()).max(10);
z.array(z.string()).length(5);
z.array(z.string()).nonempty(); // narrows to [string, ...string[]]

z.tuple([z.string(), z.number()]); // [string, number]
```

### Unions, literals, enums

```typescript
z.union([z.string(), z.number()]);
z.string().or(z.number()); // shorthand

z.literal('active');
z.literal(42);

const StatusSchema = z.enum(['pending', 'running', 'completed']);
type Status = z.infer<typeof StatusSchema>; // 'pending' | 'running' | 'completed'

// Discriminated union — errors point at the right branch instead of listing all of them
const EventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('started'), at: z.iso.datetime() }),
  z.object({ kind: z.literal('failed'), reason: z.string() }),
]);
```

Always prefer `z.discriminatedUnion` over `z.union` when the members share a tag field. A plain
union reports every branch's failure; a discriminated union reports only the branch you meant.

### Records

`z.record()` requires **both** a key type and a value type in v4:

```typescript
z.record(z.string(), z.number()); // { [k: string]: number }
z.record(z.string().regex(/^\d+$/), z.boolean());
```

The one-argument v3 form does not carry the key type. Always pass two.

## Parsing

### `parse` — throws

Use at a boundary you control, where a throw is already the failure path:

```typescript
const user = UserSchema.parse(input); // ZodError on failure
```

### `safeParse` — returns a result

Use where you intend to format the failure yourself. This is the form the CLI uses, because a
parse failure has to become an operator-facing message rather than a stack trace:

```typescript
const result = UserSchema.safeParse(input);

if (!result.success) {
  const issues = result.error.issues; // NOTE: `.issues` in v4, not `.errors`
  // ...
} else {
  const user = result.data; // fully typed
}
```

### `parseAsync` / `safeParseAsync`

Required when any refinement is async:

```typescript
const user = await UserSchema.parseAsync(input);
```

A schema with an async refinement throws if parsed synchronously. Keep async refinements out of
schemas used on hot paths.

## Type Inference

```typescript
const UserSchema = z.object({
  name: z.string(),
  email: z.email(),
  page: z.coerce.number().default(1),
});

type User = z.infer<typeof UserSchema>;
// { name: string; email: string; page: number }

type UserInput = z.input<typeof UserSchema>;
// { name: string; email: string; page?: unknown } — before coercion and defaults
```

`z.infer` is the output type; `z.input` is what a caller may hand in. When a schema coerces or
defaults, these differ, and the function boundary should accept `z.input` and return `z.infer`.

## Transformations

```typescript
const SearchSchema = z.object({
  query: z.string().transform(q => q.toLowerCase().trim()),
  page: z.coerce.number().default(1),
  limit: z.coerce.number().default(20),
});

SearchSchema.parse({ query: '  HELLO  ' });
// { query: 'hello', page: 1, limit: 20 }
```

A transform is part of the parse: the output type reflects it, so the un-normalized form is
unreachable downstream. That is the whole point — don't normalize _after_ parsing, normalize
_in_ it.

## Refinements

```typescript
const PasswordSchema = z
  .string()
  .min(8)
  .refine(p => /[A-Z]/.test(p), 'must contain an uppercase letter')
  .refine(p => /[0-9]/.test(p), 'must contain a digit');
```

Cross-field rules refine the object and point the error at the field the operator should fix:

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

Always set `path`. Without it the issue attaches to the object root, and a per-field error
display has nowhere to put it.

## Formatting Errors

Zod 4 exposes three top-level formatters. `error.format()` and `error.flatten()` still exist but
are deprecated.

```typescript
const result = UserSchema.safeParse(input);
if (!result.success) {
  z.prettifyError(result.error);
  // ✖ Invalid input: expected string, received number
  //   → at name

  z.treeifyError(result.error);
  // { errors: [], properties: { name: { errors: ['Invalid input: ...'] } } }

  z.flattenError(result.error);
  // { formErrors: [...], fieldErrors: { name: [...] } }
}
```

Which to use:

| Formatter         | Use for                                                       |
| ----------------- | ------------------------------------------------------------- |
| `z.prettifyError` | Terminal output — it is already multi-line and human-readable |
| `z.treeifyError`  | Nested per-field display (a form, a structured API response)  |
| `z.flattenError`  | Flat per-field display, when the schema has no nesting        |
| `error.issues`    | Anything custom — the raw list of `{ code, path, message }`   |

## Integration Patterns

### The controller boundary (how the CLI does it)

One command is one controller class. It takes its ports through the constructor and parses raw
commander arguments before touching the domain. This is the only place in a command's path that
sees untyped input.

```typescript
import { z } from 'zod';

const ListArgsSchema = z.strictObject({
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.enum(['pending', 'running', 'completed']).optional(),
  json: z.boolean().default(false),
});

type ListArgs = z.infer<typeof ListArgsSchema>;

export class ListController {
  constructor(
    private readonly io: ICliIo,
    private readonly sessions: ISessionQuery, // a domain port — takes ListArgs, never `unknown`
  ) {}

  async run(raw: unknown): Promise<void> {
    const parsed = ListArgsSchema.safeParse(raw);
    if (!parsed.success) {
      // One formatter, every command: reason on stderr, non-zero exit.
      this.io.error(z.prettifyError(parsed.error));
      this.io.setExitCode(1);
      return;
    }

    const args: ListArgs = parsed.data;
    const rows = await this.sessions.list(args);
    this.io.success(render(rows, args.json));
  }
}
```

Registered on the program in `registerDomain`, which is the only scaffold↔domain seam:

```typescript
export function registerDomain(program: Command, world: CliWorld): void {
  program
    .command('list')
    .option('--limit <n>')
    .option('--status <status>')
    .option('--json')
    .action(opts => new ListController(world.io, buildSessionQuery(world)).run(opts));
}
```

Three properties follow from this shape, and all three are the reason for it:

1. **`ISessionQuery` never accepts raw input.** Its signature is `ListArgs`, so the domain is
   structurally unable to receive an unparsed value.
2. **Failure is reported once, uniformly.** Every controller formats parse failures the same way,
   so the CLI has one error voice rather than one per command.
3. **The controller is unit-testable without a terminal.** `io` is a double, `raw` is a plain
   object, and a bad-input test is three lines.

Note that commander hands the action callback whatever the user typed — every option value is a
string or `undefined`, whether or not the declared type says so. `z.coerce` is not optional
polish here; it is what makes `--limit 20` a number.

### An HTTP surface

The same rule with a different transport: parse the body at the handler, and turn issues into a
structured per-field response rather than one string.

```typescript
const CreateSchema = z.strictObject({
  title: z.string().min(1).max(200),
  labels: z.array(z.string()).max(10).default([]),
});

async function create(req: Request): Promise<Response> {
  const result = CreateSchema.safeParse(await req.json());

  if (!result.success) {
    return Response.json({ errors: z.treeifyError(result.error) }, { status: 400 });
  }

  const created = await service.create(result.data); // typed
  return Response.json(created, { status: 201 });
}
```

`packages/daemon` is a placeholder today, so this pattern is prescribed rather than in use — but
when `fyd` grows a wire surface, it parses at the handler with a strict object and returns
`z.treeifyError` output, exactly as above.

### Domain types with invariants

A schema makes input _well-formed_. A domain type makes it _legal_. Use both, in that order —
parse at the boundary, then construct the domain type from the parsed value.

```typescript
export class Email {
  private constructor(private readonly value: string) {}

  static create(raw: string): Result<Email, string> {
    const parsed = z.email().safeParse(raw);
    if (!parsed.success) return err('invalid email format');
    return ok(new Email(parsed.data));
  }

  get Value(): string {
    return this.value;
  }
}
```

> **Note:** `Result`, `ok`, and `err` above are placeholders — this repository has not adopted a
> Result type yet. See [Functional Practices](../../functional-practices/index.md) for the
> error-representation decision; until it is settled, a domain factory may throw a domain error
> instead, and the shape of this example is what matters.

## Testing Schemas

Test **your** schema and **your** refinements. Do not test Zod.

```typescript
describe('ListArgsSchema', () => {
  it('should coerce a string limit and apply defaults', () => {
    // Arrange
    const input = { limit: '5' };
    const expected = { limit: 5, json: false };

    // Act
    const actual = ListArgsSchema.parse(input);

    // Assert
    should(actual).deepEqual(expected);
  });

  it('should reject a limit above the maximum', () => {
    // Act
    const actual = ListArgsSchema.safeParse({ limit: '500' });

    // Assert
    should(actual.success).be.false();
  });

  it('should reject an unknown option', () => {
    // Act + Assert — strictObject means a typo is an error, not a no-op
    should(ListArgsSchema.safeParse({ limits: '5' }).success).be.false();
  });
});
```

Assert on `success` and on the parsed value. Asserting on Zod's message text couples the test to
the library's wording and will break on upgrade for no reason — assert on `issue.code` and
`issue.path` if a specific failure matters.

## Related Articles

- [Data Validation](../index.md) — the doctrine these snippets implement
- [Three-Layer Architecture](../../three-layer-architecture/index.md) — where the controller sits
- [Functional Practices](../../functional-practices/index.md) — representing and returning failures
- [Date/Time in TypeScript](../../datetime/languages/typescript.md) — parsing date and duration inputs
- [Testing in TypeScript](../../testing/languages/typescript.md) — the test style above
