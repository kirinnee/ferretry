/**
 * Running one package manager for a harness install (`docs/design/account-model.md` §8.6).
 *
 * The service decides WHAT runs, from its declared table; this adapter only runs it, and is shaped so
 * a run can neither wait on a person nor outlive its deadline:
 *
 * - **An argv array and no shell.** The executable is the absolute manager path the service located.
 * - **stdin is closed.** A manager that wants a password or a yes reads end-of-file and fails, which the
 *   service reads as "needs admin" and answers with a command for a person. Nothing can sit waiting.
 * - **Only a bounded tail of output is kept**, from stdout and stderr alike, so a failure can be
 *   classified and quoted. It is handed back once and never stored.
 * - **The deadline races the read.** Killing a manager does not close a pipe a grandchild inherited, so
 *   a deadline that only signalled would still wait for an end-of-stream that never comes. The timer
 *   resolves the run itself, and once the manager exits the readers get a short grace and no more.
 */
import type { PackageInstallPort } from '../../lib/fleet/tool-install.ts';

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

/** A promise that resolves after `milliseconds` without holding the daemon open. */
function after<T>(milliseconds: number, value: T): { readonly done: Promise<T>; readonly cancel: () => void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<T>(resolve => {
    handle = setTimeout(() => resolve(value), milliseconds);
    handle.unref?.();
  });
  return { done, cancel: () => clearTimeout(handle) };
}

/** Run one package manager to completion or to its deadline. */
export const runPackageInstall: PackageInstallPort = async run => {
  let child: ReturnType<typeof Bun.spawn<'ignore', 'pipe', 'pipe'>>;
  try {
    child = Bun.spawn({
      cmd: [run.executable, ...run.args],
      env: run.environment,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (error) {
    return { kind: 'not-started', reason: error instanceof Error ? error.message : String(error) };
  }
  const tail: string[] = [];
  // A reader that throws is a stream that ended abruptly, which the exit code already reports.
  const readers = Promise.all([collect(child.stdout, tail), collect(child.stderr, tail)]).catch(() => undefined);
  const deadline = after(run.timeoutMs, 'timed-out' as const);
  const ended = await Promise.race([child.exited, deadline.done]);
  deadline.cancel();
  if (ended === 'timed-out') {
    child.kill('SIGKILL');
    return { kind: 'timed-out', tail: [...tail] };
  }
  const grace = after(DRAIN_GRACE_MS, undefined);
  await Promise.race([readers, grace.done]);
  grace.cancel();
  return { kind: 'exited', code: ended, tail: [...tail] };
};
