# Move one machine from Ferretry 4 to Ferretry 5, keeping everything

**This is a prompt.** Paste everything below the line into an agent (Claude Code or Codex) running **in a terminal on
the machine being moved**, with the owner at hand. Run it once per machine, one machine at a time. It replaces the
older clean-slate runbook ([clean-slate-prompt.md](clean-slate-prompt.md)), which threw sign-ins, secrets and paired
phones away: this one keeps them.

Why it is a prompt and not a feature: Ferretry 5 contains **no code that reads a v4 home** (owner decision A452,
addendum 2 of 2026-11-07: "dont include the migration IN code itself, because we dont want backward compatibility as a
deadweight"). The one-time converter and its driver script, `migration/v4-to-v5/migrate.sh`, live in the repository
outside every package, and are **deleted from the repository once all three machines are on v5**. What the converter
reads is listed in [v4-formats.md](v4-formats.md).

---

You are moving this machine's Ferretry from **v4 (4.291.10 or later)** to **a released v5**, keeping all data and every
ferret. Every mechanical step is one tested script, `migrate.sh <phase>`. Your job is to ask the owner the questions
below, run the phases in order, **read each phase's output**, and show it to the owner. **A phase that exits non-zero is
a stop: tell the owner what it printed, and never improvise around it.** The exit codes mean: `1` refused or failed,
`2` something could not be inspected, `3` (convert) the converter says a step would not finish, `64` wrong usage.

## Rules you keep for the whole run

- **Never open a secret.** You never `cat`, `less`, `head`, `jq`, `grep`, `diff`, hash or otherwise read any file named
  in [v4-formats.md](v4-formats.md) as sealed or secret (the vault and its key, login and OAuth secrets, identity and
  push keys, `api-token`, `api-warden-token`, `sessions/*/environment.json`, anything under `fleet/credentials/`, any
  `auth.json`, `.credentials.json` or `.claude.json`) in the old home, the backup or the new home. The script and the
  converter move them byte for byte and never print one. Never print a token, key, pairing code or secret, and never
  paste one into chat.
- **Never touch the harness's own sign-in folders** outside the home (`~/.claude*`, `~/.codex*`, the macOS keychain).
- **Never kill the tmux server** (`tmux … kill-server`, `pkill`, `killall`) and never run `fy daemon reset`. Ferrets keep
  running in their panes the whole time; that is how they are kept.
- Do not use any Ferretry tool (`fy`, the app, an MCP tool) to read the old home or the backup yourself; the script does
  the only reading, and only of names and metadata.
- **Run in `bash`.** Each tool call may begin in a fresh shell, so pass the notes file on every call: `--notes "$NOTES"`.
  The script never changes your shell: you export nothing (no `PATH`, no `FY_URL`, no `FY_HOME`, no `FY_PORT`). Every
  phase runs `fy`/`fyd` with the home and port recorded at `preflight`, whatever your shell holds later. A `FY_URL` that
  carries credentials or names another machine makes `preflight` refuse (unset it for the switch); a query or fragment on a
  loopback address is dropped, never copied.

## What is left behind (tell the owner before they confirm anything)

The owner chose **not** to carry these over (decision !A516, "Leave them"). Read this list to the owner before the first
decision below, and again in your final report. `preflight`, `backup` (until the owner says yes), `verify` and the
converter's summary print the same list from one file, `migration/v4-to-v5/left-behind.txt`.

- chat history (old conversations and transcripts)
- agents' browser sign-ins (the agent browser profile)
- named agent terminals
- the Warden machine agenda item
- some security history (Gate kept-bucket and grant audit history)

**Nothing is deleted.** v4's home is kept untouched at `<home>-before-<stamp>` (the backup; `preflight` prints the exact
path), so the owner can look back at any of it. To look: open that folder, or copy it and run v4's `fy` against the copy
(`FY_HOME=<copy>`). Do not start v4 on the original; it must stay as it is for a rollback.

## Decisions the owner makes

Ask these first, one at a time, and wait.

1. **Is this the machine to move now?** One machine per run. v4 stops being usable here until the end or a rollback.
2. **Which released tag?** The real switch runs **only from a released 5.0** (`v5.0.0` or later): there is no
   pre-release install path for the owner's machine, and `preflight` refuses a checkout that is not exactly a `v5.N.N`
   tag. If 5.0 is not released yet, stop and say so.
3. **The quiet window.** The owner stops messaging ferrets and says all four: no ferret is mid-turn, phone approvals and
   input holds are answered or dismissed (v4 closes approval cards at a daemon stop), no ferret runs a loop or timer inside
   its own harness, and nobody will type into a pane until the end. You pass `--owner-confirmed` only after hearing this.
4. **The agenda count.** The owner opens the app's Agenda and tells you how many asks are open, and the title of one
   that has an answer. You pass `--asks-open N` (and `--answered-ask "<title>"`).
5. **The backup (owner's yes).** Say: "I will move the Ferretry home aside; that folder is the backup and stays untouched
   until you delete it." With their yes you pass `--owner-yes`.
6. **If the install kind is not Homebrew, a nix profile or a standalone binary** (nix-module, deb/rpm), `preflight --kind
manual` has the owner install v5 by hand; ask how this machine installs Ferretry.

## Run it

Get the v5 repository into a **fresh folder** (never reuse, reset or clean an existing clone) at the released tag, and
run the script from there. The converter and the programs are then one tag by construction:

```bash
TAG=v5.0.0   # the tag the owner named
SRC="$HOME/ferretry-v5-src-$(date -u +%Y-%m-%d-%H%M)"
git clone --no-checkout https://github.com/kirinnee/ferretry "$SRC" && git -C "$SRC" checkout --detach "$TAG"
S="$SRC/migration/v4-to-v5/migrate.sh"
bash "$S" preflight
```

`preflight` prints `NOTES=<path>`: use that path as `$NOTES` from now on. Then, each followed by showing its output to
the owner:

| Phase                     | What it does                                                                                                                                                                                                                                                                                                                                              | Owner / you                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `preflight`               | tools present, v4 is 4.291.10 or later, this checkout is a released v5 tag the install kind can get, disk space; records the original `PATH`, whether `FY_URL` (a plain loopback address only) and `FY_PORT` were set, and where v4's `fy`/`fyd` are (never a secret). `MIGRATE_REHEARSAL=1` on the default home is refused here, before anything changes | stop on any exit                                                                   |
| `baseline --asks-open N`  | saves what v4 holds now into a folder beside the notes: every ferret (id, **callsign and title kept apart**, parent, state), pane map, board ids and lanes of every state (stops at the 500-card limit), login names, secret **names**. An empty fleet (no live ferret) is a defined path                                                                 | the owner's agenda count                                                           |
| `quiet --owner-confirmed` | no pane writes for a minute, stops the v4 daemon, proves it again, checks nothing is half-done. Panes and tmux keep running                                                                                                                                                                                                                               | exit `1` = still writing or something pending: wait, ask again, rerun from the top |
| `backup --owner-yes`      | `mv` the home to `<home>-before-<stamp>` (mode 700)                                                                                                                                                                                                                                                                                                       | the owner's yes                                                                    |
| `convert`                 | converter dry run (own report), then the real run, exit codes checked. Writes the new home with `home.json` last                                                                                                                                                                                                                                          | show the printed summary; exit `3` → rollback or wait for a fixed converter        |
| `install`                 | puts the released v5 programs in place for the recorded install kind (cask, nix profile element, standalone), proves `fy --version` is the tag. **Never starts the daemon**                                                                                                                                                                               | stop on any exit                                                                   |
| `start`                   | `fyd --check`, `fy config check` (offline: nothing can start a daemon), the home holds only what v5 makes, then **the one deliberate daemon start**, proved by asking it                                                                                                                                                                                  | show every `!` line                                                                |
| `verify`                  | compares v5 with the baseline and prints a table: ferret ids, parents, callsigns (v4 callsign = v5 name), titles, panes, board ids (lanes are shown to the owner), logins, secret names, asks, `fy doctor`                                                                                                                                                | a `FAIL` row is a stop; a `REVIEW` row is for the owner to decide                  |

`fy config check` may name a login file that still holds a literal key: that is expected and the **owner** repairs it
(below), after `start`. Any other `config check` failure stops the run.

### Repair each literal credential (the owner does this, not you)

v5 refuses a literal credential in a login file (an intended difference); the converter seals the keys it recognises, and
`start` shows any it did not (the login file and key, never the value). That login stays out of effect until repaired; the
daemon is up regardless.

1. The owner **chooses one unique valid name per repaired credential** (uppercase letters, digits, underscores) and
   writes down login, key and chosen name (no value). `NAME` in `fy secret set NAME` is a placeholder, not a name
   `fy` allocates; reusing one name for several keys would point several sign-ins at one value.
2. The owner enters the value through a masked surface, never in chat, argv, shell history or a file: the app's
   Settings › ‹this machine› › Secrets (a password field, write-only), or in a terminal only they type into:
   `stty -echo; fy secret set <NAME>; stty echo`, type the value, Enter, then Ctrl-D on the empty line. (At least 8
   characters.)
3. The owner rewrites that login's variable to `${secret:<NAME>}` (app: Settings › Files, or `config/logins/<id>.yaml`).
4. v5 **holds** a login file that newly names a secret until the owner confirms it: `fy config confirm logins/<id>.yaml`
   (a bare `fy config confirm` lists what waits), or Allow it in the app. Do not bypass this.
5. You run `fy config check` and `fy secret use --with <NAME> -- true`; both must succeed. You never see the value.

## What is kept, item by item

Tell the owner this list before `start`, and say which items the converter summary showed as converted.

| Item                                                                                                                               | Kept?               | How                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every ferret, live and archived: id, callsign, title, lineage (parent/child, pack), project, runtime, start options, pins, history | **Kept**            | converted into Ferrets                                                                                                                                                                                                                                                                       |
| Running ferrets                                                                                                                    | **Kept, same pane** | v5 attaches to each live tmux pane by its handle (no new window, no lost turn). A ferret whose pane is gone is resumed from its harness conversation id. At its next idle turn, an attached harness is restarted in that same pane with resume, so its hooks and tools are v5 (no lost turn) |
| Harness conversations (Claude Code / Codex transcripts, chat history)                                                              | **Left behind**     | not carried (see the left-behind list above)                                                                                                                                                                                                                                                 |
| Message queue, shared drafts (chat and ask replies), turns, attachments, renders                                                   | **Kept**            | converted into Conversation                                                                                                                                                                                                                                                                  |
| Board: cards, lanes, links, dependencies, history; projects                                                                        | **Kept**            | converted                                                                                                                                                                                                                                                                                    |
| Agenda: asks, answers, notices                                                                                                     | **Kept**            | converted into Asks and Agenda                                                                                                                                                                                                                                                               |
| Lessons, usage history and budgets, warden history and settings                                                                    | **Kept**            | converted                                                                                                                                                                                                                                                                                    |
| Catalogs and shares (published catalogs, links, members, installs)                                                                 | **Kept**            | converted; link keys moved sealed; the skill folders you installed are copied to the new home byte for byte                                                                                                                                                                                  |
| Settings, layouts, runtimes, profiles, logins                                                                                      | **Kept**            | YAML split per v5 owner; comments kept                                                                                                                                                                                                                                                       |
| Changes you had confirmed that loosen a setting (e.g. skipping agent permissions, a raised cap)                                    | **Kept**            | your v4 confirmations move with them, so v5 does not ask again. If v4 was still waiting for you to confirm a change when it stopped, none are carried and v5 asks again (the summary names the file)                                                                                         |
| MCP server sign-ins (OAuth)                                                                                                        | **Kept**            | the sign-in records move, and the sealed refresh tokens move byte for byte with the vault key that opens them                                                                                                                                                                                |
| Security log (pairings, grants, secrets used)                                                                                      | **Kept, in part**   | the v4 logs are merged into one v5 log, names and ids only, EXCEPT the Gate kept-bucket and grant audit history, which is left behind                                                                                                                                                        |
| Harness sign-ins                                                                                                                   | **Kept**            | the sign-in folders move whole; never read                                                                                                                                                                                                                                                   |
| Secrets                                                                                                                            | **Kept**            | the sealed vault and its key move byte for byte; no existing value is ever opened. A key v4 had saved in plain text in a login file is sealed into the vault as `LOGIN_<ID>_<VAR>` and the login file names it with `${secret:…}` (listed by name in the summary)                            |
| Paired phones and browsers, passkeys, unlock settings, push                                                                        | **Kept**            | the daemon identity, device public keys, grants, passkey ids and push keys move as they are. See **Devices and passkeys** below                                                                                                                                                              |
| Admin and warden tokens                                                                                                            | **Kept**            | moved byte for byte, never opened; `fy` keeps working without signing in again                                                                                                                                                                                                               |
| Global lessons (the rules applied from Lessons)                                                                                    | **Kept, wider**     | they now reach EVERY ferret, where v4 gave them only to ferrets whose profile listed `instructions/lessons`; that profile entry is removed, so no ferret gets them twice                                                                                                                     |
| Model routing catalog (`routing.json`: scores, floors, weights)                                                                    | **Not kept**        | v5 picks models by the routing prompt and `fy recommend`; the runtimes v4 never suggested are named in one line added to the end of your routing prompt (or listed in the summary when you had no prompt of your own)                                                                        |
| Pairing codes                                                                                                                      | **Not kept**        | single-use, two minutes long                                                                                                                                                                                                                                                                 |
| Live unlocks                                                                                                                       | **Not kept**        | each device unlocks again with its passkey, once                                                                                                                                                                                                                                             |
| In-flight input holds                                                                                                              | **Not kept**        | a hold mid-delivery is closed and its pane quarantined, as at any restart                                                                                                                                                                                                                    |
| Caches (session index, analytics, search) and per-login usage readings                                                             | **Rebuilt**         | v5 rebuilds them from the kept files, and measures usage afresh                                                                                                                                                                                                                              |

## Devices and passkeys: nobody re-pairs

Released 5.0 serves its hosted app at **`https://ferretry.pages.dev`, the same origin v4 links to**, so existing paired
phones and browsers and their passkeys **keep working**. Each device just reloads the app and unlocks once with its
passkey; nothing is paired again. Why this is true, in source: v4 pairs against `HOSTED_APP_ORIGIN =
'https://ferretry.pages.dev'` (`packages/protocol/src/lib/pairing.ts`); a released v5 build embeds
`DEFAULT_HOSTED_APP_ORIGIN`, the same address, because no define overrides it (`packages/core/kernel/contract/hosted-app.ts`,
`scripts/ci/hosted-app-origin.sh`, `scripts/release/compile.sh`), and the production workflow deploys the app with no
override (`.github/workflows/pwa-pages.yaml`, from `main`); a passkey's relying-party id is the hostname of its origin
(`relyingPartyId` in `packages/plugins/access/daemon/lib/passkeys/verifier.ts`), and the converter carries each passkey
with its origin unchanged. The one exception is the **preview** app (`ferretry-v5.pages.dev`), a different origin whose
passkeys are not interchangeable: it exists only for rehearsing this migration in a sandbox (`install --rehearsal-build`,
for a fake home, never a real one) and is never used on the owner's machine.

## Check by eye, with the owner (after `verify` passes)

`verify` proves the data; these need a person. Show the owner each result.

1. Send one running ferret a short message (owner's yes) and see it answer in the same conversation; its pane is the one
   from the baseline. v5 restarts an attached harness only at its next idle turn.
2. Resume one stopped ferret with the owner; it continues its old conversation.
3. Open one card with history and links. Show the owner every `REVIEW` row of `verify` (lane differences, fallback
   callsigns, dropped titles) and let them decide.
4. `fy ask show <id>` for the answered ask the owner named: the answer is there. `fy login ls`: every login is signed in.
5. Reload the app on one paired phone: it connects without pairing and unlocks with its passkey.
6. `fy secret use --with <NAME> -- true` (owner's yes) for one secret by name. It must succeed; you never see the value.

**An item that does not exist on this machine** (no running ferret, no stopped ferret, no card with history, no answered
ask, no paired phone, no named secret): ask the owner to confirm there is none and write it down as
`SKIP: <item> (owner confirmed there is none)` in your report. Never invent a substitute and never call a skipped item
checked.

Then turn automatic updates back on if the owner had them on.

## Rollback (owner's yes)

If any phase from `convert` on fails, or `verify` or the checks above fail, and the owner wants v4 back, say what it
costs and get the yes: **v4 returns exactly as it was at the backup. Anything done in v5 since the start (messages,
cards, asks, new ferrets, new conversation lines, new secrets) is not in v4.** It stays whole in the failed v5 home
(`<home>-v5-failed-<stamp>`); nothing is deleted. Then:

```bash
bash "$S" rollback --notes "$NOTES" --owner-yes            # add --restart once the owner agrees to the line below
```

`rollback` reads the notes, so it acts only on what happened: it reaches a quiet point and stops any v5 daemon (proved
by the process list, not by a marker), moves the v5 home aside only if the backup exists, restores the backup, puts the
v4 programs back from the recorded state (including "neither installed"), restores the recorded `PATH` and `FY_URL`
exactly, starts v4, and restarts **only the recorded ferrets by id**: v5 may have relaunched their harnesses with its own
hooks, so `--restart` runs `fy restart <id>...` (bare `fy restart` only reports status). If it exits non-zero, read what
it printed and tell the owner; it is safe to run again. It proves the panes quiet before it moves anything, whether or not
a daemon is running, and it decides what a live `fyd` is from the notes, not from the `fy` now on the PATH: if that
`fyd` is the v5 one and no v5 `fy` is left to stop it, it refuses and moves nothing. For an install kind `manual` it
restores the homes, then stops and asks the owner to put the v4 programs back by hand; **run `rollback` again after
that** and it checks that `fy` and `fyd` print 4.291.x and finishes (starts v4, restarts the recorded ferrets).

## Afterwards

- **Keep the backup.** `<home>-before-<stamp>` stays until **the owner** deletes it. Never delete it yourself. v5 fences
  every `<home>-before-*` folder and never reads it. It holds the old vault, key and sign-ins, so it stays `0700`.
- Report to the owner: the converter's summary (it ends with the left-behind list and the path of the v4 home), repeat that list in plain words, the `verify` table, the commit in `$NOTES` (`COMMIT`), and where the
  backup, the report, the baseline folder and the notes are.
- Do not delete `$SRC` until the owner says this machine is done.
- **When all three machines are on v5**, the converter and its script are deleted from the repository
  (`git rm -r migration/v4-to-v5 scripts/validate/migration-isolated.sh` and its wiring), together with this prompt's
  reference to them. Say so to the owner when you report the last machine.
