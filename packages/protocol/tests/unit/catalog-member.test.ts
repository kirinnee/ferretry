import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import * as member from '../../src/lib/catalog-member.ts';
import {
  CATALOG_SHARE_EXPIRIES,
  CATALOG_SHARE_EXPIRY_SECONDS,
  CatalogShareCodeSchema,
  CatalogShareMintRequestSchema,
  CatalogShareMintResponseSchema,
  CatalogShareViewSchema,
  formatShareFragment,
  MEMBER_PASSKEY_NAME_MAX_BYTES,
  MemberJoinedResponseSchema,
  memberPasskeyName,
  parseShareFragment,
  SHARE_FRAGMENT_PATTERN,
  SHARE_LINK_RELAYED_NOTICE,
  shareLinkNotice,
  shareLinkUrl,
} from '../../src/lib/catalog-member.ts';
import { formatPairingFragment, PairingCodeSchema, parsePairingFragment } from '../../src/lib/pairing.ts';

const DAEMON = `fy_daemon_${'D'.repeat(43)}`;
const CATALOG = `cat_${'c'.repeat(22)}`;
const OTHER_CATALOG = `cat_${'o'.repeat(22)}`;
const MEMBER = `mbr_${'m'.repeat(22)}`;
const KEY = `mk_${'k'.repeat(22)}`;
const SHARE = `shr_${'s'.repeat(22)}`;
const CODE = CatalogShareCodeSchema.parse(`fy_share_${'Q'.repeat(22)}`);
const AT = '2026-10-31T09:00:00.000Z';
const URL_ = 'https://192.168.1.20:7300';

const view = {
  shareId: SHARE,
  memberId: MEMBER,
  memberLabel: 'Alice',
  catalogIds: [CATALOG],
  createdAt: AT,
  expiresAt: AT,
  uses: { kind: 'single' },
  state: 'live',
  usedBy: [],
} as const;

describe('share codes', () => {
  it('are 128 random bits behind a recognisable prefix', () => {
    expect(CatalogShareCodeSchema.safeParse(`fy_share_${'a'.repeat(22)}`).success).toBe(true);
    for (const code of [
      `fy_share_${'a'.repeat(21)}`,
      `fy_share_${'a'.repeat(23)}`,
      'a'.repeat(22),
      `fy_share_${'a'.repeat(21)}=`,
    ]) {
      expect(CatalogShareCodeSchema.safeParse(code).success).toBe(false);
    }
  });

  it('can never be read as a pairing code, nor a pairing code as a share code', () => {
    expect(PairingCodeSchema.safeParse(CODE).success).toBe(false);
    expect(CatalogShareCodeSchema.safeParse('ABCD-EFGH').success).toBe(false);
  });
});

describe('minting a share', () => {
  const request = {
    catalogIds: [CATALOG],
    member: { kind: 'new', label: 'Alice' },
    expiresIn: '1h',
    uses: { kind: 'single' },
  } as const;

  it('takes the five expiries the owner chose, and nothing else', () => {
    expect([...CATALOG_SHARE_EXPIRIES]).toEqual(['15m', '1h', '3h', '8h', '1d']);
    expect(CATALOG_SHARE_EXPIRY_SECONDS['1d']).toBe(86_400);
    for (const expiresIn of CATALOG_SHARE_EXPIRIES) {
      expect(CatalogShareMintRequestSchema.safeParse({ ...request, expiresIn }).success).toBe(true);
    }
    for (const expiresIn of ['2d', '30m', '1w', '']) {
      expect(CatalogShareMintRequestSchema.safeParse({ ...request, expiresIn }).success).toBe(false);
    }
  });

  it('makes a many-person code its own member, and refuses one for an existing member', () => {
    const multi = { ...request, uses: { kind: 'multi', cap: 50 } };
    expect(CatalogShareMintRequestSchema.safeParse(multi).success).toBe(true);
    expect(
      CatalogShareMintRequestSchema.safeParse({ ...multi, member: { kind: 'existing', memberId: MEMBER } }).success,
    ).toBe(false);
    expect(
      CatalogShareMintRequestSchema.safeParse({ ...request, member: { kind: 'existing', memberId: MEMBER } }).success,
    ).toBe(true);
  });

  it('bounds the cap, and names each catalog once', () => {
    for (const cap of [1, 501, 2.5]) {
      expect(CatalogShareMintRequestSchema.safeParse({ ...request, uses: { kind: 'multi', cap } }).success).toBe(false);
    }
    expect(CatalogShareMintRequestSchema.safeParse({ ...request, catalogIds: [CATALOG, CATALOG] }).success).toBe(false);
    expect(CatalogShareMintRequestSchema.safeParse({ ...request, catalogIds: [] }).success).toBe(false);
    expect(CatalogShareMintRequestSchema.safeParse({ ...request, catalogIds: [CATALOG, OTHER_CATALOG] }).success).toBe(
      true,
    );
  });

  it('answers the code once, beside a share view that has no field for it', () => {
    const link = shareLinkUrl('https://ferretry.pages.dev', { daemonUrl: URL_, daemonId: DAEMON, code: CODE });
    expect(CatalogShareMintResponseSchema.safeParse({ share: view, code: CODE, link }).success).toBe(true);
    expect(CatalogShareViewSchema.safeParse({ ...view, code: CODE }).success).toBe(false);
    expect(
      CatalogShareMintResponseSchema.safeParse({ share: view, code: CODE, link: 'javascript:alert(1)' }).success,
    ).toBe(false);
  });
});

describe('the share link', () => {
  const seed = { daemonUrl: URL_, daemonId: DAEMON, code: CODE } as const;

  it('round-trips through the fragment, on the /join page', () => {
    const link = shareLinkUrl('https://ferretry.pages.dev', seed);
    expect(link.startsWith('https://ferretry.pages.dev/join#v1;')).toBe(true);
    const fragment = new URL(link).hash;
    expect(SHARE_FRAGMENT_PATTERN.test(fragment)).toBe(true);
    expect(parseShareFragment(fragment)).toEqual(seed);
    expect(parseShareFragment(formatShareFragment(seed))).toEqual(seed);
  });

  it('keeps the code out of the path and the query', () => {
    const url = new URL(shareLinkUrl('https://ferretry.pages.dev', seed));
    expect(url.pathname + url.search).not.toContain(CODE);
    expect(url.hash).toContain(CODE);
  });

  it('ignores a field it does not know, and refuses a repeated one', () => {
    expect(parseShareFragment(`${formatShareFragment(seed)};relay=wss%3A%2F%2Fevil.example`)).toEqual(seed);
    expect(() => parseShareFragment(`${formatShareFragment(seed)};fp=${DAEMON}`)).toThrow('repeats fp');
  });

  it('says why a fragment is not a share link', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['v2;url=x', 'version'],
      ['v1;url', 'name=value'],
      [`v1;url=${encodeURIComponent(URL_)};fp=${DAEMON}`, 'must include'],
      [`v1;url=not-a-url;fp=${DAEMON};share=${CODE}`, 'not an http or https URL'],
      [`v1;url=${encodeURIComponent(URL_)};fp=fy_daemon_short;share=${CODE}`, 'fingerprint'],
      [`v1;url=${encodeURIComponent(URL_)};fp=${DAEMON};share=ABCD-EFGH`, 'invalid code'],
      [`v1;url=%E0%A4%A;fp=${DAEMON};share=${CODE}`, 'not decodable'],
    ];
    for (const [fragment, reason] of cases) expect(() => parseShareFragment(fragment)).toThrow(reason);
  });

  it('is refused by the pairing reader, and a pairing link by the share reader', () => {
    expect(() => parsePairingFragment(formatShareFragment(seed))).toThrow();
    const pairing = formatPairingFragment({
      daemonUrl: URL_,
      daemonId: DAEMON,
      code: PairingCodeSchema.parse('ABCD-EFGH'),
    });
    expect(() => parseShareFragment(pairing)).toThrow('this is a pairing link');
  });

  it('refuses a link that carries both a pairing code and a share code, in both readers', () => {
    const both = `${formatShareFragment(seed)};code=ABCD-EFGH`;
    expect(() => parseShareFragment(both)).toThrow('this is a pairing link');
    expect(() => parsePairingFragment(both)).toThrow('this is a share link');
  });

  it('dials only an http or https publisher address', () => {
    for (const address of ['javascript:alert(1)', 'file:///etc/passwd', 'wss://relay.example']) {
      const fragment = `v1;url=${encodeURIComponent(address)};fp=${DAEMON};share=${CODE}`;
      expect(() => parseShareFragment(fragment)).toThrow('not an http or https URL');
    }
    const pairing = `v1;url=${encodeURIComponent('javascript:alert(1)')};code=ABCD-EFGH;fp=${DAEMON}`;
    expect(() => parsePairingFragment(pairing)).toThrow('not an http or https URL');
  });

  it('gates on a share field, so a surface routes by path first', () => {
    expect(SHARE_FRAGMENT_PATTERN.test(`#${formatShareFragment(seed)}`)).toBe(true);
    expect(SHARE_FRAGMENT_PATTERN.test(`#v1;url=x;code=ABCD-EFGH;fp=${DAEMON}`)).toBe(false);
    expect(SHARE_FRAGMENT_PATTERN.test('#v2;share=x')).toBe(false);
  });
});

describe('what the owner is told beside a share link', () => {
  const APP = 'https://ferretry.pages.dev';

  it('discloses the relay beside a link whose address is this computer itself', () => {
    for (const daemonUrl of ['http://127.0.0.1:7077', 'http://localhost:7077', 'http://[::1]:7077']) {
      expect(shareLinkNotice(shareLinkUrl(APP, { daemonUrl, daemonId: DAEMON, code: CODE }))).toBe(
        SHARE_LINK_RELAYED_NOTICE,
      );
    }
    expect(SHARE_LINK_RELAYED_NOTICE).toContain('never the code');
  });

  it('says nothing beside a direct link, or beside anything that is not a share link', () => {
    expect(shareLinkNotice(shareLinkUrl(APP, { daemonUrl: URL_, daemonId: DAEMON, code: CODE }))).toBeUndefined();
    expect(shareLinkNotice('not a link')).toBeUndefined();
    expect(shareLinkNotice(`${APP}/join#v2;share=x`)).toBeUndefined();
  });
});

describe('the member passkey name', () => {
  const bytes = (text: string) => new TextEncoder().encode(text).length;

  it('names the member, the catalog and the publisher', () => {
    expect(memberPasskeyName('Alice', ["Kirin's skills"], 'kirin-box')).toBe("Alice · Kirin's skills · kirin-box");
    expect(memberPasskeyName('Alice', ['a', 'b', 'c'], 'kirin-box')).toBe('Alice · 3 catalogs · kirin-box');
  });

  it('fits 64 BYTES, cutting at a character and keeping the publisher longest', () => {
    const ascii = memberPasskeyName('A'.repeat(40), ['B'.repeat(40)], 'C'.repeat(40));
    expect(bytes(ascii)).toBeLessThanOrEqual(MEMBER_PASSKEY_NAME_MAX_BYTES);
    expect(ascii).toBe(`${'A'.repeat(11)}… · ${'B'.repeat(15)}… · ${'C'.repeat(21)}…`);
    // Three bytes a character: still within 64 bytes, and never half a character.
    const wide = memberPasskeyName('€'.repeat(30), ['€'.repeat(30)], '€'.repeat(30));
    expect(bytes(wide)).toBeLessThanOrEqual(MEMBER_PASSKEY_NAME_MAX_BYTES);
    expect(wide.split(' · ').every(part => part.endsWith('…'))).toBe(true);
    // A short member name leaves its room to the publisher.
    const short = memberPasskeyName('Al', ['x'.repeat(40)], 'p'.repeat(60));
    expect(bytes(short)).toBeLessThanOrEqual(MEMBER_PASSKEY_NAME_MAX_BYTES);
    expect(short.split(' · ')[2]?.length).toBeGreaterThan(21);
  });
});

describe('the joined response', () => {
  it('carries no key, proof or fingerprint, and defaults the carriers for an older publisher', () => {
    const response = MemberJoinedResponseSchema.parse({
      memberId: MEMBER,
      keyId: KEY,
      label: 'Alice',
      daemonId: DAEMON,
      daemonName: 'kirin-box',
      catalogCount: 1,
      passkeyWindowEndsAt: AT,
      memberUnlockDays: 30,
    });
    expect(response.carriers).toEqual([]);
    expect(MemberJoinedResponseSchema.safeParse({ ...response, memberUnlockDays: 91 }).success).toBe(false);
    expect(MemberJoinedResponseSchema.safeParse({ ...response, memberKey: 'x' }).success).toBe(false);
  });
});

describe('no member schema has a field for a code, a key or a proof — except the one mint answer', () => {
  /** Every property name a schema declares, at any depth (a closed enum holds no words of its own). */
  const fieldNames = (schema: z.ZodType): readonly string[] => {
    const names: string[] = [];
    const closed = (property: unknown): boolean =>
      typeof property === 'object' && property !== null && ('enum' in property || 'const' in property);
    const stack: unknown[] = [z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' })];
    while (stack.length > 0) {
      const node = stack.pop();
      if (typeof node !== 'object' || node === null) continue;
      const record = node as Record<string, unknown>;
      if (typeof record.properties === 'object' && record.properties !== null)
        names.push(
          ...Object.entries(record.properties as Record<string, unknown>)
            .filter(([, property]) => !closed(property))
            .map(([key]) => key),
        );
      stack.push(...Object.values(record));
    }
    return names;
  };

  it('holds for every exported schema', () => {
    const schemas = Object.entries(member).filter(
      ([name, value]) => name.endsWith('Schema') && value instanceof z.ZodType,
    );
    expect(schemas.length).toBeGreaterThan(15);
    // The mint answer hands the code to its owner once; a redeem spends one. Nothing else may hold one.
    const allowed = new Set(['CatalogShareMintResponseSchema.code', 'SharedRedeemRequestSchema.code']);
    const forbidden = /code|secret|token|password|private|proof|spki|memberkey|boxkey|digest|hash|credential/iu;
    const offenders = schemas.flatMap(([name, schema]) =>
      fieldNames(schema as z.ZodType)
        .filter(field => forbidden.test(field))
        .map(field => `${name}.${field}`)
        .filter(field => !allowed.has(field)),
    );
    expect(offenders).toEqual([]);
  });
});

describe('the owner’s member management answers', () => {
  it('takes a rename of a one-line label, and nothing else', () => {
    const { CatalogMemberRenameRequestSchema } = member;
    expect(CatalogMemberRenameRequestSchema.safeParse({ label: 'Samuel' }).success).toBe(true);
    expect(CatalogMemberRenameRequestSchema.safeParse({ label: 'x'.repeat(80) }).success).toBe(true);
    for (const bad of [
      {},
      { label: '' },
      { label: ' Samuel' },
      { label: 'Samuel ' },
      { label: 'x'.repeat(81) },
      { label: 'two\nlines' },
      { label: 7 },
      { label: 'Samuel', memberId: MEMBER },
    ]) {
      expect(CatalogMemberRenameRequestSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('says what a revoke removed, within the bounds the store holds', () => {
    const { CatalogMemberRevokedSchema, CATALOG_MAX_KEYS_PER_MEMBER, CATALOG_SHARES_LISTED_MAX } = member;
    const revoked = { memberId: MEMBER, keysRemoved: 2, sharesEnded: 1 };
    expect(CatalogMemberRevokedSchema.parse(revoked)).toEqual(revoked);
    expect(CatalogMemberRevokedSchema.safeParse({ ...revoked, keysRemoved: 0, sharesEnded: 0 }).success).toBe(true);
    expect(
      CatalogMemberRevokedSchema.safeParse({
        ...revoked,
        keysRemoved: CATALOG_MAX_KEYS_PER_MEMBER,
        sharesEnded: CATALOG_SHARES_LISTED_MAX,
      }).success,
    ).toBe(true);
    for (const bad of [
      { ...revoked, keysRemoved: -1 },
      { ...revoked, keysRemoved: CATALOG_MAX_KEYS_PER_MEMBER + 1 },
      { ...revoked, sharesEnded: -1 },
      { ...revoked, sharesEnded: CATALOG_SHARES_LISTED_MAX + 1 },
      { ...revoked, keysRemoved: 1.5 },
      { ...revoked, memberId: KEY },
      { memberId: MEMBER, keysRemoved: 1 },
      { ...revoked, label: 'Sam' },
    ]) {
      expect(CatalogMemberRevokedSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('names the one browser a remove took away', () => {
    const { CatalogMemberKeyRemovedSchema } = member;
    const removed = { memberId: MEMBER, keyId: KEY };
    expect(CatalogMemberKeyRemovedSchema.parse(removed)).toEqual(removed);
    for (const bad of [
      {},
      { memberId: MEMBER },
      { keyId: KEY },
      { memberId: KEY, keyId: KEY },
      { memberId: MEMBER, keyId: MEMBER },
      { memberId: MEMBER, keyId: `mk_${'k'.repeat(21)}` },
      { ...removed, remaining: 0 },
    ]) {
      expect(CatalogMemberKeyRemovedSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('names the one catalog a remove took away', () => {
    const { CatalogMemberCatalogRemovedSchema } = member;
    const removed = { memberId: MEMBER, catalogId: CATALOG };
    expect(CatalogMemberCatalogRemovedSchema.parse(removed)).toEqual(removed);
    for (const bad of [
      {},
      { memberId: MEMBER },
      { catalogId: CATALOG },
      { memberId: CATALOG, catalogId: CATALOG },
      { memberId: MEMBER, catalogId: MEMBER },
      { memberId: MEMBER, catalogId: `cat_${'c'.repeat(21)}` },
      { ...removed, name: 'Team tools' },
    ]) {
      expect(CatalogMemberCatalogRemovedSchema.safeParse(bad).success).toBe(false);
    }
  });
});
