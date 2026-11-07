import { describe, it } from 'bun:test';
import should from 'should';
import type { AuditEntry } from '../../../daemon/lib/audit.ts';
import { CatalogLinkRefusal } from '../../../daemon/lib/catalog-links/refusal.ts';
import { LINK_RENEW_WITHIN_MS } from '../../../daemon/lib/catalog-links/service.ts';
import { linkUsageOf } from '../../../daemon/lib/catalog-links/usage.ts';
import { CatalogRefusal } from '../../../daemon/lib/shared-catalogs/refusal.ts';
import { SKILL_MD } from '../shared-catalogs/support.ts';
import {
  keyOf,
  linkRig,
  mintOneTime,
  mintPublic,
  OTHER_DAEMON_ID,
  refused,
  SKILL_PATH,
  storedLink,
  tooBigItems,
  UNREACHABLE,
  type LinkRig,
} from './support.ts';

const DAY = 86_400_000;

const refusal = async (work: () => Promise<unknown>): Promise<CatalogLinkRefusal> => {
  try {
    await work();
  } catch (error) {
    if (error instanceof CatalogLinkRefusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

class Sink {
  readonly entries: AuditEntry[] = [];
  failing = false;
  async record(entry: AuditEntry): Promise<void> {
    if (this.failing) throw new Error('the log is full');
    this.entries.push(entry);
  }
}

/** Publishes a second version of the item the link serves, and returns the digest a move to it must confirm. */
async function publishSecond(r: LinkRig, itemId: string): Promise<string> {
  r.items.tree.set(SKILL_PATH, { 'SKILL.md': SKILL_MD, 'notes.txt': 'second' });
  const preview = await r.items.service.previewItemVersion(itemId);
  await r.items.service.publishItemVersion(itemId, { digest: preview.digest });
  return (await r.items.service.linkSubject({ itemId, version: 2 })).contentDigest;
}

async function movable(overrides: Parameters<typeof linkRig>[0] = {}) {
  const r = await linkRig(overrides);
  const made = await mintPublic(r);
  const digest = await publishSecond(r, made.link.itemId);
  const move = { version: 2, from: 1, digest };
  return { r, made, move, id: made.link.linkId };
}

const stored = (r: LinkRig) => {
  const link = r.documents.document.links[0];
  if (link === undefined) throw new Error('no link');
  return link;
};

describe('CatalogLinkService move', () => {
  it('should serve another version from the same URL and key, with a new document', async () => {
    const { r, made, move, id } = await movable();
    r.items.clock.ms += DAY;
    const moved = await r.service.move(id, move);
    should(moved.version).equal(2);
    should(moved.movedFrom).equal(1);
    should(moved.sequence).equal(2);
    should(moved.state).equal('live');
    const [first, second] = r.client.uploads.map(call => call.upload);
    should(second?.action).equal('replace');
    should(second?.expectSequence).equal(1);
    should(second?.sequence).equal(2);
    should(second?.bundleId).equal(first?.bundleId);
    should(stored(r).pendingUpload).equal(undefined);
    should(stored(r).servedSince).equal(new Date(r.items.clock.ms).toISOString());
    should(r.vault.keys.get(id)).equal(keyOf(made.url));
    should((await r.service.copy(id)).url).equal(made.url);
  });

  it('should refuse a move made from a stale screen, to the same version, or to bytes that changed', async () => {
    const { r, move, id } = await movable();
    should((await refusal(() => r.service.move(id, { ...move, from: 2 }))).refusal).equal('current_changed');
    should((await refusal(() => r.service.move(id, { ...move, version: 1 }))).refusal).equal('nothing_to_publish');
    const changed = await refusal(() => r.service.move(id, { ...move, digest: `sha256:${'0'.repeat(64)}` }));
    should(changed.refusal).equal('changed_since_preview');
    should(r.client.uploads.length).equal(1);
    should(stored(r).pendingUpload).equal(undefined);
  });

  it('should refuse a one-time link, a link that is off, an unknown link and a key that is gone', async () => {
    const { r, move, id } = await movable();
    const one = await mintOneTime(r);
    should((await refusal(() => r.service.move(one.link.linkId, move))).refusal).equal('link_not_public');
    should((await refusal(() => r.service.move(`lnk_${'Z'.repeat(22)}`, move))).refusal).equal('link_unknown');
    r.vault.keys.delete(id);
    should((await refusal(() => r.service.move(id, move))).refusal).equal('link_not_live');
    const ended = await mintPublic(r);
    await r.service.revoke(ended.link.linkId);
    should((await refusal(() => r.service.move(ended.link.linkId, move))).refusal).equal('link_not_live');
  });

  it('should refuse a retired version, and one retired after the change was written down', async () => {
    const { r, move, id } = await movable();
    const itemId = stored(r).itemId;
    await r.items.service.makeCurrent(itemId, { version: 1, from: 2 });
    await r.items.service.setRetired(itemId, 2, true);
    should((await refusal(() => r.service.move(id, move))).refusal).equal('version_retired');
    await r.items.service.setRetired(itemId, 2, false);
    r.items.service.holdsLinkVersion = async () => false;
    const late = await refusal(() => r.service.move(id, move));
    should(late.refusal).equal('version_retired');
    should(stored(r).pendingUpload).equal(undefined);
    should(r.client.uploads.length).equal(1);
  });

  it('should refuse when the identity cannot be read', async () => {
    const { r, move, id } = await movable();
    r.items.identity = undefined;
    should((await refusal(() => r.service.move(id, move))).refusal).equal('signing_unavailable');
  });

  it('should refuse a bundle too big to seal', async () => {
    const r = await linkRig();
    const big = await tooBigItems(r);
    let useBig = false;
    const wrapped = await linkRig({
      items: {
        linkSubject: async (selection, summary) =>
          await (useBig ? big : wrapped.items.service).linkSubject(selection, summary),
        holdsLinkVersion: async () => true,
      },
    });
    const made = await mintPublic(wrapped);
    useBig = true;
    const subject = await big.linkSubject({ source: { kind: 'skill', skill: 'demo' } });
    const out = await refusal(() =>
      wrapped.service.move(made.link.linkId, { version: 2, from: 1, digest: subject.contentDigest }),
    );
    should(out.refusal).equal('link_too_big');
    should(stored(wrapped).pendingUpload).equal(undefined);
  });

  it('should leave the link as it was when the store says no', async () => {
    const { r, move, id } = await movable();
    r.client.uploadAnswer = refused('link_sequence_conflict');
    const out = await refusal(() => r.service.move(id, move));
    should(out.refusal).equal('link_store_unavailable');
    should(out.message).containEql('did not take that change');
    should(stored(r).pendingUpload).equal(undefined);
    should(stored(r).version).equal(1);
  });

  it('should keep the change written down when the store never answered, and settle it from what the store holds', async () => {
    const { r, move, id } = await movable();
    r.client.uploadAnswer = UNREACHABLE;
    const out = await refusal(() => r.service.move(id, move));
    should(out.message).containEql('may have been made');
    should(stored(r).pendingUpload?.version).equal(2);
    r.client.statusAnswer = bundleIds => ({
      ok: true,
      value: { version: 1, links: bundleIds.map(bundleId => ({ bundleId, state: 'live' as const, sequence: 2 })) },
    });
    await r.service.reconcile();
    should(stored(r).version).equal(2);
    should(stored(r).movedFrom).equal(1);
    should(stored(r).sequence).equal(2);
    should(stored(r).pendingUpload).equal(undefined);
  });

  it('should drop an unconfirmed change the store did not take, and carry on', async () => {
    const { r, move, id } = await movable();
    r.client.uploadAnswer = UNREACHABLE;
    await refusal(() => r.service.move(id, move));
    r.client.uploadAnswer = { ok: true, value: undefined };
    const moved = await r.service.move(id, move);
    should(moved.version).equal(2);
    should(moved.sequence).equal(2);
  });

  it('should wait, and say so, while an earlier change cannot be settled', async () => {
    const { r, move, id } = await movable();
    r.client.uploadAnswer = UNREACHABLE;
    await refusal(() => r.service.move(id, move));
    r.client.statusAnswer = () => UNREACHABLE;
    const out = await refusal(() => r.service.move(id, move));
    should(out.refusal).equal('link_store_unavailable');
    should(out.message).containEql('still waiting');
  });
});

describe('CatalogLinkService update', () => {
  it('should know which changes reach further', async () => {
    const r = await linkRig();
    const made = await mintPublic(r, '7d', 5);
    const id = made.link.linkId;
    const widens = (request: Parameters<typeof r.service.update>[1]) => r.service.widens(id, request);
    should(await widens({ expires: '1d' })).equal(false);
    should(await widens({ expires: '30d' })).equal(true);
    should(await widens({ expires: 'never' })).equal(true);
    should(await widens({ installCap: 3 })).equal(false);
    should(await widens({ installCap: 9 })).equal(true);
    should(await widens({ installCap: null })).equal(true);
    should(await widens({ expires: '7d', installCap: 5 })).equal(false);
    const open = await mintPublic(r, 'never');
    should(await r.service.widens(open.link.linkId, { installCap: 4 })).equal(false);
    should(await r.service.widens(open.link.linkId, { expires: '30d' })).equal(false);
    should((await refusal(() => r.service.widens(`lnk_${'Z'.repeat(22)}`, { installCap: 1 }))).refusal).equal(
      'link_unknown',
    );
  });

  it('should narrow the end and the cap with a new document and no passkey', async () => {
    const r = await linkRig();
    const made = await mintPublic(r, '7d', 5);
    r.items.clock.ms += DAY;
    const out = await r.service.update(made.link.linkId, { expires: '1d', installCap: 2 }, false);
    should(out.installCap).equal(2);
    should(out.sequence).equal(2);
    should(out.expiresAt).equal(new Date(r.items.clock.ms + DAY).toISOString());
    const upload = r.client.uploads.at(-1)?.upload;
    should(upload?.action).equal('replace');
    should(upload?.expectSequence).equal(1);
    should(upload?.installCap).equal(2);
    should(upload?.notAfter).equal(out.expiresAt);
  });

  it('should take the cap off, and the end off, when asked and proven', async () => {
    const r = await linkRig();
    const made = await mintPublic(r, '7d', 5);
    const out = await r.service.update(made.link.linkId, { expires: 'never', installCap: null }, true);
    should(out.installCap).equal(undefined);
    should(out.expiresAt).equal(undefined);
    const upload = r.client.uploads.at(-1)?.upload;
    should(upload?.installCap).equal(undefined);
    should(upload?.expiresAt).equal(undefined);
    should(stored(r).installCap).equal(undefined);
    should(stored(r).expiresAt).equal(undefined);
    should(stored(r).notAfter).equal(new Date(r.items.clock.ms + 30 * DAY).toISOString());
  });

  it('should refuse a change that reaches further than the caller proved', async () => {
    const r = await linkRig();
    const made = await mintPublic(r, '7d', 5);
    const out = await refusal(() => r.service.update(made.link.linkId, { installCap: 9 }, false));
    should(out.refusal).equal('current_changed');
    should(r.client.uploads.length).equal(1);
  });

  it('should write nothing for a change that changes nothing', async () => {
    const r = await linkRig();
    const made = await mintPublic(r, '7d', 5);
    const writes = r.documents.writes.length;
    const out = await r.service.update(made.link.linkId, { installCap: 5 }, false);
    should(out.sequence).equal(1);
    should(r.client.uploads.length).equal(1);
    should(r.documents.writes.length).equal(writes);
  });

  it('should refuse a one-time link and a link that is off', async () => {
    const r = await linkRig();
    const one = await mintOneTime(r);
    should((await refusal(() => r.service.update(one.link.linkId, { installCap: 1 }, false))).refusal).equal(
      'link_not_public',
    );
    const made = await mintPublic(r);
    await r.service.revoke(made.link.linkId);
    should((await refusal(() => r.service.update(made.link.linkId, { installCap: 1 }, false))).refusal).equal(
      'link_not_live',
    );
  });
});

describe('CatalogLinkService refresh', () => {
  it('should re-sign a link a week after the last refresh, as the same version', async () => {
    const r = await linkRig();
    const made = await mintPublic(r, 'never');
    r.items.clock.ms += 8 * DAY;
    await r.service.refresh();
    const upload = r.client.uploads.at(-1)?.upload;
    should(upload?.action).equal('replace');
    should(upload?.expectSequence).equal(1);
    should(stored(r).sequence).equal(2);
    should(stored(r).version).equal(1);
    should(stored(r).movedFrom).equal(undefined);
    should(stored(r).notAfter).equal(new Date(r.items.clock.ms + 30 * DAY).toISOString());
    should((await r.service.copy(made.link.linkId)).url).equal(made.url);
  });

  it('should leave a link alone while its lease has time, and when a short end leaves nothing to extend', async () => {
    const r = await linkRig();
    await mintPublic(r, 'never');
    await mintPublic(r, '1d');
    r.items.clock.ms += DAY / 2;
    const asked = r.client.uploads.length;
    await r.service.refresh();
    should(r.client.uploads.length).equal(asked);
    should(LINK_RENEW_WITHIN_MS).equal(23 * DAY);
  });

  it('should put back a link the store let lapse, under the same id and key, and tell the log', async () => {
    const sink = new Sink();
    const r = await linkRig({ audit: sink });
    const made = await mintPublic(r, 'never');
    r.items.clock.ms += 31 * DAY;
    r.client.statusAnswer = bundleIds => ({
      ok: true,
      value: { version: 1, links: bundleIds.map(bundleId => ({ bundleId, state: 'lapsed' as const })) },
    });
    await r.service.refresh();
    const upload = r.client.uploads.at(-1)?.upload;
    should(upload?.action).equal('create');
    should(upload?.sequence).equal(2);
    should(upload?.expectSequence).equal(undefined);
    should(stored(r).revivedAt).equal(new Date(r.items.clock.ms).toISOString());
    should(stored(r).state).equal('live');
    should(sink.entries.map(entry => entry.event)).deepEqual(['catalog.link.revived']);
    should(sink.entries[0]?.subject).equal(made.link.linkId);
    should(sink.entries[0]?.detail).deepEqual({ linkId: made.link.linkId, sequence: 2 });
    should(JSON.stringify(sink.entries)).not.containEql(keyOf(made.url));
  });

  it('should keep a never-ending link live past its 30-day lease, listed as lapsed, until refresh puts it back', async () => {
    const r = await linkRig();
    const made = await mintPublic(r, 'never');
    r.items.clock.ms += 31 * DAY;
    r.client.statusAnswer = bundleIds => ({
      ok: true,
      value: { version: 1, links: bundleIds.map(bundleId => ({ bundleId, state: 'lapsed' as const })) },
    });
    const listed = await r.service.list();
    should(listed.links[0]?.state).equal('live');
    should(listed.links[0]?.storeState).equal('lapsed');
    should((await r.service.get(made.link.linkId)).state).equal('live');
    should(r.vault.keys.has(made.link.linkId)).equal(true);
    await r.service.refresh();
    should(stored(r).sequence).equal(2);
    should(stored(r).revivedAt).not.equal(undefined);
    should(stored(r).notAfter).equal(new Date(r.items.clock.ms + 30 * DAY).toISOString());
    should((await r.service.copy(made.link.linkId)).url).equal(made.url);
  });

  it('should put back a link the store no longer knows, and carry on if the log refuses', async () => {
    const sink = new Sink();
    sink.failing = true;
    const r = await linkRig({ audit: sink });
    await mintPublic(r);
    r.client.statusAnswer = bundleIds => ({
      ok: true,
      value: { version: 1, links: bundleIds.map(bundleId => ({ bundleId, state: 'unknown' as const })) },
    });
    await r.service.refresh();
    should(stored(r).revivedAt).not.equal(undefined);
  });

  it('should put a link back without a log to tell', async () => {
    const r = await linkRig();
    await mintPublic(r);
    r.client.statusAnswer = bundleIds => ({
      ok: true,
      value: { version: 1, links: bundleIds.map(bundleId => ({ bundleId, state: 'lapsed' as const })) },
    });
    await r.service.refresh();
    should(stored(r).sequence).equal(2);
  });

  it('should settle a put-back the store took after the answer was lost', async () => {
    const sink = new Sink();
    const r = await linkRig({ audit: sink });
    await mintPublic(r);
    r.client.statusAnswer = bundleIds => ({
      ok: true,
      value: { version: 1, links: bundleIds.map(bundleId => ({ bundleId, state: 'lapsed' as const })) },
    });
    r.client.uploadAnswer = UNREACHABLE;
    await r.service.refresh();
    should(stored(r).pendingUpload?.revived).equal(true);
    r.client.statusAnswer = bundleIds => ({
      ok: true,
      value: { version: 1, links: bundleIds.map(bundleId => ({ bundleId, state: 'live' as const, sequence: 2 })) },
    });
    await r.service.reconcile();
    should(stored(r).pendingUpload).equal(undefined);
    should(stored(r).revivedAt).not.equal(undefined);
    should(sink.entries.length).equal(1);
  });

  it('should change nothing when the store cannot be reached or does not report the link', async () => {
    const r = await linkRig();
    await mintPublic(r);
    r.items.clock.ms += 8 * DAY;
    const asked = r.client.uploads.length;
    r.client.statusAnswer = () => UNREACHABLE;
    await r.service.refresh();
    r.client.statusAnswer = () => ({ ok: true, value: { version: 1, links: [] } });
    await r.service.refresh();
    should(r.client.uploads.length).equal(asked);
    should(stored(r).sequence).equal(1);
  });

  it('should leave one-time links, links with a change in flight, and links that are off', async () => {
    const r = await linkRig();
    await mintOneTime(r);
    r.documents.document = {
      schemaVersion: 1,
      links: [
        ...r.documents.document.links,
        storedLink({
          state: 'live',
          notAfter: '2026-01-02T00:00:00.000Z',
          pendingUpload: { sequence: 2, version: 1, notAfter: '2026-02-01T00:00:00.000Z' },
        }),
        storedLink({ state: 'ended', endedAt: '2026-01-01T00:00:00.000Z', endReason: 'owner' }),
      ],
    };
    await r.service.refresh();
    should(r.client.statuses.length).equal(0);
  });

  it('should end a link whose item is gone, and keep one the store only refused to change', async () => {
    const r = await linkRig();
    const made = await mintPublic(r);
    const keep = await mintPublic(r);
    r.items.clock.ms += DAY;
    r.client.statusAnswer = bundleIds => ({
      ok: true,
      value: { version: 1, links: bundleIds.map(bundleId => ({ bundleId, state: 'lapsed' as const })) },
    });
    const real = r.items.service.linkSubject.bind(r.items.service);
    r.items.service.linkSubject = async () => {
      throw new CatalogRefusal('item_unknown', 'gone');
    };
    await r.service.refresh();
    const byId = new Map(r.documents.document.links.map(link => [link.linkId, link]));
    should(byId.get(made.link.linkId)?.state).equal('ended');
    should(byId.get(made.link.linkId)?.endReason).equal('item-gone');
    should(byId.get(keep.link.linkId)?.endReason).equal('item-gone');

    const other = await linkRig();
    const kept = await mintPublic(other);
    other.client.statusAnswer = bundleIds => ({
      ok: true,
      value: { version: 1, links: bundleIds.map(bundleId => ({ bundleId, state: 'lapsed' as const })) },
    });
    other.client.uploadAnswer = refused('link_store_full');
    await other.service.refresh();
    should(other.documents.document.links[0]?.state).equal('live');
    should(kept.link.linkId).equal(other.documents.document.links[0]?.linkId);
    void real;
  });

  it('should not hide an error that is not a refusal', async () => {
    const r = await linkRig();
    await mintPublic(r);
    r.client.statusAnswer = bundleIds => ({
      ok: true,
      value: { version: 1, links: bundleIds.map(bundleId => ({ bundleId, state: 'lapsed' as const })) },
    });
    r.items.service.linkSubject = async () => {
      throw new Error('boom');
    };
    let thrown: unknown;
    try {
      await r.service.refresh();
    } catch (error) {
      thrown = error;
    }
    should((thrown as Error).message).equal('boom');
  });
});

describe('CatalogLinkService an extension the store took but never answered', () => {
  const unanswered = async () => {
    const r = await linkRig();
    const made = await mintPublic(r, '1d');
    r.client.uploadAnswer = UNREACHABLE;
    await refusal(() => r.service.update(made.link.linkId, { expires: '7d' }, true));
    should(stored(r).pendingUpload?.sequence).equal(2);
    return { r, id: made.link.linkId, extended: stored(r).pendingUpload?.expiresAt };
  };

  it('should not call the link expired across its old deadline, and still turn it off at the store', async () => {
    const { r, id } = await unanswered();
    r.items.clock.ms += 2 * DAY;
    const seen = await r.service.get(id);
    should(seen.state).equal('live');
    should(r.vault.keys.has(id)).equal(true);
    should(stored(r).pendingUpload).not.equal(undefined);
    const off = await r.service.revoke(id);
    should(r.client.removes.length).equal(1);
    should(off.state).equal('ended');
    should(r.vault.keys.has(id)).equal(false);
  });

  it('should call the link expired, at the extended end, once that has passed too', async () => {
    const { r, id, extended } = await unanswered();
    r.items.clock.ms += 8 * DAY;
    const seen = await r.service.get(id);
    should(seen.state).equal('expired');
    should(seen.endedAt).equal(extended);
    should(r.vault.keys.has(id)).equal(false);
  });

  it('should say a link made under another identity may be served until the extended end', async () => {
    const { r, id, extended } = await unanswered();
    const mine = r.items.identity;
    if (mine === undefined) throw new Error('the rig has an identity');
    r.items.identity = { ...mine, daemonId: OTHER_DAEMON_ID };
    const seen = await r.service.get(id);
    should(seen.state).equal('ended');
    should(seen.endReason).equal('identity-changed');
    should(seen.stopsBy).equal(extended);
    should(stored(r).pendingUpload).equal(undefined);
  });

  it('should not call a link made under another identity expired while the extended end is ahead', async () => {
    const { r, id, extended } = await unanswered();
    const mine = r.items.identity;
    if (mine === undefined) throw new Error('the rig has an identity');
    r.items.identity = { ...mine, daemonId: OTHER_DAEMON_ID };
    r.client.removeAnswer = refused('link_unknown');
    r.items.clock.ms += 2 * DAY;
    const out = await refusal(() => r.service.revoke(id));
    should(out.refusal).equal('signing_unavailable');
    should(out.message).containEql(extended ?? 'no extended end');
    should(stored(r).state).equal('ending');
    should(stored(r).pendingUpload).equal(undefined);
    r.items.clock.ms += DAY;
    await r.service.reconcile();
    should(stored(r).state).equal('ending');
    r.items.clock.ms += 6 * DAY;
    await r.service.revoke(id);
    should(stored(r).state).equal('expired');
  });
});

describe('CatalogLinkService an upload the store took but never answered, then let lapse', () => {
  const lapsedAt = (sequence: number) => (bundleIds: readonly string[]) =>
    ({
      ok: true,
      value: { version: 1, links: bundleIds.map(bundleId => ({ bundleId, state: 'lapsed' as const, sequence })) },
    }) as const;

  it('should keep the sequence of a lost refresh the store took, and put the link back at the next one', async () => {
    const r = await linkRig();
    const made = await mintPublic(r, 'never');
    r.items.clock.ms += 8 * DAY;
    r.client.uploadAnswer = UNREACHABLE;
    await r.service.refresh();
    should(stored(r).pendingUpload?.sequence).equal(2);
    r.client.uploadAnswer = { ok: true, value: undefined };
    r.items.clock.ms += 31 * DAY;
    r.client.statusAnswer = lapsedAt(2);
    await r.service.reconcile();
    should(stored(r).pendingUpload).equal(undefined);
    should(stored(r).sequence).equal(2);
    should(stored(r).state).equal('live');
    await r.service.refresh();
    const upload = r.client.uploads.at(-1)?.upload;
    should(upload?.action).equal('create');
    should(upload?.sequence).equal(3);
    should(stored(r).sequence).equal(3);
    should(stored(r).revivedAt).not.equal(undefined);
    should((await r.service.copy(made.link.linkId)).url).equal(made.url);
  });

  it('should keep a link live when the store took the removal of its end and the lease then lapsed', async () => {
    const r = await linkRig();
    const made = await mintPublic(r, '7d');
    r.client.uploadAnswer = UNREACHABLE;
    await refusal(() => r.service.update(made.link.linkId, { expires: 'never' }, true));
    should(stored(r).pendingUpload?.sequence).equal(2);
    should(stored(r).pendingUpload?.expiresAt).equal(undefined);
    r.items.clock.ms += 40 * DAY;
    r.client.statusAnswer = lapsedAt(2);
    await r.service.reconcile();
    should(stored(r).state).equal('live');
    should(stored(r).sequence).equal(2);
    should(stored(r).expiresAt).equal(undefined);
    should((await r.service.get(made.link.linkId)).state).equal('live');
  });

  it('should drop an unanswered upload when the store holds another sequence, or has ended the link', async () => {
    const r = await linkRig();
    await mintPublic(r, 'never');
    r.items.clock.ms += 8 * DAY;
    r.client.uploadAnswer = UNREACHABLE;
    await r.service.refresh();
    should(stored(r).pendingUpload?.sequence).equal(2);
    r.client.statusAnswer = lapsedAt(1);
    await r.service.reconcile();
    should(stored(r).pendingUpload).equal(undefined);
    should(stored(r).sequence).equal(1);
    await r.service.refresh();
    should(stored(r).pendingUpload?.sequence).equal(2);
    r.client.statusAnswer = bundleIds => ({
      ok: true,
      value: { version: 1, links: bundleIds.map(bundleId => ({ bundleId, state: 'ended' as const, sequence: 2 })) },
    });
    await r.service.reconcile();
    should(stored(r).pendingUpload).equal(undefined);
    should(stored(r).sequence).equal(1);
  });
});

describe('CatalogLinkService a version retired while a change is being written down', () => {
  it('should refuse the move when a retire in flight finishes before the final check', async () => {
    let r!: LinkRig;
    r = await linkRig({}, { linkUsage: { serving: () => linkUsageOf(r.documents).serving() } });
    const made = await mintPublic(r);
    const digest = await publishSecond(r, made.link.itemId);
    const itemId = made.link.itemId;
    await r.items.service.makeCurrent(itemId, { version: 1, from: 2 });

    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    let reached!: () => void;
    const paused = new Promise<void>(resolve => (reached = resolve));
    const write = r.items.documents.write.bind(r.items.documents);
    r.items.documents.write = async document => {
      reached();
      await gate;
      await write(document);
    };

    const retire = r.items.service.setRetired(itemId, 2, true);
    await paused;
    const move = refusal(() => r.service.move(made.link.linkId, { version: 2, from: 1, digest }));
    while (stored(r).pendingUpload === undefined) await new Promise(resolve => setTimeout(resolve, 0));
    release();

    should((await move).refusal).equal('version_retired');
    await retire;
    should(r.client.uploads.length).equal(1);
    should(stored(r).pendingUpload).equal(undefined);
  });
});

describe('CatalogLinkService identity rotation', () => {
  const rotate = (r: LinkRig) => {
    const mine = r.items.identity;
    if (mine === undefined) throw new Error('the rig has an identity');
    r.items.identity = { ...mine, daemonId: OTHER_DAEMON_ID };
  };

  it('should end a live link made under another identity, forget its key, and say when it stops', async () => {
    const r = await linkRig();
    const made = await mintPublic(r, '7d');
    rotate(r);
    r.client.statusAnswer = () => ({ ok: true, value: { version: 1, links: [] } });
    const list = await r.service.list();
    const link = list.links[0];
    should(link?.state).equal('ended');
    should(link?.endReason).equal('identity-changed');
    should(link?.stopsBy).equal(stored(r).notAfter);
    should(r.vault.keys.has(made.link.linkId)).equal(false);
    should(list.sentence).containEql("1 link was made under this machine's previous identity");
    should(r.client.removes.length).equal(0);
  });

  it('should end a link and sign nothing when the identity changes while the store is being asked', async () => {
    const r = await linkRig();
    const made = await mintPublic(r, 'never');
    const uploads = r.client.uploads.length;
    r.client.statusAnswer = bundleIds => {
      rotate(r);
      return {
        ok: true,
        value: { version: 1, links: bundleIds.map(bundleId => ({ bundleId, state: 'lapsed' as const })) },
      };
    };
    await r.service.refresh();
    should(r.client.uploads.length).equal(uploads);
    should(stored(r).state).equal('ended');
    should(stored(r).endReason).equal('identity-changed');
    should(r.vault.keys.has(made.link.linkId)).equal(false);
  });

  it('should end a pending link made under another identity too', async () => {
    const r = await linkRig();
    r.documents.document = { schemaVersion: 1, links: [storedLink({ state: 'pending' })] };
    await r.service.refresh();
    rotate(r);
    const out = await r.service.get(r.documents.document.links[0]?.linkId ?? '');
    should(out.state).equal('ended');
    should(out.endReason).equal('identity-changed');
  });

  it('should count several, and say nothing once their lease has passed', async () => {
    const r = await linkRig();
    await mintPublic(r, '7d');
    await mintPublic(r, '7d');
    rotate(r);
    const list = await r.service.list();
    should(list.sentence).containEql('2 links were made under');
    should(list.sentence).containEql('They stop working');
    r.items.clock.ms += 31 * DAY;
    should((await r.service.list()).sentence).equal(undefined);
  });

  it('should leave links alone when the identity cannot be read', async () => {
    const r = await linkRig();
    await mintPublic(r);
    r.items.identity = undefined;
    const list = await r.service.list().catch((error: unknown) => error);
    should(list instanceof CatalogLinkRefusal).equal(true);
    should(stored(r).state).equal('live');
  });

  it('should list one lapsed link and many in the words that fit', async () => {
    const r = await linkRig();
    await mintPublic(r);
    await mintPublic(r);
    r.client.statusAnswer = bundleIds => ({
      ok: true,
      value: { version: 1, links: bundleIds.map(bundleId => ({ bundleId, state: 'lapsed' as const })) },
    });
    should((await r.service.list()).sentence).containEql('2 links were dropped by the link store');
  });
});

describe('CatalogLinkService mint of a kept item', () => {
  it('should say a link made for an item already kept did not create it', async () => {
    const r = await linkRig();
    const first = await mintPublic(r);
    should(first.created).equal(true);
    const preview = await r.service.preview({ itemId: first.link.itemId, version: 1 });
    const second = await r.service.mint({
      item: { itemId: first.link.itemId, version: 1, digest: preview.digest },
      kind: 'public',
      expires: '7d',
    });
    should(second.created).equal(false);
  });

  it('should refuse, and keep nothing, when the version is retired as the link is written down', async () => {
    const r = await linkRig();
    const first = await mintPublic(r);
    const preview = await r.service.preview({ itemId: first.link.itemId, version: 1 });
    r.items.service.holdsLinkVersion = async () => false;
    const before = r.client.uploads.length;
    const out = await refusal(() =>
      r.service.mint({
        item: { itemId: first.link.itemId, version: 1, digest: preview.digest },
        kind: 'public',
        expires: '7d',
      }),
    );
    should(out.refusal).equal('version_retired');
    should(r.client.uploads.length).equal(before);
    should(r.documents.document.links.length).equal(1);
  });
});
