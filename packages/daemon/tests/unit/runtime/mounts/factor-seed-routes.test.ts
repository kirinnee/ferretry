import { describe, it } from 'bun:test';
import {
  addTwoFactorKeySubject,
  type AccountList,
  padInputValue,
  STEP_UP_REQUIRED_CODE,
  TotpParametersSchema,
  type TwoFactorSeedStaged,
} from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import type { ClaimFreshWitness, StepUpWitness } from '../../../../src/lib/api/capability.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { type SecretSubsystem, secretRoutes } from '../../../../src/lib/runtime/mounts/secrets.ts';
import { LoginVault, totpCode, type TwoFactorSeedStagesDeps } from '../../../../src/lib/secrets/index.ts';
import { StepUpRegistry } from '../../../../src/lib/step-up/index.ts';
import { jsonBody, request } from '../../api/support.ts';
import {
  agentIn,
  CREDENTIALS,
  FakeSecretCipher,
  GRANTED,
  human,
  MemoryLoginIndex,
  MemorySecretDocuments,
  plantSeed,
  secretSubsystem,
} from './support.ts';

/**
 * SAVING A 2FA SEED (r2-plan §1.5, §4.3–4.6; §6 invariants 2, 4, 5, 12, 15, 16, 19): staged in memory, committed only
 * with a fresh `add-2fa-key` passkey proof bound to THAT stage — from every caller, the machine's own token included —
 * and never answered back. The old saved-login seed path is closed with a 403 that says where to go.
 */

const SEED = 'JBSWY3DPEHPK3PXP';
const URI = `otpauth://totp/GitHub:kirinnee?secret=${SEED}&issuer=GitHub`;
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const DEVICE = { deviceId: 'device-1', appSession: 'app-one' } as const;
const asDevice = { device: DEVICE } as const;

interface Rig {
  readonly subsystem: SecretSubsystem;
  readonly registry: StepUpRegistry;
  readonly index: MemoryLoginIndex;
  readonly sealed: MemorySecretDocuments & { writes: number };
  readonly clock: { now: number };
  readonly vault: LoginVault;
  readonly call: (
    method: string,
    path: string,
    body?: unknown,
    as?: { readonly headers?: Record<string, string>; readonly device?: typeof DEVICE },
  ) => Promise<{ readonly status: number; readonly body: unknown; readonly consumed: boolean }>;
}

class CountingDocuments extends MemorySecretDocuments {
  writes = 0;
  override async write(document: Parameters<MemorySecretDocuments['write']>[0]): Promise<void> {
    this.writes += 1;
    await super.write(document);
  }
}

/** A GitHub account (kirinnee, at github.com) and a Google one, over a real step-up registry as the witness. */
async function rig(
  seeds: Partial<Pick<TwoFactorSeedStagesDeps, 'anyPasskey' | 'cards' | 'agenda'>> = {},
): Promise<Rig> {
  const clock = { now: NOW };
  const index = new MemoryLoginIndex();
  const sealed = new CountingDocuments();
  const subsystem = secretSubsystem({
    loginIndex: index,
    loginSealed: sealed,
    seeds: { ...seeds, clock: { nowMs: () => clock.now } },
  });
  const registry = new StepUpRegistry({ nowMs: () => clock.now });
  registry.open(DEVICE);
  const witness: StepUpWitness = {
    held: device => registry.held(device, clock.now),
    freshlyHeld: device => registry.freshlyHeld(device, clock.now),
    claimFresh: ((device: typeof DEVICE, act?: never, bound?: never) =>
      registry.claimFresh(device, clock.now, act as never, bound as never)) as ClaimFreshWitness,
  };
  const dispatcher = new ApiDispatcher(
    new ApiRouter(secretRoutes(subsystem)),
    CREDENTIALS,
    GRANTED,
    undefined,
    witness,
  );
  const call: Rig['call'] = async (method, path, body, as = { headers: human }) => {
    const [route = path, search = ''] = path.split('?');
    const reads = { limits: [] as (number | undefined)[], consumed: false, discarded: false };
    const response = await dispatcher.dispatch(
      request({
        method,
        path: route,
        query: [...new URLSearchParams(search)],
        headers: as.headers ?? {},
        reads,
        ...(as.device === undefined ? {} : { device: as.device }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: await jsonBody(response), consumed: reads.consumed };
  };
  const ok = async (method: string, path: string, body?: unknown) => {
    const answer = await call(method, path, body);
    should(answer.status).within(200, 201);
    return answer.body;
  };
  await ok('PUT', '/v1/accounts/GITHUB', { label: 'GitHub', username: 'kirinnee', password: 'hunter2-UNIQUE-pw' });
  await ok('POST', '/v1/accounts/GITHUB/sign-ins', { place: { kind: 'site', domains: ['github.com'], match: [] } });
  await ok('PUT', '/v1/accounts/GOOGLE', { label: 'Google', username: 'kirin@example.com' });
  await ok('POST', '/v1/accounts/GOOGLE/sign-ins', {
    place: { kind: 'site', domains: ['accounts.google.com'], match: [] },
  });
  sealed.writes = 0;
  return {
    subsystem,
    registry,
    index,
    sealed,
    clock,
    vault: new LoginVault(index, sealed, new FakeSecretCipher()),
    call,
  };
}

const stageBody = (text: string, extra: Record<string, unknown> = {}) => ({
  padded: padInputValue(text),
  totpAcknowledged: true,
  ...extra,
});

async function stage(r: Rig, account = 'GITHUB', text = URI, extra: Record<string, unknown> = {}) {
  const answer = await r.call('POST', `/v1/accounts/${account}/factors/seed`, stageBody(text, extra));
  should(answer.status).equal(201);
  return answer.body as TwoFactorSeedStaged;
}

/** The proof a paired device's passkey buys for one stage, as the step-up ceremony would grant it. */
const proveFor = (r: Rig, staged: TwoFactorSeedStaged) =>
  r.registry.grantBound(
    DEVICE,
    r.clock.now,
    'add-2fa-key',
    addTwoFactorKeySubject(r.index.accounts.accounts.GITHUB?.key ?? '', staged.stage),
  );

const commit = (r: Rig, staged: TwoFactorSeedStaged, as: Parameters<Rig['call']>[3] = asDevice) =>
  r.call('POST', `/v1/accounts/${staged.account}/factors/seed/${staged.stage}/commit`, undefined, as);

const seeds = (r: Rig): number =>
  (r.index.accounts.accounts.GITHUB?.factors ?? []).filter(
    factor => factor.kind === 'totp' && factor.seal !== undefined,
  ).length;

describe('a 2FA seed is saved only with a passkey bound to its stage, from every caller', () => {
  it('should refuse the machine itself: its admin token proves nothing, and the stage keeps waiting', async () => {
    // Arrange
    const r = await rig();
    const staged = await stage(r);

    // Act — the owner's own shell on loopback, with no proof; then with a proof bound to it held by a device
    const machine = await commit(r, staged, { headers: human });
    proveFor(r, staged);
    const stillMachine = await commit(r, staged, { headers: human });
    const view = await r.call('GET', `/v1/accounts/GITHUB/factors/seed/${staged.stage}`);

    // Assert
    for (const answer of [machine, stillMachine]) {
      should(answer.status).equal(403);
      should(answer.body).match({ code: STEP_UP_REQUIRED_CODE, demand: { capability: 'secrets', act: 'add-2fa-key' } });
    }
    should(view.body).match({ state: 'waiting' });
    should(seeds(r)).equal(0);
  });

  it('should refuse a step-up window, an unlock, an act-less proof or one for another act', async () => {
    // Arrange
    const r = await rig();
    const staged = await stage(r);

    // Act + Assert — each proof this device could hold that is not the one bound to this stage
    for (const grant of [
      () => r.registry.grant(DEVICE, r.clock.now),
      () => r.registry.grant(DEVICE, r.clock.now, false),
      () => r.registry.grant(DEVICE, r.clock.now, true, 'catalog-install'),
      () => r.registry.grant(DEVICE, r.clock.now, true, 'add-device'),
    ]) {
      grant();
      should((await commit(r, staged)).status).equal(403);
    }
    should(seeds(r)).equal(0);
  });

  it('should refuse a proof bound to another stage, and a proof spent once already', async () => {
    // Arrange
    const r = await rig();
    const first = await stage(r);
    const second = await stage(r, 'GITHUB', SEED, { label: 'Backup' });

    // Act
    proveFor(r, first);
    const crossed = await commit(r, second);
    const saved = await commit(r, first);
    const reused = await commit(r, second);

    // Assert
    should(crossed.status).equal(403);
    should(saved.status).equal(200);
    should(reused.status).equal(403);
    should(seeds(r)).equal(1);
  });

  it('should save with its proof: sealed under a fresh name, typed back as the code, answered without the seed', async () => {
    // Arrange
    const r = await rig();
    const staged = await stage(r);
    proveFor(r, staged);

    // Act
    const saved = await commit(r, staged);
    const view = await r.call('GET', `/v1/accounts/GITHUB/factors/seed/${staged.stage}`);

    // Assert
    should(saved.status).equal(200);
    should(saved.body).match({
      account: 'GITHUB',
      factor: { kind: 'totp', label: 'Authenticator app', automatic: true, issuer: 'GitHub', addedBy: 'owner' },
    });
    should(view.body).match({ state: 'saved' });
    should(r.sealed.writes).be.above(0);
    should(await r.vault.fill('GITHUB', 'totp', 59_000)).equal(totpCode(SEED, TotpParametersSchema.parse({}), 59_000));
    should(JSON.stringify(saved.body)).not.containEql(SEED);
  });

  it('should save one key for one stage, even when two commits race with a proof each', async () => {
    // Arrange
    const r = await rig();
    const staged = await stage(r);

    // Act — two paired devices each prove for this stage, and both commits are in flight at once
    const other = { deviceId: 'device-2', appSession: 'app-two' } as const;
    r.registry.open(other);
    proveFor(r, staged);
    r.registry.grantBound(other, r.clock.now, 'add-2fa-key', r.subsystem.seeds?.boundSubjectOf(staged.stage) ?? '');
    const first = commit(r, staged);
    const second = commit(r, staged, { device: other as never });
    const statuses = [(await first).status, (await second).status].sort();

    // Assert
    should(statuses).deepEqual([200, 404]);
    should(seeds(r)).equal(1);
  });

  it('should let a stage go after two minutes: no binding, no commit', async () => {
    // Arrange
    const r = await rig();
    const staged = await stage(r);
    proveFor(r, staged);

    // Act
    r.clock.now += 120_000;
    const late = await commit(r, staged);

    // Assert
    should(late.status).equal(404);
    should(late.body).match({ code: 'stage_not_found' });
    should(r.subsystem.seeds?.boundSubjectOf(staged.stage)).be.undefined();
    should([...(await (r.subsystem.seeds as NonNullable<SecretSubsystem['seeds']>).values()).values()]).deepEqual([]);
    should(seeds(r)).equal(0);
  });
});

describe('a staged seed', () => {
  it('should be held in memory only, masked at once, and never written before its commit', async () => {
    // Arrange
    const r = await rig();
    const before = JSON.stringify(r.index.document);

    // Act
    await stage(r);

    // Assert
    should(r.sealed.writes).equal(0);
    should(JSON.stringify(r.index.document)).equal(before);
    const masked = [...(await (r.subsystem.seeds as NonNullable<SecretSubsystem['seeds']>).values()).values()];
    should(masked).containEql(SEED);
    should(masked).containEql(URI);
  });

  it('should cap stages per caller and keep a slot for a paired device, so a ferret cannot lock the owner out', async () => {
    // Arrange — the two callers that are not a device and reach these routes: the admin token as `fy` and as the UI.
    // A ferret holding the admin token (no session header, honest-client until RF-2) is one of these two.
    const r = await rig();
    const cli = { headers: human };
    const ui = { headers: { authorization: human.authorization } };
    const stageAs = async (as: Parameters<Rig['call']>[3], label: string) =>
      (await r.call('POST', '/v1/accounts/GITHUB/factors/seed', stageBody(SEED, { label }), as)).status;

    // Act
    const one = await stageAs(cli, 'One');
    const two = await stageAs(cli, 'Two');
    const third = await stageAs(cli, 'Three');
    const other = await stageAs(ui, 'Four');
    const reserved = await stageAs(ui, 'Five');
    const device = await stageAs(asDevice, 'Six');
    const full = await stageAs({ device: { deviceId: 'device-2', appSession: 'x' } as never }, 'Seven');

    // Assert — two per caller; three for non-devices together; the fourth is the owner's device's
    should([one, two, third, other, reserved, device, full]).deepEqual([201, 201, 429, 201, 429, 201, 429]);
  });

  it('should let only the caller that staged a seed, or a paired device, read, drop or card it', async () => {
    // Arrange — the owner's shell stages; a ferret learns the id (it is on the agenda card)
    const r = await rig({ agenda: { raise: async () => 'A1', close: async () => undefined } });
    const staged = await stage(r);
    const ferret = { headers: { authorization: human.authorization } };
    const path = `/v1/accounts/GITHUB/factors/seed/${staged.stage}`;

    // Act
    const read = await r.call('GET', path, undefined, ferret);
    const carded = await r.call('POST', `${path}/confirm-in-app`, { session: 's' }, ferret);
    const dropped = await r.call('DELETE', path, undefined, ferret);
    const owner = await r.call('GET', path);
    const device = await r.call('GET', path, undefined, asDevice);
    const deviceDrop = await r.call('DELETE', path, undefined, asDevice);

    // Assert — another caller sees nothing to touch, and the stage still waits until the device drops it
    for (const answer of [read, carded, dropped]) should(answer.status).equal(404);
    should(owner.body).match({ state: 'waiting' });
    should(device.body).match({ state: 'waiting' });
    should(deviceDrop.status).equal(200);
    should((await r.call('GET', path)).body).match({ state: 'dropped' });
  });

  it('should refuse a key that says it is for another account, unless "save it here anyway" was ticked', async () => {
    // Arrange
    const r = await rig();
    const okta = `otpauth://totp/Okta:bob@x.com?secret=${SEED}&issuer=Okta`;

    // Act
    const refused = await r.call('POST', '/v1/accounts/GITHUB/factors/seed', stageBody(okta));
    const allowed = await stage(r, 'GITHUB', okta, { mismatchAcknowledged: true });

    // Assert
    should(refused.status).equal(409);
    should(refused.body).match({ code: 'factor_mismatch', error: /Okta · bob@x\.com.*GitHub · kirinnee/u });
    should(allowed.mismatch).match({ issuer: 'Okta', accountName: 'bob@x.com' });
  });

  it('should refuse without a passkey anywhere, without the warning tick, and on an account with four seeds', async () => {
    // Arrange
    const none = await rig({ anyPasskey: async () => false });
    const r = await rig();
    for (const label of ['One', 'Two', 'Three', 'Four'])
      await plantSeed(r.subsystem.accounts as NonNullable<SecretSubsystem['accounts']>, 'GITHUB', SEED, label);

    // Act
    const noPasskey = await none.call('POST', '/v1/accounts/GITHUB/factors/seed', stageBody(SEED));
    const unticked = await r.call('POST', '/v1/accounts/GOOGLE/factors/seed', { padded: padInputValue(SEED) });
    const full = await r.call('POST', '/v1/accounts/GITHUB/factors/seed', stageBody(SEED));
    const notAKey = await r.call('POST', '/v1/accounts/GOOGLE/factors/seed', stageBody('otpauth://hotp/x?secret=AAAA'));

    // Assert
    should(noPasskey.status).equal(409);
    should(noPasskey.body).match({ code: 'passkey_required', error: /add a passkey/u });
    should(unticked.status).equal(400);
    should(full.status).equal(409);
    should(notAKey.status).equal(400);
    should(JSON.stringify(notAKey.body)).not.containEql('AAAA');
  });

  it('should save only to the account the daemon matched for the card it was set up from', async () => {
    // Arrange — one open card, whose target the daemon saw at github.com
    const card = 'c'.repeat(32);
    const r = await rig({ cards: { cardTarget: id => (id === card ? { matchKey: 'github.com' } : undefined) } });

    // Act
    const elsewhere = await r.call('POST', '/v1/accounts/GOOGLE/factors/seed', stageBody(SEED, { request: card }));
    const closed = await r.call(
      'POST',
      '/v1/accounts/GITHUB/factors/seed',
      stageBody(SEED, { request: 'd'.repeat(32) }),
    );
    const matched = await r.call('POST', '/v1/accounts/GITHUB/factors/seed', stageBody(SEED, { request: card }));

    // Assert
    should(elsewhere.status).equal(409);
    should(elsewhere.body).match({ code: 'not_this_cards_account' });
    should(closed.status).equal(409);
    should(matched.status).equal(201);
  });

  it('should put a daemon-worded card on the agenda, and close it when the seed is saved', async () => {
    // Arrange
    const raised: unknown[] = [];
    const closed: unknown[] = [];
    const r = await rig({
      agenda: {
        raise: async (sessionId, card) => {
          raised.push({ sessionId, ...card });
          return 'A7';
        },
        close: async (sessionId, id, note) => {
          closed.push({ sessionId, id, note });
        },
      },
    });
    const staged = await stage(r);

    // Act
    const asked = await r.call('POST', `/v1/accounts/GITHUB/factors/seed/${staged.stage}/confirm-in-app`, {
      session: 'owner-board',
    });
    proveFor(r, staged);
    await commit(r, staged);

    // Assert
    should(asked.status).equal(201);
    should(asked.body).deepEqual({ stage: staged.stage, session: 'owner-board', agendaItemId: 'A7' });
    should(raised).match([
      {
        sessionId: 'owner-board',
        stage: staged.stage,
        account: 'GITHUB',
        subject: 'Save automatic codes to GitHub · kirinnee?',
        why: /^Asked by `fy` on kirin-box at \d\d:\d\d UTC\./u,
      },
    ]);
    should(JSON.stringify(raised)).not.containEql(SEED);
    should(closed).match([{ sessionId: 'owner-board', id: 'A7', note: /^Saved/u }]);
  });
});

describe('the old seed path and the other 2FA key routes', () => {
  it('should refuse a seed on the old saved-login route with where to go, and still remove one there', async () => {
    // Arrange
    const r = await rig();

    // Act
    const refused = await r.call('PUT', '/v1/secrets/logins/GITHUB', { totp: { seed: SEED }, totpAcknowledged: true });
    await plantSeed(r.subsystem.accounts as NonNullable<SecretSubsystem['accounts']>, 'GITHUB', SEED);
    const removed = await r.call('PUT', '/v1/secrets/logins/GITHUB', { totp: null });

    // Assert
    should(refused.status).equal(403);
    should(refused.body).match({ code: 'add_2fa_key_needs_passkey', error: /fy account factor add/u });
    should(JSON.stringify(refused.body)).not.containEql(SEED);
    should(removed.status).equal(200);
    should(seeds(r)).equal(0);
  });

  it('should add, relabel and remove a key with no passkey, sweeping a removed seed and its mask', async () => {
    // Arrange
    const r = await rig();
    await plantSeed(r.subsystem.accounts as NonNullable<SecretSubsystem['accounts']>, 'GITHUB', SEED);
    const seeded = r.index.accounts.accounts.GITHUB?.factors?.[0];

    // Act
    const sms = await r.call('POST', '/v1/accounts/GITHUB/factors', { kind: 'sms', label: 'Phone', endsWith: '42' });
    const relabelled = await r.call('PATCH', `/v1/accounts/GITHUB/factors/${(sms.body as { id: string }).id}`, {
      label: 'Pixel',
      endsWith: null,
    });
    const removed = await r.call('DELETE', `/v1/accounts/GITHUB/factors/${seeded?.id ?? ''}`, undefined, asDevice);

    // Assert
    should(sms.status).equal(201);
    should(relabelled.body).match({ kind: 'sms', label: 'Pixel', automatic: false });
    should(relabelled.body).not.have.property('endsWith');
    should(removed.status).equal(200);
    should(removed.body).deepEqual({ account: 'GITHUB', factor: seeded?.id, removed: true });
    should(seeds(r)).equal(0);
    should(JSON.stringify((await r.sealed.read())?.entries ?? {})).not.containEql('_TOTP_');
    should([...(await r.vault.values()).values()]).not.containEql(SEED);
  });

  it('should take no seed, seal or code parameters on the add route, and no foreign fact on a relabel', async () => {
    // Arrange
    const r = await rig();
    const sms = (await r.call('POST', '/v1/accounts/GITHUB/factors', { kind: 'sms', label: 'Phone' })).body as {
      id: string;
    };

    // Act + Assert
    for (const extra of [{ seed: SEED }, { seal: 'x' }, { params: {} }])
      should(
        (await r.call('POST', '/v1/accounts/GITHUB/factors', { kind: 'totp', label: 'App', ...extra })).status,
      ).equal(400);
    should((await r.call('PATCH', `/v1/accounts/GITHUB/factors/${sms.id}`, { app: 'duo' })).status).equal(409);
    should((await r.call('POST', '/v1/accounts/GITHUB/factors', { kind: 'push', label: 'phone' })).status).equal(409);
    should((await r.call('DELETE', '/v1/accounts/GITHUB/factors/tf_000000000000')).status).equal(404);
  });

  it('should refuse a ferret on every 2FA key route, before its body is read', async () => {
    // Arrange
    const r = await rig();
    const staged = await stage(r);
    const ferret = { headers: agentIn('ferret-1') };
    const base = `/v1/accounts/GITHUB/factors`;

    // Act
    const answers = [
      await r.call('POST', base, { kind: 'sms', label: 'x' }, ferret),
      await r.call('PATCH', `${base}/tf_000000000000`, { label: 'x' }, ferret),
      await r.call('DELETE', `${base}/tf_000000000000`, undefined, ferret),
      await r.call('POST', `${base}/seed`, stageBody(SEED), ferret),
      await r.call('GET', `${base}/seed/${staged.stage}`, undefined, ferret),
      await r.call('POST', `${base}/seed/${staged.stage}/commit`, undefined, ferret),
      await r.call('POST', `${base}/seed/${staged.stage}/confirm-in-app`, { session: 'x' }, ferret),
      await r.call('DELETE', `${base}/seed/${staged.stage}`, undefined, ferret),
    ];

    // Assert
    for (const answer of answers) {
      should(answer.status).equal(403);
      should(answer.body).match({ code: 'forbidden' });
      should(answer.consumed).be.false();
    }
  });

  it('should answer the seed, its base32 or its link nowhere', async () => {
    // Arrange
    const r = await rig();
    const staged = await stage(r);
    proveFor(r, staged);

    // Act
    const answers = [
      staged,
      (await r.call('GET', `/v1/accounts/GITHUB/factors/seed/${staged.stage}`)).body,
      (await commit(r, staged)).body,
      (await r.call('GET', '/v1/accounts')).body,
      (await r.call('GET', '/v1/accounts/hint?site=github.com')).body,
      (await r.call('GET', '/v1/secrets/logins')).body,
      (await r.call('DELETE', `/v1/accounts/GITHUB/factors/seed/${staged.stage}`)).body,
    ];

    // Assert
    for (const answer of answers) {
      const text = JSON.stringify(answer);
      for (const value of [SEED, SEED.toLowerCase(), URI, 'JBSW Y3DP']) should(text).not.containEql(value);
    }
    should((answers[3] as AccountList).accounts.find(account => account.id === 'GITHUB')?.fields.totp).be.true();
    should(JSON.stringify(r.index.document)).not.containEql(SEED);
  });
});

describe('the old seed path, below the route', () => {
  it('should refuse a seed in the store itself, whoever calls it, and change nothing', async () => {
    // Arrange — the saved-login projection called directly, as a future import or tool would
    const r = await rig();
    const before = JSON.stringify(r.index.document);

    // Act
    const refused = await (r.subsystem.logins as NonNullable<SecretSubsystem['logins']>)
      .put('GITHUB', { totp: { seed: SEED, parameters: TotpParametersSchema.parse({}) }, totpAcknowledged: true })
      .catch((error: { refusal?: string }) => error.refusal);

    // Assert
    should(refused).equal('add_2fa_key_needs_passkey');
    should(JSON.stringify(r.index.document)).equal(before);
    should(r.sealed.writes).equal(0);
  });
});
