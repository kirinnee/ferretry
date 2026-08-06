---
id: solid-principles
title: SOLID Principles
---

# SOLID Principles

SOLID is the disciplined framework for managing dependencies, achieving low coupling and high
cohesion. These five principles -- and a set of corollaries -- tell you **when** to group things
together and **how** to keep groups independent from each other. They are the structural laws of
this repository.

This article builds on the foundational ideas in
[Software Design Philosophy](../software-design-philosophy/index.md) -- changeability as the goal,
locality as the core property, dependencies as the root problem, and the tension between coupling
and cohesion. Everything else in this repository's doctrine tree --
[Functional Practices](../functional-practices/index.md),
[Domain-Driven Design](../domain-driven-design/index.md),
[Three-Layer Architecture](../three-layer-architecture/index.md), and
[Stateless OOP with Dependency Injection](../stateless-oop-di/index.md) -- builds on top of these
principles.

---

## S -- Single Responsibility Principle (SRP)

> A class should have only one reason to change.

The word "responsibility" does not mean "one thing it does." A class that handles CRUD for a session
does four things, but they all change for the same reason. That is one responsibility.

### Reason to Change vs Rate of Change

There are two ways to think about cohesion:

**Reason to change (white-box):** This is the intrinsic property. Why would this code need to
change? What external force drives the change? A protocol version bump? A new command flag? A
storage-format migration?

**Rate of change (black-box):** This is the observable metric. How often does this code change? Does
it change on the same commits as other code?

Rate of change is easier to observe -- you can measure it from git history. But reason to change is
the underlying truth. We observe rate of change because it reveals reason to change. If two pieces
of code change on the same commits over and over, they probably share a reason to change.

### Corollary: Zero Private Methods

Code in this repository has **zero private methods**. Every private method is a hidden dependency.
Hidden dependencies impede testability. Extract helpers as injectable services instead. This
corollary is doctrine in this repository, and it is enforced in examples throughout: no example in
these standards uses a `private` method.

---

## O -- Open-Closed Principle (OCP)

> Software entities should be open for extension, but closed for modification.

OCP means you can change what the system does without changing the code that already exists. It is
about **parameterization** -- making the moving parts configurable rather than hardcoded.

### The Spectrum of Openness

```typescript
// Fully closed -- hardcoded behavior
function addClosed();
return 3 + 5;

// Opened one level -- parameterized input
function addOpened(a, b);
return a + b;

// Opened further -- parameterized behavior
function addEvenMoreOpened(a, b, combine);
return combine(a, b);
```

### Why OOP, Not Higher-Order Functions

Functional style is **too powerful and too free**. When every argument can be a function of
functions, anyone can do anything in any order. OOP provides a **more restricted framework** --
interfaces standardize what is opened up and how it is opened. `IVersionControl` tells you something
that `(string) -> void` does not.

Methods should always take value-types as arguments. If a method needs behavior, the constructor
should receive another object -- an interface with a name, a contract, and a testable identity.

### Classes as Config/DI Containers

Class members are **only** one of two things:

1. **Configuration values** -- immutable data set at construction time.
2. **Injected services** -- interfaces provided at construction time.

No mutable state. No fields that change after construction.

```typescript
class Enricher
  constructor(
    client: IClient,          // injected service
    encryptor: IEncryptor,    // injected service
    logger: ILogger,          // injected service
    config: EnricherConfig    // configuration
  )

  enrich(data: InputData) -> Result<OutputData>
    // use this.client, this.encryptor, this.logger, this.config
    // but never mutate them
```

---

## L -- Liskov Substitution Principle (LSP)

> Subtypes must be substitutable for their base types without altering the correctness of the
> program.

LSP is a **constraint** on how you implement interfaces. Every implementation must honor the full
contract -- including implicit behavioral promises.

Classes model **concepts**, not instances. Design-time hierarchies are about **behavioral
contracts**. Runtime instances are about **data conformance**. Do not conflate them.

### Corollary: No Subclassing

This repository discourages subclassing (`extends`). Implement interfaces instead. Concrete
inheritance smuggles in a hidden dependency on a base class's implementation details and its
call-ordering assumptions; an interface names a contract without dragging its implementation along.
This corollary is doctrine in this repository.

---

## I -- Interface Segregation Principle (ISP)

> No client should be forced to depend on methods it does not use.

ISP governs **interface design** from the consumer's perspective. Design interfaces for **how users
use them**, not for how implementations are structured.

Different from SRP: SRP would not separate `push` from `pop` on a stack (same reason to change). But
ISP would if a client only pushes:

```typescript
interface Pusher
  push(item) -> void

interface Popper
  pop() -> Item

class Stack implements Pusher, Popper
  push(item) -> void
  pop() -> Item
```

---

## D -- Dependency Inversion Principle (DIP)

> High-level modules should not depend on low-level modules. Both should depend on abstractions.

DIP is the **core binding principle**. Without DIP, all the other principles are theoretical.

```text
A -> B           // A breaks when B changes

A -> X <- B      // X is an interface; A and B are decoupled
```

This pattern is the origin of everything:

- **ISP** exists because `X` should be minimal.
- **LSP** exists because `B` must honor `X`'s contract.
- **OCP** is achieved because behavior is swappable behind `X`.
- **SRP** is enforceable because `X` defines a focused contract.

### Visible + Fixed

A dependency is **visible** when you can see everything the code needs by looking at its signature
-- the constructor for a class, the parameters for a function. You should not need to open the
method body to discover hidden dependencies.

A dependency is **fixed** when it is immutable after construction. The reference never changes. The
behavior never changes.

```typescript
// WRONG -- not visible, not fixed
class OrderService
  processOrder(order)
    Logger.log("Processing order")    // hidden dependency on Logger
    return Database.query(...)        // hidden dependency on Database
```

```typescript
// RIGHT -- visible and fixed
class OrderService
  constructor(logger: ILogger, db: IDatabase)
    this.logger = logger   // visible in constructor, fixed reference
    this.db = db           // visible in constructor, fixed reference

  processOrder(order)
    this.logger.log("Processing order")
    return this.db.query(...)
```

---

## No Singletons

If everything is a class, everything is injectable. If everything is injectable, everything is
swappable. Nothing is hardwired.

### Rules

- **No static methods** that contain business logic.
- **No singletons.** Create instances at the entry point and inject them.
- **No global state.** Values flow through the dependency tree.

A static method cuts through the DI tree. You cannot swap it for a silent logger in tests, a
structured logger in production, or a per-module logger.

```text
// WRONG -- static global
static Logger.log("User logged in")    // decree from the universe

// RIGHT -- injected collaborator
class UserService
  constructor(logger: ILogger)

  login(user: User) -> Result<Session>
    this.logger.log("User logged in")  // request to a collaborator
```

### The one exception: a value a framework needs at module load

**Settled: a module-level instance is permitted when a framework needs the value before the
composition root can run, and only under all four conditions below.** The question is real -- React
resolves a component's default props at module load, which is strictly earlier than any context
exists -- so this is the answer rather than a judgement call per pull request.

1. **A framework forces the timing.** The value is needed at module evaluation, before the
   composition root has run. "It was convenient" and "everything already imports it" are not this
   condition.
2. **It stays injectable.** Every consumer can be handed a different instance, and the tests do. This
   is the property "no singletons" exists to protect, and it must be completely present -- a module
   default is a default binding, not a hardwiring.
3. **Whatever owns its lifecycle holds a reference to it.** A module-level instance is invisible to
   the object graph, so anything that must invalidate, reset, or dispose of it has to be given it
   explicitly at the composition root.
4. **The declaration says why.** The docblock names the framework constraint that forced the timing
   and the defect that produced the current arrangement, so the next reader can retire the exception
   instead of copying it.

Fail any one of the four and the value moves into the composition root. There is no allowlist and no
second exception: a new module-level instance is a decision somebody has to argue for on these terms.

**Exactly one value in the repository qualifies today**: `documentDraftStore` in
`packages/pwa/src/lib/drafts.ts`, which the composer needs as a default prop at module load. It is
also the reason condition 3 is a condition. That store used to be a module default inside
`composer.tsx`, which made it the one daemon-scoped store in the bundle the connection registry could
not reach -- `clearDaemon` existed, was tested, and was called by nothing, so unpairing a daemon left
its drafts in `localStorage` for the next pairing that minted the same id to read back. Moving it into
`drafts.ts` and registering it at the composition root fixed that, and left the module-level instance
behind as the cost.

**How a violation is detected.** Condition 3 is mechanical for daemon-scoped state:
`scripts/validate/daemon-scope.sh`'s `invalidate` pass fails when a class declares `clearDaemon()` and
the connection registry never receives it -- it is what found the defect above. The rest is a stated
sweep rather than a gate:

```bash
# module-level service instances, tolerating a type annotation, excluding value-object constructors
git ls-files "packages/*/src/lib/*" | grep '\.ts$' | grep -v tests \
  | xargs rg -n '^export const [A-Za-z_][A-Za-z0-9_]*(: [^=]+)? = new ' \
  | grep -vE '= *new (Set|Map|WeakMap|WeakSet|RegExp|Date|URL)\b'
```

The pattern is written out because a shorter one hides things: `^export const [a-zA-Z]+ = new ` misses
a `SCREAMING_SNAKE` name and misses any declaration carrying a type annotation, so a genuine stateful
singleton would be invisible to it. On `00b733d0` the sweep returns one line, and it is the exception
named above.

---

## Temporal Coupling

Temporal coupling occurs when the order of operations matters, but the code does not enforce it.
This is a subtle form of hidden dependency.

```typescript
// WRONG -- temporal coupling: must call setTable before build
class QueryBuilder
  private table: string?
  private columns: string[]?

  setTable(t: string)
    this.table = t

  setColumns(cols: string[])
    this.columns = cols

  build() -> Query
    // crashes if table or columns not set!
```

```typescript
// RIGHT -- no temporal coupling: constructor enforces required state
class QueryBuilder
  constructor(table: string, columns: string[])

  build() -> Query
    // always works
```

```typescript
// WRONG -- stateful service with temporal coupling
class OrderService
  private items: Item[] = []

  addItem(item: Item)
    this.items.push(item)

  calculateTotal() -> Money
    return sum(this.items)
```

```typescript
// RIGHT -- all data flows through parameters
class OrderService
  calculateTotal(items: Item[]) -> Money
    return sum(items)
```

---

## Quick Checklist

- [ ] **SRP:** Does each class have one reason to change? Do things that change for different
      reasons live in different classes?
- [ ] **OCP:** Can behavior be changed by injecting different implementations rather than editing
      existing code?
- [ ] **LSP:** Does every implementation honor the full behavioral contract of its interface --
      including implicit promises?
- [ ] **ISP:** Does each interface contain only the methods its consumers actually use? Are large
      interfaces split into focused ones?
- [ ] **DIP:** Do high-level modules depend on interfaces, not concrete implementations? Is all
      wiring done at the composition root?
- [ ] **No private methods:** Are there zero private methods? Is every helper extracted into its own
      injectable service?
- [ ] **No subclassing:** Is every relationship an `implements` of an interface, with zero
      `extends`?
- [ ] **No singletons:** Are there zero singletons or static methods with business logic? Is
      everything injectable? If a module-level instance is unavoidable, does it meet all four
      conditions of [the one exception](#the-one-exception-a-value-a-framework-needs-at-module-load)?
- [ ] **Immutable members:** Are all class fields set in the constructor and never mutated? Are
      members only config values or injected services?
- [ ] **Methods take value types:** Do methods receive data as parameters (not stored in fields) and
      return data as results?
- [ ] **Visible dependencies:** Can you see every dependency by looking at the constructor
      signature, without reading method bodies?
- [ ] **Fixed references:** Do dependencies remain unchanged after construction?
- [ ] **No temporal coupling:** Does the order of method calls not matter? Are objects ready to use
      after construction?

---

## Language Implementations

- [SOLID in TypeScript](./languages/typescript.md) -- how these principles map onto the real
  `packages/cli` layout: `src/lib/`, `src/adapters/`, and the `bin/` composition root.

---

## Related Articles

- [Software Design Philosophy](../software-design-philosophy/index.md) -- the foundational "why"
  behind all principles
- [Functional Practices](../functional-practices/index.md) -- immutability, pure functions, total
  functions, and railway oriented programming
- [Domain-Driven Design](../domain-driven-design/index.md) -- how to model the domain
- [Three-Layer Architecture](../three-layer-architecture/index.md) -- how to structure layers and
  boundaries
- [Stateless OOP and Dependency Injection](../stateless-oop-di/index.md) -- how to structure
  services and wire dependencies
