import { describe, expect, test } from 'bun:test';
import type { ScratchDirectory, ScratchPort } from '@ferretry/kernel/contract';
import { ScratchWardenWorkFolders } from '../../daemon/adapters/work-folders.ts';

/** A scratch port that records what it was asked, so the folders' lifecycle can be read off it. */
function scratch(options: { readonly openFails?: number } = {}) {
  const log: string[] = [];
  let failures = options.openFails ?? 0;
  const port = {
    open: async (): Promise<ScratchDirectory> => {
      log.push('open');
      if (failures > 0) {
        failures -= 1;
        throw new Error('the scratch folder could not be made');
      }
      return {
        path: '/scratch/warden',
        makeDirectory: async (name: string) => void log.push(`mkdir ${name}`),
        close: async () => void log.push('close'),
      } as unknown as ScratchDirectory;
    },
  } as unknown as ScratchPort;
  return { log, folders: new ScratchWardenWorkFolders(port) };
}

describe('the investigators work folders over the kernel scratch folder (the real adapter)', () => {
  test('opens the scratch folder once, on the first investigation, and gives each callsign its own folder inside it', async () => {
    const { log, folders } = scratch();
    expect(log).toEqual([]);
    expect(await folders.folderFor('wd-1')).toBe('/scratch/warden/wd-1');
    expect(await folders.folderFor('wd-2')).toBe('/scratch/warden/wd-2');
    expect(log).toEqual(['open', 'mkdir wd-1', 'mkdir wd-2']);
  });

  test('turns away a name that is not a plain callsign before anything is opened', async () => {
    const { log, folders } = scratch();
    await expect(folders.folderFor('../etc')).rejects.toThrow('plain callsign');
    expect(log).toEqual([]);
  });

  test('a scratch folder that could not be opened is tried again by the next investigation', async () => {
    const { log, folders } = scratch({ openFails: 1 });
    await expect(folders.folderFor('wd-1')).rejects.toThrow('could not be made');
    expect(await folders.folderFor('wd-1')).toBe('/scratch/warden/wd-1');
    expect(log).toEqual(['open', 'open', 'mkdir wd-1']);
  });

  test('closing removes the scratch folder it opened, once, and does nothing when none was opened', async () => {
    const { log, folders } = scratch();
    await folders.close();
    expect(log).toEqual([]);
    await folders.folderFor('wd-1');
    await folders.close();
    await folders.close();
    expect(log).toEqual(['open', 'mkdir wd-1', 'close']);
  });

  test('closing after an open that failed leaves nothing to remove', async () => {
    const { log, folders } = scratch({ openFails: 1 });
    await expect(folders.folderFor('wd-1')).rejects.toThrow();
    await folders.close();
    expect(log).toEqual(['open']);
  });
});
