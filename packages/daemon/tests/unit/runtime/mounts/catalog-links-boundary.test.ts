import { describe, it } from 'bun:test';
import {
  type CapabilityGrants,
  DEFAULT_SECURITY_SETTINGS,
  type SecuritySettings,
  STEP_UP_ACTS,
  STEP_UP_REQUIRED_CODE,
} from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { DEFAULT_CAPABILITY_GRANTS } from '../../../../src/lib/grants/index.ts';
import { type CatalogLinkSubsystem, catalogLinkRoutes } from '../../../../src/lib/runtime/mounts/catalog-links.ts';
import { stepUpRoutes } from '../../../../src/lib/runtime/mounts/step-up.ts';
import { SecuritySettingsService } from '../../../../src/lib/security/index.ts';
import {
  ChallengeLedger,
  type PasskeyStore,
  type PasskeyVerifierPort,
  StepUpRegistry,
  StepUpService,
  type StoredPasskey,
} from '../../../../src/lib/step-up/index.ts';
import { bodyReads, request } from '../../api/support.ts';
import { grantSubsystem } from './support.ts';

/**
 * THE LINK ROUTES AT THE BOUNDARY: the REAL step-up service, security settings and dispatcher around the real route
 * table, with only the passkey verdict and the links subsystem replaced. A narrowing, Copy and turning off ask
 * nothing beyond the unlock; a move and a widening ask for the one `share-link` passkey, and must still get it when
 * the step-up window is zero minutes (the boundary must not spend the proof the handler is about to claim).
 */

const T0 = Date.parse('2026-10-14T09:00:00.000Z');
const ORIGIN = 'https://app.example.test';
const deviceId = `fy_device_id_${'d'.repeat(22)}`;
const phone = { deviceId, appSession: 'app-one' } as const;
const CREDENTIAL_ID = Buffer.from([1, 2, 3, 4]).toString('base64url');
const LINK_ID = `lnk_${'l'.repeat(22)}`;
const DIGEST = `sha256:${'a'.repeat(64)}`;

class MemoryStore implements PasskeyStore {
  held: StoredPasskey[] = [
    {
      credentialId: CREDENTIAL_ID,
      deviceId,
      algorithm: -7,
      publicKeySpki: Buffer.from([9, 9, 9, 9]).toString('base64url'),
      signCount: 1,
      origin: ORIGIN,
      createdAt: '2026-10-14T08:00:00.000Z',
    },
  ];
  async list(id: string) {
    return this.held.filter(passkey => passkey.deviceId === id);
  }
  async holder(credentialId: string) {
    return this.held.find(passkey => passkey.credentialId === credentialId)?.deviceId;
  }
  async add(passkey: StoredPasskey) {
    this.held.push(passkey);
  }
  async updateSignCount(id: string, credentialId: string, signCount: number) {
    const passkey = this.held.find(entry => entry.deviceId === id && entry.credentialId === credentialId);
    if (passkey === undefined || signCount <= passkey.signCount) return false;
    this.held = this.held.map(entry => (entry === passkey ? { ...entry, signCount } : entry));
    return true;
  }
  async forgetDevice() {}
}

let assertions = 0;
const verifier: PasskeyVerifierPort = {
  verifyRegistration: async () => ({ ok: false, reason: 'unused' }),
  verifyAssertion: async () => {
    assertions += 1;
    return { ok: true, signCount: 100 + assertions, origin: ORIGIN };
  },
};

const json = (value: unknown): string => JSON.stringify(value);
const assertionBody = json({
  credentialId: CREDENTIAL_ID,
  clientDataJSON: 'Y2xpZW50',
  authenticatorData: 'YXV0aA',
  signature: 'c2ln',
});
const MINT = { item: { itemId: `itm_${'i'.repeat(22)}`, version: 1, digest: DIGEST }, kind: 'public', expires: '7d' };
const MOVE = { version: 2, from: 1, digest: DIGEST };

class FakeLinks {
  readonly calls: string[] = [];
  widening = false;
  async storeStatus() {
    return { available: true };
  }
  async mint() {
    this.calls.push('mint');
    return { link: { linkId: LINK_ID }, url: 'https://app.example.test/l#v1;b=x;k=SECRETKEY' };
  }
  async move(linkId: string) {
    this.calls.push('move');
    return { linkId, version: 2 };
  }
  async widens() {
    return this.widening;
  }
  async update(linkId: string) {
    this.calls.push('update');
    return { linkId };
  }
  async copy() {
    this.calls.push('copy');
    return { url: 'https://app.example.test/l#v1;b=x;k=SECRETKEY' };
  }
  async revoke(linkId: string) {
    this.calls.push('revoke');
    return { linkId, state: 'ended' };
  }
}

async function machine(initial: Partial<SecuritySettings>, granted: CapabilityGrants = DEFAULT_CAPABILITY_GRANTS) {
  const clock = { now: T0 };
  const stored: SecuritySettings = { ...DEFAULT_SECURITY_SETTINGS, ...initial };
  const security = new SecuritySettingsService({
    document: {
      read: async () => ({ settings: stored, updatedAt: '2026-10-01T00:00:00.000Z' }),
      write: async () => {},
    },
    audit: { record: async () => {}, recent: async () => ({ entries: [], unreadable: 0, truncated: false }) },
    clock: { nowMs: () => clock.now },
    widenCommand: 'fy daemon security set <field> <value>',
  });
  await security.refresh();
  const registry = new StepUpRegistry({ nowMs: () => clock.now }, () => security.current().stepUpWindowMinutes);
  registry.open(phone);
  const service = new StepUpService({
    store: new MemoryStore(),
    verifier,
    registry,
    challenges: new ChallengeLedger(),
    random: { bytes: length => new Uint8Array(length).fill(7) },
    clock: { nowMs: () => clock.now },
    devices: {
      device: async id => (id === deviceId ? { name: 'Phone', createdAt: '2026-10-14T08:00:00.000Z' } : undefined),
    },
    allowedOrigins: () => [ORIGIN],
    relyingPartyName: 'Ferretry',
    machineName: 'studio',
    settings: () => security.current(),
    audit: { record: async () => {} },
  });
  const grants = grantSubsystem({ grants: granted });
  await grants.refresh();
  const links = new FakeLinks();
  const http = new ApiDispatcher(
    new ApiRouter([...stepUpRoutes(service), ...catalogLinkRoutes({ links } as unknown as CatalogLinkSubsystem)]),
    {
      admin: 'admin-secret',
      warden: 'warden-secret',
      devices: { has: (id: string) => id === deviceId, grants: () => DEFAULT_CAPABILITY_GRANTS },
    },
    grants,
    undefined,
    service,
  );
  const ask = (method: string, path: string, body?: unknown) =>
    http.dispatch(
      request({
        method,
        path,
        device: phone,
        loopback: false,
        headers: { 'content-type': 'application/json' },
        reads: bodyReads(),
        ...(body === undefined ? {} : { body: json(body) }),
      }),
    );
  const unlock = async () => {
    should((await ask('POST', '/v1/unlock/options', { origin: ORIGIN })).status).equal(200);
    should((await ask('POST', '/v1/unlock', JSON.parse(assertionBody))).status).equal(200);
  };
  const prove = async (act: string = STEP_UP_ACTS.shareLink) => {
    should((await ask('POST', '/v1/step-up/options', { origin: ORIGIN, act })).status).equal(200);
    should((await ask('POST', '/v1/step-up', JSON.parse(assertionBody))).status).equal(200);
  };
  const mint = () => ask('POST', '/v1/catalog-links', MINT);
  const move = () => ask('PUT', `/v1/catalog-links/${LINK_ID}/version`, MOVE);
  const patch = (body: unknown) => ask('PATCH', `/v1/catalog-links/${LINK_ID}`, body);
  return { links, ask, unlock, prove, mint, move, patch };
}

const codeOf = (response: { body: string }): string | undefined =>
  (JSON.parse(response.body) as { code?: string }).code;

describe('a governed device that asks for a passkey on every act', () => {
  const ACT_ON = { stepUpOnActions: true, stepUpWindowMinutes: 0 } as const;

  it('should narrow, copy and turn off a link with no per-act proof', async () => {
    // Arrange
    const world = await machine(ACT_ON);
    await world.unlock();

    // Act
    const narrowed = await world.patch({ expires: '1d' });
    const copied = await world.ask('POST', `/v1/catalog-links/${LINK_ID}/copy`);
    const ended = await world.ask('DELETE', `/v1/catalog-links/${LINK_ID}`);

    // Assert
    should([narrowed.status, copied.status, ended.status]).deepEqual([200, 200, 200]);
    should(world.links.calls).deepEqual(['update', 'copy', 'revoke']);
  });

  it('should refuse a move without the share-link passkey, and serve it after one, with a zero-minute window', async () => {
    // Arrange
    const world = await machine(ACT_ON);
    await world.unlock();

    // Act
    const refused = await world.move();
    await world.prove();
    const served = await world.move();

    // Assert
    should([refused.status, codeOf(refused)]).deepEqual([403, STEP_UP_REQUIRED_CODE]);
    should(served.status).equal(200);
    should(world.links.calls).deepEqual(['move']);
  });

  it('should refuse a widening without the share-link passkey, and serve it after one, with a zero-minute window', async () => {
    // Arrange
    const world = await machine(ACT_ON);
    world.links.widening = true;
    await world.unlock();

    // Act
    const refused = await world.patch({ expires: 'never' });
    await world.prove();
    const served = await world.patch({ expires: 'never' });

    // Assert
    should([refused.status, codeOf(refused)]).deepEqual([403, STEP_UP_REQUIRED_CODE]);
    should(served.status).equal(200);
    should(world.links.calls).deepEqual(['update']);
  });

  it('should spend the proof on one move, so a second needs another', async () => {
    // Arrange
    const world = await machine(ACT_ON);
    await world.unlock();
    await world.prove();

    // Act
    const first = await world.move();
    const second = await world.move();

    // Assert
    should([first.status, second.status]).deepEqual([200, 403]);
  });
});

describe('minting a link at the boundary', () => {
  it.each([
    ['a zero-minute window', { stepUpOnActions: true, stepUpWindowMinutes: 0 }],
    ['the default window', {}],
  ] as const)(
    'should refuse without the share-link passkey, then serve after one, with %s',
    async (_name, settings) => {
      const world = await machine(settings);
      await world.unlock();

      const refused = await world.mint();
      await world.prove();
      const served = await world.mint();

      should([refused.status, codeOf(refused)]).deepEqual([403, STEP_UP_REQUIRED_CODE]);
      should(served.status).equal(201);
      should(world.links.calls).deepEqual(['mint']);
    },
  );

  it.each([
    ['a zero-minute window', { stepUpOnActions: true, stepUpWindowMinutes: 0 }],
    ['the default window', {}],
  ] as const)('should let exactly one of two concurrent mints spend one proof, with %s', async (_name, settings) => {
    const world = await machine(settings);
    await world.unlock();
    await world.prove();

    const answers = await Promise.all([world.mint(), world.mint()]);

    should(answers.map(answer => answer.status).sort()).deepEqual([201, 403]);
    should(world.links.calls).deepEqual(['mint']);
  });

  it.each([
    ['a mint', (world: Awaited<ReturnType<typeof machine>>) => world.mint()],
    ['a move', (world: Awaited<ReturnType<typeof machine>>) => world.move()],
  ] as const)('should leave the next governed act unproved after %s, with a zero-minute window', async (_name, act) => {
    const world = await machine({ stepUpOnActions: true, stepUpWindowMinutes: 0 });
    await world.unlock();
    await world.prove();

    const served = await act(world);
    const store = await world.ask('GET', '/v1/catalog-links/store');

    should(served.status).be.oneOf(200, 201);
    should([store.status, codeOf(store)]).deepEqual([403, STEP_UP_REQUIRED_CODE]);
  });

  // A failed claim must not spend anything: with no second proof, the unlock's held step-up serves exactly one read.
  it('should leave the held step-up unspent when the mint was refused for want of the proof, with a zero-minute window', async () => {
    // Arrange
    const world = await machine({ stepUpOnActions: true, stepUpWindowMinutes: 0 });
    await world.unlock();

    // Act
    const refused = await world.mint();
    const first = await world.ask('GET', '/v1/catalog-links/store');
    const second = await world.ask('GET', '/v1/catalog-links/store');

    // Assert
    should([refused.status, codeOf(refused)]).deepEqual([403, STEP_UP_REQUIRED_CODE]);
    should(first.status).equal(200);
    should([second.status, codeOf(second)]).deepEqual([403, STEP_UP_REQUIRED_CODE]);
    should(world.links.calls).be.empty();
  });

  it('should serve the mint on its own proof after a refused one, with a zero-minute window', async () => {
    const world = await machine({ stepUpOnActions: true, stepUpWindowMinutes: 0 });
    await world.unlock();

    const refused = await world.mint();
    await world.prove();
    const served = await world.mint();

    should([refused.status, codeOf(refused)]).deepEqual([403, STEP_UP_REQUIRED_CODE]);
    should(served.status).equal(201);
  });

  it('should refuse a proof made for another act', async () => {
    const world = await machine({});
    await world.unlock();
    await world.prove(STEP_UP_ACTS.shareCatalog);

    const answer = await world.mint();

    should([answer.status, codeOf(answer)]).deepEqual([403, STEP_UP_REQUIRED_CODE]);
    should(world.links.calls).be.empty();
  });
});

describe('a governed device that has not unlocked', () => {
  it('should be refused every link change at the door, narrowing included', async () => {
    // Arrange
    const world = await machine({});

    // Act
    const answers = [
      await world.patch({ expires: '1d' }),
      await world.ask('POST', `/v1/catalog-links/${LINK_ID}/copy`),
      await world.ask('DELETE', `/v1/catalog-links/${LINK_ID}`),
      await world.move(),
    ];

    // Assert
    should(answers.map(answer => answer.status)).deepEqual([401, 401, 401, 401]);
    should(world.links.calls).be.empty();
  });
});
