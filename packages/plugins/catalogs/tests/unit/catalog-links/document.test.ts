import { describe, it } from 'bun:test';
import should from 'should';
import {
  EMPTY_LINKS_DOCUMENT,
  findLink,
  heldCount,
  LINK_FORGET_AFTER_MS,
  LINKS_ENDED_KEPT_MAX,
  LinksDocumentSchema,
  pruned,
  withLink,
  withoutLink,
} from '../../../daemon/lib/catalog-links/document.ts';
import { isLinkRefusalCode } from '../../../daemon/lib/catalog-links/refusal.ts';
import { storedLink } from './support.ts';

const problem = (links: ReturnType<typeof storedLink>[]) => {
  const parsed = LinksDocumentSchema.safeParse({ schemaVersion: 1, links });
  return parsed.success ? undefined : parsed.error.issues[0]?.message;
};

describe('links.json document', () => {
  it('should accept the empty document and valid links', () => {
    should(LinksDocumentSchema.safeParse(EMPTY_LINKS_DOCUMENT).success).equal(true);
    should(problem([storedLink({ state: 'live' }), storedLink({ state: 'live', kind: 'one-time' })])).equal(undefined);
  });

  it('should refuse the shapes that could never be right', () => {
    const live = storedLink({ state: 'live' });
    should(problem([live, live])).containEql('listed twice');
    should(problem([live, { ...storedLink({ state: 'live' }), bundleId: live.bundleId }])).containEql(
      'share one bundle id',
    );
    const one = storedLink({ state: 'live', kind: 'one-time' });
    should(problem([{ ...one, keyRef: one.linkId }])).containEql('keeps a key');
    should(problem([{ ...one, sequence: 2 }])).containEql('uploaded again');
    should(problem([{ ...one, expiresAt: undefined }])).containEql('no end');
    should(problem([{ ...live, keyRef: undefined }])).containEql('no key');
    should(problem([{ ...live, keyRef: `lnk_${'Y'.repeat(22)}` }])).containEql("another link's key");
    should(problem([{ ...live, keyRef: undefined, state: 'ended' }])).equal(undefined);
    should(problem(Array.from({ length: 51 }, () => storedLink({ state: 'live' })))).containEql('more links are live');
  });

  it('should require the uploader and hold the store to an https origin', () => {
    const live = storedLink({ state: 'live' });
    const { publisher: _gone, ...unsigned } = live;
    should(LinksDocumentSchema.safeParse({ schemaVersion: 1, links: [unsigned] }).success).equal(false);
    should(problem([{ ...live, publisher: 'someone' }])).be.a.String();
    for (const storeOrigin of ['http://links.example.test', 'ftp://links.example.test', 'links.example.test'])
      should(LinksDocumentSchema.safeParse({ schemaVersion: 1, links: [{ ...live, storeOrigin }] }).success).equal(
        false,
      );
    should(problem([{ ...live, storeOrigin: 'http://127.0.0.1:8787' }])).equal(undefined);
  });

  it('should count what is held, find, add, replace and remove', () => {
    const a = storedLink({ state: 'live' });
    const b = storedLink({ state: 'pending' });
    const c = storedLink({ state: 'ending' });
    const d = storedLink({ state: 'ended' });
    should(heldCount([a, b, c, d])).equal(3);
    const document = withLink(withLink(EMPTY_LINKS_DOCUMENT, a), b);
    should(document.links.length).equal(2);
    should(findLink(document, a.linkId)).equal(a);
    should(findLink(document, 'lnk_none')).equal(undefined);
    should(withLink(document, { ...a, opens: 9 }).links[0]?.opens).equal(9);
    should(withoutLink(document, a.linkId).links).deepEqual([b]);
  });

  it('should forget ended links after thirty days and keep the newest five hundred, never a held one', () => {
    const now = Date.UTC(2026, 5, 1);
    const old = storedLink({ state: 'ended', endedAt: new Date(now - LINK_FORGET_AFTER_MS - 1).toISOString() });
    const recent = storedLink({ state: 'ended', endedAt: new Date(now - 1000).toISOString() });
    const held = storedLink({ state: 'live' });
    const noEnd = storedLink({ state: 'expired' });
    should(pruned({ schemaVersion: 1, links: [old, recent, held, noEnd] }, now).links).deepEqual([recent, held, noEnd]);
    const many = Array.from({ length: LINKS_ENDED_KEPT_MAX + 2 }, (_, index) =>
      storedLink({ state: 'ended', endedAt: new Date(now - 10_000 + index).toISOString() }),
    );
    const kept = pruned({ schemaVersion: 1, links: many }, now).links;
    should(kept.length).equal(LINKS_ENDED_KEPT_MAX);
    should(kept.some(link => link.linkId === many[0]?.linkId)).equal(false);
    should(kept.some(link => link.linkId === many[2]?.linkId)).equal(true);
    const undated = Array.from({ length: LINKS_ENDED_KEPT_MAX + 1 }, () => storedLink({ state: 'expired' }));
    should(pruned({ schemaVersion: 1, links: undated }, now).links.length).equal(LINKS_ENDED_KEPT_MAX);
  });

  it("should tell the link side's own refusal codes from others", () => {
    should(isLinkRefusalCode('link_unknown')).equal(true);
    should(isLinkRefusalCode('items_full')).equal(true);
    should(isLinkRefusalCode('catalog_unknown')).equal(false);
  });
});
