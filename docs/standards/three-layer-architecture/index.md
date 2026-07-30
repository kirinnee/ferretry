---
id: three-layer-architecture
title: Three-Layer Architecture
---

# Three-Layer Architecture

The domain is pure. Everything else is a plugin.

This is the architectural pattern at the heart of `packages/cli`. Whether an application is a CLI
tool, a daemon, or a background worker, the structure is the same: a pure domain layer in the
centre, surrounded by adapter code that the domain neither knows about nor depends on. This
document describes the pattern as the CLI actually implements it — not a generic HTTP-and-database
diagram — and the boundary that the repository machine-enforces.

This standard builds on [Software Design Philosophy](../software-design-philosophy/index.md),
[SOLID Principles](../solid-principles/index.md), and
[Functional Practices](../functional-practices/index.md), and it is where the domain modelled in
[Domain-Driven Design](../domain-driven-design/index.md) meets the outside world.

---

## The Three Seams in `packages/cli`

The pattern lands on three directories with three distinct jobs:

| Seam                 | Directory                    | Job                                                            |
| -------------------- | ---------------------------- | -------------------------------------------------------------- |
| **Domain**           | `packages/cli/src/lib/`      | Pure logic. No IO, no framework, no knowledge of the others.   |
| **Adapters**         | `packages/cli/src/adapters/` | All IO — terminal ports, shell, and any future data adapter.   |
| **Composition root** | `packages/cli/bin/`          | Wires domain to adapters at the entry point, and nowhere else. |

The domain layer's isolation is not a convention you have to remember — it is a build gate:

```bash
scripts/validate/cli-contracts.sh arch
```

The `arch` contract fails the build if `src/lib` contains `console.*`,
`process.{stdin,stdout,stderr,exitCode}`, an import from `chalk`/`ora`/`cli-progress`/`inquirer`,
or an upward import from `adapters/`. Pure means pure, mechanically.

---

## Layer Responsibilities

### Composition-Root Boundary — Guardrails

The composition root is the CLI's **entry and exit boundary**. A command controller is the
equivalent of an API handler: it is registered through `bin/fy.ts`, protects the domain from
invalid input, and remains thin.

| Concern              | What it means                           |
| -------------------- | --------------------------------------- |
| **Type enforcement** | Ensure incoming data has correct types  |
| **Validation**       | Check rules on input shape and values   |
| **Mapping**          | Convert external format → domain format |
| **Serialization**    | Convert domain format → external format |

Raw argv is untyped and untrusted. Controllers **parse it with zod at the boundary** (zod is a
real dependency of `packages/cli`), call the domain with typed structures, and translate the
result back out. Controllers contain **zero business logic**. They are constructed and attached
only through `registerDomain(program, world)`.

### Adapter Layer — IO

The terminal and system ports live in `src/adapters/` and are the code allowed to perform their
specific outside-world effects:

| Port           | Backed by     | Purpose                                     |
| -------------- | ------------- | ------------------------------------------- |
| `ICliIo`       | console/chalk | success / warn / error / exit / interactive |
| `ISpinner`     | ora           | live status                                 |
| `IProgressBar` | cli-progress  | determinate progress                        |
| `IPrompt`      | inquirer      | interactive input                           |
| `IShellRunner` | Bun `$`       | shell calls                                 |

**Never prompt off a TTY.** `IPrompt` (and any other interactive path) must be gated on
`world.interactive` — check it before asking, and fall back to a non-interactive default when it
is `false`.

### Domain Layer — Logic

The domain layer under `src/lib/` is the **source of truth**. All rules live here.

| Concern            | What it means                                  |
| ------------------ | ---------------------------------------------- |
| **Rules**          | Invariants, constraints, calculations          |
| **State machines** | Valid transitions between states               |
| **Validation**     | Domain-level validation (not input validation) |
| **Orchestration**  | Coordinating collaborators behind interfaces   |

**Constraints:**

- No IO — no console, no `process.*`, no terminal libraries, no shell, no file system.
- No knowledge of outer layers — never import from `adapters/` or `bin/`.
- Defines narrow domain-facing interfaces when it needs external collaborators. The composition
  root passes structurally compatible adapters to those interfaces; domain code never imports an
  adapter-owned terminal port such as `ICliIo`.

Because the domain has no IO, it is fully testable with plain doubles.

### Data — a Future Adapter, Not an Assumption

The classic version of this pattern names a third **data/storage** layer. The CLI has **no
persistence layer today**: `packages/cli` is a stateless client. When persistence arrives it lands
as another adapter under `src/adapters/`, structurally satisfying a repository interface the domain
defines — catching infrastructure errors and translating them into domain errors so the domain
never sees a transport or storage exception. Until then, do not model a data layer that does not
exist.

---

## Separate Models Per Boundary

Each boundary has its own models. This is non-negotiable.

| Boundary          | Model Type       | Optimized For                        |
| ----------------- | ---------------- | ------------------------------------ |
| CLI boundary      | Args / output    | Transport (CLI args, rendered text)  |
| Domain            | Principal/Record | Business logic, type safety          |
| Future data layer | Data/Entity      | Storage (when a data adapter exists) |

**Why separate models matter:**

- Output-format changes don't break domain tests.
- A future storage schema change doesn't break domain tests.
- A new driver (the daemon `fyd`, say) reuses the domain without modification.
- Each boundary evolves independently.

---

## Mappers Between Boundaries

Mappers are pure functions that translate models across a boundary.

- **CLI-boundary mapper:** external ↔ domain — `args → domain` on the way in, `domain → output`
  on the way out.
- **Data mapper (future):** domain ↔ storage — `storage → domain` and `domain → storage`.

**Mapper rules:**

1. **Composable** — higher-level mappers reuse lower-level mappers.
2. **SRP grouping** — update requests target Records grouped by update rate (see
   [Domain-Driven Design](../domain-driven-design/index.md)).
3. **Pure** — a mapper is a function of its input, with no side effects.

---

## Error Flow

Errors flow across boundaries as values, not exceptions.

```text
Infrastructure error (e.g., a failed shell call or, later, a storage failure)
    │
    ▼
Adapter catches, maps to a domain error value
    │
    ▼
Domain returns a Result-style value carrying that error
    │
    ▼
Controller maps it to output: a message via ICliIo.error and a non-zero exit code
    │
    ▼
Caller sees stderr + exit status
```

Each boundary has its own error shape; mappers translate errors just as they translate data. The
outermost `execute()` call in `bin/fy.ts` is the last-resort guard: it catches an unhandled error,
writes it through `ConsoleIo.error`, sets exit code `1`, and attempts each cleanup in its own
`try`/`catch` so cleanup failure cannot mask the command result. See
[Functional Practices](../functional-practices/index.md) for the Result-oriented direction.

---

## Dependency Direction

**The domain never points outward.**

- `src/lib/` owns pure logic and any narrow interfaces it needs; it never imports `adapters/` or
  `bin/`.
- `src/adapters/` owns concrete IO mechanisms. An adapter may structurally satisfy a domain port,
  but it does not make the domain import its implementation.
- `bin/` is deliberately dependency-aware: it imports both sides, builds the world, and performs
  the one permitted wiring step.

This is the heart of the plugin architecture: the domain is the core, everything else is
swappable. The `arch` contract above enforces the one direction that matters most — nothing in
`src/lib` may import from `adapters/`.

---

## Composition Root

All layers are wired at the entry point, `packages/cli/bin/fy.ts` — the only place that knows
concrete types. Everything else depends on interfaces.

- **`createProgram()`** builds the commander skeleton (name, description, `--version`, `--help`)
  and nothing else. It is domain-free.
- **`CliWorld`** is the interface bundle of adapters an invocation needs (`io`, `spinner`,
  `progress`, `prompt`, `shell`, `interactive`).
- **`buildWorld()`** constructs the production `CliWorld` — the shipped terminal and system
  adapters.
- **`registerDomain(program, world)`** is the **only scaffold↔domain seam**. One command is one
  controller class that takes its ports via constructor and returns/sets an exit code; controllers
  are constructed and attached here.
- **`execute()`** builds the program, wires the domain, runs `parseAsync`, catches failures, and
  releases resources without masking the command's result.
- **`if (import.meta.main)`** guards execution: the CLI runs only when invoked directly, so tests
  and the SIT in-process driver can import `createProgram()`/`registerDomain()` without launching
  it.

---

## Test Tiers

The layers map directly onto the test tiers (see [Testing](../testing/index.md)):

| Tier        | Where                | Exercises                                           |
| ----------- | -------------------- | --------------------------------------------------- |
| unit        | `tests/unit/`        | `src/lib` — the pure domain, in isolation           |
| integration | `tests/integration/` | `src/adapters` — the IO ports against real backends |
| SIT         | `tests/sit/`         | the full binary, end to end                         |

SIT is dual-driver: `BinaryCliDriver` spawns the compiled binary (black box, the default), and
`InProcessCliDriver` runs the same journeys through `createProgram()`/`registerDomain()` with
captured IO (`SIT_DRIVER=inprocess`) for the coverage ledger. Every journey asserts on
`{code, out, err}` only.

---

## Quick Checklist

- [ ] Controllers handle type enforcement, validation, mapping, and serialization — no business
      logic.
- [ ] Raw argv is parsed with zod at the controller boundary.
- [ ] The domain layer (`src/lib`) has zero IO and passes `cli-contracts.sh arch`.
- [ ] The domain defines narrow interfaces for its external dependencies and never imports an
      adapter-owned terminal port.
- [ ] Interactive prompts are gated on `world.interactive`.
- [ ] Each boundary has its own models; mappers translate between them.
- [ ] Errors are values, not exceptions, and are mapped to an `ICliIo.error` message plus a
      non-zero exit code.
- [ ] No data layer is modelled until a real persistence adapter exists.
- [ ] All wiring lives in the composition root (`bin/fy.ts`); executable invocation is guarded by
      `if (import.meta.main)`.
- [ ] Dependencies point inward — nothing in `src/lib` imports from `adapters/` or `bin/`.

---

## Related Articles

- [Software Design Philosophy](../software-design-philosophy/index.md) — the "why" behind patterns
- [SOLID Principles](../solid-principles/index.md) — why layers are separated this way
- [Functional Practices](../functional-practices/index.md) — immutability, pure functions,
  Result types
- [Domain-Driven Design](../domain-driven-design/index.md) — modelling the domain layer
- [Stateless OOP and Dependency Injection](../stateless-oop-di/index.md) — wiring the composition
  root
- [Testing](../testing/index.md) — the unit / integration / SIT tiers
