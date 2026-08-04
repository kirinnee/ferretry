import { describe, it } from 'bun:test';
import type {
  PairingCodeMintResponse,
  PairingCodeStatusResponse,
  PairingId,
  PairingResponse,
} from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher, ApiRouter } from '../../../../src/lib/api/index.ts';
import { type PairingSubsystem, pairingRoutes } from '../../../../src/lib/runtime/mounts/pairing.ts';
import { jsonBody, request } from '../../api/support.ts';

const daemonId = `fy_daemon_${'a'.repeat(43)}`;
const deviceToken = `fy_device_${'b'.repeat(43)}`;
const pairingId = `fy_pair_${'c'.repeat(22)}` as PairingId;

const minted: PairingCodeMintResponse = {
  pairingId,
  code: '7F3K-Q2ND',
  ttlSeconds: 120,
  expiresAt: '2026-08-03T12:02:00.000Z',
  daemonId,
  daemonName: 'workstation',
  daemonUrl: 'https://workstation.example.test',
  pairUrl:
    'https://ferretry.pages.dev/pair#v1;url=https%3A%2F%2Fworkstation.example.test;code=7F3K-Q2ND;fp=fy_daemon_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};
const paired: PairingResponse = { deviceToken, daemonId, daemonName: 'workstation', capabilities: ['daemon-api'] };

class FakePairing implements PairingSubsystem {
  readonly redemptions: Array<{ readonly value: unknown; readonly key: string }> = [];
  redemption: PairingResponse | undefined = paired;
  observation: PairingCodeStatusResponse | undefined = {
    pairingId,
    status: 'pending',
    expiresAt: minted.expiresAt,
  };

  mint(): PairingCodeMintResponse {
    return minted;
  }

  status(): PairingCodeStatusResponse | undefined {
    return this.observation;
  }

  async redeem(value: unknown, key: string) {
    this.redemptions.push({ value, key });
    return this.redemption === undefined
      ? ({ kind: 'refused' } as const)
      : ({ kind: 'paired', response: this.redemption } as const);
  }
}

const credentials = {
  admin: 'admin-secret',
  warden: 'warden-secret',
  devices: { identify: (token: string) => (token === 'device-secret' ? 'device-1' : undefined) },
};

function dispatcher(subject: PairingSubsystem): ApiDispatcher {
  return new ApiDispatcher(new ApiRouter(pairingRoutes(subject)), credentials);
}

describe('pairing routes', () => {
  it('should redeem publicly, key the rate limit by peer, and leave origin policy to the transport', async () => {
    const subject = new FakePairing();

    const response = await dispatcher(subject).dispatch(
      request({
        method: 'POST',
        path: '/v1/pair',
        clientAddress: '198.51.100.7',
        headers: { origin: 'http://127.0.0.1:7431' },
        body: JSON.stringify({ code: '7F3K-Q2ND', deviceName: 'phone' }),
      }),
    );

    should(response.status).equal(200);
    should(response.headers.get('cache-control')).equal('no-store');
    should(jsonBody(response)).deepEqual(paired);
    should(subject.redemptions).deepEqual([{ value: { code: '7F3K-Q2ND', deviceName: 'phone' }, key: '198.51.100.7' }]);
  });

  it('should collapse malformed, unreadable and wrong input into the same refusal', async () => {
    const subject = new FakePairing();
    subject.redemption = undefined;
    const surface = dispatcher(subject);

    const malformed = await surface.dispatch(request({ method: 'POST', path: '/v1/pair', body: '{' }));
    const unreadable = await surface.dispatch(request({ method: 'POST', path: '/v1/pair', unreadableBody: true }));
    const wrong = await surface.dispatch(
      request({ method: 'POST', path: '/v1/pair', body: JSON.stringify({ code: 'wrong' }) }),
    );

    should([malformed.status, unreadable.status, wrong.status]).deepEqual([403, 403, 403]);
    should([malformed.body, unreadable.body, wrong.body]).deepEqual([malformed.body, malformed.body, malformed.body]);
    should(jsonBody(malformed)).deepEqual({ error: 'pairing refused', code: 'pairing_refused' });
    should(subject.redemptions.map(call => call.key)).deepEqual(['remote-unknown', 'remote-unknown', 'remote-unknown']);
  });

  it('should mint only for the host admin on loopback and accept an absent body', async () => {
    const subject = new FakePairing();
    const surface = dispatcher(subject);
    const admin = { authorization: 'Bearer admin-secret' };

    const anonymous = await surface.dispatch(request({ method: 'POST', path: '/v1/pair/code', loopback: true }));
    const device = await surface.dispatch(
      request({
        method: 'POST',
        path: '/v1/pair/code',
        loopback: true,
        headers: { authorization: 'Bearer device-secret' },
      }),
    );
    const remote = await surface.dispatch(
      request({ method: 'POST', path: '/v1/pair/code', headers: admin, body: '{}' }),
    );
    const local = await surface.dispatch(
      request({ method: 'POST', path: '/v1/pair/code', loopback: true, headers: admin }),
    );

    should(anonymous.status).equal(401);
    should(device.status).equal(403);
    should(remote.status).equal(403);
    should(local.status).equal(201);
    should(local.headers.get('cache-control')).equal('no-store');
    should(jsonBody(local)).deepEqual(minted);
  });

  it('should reject fields on the bodyless mint contract', async () => {
    const response = await dispatcher(new FakePairing()).dispatch(
      request({
        method: 'POST',
        path: '/v1/pair/code',
        loopback: true,
        headers: { authorization: 'Bearer admin-secret' },
        body: JSON.stringify({ deviceName: 'phone' }),
      }),
    );

    should(response.status).equal(400);
    should(jsonBody(response).code).equal('invalid_request');
  });

  it('should expose status only to the host admin on loopback without ever returning the code', async () => {
    const subject = new FakePairing();
    const surface = dispatcher(subject);
    const path = `/v1/pair/code/${pairingId}`;
    const headers = { authorization: 'Bearer admin-secret' };

    const remote = await surface.dispatch(request({ path, headers }));
    const local = await surface.dispatch(request({ path, headers, loopback: true }));
    subject.observation = undefined;
    const absent = await surface.dispatch(request({ path, headers, loopback: true }));
    const malformed = await surface.dispatch(request({ path: '/v1/pair/code/not-an-id', headers, loopback: true }));

    should(remote.status).equal(403);
    should(local.status).equal(200);
    should(local.headers.get('cache-control')).equal('no-store');
    should(local.body).not.containEql('7F3K-Q2ND');
    should(absent.status).equal(404);
    should(malformed.status).equal(404);
    should(absent.body).equal(malformed.body);
  });

  it('should use separate fail-closed buckets when the transport cannot identify a peer', async () => {
    const subject = new FakePairing();
    const surface = dispatcher(subject);

    await surface.dispatch(request({ method: 'POST', path: '/v1/pair', loopback: true, body: '{}' }));
    await surface.dispatch(request({ method: 'POST', path: '/v1/pair', body: '{}' }));

    should(subject.redemptions.map(call => call.key)).deepEqual(['loopback-unknown', 'remote-unknown']);
  });
});
