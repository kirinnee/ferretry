import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { decideHome, HomeJsonSchema } from '@ferretry/kernel/contract';
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

/**
 * Why a service definition may not be written for `home`, or `undefined` when it is a Ferretry 5 home. Reads only.
 * A folder with content and no usable `home.json` (a Ferretry 4 home above all) is refused with the SAME sentence the
 * daemon gives (`decideHome`, one owner of the words): it names the carry-over prompt and the way back to Ferretry 4,
 * and says nothing was changed. "The daemon creates it on its first start" is true only of a folder that is missing or
 * empty, so it is said only of those.
 */
export async function serviceRefusal(home: string): Promise<string | undefined> {
  const state = await homeMarker.inspect(home);
  if (state === 'claimed') return undefined;
  if (state === 'absent' || state === 'empty')
    return `${home} is not a Ferretry home; the daemon creates it on its first start`;
  const text = await readFile(join(home, 'home.json'), 'utf8').catch(() => undefined);
  const decision = decideHome(home, text === undefined ? { kind: 'no-home-json' } : { kind: 'home-json', text });
  return decision.kind === 'refuse' ? decision.sentence : undefined;
}
