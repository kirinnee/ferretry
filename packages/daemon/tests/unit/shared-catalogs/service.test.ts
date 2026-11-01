import { describe, it } from 'bun:test';
import { verifySharedCatalogFile } from '@ferretry/relay';
import should from 'should';
import { CatalogRefusal } from '../../../src/lib/shared-catalogs/refusal.ts';
import { crypto, rig, SKILL_MD, SKILL_PATH, stdio } from './support.ts';

const refusal = async (work: () => Promise<unknown>): Promise<CatalogRefusal> => {
  try {
    await work();
  } catch (error) {
    if (error instanceof CatalogRefusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

const ASKING = { sourceState: true };

async function withSkill() {
  const r = await rig();
  const catalog = await r.service.create({ name: 'Team tools' });
  const preview = await r.service.previewItem(catalog.id, { source: { kind: 'skill', skill: 'demo' } });
  const added = await r.service.addItem(catalog.id, {
    source: { kind: 'skill', skill: 'demo' },
    digest: preview.digest,
  });
  return { r, catalog, preview, added };
}

describe('SharedCatalogService', () => {
  it('should create a catalog at revision 1 and refuse public', async () => {
    const r = await rig();
    const catalog = await r.service.create({ name: 'Team', description: 'for us' });
    should(catalog.revision).equal(1);
    should(catalog.visibility).equal('members');
    should(catalog.id).match(/^cat_[A-Za-z0-9_-]{22}$/u);
    should((await refusal(async () => await r.service.create({ name: 'Other', visibility: 'public' }))).refusal).equal(
      'public_unavailable',
    );
    should((await refusal(async () => await r.service.update(catalog.id, { visibility: 'public' }))).refusal).equal(
      'public_unavailable',
    );
    should((await refusal(async () => await r.service.create({ name: 'Team' }))).refusal).equal('name_taken');
  });

  it('should raise the revision by exactly one on each visible change and never otherwise', async () => {
    const { r, catalog, added } = await withSkill();
    const itemId = added.itemId;
    should(added.revision).equal(2);
    r.clock.ms += 1000;
    const renamed = await r.service.update(catalog.id, { name: 'Renamed' });
    should(renamed.revision).equal(3);
    const same = await r.service.update(catalog.id, { name: 'Renamed' });
    should(same.revision).equal(3);
    should(r.documents.writes).equal(3);
    const described = await r.service.update(catalog.id, { description: 'now described' });
    should(described.revision).equal(4);
    r.tree.set(SKILL_PATH, { 'SKILL.md': SKILL_MD, 'notes.txt': 'new notes' });
    const preview = await r.service.previewItem(catalog.id, { itemId });
    const published = await r.service.publishVersion(catalog.id, itemId, { digest: preview.digest });
    should(published.revision).equal(5);
    should(published.itemVersion).equal(2);
    const withdrawn = await r.service.withdraw(catalog.id, itemId);
    should(withdrawn.revision).equal(6);
  });

  it('should export byte-identical files when nothing changed, and a file that verifies', async () => {
    const { r, catalog } = await withSkill();
    r.clock.ms += 60_000;
    const first = await r.service.exportCatalog(catalog.id, {});
    r.clock.ms += 60_000;
    const second = await r.service.exportCatalog(catalog.id, {});
    should(JSON.stringify(second)).equal(JSON.stringify(first));
    should((await verifySharedCatalogFile(crypto, first)).ok).be.true();
    should(first.items).have.length(1);
    should(first.signedManifest.manifest.publisherName).equal('studio');
  });

  it('should export only the chosen items, and refuse a withdrawn one', async () => {
    const { r, catalog, added } = await withSkill();
    const server = await r.service.previewItem(catalog.id, { source: { kind: 'mcp', mcp: 'files' } });
    const mcp = await r.service.addItem(catalog.id, { source: { kind: 'mcp', mcp: 'files' }, digest: server.digest });
    const only = await r.service.exportCatalog(catalog.id, { itemIds: [mcp.itemId] });
    should(only.items.map(item => item.itemId)).deepEqual([mcp.itemId]);
    should(only.signedManifest.manifest.items).have.length(2);
    await r.service.withdraw(catalog.id, added.itemId);
    should(
      (await refusal(async () => await r.service.exportCatalog(catalog.id, { itemIds: [added.itemId] }))).refusal,
    ).equal('item_withdrawn');
    should((await refusal(async () => await r.service.exportCatalog('cat_unknown00000000000000', {}))).refusal).equal(
      'catalog_unknown',
    );
  });

  it('should bind an add to the previewed digest', async () => {
    const r = await rig();
    const catalog = await r.service.create({ name: 'Team' });
    const preview = await r.service.previewItem(catalog.id, { source: { kind: 'skill', skill: 'demo' } });
    r.tree.set(SKILL_PATH, { 'SKILL.md': SKILL_MD, 'extra.txt': 'changed under you' });
    const error = await refusal(
      async () =>
        await r.service.addItem(catalog.id, { source: { kind: 'skill', skill: 'demo' }, digest: preview.digest }),
    );
    should(error.refusal).equal('changed_since_preview');
    should(error.message).match(/changed since you previewed it/u);
    should(r.documents.document.catalogs[0]?.entries).have.length(0);
  });

  it('should bind a new version to its preview and refuse one with nothing new', async () => {
    const { r, catalog, added, preview } = await withSkill();
    should(
      (await refusal(async () => await r.service.publishVersion(catalog.id, added.itemId, { digest: preview.digest })))
        .refusal,
    ).equal('nothing_to_publish');
    const again = await r.service.previewItem(catalog.id, { itemId: added.itemId });
    should(again.sameAsVersion).equal(1);
    r.tree.set(SKILL_PATH, { 'SKILL.md': SKILL_MD, 'a.txt': 'a' });
    should(
      (await refusal(async () => await r.service.publishVersion(catalog.id, added.itemId, { digest: preview.digest })))
        .refusal,
    ).equal('changed_since_preview');
  });

  it('should keep a hand-written summary on a new version', async () => {
    const r = await rig();
    const catalog = await r.service.create({ name: 'Team' });
    const source = { kind: 'skill', skill: 'demo' } as const;
    const preview = await r.service.previewItem(catalog.id, { source, summary: 'mine' });
    const added = await r.service.addItem(catalog.id, { source, digest: preview.digest, summary: 'mine' });
    r.tree.set(SKILL_PATH, { 'SKILL.md': SKILL_MD, 'a.txt': 'a' });
    const next = await r.service.previewItem(catalog.id, { itemId: added.itemId });
    should(next.summary).equal('mine');
    const published = await r.service.publishVersion(catalog.id, added.itemId, { digest: next.digest });
    should(published.item.summary).equal('mine');
  });

  it('should list a source-changed flag per item and say when the source went away', async () => {
    const { r, catalog } = await withSkill();
    should((await r.service.list()).catalogs[0]?.items[0]).not.have.property('sourceState');
    should((await r.service.list(ASKING)).catalogs[0]?.items[0]?.sourceState).equal('unchanged');
    r.tree.set(SKILL_PATH, { 'SKILL.md': SKILL_MD, 'a.txt': 'a' });
    should((await r.service.list(ASKING)).catalogs[0]?.items[0]?.sourceState).equal('changed');
    r.skills = [];
    const gone = (await r.service.list(ASKING)).catalogs[0]?.items[0];
    should(gone?.sourceState).equal('unavailable');
    should(gone?.sourceNote).match(/not a skill this machine lists/u);
    await r.service.withdraw(catalog.id, gone?.itemId ?? '');
    should((await r.service.list(ASKING)).catalogs[0]?.items[0]?.sourceState).equal('withdrawn');
  });

  it('should refuse a withdrawn item a new version, and a second withdrawal', async () => {
    const { r, catalog, added } = await withSkill();
    await r.service.withdraw(catalog.id, added.itemId);
    should(
      (await refusal(async () => await r.service.previewItem(catalog.id, { itemId: added.itemId }))).refusal,
    ).equal('item_withdrawn');
    should((await refusal(async () => await r.service.withdraw(catalog.id, added.itemId))).refusal).equal(
      'item_withdrawn',
    );
    should(
      (await refusal(async () => await r.service.withdraw(catalog.id, 'itm_unknown000000000000000'))).refusal,
    ).equal('item_unknown');
  });

  it('should resolve a skill by its SKILL.md path, by name, and refuse unknown or ambiguous ones', async () => {
    const r = await rig();
    const catalog = await r.service.create({ name: 'Team' });
    const byPath = await r.service.previewItem(catalog.id, { source: { kind: 'skill', skill: SKILL_PATH } });
    should(byPath.name).equal('demo');
    should(
      (await refusal(async () => await r.service.previewItem(catalog.id, { source: { kind: 'skill', skill: 'nope' } })))
        .refusal,
    ).equal('source_unknown');
    const other = '/home/me/.codex/skills/demo/SKILL.md';
    r.tree.set(other, { 'SKILL.md': SKILL_MD });
    r.skills = [...r.skills, { path: other, name: 'demo' }];
    should(
      (await refusal(async () => await r.service.previewItem(catalog.id, { source: { kind: 'skill', skill: 'demo' } })))
        .refusal,
    ).equal('source_ambiguous');
  });

  it('should refuse an unreadable folder, a bad folder name and a skill with no description', async () => {
    const r = await rig();
    const catalog = await r.service.create({ name: 'Team' });
    const missing = '/home/me/.claude/skills/gone/SKILL.md';
    r.skills = [{ path: missing, name: 'gone' }];
    should(
      (await refusal(async () => await r.service.previewItem(catalog.id, { source: { kind: 'skill', skill: 'gone' } })))
        .refusal,
    ).equal('source_refused');
    const spaced = '/home/me/.claude/skills/my skill/SKILL.md';
    r.skills = [{ path: spaced, name: 'x' }];
    should(
      (await refusal(async () => await r.service.previewItem(catalog.id, { source: { kind: 'skill', skill: spaced } })))
        .message,
    ).match(/not a name a catalog item can have/u);
    const bare = '/home/me/.claude/skills/bare/SKILL.md';
    r.tree.set(bare, { 'SKILL.md': 'no front matter' });
    r.skills = [{ path: bare, name: 'bare' }];
    const error = await refusal(
      async () => await r.service.previewItem(catalog.id, { source: { kind: 'skill', skill: 'bare' } }),
    );
    should(error.message).match(/Give a summary of your own/u);
    const given = await r.service.previewItem(catalog.id, {
      source: { kind: 'skill', skill: 'bare' },
      summary: 'mine',
    });
    should(given.summary).equal('mine');
  });

  it('should add an MCP setup with the default summary, and refuse the unsafe ones with the fix', async () => {
    const r = await rig();
    r.servers = [
      stdio('files'),
      stdio('leaky', { TOKEN: '${TOKEN}' }),
      stdio('keyed', { API: 'sk-live-0123456789abcdef0123456789abcdef' }),
      { ...stdio('ferretry'), scope: 'ferretry', id: 'own' },
      stdio('twin'),
      { ...stdio('twin'), id: 'second-twin', scope: 'project' },
    ];
    const catalog = await r.service.create({ name: 'Team' });
    const ok = await r.service.previewItem(catalog.id, { source: { kind: 'mcp', mcp: 'files' } });
    should(ok.summary).equal('MCP server files');
    should(
      (await refusal(async () => await r.service.previewItem(catalog.id, { source: { kind: 'mcp', mcp: 'leaky' } })))
        .message,
    ).match(/secret store/u);
    should(
      (await refusal(async () => await r.service.previewItem(catalog.id, { source: { kind: 'mcp', mcp: 'keyed' } })))
        .refusal,
    ).equal('source_refused');
    should(
      (await refusal(async () => await r.service.previewItem(catalog.id, { source: { kind: 'mcp', mcp: 'own' } })))
        .message,
    ).match(/not shareable/u);
    should(
      (await refusal(async () => await r.service.previewItem(catalog.id, { source: { kind: 'mcp', mcp: 'twin' } })))
        .refusal,
    ).equal('source_ambiguous');
    should(
      (await refusal(async () => await r.service.previewItem(catalog.id, { source: { kind: 'mcp', mcp: 'missing' } })))
        .refusal,
    ).equal('source_unknown');
    r.servers = [];
    const added = await refusal(
      async () => await r.service.previewItem(catalog.id, { source: { kind: 'mcp', mcp: 'files' } }),
    );
    should(added.refusal).equal('source_unknown');
  });

  it('should refuse a source that is now called something else', async () => {
    const r = await rig();
    const catalog = await r.service.create({ name: 'Team' });
    const preview = await r.service.previewItem(catalog.id, { source: { kind: 'mcp', mcp: 'files' } });
    const added = await r.service.addItem(catalog.id, {
      source: { kind: 'mcp', mcp: 'files' },
      digest: preview.digest,
    });
    r.servers = [{ ...stdio('renamed'), id: 'id-files' }];
    should(
      (await refusal(async () => await r.service.previewItem(catalog.id, { itemId: added.itemId }))).message,
    ).match(/now called renamed/u);
  });

  it('should keep the publisher name it was created with, and sign it', async () => {
    const { r, catalog } = await withSkill();
    should(catalog.publisherName).equal('studio');
    r.publisher.name = 'another-host';
    should((await r.service.exportCatalog(catalog.id, {})).signedManifest.manifest.publisherName).equal('studio');
    const before = (await r.service.list()).catalogs[0]?.revision;
    const renamed = await r.service.update(catalog.id, { publisherName: 'Studio laptop' });
    should(renamed.publisherName).equal('Studio laptop');
    should(renamed.revision).equal((before ?? 0) + 1);
    should((await r.service.exportCatalog(catalog.id, {})).signedManifest.manifest.publisherName).equal(
      'Studio laptop',
    );
    should((await r.service.update(catalog.id, { publisherName: 'Studio laptop' })).revision).equal(renamed.revision);
  });

  it('should say where each source was read from, in the preview', async () => {
    const r = await rig();
    const catalog = await r.service.create({ name: 'Team' });
    const skill = await r.service.previewItem(catalog.id, { source: { kind: 'skill', skill: 'demo' } });
    should(skill.location).equal(SKILL_PATH);
    const server = await r.service.previewItem(catalog.id, { source: { kind: 'mcp', mcp: 'files' } });
    should(server.location).equal('files (user, /home/me/.claude.json)');
  });

  it('should refuse an export larger than a reader will open, and say to export fewer items', async () => {
    const r = await rig({ exportMaxBytes: 300 });
    const catalog = await r.service.create({ name: 'Team' });
    const preview = await r.service.previewItem(catalog.id, { source: { kind: 'skill', skill: 'demo' } });
    await r.service.addItem(catalog.id, { source: { kind: 'skill', skill: 'demo' }, digest: preview.digest });
    const refused = await refusal(async () => await r.service.exportCatalog(catalog.id, {}));
    should(refused.refusal).equal('export_too_big');
    should(refused.message).match(/Export fewer items/u);
  });

  it('should refuse a file it cannot make, and one that does not verify', async () => {
    const { r, catalog } = await withSkill();
    const stored = r.documents.document;
    const item = stored.items[0];
    if (item === undefined) throw new Error('fixture');
    r.documents.document = { ...stored, items: [{ ...item, harness: 'claude' as const }] };
    const made = await refusal(async () => await r.service.exportCatalog(catalog.id, {}));
    should(made.refusal).equal('export_failed');
    should(made.message).match(/could not be made/u);

    const sound = await rig({
      crypto: Object.assign(Object.create(crypto) as typeof crypto, { verifyEd25519: async () => false }),
    });
    const other = await sound.service.create({ name: 'Team' });
    const preview = await sound.service.previewItem(other.id, { source: { kind: 'skill', skill: 'demo' } });
    await sound.service.addItem(other.id, { source: { kind: 'skill', skill: 'demo' }, digest: preview.digest });
    const unverified = await refusal(async () => await sound.service.exportCatalog(other.id, {}));
    should(unverified.refusal).equal('export_failed');
    should(unverified.message).match(/did not verify/u);
  });

  it('should say an MCP setup went away on a new version, and let a real failure through a list', async () => {
    const r = await rig();
    const catalog = await r.service.create({ name: 'Team' });
    const preview = await r.service.previewItem(catalog.id, { source: { kind: 'mcp', mcp: 'files' } });
    const added = await r.service.addItem(catalog.id, {
      source: { kind: 'mcp', mcp: 'files' },
      digest: preview.digest,
    });
    r.servers = [];
    should(
      (await refusal(async () => await r.service.previewItem(catalog.id, { itemId: added.itemId }))).refusal,
    ).equal('source_unknown');
    const gone = (await r.service.list(ASKING)).catalogs[0]?.items[0];
    should(gone?.sourceState).equal('unavailable');
    r.skills = [];
    const { r: other } = await withSkill();
    other.tree.list = async () => {
      throw new Error('the disk went away');
    };
    let thrown: unknown;
    try {
      await other.service.list(ASKING);
    } catch (error) {
      thrown = error;
    }
    should(String(thrown)).match(/the disk went away/u);
  });

  it('should refuse to sign without an identity', async () => {
    const r = await rig();
    r.identity = undefined;
    should((await refusal(async () => await r.service.list())).refusal).equal('signing_unavailable');
  });

  it('should find a damaged or missing frozen copy at export', async () => {
    const { r, catalog } = await withSkill();
    const [digest] = [...r.blobs.blobs.keys()];
    const text = r.blobs.blobs.get(digest as string) as string;
    r.blobs.blobs.set(digest as string, text.replace('notes', 'NOTES'));
    should((await refusal(async () => await r.service.exportCatalog(catalog.id, {}))).message).match(
      /no longer matches its digest/u,
    );
    r.blobs.blobs.set(digest as string, text.replace('"content":"notes"', '"content":"\\ud800"'));
    should((await refusal(async () => await r.service.exportCatalog(catalog.id, {}))).message).match(
      /no longer matches its digest/u,
    );
    r.blobs.blobs.set(digest as string, 'not json');
    should((await refusal(async () => await r.service.exportCatalog(catalog.id, {}))).message).match(/is not JSON/u);
    r.blobs.blobs.set(digest as string, '{"a":1}');
    should((await refusal(async () => await r.service.exportCatalog(catalog.id, {}))).message).match(
      /not a catalog item/u,
    );
    r.blobs.blobs.delete(digest as string);
    should((await refusal(async () => await r.service.exportCatalog(catalog.id, {}))).message).match(/is missing/u);
  });

  it('should refuse a name an item of the same kind already has, and delete a catalog', async () => {
    const { r, catalog, preview } = await withSkill();
    should(
      (
        await refusal(
          async () =>
            await r.service.addItem(catalog.id, { source: { kind: 'skill', skill: 'demo' }, digest: preview.digest }),
        )
      ).refusal,
    ).equal('name_taken');
    should(await r.service.remove(catalog.id)).deepEqual({ catalogId: catalog.id });
    should((await refusal(async () => await r.service.remove(catalog.id))).refusal).equal('catalog_unknown');
  });

  it('should hand a member the signed manifest as an export makes it', async () => {
    const { r, catalog } = await withSkill();
    const exported = await r.service.exportCatalog(catalog.id, {});
    const signed = await r.service.signedManifest(catalog.id);
    should(JSON.stringify(signed)).equal(JSON.stringify(exported.signedManifest));
    should((await refusal(async () => await r.service.signedManifest('cat_unknown00000000000000'))).refusal).equal(
      'catalog_unknown',
    );
  });

  it('should hand a member one frozen version, and refuse a withdrawn, missing or unknown one', async () => {
    const { r, catalog, added } = await withSkill();
    const item = await r.service.frozenItem(catalog.id, added.itemId, 1);
    should(item.itemId).equal(added.itemId);
    should((await refusal(async () => await r.service.frozenItem(catalog.id, added.itemId, 2))).refusal).equal(
      'item_unknown',
    );
    should((await refusal(async () => await r.service.frozenItem('cat_unknown00000000000000', 'x', 1))).refusal).equal(
      'catalog_unknown',
    );
    await r.service.withdraw(catalog.id, added.itemId);
    should((await refusal(async () => await r.service.frozenItem(catalog.id, added.itemId, 1))).refusal).equal(
      'item_withdrawn',
    );
  });
});
