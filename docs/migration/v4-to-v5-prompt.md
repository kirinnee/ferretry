# Move one machine from Ferretry 4 to Ferretry 5, keeping everything

**This is a prompt.** Paste everything below the line into an agent (Claude Code or Codex) running **in a terminal on
the machine being moved**, with the owner at hand. Run it once per machine, one machine at a time. It replaces the
older clean-slate runbook ([clean-slate-prompt.md](clean-slate-prompt.md)), which threw sign-ins, secrets and paired
phones away: this one keeps them.

Why it is a prompt and not a feature: Ferretry 5 contains **no code that reads a v4 home** (owner decision A452,
addendum 2 of 2026-11-07: "dont include the migration IN code itself, because we dont want backward compatibility as a
deadweight"). The one-time converter lives at `migration/v4-to-v5/` in the repository, outside every package, and is
**deleted from the repository once all three machines are on v5**. What it reads is listed in
[v4-formats.md](v4-formats.md).

---

You are moving this machine's Ferretry from **v4 (4.291.x)** to **v5**, keeping all data and every ferret. Follow the
steps in order. Stop and tell the owner at any step that fails; never improvise around a failure.

## Rules you must keep for the whole run

- **Never open a secret.** You never `cat`, `less`, `head`, `jq`, `grep`, `diff`, hash or otherwise read these, in the
  old home, the backup or the new home: `state/secrets.key`, `state/secrets.json`, `state/login-secrets.json`,
  `state/mcp-oauth-secrets.json`, `state/catalogs/link-keys.json`, `state/daemon-identity.json`,
  `state/push-vapid.json`, `state/push.json`, `state/session-message-token.key`, `state/sessions/*/environment.json`,
  `api-token`, `api-warden-token`, anything under `fleet/credentials/`, and any `auth.json`, `.credentials.json` or
  `.claude.json`. You may only move them (`mv`) or copy them (`cp -p`). The converter moves keys and identity files the same way,
  byte for byte. For a sealed document (`secrets.json` and its siblings) it re-labels only the envelope (`"v": 1`
  becomes `"format": 1`, as v5's Vault asks) and copies every sealed value unchanged: it never decrypts, prints or
  logs anything from them. Never print a token, key, pairing code or secret, and never paste one into chat.
- **Never touch the harness's own sign-in folders** outside the home (`~/.claude*`, `~/.codex*`, the macOS keychain).
- **Never kill the tmux server** (`tmux … kill-server`, `pkill`, `killall`). Ferrets keep running in their panes the
  whole time; that is how they are kept.
- Ask the owner before each step marked **(owner's yes)**, and wait for the answer.
- Work in your own shell. Do not use any Ferretry tool (`fy`, the app, an MCP tool) to read the old home or the
  backup; Ferretry fences those folders and must not be asked to look inside them.

In the commands, `H` is this machine's Ferretry home (`${FY_HOME:-$HOME/.ferretry}`) and `STAMP` is the time you take
the backup, as `YYYY-MM-DD-HHMM` in UTC. Set both once in your shell:

```bash
H="${FY_HOME:-$HOME/.ferretry}"; STAMP="$(date -u +%Y-%m-%d-%H%M)"; B="$H-before-$STAMP"
```

## 1. Check versions

1. `fy --version` must print `4.291.` something, and it must be **4.291.10 or later**: that is the first v4 that refuses
   the jump to 5.x unless it is given `--major`, so a stray update cannot leave this home unconverted. The converter
   reads layout 2 of 4.291.x only (`cat "$H/layout-version"` prints `2`). If it is older, bring v4 to 4.291.10 or later
   by the install kind (`fy daemon update --check` names it), and start again:
   - **Homebrew**: skip this when `fy --version` already prints 4.291.10 or newer. Otherwise switch to the separate v4
     cask (needs 4.291.10 released). It links the same programs as the main cask, so remove the main cask first:
     `brew uninstall --cask ferretry && brew install --cask kirinnee/ferretry/ferretry@4`, then `fy daemon restart`.
     `--to` does not work here: once 5.0 is released Homebrew installs the newest release whatever `--to` says.
   - **Nix profile**: skip this when `fy --version` already prints 4.291.10 or newer. Otherwise replace the profile
     element with the v4 tag: `nix profile list` (the element is the entry's `Name:` on newer Nix, or its `Index:` on
     older Nix such as 2.18; pick the entry whose original flake URL starts with `github:kirinnee/ferretry`), then
     `nix profile remove <element> && nix profile add github:kirinnee/ferretry/v4.291.10`, then `fy daemon restart`.
     (A Nix too old to know `add` calls it `install`; this applies to EVERY `nix profile add` line in this prompt.)
     Same reason: `nix profile upgrade` and `--to` give the newest release.
   - **Pinning kinds** (standalone, nix-module with a pinned flake input, deb/rpm): `fy daemon update --yes --to 4.291.10`,
     or the kind's own pin.
   - If none of these applies, stop and tell the owner.

   **Never run `fy daemon update --yes` bare** on a v4 older than 4.291.10: once 5.0 is released, "latest" is 5.0, and an
   update that jumps there leaves this home unconverted (5.0 refuses it). **Never pass `--major` in this section**: it is
   the flag that lets a machine skip this prompt. It is used once only, in §5, after the home is prepared.

2. Note how Ferretry is installed here (Homebrew, nix profile, home-manager/nix-darwin, deb/rpm, standalone binary):
   `fy daemon update --check` names it. You need it in step 7 and for a rollback.
3. Get the v5 repository at the release you will install, in a folder **outside** `H`:
   `git clone --branch v5.0.0 https://github.com/kirinnee/ferretry ~/ferretry-v5-src`, or in an existing clone
   `git fetch && git checkout v5.0.0`. Check the converter is there: `ls ~/ferretry-v5-src/migration/v4-to-v5/README.md`.
   If it is not, this machine is already past the window in which the converter exists: stop and tell the owner.
4. Check free space: the new home needs about as much as `du -sh "$H"` reports, on **the same filesystem** as `H`
   (`df -h "$(dirname "$H")"`).

## 2. Stop v4 politely

1. Turn off automatic updates for the duration: in the app, Settings › ‹this machine› › Updates › _Install updates
   automatically when idle_ off (or confirm it is already off — it is off by default).
2. Write down what is running, into a file outside the home: `fy list > ~/v4-ferrets-$STAMP.txt` (names, states,
   cards). This is for the owner's eyes and for step 6; it holds no secret.
3. Let every ferret reach a quiet point: wait until `fy list` shows **no ferret mid-turn** (each is idle or waiting on
   the owner). Do not interrupt a ferret that is mid-turn unless the owner says so. Ferrets that are idle stay idle in
   their panes; nothing is ended.
4. Stop the daemon: `fy daemon stop`. **The tmux server and every pane stay running** — v4's stop only ends the daemon
   (only `fy daemon reset` ends the terminal server, and you must not run it). Check: `tmux -S "$H/tmux.sock" ls` still
   lists the ferrets' sessions.
5. Check nothing is half-done: none of these may exist —
   `ls "$H"/state/sessions/*/agenda-*.pending.json "$H/fleet/.fy-fleet-apply.lock" "$H"/fleet/shared/*/.migration-journal 2>/dev/null`.
   If any does, start v4 again (`fy daemon start`), wait a minute, stop it again, and re-check. If it persists, stop
   and tell the owner.

## 3. Back up the whole home (owner's yes)

Tell the owner: "I will now move `H` aside to `B`; that folder is the backup and stays untouched until you delete it."
With their yes:

```bash
mv "$H" "$B" && chmod 700 "$B"
```

A move, not a copy: it is instant, keeps every file exactly (modes, times, links, the live tmux socket) and leaves
nothing at `H`. The running panes are not disturbed: tmux keeps serving its socket, now at `$B/tmux.sock`. From now on
the converter only **reads** `B`; nothing writes into it. Until v5 is started (§7), send nothing to any ferret and
do not type into their panes: their harness folders moved with the home, so an idle ferret must stay idle.

**Standalone install only: keep the v4 programs aside too**, because §5 replaces them with v5 and §9 must be able to
put them back. Do this before §5, with the paths `command -v` prints:

```bash
mkdir -p "$B-bin" && for p in fy fyd fyd-browser-worker; do c="$(command -v "$p")" && cp -p "$c" "$B-bin/$p"; done
printf '%s\n' "$(command -v fy)" "$(command -v fyd)" "$(command -v fyd-browser-worker)" > "$B-bin/paths.txt"
ls -l "$B-bin"
```

Tell the owner which paths were copied (`$B-bin/paths.txt` holds them). If `fy` or `fyd` is missing from that
listing, stop and tell the owner: there is then no exact v4 to put back. `fyd-browser-worker` may be absent from a
very old install; say so.

## 4. Convert into a new home

```bash
cd ~/ferretry-v5-src/migration/v4-to-v5 && bun install
bun src/main.ts --from "$B" --to "$H" --dry-run      # reads only; prints what it would do; exit 0 = every step would convert
bun src/main.ts --from "$B" --to "$H"                # writes the new home at H
```

- The converter refuses (exit 2, nothing written) if `B` is not a stopped 4.291.x home, if the v4 daemon still holds
  its lock, or if `H` exists and is not empty.
- It writes `H` mode `0700`, every file `0600`, and moves sealed files byte for byte. It gives the live tmux socket a
  second name inside the new home (a hard link, so the same running server answers there); this is why `B` and `H`
  must be on one filesystem. It prints counts and names
  only, and writes a report **beside** the new home: `$H.conversion-report.json`. Show the owner the printed summary.
- A **dry run** writes nothing (not even `H`): exit 0 means every step would convert, exit 3 means one would not; read
  the printed summary to the owner before the real run.
- **Exit 0** means complete: every item converted, and `H/home.json` written **last**. **Exit 3** means some step did
  not finish: there is no `home.json`, so v5 refuses to start on `H` by design. Do not "fix" that by writing a
  `home.json` yourself; tell the owner, and roll back (§9) or wait for a fixed converter.
- A step that **failed** names the v4 file (never its contents) and, where the owner can fix it, how. Two such fixes
  are expected; each is done in **v4** (roll back §9, fix, stop v4, back up again, convert again), never by editing
  `B` or `H` by hand:
  - **A login id with capital letters** (v5 login ids are lowercase): the owner renames that login in v4 first.
    The converter never renames it, because runtimes, budgets and usage are joined on the id.
  - **A sign-in file the converting user cannot read**: the owner makes it readable by its owner (`chmod u+r`). The
    converter copies sign-in files and never hard-links them, so the backup stays a separate copy for rollback.

## 5. Install v5 (do not start it) and check the new home

1. Install v5 the way this machine installs Ferretry (the kind from step 1.2), without starting the daemon. The v4
   updater refuses a jump to 5.x without `--major`, which is why the home is prepared first. `--major` only allows
   the jump (it is a plain flag, combined with `--to`; `--yes` is still needed in an agent's shell and alone never
   allows the jump). It does not switch a package source, so each kind has its own command:
   - **Standalone binary**: `fy daemon update --major --yes --to 5.0.0`.
   - **Homebrew**: §1.1 is skipped when v4 is already 4.291.10 or newer, so check which cask is installed:
     `brew list --cask | grep -x 'ferretry\(@4\)\?'`.
     - **Main cask `ferretry`**: the tap's cask is 5.x once 5.0.0 is released, so `brew upgrade --cask ferretry`.
     - **`ferretry@4`**: `fy daemon update` can never reach 5.0 here (that cask stays 4.x and refuses, saying so).
       Switch the cask instead: `brew uninstall --cask ferretry@4 && brew install --cask kirinnee/ferretry/ferretry`.
   - **Nix profile**: `nix profile upgrade` stays on the source it was installed from, whichever v4 source that is
     (untagged, or any v4 tag). Switch the source: `nix profile list`, pick the Ferretry element whatever its source
     (the entry whose original flake URL starts with `github:kirinnee/ferretry`; its `Name:` on newer Nix, its
     `Index:` on older Nix such as 2.18), then
     `nix profile remove <element> && nix profile add github:kirinnee/ferretry/v5.0.0`. (A Nix too old to know `add`
     calls it `install`; that applies here too.)
   - **nix-module** (home-manager / nix-darwin): repin the flake input to `github:kirinnee/ferretry/v5.0.0` and switch.
   - **deb/rpm**: install the 5.0.0 package.

   Do not start the daemon. `fy --version` must print `5.`.

2. `fy config check` — every YAML file in `H/config` parses and passes its schema.
3. `fy doctor` — names any damaged file. A damaged file is a stop: tell the owner, do not start.
4. `ls -la "$H"` shows only `home.json`, `config/`, `state/`, `run/`, `logs/`.
5. **A literal credential in a v4 login file is refused in v5** (an intended difference, rebuild-parity.md). The converter
   seals the keys it recognises; `fy config check` (step 2) names any login file that still holds one, as the FILE and the
   KEY (never the value) and says to use `fy secret set NAME`. For each one, **the OWNER does this, not you**:
   1. `fy secret set NAME` — the owner types the value at the prompt. You never read, copy, echo or paste it.
   2. The owner rewrites that login's variable to `${secret:NAME}` (app: Settings › Files, or edit `config/logins/<id>.yaml`).
   3. v5 **holds** a login file that newly names a secret reference until the owner acknowledges it. The owner confirms
      that held edit: `fy config confirm logins/<id>.yaml` (list what waits with `fy config confirm`; or Allow it in the
      app). Setting the secret does not approve the reference. Do not bypass this.
   4. `fy config check` passes, and `fy secret run NAME -- true` succeeds.

## 6. What is kept, item by item

Tell the owner this list before starting v5, and say which items the summary showed as converted.

| Item                                                                                                                               | Kept?               | How                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every ferret, live and archived: id, callsign, title, lineage (parent/child, pack), project, runtime, start options, pins, history | **Kept**            | converted into Ferrets                                                                                                                                                                                                                                                                       |
| Running ferrets                                                                                                                    | **Kept, same pane** | v5 attaches to each live tmux pane by its handle (no new window, no lost turn). A ferret whose pane is gone is resumed from its harness conversation id. At its next idle turn, an attached harness is restarted in that same pane with resume, so its hooks and tools are v5 (no lost turn) |
| Harness conversations (Claude Code / Codex transcripts, for resume)                                                                | **Kept**            | moved whole, never parsed                                                                                                                                                                                                                                                                    |
| Message queue, shared drafts (chat and ask replies), turns, attachments, renders                                                   | **Kept**            | converted into Conversation                                                                                                                                                                                                                                                                  |
| Board: cards, lanes, links, dependencies, history; projects                                                                        | **Kept**            | converted                                                                                                                                                                                                                                                                                    |
| Agenda: asks, answers, notices                                                                                                     | **Kept**            | converted into Asks and Agenda                                                                                                                                                                                                                                                               |
| Lessons, usage history and budgets, warden history and settings                                                                    | **Kept**            | converted                                                                                                                                                                                                                                                                                    |
| Catalogs and shares (published catalogs, links, members, installs)                                                                 | **Kept**            | converted; link keys moved sealed; the skill folders you installed are copied to the new home byte for byte                                                                                                                                                                                  |
| Settings, layouts, runtimes, profiles, logins                                                                                      | **Kept**            | YAML split per v5 owner; comments kept                                                                                                                                                                                                                                                       |
| Changes you had confirmed that loosen a setting (e.g. skipping agent permissions, a raised cap)                                    | **Kept**            | your v4 confirmations move with them, so v5 does not ask again. If v4 was still waiting for you to confirm a change when it stopped, none are carried and v5 asks again (the summary names the file)                                                                                         |
| MCP server sign-ins (OAuth)                                                                                                        | **Kept**            | the sign-in records move, and the sealed refresh tokens move byte for byte with the vault key that opens them                                                                                                                                                                                |
| Security log (pairings, grants, secrets used)                                                                                      | **Kept**            | the v4 logs are merged into one v5 log, names and ids only                                                                                                                                                                                                                                   |
| Harness sign-ins                                                                                                                   | **Kept**            | the sign-in folders move whole; never read                                                                                                                                                                                                                                                   |
| Secrets                                                                                                                            | **Kept**            | the sealed vault and its key move byte for byte; no existing value is ever opened. A key v4 had saved in plain text in a login file is sealed into the vault as `LOGIN_<ID>_<VAR>` and the login file names it with `${secret:…}` (listed by name in the summary)                            |
| Paired phones and browsers, passkeys, unlock settings, push                                                                        | **Kept**            | the daemon identity, device public keys, grants, passkey ids and push keys move as they are                                                                                                                                                                                                  |
| Admin and warden tokens                                                                                                            | **Kept**            | moved byte for byte, never opened; `fy` keeps working without signing in again                                                                                                                                                                                                               |
| Global lessons (the rules applied from Lessons)                                                                                    | **Kept, wider**     | they now reach EVERY ferret, where v4 gave them only to ferrets whose profile listed `instructions/lessons`; that profile entry is removed, so no ferret gets them twice                                                                                                                     |
| Model routing catalog (`routing.json`: scores, floors, weights)                                                                    | **Not kept**        | v5 picks models by the routing prompt and `fy recommend`; the runtimes v4 never suggested are named in one line added to the end of your routing prompt (or listed in the summary when you had no prompt of your own)                                                                        |
| Pairing codes                                                                                                                      | **Not kept**        | single-use, two minutes long                                                                                                                                                                                                                                                                 |
| Live unlocks                                                                                                                       | **Not kept**        | each device unlocks again with its passkey, once                                                                                                                                                                                                                                             |
| In-flight input holds                                                                                                              | **Not kept**        | a hold mid-delivery is closed and its pane quarantined, as at any restart                                                                                                                                                                                                                    |
| Caches (session index, analytics, search) and per-login usage readings                                                             | **Rebuilt**         | v5 rebuilds them from the kept files, and measures usage afresh                                                                                                                                                                                                                              |

## 7. Start v5

1. `fy daemon start`.
2. In each browser and phone: just reload the app. Paired devices stay paired (same daemon identity); each one asks
   for its passkey unlock once.

## 8. Verify

Run each check and show the owner the result. Command names are v5's; if one differs in the installed release, use
`fy help` to find its current name — never fall back to reading files. Any failure: stop, tell the owner, and offer the rollback (§9).

1. **Ferrets**: `fy list` shows every ferret from `~/v4-ferrets-$STAMP.txt`, with the same names and parents.
2. **Running ferrets were attached in their own panes**: for each ferret that was running, its pane id is unchanged
   (`tmux -S "$H/state/terminals/tmux.sock" list-panes -a` against the note) and `fy list` shows it live. Send one a
   short message with the owner's yes and see it answer in the same conversation.
3. **Resume**: pick one stopped ferret with the owner and resume it; it continues its old conversation.
4. **Board**: `fy board` shows the same cards in the same lanes; open one with history and links.
5. **Agenda**: open asks and their answers are there (`fy ask list`).
6. **Secrets by USE**: `fy secret list` shows every name; with the owner's yes run one harmless command that uses a
   secret by name (never print it), e.g. `fy secret run <NAME> -- true`. It must succeed. You never see the value.
7. **No key in plain text in a login file**: `fy config check` passes (v5 refuses a login file that holds a key, so a pass is
   the proof; do not open the login files to look). Every key the converter moved out of a login file is listed in its
   summary by login, variable and secret name (`LOGIN_<ID>_<VAR>`), never by value. With the owner's yes run
   `fy secret run <NAME> -- true` for one of them; it must succeed. You never see the value.
8. **Devices**: on one paired phone, reload the app: it connects without pairing again and unlocks with its passkey.
9. **Sign-ins**: `fy login list` shows every login signed in.
10. `fy doctor` is clean.

Then turn automatic updates back on if the owner had them on.

## 9. Rollback (owner's yes)

If anything in §4–§8 fails and the owner wants v4 back:

```bash
fy daemon stop                                   # stop v5 (panes keep running)
mv "$H" "$H-v5-failed-$STAMP" && chmod 700 "$H-v5-failed-$STAMP"
mv "$B" "$H"                                     # the untouched v4 home, exactly as it was
```

Then put **4.291.10 or later** (v4) back the way this machine installs Ferretry (below), then `fy daemon restart`. v4 finds its
home and its live tmux server as it left them. Every kind below applies to a machine that **did** install v5 in §5:
until the v4 programs are back, starting the daemon runs v5, which refuses the restored v4 home. Pick the line for the
install kind `fy daemon update --check` named:

- **Nix profile**: remove the v5 element and install the v4 tag: `nix profile list` (the entry whose
  original flake URL is the v5 tag; its `Name:` on newer Nix, its `Index:` on older Nix), then
  `nix profile remove <element> && nix profile add github:kirinnee/ferretry/v4.291.10` (`install` instead of `add` on a
  Nix too old to know `add`)
  (or `nix profile rollback` to the generation from before §5, if it is still there and was 4.291.10 or later).
- **nix-module** (home-manager / nix-darwin): repin the flake input to `github:kirinnee/ferretry/v4.291.10` and switch.
- **Standalone binary**: copy the programs saved in §3 back over the v5 ones, to the paths in `$B-bin/paths.txt`:
  `for p in fy fyd fyd-browser-worker; do if [ -f "$B-bin/$p" ]; then cp -p "$B-bin/$p" "$(grep "/$p\$" "$B-bin/paths.txt")"; fi; done`,
  then check `fy --version` prints `4.291.`. (Only an accidental v4 self-update on a standalone install never moved off
  4.x, because v4 refuses a standalone release it cannot verify; after §5 it did move, which is why §3 saved them.)
- **Homebrew**: `brew upgrade` installs what the tap has now, which is 5.x, and brew cannot pin a cask version. The way
  back is the separate v4 cask (needs 4.291.10 released):
  `brew uninstall --cask ferretry && brew install --cask kirinnee/ferretry/ferretry@4`. If 4.291.10 is not released,
  stop and tell the owner, and do not run `brew upgrade` again.
- **deb/rpm**: install the 4.291.10 (or later 4.x) package of `fy` from the package source, if it still keeps that version.

After the install line for your kind, run `fy daemon restart` and check `fy --version` prints `4.291.`.

A migrated v5 home is **refused by v4 with nothing written** (it has no `layout-version`), so the `mv "$B" "$H"` above is
the way back: without the backup there is no v4 home to go back to. Tell the owner the failed v5 home is at
`$H-v5-failed-$STAMP` (it holds copies of sealed files: they decide when to delete it).

## 10. Afterwards

- **Keep the backup.** `B` (`$H-before-$STAMP`) stays until **the owner** deletes it. Never delete it yourself. v5
  fences every `<home>-before-*` folder and never reads it. It holds the old vault, key and sign-ins, so it stays `0700`.
- Report to the owner: the converter's summary, the §8 results, and where the backup and the report are.
- Do not delete `~/ferretry-v5-src` until the owner says this machine is done.
- **When all three machines are on v5**, the converter is deleted from the repository (`git rm -r migration/v4-to-v5 scripts/validate/migration-isolated.sh`
  and its wiring), together with this prompt's reference to it. Say so to the
  owner when you report the last machine.
