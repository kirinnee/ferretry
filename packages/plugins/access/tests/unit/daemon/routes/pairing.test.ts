import { describe, it } from 'bun:test';
import should from 'should';
import { NARROW, USE } from '../../../../contract/index.ts';
import {
  DEFAULT_CAPABILITY_GRANTS,
  DeviceGrantService,
  decideCapability,
  type GrantAuditEntry,
} from '../../../../daemon/lib/grants/index.ts';
import { type PairingSubsystem, pairingRoutes } from '../../../../daemon/lib/routes/pairing.ts';
import {
  type ApiRoute,
  type CapabilityGrants,
  capabilityNamed,
  type DaemonId,
  FULL_DEVICE_GRANTS,
  LIMITED_DEVICE_GRANTS,
  type PairedDevice,
  type PairingCodeMintResponse,
  type PairingCodeStatusResponse,
  type PairingGrantSet,
  type PairingId,
} from '../../../../daemon/lib/wire.ts';
import manifest from '../../../../manifest.ts';
import { type CallOverrides, call, jsonBody, respond } from '../../../support/daemon/call.ts';

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
  grants: 'full',
} as PairingCodeMintResponse;
const device = (id: string, name: string): PairedDevice =>
  ({
    id,
    name,
    platform: 'browser',
    createdAt: '2026-08-01T09:00:00.000Z',
    lastSeenAt: '2026-08-03T11:58:00.000Z',
    idleExpiresAt: '2026-09-02T11:58:00.000Z',
    grants: LIMITED_DEVICE_GRANTS,
  }) as PairedDevice;

class FakePairing implements PairingSubsystem {
  readonly daemonId = daemonId as DaemonId;
  readonly revoked: PairingId[] = [];
  readonly revokedDevices: string[] = [];
  /** Who each revocation was asked by, as Gate derived it. */
  readonly revokers: string[] = [];
  observation: PairingCodeStatusResponse | undefined = {
    pairingId,
    status: 'pending',
    expiresAt: minted.expiresAt,
  } as PairingCodeStatusResponse;
  granted: PairedDevice[] = [device(deviceOneId, 'Pixel 8'), device(deviceTwoId, 'iPad')];

  /** How many codes the subsystem was actually asked for, so a refusal before it is visible. */
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
    return { pairingId: id, status: 'expired', expiresAt: minted.expiresAt } as PairingCodeStatusResponse;
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

/** A paired browser: whoever its session proved. It sends no credential of its own. */
const browser = { deviceId: deviceOneId, appSession: 'app-one' } as const;

/**
 * Today's step-up witness, as the presentation Gate stamps: `held` is `stepUp`, `freshlyHeld` is `freshStepUp`.
 * A device that has just confirmed WITH A PASSKEY holds both — what minting a code, an act that adds access, needs.
 */
const PASSKEY_CONFIRMED = { stepUp: true, freshStepUp: true } as const;
/** An unlocked device that has not confirmed THIS act: its step-up is held, no fresh proof is. */
const UNLOCKED_ONLY = { stepUp: true } as const;

/**
 * The routes over the REAL device-grant service, with the daemon-wide document as Gate holds it. `pairing` is
 * permissive by default, so `allow: false` is how a fixture states that the operator switched it off.
 */
function mount(
  subject: PairingSubsystem,
  allow = true,
  devices: Map<string, CapabilityGrants> = new Map([
    [deviceOneId, DEFAULT_CAPABILITY_GRANTS],
    [deviceTwoId, LIMITED_DEVICE_GRANTS],
  ]),
  audit: GrantAuditEntry[] = [],
): readonly ApiRoute[] {
  const daemonWide = { ...DEFAULT_CAPABILITY_GRANTS, pairing: { use: allow, configure: allow } };
  return pairingRoutes(
    subject,
    new DeviceGrantService({
      devices: {
        deviceGrants: id => devices.get(id),
        setDeviceGrants: async (id, next) => {
          if (!devices.has(id)) return false;
          devices.set(id, next);
          return true;
        },
      },
      daemonWide: () => daemonWide,
      audit: {
        record: async entry => {
          audit.push(entry);
        },
        recent: async () => ({ entries: [], unreadable: 0, truncated: false }),
      },
      clock: { nowMs: () => 1_700_000_000_000 },
      clientName: 'fy',
    }),
  );
}

/** The owner at the machine: the host's admin token, through the kernel's own listener. */
const atHost: CallOverrides = { host: true };
/** A paired device, governed wherever it runs (B4), holding `own` and the presentation given. */
const fromDevice = (
  own: CapabilityGrants = DEFAULT_CAPABILITY_GRANTS,
  presentation: CallOverrides['presentation'] = {},
): CallOverrides => ({ device: browser, deviceGrants: own, presentation });

const declared = (key: string) => {
  const route = manifest.actions.routes.find(candidate => candidate.key === key);
  if (route === undefined) throw new Error(`the manifest must declare ${key}`);
  return route;
};

describe('pairing routes as declared (the boundary Gate enforces)', () => {
  it('P16 the code, device and identity routes require the operator minimum plus pairing.use, from a person', () => {
    for (const key of [
      'POST /v1/pair/code',
      'GET /v1/pair/code/:pairingId',
      'DELETE /v1/pair/code/:pairingId',
      'GET /v1/pair/devices',
      'DELETE /v1/pair/devices/:deviceId',
      'PATCH /v1/pair/devices/:deviceId/grants',
      'GET /v1/pair/identity',
    ]) {
      const route = declared(key);
      should(route.minimum).equal('operator');
      should(route.caller).equal('person');
      should(route.noStore).equal(true);
      should(route.capability?.capability).equal(capabilityNamed('pairing'));
      should(route.capability?.axis).equal('use');
    }
  });

  it('G51 pairing routes sit at the operator minimum with a pairing demand, and only the admin token at the machine mints without the grant or a step-up', async () => {
    // The demand is Gate's to enforce for every governed caller; the handler adds the per-act passkey for a device.
    should(declared('POST /v1/pair/code').capability).deepEqual(USE.pairing);
    const subject = new FakePairing();
    const fromHostCli = await respond(mount(subject, false), 'POST /v1/pair/code', atHost);
    const fromDeviceUnconfirmed = await respond(mount(subject), 'POST /v1/pair/code', fromDevice());
    should(fromHostCli.status).equal(201);
    should(jsonBody(fromDeviceUnconfirmed).code).equal('grant_step_up_required');
    should(subject.mints).equal(1);
  });

  it('G54 ending a code and revoking a device are both on the use axis', () => {
    should(declared('DELETE /v1/pair/code/:pairingId').capability).deepEqual(USE.pairing);
    should(declared('DELETE /v1/pair/devices/:deviceId').capability).deepEqual(NARROW.pairing);
    for (const key of ['DELETE /v1/pair/code/:pairingId', 'DELETE /v1/pair/devices/:deviceId'])
      should(declared(key).capability?.axis).equal('use');
  });

  it('P126 revoking a device carries the pairing.use demand as a narrowing, never a configure', () => {
    should(declared('DELETE /v1/pair/devices/:deviceId').capability).deepEqual({
      capability: capabilityNamed('pairing'),
      axis: 'use',
      narrowing: true,
    });
  });

  it('P56 the mint demands pairing.use, which Gate reads against the device’s own grants as well as the daemon-wide ones', () => {
    // effective = daemon-wide ∧ device: a device whose own record lacks pairing.use is refused before the handler.
    const demand = declared('POST /v1/pair/code').capability;
    if (demand === undefined) throw new Error('the mint must carry a demand');
    const fleetOnly = decideCapability(demand, {
      grants: DEFAULT_CAPABILITY_GRANTS,
      governed: true,
      hostLocal: false,
      stepUp: true,
      device: LIMITED_DEVICE_GRANTS,
    });
    should(fleetOnly).deepEqual({ allowed: false, refusal: 'device-not-granted' });
  });

  it('P119 a governed caller with no proven device is refused a revocation, though a narrowing asks no step-up', () => {
    // Today's admin token off loopback, or a remote warden: no device stood behind the narrowing.
    const demand = declared('DELETE /v1/pair/devices/:deviceId').capability;
    if (demand === undefined) throw new Error('the revoke must carry a demand');
    const noDevice = decideCapability(demand, {
      grants: DEFAULT_CAPABILITY_GRANTS,
      governed: true,
      hostLocal: false,
      stepUp: false,
    });
    const device = decideCapability(demand, {
      grants: DEFAULT_CAPABILITY_GRANTS,
      governed: true,
      hostLocal: false,
      stepUp: false,
      device: DEFAULT_CAPABILITY_GRANTS,
    });
    should(noDevice.allowed).be.false();
    should(device.allowed).be.true();
  });

  it('P21 nothing on the pairing surface is public, and POST /v1/pair is not a route', () => {
    const keys = manifest.actions.routes.map(route => route.key);
    should(keys).not.containEql('POST /v1/pair');
    should(
      manifest.actions.routes.filter(route => route.path.startsWith('/v1/pair')).map(route => route.minimum),
    ).matchEach('operator');
    should(mount(new FakePairing()).some(route => route.method === 'POST' && route.path === '/v1/pair')).be.false();
  });

  it('R569 the pair record is the only redemption: no route in the manifest or the handler table redeems a code', () => {
    should(manifest.actions.routes.some(route => (route.key as string) === 'POST /v1/pair')).be.false();
    should(mount(new FakePairing()).map(route => `${route.method} ${route.path}`)).not.containEql('POST /v1/pair');
  });

  it('G53 pairing governs minting, never redemption: every route with a pairing demand mints, reads or revokes', () => {
    const governed = manifest.actions.routes
      .filter(route => route.capability?.capability === capabilityNamed('pairing'))
      .map(route => route.key)
      .sort();
    should(governed).deepEqual(
      [
        'DELETE /v1/pair/code/:pairingId',
        'DELETE /v1/pair/devices/:deviceId',
        'GET /v1/pair/code/:pairingId',
        'GET /v1/pair/devices',
        'GET /v1/pair/identity',
        'PATCH /v1/pair/devices/:deviceId/grants',
        'POST /v1/pair/code',
      ].sort(),
    );
  });

  it('R589 redemption is credentialed by the code alone: no route takes a code, and only the mint is the pairing use that adds access', () => {
    should(manifest.actions.routes.filter(route => route.method === 'POST' && route.path.startsWith('/v1/pair')).map(route => route.key)).deepEqual(['POST /v1/pair/code']);
  });
});

describe('pairing routes', () => {
  it('P19 tells the owner this daemon’s id and nothing else, from a person-only no-store route', async () => {
    // The id is the one the pairing QR already carries; the CLI puts it in a link so the app opens on the right machine.
    const identity = declared('GET /v1/pair/identity');
    should(identity.caller).equal('person');
    should(identity.noStore).equal(true);

    const owner = await respond(mount(new FakePairing()), 'GET /v1/pair/identity', atHost);

    should(owner.status).equal(200);
    should(jsonBody(owner)).deepEqual({ daemonId });
  });

  it('P54 a browser on this host is an ordinary governed device: it mints once confirmed with a passkey, the host CLI with nothing', async () => {
    // A browser is always a paired device — that is how it got a credential at all — so it is governed like any
    // device (B4), confirms with a passkey first, and then mints.
    // Arrange
    const subject = new FakePairing();
    const routes = mount(subject);

    // Act
    const unconfirmed = await respond(routes, 'POST /v1/pair/code', fromDevice());
    const fromBrowser = await respond(routes, 'POST /v1/pair/code', fromDevice(undefined, PASSKEY_CONFIRMED));
    const fromHostCli = await respond(routes, 'POST /v1/pair/code', atHost);

    // Assert
    should(jsonBody(unconfirmed).code).equal('grant_step_up_required');
    should(fromBrowser.status).equal(201);
    should(fromHostCli.status).equal(201);
    should(jsonBody(fromBrowser)).deepEqual(minted);
  });

  it('P61 holds a REMOTE mint behind the passkey step-up, and releases it once the device has confirmed', async () => {
    // A phone adding another device is handing out a credential. The code never runs without the proof.
    // Arrange
    const subject = new FakePairing();

    // Act
    const unconfirmed = await respond(mount(subject), 'POST /v1/pair/code', fromDevice());
    const confirmed = await respond(mount(subject), 'POST /v1/pair/code', fromDevice(undefined, PASSKEY_CONFIRMED));

    // Assert
    should(unconfirmed.status).equal(403);
    should(jsonBody(unconfirmed).code).equal('grant_step_up_required');
    should(jsonBody(unconfirmed).demand).deepEqual({ capability: 'pairing', axis: 'use', act: 'add-device' });
    should(subject.mints).equal(1);
    should(confirmed.status).equal(201);
    should(jsonBody(confirmed)).deepEqual(minted);
  });

  it('P44 a full device is still narrowed by the daemon-wide document: with pairing off there, it cannot pass on full access', async () => {
    // The owner at the machine is narrowed by neither document; a device is, whatever its own record says.
    // Arrange
    const subject = new FakePairing();
    const routes = mount(subject, false);

    // Act
    const fromHostCli = await respond(routes, 'POST /v1/pair/code', atHost);
    const fromFullDevice = await respond(
      routes,
      'POST /v1/pair/code',
      fromDevice(FULL_DEVICE_GRANTS, PASSKEY_CONFIRMED),
    );

    // Assert
    should(fromHostCli.status).equal(201);
    should(fromFullDevice.status).equal(403);
    should(jsonBody(fromFullDevice).code).equal('grant_forbidden');
    should(subject.grantSets).deepEqual(['full']);
  });

  it('P118 revokes a device for a paired device with only pairing.use, never a per-act passkey', async () => {
    // REVOKING only takes away, so it asks no passkey of its own: taking access away is never harder than having
    // it. The boundary's pairing.use (a narrowing) is Gate's; the handler asks nothing more.
    // Arrange
    const subject = new FakePairing();

    // Act
    const revoked = await respond(mount(subject), 'DELETE /v1/pair/devices/:deviceId', {
      ...fromDevice(),
      params: { deviceId: deviceTwoId },
    });

    // Assert
    should(revoked.status).equal(200);
    should(subject.revokedDevices).deepEqual([deviceTwoId]);
  });

  it('should reject fields on the bodyless mint contract', async () => {
    const response = await respond(mount(new FakePairing()), 'POST /v1/pair/code', {
      ...atHost,
      body: JSON.stringify({ deviceName: 'phone' }),
    });

    should(response.status).equal(400);
    should(jsonBody(response).code).equal('invalid_request');
  });

  it('P17 reports a minted code’s fate without ever returning the code', async () => {
    const subject = new FakePairing();
    const routes = mount(subject);
    const at = (id: string) => ({ ...fromDevice(), params: { pairingId: id } });

    const local = await respond(routes, 'GET /v1/pair/code/:pairingId', at(pairingId));
    subject.observation = undefined;
    const absent = await respond(routes, 'GET /v1/pair/code/:pairingId', at(pairingId));
    const malformed = await respond(routes, 'GET /v1/pair/code/:pairingId', at('not-an-id'));

    should(local.status).equal(200);
    should(local.body).not.containEql('7F3K-Q2ND');
    should(absent.status).equal(404);
    should(malformed.status).equal(404);
    should(absent.body).equal(malformed.body);
  });

  it('P108 revokes a live code by its pairing id and answers 404 for an id it never minted', async () => {
    const subject = new FakePairing();
    const routes = mount(subject);
    const at = (id: string) => ({ ...fromDevice(), params: { pairingId: id } });

    const revoked = await respond(routes, 'DELETE /v1/pair/code/:pairingId', at(pairingId));
    subject.observation = undefined;
    const unknown = await respond(routes, 'DELETE /v1/pair/code/:pairingId', at(pairingId));
    const malformed = await respond(routes, 'DELETE /v1/pair/code/:pairingId', at('not-an-id'));

    should(revoked.status).equal(200);
    should(jsonBody(revoked)).containDeep({ pairingId, status: 'expired' });
    should(revoked.body).not.containEql('7F3K-Q2ND');
    should(subject.revoked).deepEqual([pairingId]);
    should(unknown.status).equal(404);
    should(malformed.status).equal(404);
  });

  it('P57 lists who may reach this machine, marking the caller’s own device from the server-derived actor', async () => {
    // `thisDeviceId` comes from the server-derived actor, never from anything the caller sent, so a
    // browser cannot point the "this is you" mark at somebody else's grant.
    // Arrange
    const routes = mount(new FakePairing());

    // Act
    const fromBrowser = await respond(routes, 'GET /v1/pair/devices', {
      ...fromDevice(),
      headers: { 'x-ferretry-device': deviceTwoId },
    });
    const fromHostCli = await respond(routes, 'GET /v1/pair/devices', atHost);

    // Assert
    should(jsonBody(fromBrowser)).deepEqual({
      devices: [device(deviceOneId, 'Pixel 8'), device(deviceTwoId, 'iPad')],
      // A browser on this host is not the owner (B4), so it is not told it is at the machine.
      hostLocal: false,
      thisDeviceId: deviceOneId,
      // A device that holds everything may give a device every axis.
      mayWiden: DEFAULT_CAPABILITY_GRANTS,
    });
    // The host's admin credential is not a paired device, so there is no grant of its own to mark.
    should(jsonBody(fromHostCli).thisDeviceId).be.undefined();
    should(jsonBody(fromHostCli).hostLocal).be.true();
    should(fromBrowser.body).not.containEql('publicKey');
  });

  it('P55 never tells a caller that arrived locally without the admin token that it is at this machine', async () => {
    // A remote caller forwarded by `tailscale serve`, `cloudflared` or `ssh -L` arrives from a loopback
    // peer. `hostLocal` is `arrivedOnHost` — the admin token through the local listener — never the bare locality.
    // Arrange
    const routes = mount(new FakePairing());
    const proxied = call({ host: true, path: '/v1/pair/devices', device: browser });

    // Act
    const list = routes.find(route => route.method === 'GET' && route.path === '/v1/pair/devices');
    if (list === undefined) throw new Error('the device list must be mounted');
    const answer = await list.handle({
      ...proxied,
      actor: `device:${deviceOneId}`,
      credential: { kind: 'authenticated', tokenClass: 'device', principal: proxied.request.principal! },
    });
    const hostCli = await respond(routes, 'GET /v1/pair/devices', atHost);

    // Assert
    should(jsonBody(answer).hostLocal).be.false();
    should(jsonBody(hostCli).hostLocal).be.true();
  });

  it('should revoke one device and answer with the remaining list', async () => {
    const subject = new FakePairing();
    const routes = mount(subject);
    const at = (id: string) => ({ ...fromDevice(), params: { deviceId: id } });

    const removed = await respond(routes, 'DELETE /v1/pair/devices/:deviceId', at(deviceTwoId));
    const again = await respond(routes, 'DELETE /v1/pair/devices/:deviceId', at(deviceTwoId));
    const malformed = await respond(routes, 'DELETE /v1/pair/devices/:deviceId', at('not-an-id'));

    should(removed.status).equal(200);
    should(jsonBody(removed)).deepEqual({
      devices: [device(deviceOneId, 'Pixel 8')],
      hostLocal: false,
      thisDeviceId: deviceOneId,
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
    const routes = mount(subject);

    // Act
    const byOwner = await respond(routes, 'DELETE /v1/pair/devices/:deviceId', {
      ...atHost,
      headers: { 'x-ferretry-client': 'cli', 'x-ferretry-actor': 'device:someone-else' },
      params: { deviceId: deviceTwoId },
    });
    const byDevice = await respond(routes, 'DELETE /v1/pair/devices/:deviceId', {
      ...fromDevice(),
      params: { deviceId: deviceOneId },
    });

    // Assert
    should([byOwner.status, byDevice.status]).deepEqual([200, 200]);
    should(subject.revokers).deepEqual(['admin-cli', `device:${deviceOneId}`]);
  });

  it('P62 a remote warden has no device and can never mint, full or limited', async () => {
    // The warden token is capability-scoped supervision. Nothing about supervising sessions needs the
    // ability to hand out credentials for the machine; it holds nothing to pass on and can never step up.
    // Arrange
    const subject = new FakePairing();
    const routes = mount(subject);
    const warden: CallOverrides = {
      standing: { actor: 'warden', credential: { kind: 'authenticated', tokenClass: 'warden' } },
      presentation: { adminToken: false, actor: 'warden' },
    };

    // Act
    const full = await respond(routes, 'POST /v1/pair/code', warden);
    const limited = await respond(routes, 'POST /v1/pair/code', {
      ...warden,
      body: JSON.stringify({ grants: 'limited' }),
    });

    // Assert
    should([full.status, limited.status]).deepEqual([403, 403]);
    should(jsonBody(full).code).equal('grant_forbidden');
    should(jsonBody(limited).code).equal('grant_step_up_required');
    should(subject.mints).equal(0);
  });

  it('P41 mints a full-access code by default for a caller that holds every capability, and a limited one on request', async () => {
    // A new device is FULL by default (owner decision 2026-10-14), so the default mint is `full`.
    // Arrange
    const subject = new FakePairing();
    const routes = mount(subject);

    // Act
    const plain = await respond(routes, 'POST /v1/pair/code', fromDevice(undefined, PASSKEY_CONFIRMED));
    const limited = await respond(routes, 'POST /v1/pair/code', {
      ...fromDevice(undefined, PASSKEY_CONFIRMED),
      body: JSON.stringify({ grants: 'limited' }),
    });

    // Assert
    should([plain.status, limited.status]).deepEqual([201, 201]);
    should(subject.grantSets).deepEqual(['full', 'limited']);
  });

  it('should mint a full-access code at the machine whatever the grants say, and over a device that holds everything', async () => {
    // Arrange
    const subject = new FakePairing();
    const routes = mount(subject);
    const full = JSON.stringify({ grants: 'full' });

    // Act
    const host = await respond(routes, 'POST /v1/pair/code', { ...atHost, body: full });
    const byHolder = await respond(routes, 'POST /v1/pair/code', {
      ...fromDevice(FULL_DEVICE_GRANTS, PASSKEY_CONFIRMED),
      body: full,
    });

    // Assert
    should([host.status, byHolder.status]).deepEqual([201, 201]);
    should(subject.grantSets).deepEqual(['full', 'full']);
  });

  it('G137 refuses a remote full mint by a device that does not hold every capability: 403 grant_forbidden', async () => {
    // A device may pass on only what it holds, by the rule a device widen reads (`mayWiden`).
    // Arrange
    const subject = new FakePairing();
    const holdsMostButNotSecrets: CapabilityGrants = {
      ...FULL_DEVICE_GRANTS,
      secrets: { use: true, configure: false },
    };
    const pairsOnly: CapabilityGrants = { ...LIMITED_DEVICE_GRANTS, pairing: { use: true, configure: true } };
    const routes = mount(subject);
    const full = JSON.stringify({ grants: 'full' });

    // Act
    const byLimited = await respond(routes, 'POST /v1/pair/code', {
      ...fromDevice(pairsOnly, PASSKEY_CONFIRMED),
      body: full,
    });
    const byAlmost = await respond(routes, 'POST /v1/pair/code', {
      ...fromDevice(holdsMostButNotSecrets, PASSKEY_CONFIRMED),
      body: full,
    });

    // Assert
    should([byLimited.status, byAlmost.status]).deepEqual([403, 403]);
    should(jsonBody(byLimited).code).equal('grant_forbidden');
    should(jsonBody(byAlmost).code).equal('grant_forbidden');
    should(subject.grantSets).deepEqual([]);
  });

  it('should let a device that holds only some capabilities mint a limited code', async () => {
    // A device with no `pairing.use` at all is stopped at Gate's boundary (P56), before the route asks what it holds.
    // Arrange
    const subject = new FakePairing();
    const pairsOnly: CapabilityGrants = { ...LIMITED_DEVICE_GRANTS, pairing: { use: true, configure: true } };

    // Act
    const pairer = await respond(mount(subject), 'POST /v1/pair/code', {
      ...fromDevice(pairsOnly, PASSKEY_CONFIRMED),
      body: JSON.stringify({ grants: 'limited' }),
    });

    // Assert
    should(pairer.status).equal(201);
    should(subject.grantSets).deepEqual(['limited']);
  });

  it('G52 a remote device may switch its own pairing off but can never switch it back on', async () => {
    // Arrange
    const devices = new Map<string, CapabilityGrants>([[deviceOneId, DEFAULT_CAPABILITY_GRANTS]]);
    const routes = mount(new FakePairing(), true, devices);
    const patch = (on: boolean, own: CapabilityGrants) =>
      respond(routes, 'PATCH /v1/pair/devices/:deviceId/grants', {
        ...fromDevice(own, PASSKEY_CONFIRMED),
        params: { deviceId: deviceOneId },
        body: JSON.stringify({ pairing: { use: on } }),
        standing: { claimFreshStepUp: (() => true) as never },
      });

    // Act
    const off = await patch(false, DEFAULT_CAPABILITY_GRANTS);
    const back = await patch(true, devices.get(deviceOneId) ?? DEFAULT_CAPABILITY_GRANTS);

    // Assert
    should(off.status).equal(200);
    should(back.status).equal(403);
    should(jsonBody(back).code).equal('grant_forbidden');
    should(devices.get(deviceOneId)?.pairing).deepEqual({ use: false, configure: false });
  });

  it('P63 widening another device follows the same per-act passkey rule: grant_step_up_required with act widen-device', async () => {
    // Arrange
    const devices = new Map<string, CapabilityGrants>([
      [deviceOneId, DEFAULT_CAPABILITY_GRANTS],
      [deviceTwoId, LIMITED_DEVICE_GRANTS],
    ]);
    const routes = mount(new FakePairing(), true, devices);

    // Act — unlocked, but with no passkey proved for THIS widen.
    const response = await respond(routes, 'PATCH /v1/pair/devices/:deviceId/grants', {
      ...fromDevice(DEFAULT_CAPABILITY_GRANTS, UNLOCKED_ONLY),
      params: { deviceId: deviceTwoId },
      body: JSON.stringify({ terminal: { use: true } }),
      standing: { claimFreshStepUp: (() => false) as never },
    });

    // Assert
    should(response.status).equal(403);
    should(jsonBody(response).code).equal('grant_step_up_required');
    should(jsonBody(response).demand).deepEqual({ capability: 'pairing', axis: 'use', act: 'widen-device' });
    should(devices.get(deviceTwoId)).deepEqual(LIMITED_DEVICE_GRANTS);
  });
});

describe('adding a device always wants a passkey proved for it', () => {
  /*
   * OWNER DECISION 2026-10-14: minting a pairing code needs a FRESH per-act step-up from a device — even
   * an unlocked one, even with `stepUpOnActions` off. The unlock alone must never be enough to put
   * another device on this machine. The machine itself (its admin token, on the host) is never asked.
   */
  it('P64 refuses an unlocked device that has not confirmed THIS act, naming the act', async () => {
    // Arrange
    const subject = new FakePairing();

    // Act
    const response = await respond(mount(subject), 'POST /v1/pair/code', fromDevice(undefined, UNLOCKED_ONLY));

    // Assert
    should(response.status).equal(403);
    should(jsonBody(response).code).equal('grant_step_up_required');
    should(jsonBody(response).demand).deepEqual({ capability: 'pairing', axis: 'use', act: 'add-device' });
    should(subject.mints).equal(0);
  });

  it('P60 mints once the device has confirmed with a passkey, and spends that proof on the one code', async () => {
    // Arrange
    const subject = new FakePairing();
    let spent = 0;

    // Act
    const response = await respond(mount(subject), 'POST /v1/pair/code', {
      ...fromDevice(undefined, PASSKEY_CONFIRMED),
      standing: {
        spendFreshStepUp: () => {
          spent += 1;
        },
      },
    });

    // Assert
    should(response.status).equal(201);
    should(subject.mints).equal(1);
    should(spent).equal(1);
  });

  it('P59 never asks the machine itself for a secret or a step-up', async () => {
    // Arrange
    const subject = new FakePairing();

    // Act — the host's admin token, on the kernel's own listener, with no step-up of any kind.
    const response = await respond(mount(subject), 'POST /v1/pair/code', atHost);

    // Assert
    should(response.status).equal(201);
    should(subject.mints).equal(1);
  });

  it('P65 an unpaired machine mints at the machine with no device and no setup', async () => {
    // Pairing does not gate local use: with nothing paired, the owner at the machine is served as ever.
    const subject = new FakePairing();
    subject.granted = [];

    const listed = await respond(mount(subject, true, new Map()), 'GET /v1/pair/devices', atHost);
    const minting = await respond(mount(subject, true, new Map()), 'POST /v1/pair/code', atHost);

    should(listed.status).equal(200);
    should(jsonBody(listed).devices).deepEqual([]);
    should(minting.status).equal(201);
  });
});

describe('a pairing route reached without a presentation of its caller', () => {
  it('should refuse rather than guess who is asking, for the device list and for minting', async () => {
    // Arrange — Gate always stamps a presentation on these routes, so the handlers are asked directly without one.
    const routes = mount(new FakePairing());
    const mint = routes.find(route => route.path === '/v1/pair/code' && route.method === 'POST');
    const list = routes.find(route => route.method === 'GET' && route.path === '/v1/pair/devices');
    if (mint === undefined || list === undefined) throw new Error('the pairing routes must be mounted');

    // Act + Assert
    for (const route of [list, mint]) {
      const { presentation: _absent, ...bare } = call({ method: route.method, path: route.path });
      await should(route.handle(bare)).be.rejectedWith({ status: 500, code: 'internal_error' });
    }
  });
});
