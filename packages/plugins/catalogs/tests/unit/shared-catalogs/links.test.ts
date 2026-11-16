import { describe, it } from 'bun:test';
import should from 'should';
import type { LinkServing } from '../../../daemon/lib/shared-catalogs/ports.ts';
import { CatalogRefusal } from '../../../daemon/lib/shared-catalogs/refusal.ts';
import { rig, SKILL_MD, SKILL_PATH } from './support.ts';

const SOURCE = { kind: 'skill', skill: 'demo' } as const;
const LINK_A = `lnk_${'a'.repeat(22)}`;
const LINK_B = `lnk_${'b'.repeat(22)}`;

const refusal = async (work: () => Promise<unknown>): Promise<CatalogRefusal> => {
  try {
    await work();
  } catch (error) {
    if (error instanceof CatalogRefusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

/** One kept skill at versions 1 and 2, 2 current, and links serving whatever the test says. */
async function twoVersions(serving?: () => LinkServing[]) {
  const r = await rig(serving === undefined ? {} : { linkUsage: { serving: async () => serving() } });
  const catalog = await r.service.create({ name: 'First' });
  const preview = await r.service.previewItem(catalog.id, { source: SOURCE });
  const added = await r.service.addItem(catalog.id, { source: SOURCE, digest: preview.digest });
  r.tree.set(SKILL_PATH, { 'SKILL.md': SKILL_MD, 'notes.txt': 'two' });
  const next = await r.service.previewItemVersion(added.itemId);
  await r.service.publishItemVersion(added.itemId, { digest: next.digest });
  return { r, itemId: added.itemId };
}

describe('SharedCatalogService and the links that serve a version', () => {
  it('should list the links on each version, for an item a link serves', async () => {
    let itemId = '';
    const served: LinkServing[] = [];
    const { r, itemId: id } = await twoVersions(() => served);
    itemId = id;
    served.push(
      { linkId: LINK_A, itemId, version: 1 },
      { linkId: LINK_B, itemId, version: 1 },
      { linkId: LINK_A, itemId: `itm_${'z'.repeat(22)}`, version: 2 },
    );
    const item = await r.service.getItem(itemId, { sourceState: false });
    should(item.versions.map(version => version.usedBy.linkIds)).deepEqual([[LINK_A, LINK_B], []]);
  });

  it('should leave the links out of a build that has none', async () => {
    const { r, itemId } = await twoVersions();
    const item = await r.service.getItem(itemId, { sourceState: false });
    for (const version of item.versions) should(version.usedBy.linkIds).equal(undefined);
  });

  it('should refuse to retire a version one link serves, and say so in the singular', async () => {
    const served: LinkServing[] = [];
    const { r, itemId } = await twoVersions(() => served);
    served.push({ linkId: LINK_A, itemId, version: 1 });
    const out = await refusal(() => r.service.setRetired(itemId, 1, true));
    should(out.refusal).equal('version_linked');
    should(out.message).equal('demo version 1 is served by 1 link. Move or turn it off first.');
  });

  it('should say how many links serve it when there are several', async () => {
    const served: LinkServing[] = [];
    const { r, itemId } = await twoVersions(() => served);
    served.push({ linkId: LINK_A, itemId, version: 1 }, { linkId: LINK_B, itemId, version: 1 });
    const out = await refusal(() => r.service.setRetired(itemId, 1, true));
    should(out.message).equal('demo version 1 is served by 2 links. Move or turn them off first.');
  });

  it('should retire a version no link serves, and bring a linked one back without asking', async () => {
    const served: LinkServing[] = [];
    const { r, itemId } = await twoVersions(() => served);
    served.push({ linkId: LINK_A, itemId, version: 2 });
    should((await r.service.setRetired(itemId, 1, true)).changed).equal(true);
    should((await r.service.setRetired(itemId, 1, false)).changed).equal(true);
  });
});
