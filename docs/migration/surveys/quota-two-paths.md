# Survey — the daemon still gets its quota numbers from kfleet

**The finding, in one line:** Ferretry's daemon serves `/usage`, `/v1/usage` and `/metrics` from a
cached feed whose only two sources are **kfleet** — an HTTP call to its `serve`, or a shell-out to its
CLI. The tool the migration exists to delete is currently a runtime dependency of the daemon's quota.

Nothing here is broken. Both paths work. But they are two parallel quota systems, and only one of them
is native.

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

## What to build

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

## Also still open

- `usage.interval` and `usage.jitter` configure nothing in the fleet path and are refused at plan time
  (`capabilities.ts`). Path A has its own `usage.refreshSeconds`, which is a **second** way to say the
  same thing — worth collapsing when the paths merge.
- `renderFleetUsageJson` is uncalled; `/v1/fleet/usage` returns the snapshot directly.
