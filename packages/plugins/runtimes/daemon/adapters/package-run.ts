/**
 * Running one package manager for a tool install.
 *
 * The service decides WHAT runs, from its declared table; this adapter only runs it, and is shaped so a run can neither
 * wait on a person nor outlive its deadline:
 *
 * - **An argv array and no shell.** The executable is the absolute manager path the service located; `sudo` is not a
 *   program this plugin may start (its manifest names `brew` and `npm` only).
 * - **stdin is closed at once, never written.** A manager that wants a password or a yes reads end-of-file and fails, which the service reads
 *   as 'needs admin' and answers with a command for a person.
 * - **Only a bounded tail of output is kept**, from stdout and stderr alike, so a failure can be classified and quoted.
 * - **The deadline races the read.** Killing a manager does not close a pipe a grandchild inherited, so the timer resolves
 *   the run itself, and once the manager exits the readers get a short grace and no more.
 */
import type { Clock, SpawnPort } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import type { PackageInstallPort } from '../lib/service/tool-install.ts';

/** How many trailing lines are kept for classifying a failure. */
const TAIL_LINES = 40;

/** How long the readers may finish after the manager exits, for a pipe a grandchild still holds. */
const DRAIN_GRACE_MS = 1_000;

async function collect(stream: ReadableStream<Uint8Array>, tail: string[]): Promise<void> {
  const decoder = new TextDecoder();
  let pending = '';
  const keep = (line: string): void => {
    tail.push(line);
    if (tail.length > TAIL_LINES) tail.shift();
  };
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    const parts = pending.split('\n');
    pending = parts.pop() ?? '';
    for (const part of parts) keep(part);
  }
  pending += decoder.decode();
  if (pending !== '') keep(pending);
}

function after<T>(clock: Clock, delay: number, value: T): { readonly done: Promise<T>; readonly cancel: () => void } {
  let cancel: () => void = () => undefined;
  const done = new Promise<T>(resolve => {
    cancel = clock.after(milliseconds(delay), () => resolve(value));
  });
  return { done, cancel };
}

export function packageRunner(spawn: () => SpawnPort, clock: Clock): PackageInstallPort {
  return async run => {
    let child: ReturnType<SpawnPort['start']>;
    try {
      // Plain values only: the environment the service built (the manager's own directory first on PATH).
      const env = Object.fromEntries(
        Object.entries(run.environment).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      );
      child = spawn().start(run.executable, run.args, { env, stdin: '' });
    } catch (error) {
      return { kind: 'not-started', reason: error instanceof Error ? error.message : String(error) };
    }
    const tail: string[] = [];
    const readers = Promise.all([collect(child.stdout, tail), collect(child.stderr, tail)]).catch(() => undefined);
    const deadline = after(clock, run.timeoutMs, 'timed-out' as const);
    const ended = await Promise.race([child.exited.catch(() => null), deadline.done]);
    deadline.cancel();
    if (ended === 'timed-out') {
      child.kill('SIGKILL');
      return { kind: 'timed-out', tail: [...tail] };
    }
    const grace = after(clock, DRAIN_GRACE_MS, undefined);
    await Promise.race([readers, grace.done]);
    grace.cancel();
    return { kind: 'exited', code: ended ?? -1, tail: [...tail] };
  };
}
