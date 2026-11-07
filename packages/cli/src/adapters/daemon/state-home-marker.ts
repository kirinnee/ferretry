import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { HomeJsonSchema } from '@ferretry/kernel/contract';
import type { IStateHomeClaimPort } from '../../lib/daemon/ports.ts';

/**
 * Whether a state home carries the format-1 marker (`home.json`) the kernel writes when it creates one. Reads only,
 * never writes: the kernel makes a home itself, and a reset is the one verb that must prove a directory is ours before
 * it deletes it. A home that is not there is `absent`; one that is there with nothing in it is `empty`, which is what
 * the daemon's first start turns into a home. Anything else without the marker is `unclaimed`.
 */
export const homeMarker: Pick<IStateHomeClaimPort, 'inspect'> = {
  async inspect(home) {
    const found = await stat(home).catch(() => undefined);
    if (found === undefined) return 'absent';
    try {
      return HomeJsonSchema.safeParse(JSON.parse(await readFile(join(home, 'home.json'), 'utf8'))).success
        ? 'claimed'
        : 'unclaimed';
    } catch {
      const entries = found.isDirectory() ? await readdir(home).catch(() => undefined) : undefined;
      return entries?.length === 0 ? 'empty' : 'unclaimed';
    }
  },
};
