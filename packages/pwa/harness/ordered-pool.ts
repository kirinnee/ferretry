/**
 * RUN INDEPENDENT HARNESS TASKS TOGETHER, AND PRINT THEM IN ONE FIXED ORDER.
 *
 * Each task owns its own browser context (own storage, viewport, theme), so two of them share nothing
 * but the Playwright connection. What they print is another matter: lines from two walks interleaved
 * would make a log nobody can read and a diff between two runs nobody can trust. So everything a task
 * writes to stdout or stderr is held in that task's own buffer, and the buffers are released in the
 * order the tasks were LISTED — whichever finished first. A failure is thrown after every started task
 * has finished and been printed, and it is the failure of the earliest task in the list, so the same
 * defect names the same task on every run.
 *
 * Which task STARTS next is a different order: the longest first, so a short one never waits behind a
 * long one that could have begun earlier. That order shows up in wall time only, never in the log.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

type Chunk = { readonly stream: 'stdout' | 'stderr'; readonly text: string | Uint8Array };

const held = new AsyncLocalStorage<Chunk[]>();
let installed = false;

const install = (): void => {
  if (installed) return;
  installed = true;
  for (const name of ['stdout', 'stderr'] as const) {
    const stream = process[name];
    const original = stream.write.bind(stream) as (...args: unknown[]) => boolean;
    stream.write = ((text: string | Uint8Array, ...rest: unknown[]): boolean => {
      const buffer = held.getStore();
      if (buffer === undefined) return original(text, ...rest);
      buffer.push({ stream: name, text });
      const done = rest.find(argument => typeof argument === 'function') as (() => void) | undefined;
      done?.();
      return true;
    }) as typeof stream.write;
  }
};

export type PoolTask = {
  readonly run: () => Promise<void>;
  /** Bigger starts sooner. Only the start order follows it; the printed order is the list order. */
  readonly weight: number;
};

export const runOrderedPool = async (tasks: readonly PoolTask[], limit: number): Promise<void> => {
  install();
  const buffers = tasks.map((): Chunk[] => []);
  const settled = tasks.map(() => false);
  const failures = new Map<number, unknown>();
  let printed = 0;
  const flush = (): void => {
    while (printed < tasks.length && settled[printed] === true) {
      for (const chunk of buffers[printed] ?? []) process[chunk.stream].write(chunk.text);
      buffers[printed] = [];
      printed += 1;
    }
  };
  const queue = tasks
    .map((task, index) => ({ task, index }))
    .sort((a, b) => b.task.weight - a.task.weight || a.index - b.index);
  const worker = async (): Promise<void> => {
    for (;;) {
      if (failures.size > 0) return;
      const next = queue.shift();
      if (next === undefined) return;
      try {
        await held.run(buffers[next.index] as Chunk[], next.task.run);
      } catch (cause) {
        failures.set(next.index, cause);
      }
      settled[next.index] = true;
      flush();
    }
  };
  // A harness that calls process.exit (its `fail` does) would take every held line with it, including
  // the message that says why. Release what is held, in list order, before the process goes.
  const exit = process.exit.bind(process);
  process.exit = ((code?: number): never => {
    held.exit(() => {
      for (let index = printed; index < tasks.length; index += 1)
        for (const chunk of buffers[index] ?? []) process[chunk.stream].write(chunk.text);
    });
    return exit(code);
  }) as typeof process.exit;
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker));
  } finally {
    process.exit = exit as typeof process.exit;
  }
  // Tasks that never started (a failure stopped the queue) print nothing and are not waited for.
  for (const [index] of tasks.entries()) if (!settled[index]) settled[index] = true;
  flush();
  const first = [...failures.keys()].sort((a, b) => a - b)[0];
  if (first !== undefined) throw failures.get(first);
};
