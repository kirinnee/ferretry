# Survey — the daemon used to get its quota numbers from kfleet

> **IMPLEMENTED.** The design below was built as written: `FleetUsageSource`
> (`packages/daemon/src/adapters/usage/fleet-usage-source.ts`) over `accountUsageFromFleet`
> (`packages/daemon/src/lib/usage/fleet-usage.ts`), wired first in `createUsageFeed`. The manifest
> join, the fail-closed window mapping and the collapsed cadence all landed. What did **not** land is
> recorded under [Where this stopped](#where-this-stopped). The document is kept because it is the
> rationale, not a plan.

**The finding, in one line:** Ferretry's daemon served `/usage`, `/v1/usage` and `/metrics` from a
cached feed whose only two sources were **kfleet** — an HTTP call to its `serve`, or a shell-out to its
CLI. The tool the migration exists to delete was a runtime dependency of the daemon's quota.

Nothing here was broken. Both paths worked. But they were two parallel quota systems, and only one of
them was native.

## The two paths

|           | path A — the daemon feed                                                         | path B — the fleet collector                            |
| --------- | -------------------------------------------------------------------------------- | ------------------------------------------------------- |
| routes    | `/usage` (public), `/v1/usage` (warden), `/metrics` (public)                     | `/v1/fleet/usage` (admin)                               |
| shape     | `AccountUsage[]`, keyed by **agent name**                                        | `FleetUsage[]`, keyed by **account id**                 |
| renderer  | `api/metrics.ts` `renderUsageMetrics`                                            | `lib/usage.ts` `renderFleetUsageMetrics` — **uncalled** |
| cache     | `CachedUsageFeed` — lazy refresh, shared in-flight, retains last good            | none; collects per request                              |
| source    | `HttpUsageSource(usage.url)` → kfleet `serve`; `CommandUsageSource` → kfleet CLI | `AnthropicUsageProbe`, native                           |
| consumers | the advisor, quota-failover, the PWA, any Prometheus scraper                     | a person typing `fy fleet usage`                        |

Path A is the better _machinery_ — it already has the loop, the rendering, and a `ready`/`stale` flag
that keeps "the fleet is empty" apart from "the collector failed"
(`api/routes/usage.ts`). Path B has the better _source_ — it asks Anthropic directly, separates the two
utilization scales, and needs no kfleet.

**Neither is wrong. They should be one thing: path A's machinery over path B's source.**

## Why this matters for deleting kfleet

`createUsageFeed` in the daemon's composition root wires exactly two sources, both external:

```
HttpUsageSource(config.usage.url)                       → kfleet's serve
CommandUsageSource(usageProbeCommand(...))              → kfleet's CLI, with --json --all --no-relogin
```

So on a host where kfleet is deleted, a daemon configured with neither serves an empty feed and says so
honestly — but the advisor, quota-failover and every scraper then have no quota data at all, while
`fy fleet usage` on the same host reports real numbers. Capability F reads as closed from the CLI and
open from the daemon.

## What to build — built

A `UsageSourcePort` backed by the fleet collector, wired **first** in `createUsageFeed`, ahead of the two
kfleet sources. That single change gives the existing loop, `/metrics` and `/usage` native numbers, makes
`renderFleetUsageMetrics` unnecessary rather than uncalled, and lets the kfleet sources be deleted once
the native one is trusted.

### The one thing that will silently break routing if it is got wrong

`AccountUsage.agent` is **not** an account id. It is the name a session is launched with:
`quota-failover/service.ts` calls `migrate(session.id, migration.target.agent)`, and the advisor matches
on the same field. A `FleetUsage` row carries only `accountId` and `kind`, so a source **must join back
to the manifest** and use `account.wrapper`.

Mapping an account id into `agent` would type-check, pass every schema, produce a plausible-looking
`/usage` document — and then silently match nothing, so failover would quietly stop moving sessions off
exhausted accounts. This is the same shape as the false exhaustion that
[kfleet-map.md](kfleet-map.md) records under F: internal measures all look fine while the fleet stops
working.

The rest of the mapping is mechanical:

| `FleetUsage`                                                                            | `AccountUsage`                        |
| --------------------------------------------------------------------------------------- | ------------------------------------- |
| `accountId` → manifest → `wrapper`                                                      | `agent`                               |
| `provider`, `usageBased`, `ok`, `authOk`, `atLimit`, `unavailable`, `unavailableReason` | same names                            |
| `shortWindow.usedPercent` / `resetAt`                                                   | `fiveHourPercent` / `fiveHourResetAt` |
| `longWindow.usedPercent` / `resetAt`                                                    | `weeklyPercent` / `weeklyResetAt`     |

An absent window must map to **absent or `null`**, never `0`: the whole point of the fleet collector's
fail-closed rule is that unknown is not zero, and flattening it here would undo that at the boundary.

### The port contract: `undefined` and `[]` are different answers

`UsageSourcePort.read` resolves to `undefined` when the source **could not be read at all**, and to an
array when it could. A native source must honour that exactly:

- the collector threw, or there is no manifest → **`undefined`**
- the manifest is genuinely empty → **`[]`**

Returning `[]` for a failure is the same mistake as reporting `0%` for an unknown window: emptiness is a
claim about the fleet, and a failed read is not evidence for it. `CachedUsageFeed` only ever replaces its
snapshot with a successful reading, so getting this right is what preserves the last good numbers across
a blip.

### Ordering is safe, and here is why — so nobody has to re-derive it

Wiring the native source **first** looks risky (would an empty manifest shadow a working kfleet?) and is
not, because the feed's loop is careful (`adapters/usage/cached-usage-feed.ts`):

- `undefined` → skip to the next source;
- a **non-empty** array → wins immediately and stops;
- an **empty** array → remembered only as a fallback, and the loop **keeps going**.

So a native source that legitimately has nothing to say does not suppress a later source that does. That
is what makes "native first, kfleet behind it" a safe intermediate state rather than a cutover.

### Fields with no equivalent must be omitted, not defaulted

`AccountUsage` carries `availability` and `retryAt`, which `FleetUsage` has no counterpart for. Leave them
absent. Filling them with a plausible default invents a reading, which is the failure mode this whole
section is about.

## Also still open — resolved

- `usage.interval` and `usage.jitter` configured nothing and were refused at plan time
  (`capabilities.ts`). Path A had its own `usage.refreshSeconds`, a **second** way to say the same
  thing. **Collapsed:** `usage.interval` is the one name, it drives `CachedUsageFeed`'s refresh through
  `usageRefreshMs`, and it is no longer refused. `usage.refreshSeconds` is deleted from the daemon
  configuration. `usage.jitter` stays refused, with a consequence line that now says why: the feed
  re-collects on snapshot age rather than on a timer, so there is no synchronized cycle to spread.
- `renderFleetUsageJson` and `renderFleetUsageMetrics` are **unnecessary rather than uncalled**:
  `/metrics` renders the native feed through `api/metrics.ts` `renderUsageMetrics`, and
  `/v1/fleet/usage` returns the snapshot directly. Deleting the pair is a separate, safe cleanup.
- Two settings found while implementing this, both parsed and dropped, both landed after the refusal
  list was written. **Fixed:** `usage.timeout` now reaches the probe from both composition roots, and
  `usage.enabled: false` now stops the daemon's unattended collection instead of being read as "not a
  request" because it defaults to true. An explicit `fy fleet usage` is unaffected: a person asking is
  not a background cycle.

## Where this stopped

- **The two external sources are still wired, behind the native one.** Removing them is a declared
  **GAP**. Ordering matters: a host part-way through the migration may still be running kfleet, and a
  daemon whose own fleet has not been applied yet should keep reporting whatever is answering. The
  loop's semantics make native-first safe to land first — `undefined` skips to the next source, a
  non-empty result wins and stops, and an empty array does not short-circuit — so a native source with
  nothing to say cannot suppress a kfleet source that has something.
- **`retryAt` and a positive `availability` have no counterpart in a collector row.** They are omitted
  rather than defaulted; a defaulted availability is an invented claim about an account.
- **Non-Anthropic providers are still a GAP in the collector itself**, unchanged by this. The daemon
  now carries whatever the collector can prove, which for those accounts is an honest failure.
