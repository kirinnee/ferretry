/**
 * Runtime options the daemon's JavaScript engine reads from its environment, once, as it starts.
 *
 * They can only be set this way: JavaScriptCore reads `BUN_JSC_*` when the VM is created, before any
 * of the daemon's own code runs, so every launch path — the systemd unit, the launchd plist and a
 * direct start — hands them over. A daemon started some other way runs on the engine defaults, which
 * is slower but not wrong.
 *
 * `sampleInterval` is the stack sampler's period in microseconds. The daemon samples its own stack so
 * a stalled event loop can be attributed, and JavaScriptCore's default of one sample per millisecond
 * costs about 13 µs per sample to hand back — a 2 s stall drained 1,824 of them for 24 ms, on the loop
 * that had just stalled. Every 10 ms is a tenth of that and still about a hundred samples a second,
 * which is plenty to say where a stall spent its time.
 *
 * `numberOfGCMarkers` caps the garbage collector's parallel marking threads. By default the engine
 * starts one per core, up to seven, and on a daemon whose heap is a few hundred megabytes they spend most
 * of each collection spinning in `sched_yield` waiting for work: on the owner-scale fleet (36 sessions,
 * 5 running) two markers cut those yields from 117,832 to 8,259 per 30 s and the daemon's CPU from 17.2%
 * to 15.3% of a core, for about 60 MB more resident memory. One marker cut CPU further but let the heap
 * grow to 1 GB, so it is two.
 *
 * Both are for the daemon's own process only. It removes every `BUN_JSC_*` variable from its environment
 * as it starts, once the engine has read them, so the agents it launches — Claude Code is a Bun program
 * too — run on their own engine's defaults.
 */
export const DAEMON_RUNTIME_TUNING: Readonly<Record<string, string>> = Object.freeze({
  BUN_JSC_sampleInterval: '10000',
  BUN_JSC_numberOfGCMarkers: '2',
});
