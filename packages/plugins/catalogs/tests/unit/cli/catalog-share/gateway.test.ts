import { describe, it } from 'bun:test';
import should from 'should';
import type { CatalogShareMintRequest } from '../../../../contract/wire/index.ts';
import { ClientSharingGateway } from '../../../../cli/lib/catalog-share/gateway';
import type { SharingApiClient } from '../../../../cli/lib/catalog-share/ports';
import { CATALOG_ID } from '../catalog/fixtures';
import {
  KEY_ID,
  LINK,
  MEMBER_ID,
  memberList,
  memberView,
  mintResponse,
  SHARE_CODE,
  SHARE_ID,
  shareList,
  shareView,
} from './fixtures';

interface Call {
  route: string;
  init: { params?: unknown; body?: unknown } | undefined;
}

function fakeClient(payload: unknown, calls: Call[]): SharingApiClient {
  return {
    call: async <T>(route: string, init?: Call['init']): Promise<T> => {
      calls.push({ route, init });
      return payload as T;
    },
  };
}

const bodyOf = (call: Call | undefined): unknown => call?.init?.body;

const request: CatalogShareMintRequest = {
  catalogIds: [CATALOG_ID],
  member: { kind: 'new', label: 'Sam' },
  expiresIn: '1h',
  uses: { kind: 'single' },
};

describe('ClientSharingGateway', () => {
  it('should POST a mint to /v1/catalog-shares and parse the one answer that holds a code', async () => {
    const calls: Call[] = [];
    const gateway = new ClientSharingGateway(fakeClient(mintResponse(), calls));
    const minted = await gateway.mint(request);
    should(minted.code).equal(SHARE_CODE);
    should(minted.link).equal(LINK);
    should(calls[0]?.route).equal('POST /v1/catalog-shares');
    should(bodyOf(calls[0])).eql(request);
  });

  it('should refuse a mint the protocol would refuse, before it leaves', async () => {
    const calls: Call[] = [];
    const gateway = new ClientSharingGateway(fakeClient(mintResponse(), calls));
    await should(gateway.mint({ ...request, catalogIds: [] })).be.rejected();
    const hidden = { ...request, member: { name: 'Al\u200Bice' } } as const;
    await should(gateway.mint(hidden)).be.rejected();
    should(calls).have.length(0);
  });

  it('should reject a mint answer with no code', async () => {
    const calls: Call[] = [];
    const { share, link } = mintResponse();
    const gateway = new ClientSharingGateway(fakeClient({ share, link }, calls));
    await should(gateway.mint(request)).be.rejected();
  });

  it('should GET the shares and members lists', async () => {
    const calls: Call[] = [];
    const shares = await new ClientSharingGateway(fakeClient(shareList(), calls)).shares();
    should(shares.shares[0]?.shareId).equal(SHARE_ID);
    should(calls[0]).eql({ route: 'GET /v1/catalog-shares', init: undefined });
    const members = await new ClientSharingGateway(fakeClient(memberList(), calls)).members();
    should(members.members[0]?.memberId).equal(MEMBER_ID);
    should(calls[1]).eql({ route: 'GET /v1/catalog-members', init: undefined });
  });

  it('should refuse a list that carries an unknown field, so a code could never ride along', async () => {
    const calls: Call[] = [];
    const bent = { shares: [{ ...shareView(), code: SHARE_CODE }] };
    await should(new ClientSharingGateway(fakeClient(bent, calls)).shares()).be.rejected();
  });

  it('should DELETE a share by id', async () => {
    const calls: Call[] = [];
    const ended = await new ClientSharingGateway(fakeClient(shareView({ state: 'ended' }), calls)).endShare(SHARE_ID);
    should(ended.state).equal('ended');
    should(calls[0]).eql({ route: 'DELETE /v1/catalog-shares/:shareId', init: { params: { shareId: SHARE_ID } } });
  });

  it('should PATCH a rename with the label', async () => {
    const calls: Call[] = [];
    const renamed = await new ClientSharingGateway(fakeClient(memberView({ label: 'Samuel' }), calls)).renameMember(
      MEMBER_ID,
      'Samuel',
    );
    should(renamed.label).equal('Samuel');
    should(calls[0]).match({ route: 'PATCH /v1/catalog-members/:memberId', init: { params: { memberId: MEMBER_ID } } });
    should(bodyOf(calls[0])).eql({ label: 'Samuel' });
  });

  it('should refuse an empty rename label before it leaves', async () => {
    const calls: Call[] = [];
    await should(new ClientSharingGateway(fakeClient(memberView(), calls)).renameMember(MEMBER_ID, '')).be.rejected();
    should(calls).have.length(0);
  });

  it('should DELETE a member and parse what was removed', async () => {
    const calls: Call[] = [];
    const revoked = await new ClientSharingGateway(
      fakeClient({ memberId: MEMBER_ID, keysRemoved: 2, sharesEnded: 1 }, calls),
    ).revokeMember(MEMBER_ID);
    should(revoked).eql({ memberId: MEMBER_ID, keysRemoved: 2, sharesEnded: 1 });
    should(calls[0]).eql({ route: 'DELETE /v1/catalog-members/:memberId', init: { params: { memberId: MEMBER_ID } } });
  });

  it('should DELETE one browser of a member', async () => {
    const calls: Call[] = [];
    const removed = await new ClientSharingGateway(fakeClient({ memberId: MEMBER_ID, keyId: KEY_ID }, calls)).removeKey(
      MEMBER_ID,
      KEY_ID,
    );
    should(removed).eql({ memberId: MEMBER_ID, keyId: KEY_ID });
    should(calls[0]).eql({
      route: 'DELETE /v1/catalog-members/:memberId/keys/:keyId',
      init: { params: { memberId: MEMBER_ID, keyId: KEY_ID } },
    });
  });

  it('should DELETE one catalog from a member', async () => {
    const calls: Call[] = [];
    const removed = await new ClientSharingGateway(
      fakeClient({ memberId: MEMBER_ID, catalogId: CATALOG_ID }, calls),
    ).removeCatalog(MEMBER_ID, CATALOG_ID);
    should(removed).eql({ memberId: MEMBER_ID, catalogId: CATALOG_ID });
    should(calls[0]).eql({
      route: 'DELETE /v1/catalog-members/:memberId/catalogs/:catalogId',
      init: { params: { memberId: MEMBER_ID, catalogId: CATALOG_ID } },
    });
  });

  it('should reject an answer of the wrong shape', async () => {
    const calls: Call[] = [];
    const gateway = new ClientSharingGateway(fakeClient({ memberId: MEMBER_ID }, calls));
    await should(gateway.removeKey(MEMBER_ID, KEY_ID)).be.rejected();
  });
});
