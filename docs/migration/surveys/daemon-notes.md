# Daemon `src/` survey notes

## 1. Cycles

- `core.ts -> usage.ts -> core.ts` (`usage.ts -> core.ts` is a type-only import).
- `service.ts -> session-manager.ts -> service.ts` (`service.ts -> session-manager.ts` is a type-only import).

These are the only cycles in the 132-file non-test static import/re-export/import-type graph.

## 2. Hubs

In-degree counts use non-test source importers; ties are ordered by file name.

- `types.ts`: 34
- `paths.ts`: 32
- `io.ts`: 25
- `tasks-types.ts`: 14
- `browser-types.ts`: 11
- `attention-types.ts`: 10
- `core.ts`: 10
- `service.ts`: 10
- `pins-store.ts`: 9
- `tasks-store.ts`: 9
- `warden-detect.ts`: 9
- `push-types.ts`: 8
- `session-tasks-store.ts`: 7
- `task-boards-types.ts`: 7
- `daemon-config.ts`: 6

## 3. Leaves

Files with no internal non-test source imports:

- `analytics-types.ts`
- `attention-types.ts`
- `browser-types.ts`
- `daemon-boot.ts`
- `daemon-secrets.ts`
- `daemon-wait.ts`
- `document-extract.ts`
- `fixtures/encrypted-pdf.ts`
- `git.ts`
- `io.ts`
- `learning-extract.ts`
- `learning-types.ts`
- `liveness.ts`
- `memory-locator.ts`
- `model-cost.ts`
- `names-pool.ts`
- `observed-human-input.ts`
- `paths.ts`
- `pdf-decrypt-worker.ts`
- `pins-types.ts`
- `pwa.ts`
- `scratch-gc.ts`
- `skills.ts`
- `start-timeout.ts`
- `storage.ts`
- `stt-enhancement.ts`
- `stt-types.ts`
- `task-title.ts`
- `tasks-types.ts`
- `terminal-types.ts`
- `transcript-search.ts`
- `types.ts`
- `ui.ts`
- `version.ts`
- `warden-concurrency.ts`

## 4. Ambiguous rows

Direct-I/O flags count host primitives and explicitly low-level I/O helpers invoked in the file (for example `atomicJson`, `run`, `runGit`, and socket `send`/`close`). Effects hidden behind domain services are not propagated. PID existence probes using `process.kill(pid, 0)` are not counted as spawning processes.

- `pdf-decrypt-worker.ts`: `io_fs=?` because lines 116-154 call qpdf/Emscripten `FS.writeFile`, `FS.readFile`, and `FS.unlink` on an in-memory virtual filesystem, not the host filesystem.
- `pdf-decrypt.ts`: `io_proc=?` because line 86 creates a Bun `Worker` and line 129 terminates it; the source does not create an OS child or drive tmux.
- `ui.ts`: `io_net=?` because the emitted `CLIENT_SCRIPT` template contains `fetch` and `new WebSocket`, while the TypeScript module itself only constructs the client-code string.

## 5. Test map

Matching tests and their physical line counts:

- `actor-context.ts` -> `actor-context.test.ts`: 100 lines
- `analytics-cli.ts` -> `analytics-cli.test.ts`: 197 lines
- `analytics-index.ts` -> `analytics-index.test.ts`: 1265 lines
- `analytics-query.ts` -> `analytics-query.test.ts`: 91 lines
- `api-client.ts` -> `api-client.test.ts`: 93 lines
- `api-server.ts` -> `api-server.test.ts`: 2752 lines
- `attachments.ts` -> `attachments.test.ts`: 716 lines
- `attention-api.ts` -> `attention-api.test.ts`: 363 lines
- `attention-cli.ts` -> `attention-cli.test.ts`: 292 lines
- `attention-notifier.ts` -> `attention-notifier.test.ts`: 115 lines
- `attention-service.ts` -> `attention-service.test.ts`: 626 lines
- `attention-sources.ts` -> `attention-sources.test.ts`: 937 lines
- `attention-store.ts` -> `attention-store.test.ts`: 350 lines
- `browser-api.ts` -> `browser-api.test.ts`: 436 lines
- `browser-cli.ts` -> `browser-cli.test.ts`: 263 lines
- `browser-display.ts` -> `browser-display.test.ts`: 169 lines
- `browser-login.ts` -> `browser-login.test.ts`: 915 lines
- `browser-playwright-client.ts` -> `browser-playwright-client.test.ts`: 368 lines
- `browser-profile.ts` -> `browser-profile.test.ts`: 173 lines
- `browser-runtime.ts` -> `browser-runtime.test.ts`: 189 lines
- `browser-service.ts` -> `browser-service.test.ts`: 928 lines
- `browser-stream.ts` -> `browser-stream.test.ts`: 467 lines
- `cgroups.ts` -> `cgroups.test.ts`: 202 lines
- `claude-transcript.ts` -> `claude-transcript.test.ts`: 1005 lines
- `codex-runtime.ts` -> `codex-runtime.test.ts`: 361 lines
- `codex-transcript.ts` -> `codex-transcript.test.ts`: 856 lines
- `core.ts` -> `core.test.ts`: 606 lines
- `daemon-boot.ts` -> `daemon-boot.test.ts`: 124 lines
- `daemon-config.ts` -> `daemon-config.test.ts`: 90 lines
- `daemon-secrets.ts` -> `daemon-secrets.test.ts`: 121 lines
- `daemon-service.ts` -> `daemon-service.test.ts`: 243 lines
- `daemon-wait.ts` -> `daemon-wait.test.ts`: 105 lines
- `document-extract.ts` -> `document-extract.test.ts`: 215 lines
- `failover.ts` -> `failover.test.ts`: 150 lines
- `fleet-inventory.ts` -> `fleet-inventory.test.ts`: 100 lines
- `fs.ts` -> `fs.test.ts`: 951 lines
- `git.ts` -> `git.test.ts`: 819 lines
- `harness.ts` -> `harness.test.ts`: 112 lines
- `liveness.ts` -> `liveness.test.ts`: 291 lines
- `memory-locator.ts` -> `memory-locator.test.ts`: 178 lines
- `migrate-graph.ts` -> `migrate-graph.test.ts`: 164 lines
- `migrate-preflight.ts` -> `migrate-preflight.test.ts`: 557 lines
- `model-cost.ts` -> `model-cost.test.ts`: 117 lines
- `names.ts` -> `names.test.ts`: 79 lines
- `notification-policy.ts` -> `notification-policy.test.ts`: 39 lines
- `pdf-decrypt.ts` -> `pdf-decrypt.test.ts`: 119 lines
- `pins-api.ts` -> `pins-api.test.ts`: 170 lines
- `pins-cli.ts` -> `pins-cli.test.ts`: 83 lines
- `pins-service.ts` -> `pins-service.test.ts`: 164 lines
- `pins-store.ts` -> `pins-store.test.ts`: 198 lines
- `provider-outage.ts` -> `provider-outage.test.ts`: 254 lines
- `push-api.ts` -> `push-api.test.ts`: 68 lines
- `push-notifier.ts` -> `push-notifier.test.ts`: 270 lines
- `push-sender.ts` -> `push-sender.test.ts`: 108 lines
- `push-subscriptions.ts` -> `push-subscriptions.test.ts`: 146 lines
- `push-vapid.ts` -> `push-vapid.test.ts`: 53 lines
- `pwa.ts` -> `pwa.test.ts`: 336 lines
- `runtime-models-api.ts` -> `runtime-models-api.test.ts`: 76 lines
- `scratch-gc.ts` -> `scratch-gc.test.ts`: 258 lines
- `send-ledger.ts` -> `send-ledger.test.ts`: 297 lines
- `session-tasks-store.ts` -> `session-tasks-store.test.ts`: 325 lines
- `skills.ts` -> `skills.test.ts`: 175 lines
- `start-timeout.ts` -> `start-timeout.test.ts`: 65 lines
- `stop-cli.ts` -> `stop-cli.test.ts`: 318 lines
- `storage.ts` -> `storage.test.ts`: 541 lines
- `stt-audio.ts` -> `stt-audio.test.ts`: 223 lines
- `stt-enhancement.ts` -> `stt-enhancement.test.ts`: 396 lines
- `stt-model.ts` -> `stt-model.test.ts`: 368 lines
- `stt-paths.ts` -> `stt-paths.test.ts`: 21 lines
- `stt-service.ts` -> `stt-service.test.ts`: 614 lines
- `stt-worker-client.ts` -> `stt-worker-client.test.ts`: 758 lines
- `task-boards-api.ts` -> `task-boards-api.test.ts`: 586 lines
- `task-boards-cli.ts` -> `task-boards-cli.test.ts`: 171 lines
- `task-boards-store.ts` -> `task-boards-store.test.ts`: 216 lines
- `task-boards-types.ts` -> `task-boards-types.test.ts`: 28 lines
- `task-boards.ts` -> `task-boards.test.ts`: 1723 lines
- `task-title.ts` -> `task-title.test.ts`: 21 lines
- `tasks-api.ts` -> `tasks-api.test.ts`: 751 lines
- `tasks-cli.ts` -> `tasks-cli.test.ts`: 768 lines
- `tasks-contract.ts` -> `tasks-contract.test.ts`: 636 lines
- `tasks-live.ts` -> `tasks-live.test.ts`: 275 lines
- `tasks-migration.ts` -> `tasks-migration.test.ts`: 232 lines
- `tasks-store.ts` -> `tasks-store.test.ts`: 650 lines
- `tasks-workflow.ts` -> `tasks-workflow.test.ts`: 460 lines
- `tasks.ts` -> `tasks.test.ts`: 1118 lines
- `terminal-api.ts` -> `terminal-api.test.ts`: 117 lines
- `terminal-runtime.ts` -> `terminal-runtime.test.ts`: 76 lines
- `terminal-service.ts` -> `terminal-service.test.ts`: 352 lines
- `terminal-stream.ts` -> `terminal-stream.test.ts`: 105 lines
- `terminal-types.ts` -> `terminal-types.test.ts`: 33 lines
- `tmux-controller.ts` -> `tmux-controller.test.ts`: 2258 lines
- `transcript-search.ts` -> `transcript-search.test.ts`: 45 lines
- `usage.ts` -> `usage.test.ts`: 375 lines
- `version.ts` -> `version.test.ts`: 66 lines
- `warden-attention.ts` -> `warden-attention.test.ts`: 976 lines
- `warden-bless.ts` -> `warden-bless.test.ts`: 181 lines
- `warden-concurrency.ts` -> `warden-concurrency.test.ts`: 184 lines
- `warden-detect.ts` -> `warden-detect.test.ts`: 458 lines
- `warden-failover.ts` -> `warden-failover.test.ts`: 390 lines
- `warden-provenance.ts` -> `warden-provenance.test.ts`: 122 lines
- `warden-reports.ts` -> `warden-reports.test.ts`: 123 lines
- `warden-verdicts.ts` -> `warden-verdicts.test.ts`: 277 lines
- `worktrees.ts` -> `worktrees.test.ts`: 435 lines

Non-test files with no matching `*.test.ts`:

- `analytics-types.ts`
- `attachment-unlock.ts`
- `attention-types.ts`
- `attention.ts`
- `browser-types.ts`
- `daemon-entry.ts`
- `fixtures/encrypted-pdf.ts`
- `index.ts`
- `io.ts`
- `learning-aggregate.ts`
- `learning-extract.ts`
- `learning-store.ts`
- `learning-types.ts`
- `learning.ts`
- `names-pool.ts`
- `observed-human-input.ts`
- `paths.ts`
- `pdf-decrypt-worker.ts`
- `pins-types.ts`
- `pins.ts`
- `push-service.ts`
- `push-types.ts`
- `service.ts`
- `session-manager.ts`
- `stt-types.ts`
- `stt-worker.ts`
- `tasks-types.ts`
- `types.ts`
- `ui.ts`

## 6. Oddities

### Zero in-degree

- `daemon-entry.ts` and `index.ts` have zero non-test in-degree and are the two `package.json` bin entry points.
- `stt-worker.ts` has zero static non-test in-degree; it is a build entry and `stt-worker-client.ts` resolves and spawns it by filename.
- `fixtures/encrypted-pdf.ts` has zero non-test in-degree and is imported by three test files.
- `worktrees.ts` has zero non-test in-degree; only `worktrees.test.ts` imports it.
- `pins.ts` is a barrel imported by `daemon-entry.ts`; its opening comment also names `index.ts` and `api-server.ts`, but those files currently import the narrower pins modules directly.

### Duplicated logic observed

- Identical positive-integer limit bodies occur in `attachment-unlock.ts` (`positive`), `document-extract.ts` (`positiveLimit`), and `pdf-decrypt.ts` (`positiveLimit`).
- Identical record/string coercion bodies occur across `analytics-index.ts`, `claude-transcript.ts`, `codex-runtime.ts`, and `codex-transcript.ts`.
- Identical object-coercion bodies occur across `attention-sources.ts`, `browser-api.ts`, `browser-stream.ts`, and `terminal-api.ts`.
- `browser-login.ts:285-296` and `browser-runtime.ts:73-84` contain the same `freeLoopbackPort` implementation.
- `browser-playwright-client.ts` and `stt-worker-client.ts` contain the same generic deferred-promise body.
- `claude-transcript.ts` and `codex-transcript.ts` repeat `nearestExistingDirectory`, inode identity helpers, waiter settlement, byte buffering/consumption, and pending-delivery logic in their watcher implementations.
- Surrogate-safe prefix truncation matches in `attachments.ts:1297-1303` and `document-extract.ts:51-57`; one-line notification truncation matches in `attention-notifier.ts` and `push-notifier.ts`.
- Error-to-wire-body functions with `{ error: error.message, code: error.code }` occur in `attention-api.ts`, `pins-api.ts`, `stt-enhancement.ts`, and `tasks-contract.ts`.
- JSON read/write helpers overlap between `io.ts` (`atomicJson`, `readJson`) and `storage.ts` (`writeJsonAtomic`, `readJsonFile`); the storage writer additionally checks serializability, uses exclusive create/fsync, and cleans up.
- `push-subscriptions.ts:98-132` and `push-vapid.ts:64-86` repeat directory permission, read/parse, atomic-write, and chmod persistence sequences.
- The same session-id regular expression appears in `pins-store.ts` and `session-tasks-store.ts`; the same `isBlockKind` predicate appears in `pins-store.ts` and `pins-service.ts`.
- The same `parseMs` body appears in `liveness.ts`, `warden-attention.ts`, `warden-detect.ts`, and `warden-failover.ts`.
- The same `sameActions` body appears in `task-boards-store.ts` and `task-boards.ts`; canonical JSON routines also recur in pins/tasks/task-board code with small differences.
- `learning-store.ts:57` contains two literal NUL bytes inside the observation-hash template literal, causing ordinary `rg` text detection to treat the file as binary.

### Files containing multiple concern groups

- `session-manager.ts` is 9,201 lines with 36 internal dependencies; its class covers launch/tmux, transcripts, sends/questions, filesystem/git views, usage, cgroups/PWA, warden/failover, scratch GC, and attachments.
- `api-server.ts` combines static assets, authentication, HTTP routing for the feature APIs, and three WebSocket surfaces.
- `index.ts` wires daemon, tasks/boards, pins, attention, browser, stop, warden, cgroups, PWA, analytics, and migration CLI commands.
- `analytics-index.ts` combines SQLite schema/migrations, query execution, transcript filesystem scanning/parsing, refresh scheduling, and aggregation.
- `storage.ts` combines JSON/JSONL persistence with SQLite event indexing, rebuilding, archival, fleet records, and chat-pointer logic.
- `tmux-controller.ts:92-1293` contains pane/UI parsing, while `tmux-controller.ts:1345-2370` drives tmux, process inspection/signals, environment forwarding, and buffer files.
- `task-boards-store.ts` combines schema parsing/building with filesystem persistence; `task-boards.ts` combines task-board authorization, mutations, reconciliation, grants, and invitations.
- `migrate-preflight.ts` combines command classification tables, live tmux/process inventory, gate decisions, CLI/report rendering, and migration-outcome rendering.
- `stt-worker-client.ts` combines native-library discovery, bounded log persistence, environment building, child IPC, model warm/load, transcription, and timeout lifecycle.
- `ui.ts` stores inline CSS, browser JavaScript, and HTML in one TypeScript file.
- `names-pool.ts` is 1,023 lines and is almost entirely generated name data.

### Named functions over 300 physical lines

- `analytics-index.ts` — `AnalyticsIndex.createSchema`, lines 381-768 (388 lines).
- `api-server.ts` — `startApiServer`, lines 424-1460 (1,037 lines).
- `api-server.ts` — nested `fetch` method, lines 465-1323 (859 lines).
- `api-server.ts` — nested `dispatch` arrow function, lines 571-1316 (746 lines).
- `session-manager.ts` — `SessionManager.monitorLoop`, lines 5590-6271 (682 lines).
- `task-boards-store.ts` — `parseBoardFile`, lines 204-512 (309 lines).
- `tasks.ts` — `TaskService.sessionTaskAct`, lines 565-892 (328 lines).
