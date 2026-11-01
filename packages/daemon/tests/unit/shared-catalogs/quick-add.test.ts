import { describe, it } from 'bun:test';
import {
  CATALOG_MAX_ITEMS,
  CatalogLabelSchema,
  QUICK_ADD_UNDO_SECONDS,
  type QuickAddAnswer,
  SHARED_ITEMS_MAX,
} from '@ferretry/protocol';
import should from 'should';
import { CatalogRefusal } from '../../../src/lib/shared-catalogs/refusal.ts';
import { defaultCatalogNames, publisherLabel } from '../../../src/lib/shared-catalogs/service.ts';
import { type Rig, rig, SKILL_MD, SKILL_PATH } from './support.ts';

const SKILL = { kind: 'skill', skill: 'demo' } as const;
const ME = 'host';

const added = (answer: QuickAddAnswer) => {
  if (answer.outcome !== 'added') throw new Error(`expected added, got ${answer.outcome}`);
  return answer;
};

const refusal = async (work: () => Promise<unknown>): Promise<string> => {
  try {
    await work();
  } catch (error) {
    if (error instanceof CatalogRefusal) return error.refusal;
    throw error;
  }
  throw new Error('expected a refusal');
};

const stored = (r: Rig) => r.documents.document;

describe('one-tap Add of a clean source', () => {
  it('should make the default catalog, freeze the item once and list it for every version', async () => {
    const r = await rig();

    const answer = added(await r.service.quickAdd(ME, { source: SKILL }));

    should(answer.catalog).containEql({ name: "studio's skills", revision: 2, created: true });
    should(answer.newItem).be.true();
    should(answer.sourceChanged).be.false();
    should(answer.itemVersion).equal(1);
    const document = stored(r);
    should(document.defaultCatalogId).equal(answer.catalog.catalogId);
    should(document.catalogs).have.length(1);
    should(document.items).have.length(1);
    const version = document.items[0]?.versions[0];
    should(version?.bindings[answer.catalog.catalogId]?.digest).equal(answer.digest);
    should(answer.undo.token).match(/^cqu_/u);
    should(answer.undo.expiresAt).equal(new Date(r.clock.ms + QUICK_ADD_UNDO_SECONDS * 1_000).toISOString());
  });

  it('should send an MCP setup that runs a command to review, since it carries a warning', async () => {
    const r = await rig();
    const answer = await r.service.quickAdd(ME, { source: { kind: 'mcp', mcp: 'files' } });
    should(answer.outcome).equal('review');
    should(stored(r).items).eql([]);
  });

  it('should list a second source in the same default catalog', async () => {
    const r = await rig();
    await r.service.quickAdd(ME, { source: SKILL });
    const before = r.documents.writes;
    r.skills.push({ path: '/home/me/.claude/skills/two/SKILL.md', name: 'two' });
    r.tree.set('/home/me/.claude/skills/two/SKILL.md', {
      'SKILL.md': '---\nname: two\ndescription: Another one\n---\nBody\n',
    });
    const second = added(await r.service.quickAdd(ME, { source: { kind: 'skill', skill: 'two' } }));
    should(second.catalog.created).be.false();
    should(second.catalog.revision).equal(3);
    should(r.documents.writes).equal(before + 1);
  });
});

describe('one-tap Add falls back to review and writes nothing', () => {
  const unchanged = async (r: Rig, work: () => Promise<QuickAddAnswer>) => {
    const writes = r.documents.writes;
    const blobs = r.blobs.blobs.size;
    const answer = await work();
    should(r.documents.writes).equal(writes);
    should(r.blobs.blobs.size).equal(blobs);
    return answer;
  };

  it('should review a skill that carries a script', async () => {
    const r = await rig();
    r.tree.set(SKILL_PATH, {
      'SKILL.md': '---\nname: demo\ndescription: Does it\n---\nBody\n',
      'run.sh': '#!/bin/sh\n',
    });

    const answer = await unchanged(r, () => r.service.quickAdd(ME, { source: SKILL }));

    should(answer.outcome).equal('review');
    if (answer.outcome !== 'review') return;
    should(answer.reasons).eql(['warnings']);
    should(answer.preview?.warnings.length).be.above(0);
    should(answer.preview?.version).equal(1);
  });

  it('should review a skill with a file left out', async () => {
    const r = await rig();
    r.tree.set(SKILL_PATH, {
      'SKILL.md': '---\nname: demo\ndescription: Does it\n---\nBody\n',
      link: 'symlink',
    });
    const answer = await unchanged(r, () => r.service.quickAdd(ME, { source: SKILL }));
    should(answer.outcome).equal('review');
    if (answer.outcome !== 'review') return;
    should(answer.reasons).eql(['problems']);
    should(answer.preview?.problems.length).be.above(0);
  });

  it('should name both reasons when both hold', async () => {
    const r = await rig();
    r.tree.set(SKILL_PATH, {
      'SKILL.md': '---\nname: demo\ndescription: Does it\n---\nBody\n',
      'run.sh': '#!/bin/sh\n',
      link: 'symlink',
    });
    const answer = await unchanged(r, () => r.service.quickAdd(ME, { source: SKILL }));
    if (answer.outcome !== 'review') throw new Error('expected review');
    should(answer.reasons).eql(['warnings', 'problems']);
  });

  it('should review a skill with no summary and show no preview', async () => {
    const r = await rig();
    r.tree.set(SKILL_PATH, { 'SKILL.md': 'No front matter\n' });
    const answer = await unchanged(r, () => r.service.quickAdd(ME, { source: SKILL }));
    should(answer).eql({ outcome: 'review', reasons: ['needs-summary'] });
  });

  it('should review a kept item whose current version has warnings, and not list it', async () => {
    const r = await rig();
    const first = added(await r.service.quickAdd(ME, { source: SKILL }));
    await r.service.undoQuickAdd(ME, first.undo.token);
    const doc = stored(r);
    should(doc.items).have.length(0);
    const other = await r.service.create({ name: 'Other' });
    r.tree.set(SKILL_PATH, {
      'SKILL.md': '---\nname: demo\ndescription: Does it\n---\nBody\n',
      'run.sh': '#!/bin/sh\n',
    });
    const preview = await r.service.previewItem(other.id, { source: SKILL });
    await r.service.addItem(other.id, { source: SKILL, digest: preview.digest });
    const itemId = stored(r).items[0]?.itemId as string;
    const answer = await unchanged(r, () => r.service.quickAdd(ME, { itemId }));
    if (answer.outcome !== 'review') throw new Error('expected review');
    should(answer.reasons).eql(['warnings']);
    should(answer.preview?.itemId).equal(itemId);
  });
});

describe('one-tap Add of an item already kept', () => {
  it('should answer already on a double tap, by source or by id, and write nothing', async () => {
    const r = await rig();
    const first = added(await r.service.quickAdd(ME, { source: SKILL }));
    const writes = r.documents.writes;

    const bySource = await r.service.quickAdd(ME, { source: SKILL });
    const byId = await r.service.quickAdd(ME, { itemId: first.itemId });

    should(bySource).eql({
      outcome: 'already',
      catalogId: first.catalog.catalogId,
      itemId: first.itemId,
      itemVersion: 1,
    });
    should(byId).eql(bySource);
    should(r.documents.writes).equal(writes);
  });

  it('should list a kept item in the default catalog from its CURRENT version, and say the source changed', async () => {
    const r = await rig();
    const other = await r.service.create({ name: 'Other' });
    const preview = await r.service.previewItem(other.id, { source: SKILL });
    const made = await r.service.addItem(other.id, { source: SKILL, digest: preview.digest });
    r.tree.set(SKILL_PATH, { 'SKILL.md': '---\nname: demo\ndescription: Does the demo thing\n---\nNew body\n' });
    const next = await r.service.previewItem(other.id, { itemId: made.itemId });
    await r.service.publishVersion(other.id, made.itemId, { digest: next.digest });
    r.tree.set(SKILL_PATH, { 'SKILL.md': '---\nname: demo\ndescription: Does the demo thing\n---\nNewer body\n' });

    const answer = added(await r.service.quickAdd(ME, { itemId: made.itemId }));

    should(answer.newItem).be.false();
    should(answer.sourceChanged).be.true();
    should(answer.itemVersion).equal(2);
    const entry = stored(r).catalogs.find(catalog => catalog.id === answer.catalog.catalogId)?.entries[0];
    should(entry?.sinceVersion).equal(2);
    should(stored(r).items[0]?.versions).have.length(2);
  });

  it('should list a kept item that is unchanged without saying it changed', async () => {
    const r = await rig();
    const other = await r.service.create({ name: 'Other' });
    const preview = await r.service.previewItem(other.id, { source: SKILL });
    await r.service.addItem(other.id, { source: SKILL, digest: preview.digest });
    const answer = added(await r.service.quickAdd(ME, { source: SKILL }));
    should(answer.sourceChanged).be.false();
    should(answer.newItem).be.false();
  });

  it('should refuse an item id this machine does not keep', async () => {
    const r = await rig();
    should(await refusal(() => r.service.quickAdd(ME, { itemId: `itm_${'B'.repeat(22)}` }))).equal('item_unknown');
  });
});

describe('the default catalog quick add makes', () => {
  it('should be named after the label, cut to 80 characters with its suffix', () => {
    const label = 'x'.repeat(80);
    const names = defaultCatalogNames(label);
    should(names).have.length(9);
    should(names[0]).equal(`${'x'.repeat(71)}'s skills`);
    should(names[1]).equal(`${'x'.repeat(69)}'s skills 2`);
    for (const name of names) should(Array.from(name).length).be.belowOrEqual(80);
  });

  it('should number the name past ones that are taken and refuse after nine', async () => {
    const r = await rig();
    for (let taken = 0; taken < 9; taken += 1) {
      await r.service.create({ name: defaultCatalogNames('studio')[taken] as string });
      const doc = stored(r);
      if (taken < 8) {
        // another catalog is not the default, so quick add makes a new one
        const fresh = await rig();
        fresh.documents.document = doc;
        const answer = added(await fresh.service.quickAdd(ME, { source: SKILL }));
        should(answer.catalog.name).equal(defaultCatalogNames('studio')[taken + 1] as string);
      }
    }
    should(await refusal(() => r.service.quickAdd(ME, { source: SKILL }))).equal('name_taken');
  });

  it('should be the only target once it exists, even when another catalog is newer', async () => {
    const r = await rig();
    const first = added(await r.service.quickAdd(ME, { source: SKILL }));
    await r.service.create({ name: 'Newer' });
    r.skills.push({ path: '/home/me/.claude/skills/two/SKILL.md', name: 'two' });
    r.tree.set('/home/me/.claude/skills/two/SKILL.md', {
      'SKILL.md': '---\nname: two\ndescription: Another one\n---\nBody\n',
    });
    const second = added(await r.service.quickAdd(ME, { source: { kind: 'skill', skill: 'two' } }));
    should(second.catalog.catalogId).equal(first.catalog.catalogId);
  });

  it('should leave nothing written when it cannot be made', async () => {
    const r = await rig();
    for (let index = 0; index < 256; index += 1) await r.service.create({ name: `Catalog ${index}` });
    const writes = r.documents.writes;
    should(await refusal(() => r.service.quickAdd(ME, { source: SKILL }))).equal('catalogs_full');
    should(r.documents.writes).equal(writes);
  });

  it('should refuse, not review, a source that cannot be shared at all', async () => {
    const r = await rig();
    r.tree.set(SKILL_PATH, { 'notes.md': 'no entry file\n' });
    should(await refusal(() => r.service.quickAdd(ME, { source: SKILL }))).equal('source_refused');
  });

  it('should refuse a source that is ambiguous', async () => {
    const r = await rig();
    r.skills.push({ path: '/other/demo/SKILL.md', name: 'demo' });
    should(await refusal(() => r.service.quickAdd(ME, { source: SKILL }))).equal('source_ambiguous');
  });
});

describe('Undo', () => {
  it('should retract an add nobody was shown, with no trace, and drop the item it made', async () => {
    const r = await rig();
    const answer = added(await r.service.quickAdd(ME, { source: SKILL }));

    const undone = await r.service.undoQuickAdd(ME, answer.undo.token);

    should(undone).eql({
      catalogId: answer.catalog.catalogId,
      itemId: answer.itemId,
      mode: 'retracted',
      revision: 3,
      itemRemoved: true,
    });
    const catalog = stored(r).catalogs[0];
    should(catalog?.entries).eql([]);
    should(stored(r).items).eql([]);
    should(stored(r).defaultCatalogId).equal(answer.catalog.catalogId);
  });

  it('should leave another item alone when it retracts one', async () => {
    const r = await rig();
    const first = added(await r.service.quickAdd(ME, { source: SKILL }));
    r.skills.push({ path: '/home/me/.claude/skills/two/SKILL.md', name: 'two' });
    r.tree.set('/home/me/.claude/skills/two/SKILL.md', {
      'SKILL.md': '---\nname: two\ndescription: Another one\n---\nBody\n',
    });
    const second = added(await r.service.quickAdd(ME, { source: { kind: 'skill', skill: 'two' } }));
    const undone = await r.service.undoQuickAdd(ME, second.undo.token);
    should(undone.mode).equal('retracted');
    should(stored(r).items.map(item => item.itemId)).eql([first.itemId]);
  });

  it('should keep a kept item when it retracts an add of one', async () => {
    const r = await rig();
    const other = await r.service.create({ name: 'Other' });
    const preview = await r.service.previewItem(other.id, { source: SKILL });
    await r.service.addItem(other.id, { source: SKILL, digest: preview.digest });
    r.skills.push({ path: '/home/me/.claude/skills/two/SKILL.md', name: 'two' });
    r.tree.set('/home/me/.claude/skills/two/SKILL.md', {
      'SKILL.md': '---\nname: two\ndescription: Another one\n---\nBody\n',
    });
    await r.service.quickAdd(ME, { source: { kind: 'skill', skill: 'two' } });
    const answer = added(await r.service.quickAdd(ME, { source: SKILL }));

    const undone = await r.service.undoQuickAdd(ME, answer.undo.token);

    should(undone.mode).equal('retracted');
    should(undone.itemRemoved).be.false();
    should(stored(r).items).have.length(2);
    should(
      stored(r).items.find(item => item.itemId === answer.itemId)?.versions[0]?.bindings[answer.catalog.catalogId],
    ).be.undefined();
  });

  it('should withdraw once a member has read the manifest', async () => {
    const r = await rig();
    const answer = added(await r.service.quickAdd(ME, { source: SKILL }));
    await r.service.signedManifest(answer.catalog.catalogId);

    const undone = await r.service.undoQuickAdd(ME, answer.undo.token);

    should(undone.mode).equal('withdrawn');
    should(undone.itemRemoved).be.false();
    const catalog = stored(r).catalogs[0];
    should(catalog?.entries[0]?.withdrawnAt).be.a.String();
    should(stored(r).items).have.length(1);
  });

  it('should withdraw once the catalog was exported', async () => {
    const r = await rig();
    const answer = added(await r.service.quickAdd(ME, { source: SKILL }));
    await r.service.exportCatalog(answer.catalog.catalogId, {});
    should((await r.service.undoQuickAdd(ME, answer.undo.token)).mode).equal('withdrawn');
  });

  it('should withdraw when the catalog moved on after the add', async () => {
    const r = await rig();
    const answer = added(await r.service.quickAdd(ME, { source: SKILL }));
    await r.service.update(answer.catalog.catalogId, { name: 'Renamed' });
    r.skills.push({ path: '/home/me/.claude/skills/two/SKILL.md', name: 'two' });
    r.tree.set('/home/me/.claude/skills/two/SKILL.md', {
      'SKILL.md': '---\nname: two\ndescription: Another one\n---\nBody\n',
    });
    added(await r.service.quickAdd(ME, { source: { kind: 'skill', skill: 'two' } }));
    should((await r.service.undoQuickAdd(ME, answer.undo.token)).mode).equal('withdrawn');
  });

  it('should withdraw, never erase, an item that was relisted over a withdrawal', async () => {
    const r = await rig();
    const first = added(await r.service.quickAdd(ME, { source: SKILL }));
    await r.service.withdraw(first.catalog.catalogId, first.itemId);
    const again = added(await r.service.quickAdd(ME, { itemId: first.itemId }));
    const undone = await r.service.undoQuickAdd(ME, again.undo.token);
    should(undone.mode).equal('withdrawn');
    should(stored(r).catalogs[0]?.entries).have.length(1);
  });

  it('should be single use', async () => {
    const r = await rig();
    const answer = added(await r.service.quickAdd(ME, { source: SKILL }));
    await r.service.undoQuickAdd(ME, answer.undo.token);
    should(await refusal(() => r.service.undoQuickAdd(ME, answer.undo.token))).equal('undo_expired');
  });

  it('should be bound to the caller, and leave the token for its owner', async () => {
    const r = await rig();
    const answer = added(await r.service.quickAdd('device:one', { source: SKILL }));
    should(await refusal(() => r.service.undoQuickAdd('device:two', answer.undo.token))).equal('undo_expired');
    should((await r.service.undoQuickAdd('device:one', answer.undo.token)).mode).equal('retracted');
  });

  it('should run out after 60 seconds and write nothing', async () => {
    const r = await rig();
    const answer = added(await r.service.quickAdd(ME, { source: SKILL }));
    const writes = r.documents.writes;
    r.clock.ms += QUICK_ADD_UNDO_SECONDS * 1_000;
    should(await refusal(() => r.service.undoQuickAdd(ME, answer.undo.token))).equal('undo_expired');
    should(r.documents.writes).equal(writes);
  });

  it('should still hold a second before it runs out', async () => {
    const r = await rig();
    const answer = added(await r.service.quickAdd(ME, { source: SKILL }));
    r.clock.ms += QUICK_ADD_UNDO_SECONDS * 1_000 - 1;
    should((await r.service.undoQuickAdd(ME, answer.undo.token)).mode).equal('retracted');
  });

  it('should be forgotten by a restart', async () => {
    const r = await rig();
    const answer = added(await r.service.quickAdd(ME, { source: SKILL }));
    const restarted = await rig();
    restarted.documents.document = stored(r);
    should(await refusal(() => restarted.service.undoQuickAdd(ME, answer.undo.token))).equal('undo_expired');
    should(stored(restarted).catalogs[0]?.entries).have.length(1);
  });

  it('should refuse when the entry was withdrawn or the catalog deleted meanwhile', async () => {
    const r = await rig();
    const withdrawn = added(await r.service.quickAdd(ME, { source: SKILL }));
    await r.service.withdraw(withdrawn.catalog.catalogId, withdrawn.itemId);
    should(await refusal(() => r.service.undoQuickAdd(ME, withdrawn.undo.token))).equal('undo_expired');

    const q = await rig();
    const gone = added(await q.service.quickAdd(ME, { source: SKILL }));
    await q.service.remove(gone.catalog.catalogId);
    should(await refusal(() => q.service.undoQuickAdd(ME, gone.undo.token))).equal('undo_expired');
  });

  it('should serialise a manifest read and an Undo so neither sees half of the other', async () => {
    const r = await rig();
    const answer = added(await r.service.quickAdd(ME, { source: SKILL }));
    const [manifest, undone] = await Promise.all([
      r.service.signedManifest(answer.catalog.catalogId),
      r.service.undoQuickAdd(ME, answer.undo.token),
    ]);
    // The manifest ran first, so it listed the item, and Undo then had to withdraw.
    should(manifest.manifest.items).have.length(1);
    should(undone.mode).equal('withdrawn');
  });
});

const SECOND_SKILL = '/home/me/.claude/skills/two/SKILL.md';
const addSecondSkill = (r: Rig) => {
  r.skills.push({ path: SECOND_SKILL, name: 'two' });
  r.tree.set(SECOND_SKILL, { 'SKILL.md': '---\nname: two\ndescription: Another one\n---\nBody\n' });
};

describe('one-tap Add and the items a source already made', () => {
  it('should refuse, naming the ids, when two kept items are the same source', async () => {
    const r = await rig();
    const first = await r.service.create({ name: 'A' });
    const second = await r.service.create({ name: 'B' });
    for (const catalog of [first, second]) {
      const preview = await r.service.previewItem(catalog.id, { source: SKILL });
      await r.service.addItem(catalog.id, { source: SKILL, digest: preview.digest });
    }
    const [one, two] = stored(r).items;
    const writes = r.documents.writes;

    should(await refusal(() => r.service.quickAdd(ME, { source: SKILL }))).equal('source_ambiguous');
    try {
      await r.service.quickAdd(ME, { source: SKILL });
    } catch (error) {
      should((error as Error).message)
        .containEql(one?.itemId as string)
        .and.containEql(two?.itemId as string);
    }
    should(r.documents.writes).equal(writes);
  });

  it('should match an item by its CURRENT version, not its latest one', async () => {
    const r = await rig();
    const other = await r.service.create({ name: 'Other' });
    const preview = await r.service.previewItem(other.id, { source: SKILL });
    await r.service.addItem(other.id, { source: SKILL, digest: preview.digest });
    const document = stored(r);
    const item = document.items[0];
    const version = item?.versions[0];
    if (item === undefined || version === undefined) throw new Error('no item');
    r.documents.document = {
      ...document,
      items: [
        {
          ...item,
          versions: [
            version,
            { ...version, version: 2, source: { kind: 'skill', path: '/elsewhere/skills/z/SKILL.md' } },
          ],
        },
      ],
    };

    const answer = added(await r.service.quickAdd(ME, { source: SKILL }));

    should(answer.newItem).be.false();
    should(answer.itemId).equal(item.itemId);
  });

  it('should decide already and review before it makes or checks the default catalog', async () => {
    const r = await rig();
    for (const name of defaultCatalogNames('studio')) await r.service.create({ name });
    const other = await r.service.create({ name: 'Other' });
    const preview = await r.service.previewItem(other.id, { source: { kind: 'mcp', mcp: 'files' } });
    const made = await r.service.addItem(other.id, {
      source: { kind: 'mcp', mcp: 'files' },
      digest: preview.digest,
    });
    const writes = r.documents.writes;

    const answer = await r.service.quickAdd(ME, { itemId: made.itemId });
    const bySource = await r.service.quickAdd(ME, { source: { kind: 'mcp', mcp: 'files' } });

    should(answer.outcome).equal('review');
    should(bySource.outcome).equal('review');
    should(r.documents.writes).equal(writes);
    should(stored(r).defaultCatalogId).be.undefined();
  });
});

describe('one-tap Add reads its source once', () => {
  it('should freeze, check and store the very same read, whatever the source says next', async () => {
    const r = await rig();
    r.tree.set(SKILL_PATH, { 'SKILL.md': SKILL_MD });
    let lists = 0;
    const list = r.tree.list.bind(r.tree);
    r.tree.list = async (path: string) => {
      lists += 1;
      if (lists > 1)
        r.tree.set(SKILL_PATH, { 'SKILL.md': '---\nname: demo\ndescription: Mutated\n---\nMutated body\n' });
      return await list(path);
    };

    const answer = added(await r.service.quickAdd(ME, { source: SKILL }));

    should(lists).equal(1);
    const texts = [...r.blobs.blobs.values()];
    should(texts).have.length(1);
    should(texts[0]).containEql('Body').and.not.containEql('Mutated');
    const version = stored(r).items[0]?.versions[0];
    should(version?.bindings[answer.catalog.catalogId]?.digest).equal(answer.digest);
    should([...r.blobs.blobs.keys()]).eql([version?.contentDigest]);
  });
});

describe('the label of the default catalog', () => {
  it('should be cut to a label the contract accepts, counting UTF-16 units', () => {
    const label = `${'x'.repeat(70)}${String.fromCodePoint(0x1f600)}`;
    for (const name of defaultCatalogNames(label)) should(CatalogLabelSchema.safeParse(name).success).be.true();
  });

  it('should keep a publisher label the contract accepts, whatever its characters count as', () => {
    const label = publisherLabel(`${'x'.repeat(79)}${String.fromCodePoint(0x1f600)}`);
    should(CatalogLabelSchema.safeParse(label).success).be.true();
    should(label.startsWith('x')).be.true();
  });
});

describe('Undo after a write that fails', () => {
  it('should leave the token good when the write did not land', async () => {
    const r = await rig();
    const answer = added(await r.service.quickAdd(ME, { source: SKILL }));
    r.documents.failWrites = true;

    await r.service.undoQuickAdd(ME, answer.undo.token).then(
      () => {
        throw new Error('expected a failure');
      },
      () => undefined,
    );
    r.documents.failWrites = false;

    should((await r.service.undoQuickAdd(ME, answer.undo.token)).mode).equal('retracted');
  });

  it('should keep the item when another catalog lists it as well', async () => {
    const r = await rig();
    const answer = added(await r.service.quickAdd(ME, { source: SKILL }));
    const other = await r.service.create({ name: 'Other' });
    await r.service.addItem(other.id, { itemId: answer.itemId, version: 1 });

    const undone = await r.service.undoQuickAdd(ME, answer.undo.token);

    should(undone.itemRemoved).be.false();
    should(stored(r).items).have.length(1);
  });
});

describe('one-tap Add and the limits', () => {
  it('should refuse an item that would pass the cap on kept items', async () => {
    const r = await rig();
    added(await r.service.quickAdd(ME, { source: SKILL }));
    const document = stored(r);
    const item = document.items[0];
    if (item === undefined) throw new Error('no item');
    r.documents.document = {
      ...document,
      items: Array.from({ length: SHARED_ITEMS_MAX }, (_, index) => ({
        ...item,
        itemId: `itm_${String(index).padStart(22, '0')}`,
      })),
    };
    addSecondSkill(r);

    should(await refusal(() => r.service.quickAdd(ME, { source: { kind: 'skill', skill: 'two' } }))).equal(
      'items_full',
    );
  });

  it('should refuse when the default catalog is full', async () => {
    const r = await rig();
    added(await r.service.quickAdd(ME, { source: SKILL }));
    const document = stored(r);
    const item = document.items[0];
    const catalog = document.catalogs[0];
    if (item === undefined || catalog === undefined) throw new Error('no item');
    const filler = Array.from({ length: CATALOG_MAX_ITEMS - 1 }, (_, index) => ({
      ...item,
      itemId: `itm_${String(index).padStart(22, '0')}`,
    }));
    r.documents.document = {
      ...document,
      items: [item, ...filler],
      catalogs: [
        {
          ...catalog,
          entries: [
            ...catalog.entries,
            ...filler.map(each => ({ itemId: each.itemId, addedAt: catalog.createdAt, sinceVersion: 1 })),
          ],
        },
      ],
    };
    addSecondSkill(r);

    should(await refusal(() => r.service.quickAdd(ME, { source: { kind: 'skill', skill: 'two' } }))).equal(
      'catalog_full',
    );
  });
});

describe('one-tap Add on the write queue', () => {
  it('should add once and answer already to a second tap that raced it', async () => {
    const r = await rig();

    const [first, second] = await Promise.all([
      r.service.quickAdd('device:one', { source: SKILL }),
      r.service.quickAdd('device:two', { source: SKILL }),
    ]);

    should([first.outcome, second.outcome]).eql(['added', 'already']);
    should(stored(r).items).have.length(1);
  });

  it('should not interleave with a publish of another item', async () => {
    const r = await rig();
    addSecondSkill(r);
    const other = await r.service.create({ name: 'Other' });
    const preview = await r.service.previewItem(other.id, { source: { kind: 'skill', skill: 'two' } });

    const [quick, published] = await Promise.all([
      r.service.quickAdd(ME, { source: SKILL }),
      r.service.addItem(other.id, { source: { kind: 'skill', skill: 'two' }, digest: preview.digest }),
    ]);

    should(quick.outcome).equal('added');
    should(published.itemId).match(/^itm_/u);
    should(stored(r).items).have.length(2);
    should(
      stored(r)
        .catalogs.map(catalog => catalog.revision)
        .sort(),
    ).eql([2, 2]);
  });
});
