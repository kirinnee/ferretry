# v4 fixture homes

Builds realistic **Ferretry 4.291.5** homes with the **released v4 binaries**, so the converter in `../` is tested
against real v4 output rather than hand-written files. Nothing here is part of the product, and all of it is deleted
with the converter.

## What it builds

`build-v4-home.ts` starts the v4 `fyd` against a throwaway `FY_HOME` (`<out>/home`, private tmux server on
`<out>/home/tmux.sock`, fake `claude`/`codex` from `support/`) and creates, through the v4 `fy` CLI and the daemon's HTTP
API:

- a project (a git repo), and ferrets: a parent with two sub-ferrets (lineage), one ended ferret, one interactive ferret
  left running in its pane
- queued messages and a shared draft for the running ferret, a pinned note and a pinned ferret
- board cards in two lanes, with a link, a dependency and history; agenda asks (one answered, one open) and a notice
- a lesson suggestion, one secret set **by name** (the value is the constant `fixture-not-a-secret`), and a paired
  device (a code minted, redeemed with a generated device key)

Then it stops `fyd` politely and, unless `--keep-panes`, kills its tmux server **by its own socket**. It writes
`<out>/made.json`: everything created, by id and name — never a value. A step the v4 CLI cannot do is recorded there as
`skipped` with the reason (for example, an archived ferret needs the ferret to have been ended for a day); a v4 file is
never written by hand.

## Run it

```bash
v4_dir="$(bash fetch-v4.sh)"          # the ONLY network access: one download of the v4.291.5 release, SHA-256 checked, cached
out="$(mktemp -d)"                    # must be under the OS temp dir and empty, or the builder refuses
bun build-v4-home.ts --out "$out" --v4-dir "$v4_dir"
bun ../src/main.ts --from "$out/home" --to "$out/v5" --dry-run
```

`fetch-v4.sh` caches under `${XDG_CACHE_HOME:-~/.cache}/ferretry-v4-fixtures/4.291.5/`; it uses `gh` when signed in and
the public URL otherwise.

## CI only on shared boxes

The builder runs a daemon and a tmux server. On a shared developer box, do not run it: the workflow
`.github/workflows/migration-v4-to-v5.yaml` does, on every push to a `rebuild/**` branch that touches
`migration/v4-to-v5/**`, and uploads `made.json` and the conversion reports. `bash -n`, `shellcheck`, and
`tsc --noEmit -p fixtures` are safe anywhere.

## What is copied from v4

`support/` is this tool's own copy of v4 test code (the v5 packages no longer carry it): the fake `claude` TUI and fake
`codex`, and in `support/pairing/` the slice of the relay session protocol (frames, handshake, sealed records, device
proof) with the v4 test session client, so a device can pair with a generated key exactly as a browser does.
