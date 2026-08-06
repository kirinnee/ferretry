import { describe, it } from 'bun:test';
import type {
  PairedDevice,
  PairingCodeMintResponse,
  PairingCodeStatusResponse,
  PairingId,
  PairingResponse,
} from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher, ApiRouter } from '../../../../src/lib/api/index.ts';
import { DEFAULT_CAPABILITY_GRANTS } from '../../../../src/lib/grants/index.ts';
import { type PairingSubsystem, pairingRoutes } from '../../../../src/lib/runtime/mounts/pairing.ts';
import { jsonBody, request } from '../../api/support.ts';
import { grantSubsystem } from './support.ts';

const daemonId = `fy_daemon_${'a'.repeat(43)}`;
const deviceToken = `fy_device_${'b'.repeat(43)}`;
const pairingId = `fy_pair_${'c'.repeat(22)}` as PairingId;
const deviceOneId = `fy_device_id_${'d'.repeat(22)}`;
const deviceTwoId = `fy_device_id_${'e'.repeat(22)}`;

const minted: PairingCodeMintResponse = {
  pairingId,
  code: '7F3K-Q2ND',
  ttlSeconds: 120,
  expiresAt: '2026-08-03T12:02:00.000Z',
  daemonId,
  daemonName: 'workstation',
  daemonUrl: 'https://workstation.example.test',
  reach: 'any-device',
  pairUrl:
    'https://ferretry.pages.dev/pair#v1;url=https%3A%2F%2Fworkstation.example.test;code=7F3K-Q2ND;fp=fy_daemon_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};
const paired: PairingResponse = { deviceToken, daemonId, daemonName: 'workstation', capabilities: ['daemon-api'] };

const device = (id: string, name: string): PairedDevice => ({
  id,
  name,
  platform: 'browser',
  createdAt: '2026-08-01T09:00:00.000Z',
  lastSeenAt: '2026-08-03T11:58:00.000Z',
});

class FakePairing implements PairingSubsystem {
  readonly redemptions: Array<{ readonly value: unknown; readonly key: string }> = [];
  readonly revoked: PairingId[] = [];
  readonly revokedDevices: string[] = [];
  redemption: PairingResponse | undefined = paired;
  observation: PairingCodeStatusResponse | undefined = {
    pairingId,
    status: 'pending',
    expiresAt: minted.expiresAt,
  };
  granted: PairedDevice[] = [device(deviceOneId, 'Pixel 8'), device(deviceTwoId, 'iPad')];

  mint(): PairingCodeMintResponse {
    return minted;
  }

  status(): PairingCodeStatusResponse | undefined {
    return this.observation;
  }

  revoke(id: PairingId): PairingCodeStatusResponse | undefined {
    // An id this daemon never minted is reported as unknown WITHOUT being recorded, so a fixture can
    // tell a revocation that reached a code from one that found nothing to revoke.
    if (this.observation === undefined) return undefined;
    this.revoked.push(id);
    return { pairingId: id, status: 'expired', expiresAt: minted.expiresAt };
  }

  async devices(): Promise<readonly PairedDevice[]> {
    return this.granted;
  }

  async revokeDevice(id: string): Promise<boolean> {
    const remaining = this.granted.filter(entry => entry.id !== id);
    // Records what was actually taken away rather than what was asked, so a fixture can tell a
    // revocation that happened from one the route refused or found nothing to do.
    if (remaining.length === this.granted.length) return false;
    this.revokedDevices.push(id);
    this.granted = remaining;
    return true;
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
  devices: { identify: (token: string) => (token === 'device-secret' ? deviceOneId : undefined) },
};

const admin = { authorization: 'Bearer admin-secret' };
const browser = { authorization: 'Bearer device-secret' };

/**
 * The mount over the REAL grant subsystem.
 *
 * Real rather than a stub guard, because the property under test is that these routes are governed by
 * the same object the operator's document feeds — a fake guard would let this file pass while the
 * daemon enforced something else. `pairing` is permissive by default, so `allow: false` is how a fixture
 * states that the operator switched it off.
 */
async function mount(subject: PairingSubsystem, allow = true) {
  const grants = grantSubsystem({
    grants: { ...DEFAULT_CAPABILITY_GRANTS, pairing: { use: allow, configure: allow } },
  });
  await grants.refresh();
  return new ApiDispatcher(new ApiRouter(pairingRoutes(subject)), credentials, grants);
}

describe('pairing routes', () => {
  it('should redeem publicly, key the rate limit by peer, and leave origin policy to the transport', async () => {
    const subject = new FakePairing();

    const response = await (
      await mount(subject)
    ).dispatch(
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
    const surface = await mount(subject);

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

  it('should let a BROWSER on this host mint, which the host scope could never do', async () => {
    // THE WHOLE POINT OF THE SCOPE MOVE. A browser is always a paired device — that is how it got a
    // credential at all — so under `host` scope the UI could not add a second device from the machine
    // itself. Loopback is ungoverned, so no grant stands in the way of a browser that IS on the host,
    // whatever the operator has decided about callers who are not.
    // Arrange
    const subject = new FakePairing();
    const surface = await mount(subject);

    // Act
    const anonymous = await surface.dispatch(request({ method: 'POST', path: '/v1/pair/code', loopback: true }));
    const fromBrowser = await surface.dispatch(
      request({ method: 'POST', path: '/v1/pair/code', loopback: true, headers: browser }),
    );
    const fromHostCli = await surface.dispatch(
      request({ method: 'POST', path: '/v1/pair/code', loopback: true, headers: admin }),
    );

    // Assert
    should(anonymous.status).equal(401);
    should(fromBrowser.status).equal(201);
    should(fromHostCli.status).equal(201);
    should(fromBrowser.headers.get('cache-control')).equal('no-store');
    should(jsonBody(fromBrowser)).deepEqual(minted);
  });

  it('should let a REMOTE browser mint while the operator leaves pairing on, and explain it when they do not', async () => {
    // Adding a device from a phone is the case the owner asked for, so the default is permissive. The
    // protection is elsewhere: a remote caller may switch `pairing` off and can never switch it back on
    // — enforced by the grant layer, tested there. What this proves is the two answers this mount gives.
    // Arrange
    const subject = new FakePairing();
    const remote = { method: 'POST' as const, path: '/v1/pair/code', headers: browser, loopback: false };

    // Act
    const allowed = await (await mount(subject)).dispatch(request(remote));
    const refused = await (await mount(subject, false)).dispatch(request(remote));

    // Assert — and the refusal names what to do next rather than saying "forbidden".
    should(allowed.status).equal(201);
    should(refused.status).equal(403);
    should(jsonBody(refused).code).equal('grant_not_granted');
    should(refused.body).match(/has not granted the UI the use of device pairing/u);
    should(refused.body).match(/fy daemon config set pairing --use/u);
  });

  it('should reject fields on the bodyless mint contract', async () => {
    const response = await (
      await mount(new FakePairing())
    ).dispatch(
      request({
        method: 'POST',
        path: '/v1/pair/code',
        loopback: true,
        headers: admin,
        body: JSON.stringify({ deviceName: 'phone' }),
      }),
    );

    should(response.status).equal(400);
    should(jsonBody(response).code).equal('invalid_request');
  });

  it('should report a minted code’s fate without ever returning the code', async () => {
    const subject = new FakePairing();
    const surface = await mount(subject);
    const path = `/v1/pair/code/${pairingId}`;

    const local = await surface.dispatch(request({ path, headers: browser, loopback: true }));
    subject.observation = undefined;
    const absent = await surface.dispatch(request({ path, headers: browser, loopback: true }));
    const malformed = await surface.dispatch(
      request({ path: '/v1/pair/code/not-an-id', headers: browser, loopback: true }),
    );

    should(local.status).equal(200);
    should(local.headers.get('cache-control')).equal('no-store');
    should(local.body).not.containEql('7F3K-Q2ND');
    should(absent.status).equal(404);
    should(malformed.status).equal(404);
    should(absent.body).equal(malformed.body);
  });

  it('should revoke a live code by its pairing id and answer 404 for an id it never minted', async () => {
    const subject = new FakePairing();
    const surface = await mount(subject);
    const path = `/v1/pair/code/${pairingId}`;

    const revoked = await surface.dispatch(request({ method: 'DELETE', path, headers: browser, loopback: true }));
    subject.observation = undefined;
    const unknown = await surface.dispatch(request({ method: 'DELETE', path, headers: browser, loopback: true }));
    const malformed = await surface.dispatch(
      request({ method: 'DELETE', path: '/v1/pair/code/not-an-id', headers: browser, loopback: true }),
    );

    should(revoked.status).equal(200);
    should(jsonBody(revoked)).containDeep({ pairingId, status: 'expired' });
    should(revoked.body).not.containEql('7F3K-Q2ND');
    should(subject.revoked).deepEqual([pairingId]);
    should(unknown.status).equal(404);
    should(malformed.status).equal(404);
  });

  it('should list who may reach this machine, marking the caller’s own device and how it arrived', async () => {
    // `thisDeviceId` comes from the server-derived actor, never from anything the caller sent, so a
    // browser cannot point the "this is you" mark at somebody else's grant.
    // Arrange
    const subject = new FakePairing();
    const surface = await mount(subject);

    // Act
    const fromBrowser = await surface.dispatch(request({ path: '/v1/pair/devices', headers: browser, loopback: true }));
    const fromHostCli = await surface.dispatch(request({ path: '/v1/pair/devices', headers: admin, loopback: true }));
    const fromRemote = await surface.dispatch(request({ path: '/v1/pair/devices', headers: browser, loopback: false }));

    // Assert
    should(jsonBody(fromBrowser)).deepEqual({
      devices: [device(deviceOneId, 'Pixel 8'), device(deviceTwoId, 'iPad')],
      hostLocal: true,
      thisDeviceId: deviceOneId,
    });
    // The host's admin credential is not a paired device, so there is no grant of its own to mark.
    should(jsonBody(fromHostCli).thisDeviceId).be.undefined();
    should(jsonBody(fromRemote).hostLocal).be.false();
    // A digest is the only thing between a leaked state file and a forged credential. It is not here.
    should(fromBrowser.body).not.containEql('tokenHash');
  });

  it('should revoke one device and answer with the remaining list', async () => {
    const subject = new FakePairing();
    const surface = await mount(subject);

    const removed = await surface.dispatch(
      request({ method: 'DELETE', path: `/v1/pair/devices/${deviceTwoId}`, headers: browser, loopback: true }),
    );
    const again = await surface.dispatch(
      request({ method: 'DELETE', path: `/v1/pair/devices/${deviceTwoId}`, headers: browser, loopback: true }),
    );
    const malformed = await surface.dispatch(
      request({ method: 'DELETE', path: '/v1/pair/devices/not-an-id', headers: browser, loopback: true }),
    );

    should(removed.status).equal(200);
    should(jsonBody(removed)).deepEqual({
      devices: [device(deviceOneId, 'Pixel 8')],
      hostLocal: true,
      thisDeviceId: deviceOneId,
    });
    should(subject.revokedDevices).deepEqual([deviceTwoId]);
    // Already gone is a 404 rather than a cheerful success: "revoked" and "there was nothing here"
    // are different answers, and a screen that cannot tell them apart claims doors it never closed.
    should(again.status).equal(404);
    should(malformed.status).equal(404);
    should(jsonBody(malformed).code).equal('pairing_device_not_found');
  });

  it('should govern the device list and its revocation exactly as it governs the mint', async () => {
    // Arrange — the operator has switched pairing off for callers who are not on this host.
    const subject = new FakePairing();
    const surface = await mount(subject, false);

    // Act — a caller that did NOT arrive over loopback, which is the only caller grants govern.
    const listing = await surface.dispatch(request({ path: '/v1/pair/devices', headers: browser, loopback: false }));
    const revoking = await surface.dispatch(
      request({ method: 'DELETE', path: `/v1/pair/devices/${deviceTwoId}`, headers: browser, loopback: false }),
    );

    // Assert
    should([listing.status, revoking.status]).deepEqual([403, 403]);
    should(subject.revokedDevices).deepEqual([]);
  });

  it('should refuse the warden every pairing operation, whatever the operator granted', async () => {
    // The warden token is capability-scoped supervision. Nothing about supervising sessions needs the
    // ability to hand out credentials for the machine, and a grant cannot widen a scope.
    // Arrange
    const subject = new FakePairing();
    const surface = await mount(subject);
    const warden = { authorization: 'Bearer warden-secret' };

    // Act
    const minting = await surface.dispatch(
      request({ method: 'POST', path: '/v1/pair/code', headers: warden, loopback: true }),
    );
    const listing = await surface.dispatch(request({ path: '/v1/pair/devices', headers: warden, loopback: true }));

    // Assert
    should([minting.status, listing.status]).deepEqual([403, 403]);
  });

  it('should use separate fail-closed buckets when the transport cannot identify a peer', async () => {
    const subject = new FakePairing();
    const surface = await mount(subject);

    await surface.dispatch(request({ method: 'POST', path: '/v1/pair', loopback: true, body: '{}' }));
    await surface.dispatch(request({ method: 'POST', path: '/v1/pair', body: '{}' }));

    should(subject.redemptions.map(call => call.key)).deepEqual(['loopback-unknown', 'remote-unknown']);
  });
});
