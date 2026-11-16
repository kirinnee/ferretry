/**
 * How long Ferrets waits for EACH taker of `start.decide` (the kernel's per-taker decide bound).
 *
 * It is a hang guard, not a latency budget. The kernel's default (200 ms) fits a taker that answers from memory, but a
 * taker of this hook reads a file (Runtimes reads the published fleet manifest under the publication lock), so on a
 * busy machine a healthy answer can take a second or more. At 200 ms that turned into
 * `409 {"error":"runtimes did not answer in time."}` on a start that was fine (full-ci Integration, PR 1685,
 * `ferret-auth.test.ts` merge bar 11). 10 s is far above any healthy read and still ends a taker that is truly hung
 * with the same named refusal, inside the time a person waits on a start before looking away.
 *
 * `auto-resume.decide` keeps the kernel default: its tests pin a late answer as a refusal (fails closed).
 */
export const DECIDE_ASK_TIMEOUT_MS = 10_000;
