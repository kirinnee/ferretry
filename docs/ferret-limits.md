# Ferret limits

Ferrets are kept **below what you can really spend**, in their own slice, so the daemon (`fyd`) is never the
one the kernel asks to reclaim memory. They are **on by default** and need no setup. This page is what is
enforced on Linux and macOS, the defaults (with a worked example), how to change them, and what needs your
confirmation. The code is `packages/protocol/src/lib/limits.ts` (the numbers, once),
`packages/daemon/src/lib/cgroups/` (the launch and the watch) and `packages/fleet`'s `config-files/`
(`limits.yaml` and its loosening rules).

## Why

On a measured box (61 GiB of RAM) the whole user slice had `MemoryHigh=48G`. Ferrets filled it; past it the
kernel makes **every task in the slice** — the daemon's main thread included — do reclaim and sleep. Swap is
a file on the same disk, so a thrashing fleet saturated the disk too, and the daemon stalled for up to 62 s,
97 % of that while the disk was saturated by swap. The fix is to keep ferrets below the user's real budget.

## The budget

The **memory budget** is `min(physical RAM, every finite memory.max and memory.high on the daemon's own
ancestor cgroups)`, read once at boot from `/proc/self/cgroup` and `/sys/fs/cgroup`. It is _not_ the RAM: a
fleet sized from 61 GiB would fill a 48 GiB cap and the daemon would stall again. The status says what set
it. Nothing is hard-coded: if the owner raises the user slice's cap, the next daemon start sees it.

The daemon keeps a **fixed 4 GiB reserve** (owner decision) for itself and the system; never more than half
of a small budget.

## What is enforced

### Linux (cgroup v2 + the user's systemd manager)

Every new ferret launches as `systemd-run --user --scope` inside its own
`<product>_fleet-<escaped-session-id>.slice`, below `<product>_fleet.slice`, with its harness
wrapped as `ionice -c2 -n7 -- <cmd>`. Supervision (the Warden and what it started) is never wrapped, and the
daemon is never launched through the wrapper.

| Where           | Setting         | Default                          |
| --------------- | --------------- | -------------------------------- |
| the fleet slice | `CPUWeight`     | 50 (voice 200; daemon: its unit) |
|                 | `MemoryHigh`    | budget − 4 GiB (slows)           |
|                 | `MemoryMax`     | budget − 2 GiB (kills inside)    |
|                 | `MemorySwapMax` | 10 % of the budget               |
|                 | `TasksMax`      | 16384                            |
| each ferret     | `MemoryHigh`    | 25 % of the budget               |
|                 | `MemoryMax`     | 30 % of the budget               |
|                 | `TasksMax`      | 4096                             |
|                 | `CPUWeight`     | 100 (200 if a person started it) |

**No CPU quota by default** — a hard quota idles cores the machine has. A weight only matters when the
machine is busy, which is exactly when it should. An operator can still set one (`cpuPercent`).

Swap is limited because swap thrash is what saturates the disk: past the swap limit the fleet is throttled
and then the kernel stops a process _inside the fleet_, never the daemon.

**Disk priority (`ionice`) only works if the disk's IO scheduler honours it.** BFQ honours it fully,
mq-deadline by class only, and on `none` (most NVMe) or kyber it does **nothing**. The status reads
`/sys/block/<disk>/queue/scheduler` for the disk under the state home and says which applies. It uses the
best-effort class at the lowest level (`-c2 -n7`), not idle: idle can starve a ferret outright under BFQ.

If the user's systemd manager does not answer (a system service, a container, a plain `su`) or the host is not
cgroup v2, ferrets launch directly as before and the status says **`limits not enforced: <reason>`**. A launch
that fails re-checks (at most every 30 s). If you wrote `enabled: true` yourself, a ferret that cannot be limited
**fails to start** instead — you asked for a guarantee.

Only **new** launches get the slice. A running ferret is never moved; relaunch it (Restart) to bring it under.
Ferrets and terminals started before this update keep their earlier layout and allowances until relaunch.
Legacy scopes outside the new fleet slice are not covered by its ceiling or watcher.

**A scope is proven before a ferret is put in it.** The launch first starts the exact scope (same slice, same
properties) around `true`. If the user's manager went away since boot, or refuses a property, the ferret starts
unconfined with a loud warning in the daemon log, the status says why and the host is probed again (at most every
30 s) — it never becomes a pane that dies before the harness ran. Only a manager that dies in the milliseconds
between that proof and the real start can still catch one launch; the next launch's proof then reports it.

**A terminal an agent opens shares the opener's allowance.** The harness and every terminal opened by that
session credential run in separate scopes below the **same per-ferret slice**. Memory and task caps and any
CPU quota apply to their combined usage, so opening six terminals still gives one allowance. The session id
is escaped for systemd unit names (a literal dash is `\x2d`), keeping each ferret slice directly below the fleet.
Who opened it comes from the credential and the tool route, never a field the agent supplies. Cross-session
terminal creation is supported: a terminal in another session still uses its **opener's** limits and priority.
The Warden exemption follows the opener, never the target session. A terminal the owner opens from the app or
on the host stays outside: it is the person's shell.

**Shared agent Chrome and its worker share a separate allowance.** Both new children run in their own
scopes below `<product>_fleet-browser.slice`, inside the fleet ceiling. Together they get one allowance
from `perFerret`: by default 25% of the budget soft, 30% hard, 4096 processes, CPU weight 100, and any
configured per-ferret CPU quota. This is a shared browser cap, not a cap per page or per caller. The scope
wrapper execs in place: Chrome keeps its real PID on the profile lease, its DevTools pipe and its teardown
semantics. The worker keeps its own stdio and PID too. A scope setup failure uses the same warning and
unconfined fallback as a ferret (or refuses on Linux with explicit `enabled: true`). The owner's own browser
is outside this allowance. Existing browser children join only when relaunched.

### macOS (no cgroups)

Ferrets launch as `taskpolicy -c utility nice -n 10 <cmd>`: the QoS is clamped to `utility` (still every core,
but yielding to your own work) and the BSD priority is lowered. Not `-b`: that throttles far below real time
(`docs/design/voice-modes.md` §2.5). `-c utility` is documented in `taskpolicy(8)`; a `-d` disk policy is
**not** used, because the man page documents only `default` and `throttle` as symbolic values. If `taskpolicy`
refuses the clamp the launch falls back to `nice -n 10` alone, and to nothing if neither runs. The wrapper is
proven around `true` before each launch; one that stops working starts the ferret unwrapped with a warning.
macOS is best effort: `enabled: true` cannot demand a guarantee a Mac cannot give, so it never fails a launch there.

> **macOS: lower CPU and disk priority only; memory is watched, not capped.**

Every 30 s the daemon sums each ferret's process-tree memory and **reports** one over its per-ferret share. It
does not stop it.

## What you see

`fy daemon status` has a **Limits** block, the app's Settings › Ferret limits tab (read-only; a Terminals tab, found in the command bar by "memory", "slow", "limits.yaml"…) shows the same
lines, and a ferret's Info › Overview says when _it_ was slowed or stopped. For the box above:

```text
ferrets: memory 44 GiB soft / 46 GiB hard of a 48 GiB user budget · CPU weight 50 (daemon 100, voice 200) · disk priority: no effect on this disk (scheduler none)
each ferret: memory 12 GiB soft / 14.4 GiB hard · up to 4096 processes
swap: ferrets may use up to 4.8 GiB of swap
3 ferrets slowed for memory now: gertrude, …
killed for memory: gertrude 23:04 (bun test, 9.1 GiB)
```

**The numbers are what the kernel holds**, read back from the cgroup files on the same 30 s look — not what
`limits.yaml` asks for. Before any ferret has launched there is nothing to read, and the status says
**"configured, not yet applied"**. An unreadable control file shows **"unknown"**, never the requested
value. CPU weights and quotas are also read back; the API keeps configured defaults for new launches separate
from applied running limits. Task counts are compared exactly; only memory byte caps allow page rounding.
After you tighten a cap, fleet and per-ferret slices keep their earlier values until the next launch using
that slice: the status keeps showing the held
numbers and adds one line saying what the file now asks for and how many running ferrets keep earlier limits.

When the ferrets _together_ go past the fleet's soft limit while each stays under its own, the kernel counts it
on the fleet slice's own `memory.events.local`. The hierarchical `memory.events` also includes child events,
so a single ferret crossing its own soft limit never implies that all ferrets are slowed. Where the local file
cannot be read, only high events not explained by the observed children count as shared pressure.
The status then says **"all ferrets are slowed for memory now"**, and each ferret running
at that moment gets one journal note marked shared — it is not pinned on one ferret the evidence does not name.

A slowed ferret (`high` rose) and a killed one (`oom_kill` rose) each get a note in their own journal
(`session.memory_throttled`, `session.memory_killed`). If the **agent itself** was killed that way its end
reason says "killed for memory" instead of "ended by signal 9". The watcher reads two small files per ferret
every 30 s and never on a request.

## Worked example

A box with **61 GiB RAM, 32 cores, and `MemoryHigh=48G` on `user-1000.slice`** (an earlier state of the box
this was measured on):

| Quantity                 | Value                                 |
| ------------------------ | ------------------------------------- |
| memory budget            | min(61, 48) = **48 GiB**              |
| reserve                  | **4 GiB**                             |
| fleet `MemoryHigh`       | 48 − 4 = **44 GiB**                   |
| fleet `MemoryMax`        | 48 − 2 = **46 GiB**                   |
| fleet `MemorySwapMax`    | 10 % × 48 = **4.8 GiB**               |
| fleet `CPUWeight`        | **50**                                |
| each ferret `MemoryHigh` | 25 % × 48 = **12 GiB**                |
| each ferret `MemoryMax`  | 30 % × 48 = **14.4 GiB**              |
| each ferret `CPUWeight`  | **100** (**200** for your own ferret) |

This is asserted by `packages/protocol/tests/unit/limits.test.ts` and
`packages/daemon/tests/unit/cgroups/ceiling-and-units.test.ts`. After the owner lifted that slice to
`MemoryHigh=57G`, the budget is 57 GiB and the fleet gets 53 GiB / 55 GiB — with no change here, because the
cap is read, not remembered.

## Changing them: `limits.yaml`

`<FY_HOME>/config/limits.yaml`, like every setting (`fy config path`, `fy config guide`, `fy config schema
limits`, `fy config check`). Every field is optional; **absent means computed**.

```yaml
enabled: true # absent = on. `false` switches limits off.
ionice: true # absent = on.
fleet:
  cpuWeight: 50
  memoryHigh: 40G # bytes, a size (512M, 40G, 1.5GiB), a percent of the budget (80%), or infinity
  memoryMax: 90%
  swapMax: 2G
  tasksMax: 16384
  cpuPercent: 50 # optional hard quota: a share of the WHOLE machine
perFerret:
  cpuWeight: 100
  interactiveCpuWeight: 200
  memoryHigh: 10G
  memoryMax: 12G
  tasksMax: 4096
  cpuPercent: 25
```

A new launch reads the file in effect; no restart.

### What needs your confirmation

A **loosening** is held until the owner confirms it (`fy config confirm limits.yaml`, or in the app), and the
tighter version stays in effect meanwhile — the same rule as every other file, so an agent with file access
cannot give itself the machine:

- raising any cap or weight above what it resolved to before (judged by the bytes it means on this machine —
  `memoryMax: 30G` against a computed 46 GiB is a tightening and applies at once);
- taking a cap away (back to the default can't be proved tighter, so it is held);
- switching limits off (`enabled: false`) or `ionice: false`.

Tightening, and anything new that is no looser, applies at once. Where the budget is unknown (`fy config check`
on another host) only an edit provably not looser passes: write caps as a percent of the budget to tighten
without a confirmation. A soft limit written above its hard limit is used as the hard limit, and the status says so.

### The retired `cgroups/config.json`

Limits used to be off by default, configured from a JSON document the app wrote. On the first start with this
version the document is moved to `limits.yaml` and kept as `cgroups/config.json.migrated`: `enabled` is carried
either way (`true` stays the explicit kind that fails a launch), a percentage you changed becomes the matching
cap as a percent of the budget, and the old defaults are not carried (they are computed now). A document that
doesn't validate is left alone and said so. The settings panel no longer edits anything.

## The daemon outranks the ferrets

CPU weights compare **siblings**. Under the user's manager the siblings are `app.slice` (the daemon, 100), the
fleet slice (50) and the voice slice (200, `docs/design/voice-modes.md` §2.5), so when the machine is busy the
daemon gets twice a busy fleet's share and voice more than either. The daemon's own unit adds `CPUWeight=200`,
which only orders it against the other services inside `app.slice`.

**`fy daemon status` and the app's Limits panel print what the kernel holds, not these defaults.** The daemon's
weight is read from its own cgroup's `cpu.weight` and the voice worker's from `<product>_voice.slice`, counted only
while a worker scope is alive in it (otherwise "not running; gets 200 when it starts"). A file that cannot be read
is "unknown", and macOS prints neither. So `systemctl --user set-property` or an edited unit shows up as what it is.

The slice names carry **no dash** on purpose: systemd reads a dash in a slice name as hierarchy
(`systemd.slice(5)`), so `<product>-fleet.slice` would have sat inside a `<product>.slice` — a second root-level
sibling of `app.slice` at the default weight 100 — and, as its only busy child, taken that whole weight. The fleet
would then have competed with the daemon at parity instead of at half. `<product>_fleet.slice` is a direct child of
the user manager, so 50 against 100 against 200 is what is actually weighed.

`fyd.service` is rendered with `CPUWeight=200` and `MemoryLow=4G`. **`MemoryLow` protects the daemon only if
every ancestor also has a `MemoryLow=`**, and a stock `user@.service` does not.

### When a cap above the daemon is below the machine's RAM — one optional owner step

If something above the daemon holds the user below the machine's RAM, the status says so and gives the exact
commands, generated from this machine's facts. For the 48 GiB example:

```text
your user slice caps memory at 48 GiB (set in /etc/systemd/system/user-1000.slice.d/50-devbox-memory.conf); ferrets get 44 GiB. To give them RAM - 4 GiB, an owner runs:
  sudo mkdir -p /etc/systemd/system/user-1000.slice.d
  printf '[Slice]\nMemoryHigh=61G\nMemoryMax=infinity\n' | sudo tee /etc/systemd/system/user-1000.slice.d/60-ferretry-memory.conf
  sudo systemctl daemon-reload
  sudo systemctl set-property user-1000.slice MemoryHigh=61G MemoryMax=infinity
  sudo systemctl set-property user@1000.service MemoryLow=4G
```

**Ferretry never runs these, and nothing at runtime needs `sudo`.** It is an optional, one-time step for the
owner; without it the ferrets simply get the budget minus 4 GiB. On a box with no such cap there is no step.
(The measured box has had it applied by hand and needs none.)

## Declared gaps

- A kill is attributed to a ferret from the kernel's counters on the fleet slice and its scopes; when several
  ferrets' scopes vanish in the same 30 s the one with the most memory at the last look is named. What was
  using the memory is the biggest process at the last look near the limit, not at the instant of the kill.
- The "killed for memory" end reason applies to the self-check's exit pass; a pane exit a session worker
  settles keeps its ordinary wording.
- macOS memory is observed on a timer, so a spike between two looks is not seen.
