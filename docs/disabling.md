# Switching a login or a runtime off

A login that has hit its provider's spend limit, or a runtime you want to rest, can be **switched off
without being deleted**. (To have a login switch itself off at a dollar amount, give it a budget instead:
[budgets.md](budgets.md). A budget holds a login through the same mechanism described below.) Nothing new starts on it; nothing already running is touched; one command
(or one tap) switches it back on.

## The switch

```yaml
# logins/liftoff.yaml                 # runtimes/liftoff-agent.yaml
harness: claude                       credential: liftoff
store: ferretry                       profile: default
disabled:                             disabled:
  reason: monthly spend limit           reason: resting it
  until: 2026-11-01
```

| Field    | Means                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `reason` | Why, in your words (1–200 characters). Shown beside the switch and in every refusal.                                                                               |
| `until`  | When it switches itself back on: a date (`2026-11-01`, the **start of that day in UTC**) or a time (`2026-11-01T09:00:00Z`). Absent: off until someone enables it. |

A `disabled` on a **login** switches off every runtime on it. A `disabled` on a **runtime** switches
off only that runtime. Both can be set; the runtime's own block is the one shown.

`fy config check` validates the block (strict keys, a readable `until`, a reason within the limit). An
`until` already in the past is not an error: it is simply no longer in effect.

## Terminal

```text
fy login disable <id>   [--until <date|time|3d|12h|90m|1w>] [--reason "…"]
fy login enable  <id>
fy runtime disable <name> [--until …] [--reason "…"]
fy runtime enable  <name>
```

`--until` takes a date, a time with an offset, or a wait counted from now (`3d`). A time already past
is refused. **Neither verb asks for a confirmation**: switching off narrows what can start, and
switching on restores exactly what the file said before, because `disabled` is the only thing it
changes. `--dry-run` and `--json` work as for every account change ([account-model.md](account-model.md)).

## Browser

Settings › Logins and Settings › Runtimes carry a switch on each row and on its own page, with the
reason and the "until" beside it. A runtime that is off because its login is off says so and points at
the login.

## While it is off

| What                                              | Happens                                                                                                                                             |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fy new`, `fy start`                              | Refused, in words: the runtime (or its login) is disabled, why and until when, which runtime to use instead, and the command that turns it back on. |
| `fy recommend`, Pack routing (`launch`, `assign`) | Skipped; a Pack that names it is refused with the code `disabled` ([pack-mode.md](pack-mode.md)).                                                   |
| The Warden's failover order, auto-resume          | Skip it: the next runtime on the list is used.                                                                                                      |
| A ferret **already running** on it                | **Keeps running.** Nothing is killed. Move one with `fy migrate <id> -a <other runtime>`; the switch-off notice says so.                            |
| `until` falls due                                 | The daemon republishes the fleet at that instant and the runtime launches again — no edit, no restart.                                              |

The refusal always names an alternative (another runtime of the same kind that is on), or says that
none is.

## How it is built

One mechanism serves all of the above: the fleet publishes a runtime whose login or own block is in
effect as **unavailable, with a reason**. Everything that asks "can this launch?" — the wrapper
script, the catalog's `launch`, the harness-readiness check, the failover and auto-resume pickers —
already reads that and so honours the switch. The pure rules (`activeDisable`, `runtimeDisable`) live
in `packages/fleet/src/lib/account/disabled*.ts`; the daemon's `DisableExpiryWatch` re-arms a timer on
every config load for the earliest `until` still ahead.

GAPs, declared:

- A ferret that is running keeps its login's traffic; a spend-limited login will fail its calls until
  the ferret ends or is moved. Ferretry does not move it for you.
- A wait (`3d`) is turned into an instant when the command runs; the file stores the instant.

`fy migrate <id> -a <runtime>` onto a runtime that is itself off is refused with the same words, since
a runtime that cannot serve a session cannot receive one either.
