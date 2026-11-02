import { describe, expect, it } from 'bun:test';
import {
  CATALOG_LINK_BUNDLE_FORMAT,
  CATALOG_LINK_FORMAT,
  CATALOG_LINK_SIGNATURE_LABEL,
  catalogLinkSignedBytes,
  CatalogLinkIdSchema,
  CatalogLinkKindSchema,
  LINK_ITEM_CATALOG_ID,
  LINK_MAX_LEASE_MS,
  LINK_ONE_TIME_MAX_MS,
  LinkBundleIdSchema,
  LinkKeySchema,
  SharedCatalogLinkBundleSchema,
  SharedCatalogLinkSchema,
  SignedCatalogLinkSchema,
} from '../../src/lib/shared-catalog-link.ts';

const PUBLISHER = `fy_daemon_${'P'.repeat(43)}`;
const ISSUED = '2026-10-31T09:00:00.000Z';
const at = (offsetMs: number) => new Date(Date.parse(ISSUED) + offsetMs).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DIGEST = `sha256:${'0'.repeat(64)}`;

const entry = (changes: Record<string, unknown> = {}) => ({
  itemId: `itm_${'s'.repeat(22)}`,
  kind: 'skill',
  name: 'pdf-tools',
  summary: 'Split, merge and OCR PDFs',
  version: 2,
  digest: DIGEST,
  size: 1234,
  publishedAt: ISSUED,
  ...changes,
});

const publicLink = (changes: Record<string, unknown> = {}) => ({
  format: CATALOG_LINK_FORMAT,
  version: 1,
  publisher: PUBLISHER,
  publisherName: 'Alice laptop',
  linkId: `lnk_${'l'.repeat(22)}`,
  bundleId: 'b'.repeat(22),
  kind: 'public',
  sequence: 1,
  issuedAt: ISSUED,
  notAfter: at(7 * DAY),
  item: entry(),
  ...changes,
});

const oneTime = (changes: Record<string, unknown> = {}) =>
  publicLink({ kind: 'one-time', notAfter: at(HOUR), expiresAt: at(HOUR), ...changes });

const skillItem = {
  format: 'ferretry-catalog-item',
  version: 1,
  publisher: PUBLISHER,
  catalogId: LINK_ITEM_CATALOG_ID,
  itemId: `itm_${'s'.repeat(22)}`,
  itemVersion: 2,
  name: 'pdf-tools',
  summary: 'Split, merge and OCR PDFs',
  kind: 'skill',
  skill: { files: [{ path: 'SKILL.md', content: '# pdf\n' }] },
};

const signed = (link: unknown = publicLink()) => ({ link, spki: 'A'.repeat(59), sig: 'B'.repeat(86) });

describe('ids and constants', () => {
  it('should name the formats, the label and the placeholder catalog', () => {
    expect(CATALOG_LINK_FORMAT).toBe('ferretry-catalog-link');
    expect(CATALOG_LINK_BUNDLE_FORMAT).toBe('ferretry-catalog-link-bundle');
    expect(CATALOG_LINK_SIGNATURE_LABEL).toBe('ferretry-catalog-link-v1');
    expect(LINK_ITEM_CATALOG_ID as string).toBe(`cat_${'A'.repeat(22)}`);
    expect(LINK_MAX_LEASE_MS).toBe(30 * DAY);
    expect(LINK_ONE_TIME_MAX_MS).toBe(DAY);
  });

  it('should accept the link id, bundle id and key shapes and refuse their neighbours', () => {
    expect(CatalogLinkIdSchema.safeParse(`lnk_${'a'.repeat(22)}`).success).toBe(true);
    expect(CatalogLinkIdSchema.safeParse(`lnk_${'a'.repeat(21)}`).success).toBe(false);
    expect(CatalogLinkIdSchema.safeParse(`lnk_${'a'.repeat(23)}`).success).toBe(false);
    expect(CatalogLinkIdSchema.safeParse(`cat_${'a'.repeat(22)}`).success).toBe(false);
    expect(LinkBundleIdSchema.safeParse('a-_'.repeat(7) + 'a').success).toBe(true);
    expect(LinkBundleIdSchema.safeParse('a'.repeat(21)).success).toBe(false);
    expect(LinkBundleIdSchema.safeParse('a'.repeat(21) + '=').success).toBe(false);
    expect(LinkKeySchema.safeParse('k'.repeat(43)).success).toBe(true);
    expect(LinkKeySchema.safeParse('k'.repeat(44)).success).toBe(false);
    expect(LinkKeySchema.safeParse('k'.repeat(42) + '+').success).toBe(false);
  });

  it('should have two kinds', () => {
    expect(CatalogLinkKindSchema.options).toEqual(['one-time', 'public']);
  });
});

describe('the signed link document', () => {
  it('should accept a public link with and without an end', () => {
    expect(SharedCatalogLinkSchema.safeParse(publicLink()).success).toBe(true);
    expect(SharedCatalogLinkSchema.safeParse(publicLink({ expiresAt: at(7 * DAY) })).success).toBe(true);
    expect(
      SharedCatalogLinkSchema.safeParse(publicLink({ expiresAt: at(90 * DAY), notAfter: at(30 * DAY) })).success,
    ).toBe(true);
    expect(SharedCatalogLinkSchema.safeParse(publicLink({ sequence: 9 })).success).toBe(true);
  });

  it('should accept an MCP item and a harness on a link item', () => {
    expect(SharedCatalogLinkSchema.safeParse(publicLink({ item: entry({ kind: 'mcp' }) })).success).toBe(true);
  });

  it('should refuse an artifact item', () => {
    const result = SharedCatalogLinkSchema.safeParse(publicLink({ item: entry({ kind: 'artifact' }) }));
    expect(result.success).toBe(false);
  });

  it('should refuse a lease that is not after issue or is longer than 30 days', () => {
    for (const notAfter of [ISSUED, at(-1), at(30 * DAY + 1)])
      expect(SharedCatalogLinkSchema.safeParse(publicLink({ notAfter })).success).toBe(false);
    expect(SharedCatalogLinkSchema.safeParse(publicLink({ notAfter: at(30 * DAY) })).success).toBe(true);
    expect(SharedCatalogLinkSchema.safeParse(publicLink({ notAfter: at(1) })).success).toBe(true);
  });

  it('should refuse a lease that outlasts the end the owner chose', () => {
    expect(SharedCatalogLinkSchema.safeParse(publicLink({ expiresAt: at(DAY), notAfter: at(DAY + 1) })).success).toBe(
      false,
    );
    expect(SharedCatalogLinkSchema.safeParse(publicLink({ expiresAt: at(DAY), notAfter: at(DAY) })).success).toBe(true);
  });

  it('should accept a one-time link of one sequence that ends within a day', () => {
    expect(SharedCatalogLinkSchema.safeParse(oneTime()).success).toBe(true);
    expect(SharedCatalogLinkSchema.safeParse(oneTime({ expiresAt: at(DAY), notAfter: at(DAY) })).success).toBe(true);
  });

  it('should refuse a one-time link uploaded twice, endless, or ending past a day', () => {
    expect(SharedCatalogLinkSchema.safeParse(oneTime({ sequence: 2 })).success).toBe(false);
    expect(SharedCatalogLinkSchema.safeParse({ ...oneTime(), expiresAt: undefined }).success).toBe(false);
    const endless: Record<string, unknown> = oneTime();
    delete endless.expiresAt;
    expect(SharedCatalogLinkSchema.safeParse(endless).success).toBe(false);
    expect(SharedCatalogLinkSchema.safeParse(oneTime({ expiresAt: at(DAY + 1), notAfter: at(HOUR) })).success).toBe(
      false,
    );
  });

  it('should refuse every unknown or malformed field', () => {
    const cases: Record<string, unknown>[] = [
      { format: 'ferretry-catalog' },
      { version: 2 },
      { publisher: 'nobody' },
      { publisherName: '' },
      { linkId: 'lnk_short' },
      { bundleId: 'short' },
      { kind: 'private' },
      { sequence: 0 },
      { sequence: 1.5 },
      { issuedAt: 'yesterday' },
      { notAfter: 'later' },
      { expiresAt: 'never' },
      { extra: true },
      { item: entry({ extra: 1 }) },
    ];
    for (const changes of cases) expect(SharedCatalogLinkSchema.safeParse(publicLink(changes)).success).toBe(false);
  });
});

describe('the signed wrapper and the bundle', () => {
  it('should accept a signed link and refuse a wrong spki, signature or extra field', () => {
    expect(SignedCatalogLinkSchema.safeParse(signed()).success).toBe(true);
    expect(SignedCatalogLinkSchema.safeParse({ ...signed(), spki: 'A' }).success).toBe(false);
    expect(SignedCatalogLinkSchema.safeParse({ ...signed(), sig: 'B' }).success).toBe(false);
    expect(SignedCatalogLinkSchema.safeParse({ ...signed(), extra: 1 }).success).toBe(false);
    expect(SignedCatalogLinkSchema.safeParse(signed(publicLink({ kind: 'x' }))).success).toBe(false);
  });

  it('should accept a bundle of one item and refuse anything else', () => {
    const bundle = { format: CATALOG_LINK_BUNDLE_FORMAT, version: 1, signedLink: signed(), item: skillItem };
    expect(SharedCatalogLinkBundleSchema.safeParse(bundle).success).toBe(true);
    expect(SharedCatalogLinkBundleSchema.safeParse({ ...bundle, format: 'x' }).success).toBe(false);
    expect(SharedCatalogLinkBundleSchema.safeParse({ ...bundle, version: 2 }).success).toBe(false);
    expect(SharedCatalogLinkBundleSchema.safeParse({ ...bundle, items: [skillItem] }).success).toBe(false);
    expect(SharedCatalogLinkBundleSchema.safeParse({ ...bundle, item: { ...skillItem, kind: 'x' } }).success).toBe(
      false,
    );
    expect(SharedCatalogLinkBundleSchema.safeParse({ ...bundle, extra: 1 }).success).toBe(false);
  });
});

describe('the bytes a signature covers', () => {
  it('should be the label, one zero byte and the digest', () => {
    const digest = new Uint8Array(32).map((_, index) => index);
    const bytes = catalogLinkSignedBytes(digest);
    const label = new TextEncoder().encode(CATALOG_LINK_SIGNATURE_LABEL);
    expect(bytes.length).toBe(label.length + 1 + 32);
    expect([...bytes.slice(0, label.length)]).toEqual([...label]);
    expect(bytes[label.length]).toBe(0);
    expect([...bytes.slice(label.length + 1)]).toEqual([...digest]);
  });
});
