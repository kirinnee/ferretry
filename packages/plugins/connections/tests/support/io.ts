import { accessSync, constants, statSync } from 'node:fs';
import type { Clock, SpawnPort } from '@ferretry/kernel/contract';
import { InstantSchema } from '@ferretry/std';
import { CloudflaredLocator } from '../../adapters/tunnel/cloudflared-locator.ts';

/** Native adapters used only by integration/realworld tests, never by a product half. */
export const clock: Clock = {
  now: () => InstantSchema.parse(new Date().toISOString()),
  nowMs: () => performance.now(),
  after: (delay, fn) => {
    const timer = setTimeout(fn, delay);
    return () => clearTimeout(timer);
  },
  every: (delay, fn) => {
    const timer = setInterval(fn, delay);
    return () => clearInterval(timer);
  },
  sleep: async (delay, signal) => {
    await Bun.sleep(delay);
    if (signal?.aborted) throw signal.reason;
  },
};
export const processes: SpawnPort = {
  run: async () => {
    throw new Error('test does not use run');
  },
  start: (program, args, options) => {
    const child = Bun.spawn([program, ...args], {
      env:
        options?.env === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries(options.env).map(([key, value]) => {
                if (typeof value !== 'string') throw new Error('test spawn cannot open a secret environment handle');
                return [key, value];
              }),
            ),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      pid: child.pid,
      stdout: child.stdout,
      stderr: child.stderr,
      write: chunk => {
        child.stdin.write(chunk);
      },
      kill: signal => {
        child.kill((signal ?? 'SIGTERM') as NodeJS.Signals);
      },
      exited: child.exited.then(code => (child.signalCode === null ? code : null)),
    };
  },
};
export function executableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
export const locator = (environment: Readonly<Record<string, string | undefined>>) =>
  new CloudflaredLocator(environment, (name, path) => Bun.which(name, { PATH: path }) ?? undefined, executableFile);
