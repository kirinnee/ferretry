# Project file index

A project's **file index** is a list of the file names inside a registered project folder that Git does not ignore. It is
found once on the daemon, kept in memory and **searched on the daemon**, so a phone over a relay is sent the top matches
and never the list. This page is the contract for what it lists, what it leaves out, how big it can get, when it
refreshes, who may read it, and what it cannot promise. The code is `packages/plugins/projects/daemon/features/files/`;
the wire shapes are `packages/plugins/projects/contract/files.ts`. Where this page and the code differ, fix the page.

**Names only.** An entry is a relative path and a file name. No contents, no hashes, no sizes, no times, no file types.
No route here returns file content; opening a file goes through the ferret file routes, which check it again.

## Who may read it, and where

Three routes, all `filesystem.use`, `caller: person`, `noStore`, guard `secrets`, audit skipped (see
[grants.md](grants.md)):

| Route                                                    | Does                                                                                    |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET /v1/projects/:id/files?q=<text>&limit=<1..200, 50>` | The best matches, `total` matched, `rebuilding`, and the `index` summary                |
| `GET /v1/projects/:id/files/status`                      | The summary alone, for a badge; never waits for a build                                 |
| `POST /v1/projects/:id/files/rescan`                     | Starts a rebuild (or joins the one running) and answers at once with `rebuilding: true` |

`q` is validated like every file search and matched as a case-folded substring over the name and the path; a name that
contains the text ranks above a path that only does, and within a rank the order is shallow first. No `q` lists the top of
the index. An unknown parameter is `400 unknown_parameter`; a bad `limit` is `400 invalid_limit`.

**A project folder outside the owner's home needs `filesystem.configure`** (owner decision D3), on top of
`filesystem.use`. A remote device needs the passkey step-up that registering a project already needs; the owner's `fy`
over loopback is ungoverned. The gate is asked ONCE per request and is decided twice over: on the registered spelling and
on where the folder really resolves, so a spelling under the home that is a link out of it is outside. **Admission comes
first**: nothing is listed, scanned or read from the file-index cache, and no build starts, until the gate has passed.
(For a spelling inside the home the daemon resolves the canonical path first, to ask the second question; that is a
look at where the folder is, not a read of it.) The home itself counts as inside, so a **use-only device can read an
index registered at the home folder**; a project at `/` or `/home` is outside, and registering it does **not** open the
file routes to a use-only device. What a refused caller sees depends on the route:

- **The three file routes** answer the gate's refusal (`403`, step-up or grant) and nothing else: no names, no partial
  index (`files/routes.ts`, `admit`).
- **The repository scan** (`GET /v1/projects/:id/repos`) answers `200` with the repositories already **saved** on the
  project and `truncated: true`, and scans nothing. Only the gate's own `403` becomes that answer; `503
folder_gate_unavailable` stays an error (`repos/routes.ts`).
- **The folder picker** (`GET /v1/projects/folders?path=/…`) answers the gate's refusal and lists nothing.

Reading below the home stays `filesystem.use`.

A registered folder that now resolves somewhere else than it was registered (a link was repointed) is no longer the
project: what was indexed is forgotten and the answer is `404 project_folder_unavailable`.

| Answer                           | Means                                                                               |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| `403 project_folder_private`     | The project folder is a key store or a secret-named folder, or holds a sign-in file |
| `404 project_folder_unavailable` | Nothing verified is there, it is in a skipped tree, or it moved                     |
| `403` step-up / grant refusal    | Outside the home without `filesystem.configure` (the refusal names the demand)      |
| `503 folder_gate_unavailable`    | The daemon could not decide the gate; nothing outside the home is read on a guess   |
| `503 index_busy`                 | Every project held in memory is building; try again shortly                         |

## What is listed

**Inside a Git repository, Git's list is taken whole, at any depth** (owner decision D1). One
`git ls-files -z --cached --others --exclude-standard` per repository, so Git's own rules decide: nested `.gitignore`,
`.git/info/exclude` and the owner's global ignore file. Depth does not cut it: on this repository 58% of the tracked
files are more than five folders deep. Ferretry does not re-implement `.gitignore`; a file ignored only by `.ignore` or
`.rgignore` (ripgrep's files) **is** listed.

**Outside a repository the walk is ours and is five folders deep** (the project folder is 0). It looks for repositories
and plain files, breadth first, skipping hidden folders and the noisy roots the ferret file index also skips
(`node_modules`, `dist`, `build`, `target`, `vendor`, `.venv`, …). A folder holding a `.git` **folder** is a repository
and is indexed whole. A repository more than five folders down is not entered and is counted `excluded`.

**Nested repositories** (Git prints `dir/` and does not enter one) each get their own `ls-files`, all under the one
project cap and the one candidate budget.

**Nested linked worktrees and submodule checkouts are not indexed** (owner decision D4). A checkout **inside** the project
folder keeps a `.git` **file**; one repository's thirty worktrees would be thirty copies of the same files (on this
checkout: 1,027,574 names with them, 14,002 without). Each is counted `excluded` and named in `nestedWorktrees` (at most
50 names; the count past that is still in `skipped`). The rule is for nested checkouts only: **a project folder that Git
itself recognises as a linked worktree is the project and is indexed** (`files/build.ts`, the root's own
`isInsideWorkTree`). The named list holds what Git prints as `dir/` and the pinned walk finds with a `.git` file. A
**tracked submodule** is a gitlink that Git lists **without** a trailing slash, so it never reaches that path: it is
counted `unsupported`, its contents are skipped, and its name is **absent** from `nestedWorktrees`.

**Global ignore rules come from Git itself.** Git reads the owner's own `HOME` and `XDG_CONFIG_HOME`; no
`-c core.excludesFile` is passed, because that would outrank a repository's own setting. Before each list the daemon asks
whether the owner's global config could be READ; if it could not (a permission error, a bad line, an unreadable include)
the repository is counted `unreadable` rather than listed without a rule the owner wrote. A repository Git will not read
(unsafe ownership, a broken repository) is `unreadable` too, and **the daemon never falls back to a plain walk of it**,
which would list what `.gitignore` hides.

**Every name passes the one secret-name list** (`@ferretry/std` `secret-names.ts`, shared with the folder picker and the
ferret file reader): `.env*`, `*.pem`, `*.key`, `id_*`, `.netrc`, `.npmrc`, sign-in files such as `auth.json` and
`hosts.yml`, and anything under a key store folder. Matches are dropped and counted `denied`.

## What is not read: the skip list

**Shared path rules.** One policy judges the **real** path (links resolved) for the picker, the repository scan and the
index alike (`daemon/features/folders/fence.ts`, `policy.ts`). These rows are the same for all three readers:

| Skipped                                                                                               | Counted as / answered as |
| ----------------------------------------------------------------------------------------------------- | ------------------------ |
| Ferretry's own home (`~/.ferretry`: secrets, tokens), refused by the kernel's `imports` root          | refused                  |
| The owner's private folders (`.ssh`, `.gnupg`, `.aws`, `.kube`, `.config/gh`, …), also through a link | private (`denied`)       |
| A folder holding a sign-in file (`id_rsa`, `auth.json`, `hosts.yml`, …), anywhere on disk             | private (`denied`)       |
| Another user's home: `/home/*`, `/Users/*`, `/root`, `/var/root` (not the owner's own)                | private                  |
| macOS `~/Library` (Mail, Messages, Keychains, browser profiles), by name, on every platform           | private                  |
| `/proc`, `/sys`, `/dev`, `/run`, `/var/run`, `/nix/store`, `/System`, `/private/var`                  | refused                  |

**Per reader.** The rules below are not shared: each belongs to the reader named, and a reader that is not named does
not apply it.

| Rule                                                                                | Folder picker                                                                                                                            | Repository scan                                                                                                                                                         | File index                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Another disk** than the project folder (a different `st_dev`), like `find -xdev`  | No such rule                                                                                                                             | A child on another device is not entered; the answer is `truncated`                                                                                                     | A folder below the project on another device is not entered, none of its contents are indexed, and it is counted `excluded`. The device is compared **after** the sign-in look, so that bounded look (known markers by name, then a bounded listing of names) may open and list a mounted folder first                                                                                       |
| **A link**                                                                          | A listing never shows one. A path someone **types** that is a link is resolved, and its real target is judged by the gate and the policy | A project folder that is itself a link scans nothing; a link below it is never listed or entered, at any depth                                                          | The walk outside a repository counts a link `unsupported` at any depth and never follows it                                                                                                                                                                                                                                                                                                  |
| **A folder whose sign-in look saw only part of its names** (too wide to prove safe) | The folder, or an ancestor, is refused: `403 folder_too_large`; nothing is listed                                                        | The project folder or an ancestor: the scan saw nothing, the saved repositories are kept and the answer is `truncated`. A child: skipped, and the answer is `truncated` | A **descendant** is not entered: counted `truncated`, so the index is partial. A **nested repository** is judged as a descendant first (`files/build.ts` `indexNested`, `Judge.dir`), so a wide one is skipped and counted `truncated`. Only the **registered root** uses the verdict **without** the completeness flag, so the same wide repository registered as the root can return names |

**Anchors are not looked at.** The sign-in look starts below an anchor: the owner's home for a path inside it, `/` for a
path outside it (`folders/policy.ts`). The anchors `/` and the home are never inspected for sign-in markers; their
descendants are, one folder at a time.

Registering a **broad root** (`/`, the home, `/home`, `/Users`) is allowed and the app warns first ("This is your whole disk or
home folder — the index will be partial"). The caps below keep it finite.

## The cap, and what "partial" means

| Bound                                      | Value      |
| ------------------------------------------ | ---------- |
| Files kept per project (owner decision D2) | **50,000** |
| Candidate names looked at, whole project   | 100,000    |
| Folders opened (non-repository walk)       | 4,000      |
| Walk depth below the project folder        | 5          |
| Names read per folder (walk)               | 5,000      |
| Git output per repository                  | 8 MiB      |
| Scan budget per build                      | 15 s       |

The 15 s is a **scan budget**, not a hard stop on the work: when it runs out the build answers what it has and counts the
rest `truncated`, but a read already in flight at that moment may still be running, and **it keeps the build's slot until
it ends** (`files/build.ts` `holdSlot`, `files/cache.ts`). Time spent queued for a slot is not part of it.

The ferret file index keeps its own, smaller bounds (20,000 files). **At the cap the order is shallow first, then
byte order by path**, so `README.md` is kept before `a/very/deep/file`. What is cut is counted as `truncated`.

The summary says what the build could and could not see:

- `coverage`: `complete` or `partial`. It is **partial exactly when** some skip was `unreadable` or `truncated`
  (a bound bit, a repository could not be read, the time ran out). `denied`, `excluded` and `unsupported` alone leave it
  `complete`: those are decisions, not blind spots. The schema refuses any other combination.
- `skipped`: `{reason, count}` for `denied`, `excluded`, `unsupported`, `unreadable`, `truncated`.
- `indexed`: files held. `biggestFolders`: the five top-level folders holding the most, so the app can say WHERE a cap
  bit. `nestedWorktrees`, `builtAt`.

**A partial index must never be shown as "no results" or as a complete count.** The same rule the ferret file index
follows.

## When it refreshes

There is **no file watcher in 5.0** (owner decision D5): on Linux inotify costs one watch per folder from a per-user
budget every editor shares. Instead:

1. **First read builds and waits.** After that, reads answer from memory. `status` and `rescan` never wait.
2. **Stale while revalidate.** The 30 s is a **threshold for the next read**: a read that arrives when the index was last
   checked more than 30 s ago answers the old one at once and starts a rebuild; the answer carries `rebuilding: true`.
   Nothing rebuilds by itself on a timer, so 30 s does **not** bound how old the returned names are: with no read, the
   index stays as it was, and a rebuild that queues for a slot or fails extends it. A failed rebuild keeps the old index
   and is not retried until a read comes after the next 30 s.
3. **A ferret that stops working in the project marks it out of date.** On `ferrets.changed`, when a ferret's state is
   `idle` (its turn ended) or `stopped`, every project whose folder holds the ferret's folder is marked. The match is on
   where the ferret's folder REALLY is: a ferret in a linked worktree under the project counts; a link that merely sits
   inside the project but points elsewhere does not. A burst of turn ends is one rebuild.
4. **The project is registered again, or its repository list changes:** marked out of date. **Removed:** forgotten at once.
5. **Rescan** (the button) starts a rebuild now.

One build per project runs at a time and a second request joins it. At most **2 builds run at once** across projects
and the rest queue; at most **16 projects** are held, and if all are building another gets `503 index_busy`. Marking a
project that is not held does nothing (a quiet project is never kept in memory by a ferret's activity). A rebuild the
privacy policy now refuses **discards** the old index; one that merely failed keeps it.

**Memory only.** The index is not written to `state/`: a list of every file name on disk is one more place names could
leak from (backups, copies), and a rebuild of a 14,000-file project is well under a second.

## The app (written from the plan; U7 is still being built)

The project page's Files section becomes a finder: a search box, the top matches (file name and folder), and a banner when
coverage is partial: how many files were kept, the biggest top-level folders, what was skipped (nested worktrees, secret-looking
names), a **Rescan** button, and a tip to add large generated folders to `.gitignore`. The command bar gets **Go to file**
for the current project. It calls the routes above and keeps nothing; nothing in the app changes what is indexed.

## Declared GAPs

- **G1 Names are data.** A file called `prod-db-password-hunter2.txt` is listed. Only pattern-matched names are dropped.
- **G2 A use-only device reads names across a broad root registered at the home folder** (`~`). That is the feature; the
  warning before registering, and `filesystem.configure` on registering, are the only mitigations. A root **outside** the
  home (`/`, `/home`) is not this gap: the file routes refuse a use-only device at the outside-home gate.
- **G3 A snapshot, not live.** There is no timer: an index is refreshed only by a read after 30 s, a ferret's turn end, a
  re-registration or Rescan, so a returned name can be older than 30 s plus one build, and longer while a rebuild queues
  or fails; a deleted file can show until the rebuild.
  Opening it then goes through the ferret file routes, which re-check.
- **G4 Same race as the folder explorer.** A local process racing renames can move a folder between a check and its
  read. It already has the disk; nothing is added for it.
- **G5 Only Git's ignore rules.** `.ignore` and `.rgignore` are not honoured.
- **G6 Other users' repositories** answer `unreadable` (Git's `safe.directory`) rather than being indexed.
- **G7 Windows** is not considered; there is no Windows daemon.
- **G8 A name inside the home that links to a folder outside it** answers the outside-home gate's refusal where a missing
  name answers `folder_refused`, so a use-only device can learn that such a link exists by guessing its name (a link is
  never listed). Stated in `folders/browse.ts`.
- **G9 No sizes or times.** The kernel's file probe says "a regular file", not how big or how new, so none are stored;
  sorting by recency is not available.
- **G10 Full-text search is out of scope.** This is names; contents stay behind the ferret file route and its masking.
- **G11 Overlapping repository scans can miss an invalidation.** `GET /v1/projects/:id/repos` compares its result with the
  repository list as it stood when that scan began, and marks the file index out of date only if the two differ. Two scans
  of one project running at the same time can interleave: the newer scan sees a repository added and marks the index out
  of date; the older scan, which began on the earlier list and never saw it, then writes its own result, restoring the
  earlier list, and finds it equal to its own snapshot, so the second change (the removal) is never marked
  (`repos/routes.ts`, `registry.recordRepos`). The index then heals at the next trigger: a ferret's turn end in the
  project, a re-registration, Rescan, or the next read after the 30 s threshold, which starts a rebuild. Accepted at U6
  (F6061): it needs two concurrent scans.
