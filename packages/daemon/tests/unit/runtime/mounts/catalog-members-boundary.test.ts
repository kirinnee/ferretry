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
import {
  type CatalogMemberSubsystem,
  catalogMemberRoutes,
} from '../../../../src/lib/runtime/mounts/catalog-members.ts';
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
 * THE MEMBER ROUTES AT THE BOUNDARY: the REAL step-up service, security settings and dispatcher around the real route
 * table, with only the passkey verdict and the members service replaced. A mint and the "new passkey" mark ask for the
 * one `share-catalog` passkey and must still get it when the step-up window is zero minutes (the boundary must not
 * spend the proof the handler is about to claim); every route that only takes access away asks nothing beyond the unlock.
 */

const T0 = Date.parse('2026-10-14T09:00:00.000Z');
const ORIGIN = 'https://app.example.test';
const deviceId = `fy_device_id_${'d'.repeat(22)}`;
const phone = { deviceId, appSession: 'app-one' } as const;
const CREDENTIAL_ID = Buffer.from([1, 2, 3, 4]).toString('base64url');
const CAT = `cat_${'c'.repeat(22)}`;
const MEMBER = `mbr_${'m'.repeat(22)}`;
const KEY = `mk_${'k'.repeat(22)}`;
const SHARE = `shr_${'s'.repeat(22)}`;

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
const MINT = {
  catalogIds: [CAT],
  member: { kind: 'new', label: 'Alice' },
  expiresIn: '1h',
  uses: { kind: 'single' },
};

class FakeMembers {
  readonly calls: string[] = [];
  async mint() {
    this.calls.push('mint');
    return { shareId: SHARE, code: 'SECRETCODE', link: 'https://app.example.test/join#SECRETCODE' };
  }
  async markNewPasskey(_shareId: string, on: boolean) {
    this.calls.push(on ? 'mark' : 'unmark');
    return { shareId: SHARE };
  }
  async endShare() {
    this.calls.push('endShare');
    return { shareId: SHARE };
  }
  async revokeMember() {
    this.calls.push('revokeMember');
    return { memberId: MEMBER };
  }
  async removeKey() {
    this.calls.push('removeKey');
    return { memberId: MEMBER };
  }
  async removeCatalog() {
    this.calls.push('removeCatalog');
    return { memberId: MEMBER };
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
  const members = new FakeMembers();
  const http = new ApiDispatcher(
    new ApiRouter([...stepUpRoutes(service), ...catalogMemberRoutes({ members } as unknown as CatalogMemberSubsystem)]),
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
  const askAsFerret = (method: string, path: string, body?: unknown) =>
    http.dispatch(
      request({
        method,
        path,
        loopback: true,
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer admin-secret',
          'x-ferretry-session-id': 'ferret-one',
        },
        reads: bodyReads(),
        ...(body === undefined ? {} : { body: json(body) }),
      }),
    );
  const unlock = async () => {
    should((await ask('POST', '/v1/unlock/options', { origin: ORIGIN })).status).equal(200);
    should((await ask('POST', '/v1/unlock', JSON.parse(assertionBody))).status).equal(200);
  };
  const prove = async (act: string = STEP_UP_ACTS.shareCatalog) => {
    should((await ask('POST', '/v1/step-up/options', { origin: ORIGIN, act })).status).equal(200);
    should((await ask('POST', '/v1/step-up', JSON.parse(assertionBody))).status).equal(200);
  };
  const mint = () => ask('POST', '/v1/catalog-shares', MINT);
  const mark = () => ask('PUT', `/v1/catalog-shares/${SHARE}/new-passkey`);
  return { members, ask, askAsFerret, unlock, prove, mint, mark };
}

const codeOf = (response: { body: string }): string | undefined =>
  (JSON.parse(response.body) as { code?: string }).code;

const WINDOWS = [
  ['a zero-minute window', { stepUpOnActions: true, stepUpWindowMinutes: 0 }],
  ['the default window', {}],
] as const;

describe.each([
  ['minting a share', 'mint', 'mint'],
  ['marking an invite "they need a new passkey"', 'mark', 'mark'],
] as const)('%s at the boundary', (_title, call, recorded) => {
  it.each(WINDOWS)(
    'should refuse without the share-catalog passkey, then serve after one, with %s',
    async (_name, settings) => {
      // Arrange
      const world = await machine(settings);
      await world.unlock();

      // Act
      const refused = await world[call]();
      await world.prove();
      const served = await world[call]();

      // Assert
      should([refused.status, codeOf(refused)]).deepEqual([403, STEP_UP_REQUIRED_CODE]);
      should(served.status).equal(call === 'mint' ? 201 : 200);
      should(world.members.calls).deepEqual([recorded]);
    },
  );

  it.each(WINDOWS)(
    'should let exactly one of two concurrent calls spend one proof, with %s',
    async (_name, settings) => {
      // Arrange
      const world = await machine(settings);
      await world.unlock();
      await world.prove();

      // Act
      const answers = await Promise.all([world[call](), world[call]()]);

      // Assert
      should(answers.map(answer => answer.status).sort()).deepEqual([call === 'mint' ? 201 : 200, 403]);
      should(world.members.calls).deepEqual([recorded]);
    },
  );

  it('should refuse a proof made for another act', async () => {
    // Arrange
    const world = await machine({});
    await world.unlock();
    await world.prove(STEP_UP_ACTS.shareLink);

    // Act
    const answer = await world[call]();

    // Assert
    should([answer.status, codeOf(answer)]).deepEqual([403, STEP_UP_REQUIRED_CODE]);
    should(world.members.calls).be.empty();
  });

  it('should refuse a device that has not unlocked', async () => {
    // Arrange
    const world = await machine({});

    // Act
    const answer = await world[call]();

    // Assert
    should(answer.status).equal(401);
    should(world.members.calls).be.empty();
  });
});

describe('a governed device that asks for a passkey on every act', () => {
  const ACT_ON = { stepUpOnActions: true, stepUpWindowMinutes: 0 } as const;
  const REMOVALS = [
    ['DELETE', `/v1/catalog-shares/${SHARE}/new-passkey`, 'unmark'],
    ['DELETE', `/v1/catalog-shares/${SHARE}`, 'endShare'],
    ['DELETE', `/v1/catalog-members/${MEMBER}`, 'revokeMember'],
    ['DELETE', `/v1/catalog-members/${MEMBER}/keys/${KEY}`, 'removeKey'],
    ['DELETE', `/v1/catalog-members/${MEMBER}/catalogs/${CAT}`, 'removeCatalog'],
  ] as const;

  it.each(REMOVALS)('should serve %s %s twice with no per-act proof', async (method, path, recorded) => {
    // Arrange
    const world = await machine(ACT_ON);
    await world.unlock();

    // Act
    const first = await world.ask(method, path);
    const second = await world.ask(method, path);

    // Assert
    should([first.status, second.status]).deepEqual([200, 200]);
    should(world.members.calls).deepEqual([recorded, recorded]);
  });

  it.each(REMOVALS)('should refuse %s %s before the unlock', async (method, path) => {
    // Arrange
    const world = await machine(ACT_ON);

    // Act
    const answer = await world.ask(method, path);

    // Assert
    should(answer.status).equal(401);
    should(world.members.calls).be.empty();
  });
});

describe('a ferret', () => {
  it('should be refused a mint and the mark, and every removal, whatever it holds', async () => {
    // Arrange
    const world = await machine({});

    // Act
    const answers = [
      await world.askAsFerret('POST', '/v1/catalog-shares', MINT),
      await world.askAsFerret('PUT', `/v1/catalog-shares/${SHARE}/new-passkey`),
      await world.askAsFerret('DELETE', `/v1/catalog-shares/${SHARE}`),
      await world.askAsFerret('DELETE', `/v1/catalog-members/${MEMBER}`),
    ];

    // Assert
    should(answers.map(answer => [answer.status, codeOf(answer)])).deepEqual(answers.map(() => [403, 'owner_only']));
    should(world.members.calls).be.empty();
  });
});
