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

1. `fy --version` must print `4.291.` something. If it is older, update v4 first (`fy daemon update --yes`) and start
   again; the converter reads layout 2 of 4.291.x only (`cat "$H/layout-version"` prints `2`).
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

## 4. Convert into a new home

```bash
cd ~/ferretry-v5-src/migration/v4-to-v5 && bun install
bun src/main.ts --from "$B" --to "$H" --dry-run      # reads only; prints what it would do
bun src/main.ts --from "$B" --to "$H"                # writes the new home at H
```

- The converter refuses (exit 2, nothing written) if `B` is not a stopped 4.291.x home, if the v4 daemon still holds
  its lock, or if `H` exists and is not empty.
- It writes `H` mode `0700`, every file `0600`, and moves sealed files byte for byte. It gives the live tmux socket a
  second name inside the new home (a hard link, so the same running server answers there); this is why `B` and `H`
  must be on one filesystem. It prints counts and names
  only, and writes a report **beside** the new home: `$H.conversion-report.json`. Show the owner the printed summary.
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

1. Install v5 the way this machine installs Ferretry (the method from step 1.2; [updating.md](../updating.md) has the
   exact commands per method), without starting the daemon. `fy --version` must print `5.`.
2. `fy config check` — every YAML file in `H/config` parses and passes its schema.
3. `fy doctor` — names any damaged file. A damaged file is a stop: tell the owner, do not start.
4. `ls -la "$H"` shows only `home.json`, `config/`, `state/`, `run/`, `logs/`.

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
| Changes you had confirmed that loosen a setting (e.g. skipping agent permissions, a raised cap)                                    | **Kept**            | your v4 confirmations move with them, so v5 does not ask again                                                                                                                                                                                                                               |
| MCP server sign-ins (OAuth)                                                                                                        | **Kept**            | the sign-in records move, and the sealed refresh tokens move byte for byte with the vault key that opens them                                                                                                                                                                                |
| Security log (pairings, grants, secrets used)                                                                                      | **Kept**            | the v4 logs are merged into one v5 log, names and ids only                                                                                                                                                                                                                                   |
| Harness sign-ins                                                                                                                   | **Kept**            | the sign-in folders move whole; never read                                                                                                                                                                                                                                                   |
| Secrets                                                                                                                            | **Kept**            | the sealed vault and its key move byte for byte; no value is ever opened                                                                                                                                                                                                                     |
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
7. **Devices**: on one paired phone, reload the app: it connects without pairing again and unlocks with its passkey.
8. **Sign-ins**: `fy login list` shows every login signed in.
9. `fy doctor` is clean.

Then turn automatic updates back on if the owner had them on.

## 9. Rollback (owner's yes)

If anything in §4–§8 fails and the owner wants v4 back:

```bash
fy daemon stop                                   # stop v5 (panes keep running)
mv "$H" "$H-v5-failed-$STAMP" && chmod 700 "$H-v5-failed-$STAMP"
mv "$B" "$H"                                     # the untouched v4 home, exactly as it was
```

Then reinstall 4.291.5 the way this machine installs Ferretry ([updating.md](../updating.md), pinned to `4.291.5`) and
`fy daemon start`. v4 finds its home and its live tmux server as it left them. Tell the owner the failed v5 home is at
`$H-v5-failed-$STAMP` (it holds copies of sealed files: they decide when to delete it).

## 10. Afterwards

- **Keep the backup.** `B` (`$H-before-$STAMP`) stays until **the owner** deletes it. Never delete it yourself. v5
  fences every `<home>-before-*` folder and never reads it. It holds the old vault, key and sign-ins, so it stays `0700`.
- Report to the owner: the converter's summary, the §8 results, and where the backup and the report are.
- Do not delete `~/ferretry-v5-src` until the owner says this machine is done.
- **When all three machines are on v5**, the converter is deleted from the repository (`git rm -r migration/v4-to-v5 scripts/validate/migration-isolated.sh`
  and its wiring), together with this prompt's reference to it. Say so to the
  owner when you report the last machine.
