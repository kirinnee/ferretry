# Shared history: one pool per harness, and an index that makes linking fast

Status: design, 2026-11-16, card &F4326 (under &C58). Owner ask, verbatim: "history linking -- can we link with
default history (default claude history) and codex share across all -- and it being FAST?"

This turns the parked "shared-history pooling (conversation's: an apply skips it and says so)" line in
`packages/plugins/runtimes/ports-pending.json` back ON, and adds the index the owner's "FAST" needs.

## 1. Numbers first (measured 2026-11-16 on the owner's machine, read-only)

| What                                                                  | Value                                                                                           |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| v4 Claude pool `~/.ferretry/fleet/shared/claude/projects`             | 19 GB, 167 project folders, 10,595 `.jsonl` (9,395 top-level)                                   |
| v4 Codex pool `~/.ferretry/fleet/shared/codex/sessions` (+ `sqlite`)  | 2.6 GB, 2,547 rollouts (+ 999 MB SQLite)                                                        |
| Owner's default `~/.claude/projects`                                  | 1.8 GB, 721 transcripts, newest 2026-10-31, 4 ids also in pool                                  |
| Owner's default `~/.codex/sessions` (+ `sqlite`)                      | 1.6 GB, 888 rollouts (+ 2.6 GB SQLite), 0 ids in pool, still in use (2026-11-16)                |
| Transcript sizes (Claude pool)                                        | p50 0.5 MB, p90 3.0 MB, p99 12.3 MB, max 939 MB                                                 |
| Active in the last 7 days (Claude pool)                               | 3,497 transcripts, 7.4 GB                                                                       |
| **v4** `fy import conversations history linking --since 7d` (3 runs)  | **192–197 s, exit 1, no output** (every query shape; Codex-only too)                            |
| **5.0** link describer (`FileConversationDescriber`), cold, real pool | **48 s** for the 7-day set; **124 s** for the whole pool (13 ms/file)                           |
| 5.0 describer, Codex pool 7-day set (1,141 rollouts, 1.3 GB)          | 15 s                                                                                            |
| 5.0 describer, what 5.0 lists today (default homes only)              | `~/.claude` 469 files 12 s + `~/.codex` 888 files 17 s = **29 s cold** after every daemon start |
| Stat of every top-level Claude transcript (`find -printf`)            | 30 ms (bun walk with `stat`: 250 ms)                                                            |
| Proposed index query, 15,000 rows, 2 words + since, newest 50         | **2.8 ms p50**, 4.4 ms max (bun:sqlite, in memory)                                              |

The slot-8 preview has fake data, so 5.0 was measured by running its own describer code over the real v4 pool,
read-only (`scratchpad/bench/describe-bench.ts`).

## 2. How history is shared today

**v4** pools by symlink. Every login home `~/.ferretry/fleet/homes/<login>/` links the history entries
(`projects`, `sessions`, `session-env`, `file-history`, `plans`, `tasks`, `todos`, `shell-snapshots`, `paste-cache`,
`history.jsonl`; Codex: `sessions`, `archived_sessions`, `history.jsonl`, plus `CODEX_SQLITE_HOME`) to
`~/.ferretry/fleet/shared/<harness>/`. Credentials and settings stay per login (one Codex login links `auth.json` to
the owner's `~/.codex/auth.json`). The owner's default `~/.claude` and `~/.codex` are separate and not pooled.
Leases live at `fleet/shared/<harness>/.leases`.

**5.0** does not pool. Each ferret has its own harness home, `state/claude-code/agent-homes/<ferret>/` and
`state/codex/agent-homes/<ferret>/`, used as `CLAUDE_CONFIG_DIR` / `CODEX_HOME`. Consequences:

- The kernel refuses every link inside `agent-homes` except `linkCredential` (`credentialHomeLinkVerdict`,
  `core/kernel/host/shared-credentials.ts`), so no plugin can pool today. Runtimes' apply skips pooling and says so.
- The v4→5.0 migrator copies the v4 pool to `agent-homes/_shared` (`migration/v4-to-v5/src/steps/harness-homes.ts`),
  but nothing links it, so a converted ferret's `hasConversation` proves the transcript absent and it **starts a new
  conversation** (`core/ferrets/daemon/lib/ferrets/service.ts`, !A516). The same happens to a conversation kept from
  the owner's own `~/.claude`: it lives outside the ferret's home.
- `fy link` lists only the owner's default homes (`historyHome` = `~/.claude`, `~/.codex`), not other ferrets', and
  describes every file by reading up to 8 MiB of it, with an in-memory cache only (cold every daemon start).
- The lease store (c58-36) is already per harness, not per home:
  `state/ferrets/conversation-leases/<harness>/<id>.lease` under one `flock`, claimed on every start, resume and fork,
  and by `fy history claim` in wrappers. Pooling needs nothing more from it.

## 3. Design

### 3.1 One pool per harness (H1–H3 of `account-model.md`, kept)

- The pool is a harness plugin's own state tree: `state/claude-code/history-pool/` and `state/codex/history-pool/`.
  It is NOT inside `agent-homes`, so it is never a credential home.
- Each ferret home gets one link per pooled entry (the H3 list above), made when the harness prepares the home:
  `agent-homes/<ferret>/projects -> state/claude-code/history-pool/projects`, and so on. Codex also gets
  `CODEX_SQLITE_HOME=<pool>/sqlite` on its launch line (an env var, no link). Everything else in the home
  (`.claude.json`, `settings.json`, `.credentials.json`, `CLAUDE.md`, `skills`, `auth.json`, `config.toml`) stays the
  ferret's own, so logins, credentials and settings are unchanged.
- **Kernel door (the one security-relevant change).** A new, narrow `RootHandle.linkHistory(home, entry)` in the
  kernel: allowed only for a plugin whose manifest declares `permissions.historyPool` with its fixed entry list and an
  opaque `history-pool/*` state def; `entry` must be one of the declared names and never a credential or settings
  name (fixed deny list: `.credentials.json`, `.claude.json`, `settings*.json`, `auth.json`, `config.toml`,
  `CLAUDE.md`, `AGENTS.md`, `skills`, `plugins`, anything starting with `.`); the target is the plugin's own pool, which
  the kernel creates with `0700`, and `at` is the top level of one ferret home. `credentialHomeLinkVerdict` is
  unchanged for every other caller. `docs/secrets.md` gets the row; the threat it adds is "a ferret can read another
  ferret's transcripts", which is exactly the owner's ask and what v4 did.
- **Kernel door, as built (PR 2, `rebuild/c58-hist-kernel-door`; the contract is `docs/secrets.md`, "A harness's history pool
  in every ferret's home").** It differs from the sketch above in these ways:
  - The permission is `permissions.historyPool: { state, entries }`: `state` is the NAME of the plugin's own opaque
    `history-pool/*` state def (one plain folder, not deeper), and `entries` is the closed list of `{ name, kind }`, with
    `kind` `'folder'` or `'file'` so the kernel knows whether to make a `0700` folder or an empty `0600` file on first use.
    `reachFaults` (build graph and boot) refuses an illegal declaration and one without the `agent-homes` root.
  - Refusals are a closed `HistoryPoolError.refusal`: `not_internal`, `not_permitted`, `denied`, `not_listed`, `not_own`,
    `not_home`, `exists`, plus the roots' own `RootError` for disk facts (`outside`, `link_escape`, `changed`,
    `hard_link`, `no_descriptor_reach`). `denied` is checked before `not_listed` and holds whatever the manifest declares;
    beyond the fixed names it also refuses any name that looks like a credential (`credential`, `secret`, `token`, `oauth`,
    `passw`) and compares case-insensitively.
  - It is on `RootHandle` (not `RootsPort`), beside `linkCredential`: it writes into the handle's root through the same
    checked descriptors. It takes the home as a `FencedPath` of an unscoped handle (`<root>/<ferret>`) or the base of a handle
    scoped to one ferret; a home that is not exactly one folder below the top of `agent-homes` is `not_home`.
  - The kernel ensures the pool itself (folder and entry, owner-only) inside the call, after every refusal; there is no
    separate ensure member. A caller that needs the pool before any home exists makes it with its own state port.
  - **What PR 3 found it still needed:** the door only LINKS. A harness can neither read the pool through a link (the state
    port refuses Claude's `-home-user-proj` folder names and has no windowed read) nor move files into it, so two more kernel
    pieces, in their own commit and in `docs/secrets.md` next to the door:
  - **PR 3:** `RootsPort.historyPool(): RootHandle` gives a synchronous, writable internal view of only that plugin's
    own opaque, non-private pool; boot now makes its base `0700` before plugin code runs. It reads, lists, writes,
    copies and supports windowed reads/`openBytes` through the regular fenced no-follow descriptor machinery. It has
    no history door, can never source or place generic links, and cannot reach other state or a ferret home.
  - **PR 3:** `RootHandle.moveToHistoryPool(from, pool, to): Promise<void>` renames one listed history entry or leaf
    out of one ferret home into its minted pool view, including `.conflicts/<ferret>/<entry>/...`. Missing pool parents
    are made `0700`; existing targets, hard-linked source files and placed credentials are refused. No copy fallback,
    no followed leaf link, no descriptor reach means refusal. It retains `renameChecked`'s declared look-then-move GAP.
  - **macOS:** the held-folder steps have no `symlinkat` yet, so a host with no `/proc/self/fd` refuses
    `no_descriptor_reach`. PR 3 pools on Linux; macOS pooling needs a `symlinkat` step in `FolderSteps` first (open point 4).
- **Existing homes.** A home whose entry is already a real folder (a 5.0 ferret that ran before this) has its files
  moved into the pool by rename (same device); a name already in the pool is kept as
  `history-pool/.conflicts/<ferret>/…` and named in the result, never overwritten. Then the link is made.
- **Migration.** The v4→5.0 migrator writes the v4 pool to `state/<harness>/history-pool/` instead of
  `agent-homes/_shared`, so converted ferrets resume their real conversations (fixes !A516).
- `hasConversation` looks through the pool (Ferretry's own spelling first, then one `projects/*/<id>.jsonl` lookup per folder),
  so a pooled resume is never refused. Every other read of a ferret's transcript goes through the same pool handle when its
  `projects` / `sessions` is the pool's link (the home's root never follows a link out).
- **Codex** also launches with `CODEX_SQLITE_HOME=<pool>/sqlite` (an `env` prefix beside `CODEX_HOME`), only when its `sessions`
  is pooled too. Its rollout proof stays per ferret: a NEW conversation is found among the pool's rollouts filed on the last
  days only (a baseline of those days, and the correlation marker is per home), a RESUMED one by its id alone, so a ferret
  never adopts another ferret's rollout and a launch never reads the whole pool.
- **Fail-safe.** Pooling is never a reason to refuse a launch. An entry that cannot be pooled (a host with no descriptor path,
  a link inside an old real folder) stays the ferret's own and the daemon log says so in one sentence.

### 3.2 The owner's default homes: read, never written

- `~/.claude` (or `CLAUDE_CONFIG_DIR`) and `~/.codex` (or `CODEX_HOME`) are indexed in place through the existing
  read-only `harness-history` root. Ferretry never writes, links or locks anything there.
- The copy is the **harness plugin's own act** (`Harness.importConversation`, asked through `FerretsApi.importConversation`,
  Conversation's alone): the harness reads the owner's history through its read-only `harness-history` root and writes only
  its own pool, header-checked for Codex, never overwriting a name the pool holds, refused above 256 MB. Conversation no
  longer writes an `imports` copy at all. `LinkService.keep` always copies a conversation of the owner's computer first.
- Linking one of them **copies** its transcript into the pool at the same relative path (`projects/<slug>/<id>.jsonl`;
  Codex `sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`) and the ferret resumes the copy. Copy cost is one file (p50 0.5 MB,
  p99 12 MB) through `copy_file_range`. The original keeps working in the owner's own terminal; the two continue
  separately (a fork), so there are never two writers on one file. The listing shows the pooled copy and says the
  original is also in the owner's own history.
- **Not in this design (needs the owner):** making the owner's own `claude` / `codex` see the pool (two-way) would mean
  replacing `~/.claude/projects` or `~/.codex/sessions` with a link — a write to the owner's folders. Parked as an
  opt-in for a ruling; nothing here does it.

### 3.3 The index (the "FAST")

- Conversation owns one `sqlite-cache` state file, `conversation-index.sqlite` (dropped and rebuilt on mismatch, so it
  grants nothing). One row per (harness, conversation id, source): `source` (`pool` | `computer`), relative path,
  size, mtime, bytes scanned, a hash of the first 4 KiB, folder, name, first prompt, latest prompt, first/last activity,
  turns (+ `turnsAtLeast`), model, and a lowercase `hay` column for search.
- **Incremental update**, in a worker thread (the kernel's worker `sqlite` seam): walk the sources with `stat` only
  (≈250 ms for 13k files); a file whose size and mtime are unchanged is skipped; one that grew with the same first-4-KiB
  hash is read only from `bytes scanned` to its end (append-only transcripts); a new or rewritten file is read head
  256 KiB + tail 1 MiB, never whole (cold build reads ≈6.6 GB of the 15.5 GB Claude pool, once, paced, in the
  background; 6,379 of 9,397 files fit whole). A file that disappears drops its row.
- **When:** at boot (background warm-up), and before a listing when the last refresh is older than 5 s. A listing never
  waits on a cold build: it answers from what is indexed and says the rest is still being read.
- **Query:** `WHERE last_at >= ?since AND instr(hay, ?word) …  ORDER BY last_at DESC LIMIT ?` — 2.8 ms for 15k rows.
  Same matcher semantics as today (every word, substring, in name / first / latest / folder).
- `LinkService.list / preview / history / keep` read rows from the index; `preview` still reads the one file fresh.
  The harness plugins' `ConversationFinder.list` (which re-reads every file's head per listing) is replaced by the
  index as the listing source.
- Targets: `fy link <words> --since 7d` warm **< 300 ms** end to end (index query < 10 ms), cold-after-boot answers
  immediately with partial results, full build < 60 s in the background.

### 3.4 Safety with the lease store

- Every pooled write is a harness process the daemon started (claims the lease on start, resume, fork) or a wrapper
  that ran `fy history claim` — unchanged from c58-36. The pool makes the lease protect what it was built for.
- Copy-on-link means the owner's own un-wrapped `claude` / `codex` never shares a file with a ferret.
- The index is read-only on transcripts (no write method on the port, as today).

## 4. Build plan (PRs into `rebuild/5.0-after`)

1. **Index** (Conversation): `conversation-index.sqlite`, the worker updater, sources = pool (when present) + every
   ferret home + the owner's default homes, `LinkService` on the index. Delivers the speed alone, and lists every
   ferret's conversations even before pooling.
2. **Kernel door**: `permissions.historyPool` + `RootHandle.linkHistory`, testing host twin, `docs/secrets.md` row.
3. **Pooling** (Claude Code + Codex + migrator): link entries at home preparation, move existing folders in,
   `CODEX_SQLITE_HOME`, `hasConversation` through the pool, migrator target, copy-on-link for default-home
   conversations; ports-pending line removed.

Each PR: Sonnet builder, one gpt-6.1-sol high review, at most 2 fix rounds.

## 5. Open points

- Two-way default-home sharing (3.2) needs an owner ruling.
- The migrator copies 19 GB; a hard-link or rename import would be faster and use no extra disk. Separate card.
- **Proven (PR 3, 2026-11-16, codex-cli 0.166.0):** `codex exec resume <id>` with a temp `CODEX_HOME` holding only a COPY of
  an owner's rollout and a fresh `CODEX_SQLITE_HOME` that had never seen it starts that session (`session id: <id>`); an
  invented id answers `no rollout found for thread id`. So the copy inserts nothing into SQLite and none is needed. Claude Code
  2.1.317: `claude --resume <id>` in a temp `CLAUDE_CONFIG_DIR` holding only a copy of `projects/<folder>/<id>.jsonl` resumes it
  (the unknown id answers `No conversation found with session ID`).
- `fy link` / keep is still not connected to a ferret start in 5.0 (`packages/plugins/conversation/daemon/reading.ts`
  `KEEP_PENDING`, card &F3447): the copy seam is built and tested end to end below that line, and starts working the moment keep is wired.
- macOS pooling needs a descriptor-relative `symlinkat` in `FolderSteps` (PR 2 refuses `no_descriptor_reach` there).
