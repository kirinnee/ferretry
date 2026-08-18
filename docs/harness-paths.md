# Where the harnesses are

This document is the contract for how a Ferretry daemon decides where `claude` and `codex` live on
the host it is running on, what an operator may say about that, and what it reports back.

It is about **discovery only**. Nothing here changes how a session launches: a start still resolves
an account to the **absolute wrapper path the fleet manifest publishes** and launches that, never a
harness command. See [CLAUDE.md](../CLAUDE.md) for why that rule exists.

## The bug this exists for

The daemon located a harness with a `which`-style lookup against **its own** environment. A daemon
started by **systemd or launchd at login inherits a minimal environment** — not the operator's
interactive shell — so `claude` works perfectly in their terminal and is invisible to their daemon.
There was nothing they could write down to fix it.

The CLI had already solved exactly this for the daemon binary: `resolveDaemonBinary` in
`packages/cli/bin/fy.ts` reads `FY_DAEMON_BIN` before falling back to a `PATH` lookup, _because_
"systemd requires an absolute ExecStart, so a bare name on PATH is resolved here". The harnesses got
no equivalent. This document is that equivalent.

## What an operator may say

Two surfaces, and **both** exist on purpose. A unit file can set an environment variable and cannot
edit a JSON document; an operator with a shell can edit the document and should not have to write a
unit file. Offering only the variable would move the problem rather than fix it.

### `config/daemon.json`

```jsonc
{
  "harness": {
    // The exact file to run for one harness. Absent means "search for it".
    "paths": { "claude": "/opt/harnesses/claude" },
    // Directories to look in, in order, on top of whatever this daemon inherited.
    "searchPaths": ["~/.local/bin", "/opt/homebrew/bin"],
  },
}
```

Every value is a path: **absolute, or written against `~`**. A relative path is refused when the
document is parsed, because this daemon's working directory is whatever a service manager handed it,
so `bin/claude` names a different file depending on where the unit happened to start. `~` is
expanded when the declaration is read. **No credential belongs in this block, and none is one** —
this file travels into backups and screen shares like the rest of the document it sits in.

### Environment

| Variable          | Means                                                              |
| ----------------- | ------------------------------------------------------------------ |
| `FY_CLAUDE_BIN`   | The exact file to run for Claude                                   |
| `FY_CODEX_BIN`    | The exact file to run for Codex                                    |
| `FY_HARNESS_PATH` | Extra directories to search, colon-separated, as `PATH` is written |

A **blank** variable has said nothing: `FY_CLAUDE_BIN=` is not an override.

## The resolution rule

One rule, in the order an operator would expect it, applied per harness:

1. **explicit override** — the path they named, from `FY_<KIND>_BIN` or `harness.paths.<kind>`.
2. **extra search path** — `<directory>/<kind>` for each declared directory, the environment's
   first, then the document's.
3. **inherited environment** — the ordinary `PATH` lookup this daemon has always done.

**The environment outranks the document**, per harness. Somebody repairing a service-managed daemon
edits the unit file, and a document that quietly outranked it would make that edit look ignored —
which is the same silent-configuration failure this whole surface exists to end. Nothing is hidden
by the choice, because every report names the key that produced the answer.

**A named path that this host cannot run is a stated failure, never a fallback.** An operator who
names a path has told the daemon something specific; searching on from there would find some other
`claude`, report success, and leave them believing they had configured something they had not. The
failure names the key to correct and says what the absence breaks.

**Nothing is ever launched to find out.** Every step is a lookup or a stat. Running an
operator-named binary as a side effect of a health check is not something this daemon does, and a
`--version` that hung would hang the boot.

**A declaration is read once per boot; the lookup is not.** Declarations are configuration and
change when the daemon is restarted, exactly like every other value in that document. Whether a
harness is installed _right now_ is asked at the moment of the lookup, so a harness installed after
the daemon came up is still found.

## What it reports

Every surface reports **which harnesses were found, the absolute path each resolved to, and which
rule produced it** — and, when one is not found, what that breaks.

- **At boot**, as a `harness commands located` milestone naming each harness, its path and its rule.
  It is said every time, not only on failure: an operator who has just written a line has no other
  way to see whether this daemon read it.
- **At boot, as an unfilterable notice**, when an explicit override names nothing runnable.
- **`fyd --check`**, as a `command` line per harness beneath the existing `harness` line, plus the
  consequence of each absence.
- **The doctor report** (`GET /v1/doctor` and the settings surface it feeds), as one check per
  harness. The report's own promise is "programs this daemon host needs, and what each absence
  breaks", and `found on PATH` answered neither _which_ `claude` nor whether an override took.

The doctor's stated limitation carries the same caveat it always did, widened by one clause:
resolving a program and stating that this host could run it is all any of this proves. **Nothing
here was launched**, so none of it says a harness is signed in, in credit, or able to reach its
provider.

## Where the code is

- `packages/daemon/src/lib/core/harness-readiness.ts` — the document schema, the declaration
  reading, the resolution rule, and every sentence built from them. There is **one** detector; a
  second one would be a second notion of what "installed" means.
- `packages/daemon/src/lib/runtime/config.ts` — the `harness` key on the operator's document.
- `packages/daemon/src/lib/core/doctor.ts` — the per-harness checks.
- `packages/daemon/bin/fyd.ts` — the only place both surfaces are available at once, so the
  declarations are read there, once, and handed to every reporter.

## Declared GAPs

- **The launch half is untouched.** A published wrapper runs `claude` from _its own_ inherited
  environment when a session starts, and a declared path or search directory does not reach that
  wrapper. Discovery now reports the truth about a service-managed host; making a session inherit
  the same declarations is a separate change to how sessions launch, which this one deliberately
  does not make.
- **There is no way to set this without editing a file.** Both surfaces are hand-edited — a JSON
  document or a unit file. A route and a settings panel would need the mutation machinery the grant
  surface has and this one does not; the daemon at least _reports_ what it read, from three places.
- **Only the document's declarations are schema-checked.** No schema stands between a unit file and
  the reader, so a relative directory in `FY_HARNESS_PATH` is kept rather than dropped: it finds
  nothing, and the report names every directory that was searched.
- **A resolved path is not verified to be the harness it claims to be.** A file named `claude` in a
  declared directory is reported as Claude. Confirming that would mean running it.
