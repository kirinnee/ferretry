/**
 * Runtime options the daemon's JavaScript engine reads from its environment, once, as it starts.
 *
 * They can only be set this way: JavaScriptCore reads `BUN_JSC_*` when the VM is created, before any
 * of the daemon's own code runs, so every launch path — the systemd unit, the launchd plist and a
 * direct start — hands them over. A daemon started some other way runs on the engine defaults, which
 * is slower, and exposed to the garbage-collector deadlock below (a declared GAP: nothing the daemon
 * runs can change an engine option once the VM exists).
 *
 * `sampleInterval` is the stack sampler's period in microseconds. The daemon samples its own stack so
 * a stalled event loop can be attributed, and JavaScriptCore's default of one sample per millisecond
 * costs about 13 µs per sample to hand back — a 2 s stall drained 1,824 of them for 24 ms, on the loop
 * that had just stalled. Every 10 ms is a tenth of that and still about a hundred samples a second,
 * which is plenty to say where a stall spent its time.
 *
 * `numberOfGCMarkers` is ONE: the collector marks on its own thread, with no parallel helpers. It is not
 * a speed setting; it is a mitigation, and the evidence for it is observed, not proved. With parallel
 * marking on — the engine default of one marker per core up to seven, or the two this used to ask for —
 * a worker thread wedged for good, often enough to see. Every thread backtrace of every wedge captured
 * (unstripped Bun 1.4.4 under gdb) was exactly these three: Bun's worker loop runs a synchronous
 * collection on the worker (`web_worker.rs` `spin` → `run_gc` → `Heap::collectSync`), which waits for the
 * collector (`waitForCollector`); the collector sits in its concurrent phase waiting for its helpers
 * (`SlotVisitor::drainInParallelPassively`); and the process-wide helper pool's thread waits for shared
 * work that never comes (`SlotVisitor::drainFromShared`). Nothing on that thread runs again — not its
 * timers, not its messages.
 *
 * The daemon starts several workers as it boots, and the one that wedged was the transcript parse
 * thread: every session read waited on it for its 120 s request timeout, so a `POST /v1/sessions` made
 * right after the daemon BOOTED (the restart journey's start, on a freshly restarted daemon) took two
 * minutes and the tmux 3.8 restart journey timed out on CI. Measured on that journey, twelve runs per
 * job on GitHub's runners: two markers wedged 13 runs in 288 (4.5%), the engine default 3 in 96, and one
 * marker none in 96. That is what one marker did in the measured runs — it stopped the wedge there — not a
 * proof that no run can wedge.
 *
 * The cost is the one #719 measured and declined: a single marker trails a busy heap, so the owner-scale
 * fleet (36 sessions, 5 running) let its heap grow toward 1 GB where two markers held it about 60 MB
 * above the default. A larger daemon that did not wedge in the measured runs is the better side of that
 * trade; a marking thread that keeps up without a helper pool is the engine's to fix, not this file's.
 *
 * WHEN A NEW VALUE TAKES EFFECT. These are written into the service definition (and handed to a direct
 * start) by the `fy` that installs, starts or restarts the daemon. A self-update run by the PREVIOUS `fy`
 * restarts the new daemon with the previous `fy`'s engine options: that process's in-process supervisor
 * (`DaemonUpdater` → `lifecycle.restart` → `restartInPlace`) carries its own compiled copy of this
 * constant. So a changed value here reaches a daemon at the next `fy daemon restart` (or start or
 * install) made through the UPDATED `fy`.
 *
 * Both are for the daemon's own process only. It removes every `BUN_JSC_*` variable from its environment
 * as it starts, once the engine has read them, so the agents it launches — Claude Code is a Bun program
 * too — run on their own engine's defaults.
 */
export const DAEMON_RUNTIME_TUNING: Readonly<Record<string, string>> = Object.freeze({
  BUN_JSC_sampleInterval: '10000',
  BUN_JSC_numberOfGCMarkers: '1',
});
