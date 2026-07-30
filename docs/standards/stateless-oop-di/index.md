---
id: stateless-oop-di
title: Stateless OOP and Dependency Injection
---

# Stateless OOP and Dependency Injection

Traditional object-oriented code often bundles data, behavior, and mutable state into one
object. That hides dependencies, creates surprising side effects, and makes change harder than
it needs to be. In Ferretry, separate **structures** (data) from **objects** (behavior), then
wire collaborators through **constructor injection**.

This standard builds on [Software Design Philosophy](../software-design-philosophy/index.md),
[SOLID Principles](../solid-principles/index.md), and
[Functional Practices](../functional-practices/index.md). Functional constraints such as
immutability, pure functions, total functions, and railway-oriented programming complement the
patterns here: they constrain what the behavior is allowed to do.

## Structures and objects

Every unit of code should have a clear role. Mixing data, collaborators, and mutable instance
state is the usual source of hidden coupling.

### Structures are pure data

Structures represent facts and values. They are immutable, serializable, and easy to inspect.

```typescript
export interface TaskRecord {
  readonly title: string;
  readonly state: 'queued' | 'active' | 'done';
}

export interface SessionTask {
  readonly id: string;
  readonly record: TaskRecord;
}
```

Structures flow through the system: they can cross a process boundary, be stored, be logged, and
be passed between layers without carrying hidden behavior.

Rules for structures:

- Do not put side effects or service references on them.
- Do not mutate them; construct a replacement value for an update.
- Use the most data-oriented construct the language provides. In TypeScript, that normally means
  a readonly interface or type.
- Keep their shape explicit at a boundary. Use Zod to parse unknown input into a trusted
  structure before domain code consumes it.

### Objects are stateless behavior

Objects are services and coordinators. Their members are readonly configuration or injected
dependencies, set once at construction time. A service may call an injected IO port, but it does
not own mutable per-request or per-command state.

```typescript
export interface TaskRepository {
  list(sessionId: string): Promise<readonly SessionTask[]>;
}

export interface TaskStatusFormatter {
  format(tasks: readonly SessionTask[]): string;
}

export class SessionStatusService {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly formatter: TaskStatusFormatter,
  ) {}

  async describe(sessionId: string): Promise<string> {
    const tasks = await this.tasks.list(sessionId);
    return this.formatter.format(tasks);
  }
}
```

Rules for objects:

- Members are readonly configuration values or readonly injected services.
- Methods do not modify the instance.
- State required to produce a result arrives through parameters and leaves through return values.
- Collaborators arrive through interfaces rather than being created inside a method.

The split has practical benefits:

- Structures travel freely and can be compared, logged, and tested without a running service.
- Objects are testable because every collaborator can be replaced with a double.
- Data shape and wiring can evolve independently.

This is the foundation for [SOLID Principles](../solid-principles/index.md) and
[Three-Layer Architecture](../three-layer-architecture/index.md).

## Stateless services

A stateless service receives every changing value through method parameters and return values.
Its instance contains no mutation history.

```typescript
export interface TaskSummary {
  readonly total: number;
  readonly completed: number;
}

export class TaskSummaryService {
  summarize(tasks: readonly SessionTask[]): TaskSummary {
    return {
      total: tasks.length,
      completed: tasks.filter(task => task.record.state === 'done').length,
    };
  }
}
```

Compare that with a stateful accumulator:

```typescript
// Wrong: the result depends on the history of calls to add.
export class TaskAccumulator {
  private tasks: SessionTask[] = [];

  add(task: SessionTask): void {
    this.tasks.push(task);
  }

  summarize(): TaskSummary {
    return {
      total: this.tasks.length,
      completed: this.tasks.filter(task => task.record.state === 'done').length,
    };
  }
}
```

The accumulator's type signature conceals its real input: every earlier mutation. A stateless
service eliminates that temporal coupling. It is easier to test, safe to call concurrently, and
easier to debug because the arguments explain the result.

## Constructor injection

Pass collaborators at construction time. Constructor injection makes the dependency graph
visible, static, and replaceable.

Rules:

1. Every dependency appears in the constructor.
2. Do not create collaborators with new inside a service method.
3. Do not resolve collaborators through a service locator or ambient context.
4. Do not put dependency-owning business behavior in static methods; it bypasses injection.

```typescript
export interface AttentionMessage {
  readonly kind: 'attention';
  readonly body: string;
}

export interface AttentionPublisher {
  publish(message: AttentionMessage): Promise<void>;
}

export interface AttentionTemplate {
  render(body: string): AttentionMessage;
}

export class AttentionNotifier {
  constructor(
    private readonly publisher: AttentionPublisher,
    private readonly template: AttentionTemplate,
  ) {}

  async notify(body: string): Promise<void> {
    await this.publisher.publish(this.template.render(body));
  }
}
```

The constructor tells a reader exactly what the service needs. Tests can pass fakes, production
can pass adapters, and decorators such as tracing or retries can wrap a port at the composition
root without changing the service.

Simple data objects may be constructed inside a method. The restriction is about creating
collaborators such as repositories, HTTP clients, terminal adapters, or loggers where their
configuration and behavior would otherwise be hidden.

## Wire at the composition root

The composition root is the one place that constructs adapters and services. For the current CLI,
that is packages/cli/bin/fy.ts: it builds a CliWorld from terminal and system adapters, then
hands that world to registerDomain.

```typescript
const io = new ConsoleIo();
const world: CliWorld = {
  io,
  spinner: new OraSpinner(),
  progress: new CliProgressBar(),
  prompt: new InquirerPrompt(),
  shell: new BunShell(),
  interactive: io.interactive(),
};

registerDomain(program, world);
```

When a domain command is added, compose its repository adapters, domain services, and controller
there rather than letting a controller discover them at runtime. The dependency graph should be
a tree wired once for an invocation, not a mutable web of global registrations.

Wiring at the root means:

- The full dependency graph is visible in one place.
- Dependencies are ready before logic runs.
- Tests and alternate environments can swap implementations without changing domain behavior.

## Quick checklist

### Structures and objects

- [ ] Structures are readonly data with no side effects or service references.
- [ ] Services hold only readonly configuration and injected dependencies.
- [ ] Changing state flows through method parameters and return values.

### Stateless services

- [ ] No service has mutable instance state.
- [ ] All instance members are set at construction and remain readonly.
- [ ] A method result never depends on an earlier method call unless that state is passed in.

### Constructor injection

- [ ] Every collaborator appears in the constructor.
- [ ] No method constructs a repository, client, or adapter for itself.
- [ ] No service locator or ambient context hides the dependency graph.
- [ ] External dependencies have explicit interfaces.

### Composition root

- [ ] Constructors for adapters and services are concentrated at the entry point.
- [ ] The graph is wired once and not changed at runtime.
- [ ] Swapping an implementation changes the composition root, not the service.

## Language guidance

See [Stateless OOP with DI in TypeScript/Bun](languages/typescript.md) for the TypeScript shape
used by this repository.

## Related articles

- [Software Design Philosophy](../software-design-philosophy/index.md)
- [SOLID Principles](../solid-principles/index.md)
- [Functional Practices](../functional-practices/index.md)
- [Domain-Driven Design](../domain-driven-design/index.md)
- [Three-Layer Architecture](../three-layer-architecture/index.md)
- [Repository Architecture](../architecture/index.md)
