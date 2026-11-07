# Clean slate: carry-over prompt

**Status: DRAFT, written with docs/design/redesign.md §9.5. Not product code: nothing in Ferretry reads this file or
the old state it talks about. Every new path below is in the redesign's file map (§9.2).**

Give this whole file to one agent for one daemon. It works by hand, step by step, and stops to ask the owner where
the owner's hands are needed. Run it once per daemon: today that is one on each machine (this one, pebox,
kirin-box). On a machine where several users run Ferretry, each user runs it for their own daemon.

---

## You are carrying one daemon over to Ferretry 5

Ferretry 5 starts empty, and it never touches a home it did not make: on an old `~/.ferretry` (no `home.json`) it
refuses to start and changes nothing. **You** move the old home aside, with the owner's yes, in step 2. Then you bring
the owner's setup across **by hand**, with `fy` commands, and leave the owner a short list of what they must do.

Rules:

- **Never read, print or copy a secret value.** Secret values are retyped by the owner (`fy secret set NAME`). Skip
  these backup files entirely: `state/secrets.*` (except `state/secrets.key`, below), `state/vault.*`,
  `state/login-secrets.json`, `fleet/credentials/**`, `api-token`, `api-warden-token`, `speed-up-keys.json`,
  anything else named `*.key`.
- **One exception: the MCP sign-ins, three files carried together in step 2c, unopened.** `state/secrets.key` →
  `state/vault/vault.key`, `state/mcp-oauth.json` → `state/mcp/oauth.json`, `state/mcp-oauth-secrets.json` →
  `state/mcp/oauth-secrets.json`. All three or none. Your shell moves them; you never read them: no `cat`, `less`,
  `head`, hash, `diff` or `jq .` to look, and their bytes never reach your output. The key is copied byte for byte; the
  two documents change only their outer `"v": 1` to `"format": 1`, which is outside what the seal covers, so every
  ciphertext stays as it was and still opens. This is what the converter (`migration/v4-to-v5`, its Vault and MCP
  steps) does; it is the real path, and step 2c is the same move by hand.
- Read the backup only, from your own shell. Ferretry fences it: no ferret tool, file tool, import or install may
  read it, **and that includes your own `fy` commands**. `fy instruction add`, `fy skill add`, `fy mcp add` and
  `fy config write` refuse any path inside the backup (`source_fenced`). So to bring a file across, first copy only
  that chosen, non-secret file out of the backup with your own shell into a staging folder (step 4), then point
  `fy` at the copy. Never try to reach the backup through `fy fs`, an item import or an attachment.
- Do not edit, re-permission or delete the backup. Only the owner deletes it, at the end.
- Write new settings only through `fy config write <file>` (it checks every file against its schema) or the `fy`
  verbs named below.
- When a step needs the owner (scanning a code, signing in, typing a secret, a passkey), ask in one short line and
  wait.

## 1. Before the update: write down open work, then stop

On the **old** version, while it still runs:

1. Turn off automatic updates on this machine (ask the owner if you can't find the setting). If it already updated,
   the new daemon refuses to start and nothing is lost: go on.
2. `fy ps` → for each running ferret: name, title, folder, what it is doing.
3. `fy board status` and the open cards per project (title, lane, progress, PR links).
4. `fy agenda list` → open asks (title, what it asks, which card).
5. Save all of it as `~/ferretry-carry-over-<date>.md` and show the owner its path.
6. Ask the owner to confirm, then stop every ferret (`fy stop`) and the old daemon. If an old ferret's terminal is
   still running, ask before ending it (`tmux -S ~/.ferretry/tmux.sock kill-server`).

## 2. Move the old home aside (only with the owner's yes)

1. Check that `~/.ferretry` has **no** `home.json`. If it has one, stop and tell the owner: it is a Ferretry 5 home.
2. Tell the owner exactly what you will run, and wait for a yes:
   `OLD=~/.ferretry-before-$(date +%Y-%m-%d-%H%M)`, then `mv ~/.ferretry "$OLD"` and `chmod 700 "$OLD"`.
   (The name must match `<FY_HOME>-before-<YYYY-MM-DD-HHMM>`, so Ferretry fences it.)
3. Run it. Note `$OLD`.

## 2b. Update and start

1. Update `fy` and the daemon the way this machine installs Ferretry (`docs/updating.md`).
2. Start the daemon (any `fy` command starts it). It finds no home, creates one and starts empty.
3. If it refuses to start, stop: tell the owner the message, and move or delete nothing.
4. Turn automatic updates back on if the owner wants them.

## 2c. Carry the MCP sign-ins: three files together, unopened

Do this **now**, before step 3 and before anything else seals a value: the new daemon mints its own
`state/vault/vault.key` the first time anything is sealed (a sign-in in step 5, a `fy secret set` in step 6), and an
old key copied over a new one would orphan whatever was sealed under it. The daemon may keep running: the Vault reads
its key, and MCP its two files, from disk on every use.

**Every command in this step must set `OLD` and `NEW` itself, as its first line, with literal values.** Tool shells
do not keep variables from one call to the next, so a variable set in step 2 is gone by now. `OLD` is the path you
noted in step 2; `NEW` is `~/.ferretry`, the home the daemon just made (it has `home.json`).

1. Look only at whether the files exist (never at what is in them). If `$OLD/state/mcp-oauth.json` or
   `$OLD/state/mcp-oauth-secrets.json` is missing, carry nothing and skip to step 3; the owner signs in to each OAuth
   MCP server again. If `$OLD/state/mcp-oauth-secrets.json` exists but `$OLD/state/secrets.key` does not, carry
   nothing and tell the owner: those tokens cannot be opened without it. Begin that command with
   `: "${OLD:?set OLD}"` so an empty `OLD` stops it instead of reading as "missing".
2. Run this as one block in your own shell, after setting `OLD` and `NEW` on its first line. It prints nothing but a
   refusal, and a refusal names only a path. The block checks for itself, before it writes anything, that all three
   targets (`state/vault/vault.key`, `state/mcp/oauth.json`, `state/mcp/oauth-secrets.json`) are absent, and each file
   is put in place without overwriting. Never overwrite one.

   ```sh
   (
     set -e
     : "${OLD:?set OLD}" "${NEW:?set NEW}"
     [ -f "$NEW/home.json" ] || { echo "refusing: $NEW is not a Ferretry 5 home" >&2; exit 1; }
     for t in "$NEW/state/vault/vault.key" "$NEW/state/mcp/oauth.json" "$NEW/state/mcp/oauth-secrets.json"; do
       [ ! -e "$t" ] || { echo "refusing: $t exists" >&2; exit 1; }
     done
     umask 077
     mkdir -p "$NEW/state/vault" "$NEW/state/mcp"
     cp "$OLD/state/secrets.key" "$NEW/state/vault/vault.key.tmp"
     jq 'if .v == 1 and .cipher == "AES-256-GCM" then {format: 1} + del(.v) else error("not a version-1 sealed document") end' \
       "$OLD/state/mcp-oauth-secrets.json" > "$NEW/state/mcp/oauth-secrets.json.tmp"
     jq 'if .v == 1 then {format: 1} + del(.v) else error("not a version-1 MCP sign-in document") end' \
       "$OLD/state/mcp-oauth.json" > "$NEW/state/mcp/oauth.json.tmp"
     chmod 600 "$NEW/state/vault/vault.key.tmp" "$NEW/state/mcp/oauth-secrets.json.tmp" "$NEW/state/mcp/oauth.json.tmp"
     ln "$NEW/state/vault/vault.key.tmp" "$NEW/state/vault/vault.key"
     ln "$NEW/state/mcp/oauth-secrets.json.tmp" "$NEW/state/mcp/oauth-secrets.json"
     ln "$NEW/state/mcp/oauth.json.tmp" "$NEW/state/mcp/oauth.json"
     rm "$NEW/state/vault/vault.key.tmp" "$NEW/state/mcp/oauth-secrets.json.tmp" "$NEW/state/mcp/oauth.json.tmp"
   )
   ```

   `jq` writes straight into the new file; you never see its output. `ln` refuses to replace a file that exists, so
   even a target that appears after the check is never overwritten.
   - If it refuses with "exists", stop, delete nothing, and tell the owner the path.
   - If it fails any other way, delete the `*.tmp` files it left, and delete a target only if it is the same file as
     its `.tmp` (`[ "$t" -ef "$t.tmp" ]`): that one is your copy. Leave any other target alone; something else made
     it. Carry nothing (never touch the backup) and tell the owner the refusal.

3. Tell the owner, in one line each:
   - Carried: each OAuth MCP server's sign-in record, refresh token and registered client secret.
   - Not carried: the **access tokens**. They lived in the old `state/secrets.json`, which this runbook never carries
     (its values are retyped, step 6).
   - **Carried sign-ins renew at the next launch that uses them, as today.** That launch spends the carried refresh
     token for a new access token before the ferret starts. A server whose provider refuses the refresh shows
     "needs sign-in" until the owner signs in to it again; the launch still starts.
4. After the main step 4 (Settings) adds the servers, `fy mcp ls` shows each one's sign-in state.

## 3. Clear each browser, then pair it (owner's hands)

For each phone and browser, **in this order**:

1. Ask the owner to clear the Ferretry app's site data in that browser, then reload the app.
2. Then run `fy pair` and ask the owner to scan the code; the phone makes a passkey in the same step.

Never the other way round: clearing site data after pairing deletes the new device key.

## 4. Settings (you do this)

Read the old YAML under `$OLD/config/` and write each part to its new home. **Leave out any key the new schema
refuses, and tell the owner which ones.** Never copy a value that looks like a secret: settings only ever hold
`${secret:NAME}` references, and the names are carried in step 6.

**Stage first, then import.** `fy` will not read inside the backup, so every file goes through a staging folder:

1. Make one outside the fence: `STAGE=$(mktemp -d)` and `chmod 700 "$STAGE"`. It must not be under `~/.ferretry`
   or any `~/.ferretry-before-*` folder.
2. With your own shell, copy into it **only** the files you chose from the 4a table, keeping their relative paths,
   e.g. `mkdir -p "$STAGE/skills" && cp -R "$OLD/fleet/assets/components/skills/review" "$STAGE/skills/"`. Never copy anything on the
   skip list above, and never copy a whole folder that holds one.
3. Write each new settings file into `$STAGE/new/` and run `fy config write` on it there; run `fy instruction add`,
   `fy skill add` and `fy mcp add` on the staged copies.
4. When step 4 is done, delete the staging folder: `rm -rf "$STAGE"`. (This is your copy, not the backup.)

### 4a. Files that move whole or nearly whole

| Old file (under `$OLD/config/`)                                                                                                                                 | New file (under the new `config/`)                                                            | Owner               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------- |
| `logins/<id>.yaml` without its `budget` block                                                                                                                   | `logins/<id>.yaml`                                                                            | Logins              |
| the `budget` block of each `logins/<id>.yaml`                                                                                                                   | `usage.yaml` › `budgets.<id>`                                                                 | Usage               |
| `presets/<id>.yaml`                                                                                                                                             | `endpoints/<id>.yaml`                                                                         | Logins              |
| `models/<name>.yaml`                                                                                                                                            | `models/<name>.yaml`                                                                          | Logins              |
| `profiles/<name>.yaml`                                                                                                                                          | `profiles/<name>.yaml`                                                                        | Runtimes            |
| `runtimes/<name>.yaml`                                                                                                                                          | `runtimes/<name>.yaml`                                                                        | Runtimes            |
| `components/modelSets/<name>.yaml`                                                                                                                              | `model-sets/<name>.yaml`                                                                      | Runtimes            |
| `components/mcp/<name>.yaml`                                                                                                                                    | `mcp/<name>.yaml`, written with `fy mcp add` so its payload is resolved and pinned            | MCP                 |
| `components/skills/<name>.yaml`                                                                                                                                 | `skills/<name>.yaml`, written with `fy skill add`                                             | Skills              |
| `components/instructions/<name>.yaml`                                                                                                                           | `instructions/<name>.md`, written with `fy instruction add`                                   | Ferrets             |
| `components/settings/<name>.yaml`                                                                                                                               | `claude-code/settings/<name>.yaml` or `codex/settings/<name>.yaml`, by the harness it was for | Claude Code / Codex |
| `components/hooks/<name>.yaml`                                                                                                                                  | `claude-code/hooks/<name>.yaml`                                                               | Claude Code         |
| `warden.yaml`                                                                                                                                                   | `warden.yaml`                                                                                 | Warden              |
| `voice.yaml`                                                                                                                                                    | `voice.yaml` (keys only as `${secret:NAME}`)                                                  | Voice               |
| `limits.yaml`                                                                                                                                                   | `limits.yaml`                                                                                 | Ferrets             |
| `learning.yaml`                                                                                                                                                 | `lessons.yaml`                                                                                | Lessons             |
| `pack.yaml` + `models-guide.yaml`                                                                                                                               | `packs.yaml`                                                                                  | Packs               |
| `account-defaults.yaml`                                                                                                                                         | `accounts.yaml`                                                                               | Accounts            |
| `daemon.json` › `carriers`, `relay` (or the old `host`/`port`)                                                                                                  | `connections.yaml`                                                                            | Connections         |
| `daemon.json` › `terminals.shell`                                                                                                                               | `terminals.yaml`                                                                              | Terminals           |
| `daemon.json` › `harness`                                                                                                                                       | `harness-claude-code.yaml`, `harness-codex.yaml` (binary path)                                | Claude Code / Codex |
| the daemon-wide grants and security settings (the old app's Settings › Security, or `$OLD/state/security.json` and the grants document; neither holds a secret) | `gate.yaml` › `grants`, `security` (a loosening edit: the owner confirms with a passkey)      | Gate                |

Bodies of instructions and skills live in `$OLD/fleet/assets/components/**`. Copy the ones you chose into
`$STAGE` first (above), then run `fy instruction add "$STAGE/…"` and `fy skill add "$STAGE/…"`. Pointed at the
backup itself, both refuse with `source_fenced`; that is the fence working, so do not look for a way around it.
Never point a ferret at the backup or at `$STAGE`.

### 4b. `machine.yaml`, key by key

| Old key                                                                 | New home                                                                                                                |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `agentPermissions`                                                      | `harness-claude-code.yaml` and `harness-codex.yaml` › `permissions`                                                     |
| `defaultRuntime`                                                        | `runtimes.yaml` › `default`                                                                                             |
| `agentControl.terminals`, `.browsers`, `.files`, `.ferretrySettings`    | `limits.yaml` › `tools`                                                                                                 |
| `autoResume`                                                            | `limits.yaml` › `autoResume`                                                                                            |
| `conversations` (Keep in sync)                                          | `conversation.yaml`                                                                                                     |
| `browserMode`, `browserProxy`, `browserPorts`, `browserFirewallFailure` | `browsers.yaml`                                                                                                         |
| update settings                                                         | `updates.yaml`                                                                                                          |
| housekeeping settings                                                   | `tidy.yaml`                                                                                                             |
| `advanced.*`                                                            | leave out, and list each key for the owner: the new daemon's `fy config write` names the file that now takes it, if any |

Anything not in these tables: leave it out and list it for the owner.

### 4c. Check

Run `fy config check` and `fy doctor`. Fix what they name, or leave the key out and tell the owner.

## 5. Logins (owner's hands)

For each login you wrote in step 4, start its sign-in (`fy login sign-in <id>`); the owner completes it. API-key
logins need the owner to retype the key (`fy secret set NAME`).

If Claude Code or Codex is already signed in on this machine outside Ferretry, onboarding offers to **link** that
sign-in instead (zero keys; Ferretry never opens the file). Tell the owner the cost in one line: ferrets then share
their own quota and account.

## 6. Secrets and accounts (owner's hands)

List the secret **names** the settings refer to (`${secret:NAME}` in the YAML you wrote) and the account names and
sites in `$OLD/state/login-entries.json` (names and sites only, never values). Ask the owner to retype each secret
(`fy secret set NAME`) and re-add each account (`fy account add`). Saved passwords and 2FA keys are re-saved by the
owner the next time each sign-in is used ("Save as" on the input card).

## 7. Projects and boards

Register each project from the carry-over note (`fy project add <path>`). Turn the board on where it was on
(`fy board on <project>`).

## 8. Optional: open work

Ask the owner which open cards and asks from the carry-over note to re-create. Re-create only those
(`fy card new …`; an ask is re-raised by the card or plugin that owns it, or by `fy ask raise …`).

## 9. Finish

1. Tell the owner: what was carried, what was left out and why, and what they still have to do.
2. When the owner says the daemon is fine, tell them they can delete `$OLD` themselves (`rm -rf` on that path).
   Do not delete it for them.
