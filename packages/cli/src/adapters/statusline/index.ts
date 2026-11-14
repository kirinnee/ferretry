/** The real ports of `fy statusline`: an atomic write of the login's passive usage file, and the person's own command. */
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { StatuslinePorts } from '../../lib/commands/statusline.ts';

/** `<home>/fleet/credentials/<id>/usage.json`: where Logins' daemon reads a `store: ferretry` login's passive reading. */
export const passiveUsagePath = (home: string, credentialId: string): string =>
  join(home, 'fleet', 'credentials', credentialId, 'usage.json').normalize('NFC');

/**
 * Runs the person's own statusLine command through `sh -c`, as Claude itself would, with the same stdin. Its stdout and
 * stderr are this process's, so what it prints is what the status line shows. Bun feeds the stdin itself: a command
 * that never reads its input closes the pipe, and writing it here would raise that EPIPE out of reach.
 */
async function runChained(command: string, stdin: string): Promise<number> {
  const child = Bun.spawn({
    cmd: ['sh', '-c', command],
    stdin: new TextEncoder().encode(stdin),
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return await child.exited;
}

export function createStatuslinePorts(home: string): StatuslinePorts {
  return {
    now: () => Date.now(),
    chain: runChained,
    async writeUsage(credentialId, record) {
      // The id comes from the environment: a name that is not one plain segment is never a path.
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(credentialId)) return;
      const target = passiveUsagePath(home, credentialId);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        await chmod(temporary, 0o600);
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },
  };
}
