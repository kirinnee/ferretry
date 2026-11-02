import { describe, it } from 'bun:test';
import should from 'should';
import {
  endShare,
  listMembers,
  listShares,
  mintShare,
  removeMemberBrowser,
  revokeMember,
  takeAwayCatalog,
} from '../../../../src/features/catalogs/catalog-shares-api.ts';
import type { CatalogClient } from '../../../../src/features/catalogs/catalogs-api.ts';
import { KEY_A1, MEMBER_A, memberView, mintResponse, SHARE_1, shareView } from '../../../support/catalog-sharing.ts';
import { CATALOG } from '../../../support/catalog-views.ts';

interface Call {
  readonly path: string;
  readonly init: RequestInit | undefined;
}

function recorder(answer: unknown): { client: CatalogClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    request: async (path: string, schema: { parse: (value: unknown) => unknown }, init?: RequestInit) => {
      calls.push({ path, init });
      return schema.parse(answer);
    },
  } as unknown as CatalogClient;
  return { client, calls };
}

describe('owner sharing routes', () => {
  it('mints a share with the validated request and returns the code once', async () => {
    const { client, calls } = recorder(mintResponse());
    const made = await mintShare(client, {
      catalogIds: [CATALOG],
      member: { kind: 'new', label: 'Alice' },
      expiresIn: '1h',
      uses: { kind: 'single' },
    });
    should(calls[0]?.path).equal('/v1/catalog-shares');
    should(calls[0]?.init?.method).equal('POST');
    should(JSON.parse(String(calls[0]?.init?.body))).match({ expiresIn: '1h', uses: { kind: 'single' } });
    should(made.code).startWith('fy_share_');
  });

  it('refuses to send a request the daemon would refuse', async () => {
    const { client, calls } = recorder(mintResponse());
    let thrown: unknown;
    try {
      await mintShare(client, {
        catalogIds: [CATALOG],
        member: { name: 'Al\u200Bice' },
        expiresIn: '1h',
        uses: { kind: 'single' },
      });
    } catch (error) {
      thrown = error;
    }
    should(thrown).be.an.Error();
    should(calls).have.length(0);
  });

  it('lists shares and members', async () => {
    const shares = recorder({ shares: [shareView()] });
    should((await listShares(shares.client)).shares).have.length(1);
    should(shares.calls[0]?.path).equal('/v1/catalog-shares');
    const members = recorder({ members: [memberView()] });
    should((await listMembers(members.client)).members[0]?.label).equal('Alice');
    should(members.calls[0]?.path).equal('/v1/catalog-members');
  });

  it('ends a share', async () => {
    const { client, calls } = recorder(shareView({ state: 'ended' }));
    should((await endShare(client, SHARE_1)).state).equal('ended');
    should(calls[0]).match({ path: `/v1/catalog-shares/${SHARE_1}`, init: { method: 'DELETE' } });
  });

  it('removes a browser, takes a catalog away and revokes a person', async () => {
    const browser = recorder({ memberId: MEMBER_A, keyId: KEY_A1 });
    await removeMemberBrowser(browser.client, MEMBER_A, KEY_A1);
    should(browser.calls[0]?.path).equal(`/v1/catalog-members/${MEMBER_A}/keys/${KEY_A1}`);
    should(browser.calls[0]?.init?.method).equal('DELETE');

    const catalog = recorder({ memberId: MEMBER_A, catalogId: CATALOG });
    await takeAwayCatalog(catalog.client, MEMBER_A, CATALOG);
    should(catalog.calls[0]?.path).equal(`/v1/catalog-members/${MEMBER_A}/catalogs/${CATALOG}`);

    const revoked = recorder({ memberId: MEMBER_A, keysRemoved: 2, sharesEnded: 1 });
    should(await revokeMember(revoked.client, MEMBER_A)).match({ keysRemoved: 2, sharesEnded: 1 });
    should(revoked.calls[0]?.path).equal(`/v1/catalog-members/${MEMBER_A}`);
  });

  it('encodes ids that are not path-safe', async () => {
    const { client, calls } = recorder(shareView());
    await endShare(client, 'a/b c');
    should(calls[0]?.path).equal('/v1/catalog-shares/a%2Fb%20c');
  });
});
