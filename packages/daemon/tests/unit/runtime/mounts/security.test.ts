import { describe, it } from 'bun:test';
import {
  DEFAULT_SECURITY_SETTINGS,
  SECURITY_SETTING_BOUNDS,
  SECURITY_WIDEN_REFUSED_CODE,
  type SecuritySettings,
  SecuritySettingsChangeSchema,
  SecuritySettingsViewSchema,
  STEP_UP_ACTS,
  STEP_UP_REQUIRED_CODE,
  UNLOCK_REQUIRED_CODE,
} from '@ferretry/protocol';
import should from 'should';
import type { StepUpWitness } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import type { SessionDevice } from '../../../../src/lib/api/http.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { DEFAULT_CAPABILITY_GRANTS, type GrantAuditEntry } from '../../../../src/lib/grants/index.ts';
import { securityRoutes } from '../../../../src/lib/runtime/mounts/security.ts';
import {
  DAMAGED_SECURITY_SETTINGS,
  PASSKEY_WIDEN_JOURNAL_LINE,
  SecuritySettingsService,
} from '../../../../src/lib/security/index.ts';
import { jsonBody, request } from '../../api/support.ts';
import { agentIn, CREDENTIALS, ferretOwn, grantSubsystem, human } from './support.ts';

/**
 * The security settings surface, driven through the REAL dispatcher and the REAL grant guard, so the
 * `pairing.configure` demand, the passkey step-up behind it and where the caller arrived are enforced
 * by the same code production runs — a hand-built context would prove the handler and nothing else.
 */
const PHONE: SessionDevice = { deviceId: 'device-phone', appSession: 'app-one' };

const witnessFor = (...held: readonly SessionDevice[]): StepUpWitness => ({
  held: subject => held.some(entry => entry.deviceId === subject.deviceId && entry.appSession === subject.appSession),
});

const MIDDLE: SecuritySettings = {
  stepUpWindowMinutes: 30,
  deviceKeyRotationDays: 40,
  unlockOnOpen: true,
  stepUpOnActions: false,
  unlockValidityHours: 12,
  idleExpiryDays: 40,
};

interface World {
  readonly settings?: SecuritySettings | 'damaged';
  readonly stepUps?: StepUpWitness;
  readonly grants?: Parameters<typeof grantSubsystem>[0];
}

async function mount(world: World = {}) {
  const writes: unknown[] = [];
  const audited: GrantAuditEntry[] = [];
  const service = new SecuritySettingsService({
    document: {
      read: async () => {
        if (world.settings === 'damaged') throw new Error('security.json is not valid JSON');
        return { settings: world.settings ?? MIDDLE, updatedAt: '2026-09-01T00:00:00.000Z' };
      },
      write: async stored => {
        writes.push(stored);
      },
    },
    audit: {
      record: async entry => {
        audited.push(entry);
      },
      recent: async () => ({ entries: [], unreadable: 0, truncated: false }),
    },
    clock: { nowMs: () => 1_700_000_000_000 },
    widenCommand: 'fy daemon security set <field> <value>',
    devicesIdleLongerThan: () => 2,
  });
  await service.refresh();
  const grants = grantSubsystem(world.grants);
  await grants.refresh();
  const dispatcher = new ApiDispatcher(
    new ApiRouter(securityRoutes(service)),
    CREDENTIALS,
    grants,
    undefined,
    world.stepUps,
  );
  return { service, dispatcher, writes, audited };
}

const body = (value?: unknown) => (value === undefined ? {} : { body: JSON.stringify(value) });

/** A paired device across the relay. */
const fromDevice = (method: string, value?: unknown) =>
  request({ method, path: '/v1/security', device: PHONE, loopback: false, ...body(value) });

/** The host command line: the admin token over loopback. */
const fromHost = (method: string, value?: unknown) =>
  request({ method, path: '/v1/security', headers: human, loopback: true, ...body(value) });

/** A browser the carrier proved is on the host. */
const fromHostBrowser = (method: string, value?: unknown) =>
  request({
    method,
    path: '/v1/security',
    device: PHONE,
    loopback: true,
    privilegedLoopback: true,
    ...body(value),
  });

describe('the routes this mount serves', () => {
  it('should serve the read and the change, and nothing else', () => {
    // Act
    const routes = securityRoutes(
      new SecuritySettingsService({
        document: { read: async () => undefined, write: async () => {} },
        audit: { record: async () => {}, recent: async () => ({ entries: [], unreadable: 0, truncated: false }) },
        clock: { nowMs: () => 0 },
        widenCommand: 'x',
      }),
    );

    // Assert
    should(routes.map(route => `${route.method} ${route.path}`)).deepEqual(['GET /v1/security', 'PATCH /v1/security']);
    should(routes[0]?.capability).be.undefined();
    should(routes[0]?.unlockExempt).be.true();
    should(routes[1]?.capability).deepEqual({ capability: 'pairing', axis: 'configure' });
    should(routes[1]?.unlockExempt).be.undefined();
  });
});

describe('the read', () => {
  it('should show a device the settings and that it may not loosen them, with no step-up', async () => {
    // Every paired device may see how strict the machine is — that is what lets the app say "this can
    // only be loosened at the machine" before anybody tries.
    // Arrange
    const { dispatcher } = await mount();

    // Act
    const answered = await dispatcher.dispatch(fromDevice('GET'));

    // Assert
    should(answered.status).equal(200);
    should(answered.headers.get('cache-control')).match(/no-store/u);
    should(SecuritySettingsViewSchema.parse(jsonBody(answered))).deepEqual({
      settings: MIDDLE,
      source: 'document',
      mayWiden: false,
      widenCommand: 'fy daemon security set <field> <value>',
      updatedAt: '2026-09-01T00:00:00.000Z',
    });
  });

  it("should show the owner's admin token that it may loosen, and a browser even on the host that it may not", async () => {
    // B4: only the owner's admin token over loopback is at the machine; a browser never is.
    // Arrange
    const { dispatcher } = await mount();

    // Act
    const cli = SecuritySettingsViewSchema.parse(jsonBody(await dispatcher.dispatch(fromHost('GET'))));
    const browser = SecuritySettingsViewSchema.parse(jsonBody(await dispatcher.dispatch(fromHostBrowser('GET'))));

    // Assert
    should(cli.mayWiden).be.true();
    should(browser.mayWiden).be.false();
  });

  it('should not take a merely loopback peer for the host', async () => {
    // A locally bound proxy forwards a remote phone from a loopback peer.
    // Arrange
    const { dispatcher } = await mount();

    // Act
    const proxied = await dispatcher.dispatch(request({ path: '/v1/security', device: PHONE, loopback: true }));

    // Assert
    should(SecuritySettingsViewSchema.parse(jsonBody(proxied)).mayWiden).be.false();
  });

  it('should refuse an unauthenticated reader and a warden', async () => {
    // Arrange
    const { dispatcher } = await mount();

    // Act
    const anonymous = await dispatcher.dispatch(request({ path: '/v1/security', loopback: false }));
    const warden = await dispatcher.dispatch(
      request({ path: '/v1/security', headers: { authorization: 'Bearer warden-secret' }, loopback: false }),
    );

    // Assert
    should(anonymous.status).equal(401);
    should(warden.status).equal(403);
  });

  it('should be served to a device that has not confirmed its presence, while a change is not', async () => {
    // The one read a device needs BEFORE it can say why the machine is asking.
    // Arrange
    const { dispatcher } = await mount({ stepUps: { held: () => true, unlockRequired: () => true } });

    // Act
    const read = await dispatcher.dispatch(fromDevice('GET'));
    const change = await dispatcher.dispatch(fromDevice('PATCH', { idleExpiryDays: 10 }));

    // Assert
    should(read.status).equal(200);
    should(change.status).equal(401);
    should(jsonBody(change)).have.property('code', UNLOCK_REQUIRED_CODE);
  });

  it('should report a damaged document as damaged, with the strict settings in force', async () => {
    // Arrange
    const { dispatcher } = await mount({ settings: 'damaged' });

    // Act
    const view = SecuritySettingsViewSchema.parse(jsonBody(await dispatcher.dispatch(fromDevice('GET'))));

    // Assert
    should(view).containDeep({ source: 'damaged', settings: DAMAGED_SECURITY_SETTINGS });
    should(view).not.have.property('updatedAt');
  });
});

describe('the bounds, over the route', () => {
  it('should accept each bound at its edges and refuse one past with a 400, as the host', async () => {
    // Refused, never clamped: a request for 120 days must not silently become 90.
    // Arrange
    const { dispatcher, service, writes } = await mount();

    // Act + Assert
    for (const [field, { min, max }] of Object.entries(SECURITY_SETTING_BOUNDS)) {
      for (const value of [min, max]) {
        const accepted = await dispatcher.dispatch(fromHost('PATCH', { [field]: value }));
        should(accepted.status).equal(200);
        should(service.current()[field as keyof typeof SECURITY_SETTING_BOUNDS]).equal(value);
      }
      const written = writes.length;
      for (const value of [min - 1, max + 1]) {
        const refused = await dispatcher.dispatch(fromHost('PATCH', { [field]: value }));
        should(refused.status).equal(400);
        should(jsonBody(refused)).have.property('code', 'invalid_request');
      }
      should(writes).have.length(written);
    }
  });

  it('should refuse an empty patch, an unknown field and a fractional value with a 400', async () => {
    // Arrange
    const { dispatcher, writes, audited } = await mount();

    // Act
    const refusals = await Promise.all(
      [{}, { retention: 1 }, { idleExpiryDays: 1.5 }, { unlockOnOpen: 'yes' }].map(
        async value => await dispatcher.dispatch(fromHost('PATCH', value)),
      ),
    );

    // Assert
    should(refusals.map(refused => refused.status)).deepEqual([400, 400, 400, 400]);
    should(writes).be.empty();
    should(audited).be.empty();
  });
});

describe('who may change what, over the route', () => {
  it('should ask a device for a passkey confirmation before it tightens anything', async () => {
    // Arrange
    const { dispatcher, service, writes } = await mount();

    // Act
    const answered = await dispatcher.dispatch(fromDevice('PATCH', { idleExpiryDays: 10 }));

    // Assert
    should(answered.status).equal(403);
    should(jsonBody(answered)).have.property('code', STEP_UP_REQUIRED_CODE);
    should(service.current()).deepEqual(MIDDLE);
    should(writes).be.empty();
  });

  it('should accept a stepped-up narrowing, answer with the change, and record who asked', async () => {
    // Arrange
    const { dispatcher, service, audited } = await mount({ stepUps: witnessFor(PHONE) });

    // Act
    const answered = await dispatcher.dispatch(fromDevice('PATCH', { idleExpiryDays: 10 }));

    // Assert
    should(answered.status).equal(200);
    should(answered.headers.get('cache-control')).match(/no-store/u);
    const change = SecuritySettingsChangeSchema.parse(jsonBody(answered));
    should(change.devicesExpiring).equal(2);
    should(change.view.settings.idleExpiryDays).equal(10);
    should(change.view.mayWiden).be.false();
    should(service.current().idleExpiryDays).equal(10);
    should(audited).containDeep([{ actor: 'device:device-phone', changes: ['security.idleExpiryDays=40->10'] }]);
  });

  it('should refuse the same narrowing from the same device in another tab', async () => {
    // A step-up belongs to one app session.
    // Arrange
    const { dispatcher } = await mount({ stepUps: witnessFor(PHONE) });

    // Act
    const answered = await dispatcher.dispatch(
      request({
        method: 'PATCH',
        path: '/v1/security',
        device: { ...PHONE, appSession: 'app-two' },
        loopback: false,
        body: JSON.stringify({ idleExpiryDays: 10 }),
      }),
    );

    // Assert
    should(answered.status).equal(403);
    should(jsonBody(answered)).have.property('code', STEP_UP_REQUIRED_CODE);
  });

  it('should refuse a stepped-up device a loosening, naming the command to run at the machine', async () => {
    // Arrange
    const { dispatcher, service, writes, audited } = await mount({ stepUps: witnessFor(PHONE) });

    // Act
    const answered = await dispatcher.dispatch(fromDevice('PATCH', { idleExpiryDays: 41 }));

    // Assert
    should(answered.status).equal(403);
    should(jsonBody(answered)).have.property('code', SECURITY_WIDEN_REFUSED_CODE);
    should(jsonBody(answered)).have.property('code', 'security_widen_at_machine');
    should(answered.body).match(/idleExpiryDays/u);
    should(answered.body).match(/fy daemon security set <field> <value>/u);
    should(service.current()).deepEqual(MIDDLE);
    should(writes).be.empty();
    should(audited).be.empty();
  });

  it('should refuse a mixed request whole, with nothing written or audited', async () => {
    // Arrange
    const { dispatcher, service, writes, audited } = await mount({ stepUps: witnessFor(PHONE) });

    // Act
    const answered = await dispatcher.dispatch(
      fromDevice('PATCH', { idleExpiryDays: 10, unlockOnOpen: false, unlockValidityHours: 24 }),
    );

    // Assert
    should(answered.status).equal(403);
    should(jsonBody(answered)).have.property('code', SECURITY_WIDEN_REFUSED_CODE);
    should(answered.body).match(/unlockValidityHours, unlockOnOpen|unlockOnOpen, unlockValidityHours/u);
    should(service.current()).deepEqual(MIDDLE);
    should(writes).be.empty();
    should(audited).be.empty();
  });

  it('should let the host loosen with no step-up, over the admin token', async () => {
    // Arrange
    const { dispatcher, service, audited } = await mount();

    // Act
    const answered = await dispatcher.dispatch(fromHost('PATCH', { idleExpiryDays: 90, unlockOnOpen: false }));

    // Assert
    should(answered.status).equal(200);
    should(SecuritySettingsChangeSchema.parse(jsonBody(answered)).view.mayWiden).be.true();
    should(service.current()).containDeep({ idleExpiryDays: 90, unlockOnOpen: false });
    should(audited[0]?.actor).equal('admin-cli');
  });

  it('should not let a browser loosen even when the carrier proved it local, however stepped up', async () => {
    // Arrange
    const { dispatcher, service } = await mount({ stepUps: witnessFor(PHONE) });

    // Act
    const answered = await dispatcher.dispatch(fromHostBrowser('PATCH', { deviceKeyRotationDays: 60 }));

    // Assert
    should([answered.status, jsonBody(answered).code]).deepEqual([403, SECURITY_WIDEN_REFUSED_CODE]);
    should(service.current().deviceKeyRotationDays).equal(40);
  });

  it('should not let a merely loopback peer loosen, however stepped up', async () => {
    // Arrange
    const { dispatcher, service } = await mount({ stepUps: witnessFor(PHONE) });

    // Act
    const answered = await dispatcher.dispatch(
      request({
        method: 'PATCH',
        path: '/v1/security',
        device: PHONE,
        loopback: true,
        body: JSON.stringify({ idleExpiryDays: 90 }),
      }),
    );

    // Assert
    should(answered.status).equal(403);
    should(jsonBody(answered)).have.property('code', SECURITY_WIDEN_REFUSED_CODE);
    should(service.current().idleExpiryDays).equal(40);
  });

  it('should refuse a change when the operator has switched pairing configuration off', async () => {
    // The route sits on `pairing.configure`, so the operator's own grant still decides first.
    // Arrange
    const { dispatcher, service } = await mount({
      stepUps: witnessFor(PHONE),
      grants: { grants: { ...DEFAULT_CAPABILITY_GRANTS, pairing: { use: true, configure: false } } },
    });

    // Act
    const answered = await dispatcher.dispatch(fromDevice('PATCH', { idleExpiryDays: 10 }));

    // Assert
    should(answered.status).equal(403);
    should(jsonBody(answered)).have.property('code', 'grant_not_granted');
    should(service.current().idleExpiryDays).equal(40);
  });

  it('should refuse a warden the change', async () => {
    // Arrange
    const { dispatcher } = await mount();

    // Act
    const answered = await dispatcher.dispatch(
      request({
        method: 'PATCH',
        path: '/v1/security',
        headers: { authorization: 'Bearer warden-secret' },
        loopback: false,
        body: JSON.stringify({ idleExpiryDays: 10 }),
      }),
    );

    // Assert
    should(answered.status).equal(403);
    should(jsonBody(answered)).have.property('code', 'owner_only');
  });

  it('should refuse a ferret the change, on its own credential or the admin token, before reading the body', async () => {
    // Arrange — a ferret's own session credential, and the admin token naming a ferret's session (an older fy).
    const { dispatcher } = await mount();
    const ferret = (headers: Readonly<Record<string, string>>) => ({
      ...request({ method: 'PATCH', path: '/v1/security', headers, loopback: true, privilegedLoopback: true }),
      text: async (): Promise<string> => {
        throw new Error('the body was read');
      },
    });

    // Act
    const answers = await Promise.all(
      [ferretOwn, agentIn('ferret-1')].map(async headers => await dispatcher.dispatch(ferret(headers))),
    );

    // Assert
    should(answers.map(answered => [answered.status, jsonBody(answered).code])).deepEqual([
      [403, 'owner_only'],
      [403, 'owner_only'],
    ]);
  });
});

describe('raising how long an unlock lasts from a device, over the route', () => {
  /** A device that holds its step-up and, when `fresh`, proved a passkey for the act at hand. */
  const provedWitness = (fresh: boolean) => {
    const spent: SessionDevice[] = [];
    let proved = fresh;
    const witness: StepUpWitness = {
      held: subject => subject.deviceId === PHONE.deviceId,
      freshlyHeld: () => proved,
      spendFresh: subject => {
        spent.push(subject);
        proved = false;
      },
    };
    return { witness, spent };
  };

  it('should ask for a passkey for THIS change, naming the act, when the device holds only its unlock', async () => {
    // Arrange
    const { witness } = provedWitness(false);
    const { dispatcher, service, writes } = await mount({ stepUps: witness });

    // Act
    const answered = await dispatcher.dispatch(fromDevice('PATCH', { unlockValidityHours: 168 }));

    // Assert
    should(answered.status).equal(403);
    should(jsonBody(answered)).containDeep({
      code: STEP_UP_REQUIRED_CODE,
      demand: { capability: 'pairing', axis: 'configure', act: STEP_UP_ACTS.loosenSecurity },
    });
    should(service.current().unlockValidityHours).equal(12);
    should(writes).be.empty();
  });

  it('should apply it at once on a fresh passkey, spend that passkey, and journal it', async () => {
    // Arrange
    const { witness, spent } = provedWitness(true);
    const { dispatcher, service, audited } = await mount({ stepUps: witness });

    // Act
    const answered = await dispatcher.dispatch(fromDevice('PATCH', { unlockValidityHours: 168 }));

    // Assert
    should(answered.status).equal(200);
    should(SecuritySettingsChangeSchema.parse(jsonBody(answered)).view.settings.unlockValidityHours).equal(168);
    should(service.current().unlockValidityHours).equal(168);
    should(spent).deepEqual([PHONE]);
    should(audited[0]?.changes).deepEqual(['security.unlockValidityHours=12->168', PASSKEY_WIDEN_JOURNAL_LINE]);
  });

  it('should not spend the passkey on a narrowing', async () => {
    // Arrange
    const { witness, spent } = provedWitness(true);
    const { dispatcher } = await mount({ stepUps: witness });

    // Act
    const answered = await dispatcher.dispatch(fromDevice('PATCH', { unlockValidityHours: 2 }));

    // Assert
    should(answered.status).equal(200);
    should(spent).be.empty();
  });

  it('should still send every other loosening to the machine, however fresh the passkey', async () => {
    // Arrange
    const { witness, spent } = provedWitness(true);
    const { dispatcher, service } = await mount({ stepUps: witness });

    // Act
    const answered = await dispatcher.dispatch(fromDevice('PATCH', { unlockValidityHours: 24, unlockOnOpen: false }));

    // Assert
    should([answered.status, jsonBody(answered).code]).deepEqual([403, SECURITY_WIDEN_REFUSED_CODE]);
    should(service.current()).deepEqual(MIDDLE);
    should(spent).be.empty();
  });

  it('should let the host raise it with no passkey at all, as before', async () => {
    // Arrange
    const { dispatcher, service } = await mount();

    // Act
    const answered = await dispatcher.dispatch(fromHost('PATCH', { unlockValidityHours: 168 }));

    // Assert
    should(answered.status).equal(200);
    should(service.current().unlockValidityHours).equal(168);
  });
});

describe('a damaged document, over the route', () => {
  it('should answer a device 503, unavailable, and change nothing', async () => {
    // Arrange
    const { dispatcher, service, writes, audited } = await mount({ settings: 'damaged', stepUps: witnessFor(PHONE) });

    // Act
    const answered = await dispatcher.dispatch(fromDevice('PATCH', { idleExpiryDays: 10 }));

    // Assert
    should(answered.status).equal(503);
    should(jsonBody(answered)).have.property('code', 'security_unavailable');
    should(answered.body).match(/at the machine/u);
    should(service.current()).deepEqual(DAMAGED_SECURITY_SETTINGS);
    should(writes).be.empty();
    should(audited).be.empty();
  });

  it('should let the host replace it, after which it reads as a document', async () => {
    // Arrange
    const { dispatcher, writes } = await mount({ settings: 'damaged' });

    // Act
    const answered = await dispatcher.dispatch(fromHost('PATCH', { unlockOnOpen: false }));
    const read = SecuritySettingsViewSchema.parse(jsonBody(await dispatcher.dispatch(fromHost('GET'))));

    // Assert
    should(answered.status).equal(200);
    should(writes).have.length(1);
    should(read.source).equal('document');
    should(read.settings).deepEqual({ ...DAMAGED_SECURITY_SETTINGS, unlockOnOpen: false });
  });
});

describe('the defaults', () => {
  it('should be what a machine that never wrote a document is read as, over the route', async () => {
    // Arrange
    const service = new SecuritySettingsService({
      document: { read: async () => undefined, write: async () => {} },
      audit: { record: async () => {}, recent: async () => ({ entries: [], unreadable: 0, truncated: false }) },
      clock: { nowMs: () => 0 },
      widenCommand: 'fy daemon security set <field> <value>',
    });
    await service.refresh();
    const grants = grantSubsystem();
    await grants.refresh();
    const dispatcher = new ApiDispatcher(new ApiRouter(securityRoutes(service)), CREDENTIALS, grants);

    // Act
    const view = SecuritySettingsViewSchema.parse(jsonBody(await dispatcher.dispatch(fromHost('GET'))));

    // Assert
    should(view).containDeep({ source: 'defaults', settings: DEFAULT_SECURITY_SETTINGS });
  });
});
