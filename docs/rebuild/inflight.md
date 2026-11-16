# In-flight work: what each port keeps, deletes and builds

Written on day 0 of the 5.0 rebuild. Source of the decisions: `docs/design/redesign.md` §10.7. This file does not
change them; it tells the porting helpers **exactly what is inside each folded item**, so they apply it while
porting instead of rediscovering it.

How to read it:

- **Reference code** is `.worktrees/rebuild-ref` (detached at `bb89d054d`, release 4.291.5). It still holds every
  compatibility file below. A port copies a subsystem from there and **deletes** what this file lists. Nothing here
  asks you to rebase or merge an old PR; those PRs are `CONFLICTING` or stale against the new tree and are not used
  as code.
- **PR / branch contents** are read with `git diff origin/main...origin/<branch>` (PRs) or `git diff
origin/main...<branch>` (local-only branches: `refactor/finish`, `c50/*`, `c52/*`, `fix/c50-resume-jobs`,
  `refactor/c50-module-*`). Never check them out in the primary checkout.
- Package names are the §8 names. "The app" is `packages/app` (today `packages/pwa`).
- Banned words in product identifiers and strings (the `no-compat` check): `legacy`, `deprecated`, `compat`,
  `migrat*`, `retired`. Several files below are named with them; the port renames or deletes them.

## 0. Verdicts at a glance

| Item                                                | State today                                    | 5.0 decision (§10.7)                 | Superseded by the rebuild?                                                 | Lands in (§8)                                     |
| --------------------------------------------------- | ---------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------- |
| #1543 boot one-shots, v1 layouts                    | open, conflicting, +153/−2126                  | fold (delete)                        | **Yes, close after 5.0 lands**                                             | Kernel, Ferrets, Gate/Access, Conversation, Packs |
| #1554 old store readers                             | open, mergeable, red `Realworld Tests` only    | fold (delete)                        | **Yes, close after 5.0 lands**                                             | Accounts, Catalogs, Access, Ferrets, Runtimes     |
| #1556 board import, `legacyRef`                     | open, conflicting, +231/−8082                  | fold (delete)                        | **Yes, close after 5.0 lands**                                             | Board, Projects, Kernel (CLI), Conversation (app) |
| #1558 agenda one-shots                              | open, conflicting, +427/−3205                  | fold (delete)                        | **Yes, close after 5.0 lands**                                             | Asks, Agenda, Board                               |
| #1565 retired `daemon.json` keys                    | open, conflicting, +797/−413                   | fold, **drop the retired-keys list** | **Yes, close after 5.0 lands**                                             | Kernel                                            |
| #1576 app feature gates                             | open, conflicting, +1466/−7524                 | fold and extend (§9.6)               | **Yes, close after 5.0 lands**                                             | the app, Accounts, MCP, Packs, Catalogs           |
| #1578 conversation-import module                    | **merged**                                     | nothing to do                        | n/a (already in the reference code)                                        | Conversation                                      |
| #1552 B165 the agenda asks                          | open, mergeable, red Integration/Compile/SIT   | land day 0, **not landing first**    | **Yes**: its _model_ is rebuilt by Agenda, Asks and Board; close after 5.0 | Asks, Agenda, Board, the app                      |
| #1573 Realworld nightly only                        | open, mergeable, red Integration and Full CI   | land                                 | **No.** It is a workflow edit, independent of the rebuild                  | CI (`.github/workflows/realworld.yaml`)           |
| F640 stack #1425 → #1427 → #1426                    | open, #1425 conflicting, #1426/#1427 mergeable | keep, park, re-cut on 5.0            | **No, not yet.** Superseded only when the Accounts re-cut lands            | Accounts (+ Access step-up, Asks, Agenda)         |
| #1479                                               | open, mergeable                                | **close as a duplicate**             | **Yes, now** (the lead may close it today)                                 | none                                              |
| `refactor/finish` (6 extractions)                   | local branch                                   | fold the six; drop its 3 C52 copies  | **Yes** (the ports absorb the extractions)                                 | Connections, Ferrets, Conversation                |
| `fix/c50-resume-jobs`                               | local branch, 1 fixup                          | fold with `refactor/finish`          | **Yes**                                                                    | Ferrets                                           |
| `refactor/c50-module-board-github`                  | local branch, 1 own commit                     | fold into the Board port             | **Yes**                                                                    | Board                                             |
| `c52/pr-16`, `c52/pr-16c`                           | local branches                                 | fold deletions, drop version floor   | **Yes**                                                                    | the app                                           |
| `c52/pr-18`                                         | local branch                                   | fold                                 | **Yes**                                                                    | Ferrets, Gate, CLI                                |
| `c52/pr-19a`                                        | local branch                                   | **drop**                             | **Yes**                                                                    | none                                              |
| `c52/fold`, `c52/pr-15`, `c52/pr-20a`, `c52/pr-16b` | local branches                                 | drop (duplicate stacks)              | **Yes**                                                                    | none                                              |
| `c50/config-files`, `c50/pack`                      | local branches                                 | drop (no commits of their own)       | **Yes**                                                                    | none                                              |

The PRs the owner held (1543, 1554, 1556, 1558, 1565, 1578, 1552) plus 1576: **all are superseded by
the rebuild.** The lead's list for closing after 5.0: **1543, 1554, 1556, 1558, 1565, 1576, 1552** (1578 is
already merged). Different: **#1573 is not superseded** (land it), **#1425/#1427/#1426 stay open** as the
reference for the Accounts re-cut, and **#1479 closes now** as a duplicate.

## 1. The compatibility deletions (#1543, #1554, #1556, #1558, #1565, #1576)

These are the zero-compat deletions. For each: what the PR removed, which port owns it, and the instruction. Where a
PR's own "Kept" list names compatibility code that survives the PR, §6 collects it: **the 5.0 port deletes that
too.**

### 1.1 #1543 — boot one-shots and v1 layouts (`refactor/c52-daemon-boot-oneshots`)

Changes (59 files, deletes 10 modules):

| Removed                                                                                                                                                                                                                         | Files (reference-code paths)                                                                                                                                                                                                                                        | Port                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Send-ledger re-proof one-shot (`LegacySendReproof`, `FileSendReproofMarker`, boot wiring, the mounts `sendReproof` port)                                                                                                        | `daemon/src/lib/session/send/reproof.ts`, `daemon/src/adapters/session/send/file-send-reproof-marker.ts`, wiring in `bin/fyd.ts`, `runtime/mounts/index.ts`, `session/send/service.ts`                                                                              | Conversation (`sends.jsonl`)         |
| `attention-` → `agenda-` send-id alias (callers compare ids with `===`)                                                                                                                                                         | `daemon/src/lib/session/send/send-id.ts`, `adapters/agenda/send-agenda-delivery.ts`                                                                                                                                                                                 | Conversation, Agenda                 |
| Operator-password file retirement at boot                                                                                                                                                                                       | `daemon/src/lib/grants/retired-password.ts`, `paths.retiredOperatorPassword`, `lib/grants/index.ts`                                                                                                                                                                 | Gate (security settings)             |
| Session directory v1 → v2 upgrade                                                                                                                                                                                               | `daemon/src/lib/layout.ts`, `adapters/storage/session-storage.ts` (−175 lines), `adapters/storage/storage-factory.ts`                                                                                                                                               | Kernel (storage), Ferrets (sessions) |
| Home layout v1 → v2 upgrade arm (`UPGRADABLE_LAYOUT_VERSIONS`, `kind: 'upgrade'`)                                                                                                                                               | `protocol/src/lib/state-home-layout.ts`, `daemon/src/adapters/storage/state-home-layout.ts`, `cli/src/lib/state-home/claim.ts`, `fleet/src/lib/config-files/evaluate.ts`                                                                                            | Kernel                               |
| Pack routing migration (`RoutingMigration`, `legacyPrompt` read fallback, `FileRoutingMigrationBackup`, `PackService.defaultPrompt`, `isLegacyModelsGuide`, deprecated `useCases`/`routing`/`models`/`routingPreferences` keys) | `daemon/src/lib/pack/migrate.ts`, `lib/pack/routing.ts` (−90), `lib/pack/service.ts`, `lib/pack/index.ts`, `adapters/pack/cleanup-runs.ts`, `protocol/src/lib/pack.ts`                                                                                              | Packs                                |
| Tests, fixtures, docs paragraphs                                                                                                                                                                                                | `legacy-send-reproof.test.ts`, `retired-password.test.ts`, `pack/migrate.test.ts`, `reproof.test.ts`, `send-id.test.ts`; boot-trace entries (send-reproof, operator-password, routing-migration steps); `docs/pack-mode.md` § Migration; `docs/message-delivery.md` | each port, with its tests            |

Instruction:

- **Delete** all of the above. **Do not port** `reproof.ts`, `send-id.ts`, `retired-password.ts`, `pack/migrate.ts`
  or any marker file. Compare send ids with `===`; there is one spelling (`agenda-…`, which the Agenda word table
  renames if needed).
- **Do not port** the v1/v2 session-directory or home-layout machinery. Every stored format starts at 1 (§9.1,
  §9.3): a mismatch is the one refusal the Kernel's format reader gives, with no upgrade arm.
- `completeSessionUpgrade` (kept by the PR) is crash recovery for an unmarked half-created session folder. Port the
  **recovery**, rename it (no `upgrade`), and drop every v1 branch of it.
- `boot-trace.expected.ts` loses three steps (send-reproof, operator-password, routing-migration). Port it without
  them.
- Pack's `useCases`/`routing`/`models` keys: strict schemas refuse unknown keys, so there is nothing to port.

### 1.2 #1554 — old store readers (`refactor/c52-daemon-store-readers`)

Changes (72 files, +1169/−4455). Removed:

| Removed                                                                                                                                                                           | Files                                                                                                                                                                                                                       | Port                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Login index v1 → v2 (the `login-entries.v1.json` backup and downgrade, frozen v1 schemas, `migrateLoginIndex`, `accounts-migrated` audit, "saved logins became accounts" notices) | `protocol/src/lib/accounts.ts` (−217), `daemon/src/lib/secrets/accounts.ts` (−220), `lib/secrets/logins.ts`, `adapters/secrets/file-login-index-store.ts`, `bin/fyd.ts` (−109), `protocol/tests/fixtures/login-index-v1.ts` | Accounts              |
| Shared catalogs v1/v2 → v3                                                                                                                                                        | `daemon/src/lib/shared-catalogs/document-v1.ts`, `lib/shared-catalogs/migrate.ts`, `document.ts`, `ports.ts`, `service.ts`, `index.ts`, `adapters/shared-catalogs/file-store.ts`, golden `v1-state.json`                    | Catalogs              |
| Members "names became IDs" upgrade and `members.before-unique-names.json`                                                                                                         | `daemon/src/lib/catalog-members/names.ts` (−47), `document.ts`, `ports.ts`, `service.ts`, `adapters/catalog-members/file-store.ts`                                                                                          | Catalogs              |
| Pre-P7 single `profile` in the fleet import record                                                                                                                                | `fleet/src/lib/account/import.ts`, `daemon/src/lib/fleet/setup-service.ts`                                                                                                                                                  | Runtimes / Onboarding |
| Wrapper-path `agent` arm in runtime-session matching (`command[0]` matching stays)                                                                                                | `daemon/src/lib/fleet/runtime-sessions.ts`                                                                                                                                                                                  | Ferrets               |
| Pairing: the drop path for a pre-device-key `devices.json` (`schemaVersion: 1`), replaced there by a named refusal                                                                | `daemon/src/adapters/pairing/state-pairing-repository.ts`                                                                                                                                                                   | Access                |
| Grants: the one-time "Sharing follows pairing" widening (`sharing-follows-pairing.ts`, `readAll`, boot wiring)                                                                    | `daemon/src/lib/grants/sharing-follows-pairing.ts`, `adapters/grants/runtime-grant-ports.ts`, `lib/paths.ts`, `lib/grants/index.ts`                                                                                         | Access                |

Instruction:

- **Delete** the lot. **Do not port** the replacement refusals either (`store_damaged` naming `login-entries.json`,
  the "write this empty v2 document then `<cli> pair`" remedy): under the clean slate `devices.json`, the login
  index and the catalog document are born at `format: 1` and a different number is the Kernel's one format refusal.
- Accounts: the index is `accounts.json` (format 1) with values sealed in the Vault; no v1 schema, no `migrated`
  schema field, no backup file.
- Catalogs: the document is one schema at `format: 1`; the byte-stability golden (`main-output.json`) is kept but
  reseeded from a v1-format seed written fresh, never converted. Members use IDs from the start (`freeMemberName`
  / `renameNotice` for live joins stay, they are not compat).
- Pairing: the "stale-grants rewrite", `fillMissingCapabilities` and the `LIMITED_DEVICE_GRANTS` default are named
  **kept** by the PR. Check each against Appendix D: a rewrite of an _older shape_ is the removed half of a SPLIT
  row; the _default grant set_ for a new device is real behaviour and stays.
- The red `Realworld Tests` check on this PR is the job #1573 moves to nightly. It is not a code failure.

### 1.3 #1556 — board import and `legacyRef` (`refactor/c52-board-import`)

Changes (106 files, +231/−8082; the biggest deletion). Removed:

| Removed                                                                                                                                                                                                         | Files                                                                                                                                                                                                                                                                                                                                    | Port             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| The one-time import of per-session `tasks.json`, whole modules                                                                                                                                                  | `daemon/src/lib/board-import/**` (importer, lane-for-status, legacy-card/history/lookup/snapshot, agenda-links, block-reason, exact-worker-assignee, lane-set-projects, ports), `daemon/src/adapters/board-import/**` (marker, legacy task source, agenda adapter, sessions), `protocol/src/lib/board-import.ts`, `docs/board-import.md` | Board            |
| `POST /v1/board/import` and `fy board import`                                                                                                                                                                   | `cli/src/adapters/board-import/**`, `cli/src/lib/board-import/**`, `cli/bin/program.ts` (−4)                                                                                                                                                                                                                                             | Board (CLI half) |
| Retired stubs `GET /v1/tasks`, `GET /v1/sessions/:id/tasks`, and the old per-session task model                                                                                                                 | `daemon/src/lib/runtime/mounts/legacy-tasks.ts`, `protocol/src/lib/tasks.ts` (−571; keep only TaskKind/TaskId/TaskTitle/TaskWorkflow/TaskMessage)                                                                                                                                                                                        | Board            |
| `legacyRef`: `GET /v1/board/tasks?legacyRef=`, `taskByLegacyRef`, the card's `legacyRef` field and `LegacyTaskRefSchema`, the app's proof of old `&F12` ids                                                     | `protocol/src/lib/board.ts`, `daemon/src/lib/board/service.ts` (−46), `lib/runtime/mounts/board.ts` (−41), app `lib/session-cards.ts`, `lib/task-reference-context.tsx`, `components/reference-surface.tsx`, `lib/composer-reference-catalogs.ts`, `hooks/use-ferret-cards.ts`                                                           | Board, the app   |
| Boot one-shots: the board-switch one-time pass, lane-set migrations (merge Released+To test, quick gains To test, stage lanes, progress names), `closeStrandedSubCards`, the migration-only relocation `reason` | `daemon/src/lib/board-projects/board-switch.ts` (−99), `lane-set-policy.ts` (−181), `lane-set-service.ts` (−155), `ports.ts`, `daemon/src/lib/board/sub-card-close.ts`, `bin/fyd.ts` (−158)                                                                                                                                              | Projects, Board  |

Instruction:

- **Delete** all of it; **do not port** `board-import/**` in any form, `legacy-tasks.ts`, the `legacyRef` field, its
  query, `LegacyTaskRefSchema`, or the lane-set migration branches. Old `&F12` text is plain text unless a card
  with that id exists (`docs/reference-standard.md` already says so after this PR; port that sentence).
- Cards (`cards/<id>.json`) are strict at `format: 1`; there is no `legacyRef` key to tolerate. A fresh home has
  boards **off**: no `board/switch.json` means off, so the board-switch document is just `{format:1, boards:[…]}`
  without `migratedAt` or `setBy: 'migration'`.
- Lane sets are written with their `stage` from the start; do not port the "lane without a stage reads with one"
  rule (the Board port's `laneStage` always reads a stored stage).
- `fy board import` goes: do **not** register it in the Board CLI half (`docs/relay-protocol` / route lists drop
  `/v1/board/import`, `/v1/tasks`, `/v1/sessions/:id/tasks`; the route-agreement allowlists lose those lines).
- The `board-github` watcher is **not** part of import. Port it (see §3.2).

### 1.4 #1558 — agenda one-shots (`refactor/c52-agenda-migrations`)

Changes (53 files, +427/−3205). Removed:

| Removed                                                                                                                                                                                         | Files                                                                                                                                                                           | Port                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `attention.json` → `agenda.json` rename (`migrateAgendaFiles`, the `readAgendaFile` legacy fallback, `MIGRATED_SUFFIX`, marker, the `ready` ctor arg of the ledger/outbox repositories)         | `daemon/src/lib/agenda/agenda-files.ts` (−224), `adapters/agenda/file-agenda-files-migration-marker.ts`, `file-agenda-ledger-repository.ts`, `file-agenda-outbox-repository.ts` | Asks                           |
| Agenda-mode migration (`migrateToAgendaMode`) + marker                                                                                                                                          | `daemon/src/lib/agenda/agenda-migration.ts`, `adapters/agenda/file-agenda-migration-marker.ts`                                                                                  | Asks                           |
| Agenda homes migration (`migrateToAgendaHomes`), the `agendaHomesMigrated` gate and the wait on it before the warden arms                                                                       | `daemon/src/lib/agenda/home-migration.ts`, `lib/agenda/state-machine.ts` (−63)                                                                                                  | Asks, Warden                   |
| Machine-agenda notices fold (`foldNoticesIntoMachineAgenda`, `homesGate`/`machineFolded`, warden `machine.folded`; autoMove 60 s interval starts at once)                                       | `daemon/src/lib/agenda/machine-migration.ts`, `adapters/agenda/file-machine-migration-marker.ts`                                                                                | Agenda, Warden                 |
| Gate-items duplicates sweep (B138) + `GateItemsMigrationMarker` (the live `DuplicateSweep` and `gateItems.backfill()` stay)                                                                     | `daemon/src/adapters/board/file-gate-items-migration-marker.ts`, `lib/board/gate-items.ts` (−50)                                                                                | Board                          |
| SQLite agenda versions: `user_version` 1 → 2 upgrade and the `.jsonl` import                                                                                                                    | `daemon/src/adapters/agenda/sqlite-agenda-versions.ts` (−92), `agenda-versions-program.ts`                                                                                      | Asks (`versions/<ask>.sqlite`) |
| Untagged pushes in `notifications/clear.ts`, `legacyStop`/`codeCardTags` in `policy.ts`; `hasOpenAgenda` no longer reads `state.attention`; `legacyAttentionBatchMessage` → `batchReplyMessage` | `daemon/src/lib/notifications/clear.ts` (−67), `policy.ts` (−37), `lib/agenda/harness-prompt.ts`, `lib/agenda/reply-batch.ts`, `bin/fyd.ts` (−152)                              | Agenda (notifications)         |

Instruction:

- **Delete** all of it. **Do not port** the **new** file this PR adds, `adapters/agenda/pre-rename-agenda-listing.ts`:
  it is a refuse-to-start check for homes that still hold `attention.json`; under the clean slate such a home cannot
  exist (a home is born at 5.0 or not at all).
- The SQLite versions file keeps one rule from this PR that is **not** compat: setup in an `IMMEDIATE` transaction,
  and a non-empty archive with an unexpected `user_version` is refused by name. Port that, with the single number
  1.
- Every current agenda push carries a tag: notification clearing has no "untagged" branch.
- Wait gates on migrations before the warden arms go away entirely: the Warden plugin arms when its dependencies
  report ready, not behind a migration gate (boot-trace expectations drop these steps).
- Read the §6 table for what #1558 deliberately left (ledger v1/unversioned chain, the notification-ledger old
  spelling, `resting.migrated`): the 5.0 port deletes those as well.

### 1.5 #1565 — retired `daemon.json` keys (`refactor/c52-retired-config-keys`)

Changes (31 files, +797/−413). Removed from the document: `attention` (renamed `agenda`), `accountModel`, `fleet`
(`prepareDefaults`), `sessionWorkers.enabled`; the two-spellings `agenda` merge and the boot notices for them.
Added (**do not port**): `fleet/src/lib/config-files/retired-daemon-keys.ts` (`RETIRED_DAEMON_KEYS`,
`DAEMON_DOCUMENT_FILE`, one remedy sentence per key), its readers in `cli/src/adapters/config/files.ts`,
`cli/src/lib/config/controller.ts` + `ports.ts` (`fy config check` reads `daemon.json`), and
`daemon/src/adapters/runtime/daemon-config.ts` / `explicit-config.ts`.

Other files: `daemon/src/lib/runtime/config.ts` (−183), `lib/runtime/provenance.ts`, `bin/fyd.ts`,
`lib/agenda/resurfacer.ts`, `lib/notifications/buzz.ts`, `protocol/src/lib/performance*.ts`.

Port: **Kernel** (`config-files`).

Instruction:

- **Delete** the four keys and their handling. **Do not port the retired-keys list**, the shared reader, or the
  remedy sentences (§10.7: a list of retired names is itself compatibility code).
- `daemon.json` does not exist in 5.0. Config is YAML under `config/`, one schema per file, generated to
  `.schema/<file>.json`, and the schemas are **strict**, so an unknown key is refused by name by the same path as
  any other config error (the Kernel's `ConfigIssue`). The behaviour worth keeping is only: _a refused document is
  left byte-identical (no backup, no journal entry) and the message never prints a value._
- `machine.yaml` `attentionNudge` (kept by the PR) is renamed by the Agenda word table (attention → agenda), not
  carried under the old name.
- The host/port → `carriers` conversion at boot (kept by the PR) is a converter: delete it; `carriers` is the only
  spelling.

### 1.6 #1576 — app feature gates and the saved-logins surface (`refactor/c52-pwa-feature-gates`)

Changes (162 files, +1466/−7524). Removed:

| Removed                                                                                                                                                                                                                                                                                                                                                                                           | Files                                                                                                                                                                                                                                                                                                                                                                                    | Port                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| App gates for features every daemon reports: work search, Pack idea 4000-char limit, clear agents, send-back/gate attachments, History tail walk, login budgets, Accounts + sign-ins, 2FA keys, sign-in rules, task plans, paste-rule passkey staging, catalogs (items, quick-add, versions), shared-draft uploading + slots, phone approval, push clear, Settings "needs a newer Ferretry" notes | ~70 app files (`features/catalogs/*`, `features/input-request/input-card-host.tsx`, `phone-approval-host.tsx`, `features/secure-copy/*`, `features/settings/daemon-settings-frame.tsx` (−87), `features/fleet/credentials/budget-editor.tsx`, `features/pack/*`, `lib/agenda-clear-agents.ts`, `lib/item-conversation.ts`, `lib/login-form.ts` (−165), `lib/machine-update-words.ts`, …) | the app (each plugin's app half) |
| The legacy saved-logins surface                                                                                                                                                                                                                                                                                                                                                                   | `pwa/src/features/secrets/logins-surface.tsx`, `logins-card.tsx` (805 lines), `logins-api.ts`, `login-recipe.tsx` + tests                                                                                                                                                                                                                                                                | Accounts (app half)              |
| The six `/v1/secrets/logins*` routes, their audit rules, route-contract and allowlist lines                                                                                                                                                                                                                                                                                                       | `daemon/src/lib/runtime/mounts/secrets.ts` (−204), `lib/audit/routes.ts` (−29), `scripts/validate/route-agreement-allowlist.txt`                                                                                                                                                                                                                                                         | Accounts                         |
| `LoginDirectory.list/put/rename/remove/decide`, `savedLoginOf` (`LoginDirectory` stays with `.accounts`, `saveFields`, `sweepUnreferenced`)                                                                                                                                                                                                                                                       | `daemon/src/lib/secrets/logins.ts` (−250), `lib/secrets/accounts.ts`, `lib/secrets/login-recipes.ts`, `lib/secrets/proposal-target.ts` (−72)                                                                                                                                                                                                                                             | Accounts                         |
| The `{ login }` recipe target, `account.propose { login }`, the `login.hint`/`login.propose` aliases (`signIn` becomes required), the `secure.preapprove` tool and `taskPlanCallOf`                                                                                                                                                                                                               | `daemon/src/lib/agent-tools/service.ts` (−48), `types.ts`, `protocol/src/lib/agent-tools.ts` (−68), `protocol/src/lib/login-entries.ts` (−237), `login-recipes.ts`, `task-plan.ts`, `daemon/src/lib/task-plans/service.ts`, `lib/sign-in-rules/suggestions.ts`                                                                                                                           | Accounts, MCP                    |

Instruction:

- **Delete** all gates; in every place the "offered" branch becomes the only code. Also delete what #1576 **kept**
  and §10.7 says to finish: `DAEMON_FEATURES`, `hasFeature`, `machineOffers`/`machineLacks`,
  `LEGACY_MAX_IDEA_CHARS`, the "machine is older" panes, `useMachineUpdates`' feature half and
  `UPDATE_MACHINE_WHERE` as a skew explainer (§9.6; the handshake is `PROTOCOL` plus the per-plugin contract hash).
  Keep: `useDaemonHealth` and the disk-pressure code, `outdatedRefusal` as the one full-screen sentence of §9.6.
- **Do not port** the saved-logins surface, `/v1/secrets/logins*`, the `{ login }` target or aliases, `secure.preapprove`.
- Appendix D rows that say "only on a machine reporting `sign-in-rules.1`" or "when the daemon lists
  `session.credential.1`" name a feature test (P125, S53): check each row in Appendix D; the feature test goes, the behaviour stays unconditional.
- `CopyPlanHost` and the paste-plan helpers stay (they are live code, kept by the PR).
- Cuts a round trip: each removed gate also drops a `/v1/health` read. The app port must not add one back for a
  version probe.

## 2. The agenda / board model of #1552 (build this in Asks, Agenda and Board)

**PR:** `fix(agenda): the agenda asks, the card shows (B165)` (`fix/b165-v3-agenda-owns-the-ask`), +8419/−1089, 10
review rounds, red on Integration/SIT. It **does not land first**, so the ports build the model from the branch
(`git diff origin/main...origin/fix/b165-v3-agenda-owns-the-ask`, and `docs/agenda.md` § "One model" on that branch).
The rule it states, in the owner's words (2026-11-02 → 2026-11-06): _"TASK no longer have user interactivity
anymore! agenda tracks all those"_.

### 2.1 The model (as rules)

1. **The agenda item is the only place the owner acts.** One "What I need from you", **one answer row** (buttons) or
   words typed below, never both said twice. In 5.0 words: an **ask** (Asks) shown by the Agenda plugin.
2. **A card is read-only status** (Board). It never asks, has no answer buttons, is never headed "Card &F12" or "your
   answer for the card", and is named at most once, as a plain reference line ("For &F12 Badge colour").
3. **Answering an item may move its linked cards.** That is bookkeeping the owner never sees: the item's _Done_ moves
   a tried card to Closed; its _Not good_ sends it back with the owner's words. The card moves **first**, through the
   Board service as the owner (so authority, history and the done/reopen ladders are the Board's), then the ask is
   marked answered.
4. **The daemon asks only when there is something to ask**, and only on the topic's existing item, never a new item
   per stage.

The §1 words map: _agenda item_ → **ask** (Asks) shown in the **Agenda**; _card_ → **card** (Board); _card ask_,
_gate_, _lane_ are internal words that **never reach an owner-facing string**.

### 2.2 What the branch builds

| Piece                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Where it is                                                                                                                                                                                                           | Port                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Shared rule, decided in one place, read by daemon and app**: `itemAsksOwnQuestion`, `isGeneratedCardAgendaAsk` (with a durable daemon-written `generatedSubject`), `askLineRepeatsCardAsk`, `ownAskDigest`, `repliedToOwnAsk`, `awaitsOwnAnswer`, `ownCardAsk`, `askedCardAsks`                                                                                                                                                                               | `protocol/src/lib/agenda-card-asks.ts`                                                                                                                                                                                | Asks contract                                                                 |
| Order the asks are asked in (a _Not yet_ ask waits behind the others) and "an owner's plain reply records `ownAskRepliedTo`, so an answered question does not come back"                                                                                                                                                                                                                                                                                        | same file; `daemon/src/lib/agenda/card-asks.ts` (`cardAskWaits`, `asksOnlyCardAsks`, `replyKeepsCardAskOpen`), `state-machine.ts`                                                                                     | Asks                                                                          |
| Try-it/approval wording, one source: `gateStyle`, `GATE_GOOD_LABEL` ("Good"), `gateButtonLabel`, `gateTapOptions`, `gateTypedLabel/Lead/Placeholder`, `gateAskLine`, `tryItText`, `previewUrlOf`                                                                                                                                                                                                                                                                | new `protocol/src/lib/agenda-gate-wording.ts`                                                                                                                                                                         | Asks contract / Agenda                                                        |
| **`tryItVerdict`** (pure): _wait_ (card blocked, or an umbrella card with a sub-card still being built) / _nothing to try_ (private, a `chore`, no How to test, a closed no-testing grammar `saysNothingToTry`, or every merged PR docs/tests-only) / _ask_                                                                                                                                                                                                     | `daemon/src/lib/board/gate-policy.ts`, `gate-items.ts` (`GateItems`, `sweep`, `backfill`), `board-gate-cards.ts`, `graph.ts`                                                                                          | Board                                                                         |
| "Nothing to try" **closes the card with one line, no button**: reason `Nothing to try: <why>`; leaves an `updated` activity `&F12: Nothing to try: <why>` on a carrying item (`nothingToTryLine`), raises no item. Re-judged inside the card's own write. **The one narrow daemon exception to "only the owner passes a gate"** (daemon only, only out of a try-it stage, only into Closed, only while the card sits at that stage by that entry)               | `gate-policy.ts`, `board/service.ts`, `card-actions.ts`                                                                                                                                                               | Board (with an Asks hook)                                                     |
| What a PR changed: `PrLink.changes` (`docs-tests` \| `code`, absent = unread = code), judged from the files in the GitHub watcher's one GraphQL query, at most `PR_FILES_READ = 100` files                                                                                                                                                                                                                                                                      | new `daemon/src/lib/board/pr-changes.ts`, `board-github/query.ts`, `board/pr-cache.ts`, `protocol/src/lib/board.ts`                                                                                                   | Board (watcher)                                                               |
| **One agenda box on every path (app)**: `itemAskPlan` draws the first card ask still waiting as the item's own ask ("Try it" / "Approve", the card named once "For &F12 Title"), holds the item's own buttons behind it, names the others "Next"; `itemSwipeTargets` drives every swipe and key surface; the Warden "cards with no ferret" notice is **one form** (a pick per card — Start a ferret / Close it / Leave it — and one Send)                       | `pwa/src/features/agenda/*` (incl. new `agenda-card-ask-answer.tsx`), `lib/agenda-inbox*.ts`, `lib/agenda-item-sections.ts`, `lib/agenda-gate-send.ts`, `lib/gate-items.ts`, `agenda-history.ts`, `agenda-replied.ts` | the app (Agenda half)                                                         |
| Notifications/buzz and daemon agenda mount follow the same facts                                                                                                                                                                                                                                                                                                                                                                                                | `notifications/buzz.ts`, `service.ts`, `runtime/mounts/agenda.ts`                                                                                                                                                     | Agenda                                                                        |
| **Enforcement**: `scripts/validate/owner-surface-words.{sh,ts}` (pre-commit gate over app, daemon agenda/board/mounts and protocol strings; fails on "card ask", "your answer for the card", a "Card &F12:" heading, the card narrated as the actor — "the card goes back/stays" — gate/lane jargon, "it is asked here") and the test `agenda-one-answer-row.test.tsx` (draws every kind with 1 and 2 card asks on every surface and counts **one** answer row) | `scripts/validate/`, `nix/pre-commit.nix`, `docs/standards/{contracts,linting}`                                                                                                                                       | Agenda + repo checks (the §7.9 `glossary` check should carry the same shapes) |

### 2.3 Carried vs deleted when the ports rebuild it

**Carry** (it is the product model): everything in the table above; the `docs/agenda.md` section "One model: the
agenda asks, the card shows" and `docs/board.md` § "Cards show progress; their asks ride the agenda" as the Agenda
and Board docs; the **attaching rules** (a card the owner asked for, sitting in a gate lane, has its ask on exactly one
open agenda, found in this order: an agenda that already carries the card → one that carries its parent card → the
card's topic item → a new agenda named after the card; the ask is named `gate:<card>:<lane>:<entry>` and restated in
place, never asked twice; a new ask wakes the agenda out of a snooze; the owner's answer is authorised as the
admin token or a paired device whose `fleet` grant may use the board). In 5.0 the ask source is `ask.sources: card`
(Board), raised through Asks.

**Delete** (the clean-slate halves §10.7 names — "the `gateAttached` mirror, synthesized rows"):

- the **`gateAttached` mirror** of the first open ask's gate on every write "for an app that predates card asks"
  (`daemon/src/lib/agenda/card-asks.ts`, `state-machine.ts` — 10 references —, `protocol/src/lib/agenda.ts`, app
  `lib/agenda-item-sections.ts`, `lib/agenda-merge.ts`, `lib/agenda-answers.ts`, `features/agenda/agenda-inbox-page.tsx`,
  `daemon-features/agenda.ts`), and its `gateAttachedChangedAt` stamp;
- the **synthesized to-test rows** (the app's own "old-daemon Inbox to-test rows") and the `board.gate-items.1`
  feature probe that chooses between them (`pwa/src/lib/gate-items.ts`, `features/agenda/to-test-rows.tsx`,
  `to-test-step.tsx`);
- the **conservative reading of old card agendas** ("from before `generatedSubject`"): in 5.0 every card ask is
  born with `generatedSubject`;
- the **boot effect** ("cards already at Released with nothing to try are closed on the first sweep"): there are no
  old cards, so there is no boot sweep for it (the periodic sweep and the write-time re-judgement stay).
- #1552's `Heads-up` about #1494's exception is moot: the branch already drops it.

Do not forget: the branch edits `packages/fleet/src/lib/account/fixed-layer.ts` (the agenda/board instruction text).
Under the plugin spec that text becomes each subsystem's `instructions` (Asks, Agenda, Board): write the "agenda
asks, card shows" wording there, once.

## 3. The `refactor/finish` family and the board-github module

### 3.1 `refactor/finish` — six extractions (keep) and three copies (drop)

The branch is `8a5aebe05` (validate fix) + six extractions + three C52 copies on top of `64fd8cbcc`. Its six
commits move code out of `packages/daemon/bin/fyd.ts` into `bin/modules/*.ts`, and mounts into
`src/lib/runtime/mounts/*.ts`. In 5.0 the `bin/modules/` shape is replaced by each package's `daemon/` half, but the
**bodies** (the factories, services, jobs, route handlers) are what `fyd.ts` made hardest to move, and they are done.

| Commit      | Module (file)                                                          | Serves                                                                                                                                                                                     | Port (body of …)                                                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `113c323d7` | `bin/modules/reach.ts` (613 lines) + `mounts/reach.ts`                 | `GET /v1/carriers`, `GET`/`PUT /v1/tunnel`, `POST /v1/webrtc/offer`; relay carriers, WebRTC carrier, hosted tunnel; two jobs `startRelays`, `startTunnel`; **not pairing** (never relayed) | **Connections** (carriers)                                                                                                                                                                      |
| `b8e9ce850` | `bin/modules/session-fork.ts` (294) + `mounts/session-fork.ts`         | `POST /v1/sessions/:sessionId/fork`; preparer, target resolver/binder, durable receipt store, service                                                                                      | **Ferrets** (`forks/`) with the harness `fork?` hook in Claude Code / Codex                                                                                                                     |
| `3ce2db548` | `bin/modules/session-handover.ts` (356) + `mounts/session-handover.ts` | `POST`/`GET /v1/sessions/:sessionId/handover`, `POST …/handover/cancel`; receipt store, state machine, reconcile loop (`appendOnce` journal write) — one job armed at boot                 | **Ferrets** (`moves/`; cross-harness)                                                                                                                                                           |
| `b2d512188` | `bin/modules/session-migrate.ts` (1137) + `mounts/session-migrate.ts`  | `POST …/migrate`, `POST …/conversion-preview`, `GET …/relaunch-settings`, `POST …/migrate/ask-to-stop-jobs`; the safety gate, the report store, the conversion checks                      | **Ferrets** (`moves/`; account move). **Rename `migrate` → `move`** everywhere (route, `lib/migrate/**`, `fy migrate`, `migrate-sheet.tsx`, `warden/auto-migrate*`) because `migrat*` is banned |
| `d90bce4b9` | `bin/modules/session-reads.ts` (558) + `mounts/session-reads.ts`       | `GET …/events`, `…/snapshot`, `…/logs`, `…/log-page`, `…/log-search`, `…/messages`, `…/transcript-images/:handle`, the compact-at and hypermedia settings, the declared-wait monitor       | **Ferrets** (events, snapshot, the declared-wait monitor) and **Conversation** (messages, transcript reads, images)                                                                             |
| `fc67dd7e1` | `bin/modules/session-resume.ts` (557) + `mounts/session-resume.ts`     | `POST …/resume`, the `/v1/restarts` routes, the auto-resume pass (`createAutoResumeBoot`)                                                                                                  | **Ferrets** (`restarts.json`, `auto-resume.json`)                                                                                                                                               |

Each commit also ships a unit test directory `tests/unit/modules/<module>/{build.test.ts,fixture.ts,route-contract.ts}`.
These are the quickest way to see each module's needs and provides. Take them as the port's starting tests, then add
the Appendix D row-named tests.

Instruction:

- **Take the extraction file as the body of the plugin's daemon half.** Keep the structure: `Needs` (typed
  collaborators), `Provides`, `build`, jobs armed by the plugin's `start()`. Replace `DaemonWorld` seams with the
  contract imports of §2.1; in these modules every owner they borrow is already a typed `Needs`.
- Keep the comments that state **order is the contract** (reach: the relay directory is read right after bind, the
  P2P carrier and tunnel switch are made before subsystems mount, relays dialled after serving, the tunnel after the
  relays; handover: `appendOnce` pages to the true end of the journal; reads: `resolve → configuration read` order for
  Codex provenance). They are behaviour.
- **Do not copy** the three C52 copies at the top of the branch: `a95813145` (copy of #1543), `ceefb079e` (copy of
  #1558), `41d7a8ad8` (copy of #1565). They are the same deletions as §1.1, §1.4, §1.5; apply those instead.
- Do not copy `bin/modules/seams.ts`, the `legacy/route-contract.ts` fixture, the `boot-trace` expectations as they
  stand, or `surface-world.ts`; they belong to the old `DaemonWorld` composition.
- **`fix/c50-resume-jobs`** (`a580ae863`, one `fixup!` on the session-resume commit): squash it into the Ferrets
  resume body. It changes four files only: `bin/fyd.ts`, `bin/modules/seams.ts`, `bin/modules/session-resume.ts` (+18
  lines: the auto-resume jobs now armed from the module) and `tests/unit/modules/session-resume/build.test.ts`.
- `c52/pr-18` (`ced5e6291`, see §4) was cut from `refactor/finish`, and `c50/pack` / `c50/config-files` are the
  same head (`41d7a8ad8`) with no commit of their own: **drop** both.

### 3.2 `refactor/c50-module-board-github` — one extraction (keep)

Only one commit is its own (`2bc74ab53`): the board-github module. Everything under it already landed.

- Files: `packages/daemon/bin/modules/board-github.ts` (190 lines), 4 lines in `bin/modules/seams.ts`, `bin/fyd.ts`
  (−117). It serves **no route**; it owns the alert path every board nudge passes (`BoardAlerts`, `AlertSurface`,
  `alertFallback`, `noticeRecipient`), the `GitHubWatcher` (runs the host's own `gh`, links the PRs a card's work
  opened, nudges through the board's path) and the Unfiled board's refile (`UnfiledRefiler`). One job, armed by
  `start()` after bind, whose `arm()` returns its stop callback synchronously.
- Port: **Board** (`board-github`). Take the file as the body of the Board plugin's watcher. `board-import` is
  deliberately **not** part of it (and is deleted anyway, §1.3).
- #1552's `pr-changes.ts` / GraphQL query change (§2.2) extends this watcher; build both together in the Board port.

## 4. The `c52/*` branches

| Branch (worktree)                                   | Own commits                                                                                                                                                                                                                                  | Decision                   | Instruction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `c52/fold`, `c52/pr-15`, `c52/pr-20a`, `c52/pr-16b` | `70d36ad44` (#1543 copy), `a315c906a` (#1558 copy), `36fe41a55` (#1565 copy), `242aa90a6` (#1554 copy), `ef801d9c4` (#1556 copy), plus the `terminal`/`browser`/`transfer` module extractions of `0bf48bb07`, and `pr-16b` = the #1576 stack | **Drop**                   | Duplicates of the open PRs; nothing new. (The terminal/browser/transfer extractions are already on `main`.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `c52/pr-16` (`5f0573b22`)                           | the #1576 commits plus `refactor(pwa): drop fallbacks for daemons older than the version floor` (79 files, +285/−910)                                                                                                                        | **Fold the deletions**     | The fallback deletions: board ids/projects, session queue, push device list, copy-rules settings, tunnel switch, WebRTC offer and runtime model catalog (a missing route is an ordinary failure); About, Agent CLIs, "Use the board" and machine-reach panes (404 falls to the generic error); runtime controls and fast mode (no "update the daemon" notice); event stream `?transcript=1`, fleet feed `?tail=`, transcript `log-page` (offsets required in the protocol); the board "older rule for cards without visibility" and the Done/Not good lane fallback; the clone-review missing-route case. Apply all in the app port.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `c52/pr-16c` (`396d411d3`)                          | `feat(pwa): refuse daemons below the 4.279.0 version floor` (`pwa/src/lib/daemon-version-floor.ts`, `relay-carrier.ts` +84, relay docs)                                                                                                      | **Drop the version floor** | **Do not port** `daemon-version-floor.ts` or its relay-carrier branch. The handshake (`PROTOCOL` + per-plugin contract hash, §9.6) replaces any floor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `c52/pr-18` (`ced5e6291`)                           | `refactor: present the session credential only as a fys_ bearer` (34 files, +317/−252)                                                                                                                                                       | **Fold**                   | Pure deletion of a fallback: the CLI presents the session credential **only** as `Bearer fys_…` (no `FY_SESSION_ID`-gated alternative, no feature test). Files: `cli/src/lib/daemon/credential.ts` (−78 lines of branches), `agent-tools/session-credential-gateway.ts`, `client.ts`, `mcp-group.ts`; `daemon/src/lib/api/authentication.ts`, `lib/session/lifecycle/{credential-rotation,policy,service,types}.ts`, `adapters/fork/session-fork-target-binder.ts`, `runtime/mounts/{agent-tools,config-files,learning}.ts`; `protocol/src/lib/agent-tools.ts`; `fleet/src/lib/account/fixed-layer.ts`; `docs/agent-tools.md`, `docs/secrets.md`. This is Appendix D row **S53** ("when the daemon lists `session.credential.1`, every request carries `Bearer fys_…`"); check its kept/split status there: the feature-test half goes. Security code is **copied, not redesigned**: keep the session-credential issuing/rotation untouched and delete only the alternative presentation. Ports: Ferrets (ferret tokens), Gate (authentication), CLI. |
| `c52/pr-19a` (`62758a7a2`)                          | `refactor(notifications): write only the agenda spelling and rewrite old ledger rows once` (+1594/−97)                                                                                                                                       | **Drop**                   | It _adds_ a one-shot rewrite of old rows (`notification-ledger-rewrite.ts` 197 lines, `ledger-spelling.ts` 239, `reading.ts` 91): a converter. **Do not port any of it.** The ledger is born in the agenda spelling (§6 deletes the old-spelling read in Agenda).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## 5. F640 sign-in recipe approval (#1425 → #1427 → #1426, and #1479)

**Decision:** keep the stack, park it, **re-cut it on 5.0** as an **Accounts** approval raised through **Asks**
(`source: 'sign-in-approval'`, §2.3 `ask.sources`) that the **Agenda** shows with a form. These are _agenda items that
implement an owner ask_, not board cards that ask. **Close #1479 as a duplicate.**

What the stack carries (the owner's choices, decision **A320**, quote: _"sign in recipe has to be approved very far
in -- when the ferret suggests it, why cant we immeidately approve it in chat?"_):

| PR (branch, base)                                                               | Content (re-use as spec and tests)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 5.0 owner                                                                                                                                                                                |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1425 PR1, protocol + daemon (`feat/f640-recipe-gate` ← `main`, +1468)          | `recipeProposal: { signIn, id }` on an agenda `task` card only; step-up act **`approve-recipe`** (machine-skippable: the machine itself is never asked); `LoginRecipeDecisionSchema` `{decision:'approve', recipe?} \| {decision:'decline'}`; the approval gate **`recipeProofRefusal`** on both doors (a governed/remote caller must hold a fresh proof stamped `approve-recipe`, **claimed atomically at admission**: one passkey, one approval; loopback is ungoverned; a decline never asks); "Approve my version" writes the owner's text in the same transaction (values check and stale check hold; no `recipeBy`); eligibility `history` on `no-history` (only when asked with `&progress=1`); `tapProgress` (the owner's fills that count, capped below two); the generic agenda answer refuses the recipe card (`use_input_form`)                                                                                                        | Accounts + Access (step-up act) + Asks (source)                                                                                                                                          |
| #1427 PR2, app card (`feat/f640-recipe-card` ← `feat/f640-recipe-gate`, +1894)  | The card answered in place in the chat view and the Inbox deck: "Sign-in steps for <place>", `vN → proposed · X added, Y removed`, numbered steps (added green, removed struck red), the ferret's quoted words, a "What Ferretry saw" box; Edit opens a textarea (max `LOGIN_RECIPE_MAX_LENGTH`) and "Approve my version" sends `{decision:'approve', recipe}`; `409 stale_proposal` re-reads; the card hides the generic "What I need from you" while the host draws (`PlanFormClaimContext`, `plan-form-claim.ts`); a device that may not read accounts (403) or a proposal the daemon no longer holds falls back to a plain card; B147 `endsItself` covers recipe-proposal items; the host holds the chat view while editing or deciding, then closes with its own words ("Recipe for github.com approved." / "Declined."). Files: `features/secrets/recipe-proposal-{card,host}.tsx`, `features/agenda/plan-form-claim.ts`, `lib/input-api.ts` | the app (Accounts app half + Agenda form slot)                                                                                                                                           |
| #1426 PR3, progress (`feat/f640-rule-progress` ← `feat/f640-recipe-gate`, +493) | "1 of 2 sign-ins done" on the open password card, the rule-suggestion card ("Not yet" + meter + what to do; the Review button hidden until ready) and Settings › account › site › Rule tab; `ruleReadiness`; the explainer "Ferretry offers a standing rule only for a sign-in you filled yourself from the app, twice in a row, so it has seen this page take this password." The line never holds the card after Send (B147 close-on-Send unchanged). Keep **2** sign-ins (decision A319).                                                                                                                                                                                                                                                                                                                                                                                                                                                       | the app (Accounts)                                                                                                                                                                       |
| #1479 (`feat/f640-approve-recipe-in-chat` ← `main`, +1294)                      | Same ask a second way: a daemon-only `recipeProposal: { signIn, proposal }` pointer on `AgendaItem`, `RecipeAgendaAdapter`, `RecipeProposalHost`/`Card`, a shared `RecipeDiff` with Settings, answering through the **same owner-only route** Settings uses.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | **Close as duplicate.** Nothing from it is ported. (One idea worth lifting into the spec: an agent raise that carries the pointer is refused `forbidden`; only the daemon may raise it.) |

Notes for the Accounts re-cut (do **not** do it as part of the first port; park it):

- The 5.0 target is Appendix D's S-rows for step-up (S106 stage + commit, S118 suspension) and the `approve-recipe`
  act is a **new step-up act**, so it needs a contract change in Access first (message the lead).
- Words in the PRs that the glossary replaces: "card" in "approve a suggested sign-in recipe on its card" becomes
  **ask**/**item**; "recipe card" is an ask with a form. The app half draws it from `ask.sources: sign-in-approval`.

## 6. Compatibility left behind by those PRs and by no PR at all (delete in 5.0 too)

The six PRs deliberately stopped short in places. A port that copies from the reference code would copy these back
in. Delete them as well.

| Left in place by …    | What                                                                                                                                                                                        | Where (reference code)                                                                                                                                           | Port                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| #1558 (row 6, PR-20)  | The ledger **v1 / unversioned read chain** (161 of 188 ledgers unversioned on the primary box)                                                                                              | `daemon/src/lib/agenda/**`, `adapters/agenda/file-agenda-ledger-repository.ts`                                                                                   | Asks                |
| #1558 (row 8b, PR-19) | The notification-ledger **old spelling** (450 old keys on disk)                                                                                                                             | `daemon/src/adapters/notifications/file-notification-delivery-ledger.ts`, `lib/notifications/*`                                                                  | Agenda              |
| #1558 (S2)            | `resting.migrated`                                                                                                                                                                          | `daemon/bin/modules/analytics.ts`, `daemon/src/lib/agenda/**`                                                                                                    | Agenda / Usage      |
| #1556                 | The `migrated` history event + renderers; `migratedAt` and `setBy: 'migration'` in the switch document; the PWA URL route `legacy-tasks-redirect`                                           | `pwa/src/shell/palette-destinations.ts`, `App.tsx`, `lib/pages/routes.ts`, `lib/router.tsx`; board history                                                       | Board, the app      |
| #1556                 | `unfiledRefiler.run()` at boot as a one-time pass (the _watcher job_ stays)                                                                                                                 | `bin/modules/board-github.ts` (extraction)                                                                                                                       | Board               |
| #1565                 | `machine.yaml` `attentionNudge` (name) and the `/attention` routes, the old push kinds, the host/port/relay spelling                                                                        | `fleet/src/lib/config-files/{check,skill}.ts`, `fleet/src/lib/account/schema.ts`, `daemon/bin/fyd.ts`                                                            | Kernel, Agenda      |
| #1554                 | The pairing stale-grants rewrite; `fillMissingCapabilities`; Vault v1 read; push `prefs`; the `fleet/config.yaml` refusal                                                                   | `daemon/src/adapters/pairing/state-pairing-repository.ts`, `lib/pairing/service.ts`, `protocol/src/lib/{grants,pairing}.ts`                                      | Access, Vault       |
| #1543                 | `completeSessionUpgrade` name and its v1 branches                                                                                                                                           | `daemon/src/adapters/storage/session-storage.ts`                                                                                                                 | Ferrets             |
| #1576                 | `DAEMON_FEATURES`, `hasFeature`, the feature names, `LEGACY_MAX_IDEA_CHARS`                                                                                                                 | `protocol/src/lib/daemon-features/**`, app `lib/daemon-health.ts`, `lib/board-ports.ts`, `features/catalogs/catalogs-api.ts`, `cli/src/lib/daemon/credential.ts` | the app, Kernel     |
| **No PR**             | The one-time move of `cgroups/config.json` → `limits.yaml` (reads the old JSON, carries `enabled` and percentages, writes `config.json.migrated`). **Not covered by any in-flight item.**   | `daemon/src/lib/cgroups/legacy.ts`, `daemon/src/adapters/cgroups/legacy-documents.ts`                                                                            | Terminals (cgroups) |
| **No PR**             | `warden/auto-migrate*` and the `migrate` name on moves (see §3.1: renamed `move`, not deleted, since moving a ferret to another account is a product feature)                               | `daemon/src/lib/warden/auto-migrate{,-service}.ts`, `cli/src/lib/migration/**`, `pwa/src/components/migrate-*`                                                   | Ferrets, Warden     |
| **No PR**             | `scripts/validate/no-legacy-state.sh` — a repo check, not product code; keep it in the repo checks (it forbids the pre-Ferretry state paths and wire names in `packages/`), no port needed. | `scripts/validate/no-legacy-state.sh`                                                                                                                            | repo checks         |

The `no-compat` check will find the rest by name; this table is only the ones it cannot find by grep.

## 7. #1573 and #1578

- **#1573** `ci(realworld): run the Realworld Tests job nightly and on dispatch only` (`ci/realworld-nightly`, +38/−26)
  edits `.github/workflows/realworld.yaml` (the `realworld` job runs only on `schedule` at 09:17 UTC and on
  `workflow_dispatch`; the PR path filter loses `packages/*/tests/realworld/**`), plus
  `docs/standards/ci-cd/index.md` and `docs/standards/testing/index.md`. Saves about 9.4k Namespace unit-minutes a
  day. It also clears #1554's red check. **Not superseded.** `rebuild/5.0` (`bb89d054d`) does **not** have this
  change yet: the lead should bring the one workflow file and the two doc paragraphs onto `rebuild/5.0` (or merge
  `main` once #1573 lands), otherwise the rebuild's CI spends the Realworld minutes on every `full-ci` pull request.
- **#1578** `extract the conversation-import module from fyd.ts` is merged. `bin/modules/conversation-import.ts` is in the
  reference code (it is the body of Conversation's `imports`). Nothing to do beyond the normal port.

## 8. What the ports must not miss

1. **Every compatibility file named in this document is a delete, not a port.** Copy from the reference code, then
   run the deletions of §1 and §6 for your subsystem **before** you rename. `rg -n -i
'legacy|deprecat|compat|migrat|retired'` over your package is the exit check (the `no-compat` check).
2. **The migrations in §6 that no PR covers** (cgroups `legacy.ts`/`legacy-documents.ts`), and the compat code the
   PRs name as "Kept" (ledger v1 chain, old notification spelling, `resting.migrated`, `attentionNudge`,
   `legacy-tasks-redirect`, `DAEMON_FEATURES`). They are the part a "copy the PRs" approach would miss.
3. **`session-migrate` is renamed `move`**, not deleted: the product feature (move a ferret to another account) stays;
   only the banned word goes. `fy migrate` becomes the move verb in the Ferrets CLI half.
4. **#1552 is the target model**; port Agenda, Asks and Board against §2, not against today's reference code. In
   particular: one answer row per item; no card-asks text on any card; `tryItVerdict` and the daemon-only
   nothing-to-try close; the order asks are asked in; the `gateAttached` mirror and synthesized rows are _not_
   ported; `owner-surface-words` words are policed in the glossary check.
5. **Order is behaviour** in the extractions (reach boot order, handover `appendOnce`, resume/auto-resume timing,
   reads' provenance order). Keep the comments that say so, and the unit tests that pin them.
6. **Security code is copied.** The session-credential gate (S53), the final response check, step-up and the grants
   code are not touched by the deletions except for the single-presentation change in `c52/pr-18` and the
   feature-test removals in #1576. Appendix D's SPLIT rows say exactly which half goes.
7. **No version floor, no feature probes, no "older machine" panes** anywhere in the app. The only skew handling
   is `PROTOCOL` (the one full-screen sentence) and the per-plugin contract hash (§9.6).
8. **Do not close PRs yourself.** The lead closes #1543, #1554, #1556, #1558, #1565, #1576 and #1552 after 5.0
   lands, closes #1479 now as a duplicate, keeps #1425/#1427/#1426 until the Accounts re-cut lands, and lands #1573.

## 9. Sources used (so this can be redone)

PR facts are from `gh pr view <n> --json title,state,headRefName,additions,deletions,mergeable,statusCheckRollup`
and `gh pr view <n> --json body`, read on 2026-11-07 against `origin/main` `557a6d3dd`. File lists are from
`git diff --name-status origin/main...<branch>` and `--stat`. Branch heads at the time: `refactor/finish`
`41d7a8ad8`; `refactor/c50-module-board-github` `2bc74ab53`; `fix/c50-resume-jobs` `a580ae863`; `c52/pr-16`
`5f0573b22`; `c52/pr-16c` `396d411d3`; `c52/pr-18` `ced5e6291`; `c52/pr-19a` `62758a7a2`. The reference-code path
claims in §6 are checked with `git ls-files` and `rg` in `.worktrees/rebuild-ref`.
