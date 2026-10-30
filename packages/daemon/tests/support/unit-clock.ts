/**
 * The unit tier's one clock, for a test that needs to steer it — most never do, because it advances on
 * idle, in order. `unitClock.hold()` then `advance(ms)` / `next()` to look at what is on screen before a
 * timer fires; `turn()` to poll a condition; `quiet()` to let WebCrypto land under a clock of the test's
 * own; `useRealTime(reason)` for the rare test whose subject IS real time. `unit-determinism.ts`, the
 * preload that installs it, says how time moves and why a unit test has no other clock.
 */
export { UNIT_CLOCK_ORIGIN, unitClock } from './unit-determinism.ts';
