import type { SessionView } from '@ferretry/protocol';

/**
 * From this long a Codex start is worth explaining. A healthy one is ready in about a second; every
 * extra millisecond to chatgpt.com adds one (docs/message-delivery.md § "Why a Codex start is slow").
 */
export const SLOW_CODEX_START_MS = 3_000;

/** `4.2 s`: one decimal, so a start that took 4234 ms and one that took 4249 ms read the same. */
export function harnessReadySeconds(milliseconds: number): string {
  return `${(Math.round(Math.max(0, milliseconds) / 100) / 10).toFixed(1)} s`;
}

/**
 * `harness ready in 4.2 s`, or `harness not ready after 31.4 s` when the start gave up waiting (that figure is
 * the time from launch until the wait gave up, at least the 30 s bound, not a startup time), or nothing when this
 * session's start was never measured.
 */
export function harnessReadyWords(view: SessionView): string | undefined {
  const { harnessStartupMs: ready, harnessNotReadyAfterMs: waited } = view.state;
  if (ready !== undefined) return `harness ready in ${harnessReadySeconds(ready)}`;
  return waited === undefined ? undefined : `harness not ready after ${harnessReadySeconds(waited)}`;
}

/**
 * The one line a slow Codex start earns, so nobody blames this machine for the network; nothing for a fast
 * start, an unmeasured one, or any other harness (Claude never waits on an account check).
 */
export function slowCodexStartNote(view: SessionView): string | undefined {
  // A start that gave up waiting was at least that slow, so it earns the same line.
  const measured = view.state.harnessStartupMs ?? view.state.harnessNotReadyAfterMs;
  if (view.config.harness !== 'codex' || measured === undefined || measured < SLOW_CODEX_START_MS) return undefined;
  return 'Codex waits on an account check with chatgpt.com before it starts, so a slow start is usually the network (the first start on a new Codex home also indexes its history once) (docs/message-delivery.md).';
}
