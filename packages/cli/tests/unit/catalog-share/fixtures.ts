import {
  type CatalogMemberCatalogRemoved,
  type CatalogMemberKeyRemoved,
  type CatalogMemberList,
  type CatalogMemberRevoked,
  type CatalogMemberView,
  type CatalogShareList,
  type CatalogShareMintRequest,
  type CatalogShareMintResponse,
  CatalogShareCodeSchema,
  DaemonIdSchema,
  type CatalogShareView,
  shareLinkUrl,
} from '@ferretry/protocol';
import type { ICatalogGateway } from '../../../src/lib/catalog/ports';
import type { ISharingGateway, IShareScreen } from '../../../src/lib/catalog-share/ports';
import { catalog, catalogList, CATALOG_ID, OTHER_CATALOG_ID } from '../catalog/fixtures';

export const MEMBER_ID = `mbr_${'m'.repeat(22)}`;
export const OTHER_MEMBER_ID = `mbr_${'n'.repeat(22)}`;
export const KEY_ID = `mk_${'k'.repeat(22)}`;
export const OTHER_KEY_ID = `mk_${'j'.repeat(22)}`;
export const SHARE_ID = `shr_${'s'.repeat(22)}`;
export const SHARE_CODE = CatalogShareCodeSchema.parse(`fy_share_${'Q'.repeat(22)}`);
const DAEMON_ID = `fy_daemon_${'a'.repeat(43)}`;
export const AT = '2026-10-31T09:00:00.000Z';
export const LATER = '2026-10-31T10:00:00.000Z';

export const LINK = shareLinkUrl('https://ferretry.pages.dev', {
  daemonUrl: 'https://box.tailnet-abc.ts.net',
  daemonId: DaemonIdSchema.parse(DAEMON_ID),
  code: SHARE_CODE,
});

export function shareView(overrides: Partial<CatalogShareView> = {}): CatalogShareView {
  return {
    shareId: SHARE_ID,
    memberId: MEMBER_ID,
    memberLabel: 'Sam',
    catalogIds: [CATALOG_ID],
    createdAt: AT,
    expiresAt: LATER,
    uses: { kind: 'single' },
    state: 'live',
    usedBy: [],
    ...overrides,
  };
}

export function mintResponse(overrides: Partial<CatalogShareView> = {}): CatalogShareMintResponse {
  return { share: shareView(overrides), code: SHARE_CODE, link: LINK };
}

export function shareList(shares: readonly CatalogShareView[] = [shareView()]): CatalogShareList {
  return { shares: [...shares] };
}

export function memberView(overrides: Partial<CatalogMemberView> = {}): CatalogMemberView {
  return {
    memberId: MEMBER_ID,
    label: 'Sam',
    catalogIds: [CATALOG_ID],
    createdAt: AT,
    keys: [
      {
        keyId: KEY_ID,
        clientName: 'Firefox on a Mac',
        joinedAt: AT,
        lastSeenAt: LATER,
        passkeys: 1,
      },
    ],
    ...overrides,
  };
}

export function memberList(members: readonly CatalogMemberView[] = [memberView()]): CatalogMemberList {
  return { members: [...members] };
}

export type SharingCall =
  | { call: 'mint'; request: CatalogShareMintRequest }
  | { call: 'shares' }
  | { call: 'endShare'; shareId: string }
  | { call: 'members' }
  | { call: 'renameMember'; memberId: string; label: string }
  | { call: 'revokeMember'; memberId: string }
  | { call: 'removeKey'; memberId: string; keyId: string }
  | { call: 'removeCatalog'; memberId: string; catalogId: string };

/** An owner gateway that records every call and answers from fixtures. */
export class FakeSharing implements ISharingGateway {
  readonly calls: SharingCall[] = [];

  constructor(
    private readonly state: {
      members: readonly CatalogMemberView[];
      shares: readonly CatalogShareView[];
      mint: CatalogShareMintResponse;
    } = { members: [memberView()], shares: [shareView()], mint: mintResponse() },
  ) {}

  mint(request: CatalogShareMintRequest): Promise<CatalogShareMintResponse> {
    this.calls.push({ call: 'mint', request });
    return Promise.resolve(this.state.mint);
  }
  shares(): Promise<CatalogShareList> {
    this.calls.push({ call: 'shares' });
    return Promise.resolve(shareList(this.state.shares));
  }
  endShare(shareId: string): Promise<CatalogShareView> {
    this.calls.push({ call: 'endShare', shareId });
    return Promise.resolve(shareView({ state: 'ended' }));
  }
  members(): Promise<CatalogMemberList> {
    this.calls.push({ call: 'members' });
    return Promise.resolve(memberList(this.state.members));
  }
  renameMember(memberId: string, label: string): Promise<CatalogMemberView> {
    this.calls.push({ call: 'renameMember', memberId, label });
    return Promise.resolve(memberView({ memberId, label }));
  }
  revokeMember(memberId: string): Promise<CatalogMemberRevoked> {
    this.calls.push({ call: 'revokeMember', memberId });
    return Promise.resolve({ memberId, keysRemoved: 2, sharesEnded: 1 });
  }
  removeKey(memberId: string, keyId: string): Promise<CatalogMemberKeyRemoved> {
    this.calls.push({ call: 'removeKey', memberId, keyId });
    return Promise.resolve({ memberId, keyId });
  }
  removeCatalog(memberId: string, catalogId: string): Promise<CatalogMemberCatalogRemoved> {
    this.calls.push({ call: 'removeCatalog', memberId, catalogId });
    return Promise.resolve({ memberId, catalogId });
  }
}

/** The catalogs the owner has, listed once per call. */
export class FakeCatalogs implements Pick<ICatalogGateway, 'list'> {
  listed = 0;

  constructor(
    private readonly catalogs = [catalog(), catalog({ id: OTHER_CATALOG_ID, name: 'Side tools', items: [] })],
  ) {}

  list(): ReturnType<ICatalogGateway['list']> {
    this.listed += 1;
    return Promise.resolve(catalogList(this.catalogs));
  }
}

export class CapturingShareScreen implements IShareScreen {
  readonly writes: string[] = [];

  write(text: string): void {
    this.writes.push(text);
  }

  get text(): string {
    return this.writes.join('\n');
  }
}
