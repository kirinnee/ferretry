import { describe, expect, test } from 'bun:test';
import type { FerretId, FerretRecord } from '../../../../contract/index.ts';
import { T0 } from '../../../../contract/testing/index.ts';
import { FerretsService, type FerretsPorts } from '../../../../daemon/lib/ferrets/service.ts';
import { FerretRegistry } from '../../../../daemon/lib/registry/registry.ts';
import { FerretTokenDirectory } from '../../../../daemon/lib/tokens/tokens.ts';

const record: FerretRecord = {
  format: 1,
  id: 'f1' as FerretId,
  name: 'fern',
  role: 'lead',
  harness: 'claude-code',
  runner: 'tmux',
  folder: '/home/owner/work/project',
  state: 'working',
  createdAt: T0,
  stateAt: T0,
};

/** The service with only the seams `workFolder` reads; nothing else may be reached. */
const service = (realPath?: (folder: string) => Promise<string | undefined>) =>
  new FerretsService(new FerretRegistry([record]), new FerretTokenDirectory(), {
    ready: async () => undefined,
    ...(realPath === undefined ? {} : { realPath }),
  } as unknown as FerretsPorts);

describe('a ferret’s work folder (Accounts’ sign-in ordering)', () => {
  test('a recorded folder that is still its own real path is answered', async () => {
    const asked: string[] = [];
    const answer = await service(async folder => {
      asked.push(folder);
      return folder;
    }).workFolder(record.id);
    expect(answer).toEqual({ folder: '/home/owner/work/project' });
    expect(asked).toEqual(['/home/owner/work/project']);
  });

  test('a folder swapped for a symlink elsewhere, or one that cannot be resolved, answers nothing', async () => {
    expect(await service(async () => '/home/owner/other').workFolder(record.id)).toBeUndefined();
    expect(await service(async () => undefined).workFolder(record.id)).toBeUndefined();
    expect(
      await service(async () => {
        throw new Error('ENOENT');
      }).workFolder(record.id),
    ).toBeUndefined();
  });

  test('an unknown ferret, or no real-path seam bound, answers nothing', async () => {
    expect(await service(async folder => folder).workFolder('nobody' as FerretId)).toBeUndefined();
    expect(await service().workFolder(record.id)).toBeUndefined();
  });
});
