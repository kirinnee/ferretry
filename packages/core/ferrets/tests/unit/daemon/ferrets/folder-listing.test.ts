import { describe, expect, test } from 'bun:test';
import { ApiError, FsError, type FsErrorCode } from '@ferretry/kernel/contract';
import { ferretId } from '../../../../contract/testing/index.ts';
import { folderLister, FS_ERROR_STATUS } from '../../../../daemon/lib/ferrets/folder-listing.ts';
import { AGENT_READ_FENCE, type FsListing } from '../../../../daemon/lib/session/filesystem/index.ts';

const F1 = ferretId('f1');
const F2 = ferretId('f2');
const OTHER = ferretId('f3');

const LISTING: FsListing = {
  root: '/work/project',
  path: 'src',
  entries: [
    { name: 'lib', type: 'dir', mtime: '2026-11-07T00:00:00.000Z' },
    { name: 'app.ts', type: 'file', size: 4_096, mtime: '2026-11-07T00:00:00.000Z' },
    { name: '.env', type: 'file', size: 12, denied: true },
    { name: 'dist', type: 'dir', ignored: true },
    { name: 'out', type: 'symlink', escapes: true },
  ],
};

interface Asked {
  readonly folder: string;
  readonly path: string | undefined;
  readonly options: unknown;
}

const lister = (
  over: {
    readonly list?: () => Promise<FsListing>;
    readonly touches?: (caller: string, target: string) => boolean;
  } = {},
) => {
  const asked: Asked[] = [];
  const touched: string[] = [];
  const list = folderLister({
    folderOf: id => (id === F1 || id === F2 ? `/work/${id}` : undefined),
    filesystem: ferret => ({
      list: async (folder, path, options) => {
        asked.push({ folder, path, options });
        touched.push(ferret);
        return await (over.list ?? (async () => LISTING))();
      },
    }),
    mayTouch: (caller, target) => (over.touches ?? ((c, t) => c === t))(caller, target),
  });
  return { list, asked, touched };
};

describe('FerretsApi.listFolder lists one folder through the file browser’s service and its fence', () => {
  test('it answers names, types and the three badges, and nothing else of an entry (no size, no time)', async () => {
    const { list } = lister();
    const answer = await list(F1, 'src');
    expect(answer).toEqual({
      path: 'src',
      entries: [
        { name: 'lib', type: 'dir' },
        { name: 'app.ts', type: 'file' },
        { name: '.env', type: 'file', denied: true },
        { name: 'dist', type: 'dir', ignored: true },
        { name: 'out', type: 'symlink', escapes: true },
      ],
    });
    expect(JSON.stringify(answer)).not.toContain('4096');
    expect(JSON.stringify(answer)).not.toContain('/work');
  });

  test('a truncated listing says so', async () => {
    const { list } = lister({ list: async () => ({ ...LISTING, truncated: true }) });
    expect((await list(F1, 'src'))?.truncated).toBe(true);
  });

  test('the folder is the ferret’s own folder and the listing is ALWAYS read under the agent fence, for a person too', async () => {
    const { list, asked } = lister();
    await list(F1, 'src');
    await list(F1, undefined, F1);
    expect(asked).toEqual([
      { folder: '/work/f1', path: 'src', options: { fence: AGENT_READ_FENCE } },
      { folder: '/work/f1', path: undefined, options: { fence: AGENT_READ_FENCE } },
    ]);
  });

  test('a ferret this daemon does not know answers undefined and nothing is listed', async () => {
    const { list, touched } = lister();
    expect(await list(OTHER, '')).toBeUndefined();
    expect(touched).toEqual([]);
  });

  test('a ferret reads only itself and its helpers: anyone else is refused 403 forbidden BEFORE the folder is touched', async () => {
    const { list, touched } = lister({ touches: (caller, target) => caller === F1 && target === F1 });
    expect((await list(F1, '', F1))?.path).toBe('src');
    const refusal = await list(F2, '', F1).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ApiError);
    expect(refusal).toMatchObject({ status: 403, code: 'forbidden' });
    expect(touched).toEqual([F1]);
  });

  test('each refusal of the browser keeps the status its own route answers', async () => {
    for (const code of Object.keys(FS_ERROR_STATUS) as FsErrorCode[]) {
      const { list } = lister({
        list: async () => {
          throw new FsError(code, `refused ${code}`);
        },
      });
      const refusal = await list(F1, 'x').catch((error: unknown) => error);
      expect(refusal).toMatchObject({ status: FS_ERROR_STATUS[code], code });
    }
    expect(FS_ERROR_STATUS.escapes_root).toBe(403);
    expect(FS_ERROR_STATUS.not_found).toBe(404);
  });

  test('a failure that is not the browser’s own passes through unchanged', async () => {
    const boom = new Error('disk gone');
    const { list } = lister({
      list: async () => {
        throw boom;
      },
    });
    expect(await list(F1, 'x').catch((error: unknown) => error)).toBe(boom);
  });
});
