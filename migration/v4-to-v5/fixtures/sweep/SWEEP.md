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
  `store: ferretry`, that `state/logins/credentials/<login>` is a real folder (a link is refused), and makes that folder mode `0700`.
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
