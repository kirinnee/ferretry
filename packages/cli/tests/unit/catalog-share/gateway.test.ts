import { describe, it } from 'bun:test';
import should from 'should';
import type { z } from 'zod';
import type { CatalogShareMintRequest } from '@ferretry/protocol';
import {
  catalogMemberCatalogPath,
  catalogMemberKeyPath,
  catalogMemberPath,
  catalogSharePath,
  ProtocolSharingGateway,
} from '../../../src/lib/catalog-share/gateway';
import type { SharingApiClient } from '../../../src/lib/catalog-share/ports';
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
  path: string;
  init: RequestInit | undefined;
}

function fakeClient(payload: unknown, calls: Call[]): SharingApiClient {
  return {
    request: <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
      calls.push({ path, init });
      return Promise.resolve(schema.parse(payload));
    },
  };
}

const bodyOf = (call: Call | undefined): unknown => JSON.parse(String(call?.init?.body));

const request: CatalogShareMintRequest = {
  catalogIds: [CATALOG_ID],
  member: { kind: 'new', label: 'Sam' },
  expiresIn: '1h',
  uses: { kind: 'single' },
};

describe('sharing routes', () => {
  it('should name each route under /v1/catalog-shares and /v1/catalog-members with the ids encoded', () => {
    should(catalogSharePath(SHARE_ID)).equal(`/v1/catalog-shares/${SHARE_ID}`);
    should(catalogSharePath('a/b')).equal('/v1/catalog-shares/a%2Fb');
    should(catalogMemberPath(MEMBER_ID)).equal(`/v1/catalog-members/${MEMBER_ID}`);
    should(catalogMemberKeyPath(MEMBER_ID, KEY_ID)).equal(`/v1/catalog-members/${MEMBER_ID}/keys/${KEY_ID}`);
    should(catalogMemberCatalogPath(MEMBER_ID, CATALOG_ID)).equal(
      `/v1/catalog-members/${MEMBER_ID}/catalogs/${CATALOG_ID}`,
    );
    should(catalogMemberPath('a b')).equal('/v1/catalog-members/a%20b');
  });
});

describe('ProtocolSharingGateway', () => {
  it('should POST a mint to /v1/catalog-shares and parse the one answer that holds a code', async () => {
    const calls: Call[] = [];
    const gateway = new ProtocolSharingGateway(fakeClient(mintResponse(), calls));
    const minted = await gateway.mint(request);
    should(minted.code).equal(SHARE_CODE);
    should(minted.link).equal(LINK);
    should(calls[0]?.path).equal('/v1/catalog-shares');
    should(calls[0]?.init?.method).equal('POST');
    should(calls[0]?.init?.headers).eql({ 'content-type': 'application/json' });
    should(bodyOf(calls[0])).eql(request);
  });

  it('should refuse a mint the protocol would refuse, before it leaves', async () => {
    const calls: Call[] = [];
    const gateway = new ProtocolSharingGateway(fakeClient(mintResponse(), calls));
    await should(gateway.mint({ ...request, catalogIds: [] })).be.rejected();
    const many = {
      ...request,
      member: { kind: 'existing', memberId: MEMBER_ID },
      uses: { kind: 'multi', cap: 5 },
    } as const;
    await should(gateway.mint(many)).be.rejected();
    should(calls).have.length(0);
  });

  it('should reject a mint answer with no code', async () => {
    const calls: Call[] = [];
    const { share, link } = mintResponse();
    const gateway = new ProtocolSharingGateway(fakeClient({ share, link }, calls));
    await should(gateway.mint(request)).be.rejected();
  });

  it('should GET the shares and members lists', async () => {
    const calls: Call[] = [];
    const shares = await new ProtocolSharingGateway(fakeClient(shareList(), calls)).shares();
    should(shares.shares[0]?.shareId).equal(SHARE_ID);
    should(calls[0]).eql({ path: '/v1/catalog-shares', init: undefined });
    const members = await new ProtocolSharingGateway(fakeClient(memberList(), calls)).members();
    should(members.members[0]?.memberId).equal(MEMBER_ID);
    should(calls[1]).eql({ path: '/v1/catalog-members', init: undefined });
  });

  it('should refuse a list that carries an unknown field, so a code could never ride along', async () => {
    const calls: Call[] = [];
    const bent = { shares: [{ ...shareView(), code: SHARE_CODE }] };
    await should(new ProtocolSharingGateway(fakeClient(bent, calls)).shares()).be.rejected();
  });

  it('should DELETE a share by id', async () => {
    const calls: Call[] = [];
    const ended = await new ProtocolSharingGateway(fakeClient(shareView({ state: 'ended' }), calls)).endShare(SHARE_ID);
    should(ended.state).equal('ended');
    should(calls[0]?.path).equal(`/v1/catalog-shares/${SHARE_ID}`);
    should(calls[0]?.init).eql({ method: 'DELETE' });
  });

  it('should PATCH a rename with the label', async () => {
    const calls: Call[] = [];
    const renamed = await new ProtocolSharingGateway(fakeClient(memberView({ label: 'Samuel' }), calls)).renameMember(
      MEMBER_ID,
      'Samuel',
    );
    should(renamed.label).equal('Samuel');
    should(calls[0]?.path).equal(`/v1/catalog-members/${MEMBER_ID}`);
    should(calls[0]?.init?.method).equal('PATCH');
    should(bodyOf(calls[0])).eql({ label: 'Samuel' });
  });

  it('should refuse an empty rename label before it leaves', async () => {
    const calls: Call[] = [];
    await should(new ProtocolSharingGateway(fakeClient(memberView(), calls)).renameMember(MEMBER_ID, '')).be.rejected();
    should(calls).have.length(0);
  });

  it('should DELETE a member and parse what was removed', async () => {
    const calls: Call[] = [];
    const revoked = await new ProtocolSharingGateway(
      fakeClient({ memberId: MEMBER_ID, keysRemoved: 2, sharesEnded: 1 }, calls),
    ).revokeMember(MEMBER_ID);
    should(revoked).eql({ memberId: MEMBER_ID, keysRemoved: 2, sharesEnded: 1 });
    should(calls[0]?.path).equal(`/v1/catalog-members/${MEMBER_ID}`);
    should(calls[0]?.init).eql({ method: 'DELETE' });
  });

  it('should DELETE one browser of a member', async () => {
    const calls: Call[] = [];
    const removed = await new ProtocolSharingGateway(
      fakeClient({ memberId: MEMBER_ID, keyId: KEY_ID }, calls),
    ).removeKey(MEMBER_ID, KEY_ID);
    should(removed).eql({ memberId: MEMBER_ID, keyId: KEY_ID });
    should(calls[0]?.path).equal(`/v1/catalog-members/${MEMBER_ID}/keys/${KEY_ID}`);
    should(calls[0]?.init).eql({ method: 'DELETE' });
  });

  it('should DELETE one catalog from a member', async () => {
    const calls: Call[] = [];
    const removed = await new ProtocolSharingGateway(
      fakeClient({ memberId: MEMBER_ID, catalogId: CATALOG_ID }, calls),
    ).removeCatalog(MEMBER_ID, CATALOG_ID);
    should(removed).eql({ memberId: MEMBER_ID, catalogId: CATALOG_ID });
    should(calls[0]?.path).equal(`/v1/catalog-members/${MEMBER_ID}/catalogs/${CATALOG_ID}`);
    should(calls[0]?.init).eql({ method: 'DELETE' });
  });

  it('should reject an answer of the wrong shape', async () => {
    const calls: Call[] = [];
    const gateway = new ProtocolSharingGateway(fakeClient({ memberId: MEMBER_ID }, calls));
    await should(gateway.removeKey(MEMBER_ID, KEY_ID)).be.rejected();
  });
});
