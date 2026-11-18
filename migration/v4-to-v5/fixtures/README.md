# v4 fixture homes

Builds realistic **Ferretry 4.291.15** homes with the **released v4 binaries**, so the converter in `../` is tested
against real v4 output rather than hand-written files. Nothing here is part of the product, and all of it is deleted
with the converter.

## What it builds

`build-v4-home.ts` starts the v4 `fyd` against a throwaway `FY_HOME` (`<out>/home`, private tmux server on
`<out>/home/tmux.sock`, fake `claude`/`codex` from `support/`) and creates, through the v4 `fy` CLI and the daemon's HTTP
API:

- a project (a git repo), and ferrets: a parent with two sub-ferrets (lineage), one ended ferret, one interactive ferret
  left running in its pane
- queued messages and a shared draft for the running ferret, a pinned note and a pinned ferret
- board cards in two lanes, with a link, a dependency and history; agenda asks (one closed, one answered and held for the ferret, one open; each state as v4 itself lists it) and a notice
- a lesson suggestion, one secret set **by name** (the value is the constant `fixture-not-a-secret`), and a paired
  device (a code minted, redeemed with a generated device key)

Then it stops `fyd` politely and, unless `--keep-panes`, kills its tmux server **by its own socket**. It writes
`<out>/made.json`: everything created, by id and name — never a value. A step the v4 CLI cannot do is recorded there as
`skipped` with the reason (for example, an archived ferret needs the ferret to have been ended for a day); a v4 file is
never written by hand.

## Run it

```bash
v4_dir="$(bash fetch-v4.sh)"          # the ONLY network access: one download of the v4.291.15 release, SHA-256 checked, cached
out="$(mktemp -d)"                    # must be under the OS temp dir and empty, or the builder refuses
bun build-v4-home.ts --out "$out" --v4-dir "$v4_dir"
bun ../src/main.ts --from "$out/home" --to "$out/v5" --dry-run
```

`fetch-v4.sh` caches under `${XDG_CACHE_HOME:-~/.cache}/ferretry-v4-fixtures/4.291.15/`; it uses `gh` when signed in and
the public URL otherwise.

## `--rich`: a lived-in home (for side-by-side sweeps)

`bun build-v4-home.ts --out <dir> --v4-dir <v4> --rich` keeps the default fixture untouched and adds `rich-home.ts` on top
of it, still only through v4's own CLI and HTTP API: more projects; 23 ferrets in every state with real transcripts
(tool calls, an image, an AskUserQuestion, a permission prompt, queued messages, a draft); board cards across lanes;
agenda items in every state; five logins (two signed in through the daemon's own flow, fake credentials only) with
budgets, runtimes, profiles and components; secrets by name; warden, voice, learning and pack config; terminals; a browser
profile; a second device. What v4 cannot create is recorded as `skipped` in `made.json`. `--keep-panes` leaves v4's tmux
alive and `--port <n>` pins the daemon's port. The directives that make the fake claude play a script
(`FIXTURE-REC`, `FIXTURE-RUN`, in `support/fake-claude-rich.ts` and `fake-claude-tui.sh`) answer only when `FY_FIXTURE_RICH` is set.

`sweep/` builds on it: `sweep-up.sh <1..9>` brings up a v4 daemon and a 5.0 daemon (a converted copy) side by side under
`/tmp/claude-1000/sweep/slot<N>/`, `sweep-down.sh <N>` stops them. Each daemon is a transient **user service** (`fy4-slot<N>.service`, `fy5-slot<N>.service`: restarts after a crash,
`KillMode=process`) and each side's tmux server runs in its own scope (`fy<4|5>-slot<N>-terminals.scope`), so neither sits in the cgroup of
whoever ran the kit; `slot.ts status <N>` prints each unit's state and cgroup. By default a slot does not survive a reboot (it lives under `/tmp`).
`slot.ts persist <N> [dir]` makes ONE slot survive one: it stops the slot, moves its folder to `dir` (default
`~/.local/share/fy-sweep/slot<N>`, refused inside `/tmp`, the sweep root or any of `~/.ferretry*`, `~/.claude*`, `~/.codex*`,
`~/.secrets`), leaves `/tmp/claude-1000/sweep/slot<N>` as a symlink to it (every unit recreates it before it starts, because `/tmp` is
empty after a boot; the homes record absolute paths of themselves, so nothing inside a home is rewritten), copies the v4 programs and
the fake ferret's helper into the slot, and installs **enabled user units** in `~/.config/systemd/user/`
(`fy4-slot<N>.service`, `fy5-slot<N>.service`, and `fy<4|5>-slot<N>-terminals.service` for each tmux server; `Restart=on-failure`,
`KillMode=process`, the same allow-list env file at mode 0600 through `fyd-exec.sh`, `%` and `$` escaped in every path). Identity, devices
and data are the same files; only the ferrets' panes are not kept (each side revives them, as after a restart). Starting at boot with
no login needs `loginctl enable-linger`; `persist` says whether it is on and never turns it on itself. `slot.ts unpersist <N>` is the
reverse. A persisted slot refuses `up` and `down` (without `--keep-files`) until it is unpersisted.
A persisted slot's CLI wrappers survive a reboot too: `fy4s<N>` / `fy5s<N>` live in `<persistent folder>/bin/` and run `bun` on a COPY of
the kit in `<persistent folder>/kit/` (`slot.ts` and the files it imports, so no git worktree path is involved). The shared
`/tmp/claude-1000/sweep/bin/fy?s<N>` are only links to them for PATH habits: gone at boot, put back by the next `slot.ts` command
(`status`, `wrappers`, `cli`, …); call the persistent path directly, or point your own launcher at it (`exec '<folder>/bin/fy5s<N>' "$@"`).
`slot.ts wrappers <N>` (re)writes ONLY those wrappers, the links and the kit copy of an already persisted slot (also how a slot an older
kit persisted gets them): it stops and starts nothing, runs no `systemctl`, touches no file in either home and leaves the unit files alone,
so it is safe against a slot in use. `unpersist` removes `bin/` and `kit/` with the rest of what `persist` added.
The fixture's Codex login (`codex-main`) carries a fake `auth.json` (`sweep/fake-codex-auth.ts`: made-up markers, never a real token), so
`codex-main-agent` counts as signed in and can resume.
`slot.ts real-claude <N> on <login> | off` is the ONE exception to "no real model": one real Claude for one login on a persisted slot's 5.0 side (see [`sweep/SWEEP.md`](sweep/SWEEP.md)).
It is a developer tool (it starts daemons); CI does not run it.

## Boot v5 on the converted home

`boot-v5.ts --fixture <out>` starts this repository's v5 `fyd` (from source, `--port 0`, a disposable `HOME`) on the
converter's real output `<out>/v5`, which must be complete, after booting it on an empty home as a baseline. It fails for
any plugin v5 reports down on the converted home alone (one down on the empty home too is v5's bug: a warning) — a state file it
refuses (named `state/<plugin>/<file>`), a plugin that failed or needs one that did, a folder moved aside — and checks
through v5's own routes that the ferrets, project, cards and agenda items in `made.json` are there. While v5's Gate is a
skeleton every authenticated route answers `503 admission_unavailable`, so those data checks are skipped with a warning
until it lands. It stops the daemon with SIGTERM and kills the tmux server on the home's own socket, and writes
`<out>/boot/` (`summary.json`, `fyd.stderr`, `fyd.log`). It starts a daemon: CI only.

## CI only on shared boxes

The builder runs a daemon and a tmux server. On a shared developer box, do not run it: the workflow
`.github/workflows/migration-v4-to-v5.yaml` does, on every push to a `rebuild/**` branch that touches
`migration/v4-to-v5/**`, and uploads `made.json` and the conversion reports. `bash -n`, `shellcheck`, and
`tsc --noEmit -p fixtures` are safe anywhere.

## What is copied from v4

`support/` is this tool's own copy of v4 test code (the v5 packages no longer carry it): the fake `claude` TUI and fake
`codex`, and in `support/pairing/` the slice of the relay session protocol (frames, handshake, sealed records, device
proof) with the v4 test session client, so a device can pair with a generated key exactly as a browser does.
