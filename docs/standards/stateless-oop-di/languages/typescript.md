---
id: stateless-oop-di-typescript
title: Stateless OOP with DI in TypeScript/Bun
---

# Stateless OOP with DI in TypeScript/Bun

Ferretry is a Bun workspaces repository. The CLI composition root is
packages/cli/bin/fy.ts; its pure code belongs under packages/cli/src/lib and its IO adapters
belong under packages/cli/src/adapters. The examples below show the shape future domain code
should follow without claiming that the sample task command already ships.

## Folder shape

```text
packages/cli/
  bin/
    fy.ts                    # Composition root: creates CliWorld and registers domains
  src/
    lib/                     # Pure domain code; version.ts exists here today
      <domain>/
        structures.ts
        validation.ts
        rules.ts
    adapters/                # Terminal, system, and future process/network IO
      <domain>/
        repository.ts
        controller.ts
```

Keep a domain's structures, ports, and stateless behavior together by reason to change. The
current CLI only ships its scaffold and adapters; add a domain folder when a command actually
needs it.

## Structures are readonly data

Use Zod at an untrusted boundary, then pass an explicit readonly structure through the domain.

```typescript
import { z } from 'zod';

export const TaskRecordSchema = z
  .object({
    title: z.string().trim().min(1),
    state: z.enum(['queued', 'active', 'done']),
  })
  .readonly();

export type TaskRecord = z.infer<typeof TaskRecordSchema>;

export interface SessionTask {
  readonly id: string;
  readonly record: TaskRecord;
}
```

Use safeParse when invalid input is an expected user-facing condition. The controller can map a
Zod issue into its presentation error before it calls the domain. Do not pass unknown through
the domain and do not mutate the parsed structure.

## Boundary ports make dependencies explicit

Dependencies are interfaces owned by the consumer of the behavior, not concrete adapters hidden
inside it.

```typescript
export interface TaskRepository {
  findById(id: string): Promise<SessionTask | null>;
  save(task: SessionTask): Promise<void>;
}

export interface ActivityLog {
  info(message: string): void;
}
```

## A stateless boundary coordinator

Every member is readonly and every changing value is a parameter or return value.

```typescript
export class TaskService {
  constructor(
    private readonly repository: TaskRepository,
    private readonly log: ActivityLog,
  ) {}

  async create(record: TaskRecord): Promise<SessionTask> {
    const task: SessionTask = {
      id: crypto.randomUUID(),
      record,
    };

    await this.repository.save(task);
    this.log.info('created task ' + task.id);
    return task;
  }
}
```

The repository and log introduce IO, but the coordinator remains stateless: it has no mutable
instance field and no hidden collaborator. Keep transformations that need no IO as pure helpers
in src/lib; place IO coordination at the controller or composition boundary, and let adapters own
console, process, shell, and network behavior.

## Composition-root wiring

The CLI's existing composition root builds a CliWorld from its concrete adapters and passes it
to registerDomain. New command wiring belongs at that same seam.

```typescript
const world = buildWorld();
registerDomain(program, world);
```

For a future task command, construct its repository adapter and service in that root, then pass
the service to a controller. A controller must not construct a repository halfway through a
request, and a service must not reach for a global world object.

## Adapter implementations

Adapters implement the domain-owned port and are allowed to perform IO. They stay outside
src/lib.

```typescript
export class ConsoleActivityLog implements ActivityLog {
  info(message: string): void {
    console.log(message);
  }
}
```

The repository can be replaced with an in-memory fake in a unit test, a process-backed adapter
in an integration test, or a production adapter at runtime. The TaskService source does not
change.

## TypeScript rules

- Use readonly properties and readonly arrays for structures.
- Prefer interfaces and type aliases for data rather than classes with behavior and hidden
  fields.
- Use constructor parameter properties only when they are readonly.
- Let Zod parse raw input at a controller boundary; retain its typed output, not the unknown
  input.
- Keep IO-coordinating services at the controller or composition boundary; src/lib remains a
  pure domain layer.
- Keep expected failures in an explicit result type once the domain needs one. Ferretry does not
  currently vendor a shared Result or Option module, so add one reviewed module under src/lib
  rather than inventing incompatible local variants.
- Keep static methods free of dependency-owning business behavior. A dependency-free transform
  may be a standalone pure function when that is clearer.

## Related articles

- [Stateless OOP and Dependency Injection](../index.md)
- [Functional Practices](../../functional-practices/index.md)
- [Three-Layer Architecture](../../three-layer-architecture/index.md)
