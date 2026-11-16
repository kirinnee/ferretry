import { describe, it } from 'bun:test';
import { parseLinkFragment } from '../../../daemon/lib/boundary.ts';
import should from 'should';
import { CatalogLinkRefusal } from '../../../daemon/lib/catalog-links/refusal.ts';
import { LINK_REFRESH_MS, LINK_RETRY_MAX_MS, LINK_RETRY_MIN_MS } from '../../../daemon/lib/catalog-links/service.ts';
import {
  keyOf,
  linkRig,
  mintOneTime,
  mintPublic,
  OTHER_DAEMON_ID,
  refused,
  SKILL_SOURCE,
  storedLink,
  STORE_ORIGIN,
  UNREACHABLE,
} from './support.ts';

const refusal = async (work: () => Promise<unknown>): Promise<CatalogLinkRefusal> => {
  try {
    await work();
  } catch (error) {
    if (error instanceof CatalogLinkRefusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('CatalogLinkService list and get', () => {
  it('G67 should list every link, or those of one item, with no bundle, store, key or URL', async () => {
    const r = await linkRig();
    const first = await mintPublic(r);
    await mintOneTime(r);
    const all = await r.service.list();
    should(all.links.length).equal(2);
    should(all.max).equal(50);
    should(all.links[0]?.storeState).equal('ok');
    should((await r.service.list(first.link.itemId)).links.length).equal(2);
    should((await r.service.list(`itm_${'Q'.repeat(22)}`)).links).deepEqual([]);
    const text = JSON.stringify(all);
    should(text).not.containEql(keyOf(first.url));
    should(text).not.containEql(r.documents.document.links[0]?.bundleId);
    should(text).not.containEql(STORE_ORIGIN);
    should((await r.service.get(first.link.linkId)).linkId).equal(first.link.linkId);
    should((await refusal(() => r.service.get(`lnk_${'Z'.repeat(22)}`))).refusal).equal('link_unknown');
  });

  it('should refuse to list when the identity cannot be read', async () => {
    const r = await linkRig();
    r.items.identity = undefined;
    should((await refusal(() => r.service.list())).refusal).equal('signing_unavailable');
  });

  it('should refresh the count of opens at most once a minute and ask each store once', async () => {
    const r = await linkRig();
    const made = await mintPublic(r);
    const bundleId = r.documents.document.links[0]?.bundleId ?? '';
    r.client.statusAnswer = () => ({ ok: true, value: { version: 1, links: [{ bundleId, state: 'live', opens: 4 }] } });
    should((await r.service.get(made.link.linkId)).opens).equal(4);
    should(r.client.statuses.length).equal(1);
    await r.service.get(made.link.linkId);
    should(r.client.statuses.length).equal(1);
    r.items.clock.ms += LINK_REFRESH_MS;
    await r.service.get(made.link.linkId);
    should(r.client.statuses.length).equal(2);
    should((await r.service.get(made.link.linkId)).opensCheckedAt).be.a.String();
  });

  it('should keep the last count and say the store is unreachable', async () => {
    const r = await linkRig();
    const made = await mintPublic(r);
    r.client.statusAnswer = () => UNREACHABLE;
    const link = await r.service.get(made.link.linkId);
    should(link.storeState).equal('unreachable');
    should(link.opens).equal(0);
    should(r.documents.document.links[0]?.opensCheckedAt).equal(undefined);
  });

  it('should not ask a failing store again for a minute, and serve the last count meanwhile', async () => {
    const r = await linkRig();
    const made = await mintPublic(r);
    r.client.statusAnswer = () => UNREACHABLE;
    should((await r.service.get(made.link.linkId)).storeState).equal('unreachable');
    should((await r.service.list()).links[0]?.storeState).equal('unreachable');
    should(r.client.statuses.length).equal(1);
    r.items.clock.ms += LINK_REFRESH_MS;
    await r.service.get(made.link.linkId);
    should(r.client.statuses.length).equal(2);
    const bundleId = r.documents.document.links[0]?.bundleId ?? '';
    r.client.statusAnswer = () => ({ ok: true, value: { version: 1, links: [{ bundleId, state: 'live', opens: 2 }] } });
    r.items.clock.ms += LINK_REFRESH_MS;
    should((await r.service.get(made.link.linkId)).opens).equal(2);
    r.client.statusAnswer = () => UNREACHABLE;
    r.items.clock.ms += LINK_REFRESH_MS;
    should((await r.service.get(made.link.linkId)).storeState).equal('unreachable');
    should(r.client.statuses.length).equal(4);
  });

  it('should leave a link the store did not report as it was', async () => {
    const r = await linkRig();
    const made = await mintPublic(r);
    r.client.statusAnswer = () => ({ ok: true, value: { version: 1, links: [] } });
    should((await r.service.get(made.link.linkId)).state).equal('live');
  });

  it('should apply what the store says: used, ended and a one-time link that lapsed, and keep a lapsed public link to put back', async () => {
    const r = await linkRig();
    const one = await mintOneTime(r);
    const two = await mintPublic(r);
    const three = await mintPublic(r);
    const four = await mintOneTime(r);
    const bundles = new Map(r.documents.document.links.map(link => [link.linkId, link.bundleId]));
    const states = new Map([
      [one.link.linkId, 'used'],
      [two.link.linkId, 'lapsed'],
      [three.link.linkId, 'ended'],
      [four.link.linkId, 'lapsed'],
    ] as const);
    r.client.statusAnswer = () => ({
      ok: true,
      value: {
        version: 1,
        links: [...states].map(([linkId, state]) => ({ bundleId: bundles.get(linkId) ?? '', state, opens: 1 })),
      },
    });
    const list = await r.service.list();
    const byId = new Map(list.links.map(link => [link.linkId, link]));
    should(byId.get(one.link.linkId)?.state).equal('used');
    should(byId.get(two.link.linkId)?.state).equal('live');
    should(byId.get(two.link.linkId)?.storeState).equal('lapsed');
    should(byId.get(three.link.linkId)?.state).equal('ended');
    should(byId.get(four.link.linkId)?.state).equal('expired');
    should(r.vault.forgotten).deepEqual([three.link.linkId]);
    should(r.vault.keys.has(two.link.linkId)).equal(true);
    should(list.sentence).containEql('1 link was dropped by the link store');
  });

  it('should end a link locally once its own end has passed, without asking the store', async () => {
    const r = await linkRig();
    const made = await mintPublic(r, '1d');
    r.items.clock.ms += 2 * 86_400_000;
    const link = await r.service.get(made.link.linkId);
    should(link.state).equal('expired');
    should(r.client.statuses.length).equal(0);
    should(r.vault.keys.size).equal(0);
    const never = await linkRig();
    const lasting = await mintPublic(never, 'never');
    never.items.clock.ms += 31 * 86_400_000;
    // A never-ending public link is renewed, so a lapsed 30-day lease alone is not its end; a one-time link's is.
    should((await never.service.get(lasting.link.linkId)).state).equal('live');
    should(never.vault.keys.has(lasting.link.linkId)).equal(true);
    const once = await linkRig();
    const single = await mintOneTime(once);
    once.items.clock.ms += 2 * 3_600_000;
    should((await once.service.get(single.link.linkId)).state).equal('expired');
  });

  it('should ask the store in batches of 64 per store', async () => {
    const r = await linkRig();
    r.documents.document = {
      schemaVersion: 1,
      links: [
        ...Array.from({ length: 40 }, () => storedLink({ state: 'live', notAfter: '2099-01-01T00:00:00.000Z' })),
        ...Array.from({ length: 24 }, () =>
          storedLink({
            state: 'live',
            notAfter: '2099-01-01T00:00:00.000Z',
            storeOrigin: 'https://other.example.test',
          }),
        ),
      ],
    };
    r.items.clock.ms = Date.UTC(2026, 0, 2);
    await r.service.list();
    should(r.client.statuses.map(call => [call.origin, call.bundleIds.length]).toSorted()).deepEqual([
      ['https://links.example.test', 40],
      ['https://other.example.test', 24],
    ]);
    const big = await linkRig();
    big.documents.document = {
      schemaVersion: 1,
      links: Array.from({ length: 50 }, () => storedLink({ state: 'live', notAfter: '2099-01-01T00:00:00.000Z' })),
    };
    big.items.clock.ms = Date.UTC(2026, 0, 2);
    await big.service.list();
    should(big.client.statuses.length).equal(1);
  });
});

describe('CatalogLinkService copy', () => {
  it('G67 should give a public link its URL again from the sealed key, without asking the store', async () => {
    const r = await linkRig();
    const made = await mintPublic(r);
    const copied = await r.service.copy(made.link.linkId);
    should(copied.url).equal(made.url);
    should(r.client.statuses.length).equal(0);
  });

  it('should carry a self-hosted store address when copying', async () => {
    const r = await linkRig();
    r.locator.site = { kind: 'ready', origin: 'https://mine.example.test', selfHosted: true };
    const made = await mintPublic(r);
    const copied = await r.service.copy(made.link.linkId);
    should(parseLinkFragment(new URL(copied.url).hash.slice(1)).storeOrigin).equal('https://mine.example.test');
  });

  it('S158 should refuse a one-time link, a link that is not live and a key that is gone', async () => {
    const r = await linkRig();
    const one = await mintOneTime(r);
    should((await refusal(() => r.service.copy(one.link.linkId))).refusal).equal('link_not_public');
    const made = await mintPublic(r);
    r.vault.keys.delete(made.link.linkId);
    should((await refusal(() => r.service.copy(made.link.linkId))).refusal).equal('link_not_live');
    const ended = await mintPublic(r);
    await r.service.revoke(ended.link.linkId);
    should((await refusal(() => r.service.copy(ended.link.linkId))).refusal).equal('link_not_live');
    should((await refusal(() => r.service.copy(`lnk_${'Z'.repeat(22)}`))).refusal).equal('link_unknown');
  });

  it('should refuse when the identity cannot be read', async () => {
    const r = await linkRig();
    const made = await mintPublic(r);
    r.items.identity = undefined;
    should((await refusal(() => r.service.copy(made.link.linkId))).refusal).equal('signing_unavailable');
  });
});

describe('CatalogLinkService revoke', () => {
  it('should delete the bundle at the store the link went to, then end the link and forget its key', async () => {
    const r = await linkRig();
    const made = await mintPublic(r);
    r.locator.site = { kind: 'ready', origin: 'https://elsewhere.example.test', selfHosted: false };
    const ended = await r.service.revoke(made.link.linkId);
    should(ended.state).equal('ended');
    should(r.client.removes[0]?.origin).equal(STORE_ORIGIN);
    should(r.vault.keys.size).equal(0);
    should(r.documents.document.links[0]?.endReason).equal('owner');
    should((await r.service.revoke(made.link.linkId)).state).equal('ended');
    should(r.client.removes.length).equal(1);
  });

  it('should leave the link ending, and say it may still work, when the store cannot be reached', async () => {
    const r = await linkRig();
    const made = await mintPublic(r);
    r.client.removeAnswer = UNREACHABLE;
    const out = await refusal(() => r.service.revoke(made.link.linkId));
    should(out.refusal).equal('link_store_unavailable');
    should(out.message).containEql('may still work');
    should(r.documents.document.links[0]?.state).equal('ending');
    should(r.vault.keys.size).equal(1);
  });

  it('should not call a link off when a store answers link_unknown to a machine that did not make it', async () => {
    const r = await linkRig();
    const made = await mintPublic(r);
    const mine = r.items.identity;
    if (mine === undefined) throw new Error('the rig has an identity');
    r.items.identity = { ...mine, daemonId: OTHER_DAEMON_ID };
    r.client.removeAnswer = refused('link_unknown');
    const out = await refusal(() => r.service.revoke(made.link.linkId));
    should(out.refusal).equal('signing_unavailable');
    should(out.message).containEql('previous identity');
    should(out.message).containEql('It stops working by');
    should(r.documents.document.links[0]?.state).equal('ending');
    should(r.vault.keys.size).equal(1);
  });

  it('should keep trying a link made under another identity slowly, then lapse it once its own end has passed', async () => {
    const r = await linkRig();
    const made = await mintPublic(r, '1d');
    const mine = r.items.identity;
    if (mine === undefined) throw new Error('the rig has an identity');
    r.items.identity = { ...mine, daemonId: OTHER_DAEMON_ID };
    r.client.removeAnswer = refused('link_unknown');
    await refusal(() => r.service.revoke(made.link.linkId));
    r.items.clock.ms += LINK_RETRY_MAX_MS;
    await r.service.reconcile();
    should(r.client.removes.length).equal(2);
    should(r.documents.document.links[0]?.state).equal('ending');
    r.items.clock.ms += 2 * 86_400_000;
    await r.service.reconcile();
    const lapsed = r.documents.document.links[0];
    should(lapsed?.state).equal('expired');
    should(lapsed?.endReason).equal('expired');
    should(r.vault.keys.size).equal(0);
    should((await r.service.revoke(made.link.linkId)).state).equal('expired');
  });

  it('should answer a revoke past the end of a link made elsewhere with the link as it lapsed', async () => {
    const r = await linkRig();
    const made = await mintPublic(r, '1d');
    const mine = r.items.identity;
    if (mine === undefined) throw new Error('the rig has an identity');
    r.items.identity = { ...mine, daemonId: OTHER_DAEMON_ID };
    r.items.clock.ms += 2 * 86_400_000;
    r.client.removeAnswer = refused('link_unknown');
    should((await r.service.revoke(made.link.linkId)).state).equal('expired');
  });

  it('should treat a store that has no such bundle, or lost it, as done', async () => {
    for (const code of ['link_unknown', 'link_gone'] as const) {
      const r = await linkRig();
      const made = await mintPublic(r);
      r.client.removeAnswer = refused(code);
      should((await r.service.revoke(made.link.linkId)).state).equal('ended');
    }
  });

  it('should keep a link ending on any other refusal', async () => {
    const r = await linkRig();
    const made = await mintPublic(r);
    r.client.removeAnswer = refused('link_rate_limited');
    should((await refusal(() => r.service.revoke(made.link.linkId))).refusal).equal('link_store_unavailable');
    should(r.documents.document.links[0]?.state).equal('ending');
  });

  it('should refuse an unknown link', async () => {
    const r = await linkRig();
    should((await refusal(() => r.service.revoke(`lnk_${'Z'.repeat(22)}`))).refusal).equal('link_unknown');
  });
});

describe('CatalogLinkService reconcile', () => {
  it('should retry an ending link after a growing pause, capped at ten minutes', async () => {
    const r = await linkRig();
    const made = await mintPublic(r);
    r.client.removeAnswer = UNREACHABLE;
    await refusal(() => r.service.revoke(made.link.linkId));
    r.jitter.value = 0.999999;
    should(r.client.removes.length).equal(1);
    await r.service.reconcile();
    should(r.client.removes.length).equal(1);
    r.items.clock.ms += LINK_RETRY_MIN_MS;
    await r.service.reconcile();
    should(r.client.removes.length).equal(2);
    r.items.clock.ms += LINK_RETRY_MIN_MS;
    await r.service.reconcile();
    should(r.client.removes.length).equal(2);
    for (let round = 0; round < 12; round += 1) {
      r.items.clock.ms += LINK_RETRY_MAX_MS;
      await r.service.reconcile();
    }
    const calls = r.client.removes.length;
    r.items.clock.ms += LINK_RETRY_MAX_MS;
    await r.service.reconcile();
    should(r.client.removes.length).equal(calls + 1);
    r.client.removeAnswer = { ok: true, value: undefined };
    r.items.clock.ms += LINK_RETRY_MAX_MS;
    await r.service.reconcile();
    should(r.documents.document.links[0]?.state).equal('ended');
    should(r.documents.document.links[0]?.endReason).equal('owner');
  });

  it('should retry a link ending after the item went with the reason it began with', async () => {
    const r = await linkRig();
    r.documents.document = {
      schemaVersion: 1,
      links: [storedLink({ state: 'ending', endReason: 'item-gone' })],
    };
    await r.service.reconcile();
    should(r.documents.document.links[0]?.endReason).equal('item-gone');
    r.documents.document = { schemaVersion: 1, links: [storedLink({ state: 'ending' })] };
    await r.service.reconcile();
    should(r.documents.document.links[0]?.endReason).equal('owner');
  });

  it('should drop a pending link the store never took, with its key', async () => {
    const r = await linkRig();
    r.client.uploadAnswer = UNREACHABLE;
    await refusal(() => mintPublic(r));
    r.client.statusAnswer = () => ({ ok: true, value: { version: 1, links: [] } });
    await r.service.reconcile();
    should(r.documents.document.links).deepEqual([]);
    should(r.vault.keys.size).equal(0);
  });

  it('should make a pending public link live when the store has it and the item is kept', async () => {
    const r = await linkRig();
    const created = await r.items.service.create({ name: 'Mine' });
    const first = await r.items.service.previewItem(created.id, { source: SKILL_SOURCE });
    const added = await r.items.service.addItem(created.id, { source: SKILL_SOURCE, digest: first.digest });
    const preview = await r.service.preview({ itemId: added.itemId, version: 1 });
    r.client.uploadAnswer = UNREACHABLE;
    await refusal(() =>
      r.service.mint({
        item: { itemId: added.itemId, version: 1, digest: preview.digest },
        kind: 'public',
        expires: '7d',
      }),
    );
    await r.service.reconcile();
    const link = r.documents.document.links[0];
    should(link?.state).equal('live');
    should(link?.pendingUpload).equal(undefined);
  });

  it('should take down a pending link whose item was never kept', async () => {
    const r = await linkRig();
    r.client.uploadAnswer = UNREACHABLE;
    await refusal(() => mintPublic(r));
    const bad = await linkRig({
      items: { linkSubject: r.items.service.linkSubject.bind(r.items.service), holdsLinkVersion: async () => false },
    });
    bad.documents.document = r.documents.document;
    await bad.service.reconcile();
    should(bad.documents.document.links[0]?.state).equal('ended');
    should(bad.documents.document.links[0]?.endReason).equal('item-gone');
  });

  it('should take down a pending one-time link the store has: nobody was ever given its key', async () => {
    const r = await linkRig();
    r.client.uploadAnswer = UNREACHABLE;
    await refusal(() => mintOneTime(r));
    await r.service.reconcile();
    should(r.documents.document.links[0]?.state).equal('ended');
    should(r.client.removes.length).equal(1);
  });

  it('should take down a pending one-time link for an item that was already kept', async () => {
    const r = await linkRig();
    const kept = await mintPublic(r);
    r.client.uploadAnswer = UNREACHABLE;
    await refusal(() => mintOneTime(r));
    await r.service.reconcile();
    const once = r.documents.document.links.find(link => link.kind === 'one-time');
    should(once?.state).equal('ended');
    should(once?.endReason).equal('owner');
    should(r.client.removes.length).equal(1);
    should(r.documents.document.links.find(link => link.linkId === kept.link.linkId)?.state).equal('live');
  });

  it('should leave every record alone when the store cannot be reached', async () => {
    const r = await linkRig();
    r.client.uploadAnswer = UNREACHABLE;
    await refusal(() => mintPublic(r));
    r.client.statusAnswer = () => UNREACHABLE;
    await r.service.reconcile();
    should(r.documents.document.links[0]?.state).equal('pending');
  });

  it('should commit or drop the unconfirmed change of a live link by what the store holds', async () => {
    const r = await linkRig();
    const pendingUpload = {
      sequence: 2,
      version: 3,
      notAfter: '2099-01-01T00:00:00.000Z',
      expiresAt: '2098-01-01T00:00:00.000Z',
      installCap: 7,
    };
    const stored = storedLink({ state: 'live', pendingUpload });
    r.documents.document = { schemaVersion: 1, links: [stored] };
    r.client.statusAnswer = () => ({
      ok: true,
      value: { version: 1, links: [{ bundleId: stored.bundleId, state: 'live', sequence: 2 }] },
    });
    await r.service.reconcile();
    const committed = r.documents.document.links[0];
    should(committed?.version).equal(3);
    should(committed?.sequence).equal(2);
    should(committed?.notAfter).equal('2099-01-01T00:00:00.000Z');
    should(committed?.expiresAt).equal('2098-01-01T00:00:00.000Z');
    should(committed?.installCap).equal(7);
    should(committed?.pendingUpload).equal(undefined);

    r.documents.document = { schemaVersion: 1, links: [stored] };
    r.client.statusAnswer = () => ({
      ok: true,
      value: { version: 1, links: [{ bundleId: stored.bundleId, state: 'live', sequence: 1 }] },
    });
    await r.service.reconcile();
    const dropped = r.documents.document.links[0];
    should(dropped?.version).equal(1);
    should(dropped?.state).equal('live');
    should(dropped?.pendingUpload).equal(undefined);
  });

  it('should not touch a settled live link', async () => {
    const r = await linkRig();
    await mintPublic(r);
    const before = r.documents.writes.length;
    await r.service.reconcile();
    should(r.documents.writes.length).equal(before);
    should(r.client.statuses.length).equal(0);
  });
});
