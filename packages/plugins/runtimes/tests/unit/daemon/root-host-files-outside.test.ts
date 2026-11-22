/**
 * A name whose parent folder is not there reads as absent by the kernel's TYPED refusal (`refusal === 'outside'`), never by
 * the words of its message: a refusal with another message still reads absent, and the same words on a plain error do not.
 */
import { describe, expect, it } from 'bun:test';
import type { RootHandle, RootsPort } from '@ferretry/kernel/contract';
import { fleetMounts, rootHostFiles } from '../../../daemon/adapters/root-host-files.ts';

const FLEET = '/state/fleet';

/** A root whose every look throws `thrown`, as the kernel does when a folder above the name is not there. */
const refusingFiles = (thrown: Error) => {
  const handle = {
    resolve: (inside: string) => ({ ok: true, value: inside }),
    lstat: async () => {
      throw thrown;
    },
  } as unknown as RootHandle;
  const roots = { root: () => handle } as unknown as Pick<RootsPort, 'root'>;
  return rootHostFiles(fleetMounts(roots, handle, FLEET));
};

const typed = (refusal: string, message: string): Error => Object.assign(new Error(message), { refusal });

describe('a name whose parent folder is not there', () => {
  it('reads as absent when the kernel refuses as "outside", whatever the message says', async () => {
    const files = refusingFiles(typed('outside', 'the folder above is not here'));

    expect(await files.lstat(`${FLEET}/assets/skills`)).toBeUndefined();
    expect(await files.readText(`${FLEET}/assets/skills/a.md`)).toBeUndefined();
  });

  it('is still refused when the words match but the error is not a typed "outside" refusal', async () => {
    const files = refusingFiles(new Error('root refused: outside'));

    await expect(files.lstat(`${FLEET}/assets/skills`)).rejects.toThrow('root refused: outside');
  });

  it('is still refused for another typed refusal', async () => {
    const files = refusingFiles(typed('changed', 'root refused: changed'));

    await expect(files.lstat(`${FLEET}/assets/skills`)).rejects.toThrow('root refused: changed');
  });
});
