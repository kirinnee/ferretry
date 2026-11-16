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
  - **macOS:** the held-folder steps have no `symlinkat` yet, so a host with no `/proc/self/fd` refuses
    `no_descriptor_reach`. PR 3 pools on Linux; macOS pooling needs a `symlinkat` step in `FolderSteps` first (open point 4).
- **Existing homes.** A home whose entry is already a real folder (a 5.0 ferret that ran before this) has its files
  moved into the pool by rename (same device); a name already in the pool is kept as
  `history-pool/.conflicts/<ferret>/…` and named in the result, never overwritten. Then the link is made.
- **Migration.** The v4→5.0 migrator writes the v4 pool to `state/<harness>/history-pool/` instead of
  `agent-homes/_shared`, so converted ferrets resume their real conversations (fixes !A516).
- `hasConversation` looks through the pool (one `projects/*/<id>.jsonl` lookup), so a pooled resume is never refused.

### 3.2 The owner's default homes: read, never written

- `~/.claude` (or `CLAUDE_CONFIG_DIR`) and `~/.codex` (or `CODEX_HOME`) are indexed in place through the existing
  read-only `harness-history` root. Ferretry never writes, links or locks anything there.
- Linking one of them **copies** its transcript into the pool at the same relative path (`projects/<slug>/<id>.jsonl`;
  Codex `sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`) and the ferret resumes the copy. Copy cost is one file (p50 0.5 MB,
  p99 12 MB) through `copy_file_range`. The original keeps working in the owner's own terminal; the two continue
  separately (a fork), so there are never two writers on one file. The listing shows the pooled copy and says the
  original is also in the owner's own history.
- **Not in this design (needs the owner):** making the owner's own `claude` / `codex` see the pool (two-way) would mean
  replacing `~/.claude/projects` or `~/.codex/sessions` with a link — a write to the owner's folders. Parked as an
  opt-in for a ruling; nothing here does it.

### 3.3 The index (the "FAST") — built in PR 1 (&F4336)

- Conversation owns one `sqlite-cache` state file, `conversation-index.sqlite` (dropped and rebuilt on a layout mismatch, so
  it grants nothing). One row per (harness, source kind, source label, relative path), i.e. per transcript file: `kind`
  (`computer` | `ferret-home` | `pool`), the file's size, mtime, `bytes scanned` and a hash of its first 4 KiB, the
  conversation id, folder, `file_title` (the transcript's own title) and `index_title` (Codex's `session_index.jsonl` name) with
  the `title` that wins, `ferret_id` and `ferret_name`, first prompt, latest prompt, first/last activity, turns
  (+ `turns_at_least`), model, a lowercase `hay` column for search, and a settled `win` flag (the newest copy of a
  conversation held in several places). A transcript that describes no conversation is kept as an `ok = 0` row, so an
  unchanged one is never read again; those rows are the listing's `skipped` count.
- **Where the sources come from** (the plugin boundary): the harness plugin owns where its CLI keeps history, Conversation owns
  what a listing says about it. Each harness's additive `Harness.historySources()` (`core/ferrets/contract/history.ts`) hands
  over read-only trees (`HarnessHistoryFiles`: `entries`, `stat`, ranged `read`; no write of any kind) — the owner's own
  home through its existing `harness-history` root, and each ferret home through its own `agent-homes` root, a link never
  followed — and Conversation reaches them through `FerretsApi.historySources()`. Conversation touches no other plugin's
  state. The **pool** is a third kind the seam already carries; the harness plugins offer it when PR 3 creates
  `state/<harness>/history-pool/` (until then there is nothing to offer, which reads as empty).
- **Incremental update.** Every tree is walked with directory listings alone (a listing already carries size and mtime, so no
  file is opened to find out it is unchanged). A file with the same size and mtime is skipped; one that grew with the same
  first-4-KiB hash is read only from `bytes scanned` to its end (at most 4 MiB, else re-read) and its new records are folded
  into latest prompt, last activity, turns and model — unless they carry a title record, which re-reads the file because the
  name rules need the whole conversation; a new or rewritten file is read **head 256 KiB + tail** (never whole, `turnsAtLeast`
  when the middle was skipped). The tail is read in two steps for Claude — 256 KiB, widened to 1 MiB only when the narrow tail
  holds no message the owner said — and at 1 MiB at once for Codex, whose rollouts rarely do. A head that parses to no owner
  message at all (a first record carrying a large paste) is looked at once more over its first 4 MiB. A vanished file drops its
  row; a vanished source drops its rows (only for a harness that answered at all). The files are described by the **existing**
  rules (`describeConversation`: `spokenMessages`, `transcriptNames`, the wrapper-title rule), so a row says what a listing
  always said.
- **Paced on the main thread, not in a worker.** The worker seam grants a worker only the plugin's own roots, and the trees come
  from other plugins' roots through the seam above, so a worker could not read them; the files are read on the main thread
  (async, eight at a time) and each is parsed in one go (a read is at most ~1.25 MiB) with the loop handed back after every file.
  A worker that is handed the bytes and returns the row is the next step if a cold build must be faster (below).
- **When:** a background build two seconds after the daemon starts, and before a listing when the last refresh is older than
  5 s. A listing of a built index waits for that refresh at most 250 ms (then it answers with what it has and says so); a listing never waits on a first build: it answers from
  what is indexed (newest transcripts are read first) and sets `indexing: true`, which `fy link` prints as one line.
- **Query:** `WHERE ok = 1 AND win = 1 AND last_at >= ?since AND instr(hay, ?word) > 0 … ORDER BY last_at DESC LIMIT ?` — the
  same matcher as ever (every word, as a substring, case-insensitively), over the ferret's name, the title, the first and latest
  message and the folder. Asked for some kinds only (`source=computer`, `source=ferretry`), the newest copy among those kinds is
  compared in the query.
- **Names (owner requirement).** A conversation's `name` is, in order: the **ferret's name** when a ferret runs or ran it (read from
  Ferrets' registry, `FerretSummary.harnessConversation`, never its files, re-applied on every update so a rename shows on the
  next listing), then the conversation's own **title** (Claude `custom-title` / generated summary, Codex thread name), then the
  first prompt cut to 60 characters. Both ferret name and title are stored separately (`ferretName`, `title`, `ferret` on the
  wire) and both are searched; when they differ `name` reads `<ferret name> — <title>`.
- `LinkService.list / preview / history / keep` read the index. `preview` and a history entry still read the one file fresh
  (ranged reads, head 4 MiB + tail 4 MiB as before). The harness plugins' `ConversationFinder.list` is no longer a listing source.
  `alsoOnComputer` marks a Ferretry copy whose conversation is also in the owner's own history.
- Targets (`fy link <words> --since 7d`): query < 10 ms, warm refresh < 500 ms, warm `fy link` < 300 ms, full cold build < 60 s in
  the background. The measured numbers are in the PR body (&F4336).

### 3.4 Safety with the lease store

- Every pooled write is a harness process the daemon started (claims the lease on start, resume, fork) or a wrapper
  that ran `fy history claim` — unchanged from c58-36. The pool makes the lease protect what it was built for.
- Copy-on-link means the owner's own un-wrapped `claude` / `codex` never shares a file with a ferret.
- The index is read-only on transcripts (no write method on the port, as today).

## 4. Build plan (PRs into `rebuild/5.0-after`)

1. **Index** (Conversation): `conversation-index.sqlite`, the paced updater, sources = every ferret home + the owner's default
   homes (+ the pool once PR 3 offers it) through `Harness.historySources`, `LinkService` on the index. Delivers the speed alone,
   and lists every ferret's conversations even before pooling. (Built: &F4336.)
2. **Kernel door**: `permissions.historyPool` + `RootHandle.linkHistory`, testing host twin, `docs/secrets.md` row.
3. **Pooling** (Claude Code + Codex + migrator): link entries at home preparation, move existing folders in,
   `CODEX_SQLITE_HOME`, `hasConversation` through the pool, migrator target, copy-on-link for default-home
   conversations; ports-pending line removed.

Each PR: Sonnet builder, one gpt-6.1-sol high review, at most 2 fix rounds.

## 5. Open points

- Two-way default-home sharing (3.2): owner ruled ONE WAY (!A530, 2026-11-16). Ferretry never writes into `~/.claude` or `~/.codex`; no two-way PR.
- The migrator copies 19 GB; a hard-link or rename import would be faster and use no extra disk. Separate card.
- Codex `resume <id>` of a copied rollout that its SQLite does not list yet must be proven against the real binary in
  PR 3 (pooled SQLite should index it; if not, the copy also inserts nothing and the PR says so).
- macOS pooling needs a descriptor-relative `symlinkat` in `FolderSteps` (PR 2 refuses `no_descriptor_reach` there).
