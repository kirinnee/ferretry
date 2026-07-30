# UNIT FL1 — `packages/fleet`: the fleet provisioner and the manifest

**Read `docs/migration/units/UNIT-CONTEXT.md` fully first.** It holds the safety rules, the
refactor doctrine, the definition of done, and the PR requirement. This brief adds only specifics.

**Worktree:** `<your-worktree>`, branch `port/fl1-fleet`.

**You own:** everything under `packages/fleet/`. Nothing else. In particular do **not** create
files under `packages/protocol/` — another unit owns that package right now. Declare the manifest
schema inside `packages/fleet/src/lib/` for now; a later unit promotes it to `protocol` if the PWA
needs it. Say so in your PR.

## Source

Read-only: `/home/kirin/.config/home-manager/modules/kfleet-ts` — 45 files, ~6.9k lines. Also
read-only for reference: `~/.kfleet/` and the `kfleet/` asset tree in the home-manager repo
(`config.yaml`, `CLAUDE*.md`, `templates/`, skills, statusline).

**Never run `kfleet apply`, `kfleet serve`, or any command that mutates the live fleet.** Read-only
introspection (`--help`, reading files) is fine.

## What to build

Port kfleet's job into `packages/fleet` as a library plus the subcommand surface that `fy fleet
apply | login | usage` will call. The CLI wiring itself is a later unit — expose a clean library
API and say in your PR what the CLI must call.

### The fleet manifest is the point of this unit

Read `docs/design/migration-plan.md` §7.1 — it is your specification, and it is based on a survey
that found **40 coupling sites**. The manifest exists to kill them. It lands at
`~/.ferretry/fleet/manifest.json`, written by apply, with per account:

`{id, kind, mode, wrapper, home, displayName, defaultModel, models[], available, unavailableReason}`

Three rulings you must honour:

1. **An opaque stable `id` is the only join key.** In kteam the wrapper _filename_ was the join key
   across five subsystems (usage rows, installed wrappers, warden config, model tables, session
   config), matched byte-identically. Account names can contain arbitrary strings, hyphens are
   ambiguous, and aliases replace the kind prefix — which is why kteam silently skipped aliased
   wrappers. The wrapper path, resolved name, and display name are **attributes**, not keys.
2. **Availability is declared in the manifest**, so a model the config says is down **cannot** be
   offered or recommended. This is not hypothetical: `kfleet/config.yaml:66-70` currently declares
   Fable down on the loge pool, while `fleet-inventory.ts:42-47,67` still offers it and
   `core.ts:361-369` still ranks it first. Config said unavailable, two hardcoded tables said
   available, and the recommender routed work to a model that could not serve. **Make that state
   unrepresentable.**
3. **No consumer ever parses a shell script or consults a hardcoded table.** kteam had exactly two
   wrapper-text readers (`harness.ts:18-27` and `:29-35`) and four hardcoded model tables
   (`fleet-inventory.ts:35-71`, `core.ts:23-55`, `core.ts:334-405`, `ui.ts:120-122`). None of them
   are reproduced.

### Also port

- **Config parsing** — the real parsed shape of `kfleet/config.yaml` (parse it with zod; read the
  source parser rather than the docs, they disagree).
- **Wrapper generation** — what apply emits. Keep secret _values_ out of the repo and out of tests;
  use placeholder material in fixtures.
- **The usage collector's data model.** Note it must eventually serve **two** contracts — `/usage`
  JSON and `/metrics` Prometheus text — because external kloop and khost consume them (plan §7.2).
  Build the collection library and the shapes; the HTTP surface belongs to the daemon and is a
  later unit. State the boundary in your PR.
- **Configurable secrets file path** — kteam hardcoded `~/.secrets` sourcing. It becomes config.

## Bugs to expect

The Fable availability contradiction above is one. Look also for: name-grammar assumptions
(`^(claude|codex)-auto-`) treated as load-bearing, alias handling that silently drops accounts, and
the duplicated model tables disagreeing with each other. Fix them; list every fix in your PR.
