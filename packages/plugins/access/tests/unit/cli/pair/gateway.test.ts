import { describe, it } from 'bun:test';
import should from 'should';
import manifest from '../../../../manifest.ts';
import {
  PAIRING_CODE_PATH,
  PAIRING_ROUTES,
  ProtocolPairingGateway,
  pairingCodePath,
} from '../../../../cli/lib/pair/gateway.ts';
import type { PairingApiClient } from '../../../../cli/lib/pair/ports.ts';
import type { DaemonCallInit } from '../../../../cli/shell.ts';
import { CODE, MINT, PAIRING_ID, redeemed } from './fixtures';

interface Call {
  route: string;
  init: DaemonCallInit | undefined;
}

/** A client that answers with a payload and records the call, so the gateway's parsing really runs. */
function fakeClient(payload: unknown, calls: Call[] = []): PairingApiClient {
  return {
    call: async <Answer>(route: string, init?: DaemonCallInit): Promise<Answer> => {
      calls.push({ route, init });
      return (await Promise.resolve(payload)) as Answer;
    },
  };
}

const declared = (manifest.actions.routes as readonly { readonly key: string }[]).map(route => route.key);

describe('pairing routes', () => {
  it('should keep minting and redeeming on different routes', () => {
    // A DEVICE redeems a code inside a sealed session; minting is a host route.
    should(PAIRING_CODE_PATH).equal('/v1/pair/code');
    should(pairingCodePath(PAIRING_ID)).equal(`/v1/pair/code/${PAIRING_ID}`);
  });

  it('should escape a pairing id rather than let it reshape the route', () => {
    should(pairingCodePath('a/b' as typeof PAIRING_ID)).equal('/v1/pair/code/a%2Fb');
  });

  it('should call only route keys the manifest declares', () => {
    for (const key of Object.values(PAIRING_ROUTES)) should(declared).containEql(key);
  });
});

describe('protocol pairing gateway', () => {
  it('should mint with no body of its own and parse the mint it gets back', async () => {
    // Arrange
    const calls: Call[] = [];
    const subject = new ProtocolPairingGateway(fakeClient(MINT, calls));

    // Act
    const actual = await subject.mint('full');

    // Assert
    should(actual).eql(MINT);
    should(calls[0]?.route).equal('POST /v1/pair/code');
    // The device names itself at redemption, so the host sends nothing the schema would refuse.
    should(calls[0]?.init?.body).eql({});
  });

  it('P14 should address the status by pairing id and never by code', async () => {
    // Arrange
    const calls: Call[] = [];
    const status = redeemed();
    const subject = new ProtocolPairingGateway(fakeClient(status, calls));

    // Act
    const actual = await subject.status(PAIRING_ID);

    // Assert
    should(actual).eql(status);
    should(calls[0]?.route).equal('GET /v1/pair/code/:pairingId');
    should(calls[0]?.init?.params).eql({ pairingId: PAIRING_ID });
    should(JSON.stringify(calls[0])).not.containEql(CODE);
    // A plain read: nothing about asking what happened changes anything.
    should(calls[0]?.init?.body).be.undefined();
    should(calls[0]?.init?.query).be.undefined();
  });

  it('P8 should meet the pairing id only in the mint response and the routes addressed by it', async () => {
    // Arrange
    const calls: Call[] = [];
    const subject = new ProtocolPairingGateway(fakeClient(MINT, calls));

    // Act
    const minted = await subject.mint('full');

    // Assert — the id arrives in the mint; it is sent nowhere but as the `:pairingId` of a code route.
    should(minted.pairingId).equal(PAIRING_ID);
    should(JSON.stringify(calls[0]?.init)).not.containEql(PAIRING_ID);
    const byId = declared.filter(key => key.includes(':pairingId'));
    should(byId.sort()).eql(['DELETE /v1/pair/code/:pairingId', 'GET /v1/pair/code/:pairingId']);
  });

  it('should refuse a mint the daemon cannot answer properly instead of drawing it', async () => {
    // Arrange — a daemon answering with an error envelope rather than a mint.
    const subject = new ProtocolPairingGateway(fakeClient({ error: 'host-local access required' }));

    // Act + Assert
    await should(subject.mint('full')).be.rejected();
  });

  it('should refuse a mint whose pairing URL does not match the code it came with', async () => {
    // Arrange — the contract schema binds `pairUrl` to the daemon, code and fingerprint; a daemon that
    // assembled it from mismatched parts is caught here rather than by a phone that will not connect.
    const subject = new ProtocolPairingGateway(
      fakeClient({ ...MINT, pairUrl: 'https://ferretry.pages.dev/pair#v1;url=x;code=7F3K-Q2ND;fp=y' }),
    );

    // Act + Assert
    await should(subject.mint('full')).be.rejected();
  });

  it('should refuse a status outside the three states the contract defines', async () => {
    // Arrange
    const subject = new ProtocolPairingGateway(fakeClient({ pairingId: PAIRING_ID, status: 'maybe' }));

    // Act + Assert
    await should(subject.status(PAIRING_ID)).be.rejected();
  });
});

describe('protocol pairing gateway, grant sets', () => {
  it('should send an empty body for the full set, the default', async () => {
    // Arrange
    const calls: Call[] = [];

    // Act
    await new ProtocolPairingGateway(fakeClient(MINT, calls)).mint('full');

    // Assert
    should(calls[0]?.init?.body).eql({});
  });

  it('P39 should name the limited set in the body, and nothing else', async () => {
    // Arrange
    const calls: Call[] = [];

    // Act
    const actual = await new ProtocolPairingGateway(fakeClient({ ...MINT, grants: 'limited' }, calls)).mint('limited');

    // Assert
    should(calls[0]?.init?.body).eql({ grants: 'limited' });
    should(actual.grants).equal('limited');
  });
});
