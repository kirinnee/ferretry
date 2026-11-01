import {
  type CatalogMemberView,
  CatalogMemberViewSchema,
  type CatalogShareMintResponse,
  CatalogShareMintResponseSchema,
  type CatalogShareView,
  CatalogShareViewSchema,
} from '@ferretry/protocol';
import { CATALOG } from './catalog-views.ts';

export const MEMBER_A = `mbr_${'a'.repeat(22)}` as const;
export const MEMBER_B = `mbr_${'b'.repeat(22)}` as const;
export const KEY_A1 = `mk_${'1'.repeat(22)}` as const;
const KEY_A2 = `mk_${'2'.repeat(22)}` as const;
export const SHARE_1 = `shr_${'s'.repeat(22)}` as const;
export const SHARE_2 = `shr_${'t'.repeat(22)}` as const;
/** A made-up code. It is not a credential of anything. */
export const FAKE_CODE = 'fy_share_FAKEFAKEFAKEFAKEFAKEFA' as const;
export const FAKE_LINK = `https://app.example.test/join#v1;url=https%3A%2F%2Fbox.example.test;fp=fy_daemon_${'q'.repeat(43)};share=${FAKE_CODE}`;

export const T0 = '2026-10-31T09:00:00.000Z';
export const T0_MS = Date.parse(T0);

export function memberView(change: Record<string, unknown> = {}): CatalogMemberView {
  return CatalogMemberViewSchema.parse({
    memberId: MEMBER_A,
    label: 'Alice',
    catalogIds: [CATALOG],
    createdAt: T0,
    keys: [
      {
        keyId: KEY_A1,
        clientName: 'Firefox on a Mac',
        joinedAt: T0,
        lastSeenAt: '2026-10-31T07:00:00.000Z',
        passkeys: 1,
      },
      { keyId: KEY_A2, clientName: 'Chrome on a phone', joinedAt: '2026-10-30T09:00:00.000Z', passkeys: 0 },
    ],
    ...change,
  });
}

export function shareView(change: Record<string, unknown> = {}): CatalogShareView {
  return CatalogShareViewSchema.parse({
    shareId: SHARE_1,
    memberId: MEMBER_A,
    memberLabel: 'Alice',
    catalogIds: [CATALOG],
    createdAt: T0,
    expiresAt: '2026-10-31T10:00:00.000Z',
    uses: { kind: 'single' },
    state: 'live',
    usedBy: [],
    ...change,
  });
}

export function mintResponse(change: Record<string, unknown> = {}): CatalogShareMintResponse {
  return CatalogShareMintResponseSchema.parse({ share: shareView(), code: FAKE_CODE, link: FAKE_LINK, ...change });
}
