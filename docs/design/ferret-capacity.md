# Ferret capacity: starting a ferret waits for room instead of failing

Status: **plan, not built; decided D1 (a), D2 (b), D3 (c, dynamic) on 2026-11-06 (!A426); the build waits
for C50 (plugin split) and C52 (compat removal).** Nothing in this document is implemented by the change
that adds it. It plans card
**&F1302 Ferret Capacity Requests**. The "Decisions" section records the three choices only the owner
makes; everything else here is a proposal a slice may correct when it measures something.

The owner's words (card &F1302), verbatim:

> _"starting a ferret waits for free capacity instead of failing"_

Paths are relative to the repository root. "Measured" means a number from a run cited here; everything
else is an estimate and says so.

---

## 0. The plan in one screen

1. **A start asks for room.** Every new ferret — `fy new`, a plain `fy start`, a start from the app —
   asks the daemon's **capacity gate** first. If there is room, it starts exactly as today. If not, it
   **waits in a queue**. It is not refused.
2. **`fy new` returns at once with a queued ferret** (D1): a real id, its place in line and what it is
   waiting for. `fy wait <id>` works on it unchanged; `fy stop <id>` cancels it before anything launches.
3. **Two kinds of limit.** The **per-lead limit** (`interactiveChildren` / `autoChildren` in `pack.yaml`)
   stays, but becomes a queue threshold: the 16th child waits for a sibling to finish. The **machine
   limit** is new: memory, CPU pressure, disk pressure, the daemon's own health, and a ceiling on live
   ferrets that is derived from the machine's memory at run time, never configured (D3).
4. **One rule with two lines per signal** (close / reopen), so the gate does not flap (§3).
5. **Who goes first** (D2): the owner's own starts, then sub-ferrets, then housekeeping; within a class,
   one lead cannot starve another; a request that waits long moves up.
6. **`depth_exceeded` stays a refusal.** Waiting never makes a ferret shallower.
7. **The queue survives a daemon restart.** A queued ferret is a session record in a new `queued` state,
   with its whole brief.
8. **Everyone can see it**, in plain words: `fy new`, `fy status`, `fy daemon status`, the app's session
   list and the child's board card: _"waiting for memory: 2 ahead of you"_.
9. **A queued ferret never looks stalled.** The Warden skips it, `fy wait` does not count its queue
   time, its board card says _"Waiting for room"_ with the staleness clock paused (§6.1).
10. **When the machine is too small, the owner is told once**, on the agenda, with numbers and options —
    never as a stream of notifications (§7).
11. **Voice never waits.** The voice worker is admitted by its own rules, and the gate counts its
    reservation as a fixed amount, so the queue never waits on it either (§8).

---

## Decisions

Three choices, **decided by the owner on 2026-11-06 (!A426)**: D1 (a), D2 (b), D3 (c, with the ceiling
derived as below). The other options stay listed so the reasoning is on record. The build waits
for C50 (plugin split) and C52 (compat removal).

**D1 — When there is no room, what does `fy new` do?** — **decided (a)**

- (a) **Return at once with a queued ferret** — id, place in line, what it waits for; exit 0. The
  ferret carries on and calls `fy wait <id>` when it needs the result. ← **decided**: no brief is
  lost and no lead sits blocked; `fy wait` already does the right thing; a lead that would rather do the
  work itself runs `fy stop <id>`.
- (b) Block until it starts (or a timeout), then answer as today. Simple for the caller, but a lead
  that fanned out ten children sits frozen inside its first `fy new`, holding its own memory.
- (c) Refuse as today, with a "try again in N minutes" hint. No queue at all: the brief is still lost
  and every ferret writes its own retry loop.

**D2 — Who goes first?** — **decided (b)**

- (a) Strict first come, first served. Simple and predictable, but one lead that fans out 15 children
  puts every other lead — and the owner's own next start — behind all 15.
- (b) **Owner first, then fair turns between leads, with ageing.** Starts a person made go first; then
  sub-ferrets of a lead a person is at; then sub-ferrets of unattended leads; then housekeeping (Warden
  investigations, learning scans, clean-up). Within a class, leads take turns, one start each. A request
  that has waited 30 minutes moves up one class. ← **decided**: the owner never waits behind a
  fan-out, a busy lead cannot starve a quiet one, and nothing waits forever.
- (c) Numeric priorities (`fy new --priority 1..5`), highest first. Flexible, but every ferret will
  mark its own work urgent.

**D3 — How is the machine limit set?** — **decided (c), dynamic**

- (a) Measured signals only — memory, CPU, disk and daemon health — no ceiling. Adapts to light
  and heavy ferrets, but reacts late: 20 ferrets admitted while idle can all start a build at once.
- (b) One fixed number of live ferrets. Easy to understand, but blind: 25 ferrets running test suites
  are not 25 ferrets reading code.
- (c) **Both: the measured signals decide, under a ceiling on live ferrets that is derived from the
  machine's memory at run time.** No number is written in config, so the ceiling grows by itself after
  the planned resize to 256 GB. "Full" means the live signals (memory, CPU, disk pressure, daemon
  health); the ceiling is itself worked out from memory (§3.3). ← **decided**: the signals catch heavy
  work, the ceiling catches the burst the signals have not seen yet. Today it works out to **36** once
  I36's 53 GiB fleet slice lands and **34** until then on the 57 GiB user slice (§10.2); under the
  2026-11-05 caps it was 28 and would have held the 29th ferret.

---

## 1. What is wrong today

### 1.1 The per-lead limit throws work away

`fy new` refuses with `limit_reached` when a lead already has its limit of running sub-ferrets
(`packages/daemon/src/lib/pack/admission.ts`, `admitChild`). On this machine `pack.yaml` says
`interactiveChildren: 15` and `maxDepth: 3`; the shipped defaults are 20, 4 and 2
(`packages/protocol/src/lib/pack.ts`, `docs/pack-mode.md` › Limits). A refused start returns
`{outcome: 'refused', refusal}` and exit 2, and the brief exists nowhere else. The lead must notice,
retry later, or do the work itself — and the routing prompt tells it to do it itself
(`docs/pack-mode.md`: _"limit_reached or depth_exceeded: do it yourself"_).

### 1.2 The machine has no limit at all

Nothing asks whether the **machine** can hold another ferret. On 2026-11-05 this box — an EC2
instance with **32 cores and 61 GiB RAM**, the person's systemd user slice capped at **`MemoryHigh` 48
GiB** (`MemoryMax` 56 GiB, measured with `systemctl show user-1000.slice`) — ran **41 live ferrets**:

- load average **57** (1.8 per core);
- the 48 GiB memory budget full, swapping on the root disk;
- the daemon's event loop stalled for up to **61.9 s** (the health route's `worstStall`).

No start was refused, because no rule looked. The I36 work (`packages/daemon/src/lib/cgroups/`, and the
parallel PR that adds `docs/ferret-limits.md`) puts ferrets into a capped systemd slice, so an
overloaded fleet is slowed or killed by the kernel instead of taking the box down. That is the
**enforcement** half. This plan is the **admission** half: do not start what the machine cannot hold.

---

## 2. The request and the queue

### 2.1 What a start becomes

Every start goes through one gate, in the daemon, after the checks that can never pass by waiting
and before anything is probed, claimed or launched:

```text
fy new / fy start / app Start
  │
  ├─ checks that waiting cannot fix → refused at once, as today
  │    pack_off · depth_exceeded · unknown_runtime · not_agent · scratch_cwd · card_unavailable
  │    disabled · cli_missing · not_logged_in · model_unavailable · queue_full (new)
  │
  ├─ capacity gate (§3) + per-lead limit + quota (§4)
  │    room for it now? ──yes──▶ probe → start, exactly as today
  │         │ no
  │         ▼
  └─ queued: a session record in state `queued`, with the whole request
           │  each time room appears, the next in order (§5) is re-checked and started
           ├─ started  → `starting` → `running` …   (the ordinary lifecycle)
           ├─ fy stop  → `stopped`, nothing ever launched
           ├─ timeout  → `failed`, refusal `queue_timeout`
           └─ its lead finishes or is stopped → `stopped`, reason "lead is gone"
```

- **The probe runs at admission, not at enqueue.** Quota and logins change while a request waits, so
  the "reply OK" probe and the `--auto` choice of runtime happen when its turn comes.
- **The credential is minted at launch.** A queued record holds no credential and no pane.
- **The request id still deduplicates.** A retried `POST /v1/ferrets` with the same request id finds
  the queued record, so a lost answer never queues a ferret twice.

### 2.2 What the caller sees (D1 a)

`fy new` returns at once, exit **0**, with a new outcome next to `started` and `refused`:

```text
$ fy new --runtime claude-llm2 --model claude-sonnet-5-5 --name "Port Board Tests" "…"
queued nova (mx81k2qd-5c0e11aa): waiting for memory — 2 ahead of you.
  fy wait mx81k2qd-5c0e11aa   returns its result once it has run
  fy stop mx81k2qd-5c0e11aa   cancels it; nothing has started
```

`--json` gives `{outcome: 'queued', session, position, waitingFor, expiresAt}`. `waitingFor` is a closed
set: `memory`, `cpu`, `disk`, `daemon`, `ferret_slots` (the machine ceiling), `lead_slots` (this lead's
own limit), `quota`.

- **`fy wait <id>`** blocks through `queued` → `running` → done and prints the result, as today. While
  queued it shows _"waiting for room (N ahead)"_, printing a new line only when N changes and never
  more often than once a minute. **Queue time does not count toward its limit**: the limit starts when
  the child starts.
- **`fy stop <id>`** on a queued ferret cancels it: status `stopped`, its card closed as cancelled,
  nothing launched.
- **A person's own `fy start`** in a terminal waits in the foreground, first in line (D2), and offers
  `--now` to start anyway (§5.3). Ctrl-C leaves it queued and says how to cancel.

### 2.3 What the lead ferret is told

- **The routing prompt line changes** (`docs/pack-mode.md` and the `FY_PACK` system-prompt text): _"If
  queued, carry on and `fy wait <id>` when you need the result; `fy stop <id>` if you do it yourself.
  depth_exceeded or queue_full: do it yourself."_
- **When a child that waited starts**, the lead gets one `fyi` message (_"nova started after waiting 6
  min for memory"_) — only if it waited more than a minute and the lead is not already in `fy wait` on
  it.
- **When a child expires or is cancelled by anyone but the lead**, the lead gets one `action` message
  with the reason and the remedy (_"nova never started: it waited 2 h for memory. Do it yourself, or ask
  again."_).

### 2.4 Timeouts, cancel and limits on the queue itself

| Rule                                 | Default              | Where                                                      |
| ------------------------------------ | -------------------- | ---------------------------------------------------------- |
| A queued request expires after       | 2 h                  | `capacity.yaml` `queue.timeout`; `fy new --wait-up-to 30m` |
| Queued children one lead may have    | 20                   | `pack.yaml` `limits.queuedChildren` (new)                  |
| Queued requests on the whole machine | 200                  | `capacity.yaml` `queue.max`                                |
| Over either queue bound              | refused `queue_full` | new refusal code                                           |

A queued request whose lead has finished, failed, stalled or been stopped is cancelled: its result
would report to nobody.

### 2.5 What survives a daemon restart

**Everything queued.** A queued ferret is a session document in `queued` state, and its launch request
(brief, attachments, runtime or `--auto`, model, effort, card, folder, lead) is stored beside it in the
session's own directory. At boot the queue is rebuilt from those records in order (§5); the expiry
clock keeps running across the restart.

`InterruptedLaunchReconciler` (`packages/daemon/src/lib/session/resume/interrupted-launch.ts`) settles a
`starting` record `failed` at boot; it must **skip `queued`**, which has nothing to interrupt. A start
that was mid-admission when the daemon died is `starting` and is settled as today.

---

## 3. The admission rule

### 3.1 The signals

Each signal has a **close line** and a **reopen line**. A signal closes when its reading reaches the
close line, and reopens only after its reading has stayed at or below the reopen line for **30 s**. The
gate is open when every signal is open; **"full" means one of these live signals is closed**, never a
number someone typed.

| Signal        | Linux reading                                                                    | macOS reading                           | Close at            | Reopen at            |
| ------------- | -------------------------------------------------------------------------------- | --------------------------------------- | ------------------- | -------------------- |
| Memory used   | working set = `memory.current` − `inactive_file` of the budget's cgroup (§3.2)   | sum of ferret process-tree RSS + daemon | 90 % of budget      | 80 % of budget       |
| Memory stalls | `/proc/pressure/memory` `some avg10`                                             | `memory_pressure` level                 | 10 %                | 2 %                  |
| CPU           | `/proc/pressure/cpu` `some avg60`, and load1 per usable core                     | load1 per usable core                   | 50 %, or 1.5 / core | 25 %, and 1.0 / core |
| Disk          | `/proc/pressure/io` `full avg10`                                                 | none (GAP)                              | 25 %                | 10 %                 |
| Daemon health | the event-loop meter (`GET /v1/health` `loop`): any stall ≥ 2 s, or lag ≥ 250 ms | same                                    | in the last 60 s    | 60 s clean           |
| Ferret slots  | live ferrets (any status but finished or `queued`)                               | same                                    | ≥ ceiling (§3.3)    | < ceiling            |

**Usable cores** are the host's cores, minus voice's C cores while the voice worker is loaded (§8.2).

The readers mostly exist: `ProcIoPressure` already reads `/proc/pressure/io` off the hot path
(`packages/daemon/src/adapters/system/proc-io-pressure.ts`); the CPU and memory files have the same
format; the health route already reports `lagMs`, `stalls` and `worstStall`. Every reading is cached and
refreshed on a 5 s timer, so the gate never waits on the disk — least of all when the disk is why it
is closed.

**A missing reading is not an open signal and not a closed one.** Where a host has no PSI (macOS, old
kernels, many containers), that row is left out and the gate says so in `fy daemon status`; the
remaining rows still decide.

### 3.2 The memory budget

The budget is the first of these that applies:

1. `capacity.yaml` `memory.budget`, when the owner set one;
2. the I36 fleet slice's cap (`MemoryHigh` when set, else `MemoryMax`), when cgroup enforcement is on —
   I36 sets it to min(RAM, the caps above it) − 4 GiB, which is **53 GiB** on this box today;
3. the person's systemd user slice `MemoryHigh` (**57 GiB** on this box today), else its `MemoryMax`;
4. the host's RAM × 0.8 (macOS, or Linux with no cap anywhere).

Its working set is read from the **same** cgroup the budget came from, so the two always describe one
thing. When the budget is the fleet slice, the daemon, the terminal multiplexer, browser pages and the
voice worker all live **outside** it, in the 4 GiB I36 leaves; the user slice is then read as a second
memory row (closes at 90 % of its `MemoryHigh`, reopens at 80 %), so those cannot overflow unseen.

The owner raised this box's caps by hand on 2026-11-06: user slice `MemoryHigh` 57 GiB and `MemoryMax`
60 GiB (they were 48 and 56 GiB on 2026-11-05), and `user@1000.service` `MemoryLow` 4 GiB.

**Page cache is not counted**: `memory.current` includes reclaimable file cache, which is why
`memory.current` here read 42 GiB while `free` said 25 GiB used (measured, 2026-11-06). The working set
subtracts `inactive_file`, as the kubelet does.

### 3.3 Admitting one request

When the gate is open and the queue is not empty, the daemon takes the next request in order (§5) and
admits it only if all of these hold:

1. **Its lead has a slot**: running children < `interactiveChildren` (or `autoChildren`). A `queued`
   child does not count as running. A request whose lead is full is skipped, not blocking those behind
   it, and says `lead_slots`.
2. **The memory forecast fits**: working set + (starts in flight + 1) × **R** ≤ **85 %** of budget.
   **R** is the memory one more ferret is expected to need: the 75th percentile of the peak working set
   of ferrets that finished in the last 24 h (the I36 per-ferret scope's `memory.peak`; RSS peak on
   macOS), never below 768 MiB, and **1.25 GiB** until there are 20 measurements (estimate: the
   2026-11-05 incident is 48 GiB over 41 ferrets ≈ 1.2 GiB each, everything included).
3. **Its quota allows it** (§4).

If they hold, it starts. **One start at a time:** the next request is considered when the previous one
reaches `running` or 20 s have passed, whichever is first — so the readings have a moment to show the
new ferret before the next is admitted, and a burst drains at the speed of real starts, not all at once.

**The ceiling on live ferrets** (D3 c) is **always derived** from the machine's memory at run time;
there is no config key for it:

```text
ceiling = floor( (85 % × budget − non-ferret working set − voice reservation) / R )
```

recomputed at boot and every hour, never between two admissions, so it grows by itself when the
machine does (the planned 256 GB resize needs no edit). "Non-ferret working set" is the
budget cgroup's working set minus the fleet's (daemon, terminal multiplexer, browser pages, the
person's shell), measured. "Voice reservation" counts only when the voice worker is inside the budget
cgroup. When the budget is the I36 fleet slice, both are zero, because they live outside it (§3.2).
Today it works out to **36** on this box with I36's fleet slice and **34** before I36 lands (§10.2);
those are examples, not settings.

### 3.4 Why it will not flap

- **Two lines per signal** (close high, reopen lower), so a reading hovering at the line does not open
  and close the gate every refresh.
- **30 s of good readings** before a closed signal reopens.
- **One start at a time**, each counted in the forecast while in flight.
- **The ceiling moves at most once an hour.**
- **Running ferrets are never stopped or paused by the gate.** It only decides who starts. A machine
  that gets busier after admission is the I36 slice's job.

### 3.5 The deadlock breaker

A lead blocked in `fy wait` on a queued child holds memory and a slot while waiting for room. If
**every** live ferret is a lead blocked in `fy wait` on a queued child, nothing can ever finish. When
the daemon sees exactly that, it admits the oldest such child anyway, provided the working set is below
**95 %** of budget, and records why. The depth limit keeps such chains short.

---

## 4. Quota

The fleet already knows each login's quota headroom (`packages/fleet/src/lib/quota.ts`; Pack mode's
`plenty` / `some` / `low` / `exhausted` / `unknown` bands).

- **`fy new --auto`: route, then wait.** As today, a candidate whose login is `exhausted` is passed over
  for the next one. Only when **no** candidate has quota does the request queue, with `waitingFor:
quota` and the soonest reset (_"waiting for quota: claude-llm1 resets at 14:00"_), instead of today's
  `no_candidate`. Its turn re-runs the choice, so it starts on whichever login reset first.
- **A named runtime with no quota: refused at once, as today** (`out_of_quota`, now naming the reset
  time). The ferret named that runtime and can pick another now; parking named work behind a reset
  hours away would hide it.
- **`unknown` is not `exhausted`.** A login nothing has measured is tried, as today.
- **Quota waits are not machine waits.** They never count towards "the machine is too small" (§7).

---

## 5. Order and fairness (D2 b)

### 5.1 Classes

| Class | Who                                                                                 |
| ----- | ----------------------------------------------------------------------------------- |
| 1     | Starts a person made: the app's Start, `fy start` from a person's terminal, revives |
| 2     | Sub-ferrets of a lead a person is at (an interactive lead)                          |
| 3     | Sub-ferrets of unattended leads                                                     |
| 4     | Housekeeping: Warden investigations, learning scans, Pack clean-up                  |

### 5.2 Within a class

Leads take **turns**: the queue is grouped by **tree** (the top-level ferret a request descends from),
and the trees take one start each in rotation; within a tree, first come first served. A request that
has waited **30 minutes** moves up one class (never into class 1), so nothing waits forever behind a
stream of newer, higher work.

### 5.3 "Start now anyway"

Only a person can skip the queue: the app's **Start now** on a waiting ferret, or `fy start --now` from
a person's terminal. It skips the gate and the order, never `depth_exceeded` and never a lead's own
limit, and the security log records it. A ferret cannot: its credential makes every start of its own a
child (`docs/pack-mode.md` › Limits), and children are classes 2–4.

---

## 6. Where waiting shows

Plain words everywhere, from one sentence the daemon writes: _"waiting for memory: 2 ahead of you"_,
_"waiting for a slot under rhett (15 running)"_, _"waiting for quota: claude-llm1 resets at 14:00"_.

| Surface                  | What it shows                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `fy new`                 | the queued line and the two commands (§2.2)                                                             |
| `fy status`, `--subtree` | state `queued` and the sentence in the LAST column                                                      |
| `fy daemon status`       | a **Capacity** block (below)                                                                            |
| The app: session list    | a **Waiting** group at the top with each ferret's sentence; **Start now** and **Cancel** for a person   |
| The child's board card   | its Status reads _"Waiting for room"_; staleness is paused; no lane move until the ferret starts (§6.1) |
| The lead's pane          | the `fy new` answer, `fy wait`'s position lines, and the one message on start or expiry (§2.3)          |

```text
$ fy daemon status
…
Capacity   full — 3 waiting, oldest 6 min
  memory   48.3 of 53 GiB in use (closes at 47.7, reopens at 42.4)   closed
  cpu      pressure 55 %, load 1.6 per core                         closed
  disk     pressure 8 %                                             ok
  daemon   no stall in the last 60 s                                ok
  ferrets  35 live, ceiling 36                                      ok
  voice    4 cores held for voice (loaded; its memory is outside the fleet slice)
```

### 6.1 A queued ferret never looks stalled

Waiting is not stalling, so every part that watches ferrets treats it that way:

- **The Warden skips a ferret that has not started yet.** A queued ferret gets no stall detection, no
  nudge and no escalation.
- **A lead's `fy wait` does not count queue time toward its limit**, and shows _"waiting for room (N
  ahead)"_ (§2.2).
- **The child's board card shows _"Waiting for room"_, and its staleness clock is paused while it is
  queued.** The clock restarts when the ferret starts.
- **One agenda item if nothing has started for 30 minutes**, not a stream. It is the one item of §7,
  kept up to date in place.

---

## 7. "This machine is too small"

The queue is the evidence. The daemon counts, per day, **machine-limited minutes**: minutes in which
something waited because of memory, CPU, disk, the daemon's health or the ferret ceiling. Waits for a
lead's own slots or for quota are not counted: they say nothing about the machine.

- **The signal:** nothing has started for **30 minutes** while requests wait for a machine reason
  (§6.1), or at least **60 machine-limited minutes on 3 of the last 7 days**, or one request that
  waited longer than **30 minutes** for a machine reason, twice in one day.
- **How the owner is told:** **one agenda item**, kept up to date in place, never a notification. It
  says what happened (peak live ferrets, peak memory, longest wait, which signal closed most) and the
  options:
  1. **Nothing** — the queue is doing its job; dismiss it.
  2. **Fewer at once** — lower `interactiveChildren` or the routing prompt's fan-out.
  3. **More memory for ferrets** — raise the budget, when the host has room above it (here little is
     left: since 2026-11-06 the user slice's `MemoryHigh` is 57 GiB of the 61 GiB host). A loosening,
     so it waits for the owner's confirmation.
  4. **A bigger machine** — on EC2, the next size up (the planned resize is to 256 GB). Everything
     Ferretry keeps is under `$FY_HOME` on the instance's disk, so a stop / change type / start keeps
     it; the daemon re-derives the ceiling at boot, so nothing needs editing.
  5. **A second machine** — needs ferrets placed across machines, the parked mesh work. Named as
     future, not designed here.
- A dismissed item stays quiet for **14 days**.

---

## 8. How this fits I36 and voice

### 8.1 I36: cgroups

- **I36 enforces, this admits.** The gate keeps the fleet under its slice's cap; the cap stays the
  backstop for what the gate cannot foresee (a ferret that grows after it started).
- **Same numbers.** The budget is read from the I36 slice when enforcement is on (§3.2), and R from
  its per-ferret scopes' `memory.peak`. With I36 off, the gate falls back to the user slice and RSS.
- **No new unit format.** The gate only reads cgroup files; it writes nothing to systemd.

### 8.2 Voice

The owner decided voice gets the processor first (`docs/design/voice-modes.md`, D3 b: the voice slice
weighs 200 against the fleet's 100). So:

- **Voice never enters the queue.** The voice worker is started by its own rules, with its own refusal
  (`503 voice_no_memory`); it never waits behind a ferret.
- **The queue never waits on voice either.** While the worker is loaded, its reservation — its
  `MemoryMax` (the model's peak × 1.25, at least 1.5 GiB) and its C cores (4 here) — is subtracted
  from the usable cores, and from the budget when the budget's cgroup contains the worker (not the I36
  fleet slice, §3.2), **as a fixed amount**. The gate does not count voice's live usage on top, and
  never waits for voice's idle exit to free anything.
- **CPU pressure cannot tell voice apart.** PSI is machine-wide, so while a voice chat is active the
  CPU row uses only load per usable core (cores − C), with voice's C runnable threads taken off the
  load. Otherwise, a voice chat would close the gate by doing exactly what the owner chose it to do.

---

## 9. What changes from today

| Today                                                             | After                                                                                        |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `limit_reached`: refused, exit 2, brief lost                      | queued as `lead_slots`; refused only when the queue is off or full (`queue_full`)            |
| `depth_exceeded`: refused                                         | unchanged — waiting cannot fix it                                                            |
| `no_candidate` because every login is out of quota                | queued as `quota` until the soonest reset (§4)                                               |
| No machine limit                                                  | the capacity gate (§3)                                                                       |
| `PackNewOutcome` is `started` or `refused`                        | adds `queued`                                                                                |
| Session statuses                                                  | add `queued`: not finished, not running; `runningChildCount` skips it                        |
| Refusal codes                                                     | add `queue_full` and `queue_timeout`                                                         |
| Routing prompt: "limit_reached or depth_exceeded: do it yourself" | "queued: carry on, `fy wait` when you need it; depth_exceeded or queue_full: do it yourself" |

### 9.1 Configuration

- **`pack.yaml` keeps its keys and values.** `limits.interactiveChildren` (15 here) and
  `limits.autoChildren` keep their numbers; only what happens past them changes. `limits.queuedChildren`
  is new (default 20). `maxDepth` is unchanged.
- **`capacity.yaml` is new** (one file per building block, `docs/config-files.md`): `queue` (on/off),
  `queue.timeout`, `queue.max`, `memory.budget` (absent = derived), and the close/reopen lines. **There
  is no key for the ceiling on live ferrets**: it is derived from memory at run time (§3.3).
  `queue: false` brings back today's refusals for the per-lead limit and turns the machine gate off.
- **What needs the owner.** The queue's default-on behaviour is what this card asks for, so it ships on
  once the owner approves this plan. After that, the usual rule holds (`fy config guide`): raising
  the budget, any close line or `queue.max`, or setting `queue: false`, **loosens** what the
  machine may run and is held for the owner's confirmation; lowering them takes effect at once.

---

## 10. Worked example on this box

### 10.1 History: 2026-11-05 under the caps of that day

32 cores, 61 GiB RAM, user slice `MemoryHigh` 48 GiB, 41 ferrets started over the day.

- **Budget** 48 GiB (the user slice; I36 off). Close at 43.2 GiB, reopen at 38.4 GiB, forecast line
  40.8 GiB.
- **R** 1.25 GiB (no measurements yet). Non-ferret working set ≈ 4 GiB (estimate). Voice loaded:
  1.5 GiB and 4 cores held.
- **Ceiling** = floor((40.8 − 4 − 1.5) / 1.25) = **28** live ferrets.
- **Ferrets 1–28** start as they are asked for, one at a time, each as soon as the previous is running.
- **Ferret 29 onwards** queue as `ferret_slots`: _"waiting for a free ferret slot: 3 ahead of you"_.
  Each lead's `fy new` returns at once and the lead carries on.
- **If the 28 run builds** and load passes 42 (1.5 per usable core; voice holds 4 of the 32 cores),
  the CPU row closes too and stays closed until load is back under 28 (1.0 per usable core) for 30 s.
- **If the daemon stalls** for 2 s, the gate closes for at least a minute. Starting more ferrets is the
  last thing a stalled daemon needs.
- **Result:** at most 28 live instead of 41; memory stays under 43 GiB instead of swapping; 13 briefs
  wait instead of being refused or overloading the box. If days like this repeat (§7), the agenda tells
  the owner the box is too small, once.

### 10.2 Today: the caps the owner set on 2026-11-06

User slice `MemoryHigh` 57 GiB / `MemoryMax` 60 GiB, `user@1000.service` `MemoryLow` 4 GiB; R still
1.25 GiB (no measurements yet). These are the numbers D3 was decided on; today the ceiling works out
to the figures below, and the next resize changes them without any edit.

| Budget comes from                          | Budget | Closes at | Reopens at | Forecast line | Ceiling                                  |
| ------------------------------------------ | ------ | --------- | ---------- | ------------- | ---------------------------------------- |
| **I36's fleet slice** (once I36 PR2 lands) | 53 GiB | 47.7 GiB  | 42.4 GiB   | 45.05 GiB     | floor(45.05 / 1.25) = **36**             |
| The user slice (until then)                | 57 GiB | 51.3 GiB  | 45.6 GiB   | 48.45 GiB     | floor((48.45 − 4 − 1.5) / 1.25) = **34** |

- **With the fleet slice**, nothing but ferrets is inside the budget: the daemon, tmux, browser pages and
  the voice worker sit in the 4 GiB I36 leaves outside it, so neither the non-ferret estimate nor voice's
  1.5 GiB is subtracted. The user slice (57 GiB) is still read as a second memory row (§3.2).
- **With the user slice**, the same ≈ 4 GiB non-ferret estimate and voice's 1.5 GiB come out first.
- **Replaying 2026-11-05 today:** ferrets 1–36 start (34 before I36), ferrets 37–41 queue (35–41 before
  I36). The CPU row is unchanged — load 57 is far past the 42 close line — so on a day as busy as that
  one the CPU row, not the ceiling, is what would hold starts back.

---

## 11. Slices

| #   | Slice                                                                                                                                        | How to see it work                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1   | Protocol: `queued` status and outcome, `waitingFor`, `queue_full` / `queue_timeout`; `runningChildCount` skips `queued`; reconciler skips it | unit tests; `fy status` shows a hand-made queued record                                                        |
| 2   | The queue: persisted queued records, order (§5), expiry, cancel, lead-gone, restart rebuild; per-lead limit becomes `lead_slots`             | 16th `fy new` under one lead returns `queued`; it starts when a sibling finishes; survives `fy daemon restart` |
| 3   | The gate: readers (memory, CPU, disk PSI, cgroup working set, health), close/reopen lines, forecast, ceiling, one-at-a-time                  | `fy daemon status` Capacity block; a memory hog closes the gate and queued ferrets wait                        |
| 4   | Surfaces: app Waiting group with Start now / Cancel, card status, lead messages, routing prompt line, `docs/pack-mode.md`                    | the app shows a waiting ferret with its sentence; Start now starts it                                          |
| 5   | Quota waits for `--auto` (§4), voice reservation (§8.2)                                                                                      | all logins exhausted → `queued` as `quota`; voice loaded → ceiling drops by its share                          |
| 6   | "Too small" agenda item (§7)                                                                                                                 | a fixture of machine-limited days raises one agenda item, updated in place                                     |

---

## 12. Declared gaps and risks

- **R is a guess until measured.** 1.25 GiB comes from one bad day divided by 41. Until 20 ferrets
  have finished under I36 scopes, the ceiling may be wrong in either direction.
- **The gate cannot see the future.** A ferret admitted while idle may start a build or a browser a
  minute later. The ceiling and the forecast margin soften that; the I36 cap is the real backstop.
- **Running ferrets are never paused.** Suspending or evicting a running ferret to make room is out of
  scope.
- **macOS is weaker.** No PSI and no cgroups: memory is summed RSS (which double-counts shared pages)
  plus `memory_pressure`, CPU is load average, and there is no disk row.
- **PSI cannot separate voice from ferrets**, so during a voice chat the CPU row falls back to load
  alone (§8.2).
- **A queued brief can go stale.** The lead may have done the work by the time a slot opens. The lead
  can `fy stop` it; nothing detects staleness for it.
- **Reboot revives are not gated.** Ferrets the daemon resumes after a host restart are not new starts
  and do not pass the gate; pacing those is future work.
- **"Start now anyway" can overload the machine.** It is a person's deliberate choice, recorded, and
  the I36 cap still holds.
- **The deadlock breaker (§3.5) is a heuristic** for the one cycle it names. Longer cycles (a lead
  waiting on a queued child of a child) are bounded by depth, not prevented.
- **The thresholds are first guesses.** 90/80 %, 10/2 %, 50/25 %, 25/10 % and 2 s are starting
  points; slice 3 records the readings at every close and reopen so they can be tuned from data.
