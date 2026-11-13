import { describe, it } from 'bun:test';
import { parseLinkFragment } from '../../../daemon/lib/boundary.ts';
import should from 'should';
import { SKILL_MD } from '../shared-catalogs/support.ts';
import { CatalogLinkRefusal } from '../../../daemon/lib/catalog-links/refusal.ts';
import { LINK_REFRESH_MS } from '../../../daemon/lib/catalog-links/service.ts';
import {
  APP_ORIGIN,
  keyOf,
  linkRig,
  mintOneTime,
  mintPublic,
  previewSkill,
  refused,
  RIG_DAEMON_ID,
  SKILL_PATH,
  SKILL_SOURCE,
  storedLink,
  STORE_ORIGIN,
  tooBigItems,
  UNREACHABLE,
} from './support.ts';

// biome-ignore lint/suspicious/noTemplateCurlyInString: a secret placeholder is the literal text `${secret:NAME}`
const PLACEHOLDER = '${secret:DOCS_KEY}';

const refusal = async (work: () => Promise<unknown>): Promise<CatalogLinkRefusal> => {
  try {
    await work();
  } catch (error) {
    if (error instanceof CatalogLinkRefusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('CatalogLinkService store status', () => {
  it('should say links are on, and remember the answer for a minute', async () => {
    const r = await linkRig();
    should(await r.service.storeStatus()).deepEqual({
      available: true,
      origin: STORE_ORIGIN,
      sentence: 'Download links are on.',
    });
    r.locator.site = { kind: 'unavailable', reason: 'off' };
    await r.service.storeStatus();
    should(r.locator.asked).equal(1);
    r.items.clock.ms += LINK_REFRESH_MS;
    should(await r.service.storeStatus()).deepEqual({ available: false, sentence: 'off' });
    should(r.locator.asked).equal(2);
  });
});

describe('CatalogLinkService preview', () => {
  it('should read a skill and freeze what a link would carry, writing nothing', async () => {
    const r = await linkRig();
    const preview = await previewSkill(r);
    should(preview.newItem).equal(true);
    should(preview.name).equal('demo');
    should(preview.itemKind).equal('skill');
    should(preview.tooBig).equal(false);
    should(preview.digest).match(/^sha256:/u);
    should(preview.envelopeBytes).be.above(0);
    should(preview).not.have.property('itemId');
    should(r.documents.writes).deepEqual([]);
    should(r.client.uploads).deepEqual([]);
  });

  it('should preview a kept version by its item id and version', async () => {
    const r = await linkRig();
    const created = await r.items.service.create({ name: 'Mine' });
    const first = await r.items.service.previewItem(created.id, { source: SKILL_SOURCE });
    const added = await r.items.service.addItem(created.id, { source: SKILL_SOURCE, digest: first.digest });
    const preview = await r.service.preview({ itemId: added.itemId, version: 1 });
    should(preview.newItem).equal(false);
    should(preview.itemId).equal(added.itemId);
    should(preview.version).equal(1);
  });

  it('should warn in the preview when a skill file looks like it holds a key', async () => {
    const r = await linkRig();
    r.items.tree.set(SKILL_PATH, {
      'SKILL.md': SKILL_MD,
      'notes.txt': 'api_key = sk-live-0123456789abcdef0123456789abcdef',
    });
    const preview = await previewSkill(r);
    const found = preview.warnings.find(warning => warning.code === 'possible-secret');
    should(found?.text).match(/notes\.txt/u);
    should(found?.text).not.match(/sk-live/u);
  });

  it('should preview an MCP setup with its secret placeholder, never a value', async () => {
    const r = await linkRig();
    r.items.servers = [
      {
        id: 'id-component-docs',
        name: 'docs',
        scope: 'component',
        harness: 'claude',
        declaration: null,
        component: { command: 'npx', args: ['-y', 'docs'], env: { API: PLACEHOLDER }, harness: 'claude' },
      },
    ];
    const preview = await r.service.preview({ source: { kind: 'mcp', mcp: 'docs' } });
    should(preview.itemKind).equal('mcp');
    should(JSON.stringify(preview.review)).containEql(PLACEHOLDER);
    should(preview.warnings.map(warning => warning.code)).not.containEql('possible-secret');
  });

  it('should say a link is too big when the sealed bundle passes the store cap', async () => {
    const r = await linkRig();
    const wrapped = await linkRig({ items: await tooBigItems(r) });
    const preview = await wrapped.service.preview({ source: SKILL_SOURCE });
    should(preview.tooBig).equal(true);
  });

  it('should refuse when the identity cannot be read', async () => {
    const r = await linkRig();
    r.items.identity = undefined;
    should((await refusal(() => r.service.preview({ source: SKILL_SOURCE }))).refusal).equal('signing_unavailable');
  });

  it('should pass on an item refusal a link knows, and a source that moved since it was kept', async () => {
    const r = await linkRig();
    should((await refusal(() => r.service.preview({ itemId: `itm_${'Z'.repeat(22)}`, version: 1 }))).refusal).equal(
      'item_unknown',
    );
    const created = await r.items.service.create({ name: 'Mine' });
    const first = await r.items.service.previewItem(created.id, { source: SKILL_SOURCE });
    await r.items.service.addItem(created.id, { source: SKILL_SOURCE, digest: first.digest });
    r.items.tree.set(SKILL_PATH, { 'SKILL.md': SKILL_MD, 'notes.txt': 'notes', 'extra.txt': 'extra' });
    should((await refusal(() => r.service.preview({ source: SKILL_SOURCE }))).refusal).equal('item_source_changed');
  });

  it('should let any other failure through unchanged', async () => {
    const r = await linkRig({
      items: {
        linkSubject: async () => {
          throw new Error('disk on fire');
        },
        holdsLinkVersion: async () => true,
      },
    });
    await r.service.preview({ source: SKILL_SOURCE }).then(
      () => should.fail('', '', 'expected an error'),
      error => should(error.message).equal('disk on fire'),
    );
  });
});

describe('CatalogLinkService mint', () => {
  it('should make a public link: key sealed, record written before the upload, item kept after it', async () => {
    const r = await linkRig();
    const events: string[] = [];
    const upload = r.client.upload.bind(r.client);
    r.client.upload = async (origin, body) => {
      events.push(`upload after ${r.documents.writes.length} writes, ${r.vault.puts.length} keys`);
      return await upload(origin, body);
    };
    const made = await mintPublic(r);
    should(events).deepEqual(['upload after 1 writes, 1 keys']);
    should(made.link.state).equal('live');
    should(made.link.kind).equal('public');
    should(made.link).not.have.property('bundleId');
    should(made.url.startsWith(`${APP_ORIGIN}/`)).equal(true);
    const seed = parseLinkFragment(new URL(made.url).hash.slice(1));
    should(seed).not.have.property('storeOrigin');
    should(r.vault.keys.get(made.link.linkId)).equal(seed.key);
    const stored = r.documents.document.links[0];
    should(stored?.pendingUpload).equal(undefined);
    should(stored?.keyRef).equal(made.link.linkId);
    should(stored?.publisher).equal(RIG_DAEMON_ID);
    should(r.client.uploads[0]?.origin).equal(STORE_ORIGIN);
    should(r.client.uploads[0]?.upload.action).equal('create');
    should(await r.items.service.holdsLinkVersion(made.link.itemId, 1)).equal(true);
    for (const text of r.documents.writes) should(text).not.containEql(seed.key);
  });

  it('should refuse a mint that has no app origin before it seals, writes or uploads anything', async () => {
    const r = await linkRig({ appOrigin: '' });
    const refused_ = await refusal(() => mintOneTime(r));
    should(refused_.refusal).equal('link_store_unavailable');
    should(r.client.uploads).deepEqual([]);
    should(r.vault.puts).deepEqual([]);
    should(r.documents.writes).deepEqual([]);
    should(r.documents.document.links).deepEqual([]);
  });

  it('S158 should never write a one-time link key anywhere', async () => {
    const r = await linkRig();
    const made = await mintOneTime(r);
    const key = keyOf(made.url);
    should(r.vault.puts).deepEqual([]);
    should(r.vault.keys.size).equal(0);
    should(made.link.kind).equal('one-time');
    for (const text of r.documents.writes) should(text).not.containEql(key);
    should(JSON.stringify(r.documents.document)).not.containEql(key);
    should(JSON.stringify(r.documents.document)).not.containEql(made.url);
    should(r.documents.document.links[0]?.keyRef).equal(undefined);
    should(r.client.uploads[0]?.upload.expiresAt).be.a.String();
  });

  it('should carry the store address only for a self-hosted store', async () => {
    const r = await linkRig();
    r.locator.site = { kind: 'ready', origin: 'https://mine.example.test', selfHosted: true };
    const made = await mintPublic(r);
    should(parseLinkFragment(new URL(made.url).hash.slice(1)).storeOrigin).equal('https://mine.example.test');
    should(r.documents.document.links[0]?.emitsStoreOrigin).equal(true);
  });

  it('should set the end, the cap and a 30 day lease for a link that never ends', async () => {
    const r = await linkRig();
    await mintPublic(r, 'never', 5);
    const upload = r.client.uploads[0]?.upload;
    should(upload?.installCap).equal(5);
    should(upload?.expiresAt).equal(undefined);
    should(upload?.notAfter).equal(new Date(r.items.clock.ms + 30 * 86_400_000).toISOString());
    const stored = r.documents.document.links[0];
    should(stored?.installCap).equal(5);
    should(stored?.expiresAt).equal(undefined);
    const dated = await linkRig();
    await mintPublic(dated, '1d');
    should(dated.client.uploads[0]?.upload.expiresAt).equal(new Date(dated.items.clock.ms + 86_400_000).toISOString());
  });

  it('should mint a kept version by item id without keeping anything new', async () => {
    const r = await linkRig();
    const created = await r.items.service.create({ name: 'Mine' });
    const first = await r.items.service.previewItem(created.id, { source: SKILL_SOURCE });
    const added = await r.items.service.addItem(created.id, { source: SKILL_SOURCE, digest: first.digest });
    const preview = await r.service.preview({ itemId: added.itemId, version: 1 });
    const made = await r.service.mint({
      item: { itemId: added.itemId, version: 1, digest: preview.digest },
      kind: 'public',
      expires: '7d',
    });
    should(made.link.itemId).equal(added.itemId);
  });

  it('should refuse when no store is taking links, and write nothing', async () => {
    const r = await linkRig();
    r.locator.site = { kind: 'unavailable', reason: 'Download links are turned off.' };
    const out = await refusal(() => mintPublic(r));
    should(out.refusal).equal('link_store_unavailable');
    should(out.message).equal('Download links are turned off.');
    should(r.documents.writes).deepEqual([]);
  });

  it('should refuse the fifty-first held link', async () => {
    const r = await linkRig();
    r.documents.document = {
      schemaVersion: 1,
      links: Array.from({ length: 50 }, () => storedLink({ state: 'live' })),
    };
    should((await refusal(() => mintPublic(r))).refusal).equal('links_full');
  });

  it('should refuse when what was previewed changed', async () => {
    const r = await linkRig();
    const preview = await previewSkill(r);
    r.items.tree.set(SKILL_PATH, { 'SKILL.md': SKILL_MD, 'notes.txt': 'changed' });
    const out = await refusal(() =>
      r.service.mint({ item: { source: SKILL_SOURCE, digest: preview.digest }, kind: 'public', expires: '7d' }),
    );
    should(out.refusal).equal('changed_since_preview');
    should(r.client.uploads).deepEqual([]);
  });

  it('should refuse when the identity cannot sign', async () => {
    const r = await linkRig();
    r.items.identity = undefined;
    should((await refusal(() => mintPublic(r))).refusal).equal('signing_unavailable');
  });

  it('should refuse an item with no one canonical spelling, before anything is written', async () => {
    const r = await linkRig();
    const real = await r.items.service.linkSubject({ source: SKILL_SOURCE });
    if (real.shared.kind !== 'skill') throw new Error('the rig shares a skill');
    const odd = {
      ...real,
      shared: {
        ...real.shared,
        skill: { files: [...real.shared.skill.files, { path: 'odd.txt', content: '\ud800' }] },
      },
    };
    const wrapped = await linkRig({ items: { linkSubject: async () => odd, holdsLinkVersion: async () => true } });
    const out = await refusal(() => wrapped.service.preview({ source: SKILL_SOURCE }));
    should(out.refusal).equal('signing_unavailable');
    should(out.message).containEql('canonical spelling');
    should(wrapped.client.uploads).have.length(0);
  });

  it('should refuse a bundle too big to seal, before anything is written', async () => {
    const r = await linkRig();
    const items = await tooBigItems(r);
    const wrapped = await linkRig({ items });
    const subject = await items.linkSubject({ source: SKILL_SOURCE });
    const out = await refusal(() =>
      wrapped.service.mint({
        item: { source: SKILL_SOURCE, digest: subject.contentDigest },
        kind: 'public',
        expires: '7d',
      }),
    );
    should(out.refusal).equal('link_too_big');
    should(wrapped.documents.writes).deepEqual([]);
    should(wrapped.vault.puts).deepEqual([]);
  });

  it('should drop the record and the key when the store says no, with its sentence', async () => {
    const r = await linkRig();
    r.client.uploadAnswer = refused('link_store_full');
    const out = await refusal(() => mintPublic(r));
    should(out.refusal).equal('link_store_unavailable');
    should(r.documents.document.links).deepEqual([]);
    should(r.vault.keys.size).equal(0);
  });

  it('should say too big when the store refuses for size', async () => {
    const r = await linkRig();
    r.client.uploadAnswer = refused('link_too_big');
    should((await refusal(() => mintPublic(r))).refusal).equal('link_too_big');
    should(r.documents.document.links).deepEqual([]);
  });

  it('should keep a pending record when the answer never came, for the next reconciliation', async () => {
    const r = await linkRig();
    r.client.uploadAnswer = UNREACHABLE;
    const out = await refusal(() => mintPublic(r));
    should(out.refusal).equal('link_store_unavailable');
    should(out.message).containEql('may have been made');
    should(out.message).not.containEql('no link was made');
    should(r.documents.document.links[0]?.state).equal('pending');
    should(r.vault.keys.size).equal(1);
  });

  it('should take the bundle back down when the item cannot be kept', async () => {
    const r = await linkRig();
    const subject = await r.items.service.linkSubject({ source: SKILL_SOURCE });
    const wrapped = await linkRig({
      items: {
        linkSubject: async () => ({
          ...subject,
          keep: async () => {
            throw new Error('disk full');
          },
        }),
        holdsLinkVersion: async () => true,
      },
    });
    await wrapped.service
      .mint({ item: { source: SKILL_SOURCE, digest: subject.contentDigest }, kind: 'public', expires: '7d' })
      .then(
        () => should.fail('', '', 'expected an error'),
        error => should(error.message).equal('disk full'),
      );
    should(wrapped.client.removes.length).equal(1);
    should(wrapped.documents.document.links[0]?.state).equal('ended');
    should(wrapped.documents.document.links[0]?.endReason).equal('item-gone');
    should(wrapped.vault.keys.size).equal(0);
  });

  it('should serialise two mints so neither write is lost', async () => {
    const r = await linkRig();
    const preview = await previewSkill(r);
    const request = { item: { source: SKILL_SOURCE, digest: preview.digest }, kind: 'public', expires: '7d' } as const;
    const [one, two] = await Promise.all([r.service.mint(request), r.service.mint(request)]);
    should(one.link.linkId).not.equal(two.link.linkId);
    should(r.documents.document.links.length).equal(2);
  });
});
