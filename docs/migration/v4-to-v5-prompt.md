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
steps in order. Stop and tell the owner at any step that fails; never improvise around a failure. Where a step makes you
guess, that is a stop too: ask the owner. The only non-zero results you may continue past are the ones this prompt
names as expected.

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
- **Run every command in `bash`** (start `bash` if your shell is zsh): the blocks below rely on its globbing and `<( )`.
  Each tool call may begin in a fresh shell: start it with `. "<the path of your notes file>"` (`NOTES`, set below) to get the variables back.
  Needs `git`, `jq`, `tmux` and `bun` on this machine; stop and tell the owner if one is missing.

In the commands, `H` is this machine's Ferretry home (`${FY_HOME:-$HOME/.ferretry}`), `STAMP` is the time you start (UTC,
`YYYY-MM-DD-HHMM`), `B` is the backup folder, `SRC` is the v5 checkout and `NOTES` is your own log. Set them once:

```bash
H="${FY_HOME:-$HOME/.ferretry}"; STAMP="$(date -u +%Y-%m-%d-%H%M)"; B="$H-before-$STAMP"
SRC="$HOME/ferretry-v5-src-$STAMP"; NOTES="$HOME/v4-to-v5-$STAMP.notes"; V5BIN="$HOME/ferretry-v5-bin"
for v in H STAMP B SRC NOTES V5BIN; do printf '%s=%q\n' "$v" "${!v}"; done > "$NOTES"
. "$NOTES"; export H STAMP B SRC NOTES V5BIN
```

`$NOTES` holds these variables and, as you go, one line `# <event>` per milestone (`# backed-up`, `# converted`,
`# installed-v5`, `# started-v5`). The rollback (§9) reads them to know how far you got. Append each with
`echo '# <event>' >> "$NOTES"` the moment it is true, never earlier.

## 1. Check versions and get v5

1. `fy --version` must print `4.291.` something, and it must be **4.291.10 or later**: that is the first v4 that refuses
   the jump to 5.x unless it is given `--major`, so a stray update cannot leave this home unconverted. The converter
   reads layout 2 of 4.291.x only (`cat "$H/layout-version"` prints `2`). If it is older, bring v4 to 4.291.10 or later
   by the install kind (`fy daemon update --check` names it), and start again:
   - **Homebrew**: skip this when `fy --version` already prints 4.291.10 or newer. Otherwise switch to the separate v4
     cask (`ferretry@4`, released with 4.291.10). It links the same programs as the main cask, so remove the main cask first:
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
   `fy daemon update --check` names it. You need it in §5 and for a rollback.
3. Decide which v5 this machine can get today. `git ls-remote --tags https://github.com/kirinnee/ferretry v5.0.0`:
   - It prints a line: **released**. Use `REF=v5.0.0`.
   - It prints nothing: **pre-release**. Use `REF=origin/rebuild/5.0`, and §5 builds the v5 programs from this same
     checkout. Tell the owner.
4. Get the v5 repository into a **fresh folder** (never reuse, reset or clean an existing clone) at one exact commit,
   and record it. Converter and programs must both come from this commit:

   ```bash
   REF=v5.0.0   # or REF=origin/rebuild/5.0 before the release; set it from step 3
   git clone --no-checkout https://github.com/kirinnee/ferretry "$SRC" && git -C "$SRC" checkout --detach "$REF"
   COMMIT="$(git -C "$SRC" rev-parse HEAD)"; printf 'REF=%s\nCOMMIT=%s\n' "$REF" "$COMMIT" >> "$NOTES"
   ls "$SRC/migration/v4-to-v5/README.md" && echo "$COMMIT"
   ```

   If the converter is not there, this machine is already past the window in which it exists: stop and tell the owner.

5. **Pre-release only: build the v5 programs now**, from `$SRC`, before anything on the machine changes. The repository's
   own release compile script builds `fy`, `fyd` and `fyd-browser-worker` for one target into `dist/bin/<name>-<target>`:

   ```bash
   case "$(uname -s)-$(uname -m)" in
     Linux-x86_64) T=linux-x64-baseline ;; Linux-aarch64 | Linux-arm64) T=linux-arm64 ;; Darwin-arm64) T=darwin-arm64 ;;
     *) echo "unsupported platform"; false ;;
   esac
   (cd "$SRC" && COMPILE_TARGETS="$T" nix develop --command ./scripts/release/compile.sh)
   mkdir -p "$V5BIN" && for p in fy fyd fyd-browser-worker; do cp "$SRC/dist/bin/$p-$T" "$V5BIN/$p" && chmod 755 "$V5BIN/$p"; done
   if [ "$(uname -s)" = Darwin ]; then xattr -d com.apple.quarantine "$V5BIN"/* 2>/dev/null; fi
   "$V5BIN/fy" --version; "$V5BIN/fyd" --version
   [ "$(git -C "$SRC" rev-parse HEAD)" = "$COMMIT" ] && [ -z "$(git -C "$SRC" status --porcelain)" ] && echo "same commit"
   ```

   Both versions must print `5.` and the last line must print `same commit`. Nothing is on `PATH` yet and no installed
   program changed. The compile needs the network and a few minutes.

6. Check free space: the new home needs about as much as `du -sh "$H"` reports, on **the same filesystem** as `H`
   (`df -h "$(dirname "$H")"`).

## 2. Stop v4 politely

1. Turn off automatic updates for the duration: in the app, Settings › ‹this machine› › Updates › _Install updates
   automatically when idle_ off (or confirm it is already off — it is off by default).
2. Save what is there now, into files **outside the home**. They hold ids, names, lanes and pane ids only, no
   conversation text and no secret. Everything §8 compares against comes from these:

   ```bash
   fy ps -a --json | jq -S '[.[] | {id: .config.id, name: .config.name, parent: (.config.parent // null), status: .state.status}] | sort_by(.id)' > ~/v4-ferrets-$STAMP.json
   for s in open closed dropped; do
     fy board --project all --state "$s" --all --json | jq -S '{truncated: (.nextCursor != null), cards: ([.cards[] | {id, laneId}] | sort_by(.id))}' > ~/v4-board-$STAMP-$s.json
   done
   jq -s 'map(.truncated) | any' ~/v4-board-$STAMP-*.json
   tmux -S "$H/tmux.sock" list-panes -a -F '#{session_name} #{pane_id}' | sort > ~/v4-panes-$STAMP.txt
   for f in "$H"/state/sessions/*/terminal-pane.json; do [ -e "$f" ] && jq -r '[.sessionId, .tmuxSession, .paneId] | @tsv' "$f"; done | sort > ~/v4-pane-owners-$STAMP.tsv
   wc -l ~/v4-ferrets-$STAMP.json ~/v4-panes-$STAMP.txt ~/v4-pane-owners-$STAMP.tsv
   ```

   `-a`, `--state` and `--all` make these cover stopped ferrets, closed and dropped cards and private cards. The
   `jq -s` line must print `false`: `true` means a board state holds more than 500 cards, `fy board` cannot page past
   that, and you stop and tell the owner. An empty `v4-panes` file means no ferret is running; say so to the owner. Also
   ask the owner to open the app's Agenda and tell you how many asks are open and the title of one that has an answer;
   write both into `$NOTES` as a comment.

3. **Quiet window.** v4 has no command that lists "mid-turn" ferrets, and its own `fy daemon restart --when-idle` reads
   the count so loosely that it prints nothing and succeeds when the count is zero **or could not be read**, so do not
   use it as proof. You establish quiet with three checks, in this order, and every one must hold; if any cannot be
   established, stop and ask the owner:
   1. The owner stops messaging ferrets, and checks in the app that no ferret is mid-turn (each shows its turn is over
      or a declared wait). The owner answers or dismisses open phone approvals first: v4 closes phone approval cards
      when the daemon restarts and puts any input hold still unresolved into a quarantine window, so settle them now.
      Ask the owner whether a ferret runs a loop or timer inside its own harness (Ferretry v4 has no switch for that);
      the owner ends it first.
   2. No pane writes anything for a minute. Paste this function once per shell and run it:

      ```bash
      quiet() { # $1 = the tmux socket. Succeeds when no pane's last-output time moved for 60 s; gives up after 10 tries.
        local n=0 before after
        while [ "$n" -lt 10 ]; do
          before="$(tmux -S "$1" list-panes -a -F '#{pane_id} #{window_activity}' | sort)" || return 2
          sleep 60
          after="$(tmux -S "$1" list-panes -a -F '#{pane_id} #{window_activity}' | sort)" || return 2
          [ "$before" = "$after" ] && return 0
          n=$((n + 1))
        done
        return 1
      }
      quiet "$H/tmux.sock"; echo "quiet exit $?"
      ```

      `0` is quiet. `1` means a pane kept writing for ten minutes. `2` means tmux could not be read. A ferret thinking
      silently for over a minute looks quiet to this check, which is why (1) comes first. Do not interrupt a mid-turn
      ferret unless the owner says so; wait and run it again.

   3. Stop the daemon first (next step), then run `quiet` once more. Stopping it also ends everything Ferretry started
      on its own (queued messages, schedules, wake-ups, revivals), so after it no new work can begin except what a
      person types into a pane. Tell the owner not to.

4. Stop the daemon: `fy daemon stop`, then `quiet "$H/tmux.sock"; echo "quiet exit $?"` again (must be `0`). **The tmux
   server and every pane stay running** — v4's stop only ends the daemon (only `fy daemon reset` ends the terminal
   server, and you must not run it). Check: `tmux -S "$H/tmux.sock" ls` still lists the ferrets' sessions.
5. Check nothing is half-done. This prints `NONE` and exits 0 when clean, prints `FOUND` and the file names (never their
   contents) and exits 1 when something is pending, and prints `ERROR` and exits 2 when the home cannot be inspected:

   ```bash
   bash -c '
   [ -d "$H/state/sessions" ] && [ -r "$H/state/sessions" ] && [ -x "$H/state/sessions" ] || { echo "ERROR: cannot read $H/state/sessions"; exit 2; }
   found=0
   for f in "$H"/state/sessions/*/agenda-*.pending.json "$H/fleet/.fy-fleet-apply.lock" "$H"/fleet/shared/*/.migration-journal; do
     if [ -e "$f" ]; then printf "%s\n" "$f"; found=1; fi
   done
   if [ "$found" = 1 ]; then echo FOUND; exit 1; fi
   echo NONE'
   ```

   `FOUND` (exit 1) is the only non-zero result you may act on here: start v4 again (`fy daemon start`), wait a minute,
   `fy daemon stop`, re-check. If it persists, stop and tell the owner. `ERROR` is a stop.

## 3. Back up the whole home (owner's yes)

Tell the owner: "I will now move `H` aside to `B`; that folder is the backup and stays untouched until you delete it."
With their yes:

```bash
mv "$H" "$B" && chmod 700 "$B" && echo '# backed-up' >> "$NOTES"
```

A move, not a copy: it is instant, keeps every file exactly (modes, times, links, the live tmux socket) and leaves
nothing at `H`. The running panes are not disturbed: tmux keeps serving its socket, now at `$B/tmux.sock`. From now on
the converter only **reads** `B`; nothing writes into it. Until v5 is started (§7), send nothing to any ferret and
do not type into their panes: their harness folders moved with the home, so an idle ferret must stay idle.

**Standalone install only: keep the v4 programs aside too**, because §5 replaces them with v5 and §9 must be able to
put them back (pre-release does not replace them, so skip this then). Do this before §5, with the paths `command -v` prints:

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
cd "$SRC/migration/v4-to-v5" && bun install
bun src/main.ts --from "$B" --to "$H" --dry-run --report ~/v4-v5-dry-run-$STAMP.json   # exit 0 = every step would convert
bun src/main.ts --from "$B" --to "$H"                                                  # writes the new home at H
```

Before the real run check `[ "$(git -C "$SRC" rev-parse HEAD)" = "$COMMIT" ]`: the converter must be the one you recorded.

- The converter refuses (exit 2, nothing written) if `B` is not a stopped 4.291.x home, if the v4 daemon still holds
  its lock, or if `H` exists and is not empty.
- It writes `H` mode `0700`, every file `0600`, and moves sealed files byte for byte. It gives the live tmux socket a
  second name inside the new home (a hard link, so the same running server answers there); this is why `B` and `H`
  must be on one filesystem. It prints counts and names
  only, and writes a report **beside** the new home: `$H.conversion-report.json`. Show the owner the printed summary.
- A **dry run** creates and changes no home (not even `H`). It still writes a report, to the `--report` path above,
  so it can never overwrite the real run's `$H.conversion-report.json`. Exit 0 means every step would convert, exit 3
  means one would not: read the printed summary to the owner before the real run.
- **Exit 0** means complete: every item converted, and `H/home.json` written **last**. Then
  `echo '# converted' >> "$NOTES"`. **Exit 3** means some step did
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

1. Install v5 the way this machine installs Ferretry (the kind from §1.2), without starting the daemon. The v4
   updater refuses a jump to 5.x without `--major`, which is why the home is prepared first. Which list applies is
   the §1.3 answer:
   - **Pre-release** (the programs you built into `$V5BIN`). Nothing is uninstalled, so v4 stays installed for a
     rollback. Put the folder first on `PATH` for this and every later shell of this run, and check:

     ```bash
     export PATH="$V5BIN:$PATH"; hash -r; command -v fy fyd; fy --version
     echo "export PATH=\"$V5BIN:\$PATH\"" >> "$NOTES"; echo '# installed-v5 prerelease' >> "$NOTES"
     ```

     Both programs must be the ones in `$V5BIN` and `fy --version` must print `5.`. Tell the owner the daemon will run
     from this folder; moving it onto a released install later is a separate step the owner decides.

   - **Released** (`v5.0.0` exists). `--major` only allows the jump (it is a plain flag, combined with `--to`; `--yes` is
     still needed in an agent's shell and alone never allows the jump). It does not switch a package source, so each
     kind has its own command. Run `echo '# installing-v5 released' >> "$NOTES"` **before** it (a half-finished
     install must still show in the notes) and `echo '# installed-v5 released' >> "$NOTES"` after it succeeds:
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

     With a released install, `fy --version` must print `5.` and match the converter's tag: `git -C "$SRC" describe --tags --exact-match`
     prints `v5.0.0`.

2. **Keep the daemon off until §7.** Pin `fy` to an address nothing serves, so that a command which would call the
   daemon fails instead of starting one (an unpinned `fy` starts the daemon on its first call):

   ```bash
   export FY_URL=http://127.0.0.1:9
   ```

   (Add `echo 'export FY_URL=http://127.0.0.1:9' >> "$NOTES"` too; §7.1 removes it.) Run **only** these checks now.
   None starts the daemon:
   1. `fyd --check` — reports the state home, the harnesses and the address, and creates, locks and binds nothing. It
      must exit `0` and call the home "a Ferretry home — this daemon would use it". Exit 78 (refused home, or another
      `fyd` serving) or 69 (something else holds the address) is a stop. Show the owner every line that begins `!`.
   2. `fy config check` — every YAML file in `H/config` parses and passes its schema; it reads files only. It may fail
      **only** with the credential case in step 4 (it names a login FILE and a KEY, never a value, and says to use
      `fy secret set NAME`). That failure is expected: write the names down and go on. Any other problem is a stop,
      and so is a failure to reach a daemon (this command must read files only).
   3. `ls -la "$H"` shows only `home.json`, `config/`, `state/`, `run/`, `logs/`.

3. **Do not run `fy doctor`, `fy secret ...`, `fy config confirm` or `fy daemon start` yet.** They need the daemon,
   and `fy doctor` reports a stopped daemon as a failure by design. They run in §7 and §8.
4. **A literal credential in a v4 login file is refused in v5** (an intended difference, rebuild-parity.md). The converter
   seals the keys it recognises; `fy config check` (step 2) names any login file that still holds one. That login stays
   out of effect until repaired (v5 keeps the last good version of a file and never applies a refused one), and the
   daemon still starts, so the repair is done in §7.3, right after the start. It does not block anything else.

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

1. `unset FY_URL`, and delete the `export FY_URL=...` line from `$NOTES`. Then `fy daemon start`, and
   `echo '# started-v5' >> "$NOTES"`. This is the one deliberate start. v5 attaches to each live pane and restarts an
   attached harness only at that ferret's next idle turn (see §6).
2. `fy doctor` — names any damaged file. It now has a daemon to ask. A damaged file is a stop: tell the owner and offer
   the rollback (§9). The credential case from §5.4 may be named here too; that is expected until step 3.
3. **Repair each literal credential (§5.4). The OWNER does this, not you.** Steps 1–3 are the owner's, in the owner's own terminal or the app; you run only step 4.
   1. The owner enters the value through a masked surface, never in chat, in argv, in shell history or in a file:
      - **The app** (preferred): Settings › ‹this machine› › Secrets. Its value field is a password field and the
        page is write-only. The name is `NAME` as the config check printed it: uppercase letters, digits and
        underscores; the value is at least 8 characters.
      - **Or a terminal only the owner types into** (not yours), echo off: `stty -echo; fy secret set NAME; stty echo`.
        The owner types the value, presses Enter, then Ctrl-D on the empty line. (`fy secret set` reads standard input to
        its end and prints no prompt; `stty -echo` is what hides the typing. If it was interrupted, `stty echo` restores the terminal.)
   2. The owner rewrites that login's variable to `${secret:NAME}` (app: Settings › Files, or edit `config/logins/<id>.yaml`).
   3. v5 **holds** a login file that newly names a secret reference until the owner acknowledges it. The owner confirms
      that held edit: `fy config confirm logins/<id>.yaml` (list what waits with a bare `fy config confirm`; or Allow it in the
      app). Setting the secret does not approve the reference. Do not bypass this.
   4. `fy config check` passes, and `fy secret use --with NAME -- true` succeeds.
4. In each browser and phone: just reload the app. Paired devices stay paired (same daemon identity); each one asks
   for its passkey unlock once.

## 8. Verify

Run each check and show the owner the result. Command names are v5's; if one differs in the installed release, use
`fy --help` (or `fy <verb> --help`) to find its current name — never fall back to reading files. Any failure: stop, tell the owner, and offer the rollback (§9).
Each diff below must print nothing.

1. **Ferrets**: every ferret, stopped ones included, with the same name and parent as in the v4 note:

   ```bash
   diff <(jq -S '[.[] | {id, name, parent}]' ~/v4-ferrets-$STAMP.json) \
        <(fy ps -a --json | jq -S '[.[] | {id, name, parent: (.parent // null)}] | sort_by(.id)')
   ```

2. **Running ferrets were attached in their own panes**: every `session pane` line saved in v4 is still there, and
   `fy ps` shows each owner as live:

   ```bash
   tmux -S "$H/state/terminals/tmux.sock" list-panes -a -F '#{session_name} #{pane_id}' | sort | comm -23 ~/v4-panes-$STAMP.txt -
   ```

   Print `~/v4-pane-owners-$STAMP.tsv` (columns: ferret id, tmux session, pane id) for the owner, with `fy ps` beside it.
   Send one running ferret a short message with the owner's yes and see it answer in the same conversation.

3. **Resume**: pick one stopped ferret with the owner and resume it; it continues its old conversation.
4. **Board**: the same cards in the same lanes, every state, private cards too, across all projects:

   ```bash
   for s in open closed dropped; do
     diff <(jq '[.cards[].id]' ~/v4-board-$STAMP-$s.json) \
          <(fy board --project all --state "$s" --all --json | jq -S '[.cards[].id] | sort')
     diff <(jq -S '.cards' ~/v4-board-$STAMP-$s.json) \
          <(fy board --project all --state "$s" --all --json | jq -S '[.cards[] | {id, laneId}] | sort_by(.id)')
   done
   ```

   The first diff of each pair (card ids) must print nothing. A difference in the second (lanes) is shown to the owner,
   who decides; it is not read as proof either way. Then open one card with history and links.

5. **Agenda**: `fy ask` lists the open asks; the count and the answered one the owner named in §2.2 are there
   (`fy ask show <id>` shows an ask with its answer).
6. **Secrets by USE**: `fy secret ls` shows every name; with the owner's yes run one harmless command that uses a
   secret by name (never print it), e.g. `fy secret use --with <NAME> -- true`. It must succeed. You never see the value.
7. **No key in plain text in a login file**: `fy config check` passes (v5 refuses a login file that holds a key, so a pass is
   the proof; do not open the login files to look). Every key the converter moved out of a login file is listed in its
   summary by login, variable and secret name (`LOGIN_<ID>_<VAR>`), never by value. With the owner's yes run
   `fy secret use --with <NAME> -- true` for one of them; it must succeed. You never see the value.
8. **Devices**: on one paired phone, reload the app: it connects without pairing again and unlocks with its passkey.
9. **Sign-ins**: `fy login ls` shows every login signed in.
10. `fy doctor` is clean.

Then turn automatic updates back on if the owner had them on.

## 9. Rollback (owner's yes)

If anything in §4–§8 fails and the owner wants v4 back. First read how far the run got:
`grep '^# ' "$NOTES"` (`backed-up`, `converted`, `installing-v5`, `installed-v5`, `started-v5`). Then tell the owner what the rollback
costs and get the yes: **v4 returns exactly as it was at the backup. Anything done in v5 since §7 — messages, cards,
asks, new ferrets, new conversation lines, new secrets — is not in v4.** It stays whole in the failed v5 home
(`$H-v5-failed-$STAMP`), nothing is deleted, and it can be looked at or copied out by hand. A ferret that v5 restarted
in its pane must be restarted again once v4 is back (step 5).

1. **Quiet point first**, by the same rules as §2.3 (no daemon-started work can begin once the daemon is stopped; the
   owner messages no ferret and types into no pane; no kill of tmux). Only when `# started-v5` is in the notes, and
   only if `fy --version` prints `5.`:

   ```bash
   quiet "$([ -S "$H/state/terminals/tmux.sock" ] && echo "$H/state/terminals/tmux.sock" || echo "$B/tmux.sock")"; echo "quiet exit $?"
   fy daemon stop       # stop v5 (panes keep running)
   ```

   then `quiet` again on the same socket. Both must exit `0`; otherwise wait and repeat, or ask the owner. If
   `# started-v5` is not in the notes, no v5 daemon ever ran: skip this step. If `fy` is not on `PATH`, use the full
   path of the v5 program you installed.

2. **Homes**, guarded so each line is safe in whatever state the run stopped (a failed conversion leaves no `H`, a dry
   run creates none):

   ```bash
   if [ -e "$H" ]; then mv "$H" "$H-v5-failed-$STAMP" && chmod 700 "$H-v5-failed-$STAMP"; fi
   if [ -d "$B" ] && [ ! -e "$H" ]; then mv "$B" "$H"; fi     # the untouched v4 home, exactly as it was
   ls -ld "$H"; ls "$H/layout-version"
   ```

   `$H/layout-version` must exist: a v5 home has none, and v4 refuses it. If `# backed-up` is not in the notes, nothing
   moved and there is nothing to do here.

3. **Programs.** Act only on what changed:
   - Neither `# installing-v5` nor `# installed-v5`: v4 is still installed. Skip to step 4.
   - `# installed-v5 prerelease`: nothing was uninstalled. Remove the `export PATH=...$V5BIN...` line from `$NOTES`,
     start a new shell and check `command -v fy fyd` no longer names `$V5BIN` and `fy --version` prints `4.291.`
     (the folder `$V5BIN` can stay).
   - `# installing-v5 released` (with or without `# installed-v5 released`; a failed or half-finished install counts): put
     **4.291.10 or later** (v4) back the way this machine installs Ferretry (below).
     Until the v4 programs are back, starting the daemon runs v5, which refuses the restored v4 home. If the install
     did not finish, `fy` may be missing from `PATH`: the lines below do not need it. Pick the line for the install
     kind from §1.2:
     - **Nix profile**: remove the v5 element and install the v4 tag: `nix profile list` (the entry whose
       original flake URL is the v5 tag; its `Name:` on newer Nix, its `Index:` on older Nix), then
       `nix profile remove <element> && nix profile add github:kirinnee/ferretry/v4.291.10` (`install` instead of `add` on a
       Nix too old to know `add`)
       (or `nix profile rollback` to the generation from before §5, if it is still there and was 4.291.10 or later).
     - **nix-module** (home-manager / nix-darwin): repin the flake input to `github:kirinnee/ferretry/v4.291.10` and switch.
     - **Standalone binary**: copy the programs saved in §3 back over the v5 ones, to the paths in `$B-bin/paths.txt`
       (`$B-bin` sits beside the backup folder, not inside it, so it is still there):
       `for p in fy fyd fyd-browser-worker; do if [ -f "$B-bin/$p" ]; then cp -p "$B-bin/$p" "$(grep "/$p\$" "$B-bin/paths.txt")"; fi; done`.
     - **Homebrew**: `brew upgrade` installs what the tap has now, which is 5.x, and brew cannot pin a cask version. Check
       first which cask is installed: `brew list --cask | grep -x 'ferretry\(@4\)\?'`. If `ferretry@4` is installed
       already, there is nothing to do. If `ferretry` is, the way back is the separate v4 cask `ferretry@4` (released
       with 4.291.10): `brew uninstall --cask ferretry && brew install --cask kirinnee/ferretry/ferretry@4`.
     - **deb/rpm**: install the 4.291.10 (or later 4.x) package of `fy` from the package source, if it still keeps that version.
4. `fy --version` must print `4.291.`. Then `fy daemon start` (or `fy daemon restart` if it says v4 is running). v4 finds
   its home and its live tmux server as it left them.
5. Ferrets that v5 restarted in their panes (§6) carry v5 hooks; with the owner's yes restart those from v4 (`fy restart`,
   or the app), and check one answers.

A migrated v5 home is **refused by v4 with nothing written** (it has no `layout-version`), so the `mv "$B" "$H"` above is
the way back: without the backup there is no v4 home to go back to. Tell the owner the failed v5 home is at
`$H-v5-failed-$STAMP` (it holds copies of sealed files: they decide when to delete it).

## 10. Afterwards

- **Keep the backup.** `B` (`$H-before-$STAMP`) stays until **the owner** deletes it. Never delete it yourself. v5
  fences every `<home>-before-*` folder and never reads it. It holds the old vault, key and sign-ins, so it stays `0700`.
- Report to the owner: the converter's summary, the §8 results, the commit in `$NOTES` (`COMMIT`), and where the backup,
  the report and the `~/v4-*-$STAMP.*` notes are.
- Do not delete `$SRC` (or, on a pre-release run, `$V5BIN`, which the daemon runs from) until the owner says this machine is done.
- **When all three machines are on v5**, the converter is deleted from the repository (`git rm -r migration/v4-to-v5 scripts/validate/migration-isolated.sh`
  and its wiring), together with this prompt's reference to it. Say so to the
  owner when you report the last machine.
