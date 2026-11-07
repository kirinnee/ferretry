/**
 * Running one package manager for a Codex update.
 *
 * The service decides WHAT runs, from its declared recipe; this adapter only runs it, and is shaped so a run can neither
 * wait on a person nor outlive its deadline:
 *
 * - **An argv array and no shell.** The executable is the absolute manager path the service located.
 * - **stdin is never written.** A manager that wants a password or a yes reads nothing and fails, which the service
 *   reads as 'needs admin' and answers with a command for a person. Nothing can sit waiting.
 * - **Only a bounded tail of output is kept**, from stdout and stderr alike, so a failure can be classified and quoted.
 *   It is handed back once and never stored.
 * - **The deadline races the read.** Killing a manager does not close a pipe a grandchild inherited, so a deadline that
 *   only signalled would still wait for an end-of-stream that never comes. The timer resolves the run itself, and once
 *   the manager exits the readers get a short grace and no more.
 */
import type { Clock, SpawnPort } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import { installEnvironment, type PackageInstallPort } from '../lib/update/index.ts';
import type { HostPrograms } from './host-programs.ts';

/** How many trailing lines are kept for classifying a failure. */
const TAIL_LINES = 40;

/** How long the readers may finish after the manager exits, for a pipe a grandchild still holds. */
const DRAIN_GRACE_MS = 1_000;

/** Read one stream into `tail`, keeping only the last {@link TAIL_LINES} lines. */
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

/** A promise that resolves after `delay` milliseconds on the kernel's clock. */
function after<T>(clock: Clock, delay: number, value: T): { readonly done: Promise<T>; readonly cancel: () => void } {
  let cancel: () => void = () => undefined;
  const done = new Promise<T>(resolve => {
    cancel = clock.after(milliseconds(delay), () => resolve(value));
  });
  return { done, cancel };
}

export function packageRunner(spawn: SpawnPort, clock: Clock, host: HostPrograms): PackageInstallPort {
  return async run => {
    const inherited = await host.environment('PATH');
    let child: ReturnType<SpawnPort['start']>;
    try {
      child = spawn.start(run.executable, run.args, { env: installEnvironment(run.executable, { PATH: inherited }) });
    } catch (error) {
      return { kind: 'not-started', reason: error instanceof Error ? error.message : String(error) };
    }
    const tail: string[] = [];
    // A reader that throws is a stream that ended abruptly, which the exit code already reports.
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
