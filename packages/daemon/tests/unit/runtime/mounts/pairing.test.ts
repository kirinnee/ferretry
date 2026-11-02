import { describe, it } from 'bun:test';
import {
  type CapabilityGrants,
  FULL_DEVICE_GRANTS,
  LIMITED_DEVICE_GRANTS,
  type PairedDevice,
  type PairingCodeMintResponse,
  type PairingCodeStatusResponse,
  type PairingGrantSet,
  type PairingId,
} from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher, ApiRouter, type StepUpWitness } from '../../../../src/lib/api/index.ts';
import { DEFAULT_CAPABILITY_GRANTS } from '../../../../src/lib/grants/index.ts';
import { type PairingSubsystem, pairingRoutes } from '../../../../src/lib/runtime/mounts/pairing.ts';
import { jsonBody, request } from '../../api/support.ts';
import { deviceGrantsOver, grantSubsystem } from './support.ts';

const daemonId = `fy_daemon_${'a'.repeat(43)}`;
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
const device = (id: string, name: string): PairedDevice => ({
  id,
  name,
  platform: 'browser',
  createdAt: '2026-08-01T09:00:00.000Z',
  lastSeenAt: '2026-08-03T11:58:00.000Z',
  idleExpiresAt: '2026-09-02T11:58:00.000Z',
  grants: LIMITED_DEVICE_GRANTS,
});

class FakePairing implements PairingSubsystem {
  readonly revoked: PairingId[] = [];
  readonly revokedDevices: string[] = [];
  /** Who each revocation was asked by, as the dispatcher derived it. */
  readonly revokers: string[] = [];
  observation: PairingCodeStatusResponse | undefined = {
    pairingId,
    status: 'pending',
    expiresAt: minted.expiresAt,
  };
  granted: PairedDevice[] = [device(deviceOneId, 'Pixel 8'), device(deviceTwoId, 'iPad')];

  /** How many codes the subsystem was actually asked for, so a refusal at the boundary is visible. */
  mints = 0;

  /** What each mint asked a redeeming device to hold. */
  readonly grantSets: PairingGrantSet[] = [];

  mint(grants: PairingGrantSet): PairingCodeMintResponse {
    this.mints += 1;
    this.grantSets.push(grants);
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

  async revokeDevice(id: string, actor: string): Promise<boolean> {
    const remaining = this.granted.filter(entry => entry.id !== id);
    // Records what was actually taken away rather than what was asked, so a fixture can tell a
    // revocation that happened from one the route refused or found nothing to do.
    if (remaining.length === this.granted.length) return false;
    this.revokedDevices.push(id);
    this.revokers.push(actor);
    this.granted = remaining;
    return true;
  }
}

const credentials = {
  admin: 'admin-secret',
  warden: 'warden-secret',
  devices: {
    has: (deviceId: string) => deviceId !== 'unpaired-device',
    // Every capability: these tests are about the daemon-wide grant and the step-up, and the per-device
    // half has its own file (`device-grants.test.ts`).
    grants: (deviceId: string) => (deviceId === 'unpaired-device' ? undefined : DEFAULT_CAPABILITY_GRANTS),
  },
};

const admin = { authorization: 'Bearer admin-secret' };
/** A paired browser: whoever its session proved. It sends no credential of its own. */
const browser = { deviceId: deviceOneId, appSession: 'app-one' } as const;
/**
 * A paired browser ON THE HOST: loopback AND the carrier's host proof. It is still an ordinary governed
 * device (B4): a tunnel to a loopback-only bind is indistinguishable from it. Only the host's admin token
 * over loopback is the owner.
 */
const localBrowser = { device: browser, loopback: true, privilegedLoopback: true } as const;
/**
 * A device that has just confirmed WITH A PASSKEY: its step-up is held and the proof is fresh — what
 * minting a code, an act that adds access, needs. The unlock alone is {@link UNLOCKED_ONLY}.
 */
const PASSKEY_CONFIRMED: StepUpWitness = { held: () => true, freshlyHeld: () => true };
/** An unlocked device that has not confirmed THIS act: its step-up is held, no fresh proof is. */
const UNLOCKED_ONLY: StepUpWitness = { held: () => true };
/** A device holding a current passkey step-up, for the cases about what a route does, not who may ask. */
const confirmedStepUp: StepUpWitness = PASSKEY_CONFIRMED;

/**
 * The mount over the REAL grant subsystem.
 *
 * Real rather than a stub guard, because the property under test is that these routes are governed by
 * the same object the operator's document feeds — a fake guard would let this file pass while the
 * daemon enforced something else. `pairing` is permissive by default, so `allow: false` is how a fixture
 * states that the operator switched it off.
 */
async function mount(
  subject: PairingSubsystem,
  allow = true,
  stepUps?: StepUpWitness,
  /** What the paired browser itself holds, before the daemon-wide document; every capability by default. */
  ownGrants: CapabilityGrants = DEFAULT_CAPABILITY_GRANTS,
) {
  const grants = grantSubsystem({
    grants: { ...DEFAULT_CAPABILITY_GRANTS, pairing: { use: allow, configure: allow } },
  });
  await grants.refresh();
  return new ApiDispatcher(
    new ApiRouter(pairingRoutes(subject, deviceGrantsOver(grants))),
    {
      ...credentials,
      devices: { ...credentials.devices, grants: (id: string) => (id === 'unpaired-device' ? undefined : ownGrants) },
    },
    grants,
    undefined,
    stepUps,
  );
}

describe('pairing routes', () => {
  it('should serve no redemption at all: the plain-HTTP POST /v1/pair is gone', async () => {
    // Redemption happens only inside a session whose daemon was proved against the QR fingerprint, so
    // nothing on this surface is public any more. An anonymous caller there is an app from before
    // device keys, so it is told to update rather than that its code is wrong; the host's own token
    // finds no route there at all.
    const surface = await mount(new FakePairing());
    const body = JSON.stringify({ code: '7F3K-Q2ND', deviceName: 'phone' });

    const anonymous = await surface.dispatch(request({ method: 'POST', path: '/v1/pair', body }));
    const host = await surface.dispatch(
      request({ method: 'POST', path: '/v1/pair', headers: admin, loopback: true, body }),
    );

    should(anonymous.status).equal(426);
    should(host.status).equal(404);
  });

  it('should let a BROWSER on this host mint once it has confirmed with a passkey, which the host scope never could', async () => {
    // THE WHOLE POINT OF THE SCOPE MOVE. A browser is always a paired device — that is how it got a
    // credential at all — so under `host` scope the UI could not add a second device from the machine
    // itself. It is governed like any device (B4), so it confirms with a passkey first, and then mints.
    // Arrange
    const subject = new FakePairing();
    const surface = await mount(subject);
    const confirmed = await mount(subject, true, confirmedStepUp);

    // Act
    const anonymous = await surface.dispatch(request({ method: 'POST', path: '/v1/pair/code', loopback: true }));
    const unconfirmed = await surface.dispatch(request({ method: 'POST', path: '/v1/pair/code', ...localBrowser }));
    const fromBrowser = await confirmed.dispatch(request({ method: 'POST', path: '/v1/pair/code', ...localBrowser }));
    const fromHostCli = await surface.dispatch(
      request({ method: 'POST', path: '/v1/pair/code', loopback: true, headers: admin }),
    );

    // Assert
    should(anonymous.status).equal(401);
    should(jsonBody(unconfirmed).code).equal('grant_step_up_required');
    should(fromBrowser.status).equal(201);
    should(fromHostCli.status).equal(201);
    should(fromBrowser.headers.get('cache-control')).equal('no-store');
    should(jsonBody(fromBrowser)).deepEqual(minted);
  });

  it('should hold a REMOTE mint behind the passkey step-up, and release it once the device has confirmed', async () => {
    // THE GOVERNED MINT. A phone adding another device is handing out a credential, so the policy holds
    // `pairing.use` behind a step-up even when the operator's grant says yes. The code never runs
    // without one — the refusal is the boundary's, and the subsystem is not even asked.
    // Arrange
    const subject = new FakePairing();
    const remote = { method: 'POST' as const, path: '/v1/pair/code', device: browser, loopback: false };

    // Act
    const unconfirmed = await (await mount(subject)).dispatch(request(remote));
    const confirmed = await (await mount(subject, true, PASSKEY_CONFIRMED)).dispatch(request(remote));

    // Assert
    should(unconfirmed.status).equal(403);
    should(jsonBody(unconfirmed).code).equal('grant_step_up_required');
    should(subject.mints).equal(1);
    should(confirmed.status).equal(201);
    should(jsonBody(confirmed)).deepEqual(minted);
  });

  it('should ask only the owner at the machine for no step-up at all, however the operator set pairing', async () => {
    // The owner — the host's admin token over loopback — already has the machine, so neither the grant
    // nor the step-up stands in front of `fy pair`. A browser on this host is not the owner: the
    // operator's "pairing off" binds it as it binds a phone (B4).
    // Arrange
    const subject = new FakePairing();
    const surface = await mount(subject, false);

    // Act
    const fromHostCli = await surface.dispatch(
      request({ method: 'POST', path: '/v1/pair/code', loopback: true, headers: admin }),
    );
    const fromLocalBrowser = await surface.dispatch(
      request({ method: 'POST', path: '/v1/pair/code', ...localBrowser }),
    );
    // A loopback peer WITHOUT the host proof is a proxied remote phone, and is governed like one.
    const fromProxiedPhone = await surface.dispatch(
      request({ method: 'POST', path: '/v1/pair/code', loopback: true, device: browser }),
    );

    // Assert
    should(fromHostCli.status).equal(201);
    should(fromLocalBrowser.status).equal(403);
    should(fromProxiedPhone.status).equal(403);
  });

  it('should hold the device list behind the same step-up for a remote caller, and never a revocation (C31)', async () => {
    // Listing is `pairing.use` too: a stolen, unconfirmed phone can neither mint nor read who else holds a
    // key. REVOKING only takes away, so with "ask again for each act" on it asks no passkey of its own: taking
    // access away is never harder than having it. The host still lists and revokes with nothing asked.
    // Arrange
    const subject = new FakePairing();
    const surface = await mount(subject);
    const remote = { device: browser, loopback: false };

    // Act
    const listed = await surface.dispatch(request({ path: '/v1/pair/devices', ...remote }));
    const revoked = await surface.dispatch(
      request({ method: 'DELETE', path: `/v1/pair/devices/${deviceTwoId}`, ...remote }),
    );
    const host = await surface.dispatch(request({ path: '/v1/pair/devices', loopback: true, headers: admin }));

    // Assert
    should([listed.status, revoked.status, host.status]).deepEqual([403, 200, 200]);
    should(subject.revokedDevices).deepEqual([deviceTwoId]);
  });

  it('should let a REMOTE browser mint once confirmed, and explain it when the operator switched pairing off', async () => {
    // Adding a device from a phone is the case the owner asked for, so the default is permissive. The
    // protection is elsewhere: a remote caller may switch `pairing` off and can never switch it back on
    // — enforced by the grant layer, tested there. What this proves is the two answers this mount gives.
    // Arrange
    const subject = new FakePairing();
    const remote = { method: 'POST' as const, path: '/v1/pair/code', device: browser, loopback: false };
    const confirmed = PASSKEY_CONFIRMED;

    // Act
    const allowed = await (await mount(subject, true, confirmed)).dispatch(request(remote));
    const refused = await (await mount(subject, false, confirmed)).dispatch(request(remote));

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
    const surface = await mount(subject, true, confirmedStepUp);
    const path = `/v1/pair/code/${pairingId}`;

    const local = await surface.dispatch(request({ path, ...localBrowser }));
    subject.observation = undefined;
    const absent = await surface.dispatch(request({ path, ...localBrowser }));
    const malformed = await surface.dispatch(request({ path: '/v1/pair/code/not-an-id', ...localBrowser }));

    should(local.status).equal(200);
    should(local.headers.get('cache-control')).equal('no-store');
    should(local.body).not.containEql('7F3K-Q2ND');
    should(absent.status).equal(404);
    should(malformed.status).equal(404);
    should(absent.body).equal(malformed.body);
  });

  it('should revoke a live code by its pairing id and answer 404 for an id it never minted', async () => {
    const subject = new FakePairing();
    const surface = await mount(subject, true, confirmedStepUp);
    const path = `/v1/pair/code/${pairingId}`;

    const revoked = await surface.dispatch(request({ method: 'DELETE', path, ...localBrowser }));
    subject.observation = undefined;
    const unknown = await surface.dispatch(request({ method: 'DELETE', path, ...localBrowser }));
    const malformed = await surface.dispatch(
      request({ method: 'DELETE', path: '/v1/pair/code/not-an-id', ...localBrowser }),
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
    const surface = await mount(subject, true, confirmedStepUp);

    // Act
    const fromBrowser = await surface.dispatch(request({ path: '/v1/pair/devices', ...localBrowser }));
    const fromHostCli = await surface.dispatch(request({ path: '/v1/pair/devices', headers: admin, loopback: true }));
    // A remote caller reads the list only once confirmed, and is told it is NOT on the host.
    const confirmed = await mount(subject, true, PASSKEY_CONFIRMED);
    const fromRemote = await confirmed.dispatch(
      request({ path: '/v1/pair/devices', device: browser, loopback: false }),
    );

    // Assert
    should(jsonBody(fromBrowser)).deepEqual({
      devices: [device(deviceOneId, 'Pixel 8'), device(deviceTwoId, 'iPad')],
      // A browser on this host is not the owner (B4), so it is not told it is at the machine.
      hostLocal: false,
      thisDeviceId: deviceOneId,
      // At the machine every axis may be given to a device.
      mayWiden: DEFAULT_CAPABILITY_GRANTS,
    });
    // The host's admin credential is not a paired device, so there is no grant of its own to mark.
    should(jsonBody(fromHostCli).thisDeviceId).be.undefined();
    should(jsonBody(fromHostCli).hostLocal).be.true();
    should(jsonBody(fromRemote).hostLocal).be.false();
    // A digest is the only thing between a leaked state file and a forged credential. It is not here.
    should(fromBrowser.body).not.containEql('tokenHash');
  });

  it('should never tell a loopback peer behind a local proxy that it is at this machine', async () => {
    // A remote caller forwarded by `tailscale serve`, `cloudflared` or `ssh -L` arrives from a loopback
    // peer on a bind that is not loopback-only. It used to read "you are at this machine".
    // Arrange
    const confirmed = await mount(new FakePairing(), true, PASSKEY_CONFIRMED);

    // Act
    const proxied = await confirmed.dispatch(request({ path: '/v1/pair/devices', device: browser, loopback: true }));
    const hostCli = await confirmed.dispatch(request({ path: '/v1/pair/devices', headers: admin, loopback: true }));

    // Assert
    should(jsonBody(proxied).hostLocal).be.false();
    should(jsonBody(hostCli).hostLocal).be.true();
  });

  it('should revoke one device and answer with the remaining list', async () => {
    const subject = new FakePairing();
    const surface = await mount(subject, true, confirmedStepUp);

    const removed = await surface.dispatch(
      request({ method: 'DELETE', path: `/v1/pair/devices/${deviceTwoId}`, ...localBrowser }),
    );
    const again = await surface.dispatch(
      request({ method: 'DELETE', path: `/v1/pair/devices/${deviceTwoId}`, ...localBrowser }),
    );
    const malformed = await surface.dispatch(
      request({ method: 'DELETE', path: '/v1/pair/devices/not-an-id', ...localBrowser }),
    );

    should(removed.status).equal(200);
    should(jsonBody(removed)).deepEqual({
      devices: [device(deviceOneId, 'Pixel 8')],
      hostLocal: false,
      thisDeviceId: deviceOneId,
      // At the machine every axis may be given to a device.
      mayWiden: DEFAULT_CAPABILITY_GRANTS,
    });
    should(subject.revokedDevices).deepEqual([deviceTwoId]);
    // Already gone is a 404 rather than a cheerful success: "revoked" and "there was nothing here"
    // are different answers, and a screen that cannot tell them apart claims doors it never closed.
    should(again.status).equal(404);
    should(malformed.status).equal(404);
    should(jsonBody(malformed).code).equal('pairing_device_not_found');
  });

  it('should hand the revocation to the subsystem under the server-derived actor, never a claimed one', async () => {
    // Arrange
    const subject = new FakePairing();
    const surface = await mount(subject, true, confirmedStepUp);

    // Act
    const byOwner = await surface.dispatch(
      request({
        method: 'DELETE',
        path: `/v1/pair/devices/${deviceTwoId}`,
        headers: { ...admin, 'x-ferretry-client': 'cli' },
        loopback: true,
      }),
    );
    const byDevice = await surface.dispatch(
      request({ method: 'DELETE', path: `/v1/pair/devices/${deviceOneId}`, ...localBrowser }),
    );

    // Assert
    should([byOwner.status, byDevice.status]).deepEqual([200, 200]);
    should(subject.revokers).deepEqual(['admin-cli', `device:${deviceOneId}`]);
  });

  it('should govern the device list and its revocation exactly as it governs the mint', async () => {
    // Arrange — the operator has switched pairing off for callers who are not on this host.
    const subject = new FakePairing();
    const surface = await mount(subject, false);

    // Act — a caller that did NOT arrive over loopback, which is the only caller grants govern.
    const listing = await surface.dispatch(request({ path: '/v1/pair/devices', device: browser, loopback: false }));
    const revoking = await surface.dispatch(
      request({ method: 'DELETE', path: `/v1/pair/devices/${deviceTwoId}`, device: browser, loopback: false }),
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

  it('should mint a full-access code by default for a caller that holds every capability, and a limited one on request', async () => {
    // A new device is FULL by default (owner decision 2026-10-14), so the default mint is `full`.
    // Arrange
    const subject = new FakePairing();
    const surface = await mount(subject, true, PASSKEY_CONFIRMED);

    // Act
    const plain = await surface.dispatch(
      request({ method: 'POST', path: '/v1/pair/code', device: browser, loopback: false }),
    );
    const limited = await surface.dispatch(
      request({
        method: 'POST',
        path: '/v1/pair/code',
        device: browser,
        loopback: false,
        body: JSON.stringify({ grants: 'limited' }),
      }),
    );

    // Assert
    should([plain.status, limited.status]).deepEqual([201, 201]);
    should(subject.grantSets).deepEqual(['full', 'limited']);
  });

  it('should mint a full-access code at the machine whatever the grants say, and over a device that holds everything', async () => {
    // Arrange
    const subject = new FakePairing();
    const surface = await mount(subject, true, PASSKEY_CONFIRMED, FULL_DEVICE_GRANTS);
    const full = JSON.stringify({ grants: 'full' });

    // Act
    const atHost = await surface.dispatch(
      request({ method: 'POST', path: '/v1/pair/code', loopback: true, headers: admin, body: full }),
    );
    const byHolder = await surface.dispatch(
      request({ method: 'POST', path: '/v1/pair/code', device: browser, loopback: false, body: full }),
    );

    // Assert
    should([atHost.status, byHolder.status]).deepEqual([201, 201]);
    should(subject.grantSets).deepEqual(['full', 'full']);
  });

  it('should refuse a remote full mint by a device that does not hold every capability: 403 grant_forbidden', async () => {
    // A device may pass on only what it holds, by the rule a device widen reads (`mayWiden`).
    // Arrange
    const subject = new FakePairing();
    const holdsMostButNotSecrets: CapabilityGrants = {
      ...FULL_DEVICE_GRANTS,
      secrets: { use: true, configure: false },
    };
    const pairsOnly: CapabilityGrants = { ...LIMITED_DEVICE_GRANTS, pairing: { use: true, configure: true } };
    const limitedDevice = await mount(subject, true, PASSKEY_CONFIRMED, pairsOnly);
    const almostEverything = await mount(subject, true, PASSKEY_CONFIRMED, holdsMostButNotSecrets);
    const full = JSON.stringify({ grants: 'full' });
    const ask = { method: 'POST' as const, path: '/v1/pair/code', body: full };

    // Act
    const byLimited = await limitedDevice.dispatch(request({ ...ask, device: browser, loopback: false }));
    const byAlmost = await almostEverything.dispatch(request({ ...ask, device: browser, loopback: false }));
    // A loopback peer without the host proof is not the machine either, and a browser on the host is an
    // ordinary device: both are judged by what the device holds.
    const proxied = await limitedDevice.dispatch(request({ ...ask, device: browser, loopback: true }));

    // Assert
    should([byLimited.status, byAlmost.status, proxied.status]).deepEqual([403, 403, 403]);
    should(jsonBody(byLimited).code).equal('grant_forbidden');
    should(jsonBody(byAlmost).code).equal('grant_forbidden');
    should(subject.grantSets).deepEqual([]);
  });

  it('should let a device that holds only some capabilities mint a limited code, and refuse a device with no pairing at all', async () => {
    // Arrange
    const subject = new FakePairing();
    const pairsOnly: CapabilityGrants = { ...LIMITED_DEVICE_GRANTS, pairing: { use: true, configure: true } };
    const asker = (ownGrants: CapabilityGrants) =>
      mount(subject, true, PASSKEY_CONFIRMED, ownGrants).then(surface =>
        surface.dispatch(
          request({
            method: 'POST',
            path: '/v1/pair/code',
            device: browser,
            loopback: false,
            body: JSON.stringify({ grants: 'limited' }),
          }),
        ),
      );

    // Act
    const pairer = await asker(pairsOnly);
    const fleetOnly = await asker(LIMITED_DEVICE_GRANTS);

    // Assert — a device with no `pairing.use` is stopped at the boundary, before the route ever asks what it holds.
    should([pairer.status, fleetOnly.status]).deepEqual([201, 403]);
    should(jsonBody(fleetOnly).code).equal('grant_device_not_granted');
    should(subject.grantSets).deepEqual(['limited']);
  });
});

describe('adding a device always wants a passkey proved for it', () => {
  /*
   * OWNER DECISION 2026-10-14: minting a pairing code needs a FRESH per-act step-up from a device — even
   * an unlocked one, even with `stepUpOnActions` off. The unlock alone must never be enough to put
   * another device on this machine. The machine itself (its admin token, on the host) is never asked.
   */
  const mint = { method: 'POST' as const, path: '/v1/pair/code', device: browser, loopback: false };

  it('should refuse an unlocked device that has not confirmed THIS act, naming the act', async () => {
    // Arrange
    const subject = new FakePairing();

    // Act
    const response = await (await mount(subject, true, UNLOCKED_ONLY)).dispatch(request(mint));

    // Assert
    should(response.status).equal(403);
    should(jsonBody(response).code).equal('grant_step_up_required');
    should(jsonBody(response).demand).deepEqual({ capability: 'pairing', axis: 'use', act: 'add-device' });
    should(subject.mints).equal(0);
  });

  it('should mint once the device has confirmed with a passkey, and spend that proof on the one code', async () => {
    // Arrange
    const subject = new FakePairing();
    let spent = 0;
    const witness: StepUpWitness = {
      ...PASSKEY_CONFIRMED,
      spendFresh: () => {
        spent += 1;
      },
    };

    // Act
    const response = await (await mount(subject, true, witness)).dispatch(request(mint));

    // Assert
    should(response.status).equal(201);
    should(subject.mints).equal(1);
    should(spent).equal(1);
  });

  it('should never ask the machine itself', async () => {
    // Arrange
    const subject = new FakePairing();

    // Act — the host's admin token, on loopback, with no step-up of any kind.
    const response = await (
      await mount(subject)
    ).dispatch(request({ method: 'POST', path: '/v1/pair/code', loopback: true, headers: admin }));

    // Assert
    should(response.status).equal(201);
    should(subject.mints).equal(1);
  });
});

describe('a pairing route reached without a presentation of its caller', () => {
  it('should refuse rather than guess who is asking, for the device list and for minting', async () => {
    // Arrange — the dispatcher always supplies a presentation, so the handlers are asked directly.
    const grants = grantSubsystem();
    await grants.refresh();
    const routes = pairingRoutes(new FakePairing(), deviceGrantsOver(grants));
    const asked = routes.filter(
      route => (route.method === 'GET' && route.path === '/v1/pair/devices') || route.method === 'POST',
    );
    const mint = asked.find(route => route.path === '/v1/pair/code');
    const list = asked.find(route => route.path === '/v1/pair/devices');
    if (mint === undefined || list === undefined) throw new Error('the pairing routes must be mounted');

    // Act + Assert
    for (const route of [list, mint])
      await Promise.resolve(
        route.handle({ request: request({ method: route.method, path: route.path }), params: new Map() }),
      ).should.be.rejectedWith({
        status: 500,
        code: 'internal_error',
      });
  });
});
