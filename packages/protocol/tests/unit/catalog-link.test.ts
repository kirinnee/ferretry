import { describe, expect, it } from 'bun:test';
import {
  CATALOG_LINK_EXPIRIES,
  CATALOG_LINK_EXPIRY_MS,
  CATALOG_LINK_INSTALL_CAP_MAX,
  CATALOG_LINK_REFUSALS,
  CATALOG_LINK_STATES,
  CATALOG_LINKS_MAX_LIVE,
  CATALOG_LINKS_PATH,
  catalogLinkUrl,
  CatalogLinkPreviewRequestSchema,
  CatalogLinkPreviewSchema,
  CatalogLinkRefusalSchema,
  CatalogLinkStoreStatusSchema,
  CatalogLinkUrlSchema,
  CreateCatalogLinkRequestSchema,
  CreatedCatalogLinkSchema,
  formatLinkFragment,
  GET_LINK_PATH,
  LINK_FRAGMENT_PATTERN,
  LINK_TOO_BIG_SENTENCE,
  linkStoreOriginProblem,
  MoveCatalogLinkRequestSchema,
  ONE_TIME_LINK_DEFAULT_EXPIRY,
  ONE_TIME_LINK_EXPIRIES,
  ONE_TIME_LINK_NOTICE,
  OwnedCatalogLinkListSchema,
  OwnedCatalogLinkSchema,
  parseLinkFragment,
  PUBLIC_LINK_DEFAULT_EXPIRY,
  PUBLIC_LINK_EXPIRIES,
  PUBLIC_LINK_NOTICE,
  UpdateCatalogLinkRequestSchema,
} from '../../src/lib/catalog-link.ts';
import { parseShareFragment } from '../../src/lib/catalog-member.ts';
import { PAIRING_FRAGMENT_PATTERN, parsePairingFragment } from '../../src/lib/pairing.ts';
import { StepUpActSchema, STEP_UP_ACTS } from '../../src/lib/step-up.ts';

const PUBLISHER = `fy_daemon_${'P'.repeat(43)}`;
const SEED = { bundleId: 'b'.repeat(22), key: 'k'.repeat(43), publisher: PUBLISHER };
const FRAGMENT = `v1;b=${'b'.repeat(22)};k=${'k'.repeat(43)};fp=${PUBLISHER}`;
const ITEM = `itm_${'s'.repeat(22)}`;
const LINK = `lnk_${'l'.repeat(22)}`;
const DIGEST = `sha256:${'0'.repeat(64)}`;
const AT = '2026-10-31T09:00:00.000Z';

describe('the link fragment', () => {
  it('should write and read the one form', () => {
    expect(formatLinkFragment(SEED)).toBe(FRAGMENT);
    expect(parseLinkFragment(FRAGMENT)).toEqual(SEED);
    expect(parseLinkFragment(`#${FRAGMENT}`)).toEqual(SEED);
  });

  it('should carry a self-hosted store, and only an https origin', () => {
    const storeOrigin = 'https://links.example.com';
    const text = formatLinkFragment({ ...SEED, storeOrigin });
    expect(text).toBe(`${FRAGMENT};s=${encodeURIComponent(storeOrigin)}`);
    expect(parseLinkFragment(text)).toEqual({ ...SEED, storeOrigin });
    for (const bad of [
      'http://links.example.com',
      'https://links.example.com/x',
      'https://u:p@links.example.com',
      'nope',
    ])
      expect(() => formatLinkFragment({ ...SEED, storeOrigin: bad })).toThrow();
    expect(() => parseLinkFragment(`${FRAGMENT};s=${encodeURIComponent('http://links.example.com')}`)).toThrow(
      'download link: the link store address is not an https address',
    );
  });

  it('should refuse to write a malformed seed', () => {
    expect(() => formatLinkFragment({ ...SEED, bundleId: 'short' })).toThrow();
    expect(() => formatLinkFragment({ ...SEED, key: 'short' })).toThrow();
    expect(() => formatLinkFragment({ ...SEED, publisher: 'nobody' })).toThrow();
  });

  it('should say why a store address cannot be used', () => {
    expect(linkStoreOriginProblem('https://links.example.com')).toBeNull();
    expect(linkStoreOriginProblem('not a url')).toBe('the link store address is not an address');
    expect(linkStoreOriginProblem('http://links.example.com')).toBe('the link store address is not an https address');
    expect(linkStoreOriginProblem('https://a:b@links.example.com')).toBe(
      'the link store address carries a user name or password',
    );
    expect(linkStoreOriginProblem('https://links.example.com/path')).toBe('the link store address is more than a host');
  });

  it('should build the /get URL with the fragment and nothing in the path or query', () => {
    const url = catalogLinkUrl('https://app.example.com', SEED);
    expect(url).toBe(`https://app.example.com/get#${FRAGMENT}`);
    const parsed = new URL(url);
    expect(parsed.pathname).toBe(GET_LINK_PATH);
    expect(parsed.search).toBe('');
    expect(parsed.pathname + parsed.search).not.toContain('k'.repeat(43));
  });

  it('should refuse a fragment that is also a pairing or share link, or names a machine', () => {
    expect(() => parseLinkFragment(`${FRAGMENT};code=ABCD`)).toThrow('this is a pairing link');
    expect(() => parseLinkFragment(`${FRAGMENT};share=ABCD`)).toThrow('this is a share link');
    expect(() => parseLinkFragment(`${FRAGMENT};url=${encodeURIComponent('https://evil.example')}`)).toThrow(
      'names no machine address',
    );
  });

  it('should refuse a missing, repeated, malformed or unreadable field', () => {
    expect(() => parseLinkFragment(`v1;k=${'k'.repeat(43)};fp=${PUBLISHER}`)).toThrow('must include b, k and fp');
    expect(() => parseLinkFragment(`v1;b=${'b'.repeat(22)};fp=${PUBLISHER}`)).toThrow('must include b, k and fp');
    expect(() => parseLinkFragment(`v1;b=${'b'.repeat(22)};k=${'k'.repeat(43)}`)).toThrow('must include b, k and fp');
    expect(() => parseLinkFragment(FRAGMENT.replace(`b=${'b'.repeat(22)}`, 'b=short'))).toThrow('invalid bundle id');
    expect(() => parseLinkFragment(FRAGMENT.replace(`k=${'k'.repeat(43)}`, 'k=short'))).toThrow('invalid key');
    expect(() => parseLinkFragment(FRAGMENT.replace(PUBLISHER, 'nobody'))).toThrow('invalid fingerprint');
    expect(() => parseLinkFragment(`${FRAGMENT};k=x`)).toThrow('repeats k');
    expect(() => parseLinkFragment(`v2;b=x`)).toThrow('version is not recognised');
  });

  it('should be refused by the pairing and share readers, both ways round', () => {
    expect(() => parsePairingFragment(FRAGMENT)).toThrow('this is a download link, not a pairing link');
    expect(() => parseShareFragment(FRAGMENT)).toThrow('this is a download link, not a share link');
    expect(() =>
      parsePairingFragment(`v1;url=https%3A%2F%2Fx.example;code=ABCD;fp=${PUBLISHER};k=${'k'.repeat(43)}`),
    ).toThrow('download link');
    expect(LINK_FRAGMENT_PATTERN.test(FRAGMENT)).toBe(true);
    expect(LINK_FRAGMENT_PATTERN.test(`#${FRAGMENT}`)).toBe(true);
    expect(LINK_FRAGMENT_PATTERN.test(`v1;url=x;code=y;fp=${PUBLISHER}`)).toBe(false);
    expect(PAIRING_FRAGMENT_PATTERN.test(FRAGMENT)).toBe(true);
  });
});

describe('sentences, expiries and limits', () => {
  it('should say what each kind of link means in plain words', () => {
    expect(PUBLIC_LINK_NOTICE).toBe('Anyone with this link can install it.');
    expect(ONE_TIME_LINK_NOTICE).toBe('This link works once. Opening it uses it up.');
    expect(LINK_TOO_BIG_SENTENCE).toContain('too large');
  });

  it('should keep one-time ends within a day and public ends at a day or more, with a default each', () => {
    expect(ONE_TIME_LINK_EXPIRIES).toEqual(['15m', '1h', '3h', '8h', '1d']);
    expect(PUBLIC_LINK_EXPIRIES).toEqual(['1d', '7d', '30d', 'never']);
    expect(ONE_TIME_LINK_DEFAULT_EXPIRY).toBe('1h');
    expect(PUBLIC_LINK_DEFAULT_EXPIRY).toBe('7d');
    for (const expiry of CATALOG_LINK_EXPIRIES) expect(CATALOG_LINK_EXPIRY_MS).toHaveProperty(expiry);
    expect(CATALOG_LINK_EXPIRY_MS.never).toBeNull();
    expect(CATALOG_LINK_EXPIRY_MS['15m']).toBe(15 * 60_000);
    expect(CATALOG_LINK_EXPIRY_MS['30d']).toBe(30 * 86_400_000);
    for (const expiry of ONE_TIME_LINK_EXPIRIES)
      expect(CATALOG_LINK_EXPIRY_MS[expiry] ?? Infinity).toBeLessThanOrEqual(86_400_000);
    expect(CATALOG_LINKS_MAX_LIVE).toBe(50);
    expect(CATALOG_LINKS_PATH).toBe('/v1/catalog-links');
  });

  it('should list every refusal once and parse each', () => {
    expect(new Set(CATALOG_LINK_REFUSALS).size).toBe(CATALOG_LINK_REFUSALS.length);
    for (const refusal of CATALOG_LINK_REFUSALS) expect(CatalogLinkRefusalSchema.parse(refusal)).toBe(refusal);
    expect(CatalogLinkRefusalSchema.safeParse('nope').success).toBe(false);
  });

  it('should name the six link states', () => {
    expect(CATALOG_LINK_STATES).toEqual(['pending', 'live', 'ending', 'used', 'expired', 'ended']);
  });
});

describe('the owner request schemas', () => {
  const kept = { itemId: ITEM, version: 1, digest: DIGEST };

  it('should accept a kept version or a source, with the end that fits the kind', () => {
    expect(CreateCatalogLinkRequestSchema.safeParse({ item: kept, kind: 'public', expires: '7d' }).success).toBe(true);
    expect(
      CreateCatalogLinkRequestSchema.safeParse({
        item: { source: { kind: 'skill', skill: 'pdf' }, digest: DIGEST, summary: 'PDF tools' },
        kind: 'one-time',
        expires: '15m',
      }).success,
    ).toBe(true);
    expect(
      CreateCatalogLinkRequestSchema.safeParse({ item: kept, kind: 'public', expires: 'never', installCap: 10 })
        .success,
    ).toBe(true);
    expect(
      CreateCatalogLinkRequestSchema.safeParse({
        item: kept,
        kind: 'public',
        expires: '1d',
        installCap: CATALOG_LINK_INSTALL_CAP_MAX,
      }).success,
    ).toBe(true);
  });

  it('should refuse an end that does not fit the kind, a cap on a one-time link or a bad cap', () => {
    const base = { item: kept, kind: 'public', expires: '7d' };
    const bad: Record<string, unknown>[] = [
      { ...base, expires: '1h' },
      { ...base, kind: 'one-time', expires: '7d' },
      { ...base, kind: 'one-time', expires: '1h', installCap: 1 },
      { ...base, installCap: 0 },
      { ...base, installCap: CATALOG_LINK_INSTALL_CAP_MAX + 1 },
      { ...base, installCap: 1.5 },
      { ...base, extra: 1 },
      { ...base, item: { ...kept, version: 0 } },
      { ...base, item: { source: { kind: 'skill', skill: 'x' } } },
      { ...base, expires: 'forever' },
    ];
    for (const body of bad) expect(CreateCatalogLinkRequestSchema.safeParse(body).success).toBe(false);
  });

  it('should preview a kept version or a source and nothing else', () => {
    expect(CatalogLinkPreviewRequestSchema.safeParse({ itemId: ITEM, version: 2 }).success).toBe(true);
    expect(CatalogLinkPreviewRequestSchema.safeParse({ source: { kind: 'mcp', mcp: 'github' } }).success).toBe(true);
    expect(CatalogLinkPreviewRequestSchema.safeParse({ itemId: ITEM }).success).toBe(false);
    expect(CatalogLinkPreviewRequestSchema.safeParse({ itemId: ITEM, version: 2, source: {} }).success).toBe(false);
  });

  it('should move a link from a version to a version by the preview digest', () => {
    expect(MoveCatalogLinkRequestSchema.safeParse({ version: 3, from: 2, digest: DIGEST }).success).toBe(true);
    expect(MoveCatalogLinkRequestSchema.safeParse({ version: 3, from: 2 }).success).toBe(false);
    expect(MoveCatalogLinkRequestSchema.safeParse({ version: 0, from: 2, digest: DIGEST }).success).toBe(false);
  });

  it('should change the end or the cap, say which, and let null remove a cap', () => {
    expect(UpdateCatalogLinkRequestSchema.safeParse({ expires: '30d' }).success).toBe(true);
    expect(UpdateCatalogLinkRequestSchema.safeParse({ installCap: 5 }).success).toBe(true);
    expect(UpdateCatalogLinkRequestSchema.safeParse({ installCap: null }).success).toBe(true);
    expect(UpdateCatalogLinkRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateCatalogLinkRequestSchema.safeParse({ expires: '1h' }).success).toBe(false);
    expect(UpdateCatalogLinkRequestSchema.safeParse({ installCap: 0 }).success).toBe(false);
  });
});

describe('the owner answer schemas', () => {
  const owned = {
    linkId: LINK,
    itemId: ITEM,
    name: 'pdf-tools',
    itemKind: 'skill',
    version: 2,
    kind: 'public',
    state: 'live',
    createdAt: AT,
    servedSince: AT,
    opens: 3,
  };

  it('should accept an owned link with and without its optional fields', () => {
    expect(OwnedCatalogLinkSchema.safeParse(owned).success).toBe(true);
    expect(
      OwnedCatalogLinkSchema.safeParse({
        ...owned,
        expiresAt: AT,
        installCap: 4,
        opensCheckedAt: AT,
        storeState: 'unreachable',
        endedAt: AT,
      }).success,
    ).toBe(true);
  });

  it('should carry no URL, key, bundle id or store address, and refuse them if added', () => {
    for (const name of ['url', 'key', 'bundleId', 'storeOrigin', 'k'])
      expect(OwnedCatalogLinkSchema.safeParse({ ...owned, [name]: 'x' }).success).toBe(false);
    expect(Object.keys(OwnedCatalogLinkSchema.shape)).not.toContain('url');
    expect(OwnedCatalogLinkSchema.safeParse({ ...owned, state: 'gone' }).success).toBe(false);
    expect(OwnedCatalogLinkSchema.safeParse({ ...owned, itemKind: 'artifact' }).success).toBe(false);
    expect(OwnedCatalogLinkSchema.safeParse({ ...owned, opens: -1 }).success).toBe(false);
  });

  it('should list the links with the maximum', () => {
    expect(OwnedCatalogLinkListSchema.safeParse({ publisher: PUBLISHER, links: [owned], max: 50 }).success).toBe(true);
    expect(OwnedCatalogLinkListSchema.safeParse({ publisher: PUBLISHER, links: [], max: 49 }).success).toBe(false);
  });

  it('should show a URL only in the created and copy answers', () => {
    expect(CreatedCatalogLinkSchema.safeParse({ link: owned, url: 'https://app.example.com/get#v1' }).success).toBe(
      true,
    );
    expect(CreatedCatalogLinkSchema.safeParse({ link: owned, url: '' }).success).toBe(false);
    expect(CatalogLinkUrlSchema.safeParse({ url: 'https://app.example.com/get#v1' }).success).toBe(true);
    expect(CatalogLinkUrlSchema.safeParse({ url: '' }).success).toBe(false);
  });

  it('should say whether the store can take a link', () => {
    expect(CatalogLinkStoreStatusSchema.safeParse({ available: true, sentence: 'Ready.' }).success).toBe(true);
    expect(
      CatalogLinkStoreStatusSchema.safeParse({
        available: false,
        origin: 'https://links.example.com',
        sentence: 'Down.',
      }).success,
    ).toBe(true);
    expect(CatalogLinkStoreStatusSchema.safeParse({ available: true }).success).toBe(false);
  });

  it('should preview a frozen review with its size and whether it is too big', () => {
    const preview = {
      newItem: false,
      name: 'pdf-tools',
      itemKind: 'skill',
      summary: 'PDF tools',
      review: [{ label: 'Skill file SKILL.md', text: '# pdf', document: true }],
      warnings: [{ code: 'unpinned-package', text: 'Changes without an update.' }],
      problems: [{ subject: 'big.bin', reason: 'left out' }],
      digest: DIGEST,
      envelopeBytes: 16_384,
      tooBig: false,
    };
    expect(CatalogLinkPreviewSchema.safeParse(preview).success).toBe(true);
    expect(
      CatalogLinkPreviewSchema.safeParse({ ...preview, itemId: ITEM, version: 1, location: '/home/a/skills/pdf' })
        .success,
    ).toBe(true);
    expect(CatalogLinkPreviewSchema.safeParse({ ...preview, envelopeBytes: -1 }).success).toBe(false);
    expect(CatalogLinkPreviewSchema.safeParse({ ...preview, tooBig: 'no' }).success).toBe(false);
  });
});

describe('the share-link passkey act', () => {
  it('should be its own act, apart from share-catalog', () => {
    expect(STEP_UP_ACTS.shareLink).toBe('share-link');
    expect(StepUpActSchema.safeParse('share-link').success).toBe(true);
    expect(STEP_UP_ACTS.shareLink).not.toBe(STEP_UP_ACTS.shareCatalog);
  });
});
