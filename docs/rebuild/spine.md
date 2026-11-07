# Ferretry 5.0 spine contract (frozen after day 1)

The foundation every spine and porting helper imports. Design: [`docs/design/redesign.md`](../design/redesign.md)
(§-numbers below are its sections). After the lead freezes this file, a change to anything it lists needs the
lead's yes (`fy send britnee --kind blocker "<package>: need <change> because <why>"`) and is announced to everyone.

## 1. Decisions the design left open

| #   | Decision                                                                                                                                                                                                                                         | Why                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | The kernel lives at **`packages/core/kernel`**, npm **`@ferretry/kernel`**, one package with subpaths `/contract`, `/manifest`, `/testing`, `/host`, `/plugin`.                                                                                   | §8 places it there; the SDK, the test host and the daemon host share the leaf types, and a second package would only add an import edge. |
| D2  | The kernel's own declaration is `@ferretry/kernel/plugin` (`plugin.ts`), not `./manifest`.                                                                                                                                                       | `@ferretry/kernel/manifest` is the SDK every manifest imports (§3.3 example).                                                              |
| D3  | The act-runner types (`Op`, `OP_EFFECTS`, `ResultOf`, `Ack`, `OpaqueId`, `Actor`, `TargetRef`, `closeAck`) live in the **kernel leaf**; Vault's contract re-exports them.                                                                       | `kernel.act` is a kernel port and the kernel imports no core contract; §4.7's "core-vault/contract" placement would invert the graph.      |
| D4  | The kernel-bound port interfaces (`Admission`, `OutputGuard`, `InputHolds`, `Redaction`, `WorkFolders`) and their tokens live in the kernel leaf; each core contract re-exports and provides its own.                                            | Same reason: the kernel calls them.                                                                                                         |
| D5  | `SessionPrincipal` lives in the kernel leaf; Gate re-exports it.                                                                                                                                                                                 | The kernel session layer mints it (§4.13).                                                                                                  |
| D6  | `ApiRequest.loopback` / `privilegedLoopback` / `carrier` are folded into one `arrival: Arrival`; `LocalArrival` carries an unexported brand so only the kernel's listener can build one. `device` / `member` are one kernel-stamped `principal`. | §4.8 "a type the carrier cannot build"; there is no device or member bearer (§7.1). `arrivedOnHost` / `arrivedPrivileged` keep today's meaning. |
| D7  | `RouteContext` is `CallContext<CallStanding>`; `CallStanding` (and `MemberStanding`) are **empty interfaces Gate fills by declaration merging** with today's `RouteContext` fields.                                                              | The kernel carries the standing without knowing Gate; handlers keep `call.actor`, `call.governance`, … exactly as today.                  |
| D8  | `needs`, `uses`, `provides` take **port tokens**, not `'core:asks'` strings; `publishes` / `subscribes` take **`EventDef`s**, not names.                                                                                                        | `build(ctx)` is typed from the tokens; strings would lose the types (§3.3's example is illustrative).                                      |
| D9  | A provide hook whose value is an interface uses `value: z.custom<T>()`.                                                                                                                                                                          | One `defineHook` signature with full inference; no explicit generics.                                                                      |
| D10 | Skeleton answer: **`503 plugin_unavailable`**, body `{ error: "<Title> is not built yet in this version of Ferretry.", code }`. `plugin_failed` (503) and `store_damaged` (503) as §3.4/§9.3. `plugin_paused` is client-side only.              | One code a port's removal makes disappear; distinct from a build failure.                                                                   |
| D11 | Every one of the 31 subsystem packages ships **skeleton daemon, app and CLI halves** now (`export default skeletonDaemon(manifest)` etc.).                                                                                                       | The global build compiles from day 1 and every export path exists; ports replace the file.                                                 |
| D12 | `ports-pending.json` and `release.json` live at the **repo root**.                                                                                                                                                                               | Read by the generator and CI; neither belongs to a package.                                                                                 |
| D13 | The `fy` package keeps npm name **`fy`** (two-name model: the binary is its `bin` key); the app package is **`@ferretry/app`**.                                                                                                                  | `scripts/local/rename.sh` and the release scripts derive names from these.                                                                 |
| D14 | A half that implements an **undeclared** route type-checks; `manifest-match` (slice 2) refuses it. A **missing** implementation does not compile.                                                                                               | TypeScript does not check excess keys in a returned object.                                                                               |
| D15 | **Owner addition (2026-11-07): runners ATTACH.** Ferrets' `runners` provide hook value is `Runner { start(spec), stop(handle), resume(spec, harnessConversationId), attach(handle: RunnerHandle): Promise<Result<RunningFerret, AttachRefusal>> }`. `attach` adopts an existing live process or pane by its handle (Terminals: the tmux pane id) **without restarting it**. A one-time v4→v5 converter that lives **outside the product** hands v5 the pane handles of running ferrets; the product has no converter code, only `attach`. | Owner ask via the lead; keeps running ferrets alive across the 5.0 switch without a compatibility path in the product. |
| D16 | **Owner addition (2026-11-07): the Vault's sealed store is byte-compatible.** v5 keeps today's sealing algorithm and `vault.key` format **byte for byte**: the Vault port copies `packages/daemon/src/lib/secrets` vault code as-is (from rebuild-ref). Sealed blobs move byte-for-byte; v5 may wrap them in a `format: 1` envelope but must **never** require decrypt-and-re-encrypt. `defineState({ store: 'secret' })` files declare this. | Owner ask via the lead; a re-seal would put every secret through memory in clear. |
| D17 | **Lead decision (2026-11-07): the identity key keeps today's layout.** `state/kernel/identity.json` is today's `daemon-identity.json` byte for byte as v5 format 1: `{"schemaVersion":1,"privateKeyPem":"<PKCS#8 PEM>"}` and a newline, `0600`; `schemaVersion: 1` is its format field and the reader accepts exactly that. The daemon id stays `fy_daemon_` + base64url SHA-256 of the SPKI. | Same rule as D16: v4 → v5 keeps every paired device without any tool reading the key. |

## 2. Packages

Workspace globs (root `package.json`, read by the generator, §2.1): `packages/*`, `packages/core/*`, `packages/plugins/*`.

| Path                             | npm name                       | Kind   |
| -------------------------------- | ------------------------------ | ------ |
| `packages/std`                   | `@ferretry/std`                | shared |
| `packages/core/kernel`           | `@ferretry/kernel`             | core   |
| `packages/core/gate`             | `@ferretry/core-gate`          | core   |
| `packages/core/vault`            | `@ferretry/core-vault`         | core   |
| `packages/core/ferrets`          | `@ferretry/core-ferrets`       | core   |
| `packages/core/asks`             | `@ferretry/core-asks`          | core   |
| `packages/plugins/<id>` (26)     | `@ferretry/plugin-<id>`        | plugin |
| `packages/cli`                   | `fy` (bin `fy`)                | shell  |
| `packages/app`                   | `@ferretry/app`                | shell  |

The 26 plugin ids: `access`, `connections`, `updates`, `claude-code`, `codex`, `logins`, `runtimes`, `terminals`,
`browsers`, `accounts`, `conversation`, `agenda`, `projects`, `board`, `packs`, `warden`, `usage`, `lessons`, `voice`,
`catalogs`, `mcp`, `skills`, `shells`, `layouts`, `onboarding`, `tidy`.

## 3. Package layout

```text
packages/plugins/<id>/            (core: packages/core/<id>/)
├── package.json      "ferretry": { "id": "<id>", "manifest": "./manifest.ts" }
├── manifest.ts       default export: definePlugin({...}); pure data
├── contract/
│   ├── index.ts      wire schemas (zod, strict), port + token, events, hooks, ids, policy refs
│   └── testing/      index.ts: the contract's fakes + conformance suite
├── daemon/index.ts   default export: implementDaemon(manifest, { build }) — or skeletonDaemon(manifest)
│   ├── lib/          pure
│   └── adapters/     IO, only through kernel ports
├── app/index.ts      default export: implementApp(...)  — or skeletonApp(manifest)
├── cli/index.ts      default export: implementCli(...)  — or skeletonCli(manifest)
├── instructions/     <name>.md for `instructions` entries
└── tests/            unit/ · integration/ · fixtures/
```

`package.json` `exports` (every subsystem package, identical):

```json
{ "./contract": "./contract/index.ts", "./contract/testing": "./contract/testing/index.ts",
  "./manifest": "./manifest.ts", "./daemon": "./daemon/index.ts", "./app": "./app/index.ts", "./cli": "./cli/index.ts" }
```

Dependencies: `@ferretry/kernel`, `@ferretry/std`, `zod` (`4.4.3`), plus `workspace:*` on each contract package it
imports. The kernel exports `./contract`, `./manifest`, `./testing`, `./host`, `./plugin`.

## 4. Import rules (§2.1, §7.9)

1. A package imports another subsystem **only** through `@ferretry/<pkg>/contract` (and `/contract/testing` in tests).
   `./daemon`, `./app`, `./cli`, `./manifest` are imported only by the generated registries (`context-imports`).
2. A `contract/` file imports only `zod`, `@ferretry/std`, `@ferretry/kernel/contract`, and other contracts.
3. A **core** contract imports only `@ferretry/kernel/contract` and other core contracts, never a plugin contract
   (`contract-graph`, `core-closed`). Plugin→plugin contract edges allowed: Usage → Logins (`LoginId`), Packs →
   Runtimes (`RuntimeId`); any other needs the lead.
4. A manifest imports only `@ferretry/kernel/manifest`, `@ferretry/kernel/contract`, and contracts.
5. Halves use the kernel ports for clock, fs, env, network, processes (`banned-globals`: no `Date.now`, `setTimeout`,
   `node:fs`, `homedir`, `process.env`, `process.platform`, `fetch`, `Bun.spawn` outside the kernel's adapters).
6. `@ferretry/std` holds no Ferretry noun.

## 5. The leaf API — `@ferretry/kernel/contract`

Ids and policy (`ids.ts`, `policy.ts`)
- `PluginId`, `PluginIdSchema`, `CORE_IDS`, `CoreId`, `PLUGIN_API = 5`, `FerretId`, `HolderId`, `SessionId`, `CarrierKey` — branded ids.
- `PolicyRef<K extends 'capability'|'remedy'|'audit'|'step-up-act'>` — branded per kind; `policyRef(kind, name)` mints one (contracts only).
- `CapabilityAxis = 'use' | 'configure'`.

Definitions (`define.ts`)
- `definePort<Api>(name): PortToken<Api>`; `defineBoundPort<Api>(name, coreId)`; `ApiOf<Token>`.
- `defineEvent(name, schema): EventDef<Name, Payload>`; `PayloadOf<E>`.
- `defineHook(name, { mode: 'observe', payload? })` · `{ mode: 'decide', input?, timeoutMs? = 200, securityPath? }` · `{ mode: 'transform', value?, timeoutMs? }` · `{ mode: 'provide', key, value?, takers? }` · `{ mode: 'contribute', item? }`.
- `HookDecision`, `ALLOW`, `Contribution<Item> { id, order?, item }`, `HookHandlerOf<H>` (observe: `(p) => void`, decide: `(i) => HookDecision`, transform: `(v) => v`, provide: the value, contribute: `() => Contribution[]`).
- `defineState({ name, path, store, format ≥ 1, schema?, onDamaged? = 'subsystem' | { narrower }, required?, mode? })` — `path` may hold one `*`; `store`: `json|jsonl|sqlite|sqlite-cache|secret|opaque`.
- `defineConfig({ file, schema, axis, loosens, personOnly? })` · `defineConfig({ collection, name: RegExp, schema, axis, loosens, personOnly? })`; `Loosens<S> = (before, after) => readonly string[]`; `neverLoosens`.

HTTP (`http.ts`) — today's primitives
- `ApiRequest { method, path, query, headers, onRoute?, clientAddress?, arrival, principal?, transcriptHash?, signal?, text() }`.
- `ApiResponse { status, headers, body, late?, gzip?, endsSession? }`, `PlainApiResponse`, `PublishedApiResponse` (branded, kernel-made).
- `finalised(response)` — the synchronous final check; `arrivedLocal`, `arrivedOnHost`, `arrivedPrivileged`.
- `ApiError(status, message, code?, issues?, extra?)`; `jsonResponse`, `textResponse`, `errorResponse`; `headersFrom`, `queryFrom`, `headerValue`, `queryValue(s)`, `decodeParameter`.

Routes (`route.ts`, `socket.ts`) — today's descriptor, field for field, plus `audit` and `guard`
- `CredentialMinimum`, `RouteCaller`, `CapabilityDemand { capability, axis, narrowing? }`, `AuditDeclaration`, `GuardDeclaration`.
- `RoutePattern { precedence?, method, path, available? }`; `ScopedRoute { minimum, caller, ferretDoor?, privilegedOnly?, unlockExempt?, capability?, consultsGrants?, wardenRemedy?, audit, guard }`.
- `RouteDescriptor = ScopedRoute + { noStore?, compress? }`; `ApiRoute<S>` adds `handle`.
- `CallStanding` / `MemberStanding` (filled by Gate); `CallContext<S> = { request, params } & S`; `RouteHandler<S>`.
- `MemberRouteDescriptor { member: 'key'|'unlocked', catalog?: 'path', noStore: true, audit, guard }`, `MemberCallContext`, `MemberRouteHandler`, `MemberRoute`.
- `parseRouteKey('GET /v1/x')`.
- Sockets: `SocketFrame`, `SOCKET_MAX_FRAME_BYTES`, `SOCKET_MAX_PENDING_FRAMES`, `SOCKET_CLOSES` (+ `unauthorized` 4401), `SocketDownstream.send(frame, permit?)`, `SocketHandler`, `SocketAttachment`, `SocketAccept<S>`, `SocketDescriptor`, `SocketRoute<S>`, `SocketUpgradeDecision`.

Session layer (`session.ts`)
- `PROTOCOL = 1`; `SessionPrincipal { kind, holder, session, leaseUntil }`; `Arrival = LocalArrival | CarriedArrival`.
- `SealedFrame`, `SealedOutbound.next()` (permit re-asked inside), `CarrierLink`, `SessionLayer.open(carrier)`, `Carrier.start(layer, signal)`, `CarrierStatus`, `ModeProof`, `SessionMode.verify/redeem`.

Act runner (`act.ts`, §4.7)
- `Op` (12), `Effect`, `OP_EFFECTS` (`as const satisfies`), `OPS`, `isOp`, `showsSomething(op)`.
- `Content { kind: 'content', text?, cells?, data? }`, `Picture { kind: 'picture', mime, bytes }`, `CellGrid`.
- `OpaqueId` (kernel-minted), `REFUSAL_CODES`, `RefusalCode`, `REFUSAL_SENTENCES`, `Ack { status, code?, ids? }`, `AckSchema`.
- `ResultMap`, `ResultOf<O>`, `OP_RESULTS_CONSISTENT` (fails to compile on drift).
- `Actor`, `TargetKind`, `TargetRef`, `RevealGrant`, `HoldRefusal`, `HoldDecision`, `ActPermit`.
- `ActRunner = <O>(target, op, fn: (permit) => Promise<ResultOf<O>>) => Promise<Result<ResultOf<O>, HoldRefusal>>`.
- `MintedIds`, `closeAck(raw, minted): Ack` — the runtime first layer, implemented.

Kernel-bound ports (`bound.ts`)
- `Admission<S, M> { admit(input), admitMember(input), readmit(request, descriptor) }`, `AdmissionInput`, `AdmissionDecision` → `AdmissionPort` (gate).
- `OutputGuard { stamp(targets?), stillShowable(stamp) }`, `GuardStamp`, `WITHHELD_SENTENCE` → `OutputGuardPort` (vault).
- `InputHolds { decide(target, op, actor, reveal?) }` → `InputHoldsPort` (vault).
- `Redaction { read(fn) }`, `RedactionScope { text, cells, lines }` → `RedactionPort` (vault).
- `WorkFolders { folderOf(ferret), check(ferret, path) }`, `FencedPath`, `FolderRefusal` → `WorkFoldersPort` (ferrets).
- `KERNEL_BOUND_PORTS`.

Kernel ports (`ports.ts`, §7.4) — `KernelPorts { clock, log, state, config, roots, events, jobs, workers, spawn, fetch, act, redaction, snapshot, lifecycle }`
- `Clock { now, nowMs, after, every, sleep }` · `Log { debug, info, warn, error, child }`.
- `StatePort { read, write, update, append, lines, list, remove, sqlite, damaged }`, `StateRead`, `StateDamage`, `SqliteHandle`.
- `ConfigPort { file, collection, watch }` · `RootsPort.root(name, scope?)`, `RootName`, `RootHandle { resolve, readText, readBytes, writeText, list, stat, remove }`.
- `EventsPort.publish(event, payload)` · `JobsPort { add, kick }`, `JobSpec { id, schedule, after?, lane?, run }`, `JobSchedule`.
- `WorkersPort.start(url)`, `WorkerHandle` · `SpawnPort { run, start }`, `SpawnOptions { cwd?, env?, stdin?, timeout?, signal?, forFerret? }`, `SpawnResult`, `ChildHandle`.
- `FetchPort.request(url, init)` · `SnapshotPort.current()` · `LifecyclePort { onStop, stopping, signal }`.

Snapshot (`snapshot.ts`): `Word`, `InstructionWhen`, `InstructionEntry`, `NavEntry`, `DoctorEntry`, `OnboardingEntry`, `PostBuildSnapshot`.

Home (`home.ts`, §9.3): `HOME_FORMAT = 1`, `HomeJsonSchema`, `HomeProbe`, `HomeDecision`, `decideHome(home, probe)` (implemented, pure), `BEFORE_SUFFIX`, `insideFence(home, path)` (implemented, pure), `beforeFolderName(id, at)`.

Kernel's own surface (`kernel.ts`): hooks `Carriers` (provide, takers `connections`), `SessionModes` (provide, takers `access`, `catalogs`), `DoctorChecks` (contribute, `DoctorCheck`, `DoctorFinding`); event `PluginsChanged`; `HealthSchema`, `PluginInventorySchema`.

Refusals (`refusals.ts`): `KERNEL_REFUSALS` (`plugin_unavailable`, `plugin_failed`, `store_damaged`, `plugin_paused`), `skeletonSentence(title)`.

## 6. The manifest SDK — `@ferretry/kernel/manifest`

- `definePlugin<const M extends Manifest>(m): M` — keeps literals; checks id, semver, `api === 5`, duplicate route keys.
- Builders: `route(key, descriptor)`, `socket(key, d)`, `memberRoute(key, d)`, `verb(line, { summary?, alias? })`, `tool(name, { …ScopedRoute minus pattern, op?, summary?, input? })`, `screen(id, { path, nav? })`, `panel(slot, { id, order })`, `settingsTab(id, { label, order })`, `renderer('ask', { source })` → key `ask:<source>` / `renderer('reference', { prefix })` → `reference:<prefix>`, `appAction(id, { on, label, calls })`.
- `Manifest` — every field of §3.3: identity (`id, title, version, api, core, kinds, words`), `needs/uses/provides` (tokens), `actions { routes, sockets, memberRoutes, cli, agentTools, app }`, `ui { screens, panels, settings, renderers, layouts, themes }`, `data { state, config, readModels, publishes, subscribes, items }`, `hooks { takes: HookTake[], offers: HookOffer[] }`, `order { after, before }`, `priority`, `instructions`, `onboarding`, `doctor`, `permissions { roots, network, spawn, secrets }`. `PluginKind`, `DATA_KINDS`, `FrameSlot`, `SlotName`.
- `implementDaemon(manifest, { build(ctx: DaemonContext<M>): DaemonHalf<M> })` — `build` is synchronous; `ctx = { manifest, needs (typed APIs), uses (UsesHandle: `current()` throws in build, then API | undefined), kernel: KernelPorts, hooks: HookInvoker }`. `DaemonHalf<M>` = `routes` per route key, `sockets`, `memberRoutes`, `tools` per tool name (`ToolHandler(call, input) => ToolResult`), `provides` per token, `hooks` keyed `name` or `name:key`, `subscribers` per event name. A section is required exactly when the manifest declares something in it.
- `HookInvoker { observe, decide, transform, provider, providers, contributions }` — for hooks this plugin offers.
- `implementApp(manifest, { build(ctx: { manifest, client: PluginClient }): AppHalf<M> })` — `screens`, `panels`, `settings`, `renderers` as `AppComponent<Props>` (framework-neutral; the app shell narrows it).
- `implementCli(manifest, { build(ctx: { manifest, client, io: TerminalIo }): { verbs } })` — `VerbHandler(invocation) => Promise<exitCode>`.
- `skeletonDaemon(m)`, `skeletonApp(m)`, `skeletonCli(m)`.

## 7. Skeletons, `ports-pending.json`, `release.json`

- A skeleton half is `export default skeletonDaemon(manifest)` (app/cli alike). The kernel answers every declared
  route, socket and tool of a skeleton with `503 plugin_unavailable` (D10); each provide key it takes is
  `unavailable`; each decide/transform/observe/contribute take is a no-op the conformance suite marks `skeleton`. The
  app shell shows the skeleton sentence on its screens; `fy` prints it and exits `69`.
- `ports-pending.json` (root): `{ "format": 1, "pending": ["gate", …] }` — the 30 subsystems still skeleton. It may
  only shrink; a port removes its own line in the same branch (`ports-pending` check).
- `release.json` (root): `{ "format": 1, "version": "5.0.0", "scope": ["kernel", …] }` — the release scope (§10.6). A
  cut removes the id here and moves its pending line to `deferred.json` (`{ "format": 1, "deferred": [] }`, created by
  the first cut).

## 8. Tests

- Tiers stay the doctrine's: `tests/unit` (lib, pure), `tests/integration` (adapters and the test host), SIT (built
  `fy` + `fyd`, slice 7). Only the files you changed run locally (TEAM-RULES); CI runs the rest.
- **Appendix D rows**: the test name starts with the row id, then words: `test('I103 wait predicate sees masked text', …)`.
  One row, at least one test, in the owner package's suite (`guarantees`, `guarantee-owner`).
- Fakes and conformance suites live in `contract/testing/` of the owning package and are imported as
  `@ferretry/<pkg>/contract/testing`; the real implementation and every fake pass the same suite.
- Kernel suites (carrier, tool/act-runner, descriptor parity) live in `@ferretry/kernel/testing` (slice 2).
- **Type-level tests** are `tests/types/*.types.ts`, compiled by `tsc --noEmit`, never run; each negative case is an
  `@ts-expect-error`. Present: `packages/core/kernel/tests/types/act.types.ts` (write-only Op, Ack, OpaqueId,
  OP_EFFECTS, PolicyRef kinds), `manifest.types.ts` (typed halves, missing handler).
- Typecheck: `./node_modules/.bin/tsc --noEmit -p .` (root, all but the app) and `-p packages/app` (DOM).

## 9. Spine slices and file ownership (day 1)

No two slices edit the same file. Each may assume the leaf (§5–§6) is as written; a needed leaf change goes to the
lead. "Owns" = the only slice that edits those paths on day 1.

| # | Slice | Owns | Delivers | Assumes |
| - | ----- | ---- | -------- | ------- |
| 1 | **Kernel host** | `packages/core/kernel/host/**`, `packages/core/kernel/tests/{unit,integration}/host*/**`, `packages/core/kernel/plugin.ts` (routes `GET /v1/health`, `GET /v1/plugins`) | boot (§7.6), data/code plugin loader, hooks engine (five modes, takers, timeouts), store with formats and damaged, config, jobs, roots + fence, `decideHome` adapter, identity key, local listener, session layer + `carriers`/`session.modes`, dispatcher calling `Admission` + `late`, act runner with `closeAck`, post-build snapshot, skeleton answers (§7) | leaf; generated registry shape from slice 2 (`kernel/src/generated/plugins.ts` exporting `DaemonImplementation[]`) |
| 2 | **SDK + generator + checks** | `packages/core/kernel/manifest/**` (runtime bodies only; types frozen), `packages/core/kernel/testing/**`, `scripts/gen/**`, the new §7.9 checks under `scripts/validate/` (new files only), `generated/` | generator (global and `--package`), `manifest-match` + `ports-pending`, `context-imports`, `contract-graph`, `plugin-graph`, `core-closed`, `banned-globals`, `host-files`, `registries-fresh`, `guarantees`, `guarantee-owner`, `one-format`, `no-compat`, `words`, `glossary`, `pins`, `contract-consumes`, `act-runner`, `read-scoped`, `descriptor-parity` harness; test host (§7.8); carrier and tool conformance suites; contract hashes + release hash compare | leaf; manifests as in §3 here |
| 3 | **Core contracts** | `packages/core/{gate,vault,ferrets,asks}/**` (contract, contract/testing, manifest) | Gate: `CallStanding`/`MemberStanding` merge with today's `RouteContext` fields, `PolicyRef` vocabulary, step-up act lists, `gate.yaml` schema, `credentials` + `step-up` hooks, inventory projection, re-export `SessionPrincipal`; Vault: re-export act types and bound ports, the byte-compatible sealed store (D16), `input.targets`, `run`/`authorizeFetch` port; Ferrets: `FerretId` re-export, `harnesses`, `runners` (with `attach`, D15), `logins`, `launch.parts`, `start.decide`, `sitrep.lines`, `ferret.changed`, `WorkFolders`; Asks: source envelope, `ask.sources`, `AskAnswered`; each with fakes | leaf |
| 4 | **Plugin contracts + skeletons** | `packages/plugins/*/**` (contract, contract/testing, manifest; halves stay skeleton) | all 26 contracts and full manifests (routes, tools, verbs, screens, hooks, state, config, permissions from §2.3/§9.2 and today's tables) | leaf; core contracts from slice 3 (import by token name; stub locally until slice 3 lands, then rebase) |
| 5 | **App shell** | `packages/app/**` | router, layout engine, slots, theme tokens, sealed session client, daemon list, reference grammar, the generated per-daemon client with the hash guard and bootstrap read (§9.6); `app/src/generated/surfaces.ts` consumer | leaf; `AppImplementation` shape |
| 6 | **`fy` shell** | `packages/cli/**` | router, terminal ports, `cli/src/generated/commands.ts` consumer, `fy plugin`, `fy words`, `fy doctor`, `fy ask`; client guard for commands and agent tools | leaf; `CliImplementation` shape |
| 7 | **Build/CI machinery** | root `package.json` scripts/devDeps (not `workspaces`), `Taskfile.yaml`, `tasks/**`, `nix/**`, `flake.nix`, `.github/workflows/**`, `scripts/{ci,release,local,test,host}/**`, existing `scripts/validate/**`, `knip*.json`, `biome.json`, `bunfig*.toml`, `wrangler.jsonc`, `goreleaser.go`, `tests/**` (root e2e) | everything in §10 below green again on the new layout; typecheck covers `packages/app`; compile `fy`/`fyd` from the new hosts | packages per §2 |

The root `package.json` `workspaces`, `tsconfig.json`, `ports-pending.json`, `release.json`, `packages/std/**` and
`packages/core/kernel/contract/**` are this spine base's; after the freeze only the lead edits them.

## 10. What the old machinery references that is now gone (slice 7)

Removed: `packages/{daemon,protocol,fleet,pwa,relay,cli (old)}`. Root `package.json` `overrides` (pointing into
`packages/pwa/vendor/`) were dropped. The root `tsconfig.json` no longer includes `scripts/*`.

Pre-commit hooks failing on this branch (committed with `--no-verify`): `a-cli-contracts` (wants
`packages/cli/bin/program.ts`), `a-closed-set-agreement` (`packages/protocol/src/lib/grants.ts`),
`a-composition-invocation` (`packages/daemon/package.json` bin), `a-composition-reachability` (no
`compositionRoots` in `packages/app`), `a-deadcode`, `a-deadcode-production` (knip configs), `a-e2e-harness-typecheck`
(`scripts/test/*`, `tests/e2e/*`), `a-pwa-relevance` (`packages/pwa/harness`), `a-route-agreement` (`packages/daemon`),
`treefmt`, and `typecheck.sh` (its project list).

Files that name a removed package path or `@ferretry/{protocol,fleet,daemon,relay,pwa}`:
`Taskfile.yaml`; `bunfig.{e2e,int,realworld,sit,unit}.toml`; `knip.json`, `knip.llm.json`, `knip.production.json`,
`knip.production.llm.json`; `wrangler.jsonc`; `nix/env.nix`, `nix/ferretry.nix`, `nix/git-hooks/install.sh`,
`nix/pre-commit.nix`; `.github/workflows/{ci,e2e-slow,harness-contract-latest,link-store-hosted,pwa-pages,realworld,relay-hosted}.yaml`;
`scripts/ci/{build-checks,build-pwa,check-pwa-release,coverage-ledger,darwin-confinement,e2e-relevance,e2e,harness-contract-report,macos-relevance,pwa-relevance,pwa-screenshot-proof,relay-bundle-fingerprint,relay-directory-origin,safari-render-proof,sign-daemon-release,sign-pwa-release,test,verify-pwa-release}.sh`;
`scripts/host/ferretry-loopback-firewall`;
`scripts/local/{bench-daemon-shutdown,bench-idle-daemon,bench-transcript-tails,check-codex-model-catalog,record-conversion-fixtures,refresh-codex-default-instructions,simulate-message-coalescing,soak-composer-landing}.ts`, `scripts/local/daemon-modules-probe/*`, `scripts/local/{gen-pwa-icons,link-store-deploy}.sh`;
`scripts/release/{bump,compile,goreleaser-shim,smoke}.sh`, `scripts/release/compile-executable.ts`;
`scripts/test/{bootstrap-only-fyd,fake-codex-login,rendezvous-process}.ts`, `scripts/test/{run-e2e,swept}.sh`;
`scripts/validate/{cli-contracts,composition-invocation,fetch-binding,macos-relevance,no-fy-render-in-docs,no-pattern-kill,no-sync-io,pages-config,pwa-relevance,relay-config,test-tiers,typecheck}.sh`,
`scripts/validate/{closed-set-agreement,cors-header-agreement,daemon-scope,no-sync-io,route-agreement}.ts` and their
allowlists; `tests/e2e/**`.

## 11. Still open (for the lead)

- `fy` exit code for a skeleton verb: `69` (EX_UNAVAILABLE) proposed.
- Whether the app half's `AppComponent` becomes React-typed in the kernel (adds a React type dep to the leaf) or stays
  framework-neutral with the app shell narrowing it (current choice).
- The carrier / session-mode interfaces (`session.ts`) are the thinnest part of the leaf; slice 1 should confirm them
  against today's relay link before the freeze.
