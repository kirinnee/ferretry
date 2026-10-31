import { describe, it } from 'bun:test';
import should from 'should';
import type { CatalogMembership } from '../../../src/lib/shared-catalogs/service.ts';
import { rig } from './support.ts';

/** Deleting a catalog tells the people it was shared with, before the catalog's own file changes. */

class RecordingMembership implements CatalogMembership {
  readonly forgotten: string[] = [];
  readonly order: string[] = [];
  failure: Error | undefined;

  async forgetCatalog(catalogId: string): Promise<void> {
    this.order.push('forget');
    if (this.failure !== undefined) throw this.failure;
    this.forgotten.push(catalogId);
  }
}

describe('SharedCatalogService.remove and the people a catalog is shared with', () => {
  it('deletes a catalog on a machine that shares with nobody, with no membership wired', async () => {
    const r = await rig();
    const catalog = await r.service.create({ name: 'Team' });

    should(await r.service.remove(catalog.id)).deepEqual({ catalogId: catalog.id });

    should(r.documents.document.catalogs).have.length(0);
  });

  it('tells the membership which catalog is going, once', async () => {
    const membership = new RecordingMembership();
    const r = await rig({ membership });
    const catalog = await r.service.create({ name: 'Team' });
    const other = await r.service.create({ name: 'Other' });

    const deleted = await r.service.remove(catalog.id);

    should(deleted).deepEqual({ catalogId: catalog.id });
    should(membership.forgotten).deepEqual([catalog.id]);
    should(r.documents.document.catalogs.map(entry => entry.id)).deepEqual([other.id]);
  });

  it('tells the membership BEFORE the catalog’s own file is written', async () => {
    const membership = new RecordingMembership();
    const r = await rig({ membership });
    const catalog = await r.service.create({ name: 'Team' });
    const originalWrite = r.documents.write.bind(r.documents);
    r.documents.write = async document => {
      membership.order.push('write');
      await originalWrite(document);
    };

    await r.service.remove(catalog.id);

    should(membership.order).deepEqual(['forget', 'write']);
  });

  it('leaves the catalog in place when the membership cannot forget it, and says why', async () => {
    const membership = new RecordingMembership();
    const r = await rig({ membership });
    const catalog = await r.service.create({ name: 'Team' });
    const writes = r.documents.writes;
    membership.failure = new Error('members.json is read-only');

    const thrown = await r.service.remove(catalog.id).then(
      () => undefined,
      (error: unknown) => error,
    );

    should((thrown as Error).message).equal('members.json is read-only');
    should(r.documents.writes).equal(writes);
    should(r.documents.document.catalogs.map(entry => entry.id)).deepEqual([catalog.id]);
  });

  it('deletes it on a retry once the membership can forget it', async () => {
    const membership = new RecordingMembership();
    const r = await rig({ membership });
    const catalog = await r.service.create({ name: 'Team' });
    membership.failure = new Error('read-only');
    await r.service.remove(catalog.id).catch(() => undefined);
    membership.failure = undefined;

    await r.service.remove(catalog.id);

    should(membership.forgotten).deepEqual([catalog.id]);
    should(r.documents.document.catalogs).have.length(0);
  });

  it('does not tell the membership about a catalog that does not exist', async () => {
    const membership = new RecordingMembership();
    const r = await rig({ membership });

    const thrown = await r.service.remove(`cat_${'z'.repeat(22)}`).then(
      () => undefined,
      (error: unknown) => error,
    );

    should(thrown).have.property('refusal', 'catalog_unknown');
    should(membership.order).deepEqual([]);
  });
});
