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
import { type SecretSubsystem, secretRoutes } from '../../../../src/lib/runtime/mounts/secrets.ts';
import { stepUpRoutes } from '../../../../src/lib/runtime/mounts/step-up.ts';
import { LoginRecipeService } from '../../../../src/lib/secrets/index.ts';
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
import { CREDENTIALS, grantSubsystem, human, MemoryLoginIndex, secretSubsystem } from './support.ts';

/**
 * APPROVING A RECIPE AT THE BOUNDARY: the REAL dispatcher, capability policy, step-up service and in-memory registry
 * around the real secret routes, with only the passkey verdict replaced. The approve proof is bound to ONE proposal;
 * a decline asks nothing; admission spends nothing, so a zero-minute window still lets the handler claim the proof.
 */

const T0 = Date.parse('2026-11-03T09:00:00.000Z');
const ORIGIN = 'https://app.example.test';
const deviceId = `fy_device_id_${'d'.repeat(22)}`;
const phone = { deviceId, appSession: 'app-one' } as const;
const CREDENTIAL_ID = Buffer.from([1, 2, 3, 4]).toString('base64url');
const PASSWORD = 'correct-horse-battery-staple';
const A = 'rp_000000000000000a';
const B = 'rp_000000000000000b';

class MemoryStore implements PasskeyStore {
  held: StoredPasskey[] = [
    {
      credentialId: CREDENTIAL_ID,
      deviceId,
      algorithm: -7,
      publicKeySpki: Buffer.from([9, 9, 9, 9]).toString('base64url'),
      signCount: 1,
      origin: ORIGIN,
      createdAt: '2026-11-03T08:00:00.000Z',
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
const assertionBody = {
  credentialId: CREDENTIAL_ID,
  clientDataJSON: 'Y2xpZW50',
  authenticatorData: 'YXV0aA',
  signature: 'c2ln',
};

const NO_SECRETS_CONFIGURE: CapabilityGrants = {
  ...DEFAULT_CAPABILITY_GRANTS,
  secrets: { use: true, configure: false },
};

/** One account, one sign-in, and the ferret's two waiting proposals A and B for it. */
async function recipes(redact: (text: string) => Promise<string>) {
  const base = secretSubsystem({ loginIndex: new MemoryLoginIndex() });
  const logins = base.logins as NonNullable<SecretSubsystem['logins']>;
  const accounts = logins.accounts;
  const ids = [A, B];
  const service = new LoginRecipeService({
    logins,
    accounts,
    values: { redact },
    agenda: { raise: async () => ({ ok: true, id: 'A1' }), close: async () => undefined },
    audit: { record: async () => undefined },
    clock: { now: () => '2026-11-03T09:00:00.000Z' },
    newId: () => ids.shift() ?? A,
  });
  const subsystem: SecretSubsystem = { ...base, loginRecipes: service };
  await accounts.putAccount('SITE', { label: 'Site', password: PASSWORD });
  const signIn = await accounts.addSignIn('SITE', {
    place: { kind: 'site', domains: ['site.example'], match: [] },
    recipe: 'Open site.example and sign in',
  });
  await service.propose('ferret-1', { signIn: signIn.id }, 'Open site.example, then the 2FA page', 'first');
  await service.propose('ferret-2', { signIn: signIn.id }, 'Open site.example, then the SMS page', 'second');
  const recipeOf = async (): Promise<string | undefined> =>
    (await accounts.list()).signIns.find(each => each.id === signIn.id)?.recipe;
  const waiting = async (): Promise<readonly string[]> =>
    ((await accounts.list()).signIns.find(each => each.id === signIn.id)?.proposals ?? []).map(each => each.id);
  return { subsystem, signIn, recipeOf, waiting };
}

async function machine(
  initial: Partial<SecuritySettings> = {},
  granted: CapabilityGrants = DEFAULT_CAPABILITY_GRANTS,
  redact: (text: string) => Promise<string> = async text => text.replaceAll(PASSWORD, '[redacted]'),
) {
  const clock = { now: T0 };
  const stored: SecuritySettings = { ...DEFAULT_SECURITY_SETTINGS, ...initial };
  const security = new SecuritySettingsService({
    document: {
      read: async () => ({ settings: stored, updatedAt: '2026-11-01T00:00:00.000Z' }),
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
      device: async id => (id === deviceId ? { name: 'Phone', createdAt: '2026-11-03T08:00:00.000Z' } : undefined),
    },
    allowedOrigins: () => [ORIGIN],
    relyingPartyName: 'Ferretry',
    machineName: 'studio',
    settings: () => security.current(),
    audit: { record: async () => {} },
  });
  const grants = grantSubsystem({ grants: granted });
  await grants.refresh();
  const world = await recipes(redact);
  const http = new ApiDispatcher(
    new ApiRouter([...stepUpRoutes(service), ...secretRoutes(world.subsystem)]),
    {
      admin: CREDENTIALS.admin,
      warden: CREDENTIALS.warden,
      devices: { has: (id: string) => id === deviceId, grants: () => granted },
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
  const fromHost = (path: string, body: unknown) =>
    http.dispatch(
      request({
        method: 'POST',
        path,
        headers: { ...human, 'content-type': 'application/json' },
        loopback: true,
        reads: bodyReads(),
        body: json(body),
      }),
    );
  const unlock = async () => {
    should((await ask('POST', '/v1/unlock/options', { origin: ORIGIN })).status).equal(200);
    should((await ask('POST', '/v1/unlock', assertionBody)).status).equal(200);
  };
  /** Proves the approve-recipe passkey for ONE proposal. */
  const prove = async (proposal: string) => {
    const options = await ask('POST', '/v1/step-up/options', {
      origin: ORIGIN,
      act: STEP_UP_ACTS.approveRecipe,
      subject: proposal,
    });
    should(options.status).equal(200);
    should((await ask('POST', '/v1/step-up', assertionBody)).status).equal(200);
  };
  return { ...world, ask, fromHost, unlock, prove, service };
}

const codeOf = (response: { body: string }): string | undefined =>
  (JSON.parse(response.body) as { code?: string }).code;

const spellings = [
  {
    name: 'the sign-in route',
    path: (world: Awaited<ReturnType<typeof machine>>, proposal: string) =>
      `/v1/accounts/sign-ins/${world.signIn.id}/recipe/proposals/${proposal}`,
  },
  {
    name: 'the saved-login route',
    path: (_world: Awaited<ReturnType<typeof machine>>, proposal: string) =>
      `/v1/secrets/logins/SITE/recipe/proposals/${proposal}`,
  },
] as const;

const APPROVE = { decision: 'approve' } as const;
const DECLINE = { decision: 'decline' } as const;
const PER_ACTION = { stepUpOnActions: true, stepUpWindowMinutes: 0 } as const;

for (const spelling of spellings) {
  describe(`approving a recipe on ${spelling.name}, at the boundary`, () => {
    it('should approve with the passkey proved for that proposal, with a zero-minute window and per-action checks', async () => {
      // Arrange
      const world = await machine(PER_ACTION);
      await world.unlock();
      await world.prove(A);

      // Act
      const approved = await world.ask('POST', spelling.path(world, A), APPROVE);

      // Assert
      should(approved.status).equal(200);
      should(await world.recipeOf()).equal('Open site.example, then the 2FA page');
    });

    it('should spend the ordinary step-up with the approval, so a zero-minute window buys exactly one act', async () => {
      // Arrange
      const world = await machine(PER_ACTION);
      await world.unlock();
      await world.prove(A);
      const approved = await world.ask('POST', spelling.path(world, A), APPROVE);
      const heldAfterApproval = world.service.held(phone);

      // Act
      const ordinary = await world.ask('PUT', `/v1/accounts/sign-ins/${world.signIn.id}`, {
        recipe: 'Changed without another ceremony',
      });

      // Assert
      should([approved.status, heldAfterApproval, ordinary.status]).deepEqual([200, false, 403]);
      should(await world.recipeOf()).equal('Open site.example, then the 2FA page');
    });

    it('should leave the held step-up untouched when the claim names the wrong proposal', async () => {
      // Arrange
      const world = await machine(PER_ACTION);
      await world.unlock();
      await world.prove(A);

      // Act
      const wrong = await world.ask('POST', spelling.path(world, B), APPROVE);

      // Assert
      should(wrong.status).equal(403);
      should(world.service.held(phone)).equal(true);
    });

    it('should leave the held step-up untouched when the answer is a decline', async () => {
      // Arrange
      const world = await machine(PER_ACTION);
      await world.unlock();
      await world.prove(A);

      // Act
      const decline = await world.ask('POST', spelling.path(world, A), DECLINE);

      // Assert
      should(decline.status).equal(200);
      should(world.service.held(phone)).equal(true);
    });

    it('should not break the ordinary operations that follow, inside a positive window', async () => {
      // Arrange
      const world = await machine({ stepUpOnActions: true, stepUpWindowMinutes: 15 });
      await world.unlock();
      await world.prove(A);

      // Act
      const approved = await world.ask('POST', spelling.path(world, A), APPROVE);
      const ordinary = await world.ask('PUT', `/v1/accounts/sign-ins/${world.signIn.id}`, {
        recipe: 'Changed inside the window',
      });

      // Assert
      should([approved.status, ordinary.status]).deepEqual([200, 200]);
      should(world.service.held(phone)).equal(true);
    });

    it('should ask for the proof, naming the proposal, when none was proved', async () => {
      // Arrange
      const world = await machine(PER_ACTION);
      await world.unlock();

      // Act
      const refused = await world.ask('POST', spelling.path(world, A), APPROVE);

      // Assert
      should([refused.status, codeOf(refused)]).deepEqual([403, STEP_UP_REQUIRED_CODE]);
      should((JSON.parse(refused.body) as { demand: Record<string, unknown> }).demand).containEql({
        act: STEP_UP_ACTS.approveRecipe,
        subject: A,
      });
      should(await world.recipeOf()).equal('Open site.example and sign in');
    });

    it('should never ask for a passkey to decline, even with per-action checks', async () => {
      // Arrange
      const world = await machine(PER_ACTION);
      await world.unlock();

      // Act
      const declined = await world.ask('POST', spelling.path(world, A), DECLINE);

      // Assert
      should(declined.status).equal(200);
      should(await world.waiting()).deepEqual([B]);
    });

    it('should not let a proof for proposal A approve B, and leave the proof unspent for A', async () => {
      // Arrange
      const world = await machine(PER_ACTION);
      await world.unlock();
      await world.prove(A);

      // Act
      const wrong = await world.ask('POST', spelling.path(world, B), APPROVE);
      const right = await world.ask('POST', spelling.path(world, A), APPROVE);

      // Assert
      should([wrong.status, codeOf(wrong)]).deepEqual([403, STEP_UP_REQUIRED_CODE]);
      should(right.status).equal(200);
      should(await world.waiting()).deepEqual([B]);
    });

    it('should refuse a replay of a spent proof', async () => {
      // Arrange
      const world = await machine(PER_ACTION);
      await world.unlock();
      await world.prove(A);
      should((await world.ask('POST', spelling.path(world, A), APPROVE)).status).equal(200);

      // Act
      const replay = await world.ask('POST', spelling.path(world, B), APPROVE);

      // Assert
      should([replay.status, codeOf(replay)]).deepEqual([403, STEP_UP_REQUIRED_CODE]);
      should(await world.waiting()).deepEqual([B]);
    });

    it('should let only one of two concurrent approvals win one proof', async () => {
      // Arrange
      const world = await machine(PER_ACTION);
      await world.unlock();
      await world.prove(A);

      // Act
      const [first, second] = await Promise.all([
        world.ask('POST', spelling.path(world, A), APPROVE),
        world.ask('POST', spelling.path(world, A), APPROVE),
      ]);

      // Assert
      should([first.status, second.status].sort()).deepEqual([200, 403]);
    });

    it('should not take a proof proved for another act as the recipe proof', async () => {
      // Arrange
      const world = await machine(PER_ACTION);
      await world.unlock();
      should(
        (await world.ask('POST', '/v1/step-up/options', { origin: ORIGIN, act: STEP_UP_ACTS.shareLink })).status,
      ).equal(200);
      should((await world.ask('POST', '/v1/step-up', assertionBody)).status).equal(200);

      // Act
      const refused = await world.ask('POST', spelling.path(world, A), APPROVE);

      // Assert
      should([refused.status, codeOf(refused)]).deepEqual([403, STEP_UP_REQUIRED_CODE]);
    });

    it('should refuse a device that has not unlocked, decline included', async () => {
      // Arrange
      const world = await machine({});

      // Act
      const approve = await world.ask('POST', spelling.path(world, A), APPROVE);
      const decline = await world.ask('POST', spelling.path(world, A), DECLINE);

      // Assert
      should([approve.status, decline.status]).deepEqual([401, 401]);
      should(await world.waiting()).deepEqual([A, B]);
    });

    it('should refuse a device whose secrets.configure grant is denied, decline included', async () => {
      // Arrange
      const world = await machine({}, NO_SECRETS_CONFIGURE);
      await world.unlock();

      // Act
      const approve = await world.ask('POST', spelling.path(world, A), APPROVE);
      const decline = await world.ask('POST', spelling.path(world, A), DECLINE);

      // Assert
      should([approve.status, decline.status]).deepEqual([403, 403]);
      should(approve.body).not.containEql(STEP_UP_REQUIRED_CODE);
      should(await world.waiting()).deepEqual([A, B]);
    });

    it('should skip the proof for the machine itself, on loopback', async () => {
      // Arrange
      const world = await machine(PER_ACTION);

      // Act
      const approved = await world.fromHost(spelling.path(world, A), APPROVE);

      // Assert
      should(approved.status).equal(200);
      should(await world.recipeOf()).equal('Open site.example, then the 2FA page');
    });
  });
}

describe('a proof bound to a proposal', () => {
  it('should not cross over from one route spelling to a different proposal on the other', async () => {
    // Arrange
    const world = await machine(PER_ACTION);
    await world.unlock();
    await world.prove(A);

    // Act
    const crossed = await world.ask('POST', `/v1/secrets/logins/SITE/recipe/proposals/${B}`, APPROVE);
    const same = await world.ask('POST', `/v1/accounts/sign-ins/${world.signIn.id}/recipe/proposals/${A}`, APPROVE);

    // Assert
    should(crossed.status).equal(403);
    should(same.status).equal(200);
  });

  it('should refuse a passkey ceremony that names no proposal or a malformed one', async () => {
    // Arrange
    const world = await machine(PER_ACTION);
    await world.unlock();

    // Act
    const none = await world.ask('POST', '/v1/step-up/options', { origin: ORIGIN, act: STEP_UP_ACTS.approveRecipe });
    const malformed = await world.ask('POST', '/v1/step-up/options', {
      origin: ORIGIN,
      act: STEP_UP_ACTS.approveRecipe,
      subject: 'rp_nope',
    });
    const other = await world.ask('POST', '/v1/step-up/options', {
      origin: ORIGIN,
      act: STEP_UP_ACTS.shareLink,
      subject: A,
    });

    // Assert
    should([none.status, malformed.status, other.status]).deepEqual([400, 400, 400]);
  });
});

describe('approving the owner’s own version at the boundary', () => {
  it('should refuse an edit when the redactor starts failing after the proposal was filed', async () => {
    // Arrange
    let down = false;
    const world = await machine({}, DEFAULT_CAPABILITY_GRANTS, async text => {
      if (down) throw new Error('redactor down');
      return text.replaceAll(PASSWORD, '[redacted]');
    });
    down = true;

    // Act
    const refused = await world.fromHost(`/v1/accounts/sign-ins/${world.signIn.id}/recipe/proposals/${A}`, {
      decision: 'approve',
      recipe: 'Open site.example, sign in, then the code',
    });

    // Assert
    should(refused.status).be.within(400, 599);
    should(await world.recipeOf()).equal('Open site.example and sign in');
    should(await world.waiting()).deepEqual([A, B]);
  });

  it('should refuse a malformed or oversized edit', async () => {
    // Arrange
    const world = await machine({});
    const path = `/v1/accounts/sign-ins/${world.signIn.id}/recipe/proposals/${A}`;

    // Act
    const empty = await world.fromHost(path, { decision: 'approve', recipe: '' });
    const huge = await world.fromHost(path, { decision: 'approve', recipe: 'x'.repeat(4_001) });
    const wrongType = await world.fromHost(path, { decision: 'approve', recipe: 42 });
    const extra = await world.fromHost(path, { decision: 'approve', recipe: 'fine', surprise: true });

    // Assert
    should([empty.status, huge.status, wrongType.status, extra.status]).deepEqual([400, 400, 400, 400]);
    should(await world.recipeOf()).equal('Open site.example and sign in');
    should(await world.waiting()).deepEqual([A, B]);
  });

  it('should refuse an edited approval once the recipe moved on', async () => {
    // Arrange
    const world = await machine(PER_ACTION);
    await world.unlock();
    await world.prove(A);
    const accounts = (world.subsystem.accounts ?? world.subsystem.logins?.accounts) as NonNullable<
      SecretSubsystem['accounts']
    >;
    await accounts.putSignIn(world.signIn.id, { recipe: 'The owner rewrote it meanwhile' });

    // Act
    const stale = await world.ask('POST', `/v1/accounts/sign-ins/${world.signIn.id}/recipe/proposals/${A}`, {
      decision: 'approve',
      recipe: 'Open site.example, sign in, then the code',
    });

    // Assert
    should(stale.status).equal(409);
    should(await world.recipeOf()).equal('The owner rewrote it meanwhile');
  });
});
