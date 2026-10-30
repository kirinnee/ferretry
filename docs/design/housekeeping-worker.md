# Housekeeping worker — stage 4 of the event-driven daemon

Status: **in progress** — PR 0 and PR 1 merged, PR 2, PR 3 and PR 4 built, and Codex discovery moved after them (§4.1–§4.4) · Date: 2026-10-22 · Parent: [event-driven-daemon.md](event-driven-daemon.md) (stage 4) ·
Sibling: [session-workers.md](session-workers.md) (stage 3, PR #701) · Owner directive, verbatim: _"use things
like inotify, 1 thread per agent, fan into the daemon (daemon should just communicate)"_. Lead's ask: _"fleet
refresh must be event-driven (only when runtime homes/config actually change) and run on the housekeeping
worker."_

This is the research and the design for stage 4. It moves the fleet-wide jobs' file reads, parsing,
credential reads and provider calls onto ONE housekeeping worker, and replaces the fleet refresh's timer with
the events that actually change a fleet reading. The main thread keeps every durable write, every lock and
every client-facing view, exactly as stage 3 does. Behaviour does not change.

Paths are relative to `packages/daemon/` unless they start with `packages/`, `scripts/` or `docs/`. Line
numbers are `origin/main` at `7525cdb26` (#702, after 4.67.0).

## 0. The decisions, in one screen

1. **Most of the fleet refresh's cost is repeated reading, not computing.** One pass reloads the whole config
   tree 4–6 times, reads every credential 2–4 times (on macOS that is 2–4 `security` processes for each Claude
   login), and reads every session's config to work out Codex usage. None of these inputs changed since the
   last pass. So the biggest win is **read only on change** (§3). Moving the work to a thread comes second
   (§2).
2. **One housekeeping worker, separate from `analytics-fold`.** The new `bin/housekeeping.worker.ts` handles
   credential reads, provider usage reads, passive usage reads and Codex rollout scans. A 32 MiB analytics fold
   stays on its own thread. If they shared one, a person pressing **Check now** could wait ten seconds behind
   a fold, and one bad transcript could take credential reads down with it (§2.1).
3. **A login token stays inside the worker.** The worker reads the credential, takes the bearer token, makes
   the HTTP call, and drops the token in that same function call. Only facts are posted back: status, expiry,
   a truncated sha256 fingerprint, usage windows, an email. The protocol types have no field that could hold
   credential material. Every error the worker posts is a fixed sentence, never a caught message (§2.4).
4. **Worker computes, main writes.** The per-credential `SingleFlight` lock, the status heads, the usage cache,
   the session index, every `state.json` and every journal append all stay on main. The worker opens no
   SQLite, writes no file and holds no secret vault. This is the same rule as stage 3 §2.4.
5. **Fleet reading becomes a model kept on main, fed by events.** The inputs are: config reloads (the
   existing watcher), the manifest, credential files, `usage.json`, Codex rollouts (stage 3 session workers),
   and on macOS a change to the keychain file. Time is only an input where the provider is the only source:
   the usage windows, read once every `usage.interval` (60 s by default) for a credential with no fresher
   passive reading. That is today's rule, kept. Status changes that depend only on time, such as a token
   reaching its expiry, are worked out from cached facts with no I/O (§3).
6. **Four PRs, each behaviour-identical** (§4):
   - one config snapshot plus cached credential facts, on main;
   - the worker;
   - the event-driven reading;
   - the rest of the housekeeping timers.

   One small behaviour fix comes first and on its own: today a credential being checked is cached as "not
   known" for a whole interval.

## 1. Inventory — fleet-wide and background jobs on the main thread today

Legend:

- **Move**: the I/O and CPU go to the housekeeping worker.
- **Event**: stays on main, but its trigger becomes an event.
- **Stay**: stays as it is.
- **3**: owned by stage 3.

Cost classes:

- **CPU**: parsing, folding or hashing on main.
- **NET**: waiting on the network. It does not block the loop, but it holds the lane.
- **CHILD**: starting a child process.
- **FILE**: file I/O.

### 1.1 Measured (2026-10-22)

| Where                                            | Fleet refresh          | `GET /v1/usage` | `security` spawns      | Analytics ingest | Terminal reaper                                         | Self-check      |
| ------------------------------------------------ | ---------------------- | --------------- | ---------------------- | ---------------- | ------------------------------------------------------- | --------------- |
| Live Linux box, 4.66.7, 57 sessions / 11 running | 2/min, p50 5.0 s wall  | p50 1.5 s       | n/a                    | 2/min, 0.3 s     | —                                                       | —               |
| Same box, 4.66.7, 61 / 13, my 180 s idle profile | 1/min, p50 1.3 s       | not hit         | n/a                    | 1/min, 85 ms     | 12/min, 28 ms; **14.2/s** `terminal-pane.json` identity | 2/min, 56 ms    |
| Owner's Mac, 4.66.7                              | on the background lane | —               | **5.9/min, p95 1.5 s** | not visible      | —                                                       | **17.7 s wall** |

The same 180 s profile also shows two costs that are not housekeeping but feed into it:

- `listDirectory` runs on all 8 config directories **0.4/s each**, which is about 24 full config-tree reloads
  a minute (§1.3).
- `secrets.key` is read **6.1/s** and `secrets.json` **0.9/s**. These reads come from the vault redactor on
  the operator read path, and stage 3's workers must leave it on main (§5.6).

### 1.2 Fleet refresh — Move + Event (the subject of this stage)

**Wiring**

- Built at `bin/fyd.ts:8958`: `new FleetRefreshService({usage: unattendedUsageFeed(usage), credentials: fleetCredentials})`.
- Queued on the lane at boot, then on a timer that only re-queues it (`bin/fyd.ts:10121-10128`).
- Cadence: `usageRefreshMs(usage.interval)` (`src/lib/usage/feed-policy.ts:15,29-31`). The fleet config
  default is 60 s (`packages/fleet/src/lib/config.ts:155`). With no fleet config it falls back to 300 s.
- One pass is `Promise.allSettled([usage.accounts(), credentials.observeAll()])`
  (`src/lib/fleet-refresh/service.ts:52`).

**A. `usage.accounts()`**

The feed is `WatchedUsageFeed`, then its `.unattended` half, then `CachedUsageFeed` (`bin/fyd.ts:7410-7429`,
`src/adapters/usage/cached-usage-feed.ts:27,67-88`). Its source is `CredentialUsageSource.read`
(`src/lib/usage/credential-usage.ts:42-54`), which only runs when the snapshot is older than `refreshMs`.

| Step                                                                                     | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Cost                   |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `enabled()`                                                                              | Calls `declaredAccountModel()`, then `configFiles.load()` (`bin/fyd.ts:6565`, `src/adapters/fleet/account-model-files.ts:94`). That **lists the whole config tree, reads every YAML file, evaluates it and takes a sha256 of each file**, queued behind every other load (`src/lib/config-files/service.ts:169-225`).                                                                                                                                                                                                                                                                                      | CPU, FILE              |
| `manifest()`                                                                             | Reads `<home>/fleet/manifest.json` and parses it with zod.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | FILE, CPU              |
| `credentials()` → `fleetCredentials.list()` (`src/lib/fleet/credentials-service.ts:477`) | `catalog.entries()`, which is **another `load()`**. Email per credential, one at a time: `.claude.json` or `sign-in/.claude.json`, or Codex `auth.json` with its `id_token` decoded. Then, per credential, `status.view()` (`packages/fleet/src/lib/account/credential-status.ts:631`): a passive reading plus `#classify`. **On macOS each classify is one `security find-generic-password … -w`** (`packages/fleet/src/adapters/credential-store.ts:443-453`). On Linux it reads `.credentials.json`. Either way the whole blob is hashed with sha256. For Codex, `#codexLocal` reads `auth.json` twice. | FILE, CHILD (mac), CPU |
| Codex passive reading                                                                    | Another `load()`, then `storage.listSessions()`, then **`readConfig` and a zod parse for every session**, then a rollout tail read or a full `.zst` decompress (`bin/fyd.ts:8331-8344`, `packages/fleet/src/adapters/rollout-rate-limits.ts:177-224`).                                                                                                                                                                                                                                                                                                                                                     | FILE, CPU              |
| `credentialUsageRows`                                                                    | Joins the results.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | CPU                    |

**B. `observeAll()`** (`src/lib/fleet/credentials-service.ts:493`)

- Another `load()`, then `observe()` for every credential **in parallel**
  (`credential-status.ts:639-650`), each under a per-credential `SingleFlight`.
- Passive reading first. Then, if `needsActiveUsageRead` (`:525`) finds no passive reading younger than the
  interval, `#activeRead` (`:666`) runs:
  - a classify, which is **spawn 1**;
  - the probe's own material read, **spawn 2** (`AnthropicUsageProbe.probeCredential`);
  - `GET https://api.anthropic.com/api/oauth/usage` with a bearer token and a 20 s timeout, or
    `GET https://chatgpt.com/backend-api/wham/usage`.
- Then `#view` classifies again: **spawn 3**.
- So on macOS, one idle Claude login costs 3 spawns per pass, plus 1 more in `list()` when the feed
  refreshes. With two Claude logins at 60 s that is about 6/min, which matches the Mac's 5.9/min.

**Writes:** memory only (the feed cache, `InMemoryCredentialStatusStore` heads). `load()` can also rewrite the
accepted record.

**Publishes:** nothing, apart from `configChanges` when a `load()` finds a difference.

**A behaviour bug on this path (fix it first, §4 PR 0).**

- `list()` runs at the same time as `observeAll()`. When `view()` lands while `observe()` holds that
  credential's flight, it reports `checking` (`credential-status.ts:324`).
- `usageRow` then emits `ok: false`, with no availability and no at-limit (`credential-usage.ts:86-104`).
- The feed caches that row for `refreshMs`.
- So the unattended pass itself can make a login read as "not known" for a whole interval. This comes from
  reading the code. A test needs to reproduce it before the fix.

**Other readers that share or bypass the cache**

- Sharing the cache: `GET /v1/usage` (`src/lib/api/routes/usage.ts:81-87`). It first awaits
  `quotaReader.watch()`, which does **two `load()`s plus a manifest read on every call** (`bin/fyd.ts:8428-8444`),
  then runs path A **synchronously when the cache is stale**. That is why it takes 1.5 s.
- Sharing the cache: quota failover, the warden sweep and the advisor.
- Calling `fleetCredentials.list()` directly, so every call re-reads every credential: the logins route
  (`bin/fyd.ts:8896-8903`), catalog facts for `runtimes()`/`machine()`/`republish()`
  (`src/lib/fleet/catalog-service.ts:585,626`), and the Ferretry tools snapshot (`bin/fyd.ts:8709`).

### 1.3 Every other fleet-wide job

| Job                                                             | Built / armed                                            | Cadence                                                                        | Reads                                                                                                                                                                                                                                                                                                                         | Writes / publishes                                                | Cost                                           | Verdict                                                                                           |
| --------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Analytics ingest / rebuild**                                  | `bin/fyd.ts:8219-8241`; lane `:10152-10159`              | 60 s (`:5170`), ≤ 8 reads/pass (`:5160`)                                       | Pricing: daemon config plus **`configFiles.load()`** via `modelCatalogs()`. Discovery: SQLite `listSessions`, then `readConfig`+`readState`+zod for **every** session, 4 at a time (`:5222-5233`). `resolveFile` on main (can run Codex discovery). The fold runs on `analytics-fold` (`bin/analytics-fold.worker.ts:30-44`). | `analytics.sqlite` upsert/forget (bun:sqlite, sync); `refreshing` | CPU (zod, hashes), FILE; fold already off main | **Event** (§4 PR 4). SQLite stays on main, the fold stays on its worker.                          |
| **Pricing feed**                                                | `:8234-8241`, `src/lib/analytics/pricing-service.ts:140` | none; only on an operator preview                                              | HTTP GET                                                                                                                                                                                                                                                                                                                      | daemon config, under its serial                                   | NET                                            | **Stay**                                                                                          |
| **Published model catalog**                                     | `:8384-8401`, `src/lib/models/published.ts:209-242`      | 6 h, checked lazily on every `catalogs()` call, including every analytics pass | version file, release, signature, catalog                                                                                                                                                                                                                                                                                     | `state/model-catalog.json`; `fleetCatalog.republish()`            | NET, CPU once per update                       | **Stay**. Its per-call `load()` is fixed by PR 1.                                                 |
| **Ollama local models**                                         | `:8409-8419`, once at `:10187`                           | once, plus on Settings                                                         | loopback `/api/tags`                                                                                                                                                                                                                                                                                                          | republish                                                         | NET                                            | **Stay**                                                                                          |
| **Terminal reaper**                                             | `:7297-7310`; lane `:10161-10165`                        | 5 s                                                                            | a survey of every session directory; a `terminal-pane` identity per session (14.2/s on the live box); `readState`; in-band `list-panes`; on macOS `ps -o lstart=` per finished pane                                                                                                                                           | kills panes                                                       | FILE, CHILD (mac)                              | **3** (3d: on `exited`). Fallback in PR 4 if 3d has not landed.                                   |
| **Quota failover**                                              | `:9096-9103`; lane `:10095-10100`                        | max(60 s, configured), default 5 min, **off** by default                       | `quota-failover/config.json`; when enabled, the usage feed, the roster, `state.json`                                                                                                                                                                                                                                          | `state.json`, journal, migrate                                    | FILE                                           | **Stay**. It reads the model's projection after PR 3.                                             |
| **Warden sweep**                                                | `:3653-3990`, `:9249-9293`; arm `:10199`                 | ≥ 60 s (default 2 min) plus debounced event triggers                           | **a full `configFiles.load()` on every triggering session event** (`:3945-3953`, `src/adapters/warden/documents.ts:88`), every sweep and every 30 s liveness tick; sessions; usage                                                                                                                                            | warden state; spawns                                              | CPU (config), FILE                             | **Stay**. Its config reloads are removed by PR 1.                                                 |
| **Warden liveness tick**                                        | `:3958-3975`                                             | 30 s                                                                           | config `load()` again; pane captures; tails; `ps`                                                                                                                                                                                                                                                                             | reflex                                                            | CHILD, CPU                                     | **3**. The `ps` fallback is in §5.5.                                                              |
| **Self-check**                                                  | `:7337-7398`; `:10030-10033`                             | 30 s (`healthIntervalSeconds`), no guard against overlapping runs              | 3 directory surveys; a deep `reconcile()` under **`serial.runExclusive`**; the exit observer's tmux queries per running session                                                                                                                                                                                               | `health-events.jsonl`, `state.json` CAS, SQLite index             | FILE, lock waits, tmux                         | **Stay** (it writes under the lock). §5.4 has the 17.7 s analysis and the fixes, outside stage 4. |
| **Update check**                                                | `:9182-9223`; `:10225`                                   | loop every 60 s; GitHub every 6 h                                              | **`turnPorts.sessions()`: `readState` for every unsettled session every minute** (`:9213-9214`)                                                                                                                                                                                                                               | `state/update/*`                                                  | FILE; NET every 6 h                            | **Event** (PR 4): read statuses from the index.                                                   |
| **Handover reconcile**                                          | `:9110-9115`; `:10219`                                   | 15 s                                                                           | **raw `readdir` + `readFile` per session directory, outside the counted port** (`src/adapters/handover/file-handover-receipt-store.ts:79-91`)                                                                                                                                                                                 | receipts; starts and stops sessions                               | FILE                                           | **Event** (PR 4): only receipts main knows are open, plus a boot pass.                            |
| **Codex rollout discovery**                                     | `:6770-6776`, `:6820-6835`                               | when read: a 2 min eager window, then every 30 s per unresolved session        | a walk of the Codex home; `claimed()` reads **every** session's config                                                                                                                                                                                                                                                        | binds provenance via `updateConfig`                               | FILE, CPU                                      | **Move** the walk (PR 4); main keeps the claims and the binding (stage 3 §8 Q3).                  |
| **Config watcher**                                              | `:5385-5420`, `:9131-9161`; `:10184`                     | on the FileEventHub plus a 30 s backstop                                       | a stat fingerprint; on change, a full load                                                                                                                                                                                                                                                                                    | accepted record; `configChanges`; republish                       | FILE, CPU on change                            | **Stay**. It is the config owner, and PR 1 makes everyone else read its snapshot.                 |
| Audit flush                                                     | `:10168-10173`                                           | 60 s                                                                           | memory                                                                                                                                                                                                                                                                                                                        | one journal line                                                  | negligible                                     | **Stay**                                                                                          |
| Event-loop lag meter / watchdog                                 | `:9435-9465`                                             | 250 ms; the watchdog has its own worker                                        | —                                                                                                                                                                                                                                                                                                                             | stall notices                                                     | negligible                                     | **Stay** (it measures main)                                                                       |
| Auto-resume                                                     | `:10037`                                                 | once                                                                           | ledger                                                                                                                                                                                                                                                                                                                        | relaunches                                                        | CHILD                                          | **Stay**                                                                                          |
| Turn watcher, declared-wait watcher, send tracker, live sampler | stage 3 §1                                               | 2 s / 15 s / per send / 500 ms                                                 | —                                                                                                                                                                                                                                                                                                                             | —                                                                 | —                                              | **3**                                                                                             |

**Not wrapped in `activities.run`, so `fy daemon profile` cannot attribute them:** warden sweep, warden
liveness tick, handover reconcile, update check, config watcher, audit flush, send tracker. PR 1 wraps them.
Without that, a stall could not be attributed to housekeeping, and stage 4's exit criterion could not be
checked.

**`BackgroundLane`** (`src/lib/runtime/background-lane.ts:21-74`) runs one job at a time and yields between
jobs. It drops a new job only when one of the same name is already _waiting_, not when one is _running_, and
it opens 120 s after serving. While a 5 s fleet pass is on the lane, the 5 s reaper waits behind it.

## 2. The worker boundary

### 2.1 One new program: `bin/housekeeping.worker.ts`

| Job kind                | Replaces (on main today)                                                         | Inputs it is sent                                                                                  | Returns                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `credential.local`      | `#classify`, `material`→`readCodexAuthFacts`, `#emails`, the sha256              | a `StoredCredentialResolution`: paths, keychain service/account names, harness                     | `{state, expiresAt?, fingerprint?, codex?: {exp?, lastRefresh?, accountId?}, email?}` — **facts, never material**    |
| `credential.active`     | `#activeRead`'s classify + `probeCredential` (material, then bearer, then fetch) | the resolution, timeout                                                                            | `{result: FleetUsageProbeResult, fingerprint?}`, where the fingerprint is of the very material whose bearer was used |
| `usage.passive.claude`  | `FilePassiveUsageStore.read`                                                     | the credential id                                                                                  | `PassiveUsageRecord` or nothing                                                                                      |
| `usage.passive.codex`   | `credentialPassiveUsage`'s rollout read and decompress                           | `[{credential, files[]}]`, an attribution main computed from its index and cached config documents | the newest `rate_limits` per credential                                                                              |
| `codex.discover` (PR 4) | the Codex rollout walk                                                           | the Codex home, the claimed ids, a cursor                                                          | candidate bindings `{session, file}` for main to apply                                                               |
| `probe`                 | —                                                                                | `{probe: true}`                                                                                    | `{probe: true}` (the `bundled-worker.ts:51-95` contract)                                                             |

The worker keeps no state between jobs. All memory lives on main: heads, the cached facts, the model, the
flights. So a crash loses nothing (§2.5).

**Why not merge into `analytics-fold`?** It is the cheaper option (one fewer thread, about 4–15 MB). But a
fold can run for seconds on a 32 MiB transcript, the thread cannot be preempted, and fleet reads are what a
person waits on (Check now, the Settings logins list). Folds are also the jobs that crash on bad input. Both
programs are built on one generalised host (`BundledWorkerHost`, extracted from `WorkerTranscriptFolds`,
`src/adapters/analytics/worker-transcript-folds.ts:46-131`). Merging them later is a wiring change. This is
open question Q2.

**Lifetime.** Today `analytics-fold` starts lazily, ends after 30 s idle and has a 120 s timeout per job. The
housekeeping worker:

- stays alive while fleet collection is enabled, because the time-driven read recurs every `usage.interval`
  and starting a bundled worker costs about 55 ms of readiness (stage 3 §3.4);
- ends after 30 s idle otherwise;
- has a 30 s timeout per job, which is longer than the probe's 20 s fetch bound plus the 5 s keychain bound.

### 2.2 What stays on main, and why

| Stays on main                                                                                                            | Why                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CredentialStatusService`: its `SingleFlight`, `observe`/`checkNow`/`view` policy, `InMemoryCredentialStatusStore` heads | The flight is shared with launch renewal (U12) and Check now. A second lock in the worker would break the "Check now joins the in-flight read" promise. Policy is cheap; only its **ports** move.                  |
| `CachedUsageFeed`, `WatchedUsageFeed`, the provider-quota reader                                                         | Every route and failover reads them on main. Environment-login quotas go through `OutboundProviderAuthorizer`, one of the six vault holders `docs/secrets.md:40-47` names. The worker must never become a seventh. |
| `ConfigFilesService` and its watcher                                                                                     | The config owner. It has its own queue, the accepted-record write and `configChanges`.                                                                                                                             |
| Session index reads (`listSessions`, `readConfig`) for Codex attribution and analytics discovery                         | `DaemonStorage` owns the SQLite handle and the document cache (stage 3 §2.4). Main sends the worker _paths_, never a storage handle.                                                                               |
| Codex **Check now** refresh (`#codexRefresh`, `ProcessFleetTokenRefreshPort`)                                            | Person-initiated, under the flight, and it rewrites the canonical `auth.json` through the harness. Its follow-up active read does go through the worker port.                                                      |
| Analytics SQLite, reaper kills, warden decisions, failover migrations, every journal append                              | Same rule as stage 3: anything holding a lock, the index or the in-process listeners.                                                                                                                              |

### 2.3 Protocol

The protocol lives in `src/lib/housekeeping/protocol.ts`. It is a closed discriminated union with an
exhaustive `switch` on both sides and type-only imports. Every request carries `{id, generation}`.

**Main → worker**

| Message    | Payload                                                                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `probe`    | `{probe: true}`                                                                                                                                |
| `job`      | `{id, generation, kind, args}`, where `kind` is from §2.1 and `args` holds only paths, ids, keychain service and account _names_, and timeouts |
| `settings` | `{keychainTimeoutMs, fetchTimeoutMs, platform}`                                                                                                |
| `cancel`   | `{id}`, best effort                                                                                                                            |

**Worker → main**

| Message   | Payload                                                                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ready`   | `{generation}` or `{probe: true}`                                                                                                                                                                                                    |
| `result`  | `{id, ok: true, value}`. `value` is one of the result types in §2.1, all built from strings that are not secret, numbers and booleans.                                                                                               |
| `result`  | `{id, ok: false, failure}`. `failure` is a member of a closed enum (`keychain-locked`, `keychain-timeout`, `file-unreadable`, `http-<status>`, `network`, `parse`, `timeout`, `internal`). **It is never a caught `Error.message`.** |
| `metrics` | deltas `{spawns: {program→count, by}, fileReads, bytesRead, fetches, jobMs}`. This feeds the stage-0 recorder, because the main thread's `Bun.spawn` counter cannot see a worker's spawns (stage 3 §6.5).                            |
| `fault`   | `{kind, fatal}`, with a fixed sentence only                                                                                                                                                                                          |

All messages are small. The largest is a Codex attribution list, which is paths only.

**Diffs, not documents** (parent doc §4) applies here as well:

- No transcript event, rollout line, config document or credential blob crosses in either direction.
- `usage.passive.codex` returns one reading per credential, not the events it came from.

### 2.4 Credentials across the boundary

What the documents say:

- `docs/secrets.md:182-183,169-181`: runtime login tokens are **not** vault secrets. They are files or a
  keychain item that Ferretry never copies.
- `docs/design/harness-login.md:111-118`: credential material "never leaves that adapter" and exists only for
  the usage probe's bearer.
- Nothing yet says which thread the adapter runs on. This design pins it down.

Rules:

1. **The adapter that yields material runs only inside the worker.** `PlatformCredentialStore` (`storedMaterial`,
   `#walkStored`), the classifier and both usage probes are constructed in `bin/housekeeping.worker.ts`. In
   `bin/fyd.ts` they are no longer wired into `CredentialStatusService` (they stay wired for clone and sign-in,
   which are person-initiated and not on this path).
2. **Read, use, drop, in one function.** For `credential.active` the worker:
   1. reads the material (a file read, or `security … -w` on macOS);
   2. takes its sha256 fingerprint;
   3. extracts the bearer token;
   4. makes the HTTP call;
   5. returns.

   The blob and the token are locals of that async function. Nothing caches them: no module map, no closure
   kept past the call. This is how long they live on main today. The difference is that they are never
   structured-cloned into a second heap, and today's three reads become one.

3. **The protocol cannot carry material.**
   - The worker-side `CredentialMaterial` type is not exported from `protocol.ts`.
   - The result types are closed records of facts.
   - A type test (`tsd`-style `expectTypeOf`) asserts that no `value` member contains a field named `blob`,
     `token`, `accessToken` or `refreshToken`.
4. **Errors are a closed enum** (§2.3).
   - A JSC `JSON.parse` `SyntaxError` quotes part of its input, which here could be part of a token. So the
     worker never posts `String(error)`. Today `analytics-fold` does post its message, and that is fine for
     transcripts, but not here.
   - On main, the host's `onerror` handler logs "housekeeping worker stopped (job `<kind>`)" and **never** the
     `ErrorEvent.message`.
5. **A canary test** (integration): a fake store holds a known canary token. Run every job kind, including
   every failure path (bad JSON, HTTP 401, timeout, keychain exit 36), with a spy on both `postMessage`
   directions, on `fault`, and on the daemon's notices and journal. Assert the canary and its base64 form never
   appear.
6. **The worker holds no `SecretVault`.** The diet test (§4 PR 2) fails the bundle if it contains
   `secrets/file-secret-document-store`, `SecretRedactor` or `bun:sqlite`.
7. **No token is cached to save a `security` process.** The cost is paid at most once per active read, and
   §3 makes active reads rare. Keeping a token in worker memory between reads would be exactly the "lives
   longer than today" this rule forbids.

**Choosing between worker and main.** Keeping the read on main would also follow these rules. The worker is
still better for three reasons:

- the bearer token never exists in the main heap, which is the heap that serves every carrier;
- on macOS a `posix_spawn` under endpoint security may block the _calling_ thread until the exec is
  authorised. This is unverified (§5.3). If it is true, today every `security` read can stall the loop;
- sha256, zstd decompression and rollout parsing leave the main-thread profile.

### 2.5 Crash, timeout, fallback

This follows stage 3 §3.3:

- `onerror`, an unexpected close or a job timeout bumps the generation. Pending jobs reject with `internal`,
  and the caller treats that as "unreadable / inconclusive", which is today's catch path
  (`credential-status.ts:746-760`). Late messages from an old generation are ignored.
- Restarts back off from 1 s to 60 s.
- Five crashes in 10 minutes switch to `InlineHousekeepingPorts` on main, which is PR 1's code, kept until the
  next start, and raise one notice.
- Correctness never depends on the worker. Only where the cost lands does.

## 3. Event-driven fleet reading

### 3.1 What actually changes a fleet reading

A usage row and a credential view are a pure function of:

- (config, manifest, per-credential local facts, passive reading, status head, `now`).

So the fleet refresh's job reduces to keeping each of those inputs current. The table lists each one and what
changes it.

| Input                                                           | Source path / item (watch target)                                                                                                            | Changes when                                                                                                                | Measured rate (Linux box, 150 s, `inotify` probe)         | Event source → action                                                                                                                                                                                                                                          |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config: logins, runtimes, components, machine, `advanced.usage` | `<home>/config/**/*.yaml`                                                                                                                    | the owner edits, `fy config`, the PWA                                                                                       | 0                                                         | the existing config watcher's `afterLoad` (`bin/fyd.ts:9143-9156`) → recompute resolutions; send `credential.local` only for credentials whose resolution changed                                                                                              |
| Fleet manifest                                                  | `<home>/fleet/manifest.json`                                                                                                                 | `fy fleet apply`                                                                                                            | 0                                                         | hub `subscribe` → recompute rows (no I/O beyond the parse)                                                                                                                                                                                                     |
| Claude login, ferretry store                                    | `<home>/fleet/credentials/<id>/.credentials.json` (Linux; the macOS fallback file)                                                           | sign-in, sign-out, Claude's own token refresh                                                                               | 0                                                         | hub `subscribe` → `credential.local`                                                                                                                                                                                                                           |
| Claude login, host store                                        | `~/.claude/.credentials.json` (Linux)                                                                                                        | same                                                                                                                        | 0                                                         | hub `subscribe` → `credential.local`                                                                                                                                                                                                                           |
| Claude login, macOS                                             | keychain item `Claude Code-credentials[-<sha256(dir)[0:8]>]`, account `$USER` (`credential-store.ts:639-656`)                                | same                                                                                                                        | —                                                         | §3.3                                                                                                                                                                                                                                                           |
| Codex login                                                     | `<home>/fleet/credentials/<id>/auth.json`, or the host `~/.codex/auth.json` (the **canonical** file, not the per-home symlink)               | sign-in, a refresh by any Codex process                                                                                     | 0                                                         | hub `subscribe` → `credential.local`                                                                                                                                                                                                                           |
| Claude email                                                    | `sign-in/.claude.json`, `~/.claude.json`                                                                                                     | sign-in only. **`~/.claude.json` is rewritten constantly by running Claude** (project stats)                                | —                                                         | **not watched**: re-read inside `credential.local` only when the credential's fingerprint changed (a new login means a new token)                                                                                                                              |
| Claude passive usage                                            | `<home>/fleet/credentials/<id>/usage.json`, written atomically by `fy statusline` (`packages/cli/src/adapters/statusline/index.ts:53`)       | **every ~6 s per credential while a session runs**                                                                          | **26 and 21 atomic renames** in 150 s for two credentials | hub `subscribe` → `usage.passive.claude` (a 168-byte file), coalesced to at most one in flight per credential. **A passive update never triggers a credential read or a network call.**                                                                        |
| Codex passive usage                                             | rollout `*.jsonl[.zst]` attributed through session configs                                                                                   | every `token_count` event of a running Codex session                                                                        | —                                                         | stage 3: the session worker already parses that rollout's tail, so it posts `rateLimits {session, at, primary, secondary}`. Without a session worker: hub `subscribe` on the attributed rollout, then `usage.passive.codex`. Stopped sessions never change it. |
| Status that depends only on time                                | cached `expiresAt`, Codex `exp` − 5 min (`credential-status.ts:197`), `last_refresh` + 8 d (`:200`), a negative conclusion + 15 min (`:194`) | time                                                                                                                        | —                                                         | **one pure timer** at the earliest threshold → recompute views. No I/O.                                                                                                                                                                                        |
| Provider usage windows (5 h / weekly / `wham`)                  | the provider                                                                                                                                 | consumption **on any device signed into that account** (another machine, claude.ai, the phone) and the reset at `resets_at` | —                                                         | **the only time-driven read** (§3.2)                                                                                                                                                                                                                           |
| Environment-login quotas                                        | the provider through the vault                                                                                                               | —                                                                                                                           | —                                                         | unchanged: read only while someone watches, behind a 60 s staleness gate (`docs/provider-quotas.md:31-39`). The `load()`s on that path are removed by PR 1.                                                                                                    |

**Hub notes**

- The FileEventHub (`src/lib/file-events/hub.ts:113-197`) watches each directory once and re-stats subscribed
  paths after 25 ms on any event. So an atomic `rename` save is seen as a stamp change on the real name. It can
  watch paths outside the state home.
- On Linux the hub uses its own inotify source, so dot-files are reported.
- On macOS `BunFileEventSource` treats names starting with `.` as unreported
  (`src/adapters/file-events/bun-file-event-source.ts:69-71`). So `.credentials.json` falls back to a 5 s stat
  poll, which is cheap and listed in `fallbacks()`.
- `fallbacks()` must reach the profile's `limitations`. It does not today; that is a stage-2 gap, closed in
  PR 3.

### 3.2 The one time-driven read, and its cadence

**Rule (unchanged): a credential gets an active read when its newest passive reading is older than
`usage.interval`** (`needsActiveUsageRead`, `credential-status.ts:525`; default 60 s).

- PR 3 keeps that rule and only changes _how it is scheduled_. The scheduler computes each credential's next
  due instant (passive `at` + interval, or last active `at` + interval), arms one `setTimeout` for the earliest
  one, and submits `fleet refresh` to the lane only when at least one credential is due.
- A credential whose session is running has a passive reading about every 6 s, so it is **never** due. Only
  idle credentials are read, at most once per interval.

**Why time is needed here at all**

- Local consumption is already observed passively, within seconds.
- Consumption on _other devices_ signed into the same account can only be seen by asking the provider.
- Windows reset at `resets_at`.

**Why 60 s is kept for now.** It is the declared default, failover's freshness gate is built around it, and
changing it is a behaviour change.

**Recommendation (Q1): move the default to 300 s, plus one read at each window's `resets_at` + 30 s.**

- Resets are then seen within 30 s, which is better than now.
- Consumption elsewhere is seen within 5 minutes. 300 s is `USAGE_REFRESH_MS`, the documented conservative
  default (`feed-policy.ts:15`), and also failover's default tick, so failover could not act faster anyway.
- On the Mac that turns about 2 `security` spawns a minute into 0.4.

### 3.3 macOS Keychain: detecting a changed item cheaply

On macOS, Claude logins live in the login keychain. Reading the secret is an exec
(`security find-generic-password -w`) that endpoint security inspects (p95 1.5 s on the owner's Mac). The goal
is an exec only when the item actually changed, and never just to _look_.

**What we know without a Mac** (from the code and Apple's public tooling behaviour):

- `security find-generic-password`/`add-generic-password` use the **file-based** keychain search list. The
  default is `~/Library/Keychains/login.keychain-db`. The data-protection keychain
  (`~/Library/Keychains/<UUID>/keychain-2.db`) is a different store that the `security` CLI does not write.
  Claude writes through `security` (`docs/design/account-model.md:665`, still marked as an inference, G1).
- So **any write to a Claude item modifies `login.keychain-db`**. So does a write from any other app to any
  login-keychain item. The file's stamp (ino, size, mtime) is therefore a _necessary_ signal, but a noisy one.
- The basename `login.keychain-db` is not a dot-file, so the macOS hub would watch `~/Library/Keychains`
  (and, because `reportsRemoval()` is false, its parent `~/Library`).
- Generic-password items carry a modification date attribute, `mdat`. Reading **attributes only** (no `-w`,
  or `SecItemCopyMatching` with `kSecReturnAttributes` and no `kSecReturnData`) does not unlock the secret.
  On file-based keychains it does not trigger the item's ACL prompt.
- The time-driven active read **re-reads the material anyway** to get the bearer token. So a credential that
  gets active reads gets fresh local facts for free. Detecting changes only matters for credentials whose
  session is running (no active reads) and for how fast a sign-in or sign-out shows up.

**Proposed ladder** (the worker runs every step; main sees only facts):

| Level  | Trigger                                                                    | Check                                                                                                       | Exec per change                                                                                                            | When used                                     |
| ------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **K0** | hub stamp change on `~/Library/Keychains/login.keychain-db`, coalesced 2 s | `mdat` of each Claude item through `bun:ffi` → `Security.framework` `SecItemCopyMatching` (attributes only) | `security … -w` **only for an item whose `mdat` moved**                                                                    | default, if verification items 1–6 below pass |
| **K1** | the same stamp change                                                      | none                                                                                                        | one `security … -w` per Claude item, at most one per item per 30 s                                                         | FFI unavailable or refused                    |
| **K2** | no file event (the hub is in fallback)                                     | none                                                                                                        | piggybacks on the active read; an item with a fresh passive reading (no active reads) gets one `security … -w` every 5 min | the stamp is not watchable                    |

Under every level, a running Claude process that refreshes its token writes the item. So K0/K1 see it within
about 2 s, where today it takes up to one interval.

**What must be verified on the owner's Mac** (each is a small script; PR 3 ships K0 only after 1–6 pass):

1. `security find-generic-password -s "Claude Code-credentials"`: its `keychain:` line names `login.keychain-db`.
   Repeat for one `-<hash>` item.
2. Write a throwaway item (`security add-generic-password -U -s fy-probe -a "$USER" -w x`, then update it,
   then `delete-generic-password`). Record `stat -f '%i %z %m'` of `login.keychain-db` before and after. Does
   each write change mtime? Is it rewritten **in place or by rename** (does ino change)?
3. **The background write rate** of `login.keychain-db` during an hour of normal work: stat it every 1 s.
   Above about 1/min, K0's FFI check runs that often. It is cheap, but needs a number.
4. Bun `fs.watch` (the hub's macOS source) on `~/Library/Keychains`: does it deliver an event for each write
   from item 2, and with what latency? Does the hub's parent watch of `~/Library` flood (FSEvents is
   recursive by nature)? If it does, the macOS source needs a "no parent watch" option for this one path.
5. Is `~/Library/Keychains` stat-able from the **launchd-started** daemon (TCC / Full Disk Access)?
6. `bun:ffi` `SecItemCopyMatching` for `{class: genericPassword, service, account, returnAttributes: true,
matchLimit: one}` from the **compiled** `fyd`, inside a Worker: is there no prompt, is `mdat` present, does
   it move when Claude refreshes, and what does one call cost?
7. Loop lag during one `security` spawn **on the main thread**: does `posix_spawn` block the caller under
   endpoint security? This sets how much moving the spawn to the worker matters.
8. The housekeeping worker's RSS in the compiled binary.
9. Linux showed this (2026-10-22, Bun 1.3.13): `fs.watch` on a directory holding a **dangling symlink**
   (`auth.json` → an empty `credentials/codex-*`) emits one `ENOENT` `error`. The hub's Linux source is
   inotify and is not affected, but the macOS source is `fs.watch`. Check that the hub turns that `onError`
   into a `failed` fallback for that directory rather than losing it. Watch canonical credential paths, never
   the per-home links.

### 3.4 The model on main

**`FleetReading`** (`src/lib/fleet-reading/`, unit ledger) is a stateless fold:

- `step(state, input, now) → {state, jobs[], recompute}`.
- `state` holds, per credential: the resolution, local facts and the stamp they were read at, passive
  readings, the head reference and `nextDue`.
- Inputs: `configLoaded`, `manifestChanged`, `fileChanged(path)`, `keychainChanged`, `passive(credential,
reading)`, `rateLimits(session, reading)`, `jobResult`, `tick`.
- Its output jobs are the worker job kinds from §2.1.
- Projections: `views(state, heads, now) → FleetCredentialView[]` and `rows(manifest, views)`. These are
  today's `credentialUsageRows`/`usageRow`, unchanged.

**What reads it**

- `CredentialUsageSource.read` returns `rows(...)` with no I/O. The feed's TTL and last-good rules stay as
  they are.
- `fleetCredentials.list()` and the routes and catalog facts that call it directly read `views(...)`.
- The logins route, `republish()` and the tools snapshot stop re-reading credentials.

**Freshness semantics for failover and the warden.** The snapshot's `at` must stay "when the evidence was
collected": the oldest contributing reading, not the projection time. Otherwise failover's freshness gate would
trust a reading it should not. A unit test pins this.

## 4. Staging — behaviour-identical PRs

Every PR keeps the full suite green. Each body carries a before/after `fy daemon profile` from the owner-scale
fixture and from the live box, plus on the Mac once PR 2 ships.

**Baseline for the CI idle budget** (`tests/realworld/runtime/idle-budget.test.ts:36-49`, measured by #702):

|               | Measured | Ceiling |
| ------------- | -------- | ------- |
| CPU           | 15.5 %   | 30      |
| Children      | 0/min    | 30      |
| Longest block | 5 ms     | 100     |
| Port file ops | 9/s      | 100     |
| Syscalls      | 1,472/s  | 3,000   |

**The current CI budget cannot see stage 4.**

- The fixture (`tests/integration/support/scaled-fleet.ts:197-202`) creates empty runtime homes with **no fleet
  config, no credentials and no manifest**. So the fleet refresh has nothing to read, and runs on the 300 s
  fallback.
- The 20 s profile window (`:30-31`) starts about 16 s after ready, so the 60 s analytics and self-check ticks
  fall outside it.

PR 2 therefore extends the fixture (below) before claiming numbers.

| PR                                                      | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Behind                                                        | Expected (fixture → live Linux box → owner's Mac)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PR 0** (fix, tiny, independent)                       | Sequence the pass: `observeAll()` settles before `accounts()` collects. Or `list()` inside the unattended pass ignores that pass's own flight. Add a test that reproduces the cached `checking` row first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | nothing                                                       | No idle delta. Removes the intermittent "unknown" usage row. **This is a behaviour fix and is declared as one.**                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **PR 1**: one config snapshot, cached facts (main only) | (a) `ConfigFilesService.load()` returns the last snapshot when no subscribed config directory has had a hub event since that load. Any directory in fallback forces a stat-fingerprint check (the watcher's own fingerprint). `writeOwn` invalidates. Every `load()` caller (account model, catalog, presets, the warden's per-event read, `modelCatalogs()`, `quotaReader.watch()`) gets this without edits. (b) Per-credential local facts cached by **file stamp** (Linux, macOS fallback file, Codex `auth.json`). Keychain-backed facts are cached for one `usage.interval` (today they are re-read every pass, which _is_ one interval). (c) `observe()` reads material once: the active read returns `{result, fingerprint}`, replacing classify + probe read + classify (3 → 1). (d) `list()` reuses (b)/(c), so it spawns nothing. (e) `activities.run` wraps the seven unattributed jobs (§1.3).                                                                                                                                                                                      | nothing                                                       | **Fixture**: about 0 (inputs are absent). **Live box**: config `listDirectory` about 3.2/s → about 0; fleet refresh p50 1.3 s → network only (about 0.4–0.8 s); `/v1/usage` p50 1.5 s → under 100 ms. **Mac**: `security` 5.9/min → about 1 per idle Claude login per interval (about 2/min); fleet refresh p50 5.0 s → under 1.5 s.                                                                                                                                                                                                                                      |
| **PR 2**: the housekeeping worker                       | `bin/housekeeping.worker.ts`; add `'housekeeping'` to `BundledWorkerName` (`src/adapters/runtime/bundled-worker.ts:17`); `BundledWorkerHost` extracted from `WorkerTranscriptFolds` (lazy start, generation, per-job timeout, back-off, inline fallback); `WorkerCredentialPorts`, which implements `CredentialStatusPorts` by sending jobs. In `packages/fleet`, `CredentialStatusPorts` is re-cut: `classify`+`material` become `local(resolution) → LocalFacts`, and `activeUsage` returns `{result, fingerprint}`, so no port returns material. The worker's spawn/file counters go into `metrics`. A probe in `fyd --check` (`bin/fyd.ts:7620-7623`) and the smoke `workers` line. **Diet test**: no `bun:sqlite`, `session-storage`, vault or redactor; zod is allowed (one worker). **Canary test** (§2.4). **Fixture extension**: 2 Claude credentials (file store) plus 1 Codex `auth.json`, a manifest and fleet config with `usage.interval: 10`, a loopback fake usage server (the probe URL becomes injectable), and a 30 s profile window, so at least two passes land inside it. | `housekeeping.enabled`, default **on**; `false` = PR 1 inline | **Fixture**: main-thread CPU profile has **no** frame from `credential-classifier`, `rollout-rate-limits`, `config-files/evaluate` or the probes; main-thread children from fleet → 0, and the worker's appear under `workers` with `by: fleet refresh`; RSS budget for the worker ≤ 25 MB (bundled). **Mac**: the `security` spawns leave the main thread (item 7 shows whether that removes stalls).                                                                                                                                                                    |
| **PR 3**: event-driven fleet reading                    | `FleetReading` model (§3.4); hub subscriptions for credential files, `usage.json`, the manifest and canonical `auth.json`; the config watcher's `afterLoad` hook; stage 3's `rateLimits` input (or hub on rollouts until 3c lands); the scheduler for the time-driven read (§3.2); the pure status-threshold timer; macOS keychain K0/K1/K2 (§3.3), with K0 only after verification; `fileEvents.fallbacks()` → profile `limitations`. The `fleet refresh` lane job now only runs due active reads.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | same flag                                                     | **Fixture**: with nothing changing, 0 credential reads, 0 config loads and 0 manifest reads in the window; `fleet refresh` runs equal to due credentials × window / interval; a touched `.credentials.json` is re-read within 1 s. **Live box**: the two Claude logins with running sessions are never due (passive about every 6 s); the one idle Claude login gets one GET per minute; Codex logins that are not signed in cost nothing. **Mac**: `security` spawns only on a keychain change or an active read (about 1/min at 60 s, about 0.2/min if Q1 is accepted). |
| **PR 4**: the remaining timers become events            | Analytics ingest on session terminal transitions (stage 3a's `facts` hook, or today's `storage.subscribeEvents`), plus config and pricing changes, plus a boot sweep, plus a 15 min backstop (`REFUSAL_RETRY_MS` already exists); candidate selection from the index rows instead of zod-parsing every config and state. Codex rollout discovery's walk → `codex.discover`. The update check reads statuses from the index. Handover reconcile visits only receipts main knows are open (verify that no other writer exists), plus a boot pass. The terminal reaper on terminal transitions and `exited`, plus `subscribeDirectory(sessions/)`, plus a 60 s backstop, **only if 3d has not already done it**. On Mac, a fleet `ps` job if stage 3 Q4 chooses it.                                                                                                                                                                                                                                                                                                                                | flag removed                                                  | **Live box**: port file ops 57.3/s → about 40/s (reaper −14/s, config −3/s); analytics passes 1/min → per finished session; handover's raw reads (uncounted today) → about 0. Stage 4's exit criterion: in a 30 min idle profile, **no housekeeping activity is the top frame of any stall ≥ 100 ms**, and no housekeeping job's CPU appears in the main-thread sampled stacks.                                                                                                                                                                                           |

**Where stage 3 meets stage 4**

- PR 2 and 3a/3b are independent.
- PR 3's Codex passive input is cleanest after 3c, whose session worker posts `rateLimits`. Before that, PR 3
  uses hub subscriptions on attributed rollouts.
- PR 4's reaper item is dropped if 3d has landed.
- Stage 3 §8 Q3 (transcript resolution) and Q4 (one fleet `ps`) both land in PR 4.

### 4.1 PR 2 as built

What shipped, where it differs from the plan above, and what it measured.

**The pieces**

- `bin/housekeeping.worker.ts` — the worker program. It keeps nothing between jobs. It is told its
  `settings` (platform, keychain account, default Claude home, fleet root, probe URLs) once per thread.
- `src/adapters/runtime/bundled-worker-host.ts` — `BundledWorkerHost`, extracted from
  `WorkerTranscriptFolds`. It handles the lazy start, a greeting per thread, the per-request timeout, the idle
  end (read when the thread goes idle), stale-thread messages, back-off from 1 s doubling to 60 s, and
  retirement after 5 failures in 10 minutes. The analytics folds use it with no restart policy, so their
  behaviour is unchanged.
- `src/adapters/housekeeping/job-runner.ts` — `runHousekeepingJob` and `hostHousekeepingPorts`. This is the
  one job code, run by the worker and, as the fallback, by the main thread (`InlineHousekeepingJobs`).
- `src/adapters/housekeeping/worker-housekeeping.ts` — `WorkerHousekeepingJobs`. Jobs go to the worker. While
  it backs off, or once it is retired, they run inline. A job that was in flight when the thread failed is
  refused, and the status service reads that as an unreadable store or an inconclusive check, as before.
- `src/adapters/housekeeping/credential-ports.ts` — `WorkerCredentialPorts`, the status service's `local`,
  `activeUsage` and `passiveUsage` by job. The kept facts and their stamps stay on main
  (`CachedCredentialReads`), so a store whose stamp held sends no job.
- In `packages/fleet`, `CachedCredentialReads` now asks a facts-only `CredentialStoreReads`.
  `MaterialCredentialReads` is the one place material exists: read, facts or one bearer, dropped.
- `housekeeping.enabled` in `daemon.json`, on by default. `false` runs every job inline (the PR 1 behaviour).
- `fyd --check` probes `housekeeping`, and the release smoke requires it by name on the `workers` line.
- `FY_USAGE_PROBE_ORIGIN` sends both free reads to a loopback server, for the fixture. It refuses anything that
  is not a plain loopback origin.

**Differences from the plan**

- Protocol: no `cancel` and no `fault` message. Every job is bounded by the 30 s timeout, and a thread that
  fails is ended. Its `onerror` is reported in a fixed sentence (`the housekeeping worker stopped`), never
  the runtime's message. The failure enum is only what a worker can actually say: `internal` (the job
  threw) and `unsettled` (a job before settings). A locked keychain, an HTTP status or bad JSON are already
  answers (facts, a probe result), not job failures.
- `codex.discover` is not here. It belongs to PR 4, as the job table says.
- `metrics` crosses per job: the child argv, file reads, requests, wall time and the worker's own heap. Main
  labels each child with `commandLabel`, so a keychain item's name never reaches a report, and attributes it to
  the main-thread activity that asked (`fleet refresh`). The report's `workers[].work` carries it. The
  `child processes` budget counts a worker's children with main's, because a spawn costs the machine the same
  wherever it starts.
- The process RSS cannot be split by thread. So the budget is a test: the bundled worker is started in a fresh
  process and must add ≤ 25 MB (`housekeeping-worker-bundle.test.ts`). It measured 15–19 MB on Linux with
  Bun 1.3.13.
- To fit that budget, the worker imports `@ferretry/fleet/credential-worker`, a narrow entry. `fleet/lib/usage.ts`
  and the Anthropic probe no longer import the wrapper generator and the account schema, by way of the new lean
  modules `shell-quote.ts` and `account/credential-directory.ts`. That took the bundle from 888 KB to 629 KB
  and the memory from about 46 MB to 15–19 MB. A diet test holds the bundle to no SQLite, session storage,
  vault, redactor, protocol schemas or account schema. zod stays.

**Open questions, as decided for PR 2:** Q1 keep 60 s. Q2 one housekeeping worker, separate from
`analytics-fold`. Q3 no `Security.framework` FFI; a keychain item's facts are kept for one interval, as in
PR 1. Q4 and Q7 are PR 3's. Q5 the self-check fixes are a separate PR.

**Measured** (`scripts/local/bench-idle-daemon.ts --small --trace --syscall-summary`, Linux fixture with
2 Claude and 1 Codex login in file stores, `usage.interval` 10 s, loopback usage server):

|                         | PR 1 (inline) | PR 2 (worker)                                                |
| ----------------------- | ------------- | ------------------------------------------------------------ |
| Daemon CPU (own report) | 7.85 %        | 8.26 %                                                       |
| Children                | 0/min         | 0/min                                                        |
| Port file ops           | 9.5/s         | 9.5/s                                                        |
| Read/write syscalls     | 192/s         | 200/s                                                        |
| Longest block           | 4 ms          | 3 ms                                                         |
| Fleet refresh           | 6/min, p50 16 | 6/min, p50 15                                                |
| RSS mean                | 334 MB        | 348 MB (the worker)                                          |
| Worker                  | —             | 66 jobs/min, 66 file reads/min, 18 requests/min, heap 4.2 MB |

On Linux, with file stores and a loopback server, a pass is cheap. So the move shows as attribution, not
as CPU: no credential, probe or rollout frame is on the main thread, and the worker's work appears under
`workers`. Nothing changed on the idle-budget measures, so no CI ceiling is earned here. On the Mac the
`security` children leave the main thread: they appear as the worker's children, `by: fleet refresh`.
Verification item 7 (§3.3) will show whether that removes stalls. The jobs per pass, about 11, include passive reads
that both `observe` and `view` make. PR 3's model reads each input once, on change.

### 4.2 PR 3 as built

**The pieces**

- `src/lib/fleet-reading/model.ts` — the pure part. For each stored credential it keeps the newest passive
  reading (and whether that reading is current) and when a pass last observed it. It turns the unchanged
  active-read rule into instants: `activeUsageReadDueAt`, in `packages/fleet` beside `needsActiveUsageRead`,
  gives `max(measured passive at, observed at) + usage.interval`.
- `src/lib/fleet-reading/service.ts` — `FleetReading`. It watches through the file-event hub:
  - each store file (`.credentials.json`, canonical `auth.json`);
  - each Claude statusLine `usage.json`;
  - each Codex credential's attributed rollouts (hub subscriptions; Q7's session-worker `rateLimits` is not
    needed for this).

  A passive change is ONE coalesced passive job for that credential. It never reads a store, never asks a
  provider and never starts a pass. A store change bumps that file's generation and re-reads its facts
  at once. While the watch is live, the generation is the stamp `CachedCredentialReads` compares, so an
  unchanged store costs no system call. A watch that is not live, or a passive reading that is not
  current, is never trusted: the answer is read directly, as before. It also implements
  `FleetRefreshSchedule`: it arms one timer for the earliest due credential. The boot pass always
  runs, and a feed with an external collector (`usage.url`), which only time refreshes, keeps one pass an
  interval, as before.

- `FleetRefreshService.arm` replaces the fixed `setInterval`. A pass observes only the credentials that are
  due (`observeAll(ids)`) and then tells the reading. The timer fires outside every activity
  (`ActivityLedger.outside`, new). Otherwise each pass was counted inside the one that armed it
  (`fleet refresh › fleet refresh › …`).
- `WatchedDocument` keeps the parsed fleet manifest for the usage feed until its watch sees a change.
- The config watcher's `afterLoad` calls `configLoaded()`, so added or removed credentials open or close
  their watches.
- `WorkerCredentialPorts` loses its passive half; the reading owns it now.

**Not in PR 3, as decided:**

- No keychain ladder (§3.3 K0/K1). Q3: a keychain item's facts are kept for one interval, as in PR 1.
- No pure status-threshold timer. Views are decided when they are read, so a time-only change (an expiry)
  shows up at the next read, exactly as before.
- The Claude account email is still stamped per list. Re-reading `~/.claude.json` only on a fingerprint
  change is left for later.

Q1: 60 s is kept. Q4: a sign-in, sign-out or token refresh is now seen within about a second (accepted).

**Measured** (same bench and fixture as §4.1; another worktree's bench ran on the box at the same time, so
process CPU is within noise):

|                     | PR 2                    | PR 3                    | PR 3 + one running session (`--statusline`)          |
| ------------------- | ----------------------- | ----------------------- | ---------------------------------------------------- |
| Housekeeping jobs   | 33 per 30 s             | 9 per 30 s              | 11 per 30 s (6 active reads, 5 passive)              |
| Fleet refresh       | 6/min, p50 15           | 6/min, p50 10           | 6/min, p50 11                                        |
| Free reads (run)    | Anthropic 32 · Codex 16 | Anthropic 32 · Codex 16 | Anthropic 10 · Codex 10: `claude-work` gets **none** |
| Daemon CPU          | 8.26 %                  | 8.2 %                   | 7.75 %                                               |
| Read/write syscalls | 200/s                   | 192/s                   | 195/s                                                |
| strace file calls   | 160/s                   | 157/s                   | —                                                    |

What is left of a pass is the due active reads: 3 logins × 1 per interval on this fixture, whose logins have
no running session. A login whose session is writing its statusLine is never due. No CI idle-budget ceiling
moved, because the process-level measures are flat on Linux, so none is earned.

### 4.3 PR 4 as built

**The pieces**

- `src/lib/runtime/pass-trigger.ts` — `PassTrigger`. One timer: the earlier of the next nudge and one backstop
  after the last pass. A burst of nudges is one pass. It never runs the pass itself; the composition root
  submits it to the housekeeping lane. Its timers fire outside every activity, as PR 3's do.
- **Analytics ingest.** The 60 s `setInterval` is gone. A pass is nudged by:
  - a state write that `owes` one (`AnalyticsIngestionService.stateWritten`, fed by `storage.subscribeStates`):
    a session that has ended (30 s settle, `ANALYTICS_ENDED_SETTLE_MS`, so the transcript's last lines land),
    or a session that has not ended but whose row the index holds — a revive, whose row must go;
  - a change to the rates (5 s): a pricing write through `AnalyticsPricingService`, a config reload
    (`afterLoad`), a newer published model catalog, a changed Ollama model list;
  - a pass that stopped at its read cap (60 s, `ANALYTICS_CATCH_UP_MS`), until the backlog is read;
  - the backstop, `ANALYTICS_BACKSTOP_MS` = 15 min = `REFUSAL_RETRY_MS`.

  The boot pass is unchanged. Candidates come **from the index first**: a session whose indexed status is not
  a terminal one is not read at all (the gate would refuse it), so a pass reads and parses only ended
  sessions' documents.

- **Terminal reaper: dropped from PR 4, as planned.** Stage 3d (#740) already sweeps it on a terminal state
  write or `session.exited`, with a 60 s backstop. PR 4 keeps that.
- **Handover reconcile.** `RememberedHandoverReceipts` wraps the file store. After one full read it keeps the
  set of open receipts in memory and follows every write; a read that answers `null` drops one. Verified: the
  handover service is the only writer of `handover.json`. The loop arms its 15 s tick only while a receipt is
  open and drops it once a pass finds none. One backstop, `HANDOVER_RESCAN_INTERVAL_MS` = 15 min, reads
  every receipt again. A write made during a full read is applied over its answer.
- **Update check.** The 60 s loop is gone. Stage 3a had already made `midTurn()` a memory read. A pass now
  runs at boot, on the backstop (`UPDATE_BACKSTOP_INTERVAL_MS` = 15 min, so GitHub is still asked at most every
  6 h, at the first look after it falls due), and on `activityChanged()` — called for every state write, and
  free unless the last pass was held back by a ferret mid-turn. Passes are serialized: a second ask joins the
  running one, so two passes can never both launch.
- The profile's limitations name the four backstops.

**Not in PR 4**

- **Codex discovery.** It has no fixed timer: it is paced per read (a 2 min eager window from the session's
  start, then 30 s). The event that would replace the pace is a watch on the home's dated rollout directory,
  and the move of the walk to the worker (`codex.discover`) needs the walk's caches, which live on main while
  the worker keeps nothing between jobs. Both were left for a follow-up, built in §4.4.
- No Mac fleet `ps` job: stage 3 Q4 has not chosen it.

**Behaviour differences, all toward sooner:** an ended session is ingested 30 s after it ends (it was up to
60 s); a pricing edit re-prices within about 5 s; an update waiting for idle launches at the write that ends
the last turn (it was up to 60 s); turning automatic updates on looks at once. **Toward later**, only for
inputs with no event: a session directory removed by hand leaves its analytics row up to 15 min (was 60 s); a
refused transcript read that only time clears is retried on the 15 min backstop, which is already how long a
refusal stands; the six-hourly GitHub ask is up to 15 min late.

**Measured** (`scripts/local/bench-idle-daemon.ts --small --trace --syscall-summary --seconds 60`, the §4.1
fixture; before = `origin/main` at `c63f4840c`, which already has stage 3d's event-driven reaper):

|                          | Before | After  |
| ------------------------ | ------ | ------ |
| strace file calls        | 53.6/s | 44.9/s |
| `handover.json` `openat` | 2.4/s  | 0      |
| `state.json` `statx`     | 3.9/s  | 3.3/s  |
| Port file ops            | 2.5/s  | 2.5/s  |
| Read/write syscalls      | 102/s  | 100/s  |
| Daemon CPU (outside)     | 5.8 %  | 5.3 %  |
| Longest block            | 25 ms  | 4 ms   |

The handover roster's reads were raw `node:fs` calls, outside the counted port, so they show in strace and not in
port file operations. Both windows hold one analytics pass: the boot rebuild catching up at its read cap, eight
transcripts a pass, which runs once a minute either way until the backlog is read. After that, this branch runs
none until an event or the backstop. No CI ceiling moved: port file operations are already far under a ceiling
that equals the product target (100), which a ceiling may not go below, and CPU is within noise. The
`session-version` and `config.json` `statx` left (about 16/s and 14/s) come from per-read document identity
checks by the transcript resolver and the fleet reading's Codex attribution, not from a housekeeping timer.

### 4.4 Codex discovery as built (`codex.discover`)

**The pieces**

- **The job.** `codex.discover` carries the Codex home, the session's correlation token and its baseline ids
  (`skip`), and answers `{candidates, changed, frontier}`: what each rollout outside the baseline is and whether
  it carries the token, how many listing changes the walk saw, and the directories a new rollout would appear
  in. Main keeps everything else, as §2.1 said: `CodexDiscoveryPacer` (#697, #703), the claims, the selection
  and the `updateConfig` that binds the rollout. `HousekeepingCodexRollouts`
  (`src/adapters/housekeeping/codex-rollout-jobs.ts`) is the resolver's `CodexRolloutIndex` on main: it sends
  the job and keeps the change count the pacer reads.
- **The cache the worker keeps.** The worker still keeps no state, but it does keep one cache: a
  `NodeCodexRolloutIndex` per thread, with its per-file facts and per-directory listings (#693, #697). Without
  it every walk would re-identify every rollout, about 2,000 header reads on the fixture. Losing it costs one
  cold walk, so a crash or a retired thread still loses nothing (§2.5). On main, the inline runner (switched off,
  or retired) walks with main's own index, the one the start's baseline read fills.
- **The watch.** The answer's `frontier` is `sessions`, its newest year and month, and its two newest day
  directories (two, so a session launched just before midnight is still heard). Codex files a rollout under the
  date its session started, so a new rollout, its first turn, a new day or a new month all land there. Main
  watches the frontier through the file-event hub (`subscribeDirectory`), follows it as it moves, and counts
  the events (`heard`). A newly watched directory counts as one event, so a change made while the walk was
  listing it is looked at once more under the watch.
- **The pace.** The pacer is unchanged, with one rule added. While every frontier directory is watched live, a
  discovery that is due by the clock alone (the eager window, or the 30 s interval) is skipped if no event has
  arrived since the last discovery **started**. A walk then could only find what the last one found. An event
  never makes discovery more frequent than #697 allowed. A listing change that another session's walk saw (it
  may be in an old day directory) is never treated as quiet. Without an event, the walk runs once every
  `CODEX_DISCOVERY_BACKSTOP_MS` (5 min), for a change no watch could hear. While any frontier directory is
  polled or missing, the clock decides, exactly as before. The profile's limitations name this backstop.

**Behaviour differences.** A session found quickly is found as before: its rollout's creation and first turn
are events in a watched directory, and the next read looks. **Later**, only for a change no watch can hear:
a rollout of an undiscovered session written into a day directory outside the frontier, say a resumed old
conversation that carries the new session's token, is found within 5 min, where it was within 30 s.

**Measured** (`scripts/local/bench-idle-daemon.ts --small --trace --syscall-summary --seconds 60`, the §4.1
fixture, which keeps two Codex sessions undiscovered; before = `origin/main` at `0c9f78cf1`, 4.75.1):

|                                                       | Before                       | After   |
| ----------------------------------------------------- | ---------------------------- | ------- |
| Main-thread CPU samples in `node-codex-rollout-index` | 1 % (`candidates`)           | none    |
| `codex.discover` jobs in the window                   | — (walks on main every 30 s) | 0       |
| `statx` of Codex dated directories                    | 1.0/s                        | 0       |
| strace file calls                                     | 44.9/s                       | 43.8/s  |
| Read/write syscalls                                   | 100.5/s                      | 100.4/s |
| Daemon CPU (outside)                                  | 4.7 %                        | 4.6 %   |

The two undiscovered sessions started long before the window, so before this they walked the home every 30 s
each, on the main thread; now each walked once after boot on the worker, once more under its new watch, and
then waits for an event or the 5 min backstop. The idle-budget test now fails on any main-thread frame of the
rollout index. No ceiling moved: CPU and read/write calls are within noise, and the walk was already paced.

## 5. Risks

### 5.1 Read-your-write after an edit

`load()` returning a snapshot is only as fresh as the hub event. That is 25 ms of settle plus the watcher's
300 ms debounce if it goes through the watcher. A reader that calls `load()` straight after an editor saves a
file could see the old snapshot, where today it sees the new file.

Mitigations:

- `writeOwn` (the daemon's own writes) invalidates synchronously.
- The hub's dirty bit is set _on the event_, not after the debounce.
- A directory in fallback always gets the stat-fingerprint check.

Leftover: an external edit read within about 25 ms of saving. Today's poll-free paths have the same window, and
it is acceptable for config. A test pins writeOwn → load.

### 5.2 Faster is still different

PR 3 sees a sign-in, sign-out or token refresh within about 1 s instead of up to one interval. That is
visible: Settings updates sooner, and failover sees a re-signed-in login sooner. It is the same shape as stage
3's exit-speed question. Accept it, or delay publication to the interval for parity (Q4)?

### 5.3 macOS unknowns

These are the list in §3.3. The design degrades safely:

- with no K0 it is K1;
- with no file events it is K2, which is still ≤ today's spawn count, because it piggybacks on the active read.

PR 3 must not ship K0 on assumption. The FFI path also adds a `bun:ffi` dependency on `Security.framework`. It
is loaded only on darwin, inside the worker, and falls back to K1 if `dlopen` fails.

### 5.4 Self-check (17.7 s on the Mac) is not fixed by stage 4

The self-check writes under `serial.runExclusive` and the SQLite index, so it stays on main. Reading the code,
its wall time comes from:

- up to three full directory surveys plus a deep `reconcile()`, each O(all session directories), under
  endpoint security;
- `runExclusive` queueing behind in-flight writes;
- tmux round trips per running session;
- **a feedback loop**: a stalled loop makes the tick late, a late tick triggers the deep pass
  (`src/lib/session/health/wedge.ts:43-56`), and the deep pass is the heaviest path;
- no guard against overlapping runs.

Proposed follow-up, outside these PRs:

- one survey per tick, shared by the consistency pass and the exit observer;
- skip a tick while one is running, without counting it as late;
- decide "late" from the lag meter rather than wall time;
- stage 3d removes the exit observer's per-session tmux calls.

The Mac profile first needs nested activities (`self-check › survey` …) to split the 17.7 s (Q5).

### 5.5 The worker's own cost

- About 4–25 MB RSS, measured in PR 2 (Q2 if merged with `analytics-fold`).
- Its CPU still counts against the process CPU budget, because `process.cpuUsage()` includes worker threads
  (stage 3 §6.5).
- Its children and file reads are invisible to main's instruments unless `metrics` reports them. PR 2's exit
  criterion is that `fy daemon profile` shows them under `workers`.

### 5.6 Secrets interplay with stage 3

The live box reads `secrets.key` 6.1/s through the redactor, likely the operator read path's pane and
transcript redaction (one vault read per redaction, uncached). Stage 3 workers produce `turnPrompt`,
`permissionRequest` and question text.

- **Redaction must stay on main, in the applier, before persisting.** A session worker must never hold the
  vault.
- The housekeeping worker never needs it.
- Uncached vault reads are a separate cheap fix: cache the vault by file stamp.

### 5.7 Codex attribution needs main's index

The `usage.passive.codex` job is sent paths that main computed from `listSessions()` and its config cache.
After 1a and 2 those are cache hits, so the per-pass "zod-parse every session config" disappears. It is
recomputed only when a session's config changes (the `facts` hook) or the index changes.

### 5.8 Lane semantics

The lane drops a duplicate only while it is waiting. An event burst (`usage.json` every 6 s × N credentials)
must not flood it:

- passive updates do **not** go through the lane at all; they are worker jobs coalesced per credential;
- only due active reads are submitted as `fleet refresh`.

## 6. Open questions for the owner

1. **Time-driven cadence**: keep `usage.interval` at 60 s (identical), or move the default to **300 s plus
   one read at each `resets_at`** (§3.2)? That trades seeing use on other devices up to 5 min late for about
   5× fewer provider calls and keychain execs.
2. **One worker or two**: keep `analytics-fold` and `housekeeping` separate (recommended: no head-of-line
   blocking of Check now, and fault isolation), or merge them to save about 4–15 MB?
3. **macOS keychain via `bun:ffi` (K0)**: acceptable to load `Security.framework` in the worker for
   attribute-only reads, provided §3.3 items 1–6 pass on your Mac? Or stay exec-only (K1)? Could you run the
   §3.3 script on the corporate Mac? It needs no secrets, and I can hand it over as one file.
4. **Faster login changes** (§5.2): show sign-in, sign-out and refresh within about 1 s once PR 3 lands, or
   hold publication to the interval for strict parity?
5. **Self-check**: take the four fixes in §5.4 as a separate PR alongside stage 4, after a nested-activity
   profile from your Mac?
6. **PR 0** (the cached `checking` row) is a behaviour fix on the unattended path. Land it first and on its
   own?
7. **Codex passive from session workers**: OK to add `rateLimits` to stage 3's worker → main protocol (a small
   extension of #701 §2.3), so Codex usage is fed by the agent's own worker instead of a fleet scan?
