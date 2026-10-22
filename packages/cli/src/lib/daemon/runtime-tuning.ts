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
 * which is plenty to say where a stall spent its time. Inherited by the agents the daemon starts, where
 * it does nothing unless one starts a sampling profiler of its own.
 */
export const DAEMON_RUNTIME_TUNING: Readonly<Record<string, string>> = Object.freeze({
  BUN_JSC_sampleInterval: '10000',
});
