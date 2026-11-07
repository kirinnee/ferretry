# v4 → v5 home converter (one-time tool)

Carries a stopped Ferretry **4.291.x** home into a **new** Ferretry 5 home with all data and every ferret kept. It is
run by the agent following [`docs/migration/v4-to-v5-prompt.md`](../../docs/migration/v4-to-v5-prompt.md), once per
machine. What it reads is [`docs/migration/v4-formats.md`](../../docs/migration/v4-formats.md).

## It is not part of the product

- Not a workspace member (the root globs are `packages/*`, `packages/core/*`, `packages/plugins/*`), never imported by
  any package, never bundled, compiled or released. `scripts/validate/migration-isolated.sh` enforces this on every
  commit, with its own planted-violation self-test.
- Its v4 parsers are its own (`src/v4/`). No v4 type or reader exists in `packages/`, and none may be added there.
- It writes v5 files only through the v5 schemas, imported from the v5 contracts (`@ferretry/<pkg>/contract`, mapped
  in `tsconfig.json`), so it can only produce files the v5 readers accept.
- **It is deleted from the repository once all three machines are on v5**, together with
  `scripts/validate/migration-isolated.sh` and its wiring.

## Use

```bash
cd migration/v4-to-v5 && bun install
bun src/main.ts --from <stopped v4 home> --to <new folder> [--report <file>] [--dry-run]
```

| Exit | Meaning                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------- |
| 0    | complete: every step converted and `home.json` written last                                          |
| 3    | ran, but a step is pending or failed: no `home.json`, so v5 refuses the folder (by design)           |
| 2    | refused before writing: not a stopped 4.291.x home, v4 daemon still holds its lock, target not empty |
| 64   | usage                                                                                                |

The report (`<to>.conversion-report.json`, beside the new home, never inside it) holds counts, ids and names only.

## Safety properties

- The v4 home is only read; the new home must not exist or be empty and must not overlap the source.
- `home.json` is written **last**, only when every step finished, so a half-converted folder can never be booted.
- Sealed and secret files (vault, its key, the identity key, push keys, harness sign-ins, the message-token key) are
  moved with `copyFile` + mode + times (`src/sealed.ts`): their bytes never become a value in this program, and the
  report names a file and its size, never content.
- The live tmux socket is given a second name in the new home with `link(2)`, so v5 reaches the same running server.

## State (Phase B)

The preflight, sealed mover, report and ordered step table (`src/steps/index.ts`) exist. Vault, identity, ferrets,
terminals, harness-homes, conversation, board, asks/agenda, projects, lessons, usage, warden, catalogs and shares, MCP, logins, website accounts, Gate, Access, settings, daemon settings and Packs have real conversions: every step converts, so a complete v4 home converts with exit 0 and gets its `home.json`.
Fixture homes built from the real 4.291.5 release are in
`fixtures/` (CI-only on shared boxes).

Ferret records keep ids, parent edges, spawn provenance, transfer edges, project ids, names, runtime, work folder,
resume ids, pane handles and credential hashes. Transcript home/file metadata points into the copied agent homes
and shared pools; the transcript bytes are never parsed. Journals become history, callsign claims become names,
and archive entries, worktree records/intents and fork receipts retain their schema-backed fields. The kernel's
declared `format: 1` stamp is added to document bodies; fork receipts also retain their original `v: 1`.

Beside each `ferret.json` (`src/steps/ferret-details.ts`): `config.json` and `state.json` are the v4 documents whole
(v5 keeps them loose), with `migration`/`migrations` renamed `move`/`moves` and old-home paths (runtime wrapper,
transcript, a pooled conversion source) pointed into the new home; `state.json` keeps the v4 status `ferret.json`'s
state was decided from. `pins.json` becomes `{format: 1, pins}`, `state/agent-pins.json` becomes
`state/ferrets/agent-pins.json` (pins of converted ferrets only), and `details.json` holds the start options
(`StartOptionsSchema`) and the v4 `name` as the title. A damaged pin file reads as no pins, as v4 read it. Those v5
schemas are private to the Ferrets daemon, so `tests/unit/ferret-details.test.ts` reads every file back with v5's
real schemas in a subprocess.

Declared files without a v5 schema are **not written**: moves, auto-resume, restarts and terminals.json. Runtime
`formerNames` belongs to the pending Runtimes/Logins conversion, not the Ferrets callsign ledger. The card a session
was anchored to is shown through `details.json`;
name counters, extra history artifacts and pin/option leftovers are listed in `notCarried`. Frozen
fork plans keep their original paths and fingerprints; changing their decision would invalidate replay checks.

Agendas (every ferret's and the machine agenda) keep v5's per-ferret engine files. v5 reads ledger `version: 1`
only and deleted v4's read-time upgrade, while v4 rewrote a board only on its next change, so many boards on disk are
still unversioned or at 1–3. The step therefore reads each board with **v4.291.5's own engine, vendored verbatim**
under `src/v4/agenda/engine` and `src/v4/agenda/protocol` (a header names the source commit; never edit, re-vendor),
then applies the v4→v5 difference: `version` 4→1, the dropped `gate`/`gateAttached`/`gateAttachedChangedAt` fields,
and a `replied` close (no longer a disposition) carried as `done` in the ledger, history and version snapshots. The
history cursor is recomputed; version archives are copied and set to `user_version` 1. An unfinished v4 commit
(`agenda-versions.pending.json`, `agenda-history.jsonl.pending`, a non-empty `agenda-changes.pending.json`) fails the
step by name. `notifications.jsonl` yields only what v5 can meet again: an ask's own buzz and the owner's opens (seen).

Board cards keep their ids exactly (`&F1792` names the same card); counters continue after the highest id; parent,
dependency, PR and approval links are kept (an approval names the same per-ferret ask `A<n>`); dropped and closed cards
are ordinary cards. Every card is parsed by v5's strict `CardSchema`: v5 kept v4's field names (`machineId`,
`projectId`, `laneId`, the ask's `text` and `source`), so only `v` → `format`, `status` → `progress` and the approval's
`sessionId` → `ferret` change. Every actor takes v5's strict actor shape (owner `{via?}` with v4's `…Via` folded in,
ferret `{name, ferret}` named by its callsign, daemon). Every v4 history event type maps to the v5 type of the same
name, except `migrated` (dropped by v5), which becomes a `note` naming the legacy ref; an unknown type fails the step by
card and type. Lane sets and the switch become one `boards/<project>.json` each (a gate's `reopen-with-agenda` is
`reopen-with-ask`), the sweep memory is carried whole, and each session's `focusTask`/`focusAnchor`/`boardSkip`
becomes `state/board/focus.json`. `legacyRef`, the session an owner or the daemon acted from and the switch's
`migratedAt` have no v5 field and are listed in `notCarried` (`src/steps/board.ts` has the full mapping).

Conversation (`src/steps/conversation.ts`) writes every file `@ferretry/plugin-conversation` declares under
`state/conversation/`: the message-token key (moved unopened), each ferret's `turns/` (byte for byte), its drafts
document (`{chat, items}`, snapshots through `DraftSnapshotSchema`, reply drafts under their unchanged ask ids),
`links.json` (ferrets whose transcript identity is `adopted`), and `queue`, `sends`, `answers`, `inbox` and `outbox`
`.jsonl` line for line. Every log line gains the kernel's `"format": 1` stamp and is parsed by the v5 store's own line
shape (built from the contract's schemas, because v5 keeps those line schemas private to its daemon); a send line is
also projected to the wire view and parsed by `SendRecordSchema`. In the send ledger `session_ended` becomes
`ferret_ended`, and `payloadFile` (a path to v4's `channel/queued-<id>.md`, which v5 neither reads nor has a place
for) and four v4 tracker timers are dropped. Outbox `question` lines are Ferrets' in v5 and are not carried. A live
ferret's `question-asked.json` becomes `question.json` through `QuestionSchema`, as v5's own writer stores it (one
question, proved against the ferret's transcript rewritten into the new home, `askedAt` = the file's mtime); anything
that writer would clear is left to the transcript. Attachments become `attachments/<ferret>~<id>.original` (moved
unopened) and `.manifest` (re-encoded as v5's store writes it, checked as its parser checks), the `<daemonId>` segment
dropped; renders become unsharded `renders/<id>.json` (`StoredRenderMetaSchema`, `author.sessionId` →
`author.ferret`) and `renders/<id>.payload` (moved unopened). A line or document v5 would refuse fails the step by
file and line, never by value.

Harness files are copied unopened under `state/<claude-code|codex>/agent-homes/`: runtime UUID directories hold
runtime-owned files; `_shared` holds each shared transcript pool (including Codex SQLite). Modes and times of these
opaque files are preserved. Links are omitted, never followed or re-made: the contracts do not yet declare a link
policy or a runtime-to-ferret home mapping. Those are explicit gaps; these copies alone do not make resume ready.
Sign-in files and `fleet/credentials/` belong to the Logins step.

Packs (`src/steps/packs.ts`) folds `config/pack.yaml` and `config/models-guide.yaml` into one `config/packs.yaml`
(the guide's `prompt`/`suggested` nested under `routing`, comments kept), turns each `state/pack-guide/<id>/` into
flat `state/packs/runs/<id>.<file>` names (`run.json` with `job.session` → `job.ferret`, the inventory's harness
`claude` → `claude-code`), keeps the one undo as `state/packs/replaced.json` (the replaced PROMPT, where v4 kept the
whole file) and each session's `pack` switch as `state/packs/switches.json`. `config/routing.json` has no v5 home and
is listed, its accounts named by runtime name (M7); the runtimes it excluded become one line at the end of the routing
prompt when the home has a prompt of its own (lead decision 2026-11-07), and are only listed otherwise, because a prompt
holding just that line would replace the one v5 renders from the model catalogs; a builder's `draft.json`, Jev's spend ledger and the
routing-migration backups are not carried.

Projects keep every id exactly; v4's bare array gains the `{format: 1, projects}` envelope. Warden carries its sweep
memory under `format: 1` (v5's schema is still the condensed `looseObject`, so the sections keep v4's names), moves
blessings to `remembered.json`, rewrites each `reportPath` into the new home, copies reports unopened and turns each
`jev-checks/<day>.jsonl` into `{format: 1, day, checks}`; the per-assignment stop capability is a secret and is
dropped. Logins moves each `fleet/credentials/<login>/` whole with `moveSealedTree` (lstat and folder listings only;
a file this user may not read fails the step by path, never hard-linked, so the backup stays its own file; a link is
made again, never followed) and turns
`state/model-catalog.json` into `models.json` `published`. A v4 login id with capitals fails the step: v5 login ids
are lowercase. `config/warden.yaml` and `config/logins/*.yaml` belong to the Settings step.

Settings (`src/steps/settings.ts`) turns each v4 `config/*.yaml` into the v5 plugin config file that owns it: runtimes
(`credential` → `login`), profiles, model sets, MCP and skills items, logins, endpoints (v4 presets), model catalogs,
`warden.yaml` (`autoMigrate` → `autoMove`, with v4's read-time upgrades applied), `limits.yaml`, `accounts.yaml`, and
`machine.yaml` split key by key over eight owners. Comments survive (each file is edited as a `yaml` Document) and every
file is checked by its v5 schema before anything is written. v4 `claude` is v5 `claude-code` in every `harness:` field.
A runtime alias in `fleet/ids.json` `formerNames` is rewritten to the current name (M7). Settings and hooks components,
an instructions document outside `fleet/assets/`, `voice.yaml`, `pack.yaml` and `models-guide.yaml` wait for v5 schemas
(the step reports `pending`). The full per-key table is `docs/migration/v4-formats.md` §5a.

Daemon settings (`src/steps/daemon-settings.ts`) splits `config/daemon.json` by owner: `grants` → `gate.yaml` with all eight
capabilities and both axes written explicitly at v4's effective value (`configure` only where `use` is on), plus
`state/security.json` → `gate.yaml` `security` (a damaged one as v4's strictest reading); the parsed result is compared
with what v4 enforced and any widening fails the step. Carriers → `connections.yaml` (`direct`, one `relay`, `tunnel`,
`webrtc`; an owner's `enabled: false` stays false; two relays switched on fail, since v5 dials one). `harness` paths →
both harness files and the agenda deadline → `agenda.yaml`, added to what Settings wrote there. A catalog link store
turned off or a shorter member unlock waits for a Catalogs schema (`pending`); `secretEnvironment`, `usage.url`, CORS,
`publicUrl` and tuning keys are listed in `notCarried`, by key only; `routing.json` belongs to the Packs step.

The `rebuild/migration-ferrets-b` development branch contains a local merge of the unreviewed
`rebuild/port-ferrets-a2` schemas. **Do not integrate it before Ferrets lands on `rebuild/5.0`.** Once Ferrets lands,
rebase the converter commits onto `rebuild/migration` without that port merge. The independent first pass remains
on `rebuild/migration-ferrets`.

Usage (`src/steps/usage.ts`): `budget-holds.json` → `state/usage/pauses.json`, `budget-told.json` → `pause-told.json`
(the told keys are spelled the same in both), and `daemon.json`'s `analyticsPricing`/`analyticsPricingSources` →
`pricing.json`; a rate row in v4's older `ratesUsdMicrosPerMillion` spelling is converted with v4's own transform,
vendored in `src/v4/usage.ts`. These v5 schemas describe the body without `format`, so `V5Writer.stamped` writes it
first, as the kernel does. The passive `fleet/credentials/<login>/usage.json` readings are only `lstat`ed and not
carried: v5's `quotas/<login>.json` holds a provider-endpoint reading with no statusline source. None of these files
holds a runtime uuid; the analytics index that does is a cache.

Catalogs (`src/steps/catalogs.ts`) writes `state/catalogs/`: `catalogs.json`, `links.json`, `members.json`,
`shares.json` and `member-passkeys.json` keep every v4 value under `format: 1` (`schemaVersion` dropped; a version-2
`catalogs.json` is upgraded as v4 does, a version-1 one or a members file with two people of one name fails with
"start v4.291.5 once"), `catalog-installs.json` becomes `installs.json` with every pin, publisher and revision (an
install stays at its pinned version), and each `blobs/<sha256>.json` is copied as the same bytes (its name re-checked
as the hash). v5 Catalogs declares these files but not yet their bodies, so the landing check is every joining id and
digest through the contract's id schemas, and each install must read as `CatalogInstallSummarySchema`. Nothing signed
is stored: the signed manifest is rebuilt from unchanged fields and blobs with the unchanged identity key, so nothing
is re-signed. The sealed `link-keys.json` (AAD `catalog-link:<linkId>`, unstamped, under the vault key) is re-labelled
with `rewrapSealed` (`v` → `format`, entries unchanged), and a test opens it with v5's own `KernelSealedDocuments`
and the moved vault key. `local-skill-installs.json` becomes Skills' `state/skills/installs.json`
(`LocalSkillInstallStateSchema`, harness `claude` → `claude-code`). A former runtime name becomes the current one
(M7). Live member unlocks, the install hold/skip prefs, the upgrade backups and the runtime skill folders under
`fleet/assets/skills/` (the Runtimes asset tree, whose v5 place is not declared yet) are listed in `notCarried`.

MCP (`src/steps/mcp.ts`): `mcp-oauth.json` → `state/mcp/oauth.json`, envelope only (`v` → `format`); the records are
the same in both. The access tokens are vault secrets kept by name (the Vault step). The sealed
`mcp-oauth-secrets.json` (refresh tokens, client secrets) → `state/mcp/oauth-secrets.json`: sealed under the vault
key, which the Vault step moves once, BEFORE this step; every entry moves as the same strings and only the envelope's
`v` → `format` changes (outside the AAD). A test seals fake entries the v4 way and opens both moved documents with the
moved key. Nothing is decrypted by the tool.

Accounts (`src/steps/accounts.ts`) writes `state/accounts/`: `login-entries.json` (`v: 2`) → `accounts.json` under
`AccountIndexDocumentSchema` with every handle, `L…` key, `si_` sign-in and `tf_` 2FA key id kept; `v: 2` becomes
`format: 1`, the one-time `migrated` record is dropped, and a 2FA key v4 marked `addedBy: 'migration'` is the
owner's (v5's only origin). `accounts/sign-in-rules.json` and `secure-copy/rules.json` (→ `copy-rules.json`) are the
same JSON values with `format: 1` stamped first, so every passkey-signed rule body still verifies; an absent paste
`settings` is v4's default (profile targets off). The sealed `login-secrets.json` → `accounts/login-secrets.json`:
v5's `LOGIN_SECRETS` opens it with the vault key the Vault step moves (BEFORE this step) and the entry name alone as
the AAD, exactly as v4 sealed it, so only the envelope's `v` → `format` changes; a test seals fake entries the v4
way and opens them with the moved key. A sealed value no account points at is carried and swept by v5's first start,
as every v4 start swept it. A `v: 1` (saved-logins) index fails by name: v4 upgrades it only at daemon start. Task
and paste plans, rule suggestions, phone approvals and staged seeds were memory-only in v4; `account-defaults.yaml`
is the Settings step's.

Gate (`src/steps/gate.ts`): `api-token` and `api-warden-token` (home root) move byte for byte to
`state/gate/admin-token` and `warden-token` (`0600`; v5's CLI reads the same raw text). The four audit files — the
general and kept stores with their rotated halves — become one `audit.jsonl` of v5 `AuditRecordSchema` lines, oldest
first. Four kinds are renamed (`input.quarantine_*` → `input.hold-*`, `session.credential-*` →
`ferret.credential-*`). The grant and security journals are not Gate's in v5 (Access below).

Access (`src/steps/access.ts`) writes `state/access/`: `devices.json` keeps every device field and public key with
`daemonId` (the identity is carried), and each grant is v4's effective value over v5's capability set (a capability
v4 did not name is off, `configure` only where `use` is on, a capability v5 dropped is reported); a `schemaVersion: 1`
bearer document is not converted. `passkeys.json` keeps credential ids, public keys, sign counters and origins; a
passkey of a device that is not carried goes with it. Live unlocks are not carried (each device unlocks again once);
the unlock settings are `gate.yaml` `security` (Daemon settings). v4's `grant-audit.jsonl` and
`security-audit.jsonl` become the ONE `grant-audit.jsonl` v5 Access declares and writes both journals into, line for
line with `format: 1` first, oldest first. `push-vapid.json` → `push-keys.json` changes its envelope only
(`schemaVersion: 1` → `format: 1`, lead decision: v5 reads the bytes as `{format: 1, privateKeyJwk}`): read once in
memory, the JWK object written back unchanged in one atomic 0600 write, never in a report or error. `push.json` moves
only in the run that writes its key, both checked first; a subscription of a device that is not carried goes with it.

Lessons (`src/steps/lessons.ts`) writes every file `@ferretry/plugin-lessons` declares under `state/lessons/`:
`state.json` (v4's learning state, with `sessions.json`'s per-ferret switches folded in as `ferrets`, lead decision M5),
`observations.jsonl` line for line, `suggested.json` (every proposal, whatever its state), `dismissed.json` (the
tombstones), `runs/<run>.json`, `digests/<run>.json` (unfinished runs only), `patches/<name>.json` and `global.json`
(the Global lessons document: the file the `lessons` instructions component names, else
`fleet/assets/instructions/lessons.md`). `config/learning.yaml` becomes `config/lessons.yaml` with comments kept. Ferret
ids are unchanged, so `sessionId`/`sessionIds`/`minerSessionId`/`minerSessions`/`sessions*` become the same values
under their `ferret` names, `perHarness.claude` becomes `claude-code` and `maxSessionsPerRun` becomes
`maxFerretsPerRun`; a Global lesson's `target.path`/`applied.path` (v4's asset file) becomes v5's
`Global lessons document`. v4 read these files leniently, so the step carries what v4 read and counts what it dropped;
a miner's raw `observations.json` and finished runs' digests are listed in `notCarried`. v5 gives the Global document to
every ferret's launch, where v4 gave it only to ferrets whose profile included `instructions/lessons`; so the Settings
step drops that component and removes the layer from every profile (lead decision 2026-11-07), and no ferret gets the
rules twice.

## Tests

`bun test tests` (unit; temp folders only, never a real home).
