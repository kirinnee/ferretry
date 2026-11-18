# One real Claude on a sweep slot (`slot.ts real-claude`)

The sweep slots run **fake** `claude` / `codex` programs: no real model is ever called. This verb is the one exception. It lets
**one** ferret on a **persisted** slot's 5.0 side talk to the real Claude, through **one** sign-in the owner does on the 5.0 Logins
screen. Every other caller on that slot keeps the fake.

```
bun slot.ts real-claude <1..9> on <login> [--binary <abs path>]
bun slot.ts real-claude <1..9> off [--force]
bun slot.ts status <1..9>            # prints "real claude: on for login … (<binary>)" or "off"
```

## What it does

- `on` replaces `<slot>/v5/harness-bin/claude` with a small shell dispatcher and keeps the old fake as `claude.fake`.
  - The shim runs the **real** claude only when `CLAUDE_SECURESTORAGE_CONFIG_DIR` is **exactly**
    `<FY_HOME>/state/logins/credentials/<login>` (a plain string match; no link is followed).
  - In every other case it runs `claude.fake`. A `store: host` login passes `""`, so it always gets the fake.
  - `--version` / `-v` always go to the real binary (5.0 picks launch settings by the probed version).
  - The real binary gets `DISABLE_AUTOUPDATER=1`. It is an absolute path resolved **once**, at `on` (the first `claude` on your
    PATH outside the sweep folders, or `--binary`). It is never looked up on PATH again, so the shim cannot call itself.
  - A nix store binary is rooted (`<slot folder>/gcroots`) so a GC cannot remove it. Re-run `on` after a claude update to re-point.
- `on` **never reads inside the login's store**. It checks that `config/logins/<login>.yaml` says `harness: claude-code` and
  `store: ferretry`, that `state/logins/credentials/<login>` is a real folder **if it exists** (a link or a file is refused), and makes an existing folder
  mode `0700`. A login you have only added has no folder yet: 5.0 creates it (mode `0700`) at **Sign in**, so `on` leaves it for that.
- `on` refuses: a missing login, a login that is not `claude-code` + `ferretry`, a link as the store, a second real login (one at a
  time), a slot that is not persisted. A refusal changes nothing. It stops and restarts **no** daemon.
- The record `<slot>/v5/real-claude.json` holds names and paths only: `{ login, store, binary, rootedAt }`.
- `up` refuses while that record exists: a rebuild would copy the fakes over the shim and reconvert the home, which deletes the
  login. `upgrade-v5` keeps the shim and the login (it replaces only `fy` / `fyd` / `fyd-browser-worker` / `BUILD.json`) and prints the
  `real claude:` line afterwards, so a 5.0 build that changes how claude is found gets noticed.
- `off` puts the fake back exactly (one rename), removes the record and the GC root link. It **never deletes the login or its
  store**. It refuses while `fy ps --json` shows a ferret on a runtime that uses the login (names only; `--force` skips that).

## Owner steps (about 5 minutes)

Do these on the paired 5.0 app (the `fy5` preview).

1. **Settings › Machines › this machine › Logins › Add login** › Claude Code, **Ferretry-managed**, named `claude-real`.
   Do **not** press **Sign in** yet.
2. Tell the agent. It runs `bun slot.ts real-claude 8 on claude-real`.
3. Press **Sign in** on `claude-real`. Open the link it shows in your own browser, sign in to claude.ai, copy the code the page
   shows, and paste it into the 5.0 screen. Only you type that code; the daemon passes it to Claude's own sign-in and Claude
   writes its credential inside the slot (`<slot>/v5/home/state/logins/credentials/claude-real/`). Nothing is written to
   `~/.claude*`, `~/.ferretry*` or `~/.codex*`.
4. **Add runtime** `claude-real-agent` (login `claude-real`, profile `claude-default`), then start **one** ferret on it.
5. In slot 8's `config/harness-claude-code.yaml` set **`permissionMode: auto`** (default for this runtime note). It tightens the
   permissions, so it needs no approval from you.

## Know before you use it

- The real agent runs as your user. Its shell can read your real files. The isolation controls only **where the credential is
  stored**; it is not a sandbox. Give the ferret a work folder inside the slot, and keep `permissionMode: auto`.
- It spends your real Claude quota. Use one ferret.
- Real claude is a newer version than the sign-in flow's documented output. If the sign-in stops recognising the link or the code
  prompt, it ends with "did not offer a sign-in that can be driven from a browser": visible, not silent.
- If a future 5.0 build starts resolving `claude` for sign-in from `harness-claude-code.yaml`, the shim is skipped for sign-in.
  `status` / `upgrade-v5` show the shim state. If 5.0 passes a different spelling of the store path, the shim falls back to the fake:
  safe (no real model), shown as "not signed in".

## Undo

1. Stop the ferret(s) on `claude-real-agent`.
2. `bun slot.ts real-claude 8 off`. The daemon keeps running.
3. Owner: Logins › `claude-real` › Sign out / Remove (deletes the store), remove the runtime. Optional: revoke the session at
   claude.ai › Settings.

## Tests

`migration/v4-to-v5/tests/unit/sweep-real-claude.test.ts` runs the shim in a real `sh` against a **stub** "real" binary and drives
`on` / `off` on a scratch folder. No real claude, no login and no network is ever used.

# Start from scratch: an EMPTY 5.0 home (`reset-v5` / `restore-v5`)

For an owner who wants to re-pair and start with nothing: no fixture ferrets, conversations, logins, runtimes, profiles, projects,
agenda, board or devices. **Persisted slots only.** The v4 side is never read or written.

```
bun slot.ts reset-v5 <1..9> --empty <libexec-dir> [--keep-real-claude]
bun slot.ts restore-v5 <1..9> <stamp>
```

## `reset-v5`

1. **Refuses first** (nothing is stopped): not persisted; the home does not pin this slot's port; a unit that is not this slot's; the
   build is not stamped or its Pages deploy is not live (the same gate as `upgrade-v5`); **real claude is on and `--keep-real-claude` was not given**.
2. Stops **only** the 5.0 daemon, the 5.0 tmux server (its socket lives inside the home that goes away) and the headless Chrome of the 5.0
   browser profile. v4 keeps running.
3. Puts the given 5.0 programs in place (old ones kept as `<name>.prev`; nothing if the slot already runs that build). Before **each**
   remove, rename and create, `v5/bin` is checked again to be a real folder (no link) that resolves under this slot's own real path; a program
   name that is a link or a folder is refused, and the new file is created exclusively (never through a link).
4. **Moves** the old 5.0 home **and** the daemon's own HOME folder (`v5/user`) into `<slot folder>/kept/<UTC stamp>/` with plain renames: a folder
   this run makes (`0700`), inside the slot's real path. Each source is looked at right before its rename and the moved folder right after (same
   inode, a real folder); a source that was swapped for something else is moved straight back. **Nothing is copied, packed, hashed or deleted**:
   no tar, no `rm` of anything the owner made. A small `provenance.json` (`0600`: slot number, slot realpath, stamp, inode/device of each
   moved folder) is written beside them for `restore-v5` to check.
5. Makes a **first-run** home: an **empty folder** (`0700`). The kit seeds **nothing**: no `config/daemon.json`, no gate, no daemon name, no relay or
   WebRTC key, no limits file, no setup run. (A 5.0 daemon refuses a home that holds any file but has no `home.json`, so nothing could be
   seeded before the first boot anyway.) The daemon's own first boot makes its **new identity** and everything else, exactly as on a brand-new
   install; the hosted relay discovery applies as for any fresh daemon. The port (7601+2N) is on the daemon's command line in the unit.
   **Limits are therefore ON** (the daemon default), unlike a `up` home: a ferret started in this slot joins the owner's real fleet slice.
6. Starts the 5.0 tmux server and daemon, waits for `/healthz`, then reads the port pin from the home the daemon made. If the daemon recorded the
   slot's bind port itself the kit writes nothing; if not, the kit writes ONLY the bind pin into `config/daemon.json`, after the first boot (every
   wrapper refuses a home that does not pin its slot's port). That write is checked first (the home, its `config` folder and `daemon.json` are real
   folders / a plain file under this slot, never a link), goes to a temp file in that folder, and is renamed over `daemon.json`; the folders are looked
   at again right before the rename. Prints `status`. **It never prints a pairing code and never pairs.**

**Kept:** the unit files, the wrappers, `cli-names.json` (the CLI name the daemon prints), the fake harness, the v4 side.
**Moved aside (never deleted):** everything in the 5.0 home and `v5/user`, into `kept/<stamp>/`. If the new home cannot be made, `kept/<stamp>` stays whole
and `restore-v5 <stamp>` puts it back (it needs no current home).

## `--keep-real-claude`

With real claude on, `reset-v5` refuses without this flag (the old login and its sign-in are in the home that goes away). With it, the
dispatcher is written again for the **same login name**, pointed at the **new** home's store path (`<FY_HOME>/state/logins/credentials/<login>`;
the same string, because the new home lives where the old one did) and `real-claude.json` is updated. The store is **missing until the owner
adds the login again and signs in**; until then the shim sends everything to the fake. `harness-claude-code.yaml` (`permissionMode: auto`)
is empty again too: set it again before starting a real ferret.

## `restore-v5`

`restore-v5 <N> <stamp>` puts a kept home back, by rename only. `<stamp>` names a folder in this slot's `kept/` that this slot's own reset or restore moved:
it must be a real folder with a `0600` `provenance.json` that names THIS slot (number and realpath) and this stamp, holds exactly the moved folders
(`home`, optionally `user`) and nothing else, and each of them must still be the very folder that was moved (same inode and device, real folder, no link).
A copy made by another slot, a hand-made folder, or a folder replaced by a link is refused before anything is stopped. Then: stop the 5.0 side, move
the CURRENT home and `user` (if there are any: none is fine) into `kept/<new stamp>/`, move the kept folders into `v5/`, start. Both `reset-v5` and
`restore-v5` also refuse, before anything is stopped, when the slot folder, `v5`, `v5/home`, `v5/user`, `v5/bin`, `v5/harness-bin`, `home/config`
or `kept` is a link or resolves anywhere but under this slot's own real path, or `config/daemon.json` is a link. By hand, the same thing is: stop
`fy5-slot<N>` and `fy5-slot<N>-terminals`, `mv v5/home v5/user` into a new `kept/<stamp>`, `mv` the kept ones back, start both.

Tests: `migration/v4-to-v5/tests/unit/sweep-reset.test.ts` (scratch folders; no daemon, no systemd, no tar).
