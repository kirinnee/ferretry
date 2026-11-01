import { describe, it } from 'bun:test';
import {
  DEFAULT_SECURITY_SETTINGS,
  MAX_PASSKEYS_PER_DEVICE,
  PASSKEY_CHALLENGE_TTL_SECONDS,
  type SecuritySettings,
  UNLOCK_REQUIRED_CODE,
  STEP_UP_TTL_SECONDS,
  stepUpRefusalCode,
} from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher, ApiRouter } from '../../../../src/lib/api/index.ts';
import { DEFAULT_CAPABILITY_GRANTS } from '../../../../src/lib/grants/index.ts';
import { stepUpRoutes } from '../../../../src/lib/runtime/mounts/step-up.ts';
import {
  ChallengeLedger,
  type DeviceKeyRotationPort,
  type PasskeyStore,
  type PasskeyVerifierPort,
  StepUpRegistry,
  StepUpService,
  type StoredPasskey,
} from '../../../../src/lib/step-up/index.ts';
import { jsonBody, request } from '../../api/support.ts';
import { grantSubsystem } from './support.ts';

const NOW = Date.parse('2026-08-03T12:00:00.000Z');
const ORIGIN = 'https://app.example.test';
const deviceId = `fy_device_id_${'d'.repeat(22)}`;
const browser = { deviceId, appSession: 'app-one' } as const;
const credentials = {
  admin: 'admin-secret',
  warden: 'warden-secret',
  devices: { has: (id: string) => id === deviceId },
};
const admin = { authorization: 'Bearer admin-secret' };
const warden = { authorization: 'Bearer warden-secret' };

const b64 = (bytes: ArrayLike<number>): string => Buffer.from(Uint8Array.from(bytes)).toString('base64url');
const CREDENTIAL_ID = b64([1, 2, 3, 4]);
const SPKI = b64([9, 9, 9, 9]);

/**
 * The ONE place the registry is built. The browser's copy of the app holds a live session throughout,
 * as it does whenever it can reach these routes, so its step-up span is open.
 */
const newRegistry = (clock?: { now: number }): StepUpRegistry => {
  const registry = new StepUpRegistry({ nowMs: () => clock?.now ?? NOW });
  registry.open(browser);
  return registry;
};

class MemoryStore implements PasskeyStore {
  constructor(public held: StoredPasskey[] = []) {}

  async list(id: string): Promise<readonly StoredPasskey[]> {
    return this.held.filter(passkey => passkey.deviceId === id);
  }

  async holder(credentialId: string): Promise<string | undefined> {
    return this.held.find(passkey => passkey.credentialId === credentialId)?.deviceId;
  }

  async add(passkey: StoredPasskey): Promise<void> {
    this.held = [...this.held.filter(existing => existing.credentialId !== passkey.credentialId), passkey];
  }

  async updateSignCount(id: string, credentialId: string, signCount: number): Promise<boolean> {
    this.held = this.held.map(passkey =>
      passkey.deviceId === id && passkey.credentialId === credentialId ? { ...passkey, signCount } : passkey,
    );
    return true;
  }

  async forgetDevice(id: string): Promise<void> {
    this.held = this.held.filter(passkey => passkey.deviceId !== id);
  }
}

const stored = (credentialId: string, overrides: Partial<StoredPasskey> = {}): StoredPasskey => ({
  credentialId,
  deviceId,
  algorithm: -7,
  publicKeySpki: SPKI,
  signCount: 1,
  origin: ORIGIN,
  createdAt: '2026-08-03T11:59:00.000Z',
  ...overrides,
});

/** A verifier that answers what the fixture says, so the route's rendering of each verdict is the subject. */
class FakeVerifier implements PasskeyVerifierPort {
  registrationVerdict: 'ok' | 'refuse' = 'ok';
  assertionVerdict: 'ok' | 'refuse' = 'ok';

  async verifyRegistration(): ReturnType<PasskeyVerifierPort['verifyRegistration']> {
    if (this.registrationVerdict === 'refuse') return { ok: false, reason: 'bad attestation' };
    return {
      ok: true,
      credentialId: Uint8Array.from([1, 2, 3, 4]),
      algorithm: -7,
      publicKeySpki: Uint8Array.from([9, 9, 9, 9]),
      signCount: 0,
      origin: ORIGIN,
    };
  }

  async verifyAssertion(): ReturnType<PasskeyVerifierPort['verifyAssertion']> {
    if (this.assertionVerdict === 'refuse') return { ok: false, reason: 'bad signature' };
    return { ok: true, signCount: 5, origin: ORIGIN };
  }
}

interface World {
  readonly store?: MemoryStore;
  /** Milliseconds between the device being paired and now. */
  readonly pairedAgoMs?: number;
  readonly known?: boolean;
  /** The machine's security settings, over the defaults. Absent builds the service without settings. */
  readonly settings?: Partial<SecuritySettings>;
  readonly rotation?: DeviceKeyRotationPort;
  /** A clock a case may move; the fixed instant otherwise. */
  readonly clock?: { now: number };
}

function mount(world: World = {}) {
  const store = world.store ?? new MemoryStore();
  const verifier = new FakeVerifier();
  const registry = newRegistry(world.clock);
  const audited: { readonly actor: string; readonly changes: readonly string[] }[] = [];
  const service = new StepUpService({
    store,
    verifier,
    registry,
    challenges: new ChallengeLedger(),
    random: { bytes: length => new Uint8Array(length).fill(7) },
    clock: { nowMs: () => world.clock?.now ?? NOW },
    devices: {
      device: async id =>
        world.known === false || id !== deviceId
          ? undefined
          : { name: 'Pixel 8', createdAt: new Date(NOW - (world.pairedAgoMs ?? 60_000)).toISOString() },
    },
    allowedOrigins: () => [ORIGIN],
    relyingPartyName: 'Ferretry',
    machineName: 'studio',
    ...(world.settings === undefined ? {} : { settings: () => ({ ...DEFAULT_SECURITY_SETTINGS, ...world.settings }) }),
    ...(world.rotation === undefined ? {} : { rotation: world.rotation }),
    audit: {
      record: async entry => {
        audited.push(entry);
      },
    },
  });
  const grants = grantSubsystem({ grants: DEFAULT_CAPABILITY_GRANTS });
  const surface = (async () => {
    await grants.refresh();
    return new ApiDispatcher(new ApiRouter(stepUpRoutes(service)), credentials, grants, undefined, service);
  })();
  return { store, verifier, registry, service, surface, audited };
}

const json = (value: unknown): string => JSON.stringify(value);
const registrationBody = json({
  credentialId: CREDENTIAL_ID,
  clientDataJSON: 'Y2xpZW50',
  attestationObject: 'YXR0ZXN0',
});
const assertionBody = json({
  credentialId: CREDENTIAL_ID,
  clientDataJSON: 'Y2xpZW50',
  authenticatorData: 'YXV0aA',
  signature: 'c2ln',
});
const originBody = json({ origin: ORIGIN });

const asDevice = { device: browser } as const;
const asAdminNoDevice = { headers: admin, loopback: true } as const;
const windowBody = json({ deviceId });
/** The owner, at the machine, re-opens this device's passkey window: the only recovery path (B4). */
const reopenAsOwner = (dispatcher: ApiDispatcher) =>
  dispatcher.dispatch(
    request({ method: 'POST', path: '/v1/passkeys/registration-window', body: windowBody, ...asAdminNoDevice }),
  );

/** Every route, with a body valid for it, for the refusals that do not depend on which route spoke. */
const ROUTES = [
  { method: 'GET', path: '/v1/passkeys', body: undefined },
  { method: 'POST', path: '/v1/passkeys/options', body: originBody },
  { method: 'POST', path: '/v1/passkeys', body: registrationBody },
  { method: 'POST', path: '/v1/step-up/options', body: originBody },
  { method: 'POST', path: '/v1/step-up', body: assertionBody },
  { method: 'POST', path: '/v1/unlock/options', body: originBody },
  { method: 'POST', path: '/v1/unlock', body: assertionBody },
] as const;

describe('step-up routes', () => {
  it('should serve the whole ceremony to a paired device, with its success statuses', async () => {
    // Arrange
    const { surface, store } = mount();
    const dispatcher = await surface;

    // Act
    const before = await dispatcher.dispatch(request({ path: '/v1/passkeys', ...asDevice }));
    const registerOptions = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/passkeys/options', body: originBody, ...asDevice }),
    );
    const registered = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/passkeys', body: registrationBody, ...asDevice }),
    );
    const during = await dispatcher.dispatch(request({ path: '/v1/passkeys', ...asDevice }));
    const stepOptions = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/step-up/options', body: originBody, ...asDevice }),
    );
    const stepped = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/step-up', body: assertionBody, ...asDevice }),
    );

    // Assert
    should(before.status).equal(200);
    should(jsonBody(before)).containEql({ passkeys: [], registration: 'first-window' });
    should(registerOptions.status).equal(200);
    should(jsonBody(registerOptions)).containEql({ rp: { id: 'app.example.test', name: 'Ferretry' } });
    should(registered.status).equal(201);
    should(jsonBody(registered)).deepEqual({
      id: CREDENTIAL_ID,
      origin: ORIGIN,
      createdAt: new Date(NOW).toISOString(),
    });
    should(store.held.map(passkey => passkey.credentialId)).deepEqual([CREDENTIAL_ID]);
    // A registration grants no step-up, and a second passkey now needs a confirmation by this one.
    should(jsonBody(during)).deepEqual({
      passkeys: [{ id: CREDENTIAL_ID, origin: ORIGIN, createdAt: new Date(NOW).toISOString() }],
      registration: 'confirm-existing',
    });
    should(stepOptions.status).equal(200);
    should(jsonBody(stepOptions)).containEql({ rpId: 'app.example.test' });
    should(stepped.status).equal(200);
    should(jsonBody(stepped)).deepEqual({ expiresAt: new Date(NOW + STEP_UP_TTL_SECONDS * 1_000).toISOString() });
    should(store.held[0]?.signCount).equal(5);
  });

  it('should stamp the proof with the act the options asked for, so only that act can claim it', async () => {
    // Arrange
    const world = mount({ store: new MemoryStore([stored(CREDENTIAL_ID)]) });
    const dispatcher = await world.surface;

    // Act
    const options = await dispatcher.dispatch(
      request({
        method: 'POST',
        path: '/v1/step-up/options',
        body: json({ origin: ORIGIN, act: 'catalog-install' }),
        ...asDevice,
      }),
    );
    const stepped = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/step-up', body: assertionBody, ...asDevice }),
    );

    // Assert
    should([options.status, stepped.status]).deepEqual([200, 200]);
    should(world.service.claimFresh(browser, 'loosen-config')).be.false();
    should(world.service.claimFresh(browser, 'catalog-install')).be.true();
  });

  it('should mint no proof for adding a 2FA key until this daemon stages one to bind it to', async () => {
    // Arrange
    const world = mount({ store: new MemoryStore([stored(CREDENTIAL_ID)]) });
    const dispatcher = await world.surface;
    const body = json({ origin: ORIGIN, act: 'add-2fa-key', subject: `st_${'a'.repeat(24)}` });

    // Act
    const options = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/step-up/options', body, ...asDevice }),
    );
    const stepped = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/step-up', body: assertionBody, ...asDevice }),
    );

    // Assert — no challenge was issued for the act, so no assertion can be stamped with it
    should(options.status).equal(400);
    should(stepped.status).not.equal(200);
    should(world.service.claimFresh(browser, 'add-2fa-key')).be.false();
  });

  it('should never cache an answer, success or refusal', async () => {
    // Arrange
    const dispatcher = await mount().surface;

    // Act
    const answered = await dispatcher.dispatch(request({ path: '/v1/passkeys', ...asDevice }));
    const refused = await dispatcher.dispatch(request({ path: '/v1/passkeys', ...asAdminNoDevice }));

    // Assert
    should(answered.headers.get('cache-control')).equal('no-store');
    should(refused.headers.get('cache-control')).equal('no-store');
  });

  it('should refuse every route to a caller that is not a paired device: 400 step_up_not_a_device', async () => {
    // Arrange — the host's own token proves a caller, but no device, and a passkey belongs to a device
    const dispatcher = await mount().surface;

    for (const route of ROUTES) {
      // Act
      const response = await dispatcher.dispatch(
        request({ method: route.method, path: route.path, body: route.body, ...asAdminNoDevice }),
      );

      // Assert
      should([route.path, response.status, jsonBody(response).code]).deepEqual([
        route.path,
        400,
        stepUpRefusalCode('not-a-device'),
      ]);
    }
  });

  it('should refuse a caller with no credential at all, and one below operator', async () => {
    // Arrange
    const dispatcher = await mount().surface;

    // Act
    const anonymous = await dispatcher.dispatch(request({ path: '/v1/passkeys' }));
    const asWarden = await dispatcher.dispatch(request({ path: '/v1/passkeys', headers: warden, loopback: true }));

    // Assert
    should(anonymous.status).equal(401);
    should(asWarden.status).equal(403);
  });

  it('should refuse a device whose pairing no longer exists, and never name it as a caller', async () => {
    // Arrange
    const dispatcher = await mount().surface;

    // Act
    const response = await dispatcher.dispatch(
      request({ path: '/v1/passkeys', device: { deviceId: `fy_device_id_${'x'.repeat(22)}`, appSession: 'app-two' } }),
    );

    // Assert
    should(response.status).equal(401);
  });

  it('should refuse an app origin the machine does not serve: 403 step_up_origin_not_allowed', async () => {
    // Arrange
    const dispatcher = await mount().surface;
    const body = json({ origin: 'https://elsewhere.example.test' });

    for (const path of ['/v1/passkeys/options', '/v1/step-up/options']) {
      // Act
      const response = await dispatcher.dispatch(request({ method: 'POST', path, body, ...asDevice }));

      // Assert
      should([path, response.status, jsonBody(response).code]).deepEqual([
        path,
        403,
        stepUpRefusalCode('origin-not-allowed'),
      ]);
    }
  });

  it('should close registration to a device paired long ago that has no step-up: 403 step_up_registration_closed', async () => {
    // Arrange
    const dispatcher = await mount({ pairedAgoMs: 3_600_000 }).surface;

    // Act
    const view = await dispatcher.dispatch(request({ path: '/v1/passkeys', ...asDevice }));
    const options = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/passkeys/options', body: originBody, ...asDevice }),
    );
    const register = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/passkeys', body: registrationBody, ...asDevice }),
    );

    // Assert
    should(jsonBody(view)).containEql({ registration: 'closed' });
    should([options.status, jsonBody(options).code]).deepEqual([403, stepUpRefusalCode('registration-closed')]);
    should([register.status, jsonBody(register).code]).deepEqual([403, stepUpRefusalCode('registration-closed')]);
  });

  it('should refuse a ninth passkey: 409 step_up_too_many_passkeys', async () => {
    // Arrange — a window the owner re-opened admits a passkey, so the cap is the only thing left to refuse
    const full = Array.from({ length: MAX_PASSKEYS_PER_DEVICE }, (_, index) => stored(b64([index, 1])));
    const dispatcher = await mount({ store: new MemoryStore(full) }).surface;
    await reopenAsOwner(dispatcher);

    // Act
    const options = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/passkeys/options', body: originBody, ...asDevice }),
    );

    // Assert
    should([options.status, jsonBody(options).code]).deepEqual([409, stepUpRefusalCode('too-many-passkeys')]);
  });

  it('should refuse a step-up for a device with no passkey at that origin: 404 step_up_no_passkey', async () => {
    // Arrange
    const elsewhere = stored(b64([5, 5]), { origin: 'https://other.example.test' });
    const dispatcher = await mount({ store: new MemoryStore([elsewhere]) }).surface;

    // Act
    const none = await (
      await mount().surface
    ).dispatch(request({ method: 'POST', path: '/v1/step-up/options', body: originBody, ...asDevice }));
    const otherOrigin = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/step-up/options', body: originBody, ...asDevice }),
    );

    // Assert
    should([none.status, jsonBody(none).code]).deepEqual([404, stepUpRefusalCode('no-passkey')]);
    should([otherOrigin.status, jsonBody(otherOrigin).code]).deepEqual([404, stepUpRefusalCode('no-passkey')]);
  });

  it('should answer 401 step_up_not_verified for every way a confirmation fails to check out', async () => {
    // Arrange
    const held = new MemoryStore([stored(CREDENTIAL_ID)]);
    const { surface, verifier } = mount({ store: held });
    const dispatcher = await surface;
    const registerAfterOptions = async () => {
      await reopenAsOwner(dispatcher);
      await dispatcher.dispatch(
        request({ method: 'POST', path: '/v1/passkeys/options', body: originBody, ...asDevice }),
      );
    };
    const stepUpAfterOptions = async () => {
      await dispatcher.dispatch(
        request({ method: 'POST', path: '/v1/step-up/options', body: originBody, ...asDevice }),
      );
    };

    // Act — no challenge outstanding, a verifier that refuses the assertion, one that refuses the
    // attestation
    const noChallenge = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/step-up', body: assertionBody, ...asDevice }),
    );
    await stepUpAfterOptions();
    verifier.assertionVerdict = 'refuse';
    const badSignature = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/step-up', body: assertionBody, ...asDevice }),
    );
    await registerAfterOptions();
    verifier.registrationVerdict = 'refuse';
    const badAttestation = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/passkeys', body: registrationBody, ...asDevice }),
    );

    // Assert
    for (const response of [noChallenge, badSignature, badAttestation])
      should([response.status, jsonBody(response).code]).deepEqual([401, stepUpRefusalCode('not-verified')]);
    should(held.held.map(passkey => passkey.signCount)).deepEqual([1]);
  });

  it('should answer 400 to a malformed body, and say nothing about the ceremony', async () => {
    // Arrange
    const dispatcher = await mount().surface;
    const cases = [
      { path: '/v1/passkeys/options', body: '{ not json' },
      { path: '/v1/passkeys/options', body: json({ origin: 'https://app.example.test/path' }) },
      { path: '/v1/passkeys', body: json({ credentialId: CREDENTIAL_ID }) },
      { path: '/v1/step-up/options', body: json({ origin: ORIGIN, extra: true }) },
      { path: '/v1/step-up/options', body: json({ origin: ORIGIN, act: 'loosen-everything' }) },
      { path: '/v1/step-up', body: json({ credentialId: '!!!' }) },
    ];

    for (const { path, body } of cases) {
      // Act
      const response = await dispatcher.dispatch(request({ method: 'POST', path, body, ...asDevice }));

      // Assert
      should([path, response.status]).deepEqual([path, 400]);
    }
  });

  it('should let only the owner at the machine re-open a window: never a browser, wherever it runs', async () => {
    // Arrange — a device with no step-up, paired long ago, so its first window is long closed
    const { surface, audited } = mount({ pairedAgoMs: 3_600_000 });
    const dispatcher = await surface;
    const lookalike = { 'x-forwarded-for': '127.0.0.1', host: 'localhost' };
    const asBrowser = (arrival: Record<string, unknown>) =>
      dispatcher.dispatch(
        request({
          method: 'POST',
          path: '/v1/passkeys/registration-window',
          body: windowBody,
          ...asDevice,
          ...arrival,
        }),
      );

    // Act — a browser on a host-proven carrier, on a loopback peer, behind a spoofed header; the admin
    // token arriving from off the host; then the owner
    const refused = [
      await asBrowser({ loopback: true, privilegedLoopback: true }),
      await asBrowser({ loopback: true }),
      await asBrowser({ headers: lookalike }),
    ];
    const remoteAdmin = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/passkeys/registration-window', body: windowBody, headers: admin }),
    );
    const before = await dispatcher.dispatch(request({ path: '/v1/passkeys', ...asDevice }));
    const opened = await reopenAsOwner(dispatcher);
    const after = await dispatcher.dispatch(request({ path: '/v1/passkeys', ...asDevice }));
    const stranger = await dispatcher.dispatch(
      request({
        method: 'POST',
        path: '/v1/passkeys/registration-window',
        body: json({ deviceId: `fy_device_id_${'z'.repeat(22)}` }),
        ...asAdminNoDevice,
      }),
    );

    // Assert — two layers: the boundary refuses every browser before the handler runs (the route is
    // admin-token only), and the service still refuses the admin token that did not arrive on the host.
    for (const response of refused) should([response.status, jsonBody(response).code]).deepEqual([403, 'forbidden']);
    should([remoteAdmin.status, jsonBody(remoteAdmin).code]).deepEqual([403, stepUpRefusalCode('not-at-machine')]);
    should(jsonBody(before)).containEql({ registration: 'closed' });
    should(opened.status).equal(200);
    should(jsonBody(opened)).containEql({ deviceId, deviceName: 'Pixel 8' });
    should(jsonBody(after)).containEql({ registration: 'reopened' });
    should([stranger.status, jsonBody(stranger).code]).deepEqual([404, stepUpRefusalCode('unknown-device')]);
    // Audited once: the refusals changed nothing.
    should(audited.map(entry => entry.changes)).deepEqual([[`passkey.registration-window=${deviceId}`]]);
  });

  it('should admit exactly one passkey through a re-opened window', async () => {
    // Arrange
    const dispatcher = await mount({ pairedAgoMs: 3_600_000 }).surface;
    await reopenAsOwner(dispatcher);

    // Act
    await dispatcher.dispatch(request({ method: 'POST', path: '/v1/passkeys/options', body: originBody, ...asDevice }));
    const registered = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/passkeys', body: registrationBody, ...asDevice }),
    );
    // Spent: from any copy of the app, a further passkey now needs a confirmation by this one.
    const otherTab = await dispatcher.dispatch(
      request({ path: '/v1/passkeys', device: { deviceId, appSession: 'app-two' } }),
    );

    // Assert
    should(registered.status).equal(201);
    should(jsonBody(otherTab)).containEql({ registration: 'confirm-existing' });
  });

  it('should refuse a second passkey with no confirmation, step-up or not: 401 step_up_not_verified', async () => {
    // Arrange — the device holds a passkey and a live step-up from it
    const { surface, store } = mount({ store: new MemoryStore([stored(CREDENTIAL_ID)]), pairedAgoMs: 3_600_000 });
    const dispatcher = await surface;
    await dispatcher.dispatch(request({ method: 'POST', path: '/v1/step-up/options', body: originBody, ...asDevice }));
    await dispatcher.dispatch(request({ method: 'POST', path: '/v1/step-up', body: assertionBody, ...asDevice }));

    // Act
    const options = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/passkeys/options', body: originBody, ...asDevice }),
    );
    const unconfirmed = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/passkeys', body: registrationBody, ...asDevice }),
    );

    // Assert
    should(options.status).equal(200);
    should(jsonBody(options)).containEql({
      confirm: {
        challenge: b64(new Array(32).fill(7)),
        rpId: 'app.example.test',
        allowCredentials: [{ type: 'public-key', id: CREDENTIAL_ID }],
        timeout: PASSKEY_CHALLENGE_TTL_SECONDS * 1_000,
      },
    });
    should([unconfirmed.status, jsonBody(unconfirmed).code]).deepEqual([401, stepUpRefusalCode('not-verified')]);
    should(store.held).have.length(1);
  });

  it('should add a second passkey confirmed by the first, in one ceremony', async () => {
    // Arrange
    const { surface, store } = mount({
      store: new MemoryStore([stored(b64([5, 5, 5, 5]))]),
      pairedAgoMs: 3_600_000,
    });
    const dispatcher = await surface;

    // Act
    await dispatcher.dispatch(request({ method: 'POST', path: '/v1/passkeys/options', body: originBody, ...asDevice }));
    const confirmed = await dispatcher.dispatch(
      request({
        method: 'POST',
        path: '/v1/passkeys',
        body: json({
          ...JSON.parse(registrationBody),
          confirmation: { ...JSON.parse(assertionBody), credentialId: b64([5, 5, 5, 5]) },
        }),
        ...asDevice,
      }),
    );

    // Assert
    should(confirmed.status).equal(201);
    should(store.held.map(passkey => passkey.credentialId)).deepEqual([b64([5, 5, 5, 5]), CREDENTIAL_ID]);
  });

  it('should keep one copy of the app’s step-up from covering another’s', async () => {
    // Arrange
    const { surface, store } = mount({ store: new MemoryStore([stored(CREDENTIAL_ID)]), pairedAgoMs: 3_600_000 });
    const dispatcher = await surface;
    await dispatcher.dispatch(request({ method: 'POST', path: '/v1/step-up/options', body: originBody, ...asDevice }));
    await dispatcher.dispatch(request({ method: 'POST', path: '/v1/step-up', body: assertionBody, ...asDevice }));

    // Act
    const same = await dispatcher.dispatch(request({ path: '/v1/passkeys', ...asDevice }));
    const otherTab = await dispatcher.dispatch(
      request({ path: '/v1/passkeys', device: { deviceId, appSession: 'app-two' } }),
    );

    // Assert
    should(jsonBody(same)).containEql({ stepUpUntil: new Date(NOW + STEP_UP_TTL_SECONDS * 1_000).toISOString() });
    should(jsonBody(otherTab)).not.have.property('stepUpUntil');
    should(store.held).have.length(1);
  });
});

describe('step-up routes: unlock on opening (B6)', () => {
  const ask = { settings: { unlockOnOpen: true } } as const;
  const post = (path: string, body: string) => request({ method: 'POST', path, body, ...asDevice });

  it('should exempt exactly the passkey panel, passkey registration and the two unlock routes from the unlock demand', () => {
    // Arrange
    const routes = stepUpRoutes(mount().service);

    // Act
    const exempt = routes.filter(route => route.unlockExempt === true).map(route => `${route.method} ${route.path}`);

    // Assert
    should(exempt).deepEqual([
      'GET /v1/passkeys',
      'POST /v1/passkeys/options',
      'POST /v1/passkeys',
      'POST /v1/unlock/options',
      'POST /v1/unlock',
    ]);
  });

  it('should serve the unlock routes with no capability demand, never cached, to operators only', () => {
    // Arrange
    const routes = stepUpRoutes(mount().service);

    // Act
    const unlockRoutes = routes.filter(route => route.path.startsWith('/v1/unlock'));

    // Assert
    should(unlockRoutes).have.length(2);
    for (const route of unlockRoutes) {
      should([route.path, route.minimum, route.noStore, route.capability]).deepEqual([
        route.path,
        'operator',
        true,
        undefined,
      ]);
    }
  });

  it('should answer 401 unlock_required to every other route until the device confirms', async () => {
    // Arrange
    const dispatcher = await mount({ ...ask, store: new MemoryStore([stored(CREDENTIAL_ID)]) }).surface;
    const refused = ROUTES.filter(
      route => !route.path.startsWith('/v1/unlock') && !route.path.startsWith('/v1/passkeys'),
    );

    for (const route of refused) {
      // Act
      const response = await dispatcher.dispatch(
        request({ method: route.method, path: route.path, body: route.body, ...asDevice }),
      );

      // Assert
      should([route.path, response.status, jsonBody(response).code]).deepEqual([route.path, 401, UNLOCK_REQUIRED_CODE]);
    }
  });

  it('should serve passkey registration before an unlock inside the first window, not refuse it as locked', async () => {
    // Arrange — a device that has just paired holds no passkey, and registering one is how it gets in.
    const world = mount({ ...ask, pairedAgoMs: 60_000 });
    const dispatcher = await world.surface;

    // Act
    const options = await dispatcher.dispatch(post('/v1/passkeys/options', originBody));
    const registered = await dispatcher.dispatch(post('/v1/passkeys', registrationBody));

    // Assert
    should(options.status).equal(200);
    should(registered.status).equal(201);
    should(world.store.held).have.length(1);
  });

  it('should refuse passkey registration outside its window by the registration rules, not as unlock_required', async () => {
    // Arrange — paired long ago, no passkey, and the owner has not re-opened the window.
    const dispatcher = await mount({ ...ask, pairedAgoMs: 3_600_000 }).surface;

    // Act
    const options = await dispatcher.dispatch(post('/v1/passkeys/options', originBody));
    const registered = await dispatcher.dispatch(post('/v1/passkeys', registrationBody));

    // Assert
    for (const response of [options, registered])
      should([response.status, jsonBody(response).code]).deepEqual([403, stepUpRefusalCode('registration-closed')]);
  });

  it('should still serve the passkey panel and both unlock routes while an unlock is required', async () => {
    // Arrange
    const dispatcher = await mount({ ...ask, store: new MemoryStore([stored(CREDENTIAL_ID)]) }).surface;

    // Act
    const panel = await dispatcher.dispatch(request({ path: '/v1/passkeys', ...asDevice }));
    const options = await dispatcher.dispatch(post('/v1/unlock/options', originBody));
    const confirmed = await dispatcher.dispatch(post('/v1/unlock', assertionBody));

    // Assert
    should(panel.status).equal(200);
    should(options.status).equal(200);
    should(jsonBody(options)).containEql({ rpId: 'app.example.test' });
    should(confirmed.status).equal(200);
  });

  it('should answer an unlock with when it lapses, and then serve every route', async () => {
    // Arrange
    const dispatcher = await mount({
      settings: { unlockOnOpen: true, unlockValidityHours: 2 },
      store: new MemoryStore([stored(CREDENTIAL_ID)]),
    }).surface;
    const blocked = await dispatcher.dispatch(post('/v1/step-up/options', originBody));
    await dispatcher.dispatch(post('/v1/unlock/options', originBody));

    // Act
    const confirmed = await dispatcher.dispatch(post('/v1/unlock', assertionBody));
    const served = await dispatcher.dispatch(post('/v1/step-up/options', originBody));

    // Assert
    should(blocked.status).equal(401);
    should(jsonBody(confirmed)).deepEqual({ unlockedUntil: new Date(NOW + 2 * 3_600_000).toISOString() });
    should(served.status).equal(200);
  });

  it('should make the unlock the step-up: a gated act is admitted after it with no per-act step-up', async () => {
    // Arrange
    const world = mount({ ...ask, store: new MemoryStore([stored(CREDENTIAL_ID)]) });
    const dispatcher = await world.surface;
    await dispatcher.dispatch(post('/v1/unlock/options', originBody));
    await dispatcher.dispatch(post('/v1/unlock', assertionBody));
    world.registry.forgetDevice(deviceId);

    // Act
    const view = await dispatcher.dispatch(request({ path: '/v1/passkeys', ...asDevice }));

    // Assert — the registry holds nothing, and the service still says the step-up is held.
    should(jsonBody(view).stepUpUntil).be.undefined();
    should(world.service.held(browser)).be.true();
  });

  it('should answer 401 unlock_required again once the unlock has lapsed', async () => {
    // Arrange
    const clock = { now: NOW };
    const world = mount({
      settings: { unlockOnOpen: true, unlockValidityHours: 1 },
      store: new MemoryStore([stored(CREDENTIAL_ID)]),
      clock,
    });
    const dispatcher = await world.surface;
    await dispatcher.dispatch(post('/v1/unlock/options', originBody));
    await dispatcher.dispatch(post('/v1/unlock', assertionBody));
    const during = await dispatcher.dispatch(post('/v1/step-up/options', originBody));

    // Act
    clock.now = NOW + 3_600_000;
    const after = await dispatcher.dispatch(post('/v1/step-up/options', originBody));

    // Assert
    should(during.status).equal(200);
    should([after.status, jsonBody(after).code]).deepEqual([401, UNLOCK_REQUIRED_CODE]);
  });

  it('should refuse a confirmation with no challenge: 401 step_up_not_verified', async () => {
    // Arrange
    const dispatcher = await mount({ ...ask, store: new MemoryStore([stored(CREDENTIAL_ID)]) }).surface;

    // Act
    const response = await dispatcher.dispatch(post('/v1/unlock', assertionBody));

    // Assert
    should([response.status, jsonBody(response).code]).deepEqual([401, stepUpRefusalCode('not-verified')]);
  });

  it('should refuse a confirmation that carries a rotation: 401 step_up_not_verified', async () => {
    // Arrange
    const dispatcher = await mount({ ...ask, store: new MemoryStore([stored(CREDENTIAL_ID)]) }).surface;
    await dispatcher.dispatch(post('/v1/unlock/options', originBody));
    const body = json({ ...JSON.parse(assertionBody), rotation: { deviceKey: 'bmV3', proof: 'cHJvb2Y' } });

    // Act
    const response = await dispatcher.dispatch(post('/v1/unlock', body));

    // Assert
    should([response.status, jsonBody(response).code]).deepEqual([401, stepUpRefusalCode('not-verified')]);
  });

  it('should ask a browser the carrier proved local, and never ask a caller that is not a device', async () => {
    // B4: a browser is never at the machine, so an unlock is asked of it wherever it runs.
    // Arrange
    const dispatcher = await mount({ ...ask, store: new MemoryStore([stored(CREDENTIAL_ID)]) }).surface;

    // Act
    const onHost = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/step-up/options', body: originBody, privilegedLoopback: true, ...asDevice }),
    );
    const noDevice = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/step-up/options', body: originBody, ...asAdminNoDevice }),
    );

    // Assert
    should([onHost.status, jsonBody(onHost).code]).deepEqual([401, UNLOCK_REQUIRED_CODE]);
    should([noDevice.status, jsonBody(noDevice).code]).deepEqual([400, stepUpRefusalCode('not-a-device')]);
  });

  it('should refuse the unlock routes to a caller that is not a device: 400 step_up_not_a_device', async () => {
    // Arrange
    const dispatcher = await mount(ask).surface;

    for (const route of ROUTES.filter(entry => entry.path.startsWith('/v1/unlock'))) {
      // Act
      const response = await dispatcher.dispatch(
        request({ method: route.method, path: route.path, body: route.body, ...asAdminNoDevice }),
      );

      // Assert
      should([route.path, response.status, jsonBody(response).code]).deepEqual([
        route.path,
        400,
        stepUpRefusalCode('not-a-device'),
      ]);
    }
  });

  it('should refuse unlock options for an origin the machine does not serve: 403', async () => {
    // Arrange
    const dispatcher = await mount({ ...ask, store: new MemoryStore([stored(CREDENTIAL_ID)]) }).surface;

    // Act
    const response = await dispatcher.dispatch(
      post('/v1/unlock/options', json({ origin: 'https://elsewhere.example.test' })),
    );

    // Assert
    should([response.status, jsonBody(response).code]).deepEqual([403, stepUpRefusalCode('origin-not-allowed')]);
  });
});

describe('step-up routes: key rotation (B6)', () => {
  const TRANSCRIPT = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const rotationBody = json({ ...JSON.parse(assertionBody), rotation: { deviceKey: 'bmV3LWtleQ', proof: 'cHJvb2Y' } });

  /** A rotation port for a key issued `ageDays` ago, answering what the case says. */
  const rotationPort = (ageDays: number, swapped = true) => {
    const rotated: Parameters<DeviceKeyRotationPort['rotate']>[0][] = [];
    const port: DeviceKeyRotationPort = {
      keyIssuedAt: () => NOW - ageDays * 86_400_000,
      verify: async () => true,
      rotate: async input => {
        rotated.push(input);
        return swapped;
      },
    };
    return { port, rotated };
  };

  /** A session-carried request: what the tunnel produces, with the transcript the proof is bound to. */
  const inSession = (body: string, path = '/v1/step-up') => ({
    ...request({ method: 'POST', path, body, ...asDevice }),
    transcriptHash: TRANSCRIPT,
  });

  it('should answer 403 step_up_rotation_required, naming what happens next, once the key is due', async () => {
    // Arrange
    const { port } = rotationPort(30);
    const world = mount({
      settings: { deviceKeyRotationDays: 30, unlockOnOpen: false },
      rotation: port,
      store: new MemoryStore([stored(CREDENTIAL_ID)]),
    });
    const dispatcher = await world.surface;
    await dispatcher.dispatch(inSession(originBody, '/v1/step-up/options'));

    // Act
    const response = await dispatcher.dispatch(inSession(assertionBody));

    // Assert
    should([response.status, jsonBody(response).code]).deepEqual([403, stepUpRefusalCode('rotation-required')]);
    should(jsonBody(response).error).equal(
      "this device's key is due for replacement, and this machine replaces it with the next passkey confirmation",
    );
    should(world.service.held(browser)).be.false();
  });

  it('should rotate the key in the same step-up that was refused, answering keyRotated', async () => {
    // Arrange
    const { port, rotated } = rotationPort(31);
    const dispatcher = await mount({
      settings: { deviceKeyRotationDays: 30, unlockOnOpen: false },
      rotation: port,
      store: new MemoryStore([stored(CREDENTIAL_ID)]),
    }).surface;
    await dispatcher.dispatch(inSession(originBody, '/v1/step-up/options'));
    const refused = await dispatcher.dispatch(inSession(assertionBody));

    // Act
    const granted = await dispatcher.dispatch(inSession(rotationBody));

    // Assert
    should(refused.status).equal(403);
    should(granted.status).equal(200);
    should(jsonBody(granted)).deepEqual({
      expiresAt: new Date(NOW + STEP_UP_TTL_SECONDS * 1_000).toISOString(),
      keyRotated: true,
    });
    should(rotated).deepEqual([{ deviceId, deviceKey: 'bmV3LWtleQ', transcriptHash: TRANSCRIPT }]);
  });

  it('should answer 400 step_up_not_a_device when the device was revoked between the assertion and the swap', async () => {
    // Arrange
    const { port } = rotationPort(31, false);
    const dispatcher = await mount({
      settings: { deviceKeyRotationDays: 30, unlockOnOpen: false },
      rotation: port,
      store: new MemoryStore([stored(CREDENTIAL_ID)]),
    }).surface;
    await dispatcher.dispatch(inSession(originBody, '/v1/step-up/options'));

    // Act
    const response = await dispatcher.dispatch(inSession(rotationBody));

    // Assert
    should([response.status, jsonBody(response).code]).deepEqual([400, stepUpRefusalCode('not-a-device')]);
  });

  it('should refuse a rotation the request did not carry a session transcript for: 401 step_up_not_verified', async () => {
    // Arrange
    const { port, rotated } = rotationPort(31);
    const dispatcher = await mount({
      settings: { deviceKeyRotationDays: 30, unlockOnOpen: false },
      rotation: port,
      store: new MemoryStore([stored(CREDENTIAL_ID)]),
    }).surface;
    await dispatcher.dispatch(inSession(originBody, '/v1/step-up/options'));

    // Act
    const response = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/step-up', body: rotationBody, ...asDevice }),
    );

    // Assert
    should([response.status, jsonBody(response).code]).deepEqual([401, stepUpRefusalCode('not-verified')]);
    should(rotated).deepEqual([]);
  });

  describe('inside an unlock', () => {
    const unlocking = (ageDays: number, swapped = true) => {
      const { port, rotated } = rotationPort(ageDays, swapped);
      const world = mount({
        settings: { deviceKeyRotationDays: 30, unlockOnOpen: true },
        rotation: port,
        store: new MemoryStore([stored(CREDENTIAL_ID)]),
      });
      return { world, rotated };
    };

    it('should answer 403 step_up_rotation_required to an unlock once the key is due, and stay locked', async () => {
      // Arrange
      const { world } = unlocking(30);
      const dispatcher = await world.surface;
      await dispatcher.dispatch(inSession(originBody, '/v1/unlock/options'));

      // Act
      const response = await dispatcher.dispatch(inSession(assertionBody, '/v1/unlock'));

      // Assert
      should([response.status, jsonBody(response).code]).deepEqual([403, stepUpRefusalCode('rotation-required')]);
      should(world.service.unlockRequired(browser)).be.true();
    });

    it('should rotate the key in the unlock that was refused, answering unlockedUntil and keyRotated', async () => {
      // Arrange
      const { world, rotated } = unlocking(31);
      const dispatcher = await world.surface;
      await dispatcher.dispatch(inSession(originBody, '/v1/unlock/options'));
      const refused = await dispatcher.dispatch(inSession(assertionBody, '/v1/unlock'));

      // Act
      const granted = await dispatcher.dispatch(inSession(rotationBody, '/v1/unlock'));

      // Assert
      should(refused.status).equal(403);
      should(granted.status).equal(200);
      should(jsonBody(granted)).deepEqual({
        unlockedUntil: new Date(NOW + 8 * 3_600_000).toISOString(),
        keyRotated: true,
      });
      should(rotated).deepEqual([{ deviceId, deviceKey: 'bmV3LWtleQ', transcriptHash: TRANSCRIPT }]);
      should(world.service.unlockRequired(browser)).be.false();
    });

    it('should answer 400 step_up_not_a_device when the device was revoked between the assertion and the swap', async () => {
      // Arrange
      const { world } = unlocking(31, false);
      const dispatcher = await world.surface;
      await dispatcher.dispatch(inSession(originBody, '/v1/unlock/options'));

      // Act
      const response = await dispatcher.dispatch(inSession(rotationBody, '/v1/unlock'));

      // Assert
      should([response.status, jsonBody(response).code]).deepEqual([400, stepUpRefusalCode('not-a-device')]);
    });

    it('should refuse a rotation the request carried no session transcript for: 401 step_up_not_verified', async () => {
      // Arrange
      const { world, rotated } = unlocking(31);
      const dispatcher = await world.surface;
      await dispatcher.dispatch(inSession(originBody, '/v1/unlock/options'));

      // Act
      const response = await dispatcher.dispatch(
        request({ method: 'POST', path: '/v1/unlock', body: rotationBody, ...asDevice }),
      );

      // Assert
      should([response.status, jsonBody(response).code]).deepEqual([401, stepUpRefusalCode('not-verified')]);
      should(rotated).deepEqual([]);
    });
  });
});
