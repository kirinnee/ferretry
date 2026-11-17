# Idle daemon memory profile (ferrets)

Two scripts, no CI tier (nothing here is a test): `generate-home.ts` builds a credential-free `FY_HOME` with
N sessions and journals, `profile-daemon.ts` runs the daemon from source and writes a memory row every 3 s.
Run both as in their headers, with a short `FY_HOME` path (the local socket path is limited), `env -i`, a fake
`HOME`, its own `TMUX_TMPDIR`, `FY_UPDATE_CHECK=off`, `FY_RELAY_DIRECTORY_ORIGIN=off`, and a port that is not a
real daemon's.

## The question

The idle daemon held about 875 MB RSS on the owner's 659 MB preview home. An empty home idles at about 380 MB.
Where do the other ~500 MB come from?

## Numbers (Linux x64, Bun 1.4.4, `rebuild/5.0-after` @ 5c8bafbfe3, from source, 45-75 s after boot)

RSS is the resident size; **peak** is `VmHWM`, the kernel's high-water mark for the process.

| Home                                            | RSS (idle) |       Peak (VmHWM) |
| ----------------------------------------------- | ---------: | -----------------: |
| empty                                           | 372-386 MB |         438-451 MB |
| 760 completed sessions, no events               | 391-409 MB |         461-467 MB |
| 760 sessions x 30 events (22,800 events, 18 MB) | 431-446 MB |         472-484 MB |
| 760 sessions x 60 events (45,600 events, 36 MB) | 410-493 MB |         517-541 MB |
| 3,000 board cards (12 MB), no sessions          | 419-453 MB |         480-504 MB |
| 760 sessions, one holds 20,000 events (15 MB)   |     501 MB |             694 MB |
| 760 sessions, one holds 200,000 events (150 MB) | 416-654 MB | **2,754-2,856 MB** |

Reading it:

- **Cards and the number of sessions are small**: 3,000 cards cost about 35-70 MB, 760 sessions about 13-30 MB.
- **A journal's size is the large one, and it is a boot-time PEAK, not a steady cost.** One 150 MB journal (the
  owner's host has one of 236,562 events) takes the process to 2.5-2.8 GB in the first seconds, then the JS heap is
  back to the baseline (a heap snapshot after a forced collection is 118 MB with it and 117 MB without it) while the
  RSS stays 40-260 MB above the baseline for as long as the allocator keeps the freed pages (it differed from run
  to run: 416 MB at 45 s in one run, 654 MB in another that was still at 654 MB 110 s in).
- **The peak is about 15 times the journal's bytes above the baseline** (150 MB: 2.75 GB less 0.47 GB; 15 MB: 0.69 GB
  less 0.47 GB).
- The JS heap is not where the idle memory is: `process.memoryUsage().heapUsed` swings between 125 and 340 MB for the
  same home depending on when it is read, and the object snapshot never moves. Use RSS and `VmHWM`.
- Running sessions with no tmux behind them add a steady growth (about 1.8k objects a second, about 5 MB a minute
  with 760 of them); a real daemon supervises real panes, so that is a fixture artefact, noted so nobody chases it.

## Who holds it

The first health tick after boot, and every tick after a stall (a laptop wake, a long pause), runs the DEEP
consistency pass: `StorageConsistencyPass.run(deep)` -> `DaemonStorage.reconcile()` -> `collectSources()` ->
`readJournal(id)` for EVERY session. `readJournal` is `state.lines(...)`, and the kernel's `lines` is not a stream:
it reads the whole file, parses every record into an array and only then yields them
(`packages/core/kernel/host/state/state-port.ts`, `lenient`); `readJournal` then wraps each line again and
`scanJournal` builds a pointer per event. One session's whole journal is therefore in memory several times over, at once,
and `collectSources` keeps every session's pointers until the sweep ends. Instrumented, a boot did exactly one
`collectSources` and 760 journal reads for 760 sessions (the home with 30 events each).

`rebuildIndexYielding` (the boot job) is not it: it reads only sessions the index lacks, one at a time, and a home
whose index is current reads nothing.

## What would bound it (not done here: each is a design change)

1. Stream the journal: a state-port read that hands records out one by one (and `scanJournal` that takes them one
   by one), so one journal costs its pointers, not its text. This is the kernel's `lines`, shared by every plugin.
2. Let `reconcile` skip a session whose journal is unchanged since the index row was written: the row would keep the
   journal's `state.version` etag (device, inode, size, change time), which today lives only in memory
   (`indexedJournals`), so it is empty at every boot and the first pass re-reads everything.
3. `journalPresent` (used by `assertJournalKept` and `assertJournalReadable`) reads a whole journal to learn that it
   has a first line; `state.version(...).size > 0` says the same.

What this does NOT show: the owner's real home (the preview copy). The 875 MB figure is the owner's; the model above
fits it (by the 15x rule a 236k-event journal alone is roughly 3 GB at the peak, an extrapolation, and the allocator can
leave hundreds of MB of that resident) but a snapshot of the
real home's `VmHWM` would confirm it, and no such snapshot was available to this run.

## After streaming the journal (c58 u2-03)

`state.lines` now reads the file in pieces and `readJournal` folds each record into its scan as it comes (items 1 and 3
above are done; item 2, the persisted etag, was done earlier). Same fixture, same machine and Bun, one run each, sampled
every 2 s for 90 s from source, `VmHWM` is the peak:

| Home                                          | Peak (VmHWM) | Against the empty home |
| --------------------------------------------- | -----------: | ---------------------: |
| empty (`generate-home.ts <home> 0 0`)         |       307 MB |                   1.0x |
| 760 sessions, g0 holds 200,000 events, BEFORE |     1,458 MB |                   4.7x |
| 760 sessions, g0 holds 200,000 events, AFTER  |       466 MB |                   1.5x |

The boot's peak with a 200,000-event journal is within twice the empty home's. The absolute numbers are lower than the
table above (a different host); the ratio is what this run proves. Tests that keep it so:
`tests/integration/daemon/session-journal-stream.test.ts` (the journal read holds pointers and a count, never lines or
events; a replay takes only the lines it names) and the kernel's `tests/unit/host-state/lines-stream.test.ts`
(`lines` yields before the whole file is read and never reads it whole).
