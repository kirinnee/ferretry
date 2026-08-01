import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { IMarkerProbe, IReadsClock, IReadsDeadline } from '../../lib/reads/ports.ts';

/** One real timer that is always detached from its signal before it resolves. */
function cancellableTimer(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise<void>(done => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      done();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/** Real time and real sleeping, for the follow and the wait. */
export class SystemPollClock implements IReadsClock {
  nowMs(): number {
    return Date.now();
  }

  async sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    await cancellableTimer(milliseconds, signal);
  }

  startDeadline(milliseconds: number): IReadsDeadline {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), milliseconds);
    return {
      signal: controller.signal,
      cancel: () => clearTimeout(timer),
    };
  }
}

/**
 * The deliverable a `--until-marker` wait is gated on.
 *
 * The invocation directory is INJECTED rather than read from `process.cwd()`: the CLI's composition
 * root already supplies its own cwd for exactly this reason, so an in-process journey resolves a
 * relative marker against the directory the caller was in and not the one the test harness happens to
 * be running from.
 */
export class FileMarkerProbe implements IMarkerProbe {
  constructor(private readonly cwd: string) {}

  resolve(path: string): string {
    return isAbsolute(path) ? path : resolve(this.cwd, path);
  }

  async exists(path: string): Promise<boolean> {
    return existsSync(this.resolve(path));
  }
}
