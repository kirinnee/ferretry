# Spend budgets

A login can carry a **daily and/or weekly budget in US dollars**, each with two levels:

- **Trigger** — once this machine's sessions on the login have spent at least this much in the period,
  **nothing new starts on it**: no `fy new`, `fy start`, Pack sub-ferret, resume, Warden revive,
  auto-resume or migration onto it. Ferrets already running on it keep going.
- **Hard limit** — once they have spent at least this much, the daemon also **stops the ferrets running
  on it**: each is interrupted, then stopped with its turn saved, so it can be resumed after the reset or
  moved to another login. The owner gets **one** notification with a ping, per login per period.

A day resets at local midnight and a week at Monday 00:00, in the owner's time zone.

## The file

```yaml
# logins/claude-liftoff.yaml
harness: claude
store: ferretry
budget:
  daily: { trigger: 40, hard: 60 } # dollars; either level may be left out
  weekly: { trigger: 150, hard: 200 } # either period may be left out
```

```yaml
# machine.yaml
timeZone: America/Los_Angeles # IANA; absent: the host's own zone
```

`fy config check` refuses a period with neither level, a hard limit below its trigger, an amount that is not
positive, and a zone `Intl` does not know. A budget can sit on any login. On a subscription login (Claude
Max, Codex plans) the amount is what the same requests would cost at API prices, so it works as a usage
throttle rather than a bill.

The app writes `timeZone` the first time a budget is saved, from the zone the owner's device reports. Like any
zone change it waits for the owner's confirmation (below). A box in the cloud usually runs in UTC, so set it
when the host's zone is not yours.

### From a terminal

```text
fy login budget <id>                                   # show it
fy login budget <id> [--daily-trigger N] [--daily-hard N] [--weekly-trigger N] [--weekly-hard N]
fy login budget <id> --daily-hard off                  # remove one level
fy login budget <id> --clear                           # remove the whole budget
fy login budget <id> --time-zone America/Los_Angeles   # machine.yaml timeZone
```

It edits only the `budget` key of `logins/<id>.yaml` (and `timeZone` in `machine.yaml`), keeping every
comment, through the daemon's checked config write. So it follows the file's rules below exactly, and says
when an edit is held. `--dry-run` and `--json` work as usual.

### Who may change it

Lowering or adding a limit **tightens** spending and applies at once. Raising a limit, removing one,
removing a period or the whole `budget`, and **any** change to `timeZone` **loosen** it: the
edit is held and the tighter version stays in effect until the owner confirms it (`fy config confirm`, a
passkey in the app, or **Allow** on an agenda card), exactly like every other loosening
([config-files.md](config-files.md#how-a-file-is-read)). A zone is held even when it is the first one set:
moving the day boundary to a zone where the next day has already begun would reset a day that is over budget
and lift its hold.

A budget can also be taken away without touching `budget:`, so these are held as removals too:

- **deleting the login file** of a login with a budget (with or without its runtimes) — and a login made
  again under the same id is judged against the one still in effect, so delete-then-recreate cannot drop it;
- **moving a runtime off a budgeted login** — its `credential` re-pointed, or its file deleted. A budget
  counts the spend of the runtimes on its login and stops their ferrets, so a runtime that leaves takes its
  week of spend and its running ferrets out of the budget's reach.

The owner's own reviewed changes (`fy login rm`, `fy runtime rm`, a runtime's login changed in the app) are
acknowledged as they are applied and are not asked about again.

**What this holds against, honestly.** An edit to the files — by hand, by `fy config write`, by `fy login
budget` or by the `config.*` tools — that loosens a budget waits for the owner, so a confused or
prompt-injected agent editing configuration cannot raise, remove or sidestep one. It is the same
**honest-client limit** as the secret store's ([secrets.md](secrets.md#what-this-does-not-protect-against)):
every ferret runs as the owner's user with this host's admin token, and the daemon tells a ferret from the
owner's shell only by what `fy` sends. So an agent can still run the owner's own reviewed changes — `fy login
rm` on loopback, which is acknowledged like the owner's — or send raw HTTP that looks like the owner, or edit
the accepted record on disk. A budget is a guard against accidents and runaway spend, not against an agent set
on removing it. The real fix is per-agent credentials (&F259), which would let the daemon refuse a ferret the
owner's changes outright.

## What is counted

The **spend meter** reads this machine's transcripts and prices every request at its own timestamp, with the
same pricing catalog analytics uses (Settings › Analytics › Pricing):

- a session's own transcript **and its Claude sub-agents'** (`<conversation>/subagents/*.jsonl`);
- running sessions as well as finished ones. A session that runs past midnight counts against each day
  for the requests made in it;
- a session migrated during the period, by its **whole history of moves** (`migrations` on the session):
  moved A→B→C, what it did before the first move counts against A, between them against B, after them
  against C;
- a transcript the session no longer names keeps what it booked to the end of the period. A migration that
  **converts** the conversation to the other harness rewrites it without the old usage records, so the file it
  left (named by the session's `conversion`) is read for them;
- a Claude message that appears in two transcripts (a fork or a resume copies the conversation) counts once.

The meter reads only what was appended since its last read, once a minute, and keeps nothing on disk. After a
restart it reads the week again before it judges anything.

**What it does not count, declared:**

- **Other machines.** Each daemon meters and enforces only its own sessions. The same login used on three
  machines can spend up to three times its budget. The app says so on every budget ("Spent on <machine>").
- Usage of the same credential outside Ferretry.
- A request whose model has no price. It is counted and shown as _unpriced_, never as $0. Add the price to
  the catalog to have it counted.
- Overshoot: a check runs once a minute, and a turn in flight finishes its current request before the
  interrupt lands. The hard limit can be passed by that much.
- A transcript with more written this period than one read reaches back over (256 MiB): it is read from where
  the read can start, and the budget is marked **partial** — "the amount may be low" — in the app and in
  `fy login check`.
- After a restart, a session converted twice in one week: only its last conversion's source file is named, so
  what the first one left behind is not read again.

## Enforcement

| What                                              | Past the trigger                                                     | Past the hard limit                                                    |
| ------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `fy new`, `fy start`, resume, revive, auto-resume | Refused: the login is published unavailable, with the reason         | Same                                                                   |
| `fy recommend`, Pack routing                      | Skipped; a Pack start that names it is refused with `over_budget`    | Same                                                                   |
| Quota failover, `fy fleet recommend`              | Skip it                                                              | Same                                                                   |
| Ferrets already running on it                     | Keep running                                                         | Interrupted, then stopped with their turn saved                        |
| The owner                                         | Sees the state on the login (app, `fy login check`)                  | One notification with a ping, naming the ferrets stopped               |
| The reset                                         | The next check (within a minute) publishes the login available again | Same; stopped ferrets stay stopped until someone resumes or moves them |

A login held by its budget uses the same "published unavailable, with a reason" path as a `disabled` one
([disabling.md](disabling.md)), so every launch path honours it without a check of its own. The published
reason names the limit and the reset, never the running amount, so a fleet is republished only when a login's
standing changes.

The hard-limit notice names, for each ferret it stopped, the command that moves it:
`fy migrate <id> -a <runtime>` with a runtime of the same kind on a login within its budget. Ferretry never
moves a ferret itself. A ferret stopped for its budget is not a crash: the Warden does not revive it and
auto-resume after a restart skips it.

The budget check runs on its **own timer**, not the Warden sweep, so it holds with the Warden switched off, and
the hard stop never waits on the publish: a fleet that will not publish (a broken runtime elsewhere) does not
keep a login's ferrets running past their hard limit. A check whose inputs cannot be read — the published
manifest, the sessions, the prices — is skipped whole: the last standing and holds stay, rather than reading as
nothing spent and lifting every hold.
Which (login, period) the owner was told about is kept in `<FY_HOME>/state/budget-told.json`, so a restart
never sends a notice twice, and the daemon also remembers them itself, so a record it cannot write does not
turn one notice into one a minute. The holds last published are kept in `<FY_HOME>/state/budget-holds.json` and read
back at boot, so a fleet published before the first count of the week finishes cannot hand a held login back.

## Where to see it

- `fy login check <id>` and `fy credentials` print each budget: spent today and this week on this machine
  against the limits, the zone, any unpriced requests, and what holds the login and until when.
- The app's Settings › Machines › Credentials shows the same, with an editor.
- `GET /v1/fleet/credentials`: each login's `budget` (`FleetCredentialBudgetSchema`).

## Code

- `packages/fleet/src/lib/account/budget.ts`: the schema, the period arithmetic (DST-safe, `Intl`), levels and
  holds. Pure.
- `packages/fleet/src/lib/config-files/kinds.ts` `loginLoosening`, `runtimeLoosening`: what a budget edit loosens
  (applied by `evaluate.ts`, a deletion included, and by the daemon's checked write).
- `packages/daemon/src/lib/budget/`: the meter (`meter.ts`, `spend-fold.ts`), the standing (`state.ts`), the
  service with its tick (`service.ts`) and the notice (`notice.ts`).
- `packages/daemon/src/adapters/budget/ports.ts`: sessions from storage, sub-agent transcripts, the told
  record.
