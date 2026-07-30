---
id: domain-driven-design-typescript
title: Domain-Driven Design in TypeScript
---

# Domain-Driven Design in TypeScript

The concrete TypeScript/Bun realisation of the language-agnostic
[Domain-Driven Design](../index.md) contract. The doctrine — domain-first code, Records /
Principals / Models, the CRUD blessed path — lives in the parent document; this guide shows how it
lands in Ferretry's `packages/cli` layout.

## Folder Structure

The domain lives under `src/lib/`; all IO lives under `src/adapters/`. This mirrors
[Three-Layer Architecture](../../three-layer-architecture/index.md): `src/lib/` is pure, and
`scripts/validate/cli-contracts.sh arch` fails the build if terminal or shell IO leaks into it.

```text
packages/cli/
  bin/
    fy.ts                 # Composition root: createProgram/buildWorld/registerDomain
  src/
    lib/                  # Pure domain code (no console, no process.*, no adapters/ imports)
      blog/               # Bounded context (illustrative)
        post/
          structures.ts   # PostRecord, PostPrincipal, Post
          interfaces.ts   # IPostService, IPostRepository
          service.ts      # PostService implementation
          errors.ts       # PostNotFound, PostValidationError
        author/
          structures.ts
          interfaces.ts
          service.ts
      identity/           # Different bounded context (illustrative)
        user/
          structures.ts
          interfaces.ts
          service.ts
    adapters/             # Impure code — all IO
      terminal/           # Real today: ICliIo, ISpinner, IProgressBar, IPrompt
      system/             # Real today: IShellRunner (Bun $)
```

> The `blog/` and `identity/` contexts above are **illustrative** — they teach the folder shape,
> not Ferretry's actual domain. At P0 `src/lib/` holds only small pure helpers (for example
> `version.ts`), and the real adapters that exist today are `terminal/` and `system/`. Add domain
> contexts under `src/lib/` as the product grows.

## Record (Pure Data, No Identity)

```typescript
// src/lib/blog/post/structures.ts (illustrative)
interface PostRecord {
  title: string;
  description: string;
  tags: string[];
}

interface AuthorRecord {
  name: string;
  // Dates are modelled as domain-neutral values here. Pick a real representation per the
  // datetime standard; do not reach for a date library that is not a dependency.
  dateOfBirth: string; // ISO-8601 calendar date, e.g. "1990-04-01"
}
```

## Multiple Records per Entity

When an entity has fields with different update rates, split into multiple Records:

```typescript
// src/lib/identity/user/structures.ts (illustrative)

// Frequently changed by user
interface UserRecord {
  displayName: string;
  bio: string;
  avatarUrl: string;
}

// Locked at creation, never changes
interface UserImmutableRecord {
  email: string;
  createdAt: string; // ISO-8601 instant, system-assigned at signup
}

// Updated by external sync, infrequent
interface UserSyncRecord {
  stripeCustomerId: string;
  githubId?: string; // Optional — not all users have linked GitHub
  lastSyncAt: string; // ISO-8601 instant
}
```

## Principal (Record + Identity)

**Single Record:**

```typescript
interface PostPrincipal {
  id: string;
  record: PostRecord;
}

interface AuthorPrincipal {
  id: string;
  record: AuthorRecord;
}
```

**Multiple Records:**

```typescript
interface UserPrincipal {
  id: string;
  record: UserRecord; // Mutable profile
  immutable: UserImmutableRecord; // Create-only
  sync: UserSyncRecord; // Externally synced
}
```

## Model (Assembled View)

```typescript
interface Post {
  principal: PostPrincipal;
  author: AuthorPrincipal;
}

interface Author {
  principal: AuthorPrincipal;
  posts: PostPrincipal[];
}
```

## Service Interface (CRUD Blessed Path)

> Result type library to be determined. See [Functional Practices](../../functional-practices/index.md)
> for the railway-oriented error-handling direction.

```typescript
// src/lib/blog/post/interfaces.ts (illustrative)
interface IPostService {
  search(params: PostSearch): Promise<PostPrincipal[]>;
  get(id: string): Promise<Post | null>;
  create(record: PostRecord): Promise<Post>;
  update(id: string, record: PostRecord): Promise<Post | null>;
  delete(id: string): Promise<void>;
}
```

## Repository Interface (Same Shape)

```typescript
interface IPostRepository {
  search(params: PostSearch): Promise<PostPrincipal[]>;
  get(id: string): Promise<Post | null>;
  create(record: PostRecord): Promise<Post>;
  update(id: string, record: PostRecord): Promise<Post | null>;
  delete(id: string): Promise<void>;
}
```

## Search Params

```typescript
interface PostSearch {
  titleContains?: string;
  tags?: string[];
  limit: number;
  offset: number;
}
```

## Domain Errors

```typescript
// src/lib/blog/post/errors.ts (illustrative)
interface PostNotFound {
  readonly kind: 'post-not-found';
  readonly id: string;
}

interface PostValidationError {
  readonly kind: 'post-validation-error';
  readonly field: string;
  readonly reason: string;
}

type PostError = PostNotFound | PostValidationError;
```

Errors are plain structures rather than exception subclasses: callers can carry them through a
Result-style value, and the no-subclassing corollary remains intact.

## Command Boundaries in the CLI

The CLI has no HTTP layer; its "API layer" is the command controller. Raw, untyped arguments
enter at that boundary and must be validated before they reach the domain:

- **Parse raw args with zod at the controller boundary.** A controller takes its collaborators as
  constructor ports (a Record/Principal domain would inject `IPostService` here), parses the raw
  argv with a zod schema, calls the domain with typed structures, and sets an exit code. `zod` is a
  real dependency of `packages/cli`; a date library is not.
- **The composition root wires the command.** `bin/fy.ts` owns `createProgram()` (the commander
  skeleton), `buildWorld()` (the production adapters), and `registerDomain(program, world)` — the
  single seam where a controller is constructed with its ports and attached to the program. The
  domain under `src/lib/` never imports from `bin/` or `adapters/`.

See [Three-Layer Architecture](../../three-layer-architecture/index.md) for the full account of the
seams the composition root wires together.
