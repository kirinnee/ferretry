import { describe, expect, test } from 'bun:test';
import type { FerretFolderEntry, FerretFolderListing, FerretsApi } from '@ferretry/core-ferrets/contract';
import { cap } from '@ferretry/core-gate/contract';
import { ApiError } from '@ferretry/kernel/contract';
import {
  REFERENCE_CATALOG_FILE_MAX_ENTRIES,
  ReferenceCatalogEntrySchema,
  type ReferenceCatalogCaller,
  type ReferenceCatalogInput,
} from '../../../contract/index.ts';
import { FilesReferenceMenu } from '../../../daemon/references/files-menu.ts';

const PERSON: ReferenceCatalogCaller = {
  actor: 'device:phone',
  credential: { kind: 'authenticated', tokenClass: 'device', principal: { kind: 'device', id: 'phone' } as never },
};
const AGENT = (ferret: string): ReferenceCatalogCaller => ({
  actor: `ferret:${ferret}`,
  credential: { kind: 'authenticated', tokenClass: 'ferret', ferret: ferret as never },
});
const WARDEN: ReferenceCatalogCaller = { credential: { kind: 'authenticated', tokenClass: 'warden' } };

const ask = (query?: string, caller: ReferenceCatalogCaller = PERSON): ReferenceCatalogInput => ({
  ferret: 'f1',
  ...(query === undefined ? {} : { query }),
  caller,
});

interface Asked {
  readonly ferret: string;
  readonly path: string | undefined;
  readonly caller: string | undefined;
}

const menuOf = (answer: (path: string | undefined) => Promise<FerretFolderListing | undefined>) => {
  const asked: Asked[] = [];
  const ferrets: Pick<FerretsApi, 'listFolder'> = {
    listFolder: async (ferret, path, caller) => {
      asked.push({ ferret, path, caller });
      return await answer(path);
    },
  };
  return { menu: new FilesReferenceMenu(ferrets), asked };
};

const listing = (path: string, entries: readonly FerretFolderEntry[]): FerretFolderListing => ({ path, entries });

describe('conversation provides the @ reference menu (reference.catalog)', () => {
  test('it declares filesystem use, what the file browser route itself asks', () => {
    expect(menuOf(async () => undefined).menu.demand).toEqual(cap('filesystem', 'use'));
  });

  test('the root is listed with ferret-root-relative tokens: a folder’s token ends in /', async () => {
    const { menu, asked } = menuOf(async () =>
      listing('', [
        { name: 'src', type: 'dir' },
        { name: 'README.md', type: 'file' },
      ]),
    );
    const entries = await menu.entries(ask());
    expect(entries).toEqual([
      { token: 'src/', label: 'src' },
      { token: 'README.md', label: 'README.md' },
    ]);
    expect(asked).toEqual([{ ferret: 'f1', path: '', caller: undefined }]);
    for (const entry of entries) expect(ReferenceCatalogEntrySchema.safeParse(entry).success).toBe(true);
  });

  test('a folder is asked for one directory at a time: q is the directory (a trailing / ignored) and the tokens carry it', async () => {
    const { menu, asked } = menuOf(async path =>
      listing(path ?? '', [
        { name: 'lib', type: 'dir' },
        { name: 'app.ts', type: 'file' },
      ]),
    );
    const entries = await menu.entries(ask('src/'));
    expect(entries.map(entry => entry.token)).toEqual(['src/lib/', 'src/app.ts']);
    await menu.entries(ask('src/lib'));
    expect(asked.map(a => a.path)).toEqual(['src', 'src/lib']);
  });

  test('a name the browser lists but never serves is offered closed with its reason, and nothing else of it', async () => {
    const { menu } = menuOf(async () =>
      listing('', [
        { name: '.env', type: 'file', denied: true },
        { name: 'dist', type: 'dir', ignored: true },
        { name: 'out', type: 'symlink', escapes: true },
      ]),
    );
    expect(await menu.entries(ask())).toEqual([
      { token: '.env', label: '.env', detail: 'protected: never served', closed: true },
      { token: 'dist/', label: 'dist', detail: 'gitignored: listed, not served', closed: true },
      { token: 'out', label: 'out', detail: 'a link out of this ferret: not served', closed: true },
    ]);
  });

  test('a folder that is not there, or is a file, is an empty menu, not an error (a half-typed path)', async () => {
    for (const status of [400, 404]) {
      const { menu } = menuOf(async () => {
        throw new ApiError(status, 'no such folder', 'not_found');
      });
      expect(await menu.entries(ask('sr'))).toEqual([]);
    }
  });

  test('a refusal that is not "nothing there" passes through: 403 stays 403 (the route answers it), other failures reach the route', async () => {
    const refuse = (status: number) =>
      menuOf(async () => {
        throw new ApiError(status, 'refused', 'escapes_root');
      }).menu.entries(ask('x'));
    expect(await refuse(403).catch((error: unknown) => error)).toMatchObject({ status: 403 });
    expect(await refuse(501).catch((error: unknown) => error)).toMatchObject({ status: 501 });
  });

  test('a ferret Ferrets does not know, or a Ferrets with no listing, offers nothing', async () => {
    expect(await menuOf(async () => undefined).menu.entries(ask())).toEqual([]);
    const none = new FilesReferenceMenu({});
    expect(await none.entries(ask())).toEqual([]);
  });

  test('a person is passed as no caller; a ferret is passed as ITSELF so Ferrets applies mayTouch; the Warden and an admin token naming none read nothing', async () => {
    const { menu, asked } = menuOf(async () => listing('', []));
    await menu.entries(ask('', AGENT('f1')));
    expect(asked).toEqual([{ ferret: 'f1', path: '', caller: 'f1' }]);
    for (const caller of [
      WARDEN,
      { credential: { kind: 'authenticated', tokenClass: 'admin' }, actor: 'agent' } as ReferenceCatalogCaller,
    ]) {
      const refusal = await menu.entries(ask('', caller)).catch((error: unknown) => error);
      expect(refusal).toMatchObject({ status: 403, code: 'not_own_session' });
    }
    expect(asked).toHaveLength(1);
  });

  test('a name too long for a token is left out, never cut into another file’s name; the answer is bounded', async () => {
    const { menu } = menuOf(async () =>
      listing('', [
        { name: 'x'.repeat(600), type: 'file' },
        ...Array.from({ length: REFERENCE_CATALOG_FILE_MAX_ENTRIES + 3 }, (_, i) => ({
          name: `f${String(i)}`,
          type: 'file' as const,
        })),
      ]),
    );
    const entries = await menu.entries(ask());
    expect(entries).toHaveLength(REFERENCE_CATALOG_FILE_MAX_ENTRIES);
    expect(entries.some(entry => entry.token.startsWith('xxxx'))).toBe(false);
    for (const entry of entries) expect(ReferenceCatalogEntrySchema.safeParse(entry).success).toBe(true);
  });

  test('a long label is cut to the entry bound while the token is whole', async () => {
    const name = 'y'.repeat(400);
    const { menu } = menuOf(async () => listing('', [{ name, type: 'file' }]));
    const [entry] = await menu.entries(ask());
    expect(entry?.token).toBe(name);
    expect(entry?.label).toHaveLength(256);
  });
});
