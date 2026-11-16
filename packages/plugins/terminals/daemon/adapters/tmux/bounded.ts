import type { SpawnPort } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import type { ControlTimer } from './control-tmux-process.ts';

/** What {@link within} answers when the bound passed first. */
export const TIMED_OUT = Symbol('timed out');

/** `work`, or {@link TIMED_OUT} once `timeoutMs` passed on `after`; the timer is cleared either way. */
export async function within<T>(
  work: Promise<T>,
  timeoutMs: number,
  after: ControlTimer,
): Promise<T | typeof TIMED_OUT> {
  let timer: (() => void) | undefined;
  const timeout = new Promise<typeof TIMED_OUT>(resolve => {
    timer = after(timeoutMs, () => resolve(TIMED_OUT));
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    timer?.();
  }
}

/**
 * The spawn port with a kernel timeout on every child: a question to a wedged tmux is KILLED at the bound, never left
 * running behind a caller that stopped waiting.
 */
export function boundedSpawn(spawn: SpawnPort, timeoutMs: number): SpawnPort {
  const timeout = milliseconds(timeoutMs);
  return {
    run: async (program, args, options) => await spawn.run(program, args, { ...options, timeout }),
    runBytes: async (program, args, options) => await spawn.runBytes(program, args, { ...options, timeout }),
    start: (program, args, options) => spawn.start(program, args, { ...options, timeout }),
  };
}
