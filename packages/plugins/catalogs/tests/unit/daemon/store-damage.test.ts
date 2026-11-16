/**
 * A DAMAGED STORE IS REFUSED THE WAY TODAY'S STORE REFUSED IT: each of Catalogs' stores keeps its own refusal class,
 * code, status and words, because a caller catches that class and a person reads that sentence. A damaged file is never
 * read as an empty one. Proven on the real daemon half for the stores a route reads, and on the store adapter for all
 * five damage voices (members, shares, catalogs, links, installs and their preferences).
 */
import { describe, expect, it } from 'bun:test';
import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import { z } from 'zod';
import {
  catalogsDamage,
  documentStore,
  installsDamage,
  linksDamage,
  membersDamage,
} from '../../../daemon/adapters/state.ts';
import { CatalogInstallStateError } from '../../../daemon/lib/catalog-installs/store.ts';
import { CatalogLinkRefusal } from '../../../daemon/lib/catalog-links/refusal.ts';
import { CatalogMemberRefusal } from '../../../daemon/lib/catalog-members/refusal.ts';
import { CatalogRefusal } from '../../../daemon/lib/shared-catalogs/refusal.ts';
import { catalogsFixture } from '../../support/daemon-host.ts';

const FILE = { name: 'x', path: 'x.json', store: 'json', format: 1 } as unknown as StateFileDef;
const Document = z.strictObject({ items: z.array(z.string()) });
const EMPTY = { items: [] as string[] };

/** A state port whose one file reads as the test says: damaged, valid but wrong, or good. */
function stateReading(result: { ok: false } | { ok: true; value: unknown }): StatePort {
  return { read: async () => result, write: async () => undefined } as unknown as StatePort;
}

async function refusalOf(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
}

describe('the damage each store speaks', () => {
  const cases = [
    ['members and shares', membersDamage, CatalogMemberRefusal, 'nobody shared with'],
    ['catalogs', catalogsDamage, CatalogRefusal, 'no catalogs'],
    ['links', linksDamage, CatalogLinkRefusal, 'no links'],
  ] as const;

  for (const [name, damage, refusalClass, remedy] of cases) {
    it(`should refuse a ${name} file that cannot be read, as its own class, and name the remedy`, async () => {
      // Arrange
      const store = documentStore(stateReading({ ok: false }), FILE, Document, EMPTY, damage);

      // Act
      const error = await refusalOf(store.read);

      // Assert
      expect(error).toBeInstanceOf(refusalClass);
      expect((error as Error).message).toContain('cannot be read');
      expect((error as Error).message).toContain('Restore the file from a backup, or move it aside to start with');
      expect((error as Error).message).toContain(remedy);
    });

    it(`should refuse a ${name} file that is not the document it writes, as its own class`, async () => {
      // Arrange
      const store = documentStore(stateReading({ ok: true, value: { items: 3 } }), FILE, Document, EMPTY, damage);

      // Act
      const error = await refusalOf(store.read);

      // Assert
      expect(error).toBeInstanceOf(refusalClass);
      expect((error as Error).message).toContain('x.json cannot be read');
    });

    it(`should refuse to write a ${name} document that breaks a rule of its file, writing nothing`, async () => {
      // Arrange
      const writes: unknown[] = [];
      const state = {
        read: async () => ({ ok: true, value: undefined }),
        write: async (_f: unknown, v: unknown) => writes.push(v),
      };
      const store = documentStore(state as unknown as StatePort, FILE, Document, EMPTY, damage);

      // Act
      const error = await refusalOf(async () => await store.write({ items: 3 } as never));

      // Assert
      expect(error).toBeInstanceOf(refusalClass);
      expect((error as Error).message).toContain('x.json was not written');
      expect(writes).toEqual([]);
    });
  }

  it('should carry today’s codes: store_damaged for members, shares and catalogs, links_store_damaged for links', async () => {
    // Arrange
    const read = async (damage: Parameters<typeof documentStore>[4]) =>
      await refusalOf(documentStore(stateReading({ ok: false }), FILE, Document, EMPTY, damage).read);

    // Act
    const members = (await read(membersDamage)) as CatalogMemberRefusal;
    const catalogs = (await read(catalogsDamage)) as CatalogRefusal;
    const links = (await read(linksDamage)) as CatalogLinkRefusal;

    // Assert
    expect(members.refusal).toBe('store_damaged');
    expect(catalogs.refusal).toBe('store_damaged');
    expect(links.refusal).toBe('links_store_damaged');
  });

  it('should refuse a damaged installs or preferences file as a CatalogInstallStateError, saying what was not changed', async () => {
    // Arrange
    const installs = documentStore(
      stateReading({ ok: false }),
      FILE,
      Document,
      EMPTY,
      installsDamage('install', 'installs'),
    );
    const prefs = documentStore(
      stateReading({ ok: true, value: { items: 3 } }),
      FILE,
      Document,
      EMPTY,
      installsDamage('preference', 'preferences'),
    );

    // Act
    const unreadable = await refusalOf(installs.read);
    const invalid = await refusalOf(prefs.read);

    // Assert
    expect(unreadable).toBeInstanceOf(CatalogInstallStateError);
    expect((unreadable as Error).message).toBe('x.json is not JSON, so no install was changed');
    expect(invalid).toBeInstanceOf(CatalogInstallStateError);
    expect((invalid as Error).message).toBe(
      'x.json is not a record of preferences this daemon writes, so no preference was changed',
    );
  });

  it('should answer a file nobody has written as empty, and a good file as its document', async () => {
    // Arrange
    const fresh = documentStore(stateReading({ ok: true, value: undefined }), FILE, Document, EMPTY, linksDamage);
    const good = documentStore(stateReading({ ok: true, value: { items: ['a'] } }), FILE, Document, EMPTY, linksDamage);

    // Act / Assert
    expect(await fresh.read()).toEqual(EMPTY);
    expect(await good.read()).toEqual({ items: ['a'] });
  });
});

describe('a damaged store on the composed daemon half', () => {
  it('should answer a damaged links file 500 links_store_damaged with the restore remedy', async () => {
    // Arrange
    const fx = await catalogsFixture();
    fx.host.state('catalogs').files.set('links.json', 'not json {');

    // Act
    const listed = await fx.host.request('GET', '/v1/catalog-links');

    // Assert
    expect(listed.status).toBe(500);
    expect(listed.json<{ code: string }>().code).toBe('links_store_damaged');
    expect(listed.body).toContain('Restore the file from a backup, or move it aside to start with no links.');
  });

  it('should answer a damaged installs file 500 catalog_installs_unreadable, never "no installs"', async () => {
    // Arrange
    const fx = await catalogsFixture();
    fx.host.state('catalogs').files.set('installs.json', 'not json {');

    // Act
    const listed = await fx.host.request('GET', '/v1/catalog-installs');

    // Assert
    expect(listed.status).toBe(500);
    expect(listed.json<{ code: string }>().code).toBe('catalog_installs_unreadable');
    expect(listed.body).toContain('installs.json is not JSON, so no install was changed');
  });

  it('should answer a damaged catalogs file 500 store_damaged, never an empty list', async () => {
    // Arrange
    const fx = await catalogsFixture();
    fx.host.state('catalogs').files.set('catalogs.json', JSON.stringify({ format: 1, nonsense: true }));

    // Act
    const listed = await fx.host.request('GET', '/v1/catalogs');

    // Assert
    expect(listed.status).toBe(500);
    expect(listed.json<{ code: string }>().code).toBe('store_damaged');
    expect(listed.body).toContain('Restore the file from a backup, or move it aside to start with no catalogs.');
  });
});
