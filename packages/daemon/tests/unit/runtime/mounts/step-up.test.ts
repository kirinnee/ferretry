import { describe, it } from 'bun:test';
import { MAX_PASSKEYS_PER_DEVICE, STEP_UP_TTL_SECONDS, stepUpRefusalCode } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher, ApiRouter } from '../../../../src/lib/api/index.ts';
import { DEFAULT_CAPABILITY_GRANTS } from '../../../../src/lib/grants/index.ts';
import { stepUpRoutes } from '../../../../src/lib/runtime/mounts/step-up.ts';
import {
  ChallengeLedger,
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
const newRegistry = (): StepUpRegistry => {
  const registry = new StepUpRegistry({ nowMs: () => NOW });
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

  async updateSignCount(id: string, credentialId: string, signCount: number): Promise<void> {
    this.held = this.held.map(passkey =>
      passkey.deviceId === id && passkey.credentialId === credentialId ? { ...passkey, signCount } : passkey,
    );
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
}

function mount(world: World = {}) {
  const store = world.store ?? new MemoryStore();
  const verifier = new FakeVerifier();
  const registry = newRegistry();
  const audited: { readonly actor: string; readonly changes: readonly string[] }[] = [];
  const service = new StepUpService({
    store,
    verifier,
    registry,
    challenges: new ChallengeLedger(),
    random: { bytes: length => new Uint8Array(length).fill(7) },
    clock: { nowMs: () => NOW },
    devices: {
      device: async id =>
        world.known === false || id !== deviceId
          ? undefined
          : { name: 'Pixel 8', createdAt: new Date(NOW - (world.pairedAgoMs ?? 60_000)).toISOString() },
    },
    allowedOrigins: () => [ORIGIN],
    relyingPartyName: 'Ferretry',
    audit: {
      record: async entry => {
        audited.push(entry);
      },
    },
  });
  const grants = grantSubsystem({ grants: DEFAULT_CAPABILITY_GRANTS });
  const surface = (async () => {
    await grants.refresh();
    return new ApiDispatcher(new ApiRouter(stepUpRoutes(service)), credentials, grants);
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
    should(jsonBody(during)).containEql({
      registration: 'stepped-up',
      stepUpUntil: new Date(NOW + STEP_UP_TTL_SECONDS * 1_000).toISOString(),
    });
    should(stepOptions.status).equal(200);
    should(jsonBody(stepOptions)).containEql({ rpId: 'app.example.test' });
    should(stepped.status).equal(200);
    should(jsonBody(stepped)).deepEqual({ expiresAt: new Date(NOW + STEP_UP_TTL_SECONDS * 1_000).toISOString() });
    should(store.held[0]?.signCount).equal(5);
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

    // Act — a browser on a host-proven carrier, on a loopback peer, behind a spoofed header; then the owner
    const refused = [
      await asBrowser({ loopback: true, privilegedLoopback: true }),
      await asBrowser({ loopback: true }),
      await asBrowser({ headers: lookalike }),
    ];
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

    // Assert
    for (const response of refused)
      should([response.status, jsonBody(response).code]).deepEqual([403, stepUpRefusalCode('not-at-machine')]);
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
    // Another copy of the app on the same device holds no step-up: the window, not the step-up, is asked.
    const otherTab = await dispatcher.dispatch(
      request({ path: '/v1/passkeys', device: { deviceId, appSession: 'app-two' } }),
    );

    // Assert
    should(registered.status).equal(201);
    should(jsonBody(otherTab)).containEql({ registration: 'closed' });
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
    should(jsonBody(same)).containEql({ registration: 'stepped-up' });
    should(jsonBody(otherTab)).containEql({ registration: 'closed' });
    should(store.held).have.length(1);
  });
});
