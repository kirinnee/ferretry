import { describe, it } from 'bun:test';
import should from 'should';
import {
  CATALOG_PREVIEW_MAX_KEPT,
  CatalogPreviews,
  type HeldPreview,
} from '../../../src/lib/catalog-installs/previews.ts';
import { skillItem } from '../../support/catalog-fixtures.ts';

/** Previews waiting for a yes: bounded by age and by count, spent by one apply. Time is a number the case moves. */

const TTL = 600_000;
const DAEMON = `fy_daemon_${'A'.repeat(43)}`;

const idOf = (n: number) => `cip_${String(n).padStart(22, '0')}` as HeldPreview['previewId'];

function held(n: number, createdAt = 1_000): HeldPreview {
  const item = skillItem(DAEMON);
  return {
    previewId: idOf(n),
    createdAt,
    expiresAt: createdAt + TTL,
    item,
    provenance: {
      publisher: DAEMON,
      publisherName: 'kirin-box',
      catalogId: item.catalogId,
      catalogName: "Kirin's catalog",
      itemId: item.itemId,
      kind: 'skill',
      name: item.name,
      version: 1,
      digest: `sha256:${'a'.repeat(64)}`,
    },
    revision: 1,
    target: { scope: 'project', projectRoot: '/srv/app', harness: 'claude' },
    allowOlder: false,
    placeholders: [],
  };
}

describe('previews waiting for a yes', () => {
  it('keeps sixteen by default', () => {
    should(CATALOG_PREVIEW_MAX_KEPT).equal(16);
  });

  it('finds a preview it holds, with the item that was reviewed', () => {
    const previews = new CatalogPreviews(TTL);
    previews.put(held(1), 1_000);

    const lookup = previews.get(idOf(1), 2_000);

    should(lookup.kind).equal('found');
    if (lookup.kind === 'found') should(lookup.preview.item.name).equal('pdf-tools');
    should(previews.size).equal(1);
  });

  it('does not know an id it never held', () => {
    should(new CatalogPreviews(TTL).get(idOf(9), 0)).deepEqual({ kind: 'unknown' });
  });

  it('is found one tick before the expiry and expired at the expiry', () => {
    const previews = new CatalogPreviews(TTL);
    previews.put(held(1), 1_000);

    should(previews.get(idOf(1), 1_000 + TTL - 1).kind).equal('found');
    should(previews.get(idOf(1), 1_000 + TTL)).deepEqual({ kind: 'expired' });
  });

  it('is spent by one consume, so the same yes cannot apply twice', () => {
    const previews = new CatalogPreviews(TTL);
    previews.put(held(1), 1_000);

    previews.consume(idOf(1));

    should(previews.get(idOf(1), 1_001)).deepEqual({ kind: 'unknown' });
    should(previews.size).equal(0);
    should(() => previews.consume(idOf(1))).not.throw();
  });

  it('drops the oldest when a new one goes over the bound', () => {
    const previews = new CatalogPreviews(TTL, 2);
    previews.put(held(1), 1_000);
    previews.put(held(2), 1_000);
    previews.put(held(3), 1_000);

    should(previews.size).equal(2);
    should(previews.get(idOf(1), 1_001).kind).equal('unknown');
    should(previews.get(idOf(2), 1_001).kind).equal('found');
    should(previews.get(idOf(3), 1_001).kind).equal('found');
  });

  it('forgets one only after it has been expired for a whole lifetime, so a late apply still reads "expired"', () => {
    const previews = new CatalogPreviews(TTL);
    previews.put(held(1), 1_000);

    previews.put(held(2, 2_000), 1_000 + TTL + TTL);
    should(previews.get(idOf(1), 1_000 + TTL + TTL).kind).equal('expired');

    previews.put(held(3, 3_000), 1_000 + TTL + TTL + TTL + 1);
    should(previews.get(idOf(1), 1_000 + TTL + TTL + TTL + 1).kind).equal('unknown');
  });
});
