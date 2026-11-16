import { readlinkSync } from 'node:fs';
import type { IJobProcess, IJobSignals, IJobTimers } from '../../lib/jobs/ports.ts';

/** This process, as the job verbs read it. */
export class RealJobProcess implements IJobProcess {
  get pid(): number {
    return process.pid;
  }

  cwd(): string {
    return process.cwd();
  }

  /** Linux names a descriptor's target under /proc; macOS has no such file, so nothing is learned there. */
  stdoutFile(): string | undefined {
    try {
      const target = readlinkSync('/proc/self/fd/1');
      return target.startsWith('/') ? target : undefined;
    } catch {
      return undefined;
    }
  }
}

const SIGNALS = ['SIGTERM', 'SIGHUP', 'SIGINT'] as const;

/**
 * An attachment must NEVER die of the signal itself — that would be the default action — nor forward it: it hears it, says it
 * detached, and leaves the job alone. Listening replaces the default; stopping restores nothing (the process is ending).
 */
export class RealJobSignals implements IJobSignals {
  listen(onSignal: (name: string) => void): () => void {
    const handlers = SIGNALS.map(name => {
      const handler = (): void => onSignal(name);
      process.on(name, handler);
      return [name, handler] as const;
    });
    return () => {
      for (const [name, handler] of handlers) process.off(name, handler);
    };
  }
}

export class RealJobTimers implements IJobTimers {
  nowMs(): number {
    return Date.now();
  }

  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>(resolve => {
      if (signal?.aborted === true) return resolve();
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      }
      signal?.addEventListener('abort', done, { once: true });
    });
  }
}
