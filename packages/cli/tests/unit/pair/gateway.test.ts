import { describe, it } from 'bun:test';
import should from 'should';
import type { z } from 'zod';
import { PAIRING_CODE_PATH, pairingCodePath, ProtocolPairingGateway } from '../../../src/lib/pair/gateway';
import type { PairingApiClient } from '../../../src/lib/pair/ports';
import { CODE, MINT, PAIRING_ID, redeemed } from './fixtures';

interface Call {
  path: string;
  init: RequestInit | undefined;
}

/** A client that answers with a payload and records the call, so the gateway's parsing really runs. */
function fakeClient(payload: unknown, calls: Call[] = []): PairingApiClient {
  return {
    request: <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
      calls.push({ path, init });
      return Promise.resolve(schema.parse(payload));
    },
  };
}

const body = (init: RequestInit | undefined): unknown => JSON.parse(String(init?.body));

describe('pairing routes', () => {
  it('should keep minting and redeeming on different routes', () => {
    // `/v1/pair` is where a DEVICE redeems a code; minting is host-scoped and loopback-only.
    should(PAIRING_CODE_PATH).equal('/v1/pair/code');
    should(pairingCodePath(PAIRING_ID)).equal(`/v1/pair/code/${PAIRING_ID}`);
  });

  it('should escape a pairing id rather than let it reshape the route', () => {
    should(pairingCodePath('a/b' as typeof PAIRING_ID)).equal('/v1/pair/code/a%2Fb');
  });
});

describe('protocol pairing gateway', () => {
  it('should mint with no body of its own and parse the mint it gets back', async () => {
    // Arrange
    const calls: Call[] = [];
    const subject = new ProtocolPairingGateway(fakeClient(MINT, calls));

    // Act
    const actual = await subject.mint();

    // Assert
    should(actual).eql(MINT);
    should(calls[0]?.path).equal(PAIRING_CODE_PATH);
    should(calls[0]?.init?.method).equal('POST');
    // The device names itself at redemption, so the host sends nothing the schema would refuse.
    should(body(calls[0]?.init)).eql({});
  });

  it('should address the status by pairing id and never by code', async () => {
    // Arrange
    const calls: Call[] = [];
    const status = redeemed();
    const subject = new ProtocolPairingGateway(fakeClient(status, calls));

    // Act
    const actual = await subject.status(PAIRING_ID);

    // Assert
    should(actual).eql(status);
    should(calls[0]?.path).equal(pairingCodePath(PAIRING_ID));
    should(calls[0]?.path).not.containEql(CODE);
    // A plain read: nothing about asking what happened changes anything.
    should(calls[0]?.init).be.undefined();
  });

  it('should refuse a mint the daemon cannot answer properly instead of drawing it', async () => {
    // Arrange — a daemon answering with an error envelope rather than a mint.
    const subject = new ProtocolPairingGateway(fakeClient({ error: 'host-local access required' }));

    // Act + Assert
    await should(subject.mint()).be.rejected();
  });

  it('should refuse a mint whose pairing URL does not match the code it came with', async () => {
    // Arrange — the protocol schema binds `pairUrl` to the daemon, code and fingerprint; a daemon that
    // assembled it from mismatched parts is caught here rather than by a phone that will not connect.
    const subject = new ProtocolPairingGateway(
      fakeClient({ ...MINT, pairUrl: 'https://ferretry.pages.dev/pair#v1;url=x;code=7F3K-Q2ND;fp=y' }),
    );

    // Act + Assert
    await should(subject.mint()).be.rejected();
  });

  it('should refuse a status outside the three states the protocol defines', async () => {
    // Arrange
    const subject = new ProtocolPairingGateway(fakeClient({ pairingId: PAIRING_ID, status: 'maybe' }));

    // Act + Assert
    await should(subject.status(PAIRING_ID)).be.rejected();
  });
});
