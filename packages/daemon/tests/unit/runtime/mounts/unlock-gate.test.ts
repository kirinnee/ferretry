import { describe, it } from 'bun:test';
import {
  type CapabilityGrants,
  DEFAULT_SECURITY_SETTINGS,
  FY_REQUEST_ID_HEADER,
  SECURITY_WIDEN_REFUSED_CODE,
  type SecuritySettings,
  STEP_UP_REQUIRED_CODE,
  UNLOCK_REQUIRED_CODE,
} from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { ApiSocketDispatcher } from '../../../../src/lib/api/socket.ts';
import { DEFAULT_CAPABILITY_GRANTS } from '../../../../src/lib/grants/index.ts';
import { tunnelApiRequest } from '../../../../src/lib/relay/tunnel.ts';
import { type McpOAuthSubsystem, mcpOAuthRoutes } from '../../../../src/lib/runtime/mounts/mcp-oauth.ts';
import { securityRoutes } from '../../../../src/lib/runtime/mounts/security.ts';
import { sessionConsoleRoutes } from '../../../../src/lib/runtime/mounts/session-console-input.ts';
import { sessionControlRoutes } from '../../../../src/lib/runtime/mounts/session-control.ts';
import { sessionPermissionRoutes } from '../../../../src/lib/runtime/mounts/session-permission.ts';
import { stepUpRoutes } from '../../../../src/lib/runtime/mounts/step-up.ts';
import { terminalRoutes, terminalSocketRoutes } from '../../../../src/lib/runtime/mounts/terminals.ts';
import { SecuritySettingsService } from '../../../../src/lib/security/index.ts';
import {
  ChallengeLedger,
  type PasskeyStore,
  type PasskeyVerifierPort,
  StepUpRegistry,
  StepUpService,
  type StoredPasskey,
} from '../../../../src/lib/step-up/index.ts';
import { parsePermissionPrompt } from '../../../../src/lib/tmux/permission-prompt.ts';
import { jsonBody, request } from '../../api/support.ts';
import {
  consoleSubsystem,
  consoleTmux,
  FakeSessionControl,
  FakeTerminals,
  grantSubsystem,
  PERMISSION_FRAME,
  permissionSubsystem,
  permissionTmux,
  sessionDirectory,
  sessionView,
} from './support.ts';

/**
 * THE UNLOCK GATE, END TO END (`docs/design/zero-trust.md` B6, owner decision 2026-10-14).
 *
 * Everything here runs through the REAL step-up service, the REAL security settings service, the REAL
 * grant guard and the REAL request and socket dispatchers; only the WebAuthn verdict and the terminal
 * and session subsystems are replaced. The property is one sentence: a governed device does nothing
 * until it has unlocked, and then may do anything its grants allow, with no further prompt.
 */

const T0 = Date.parse('2026-10-14T09:00:00.000Z');
const HOUR_MS = 3_600_000;
const ORIGIN = 'https://app.example.test';
const deviceId = `fy_device_id_${'d'.repeat(22)}`;
const phone = { deviceId, appSession: 'app-one' } as const;
const CREDENTIAL_ID = Buffer.from([1, 2, 3, 4]).toString('base64url');

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

/** Every assertion carries a higher counter than the last, as a real authenticator's does. */
let assertions = 0;
const verifier: PasskeyVerifierPort = {
  verifyRegistration: async () => ({ ok: false, reason: 'unused' }),
  verifyAssertion: async () => {
    assertions += 1;
    return { ok: true, signCount: 100 + assertions, origin: ORIGIN };
  },
};

/** The one registered project in this machine. */
const PROJECT = '/home/owner/projects/app';
const PERMISSION_ID = parsePermissionPrompt(PERMISSION_FRAME)?.id ?? 'not-parsed';
const STALE_PERMISSION_ID = '0123456789abcdef';

const json = (value: unknown): string => JSON.stringify(value);
const originBody = json({ origin: ORIGIN });
const assertionBody = json({
  credentialId: CREDENTIAL_ID,
  clientDataJSON: 'Y2xpZW50',
  authenticatorData: 'YXV0aA',
  signature: 'c2ln',
});

/** The machine: a security settings service feeding a step-up service feeding both dispatchers. */
async function machine(initial: Partial<SecuritySettings> = {}, granted: CapabilityGrants = DEFAULT_CAPABILITY_GRANTS) {
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
  const terminals = new FakeTerminals();
  const control = new FakeSessionControl();
  /** Every tmux command the Console ran: an empty list is "refused before the pane was touched". */
  const consoleKeys = consoleTmux();
  /** Every tmux command the permission route ran: `commands` are keys sent, `captures` are panes read. */
  const permissionKeys = permissionTmux();
  /** The MCP sign-in, recording every call that reached it — so "refused at the door" is a fact. */
  const mcpCalls: string[] = [];
  const mcp: McpOAuthSubsystem = {
    connections: async () => (mcpCalls.push('connections'), []),
    start: async component => {
      mcpCalls.push(`start ${component}`);
      throw new Error('not exercised');
    },
    complete: async flowId => {
      mcpCalls.push(`complete ${flowId}`);
      throw new Error('not exercised');
    },
    cancel: flowId => (mcpCalls.push(`cancel ${flowId}`), { flowId, cancelled: false }),
    signOut: async component => (mcpCalls.push(`signOut ${component}`), { component, removed: false, revoked: false }),
  };
  const credentials = {
    admin: 'admin-secret',
    warden: 'warden-secret',
    devices: { has: (id: string) => id === deviceId, grants: () => DEFAULT_CAPABILITY_GRANTS },
  };
  const http = new ApiDispatcher(
    new ApiRouter([
      ...stepUpRoutes(service),
      ...securityRoutes(security),
      ...mcpOAuthRoutes(mcp),
      ...terminalRoutes(terminals),
      ...sessionControlRoutes(control, { guard: grants, knownRoots: async () => [PROJECT] }),
      ...sessionConsoleRoutes(consoleSubsystem({}, consoleKeys), sessionDirectory([sessionView('s1')])),
      ...sessionPermissionRoutes(permissionSubsystem({}, permissionKeys), sessionDirectory([sessionView('s1')])),
    ]),
    credentials,
    grants,
    undefined,
    service,
  );
  const sockets = new ApiSocketDispatcher(
    new ApiRouter(terminalSocketRoutes(terminals)),
    credentials,
    grants,
    undefined,
    service,
  );

  const ask = (method: string, path: string, body?: string, headers: Readonly<Record<string, string>> = {}) =>
    http.dispatch(
      request({ method, path, device: phone, loopback: false, headers, ...(body === undefined ? {} : { body }) }),
    );
  const unlock = async () => {
    const options = await ask('POST', '/v1/unlock/options', originBody);
    should(options.status).equal(200);
    const granted = await ask('POST', '/v1/unlock', assertionBody);
    should(granted.status).equal(200);
    return jsonBody(granted);
  };
  let sessionsStarted = 0;
  const startSession = () => {
    sessionsStarted += 1;
    return ask('POST', '/v1/sessions', json({ agent: 'claude-auto-loge', mode: 'auto', prompt: 'go' }), {
      [FY_REQUEST_ID_HEADER]: `req-${sessionsStarted}`,
    });
  };
  /** A start that picks the harness's own flags, or a folder outside every project: terminal access. */
  const startWith = (extra: Record<string, unknown>) => {
    sessionsStarted += 1;
    return ask('POST', '/v1/sessions', json({ agent: 'claude-auto-loge', mode: 'auto', prompt: 'go', ...extra }), {
      [FY_REQUEST_ID_HEADER]: `req-${sessionsStarted}`,
    });
  };
  const openTerminal = () => ask('POST', '/v1/sessions/s1/terminals', json({}));
  const typeConsole = () => ask('POST', '/v1/sessions/s1/console/input', json({ data: 'y\r' }));
  const answerPermission = (requestId = PERMISSION_ID) =>
    ask('POST', '/v1/sessions/s1/permission', json({ kind: 'choice', requestId, number: 1 }));
  const upgrade = (terminalId: string) =>
    sockets.upgrade(
      request({ path: `/v1/sessions/s1/terminals/${terminalId}/stream`, device: phone, loopback: false }),
    );
  return {
    http,
    clock,
    security,
    registry,
    service,
    ask,
    unlock,
    startSession,
    startWith,
    openTerminal,
    typeConsole,
    answerPermission,
    permissionKeys,
    consoleKeys,
    upgrade,
    sockets,
    control,
    mcpCalls,
  };
}

const refusedAs = (response: { status: number; body: string }, status: number, code: string) =>
  should([response.status, (JSON.parse(response.body) as { code?: string }).code]).deepEqual([status, code]);

describe('before an unlock', () => {
  it('should answer every governed request 401 unlock_required, a terminal open and a session start included', async () => {
    // Arrange
    const world = await machine();

    // Act
    const blocked = [
      await world.openTerminal(),
      await world.startSession(),
      await world.ask('GET', '/v1/sessions/s1/terminals'),
      await world.ask('PATCH', '/v1/security', json({ stepUpOnActions: true })),
      await world.ask('POST', '/v1/step-up/options', originBody),
      await world.ask('POST', '/v1/step-up', assertionBody),
    ];

    // Assert
    for (const response of blocked) refusedAs(response, 401, UNLOCK_REQUIRED_CODE);
    should(world.control.starts).be.empty();
  });

  it('should refuse a terminal stream at the upgrade, before any socket exists, with 401 unlock_required', async () => {
    // Arrange
    const world = await machine();

    // Act
    const decision = await world.upgrade('000000000001');

    // Assert
    should(decision.outcome).equal('refused');
    if (decision.outcome === 'refused') refusedAs(decision.response, 401, UNLOCK_REQUIRED_CODE);
  });

  it('should still serve exactly the routes a device needs to unlock', async () => {
    // Arrange
    const world = await machine();

    // Act
    const panel = await world.ask('GET', '/v1/passkeys');
    const read = await world.ask('GET', '/v1/security');
    const options = await world.ask('POST', '/v1/unlock/options', originBody);
    const unlocked = await world.ask('POST', '/v1/unlock', assertionBody);

    // Assert
    should([panel.status, read.status, options.status, unlocked.status]).deepEqual([200, 200, 200, 200]);
  });

  it('should ask nobody to unlock on a machine whose unlock is off', async () => {
    // Arrange — and with the unlock off, every act asks for its own step-up instead.
    const world = await machine({ unlockOnOpen: false });

    // Act
    const terminal = await world.openTerminal();
    const start = await world.startSession();

    // Assert
    refusedAs(terminal, 403, STEP_UP_REQUIRED_CODE);
    should(start.status).equal(201);
  });
});

describe('after an unlock', () => {
  it('should serve a terminal, its stream and a session start with no further step-up held anywhere', async () => {
    // Arrange
    const world = await machine();
    await world.unlock();
    // The unlock also leaves a per-act step-up for this app session; drop it, so only the unlock is left.
    world.registry.forgetDevice(deviceId);
    should(world.registry.held(phone, world.clock.now)).be.false();

    // Act
    const terminal = await world.openTerminal();
    const view = jsonBody(terminal) as { id: string };
    const stream = await world.upgrade(view.id);
    const start = await world.startSession();
    const again = await world.openTerminal();

    // Assert
    should(terminal.status).equal(201);
    should(stream.outcome).equal('accepted');
    should(start.status).equal(201);
    should(again.status).equal(201);
    should(world.service.held(phone)).be.true();
    should(world.registry.held(phone, world.clock.now)).be.false();
  });

  it('should hold for a new app session of the same device, because the unlock is the device’s', async () => {
    // Arrange
    const world = await machine();
    await world.unlock();
    world.registry.forgetDevice(deviceId);

    // Act
    const response = await world.http.dispatch(
      request({
        method: 'POST',
        path: '/v1/sessions/s1/terminals',
        device: { ...phone, appSession: 'app-two' },
        loopback: false,
        body: json({}),
      }),
    );

    // Assert
    should(response.status).equal(201);
  });

  it('should never spend an unlock: acts leave the device unlocked', async () => {
    // Arrange
    const world = await machine();
    await world.unlock();

    // Act
    for (let acts = 0; acts < 5; acts += 1) await world.openTerminal();

    // Assert
    should(world.service.unlockRequired(phone)).be.false();
    should((await world.openTerminal()).status).equal(201);
  });

  it('should lapse at unlockValidityHours, and answer 401 unlock_required again from that instant', async () => {
    // Arrange
    const world = await machine({ unlockValidityHours: 2 });
    const granted = await world.unlock();
    should(granted.unlockedUntil).equal(new Date(T0 + 2 * HOUR_MS).toISOString());
    const view = jsonBody(await world.openTerminal()) as { id: string };
    const stream = await world.upgrade(view.id);
    should(stream.outcome).equal('accepted');
    world.registry.forgetDevice(deviceId);

    // Act
    world.clock.now = T0 + 2 * HOUR_MS - 1;
    const justBefore = await world.startSession();
    world.clock.now = T0 + 2 * HOUR_MS;
    const atLapse = await world.startSession();
    const lapsedTerminal = await world.openTerminal();
    const standing = world.sockets.reauthorize(
      request({ path: `/v1/sessions/s1/terminals/${view.id}/stream`, device: phone, loopback: false }),
    );

    // Assert — the stream's step-up is counted as standing, so the unlock alone ends it at renewal.
    should(justBefore.status).equal(201);
    refusedAs(atLapse, 401, UNLOCK_REQUIRED_CODE);
    refusedAs(lapsedTerminal, 401, UNLOCK_REQUIRED_CODE);
    should(standing).be.false();
  });

  it('should keep an open stream at renewal while the unlock holds, with no per-act step-up left', async () => {
    // Arrange
    const world = await machine();
    await world.unlock();
    const view = jsonBody(await world.openTerminal()) as { id: string };
    await world.upgrade(view.id);
    world.registry.forgetDevice(deviceId);
    world.clock.now = T0 + 7 * HOUR_MS;

    // Act
    const standing = world.sockets.reauthorize(
      request({ path: `/v1/sessions/s1/terminals/${view.id}/stream`, device: phone, loopback: false }),
    );

    // Assert
    should(standing).be.true();
  });
});

describe('a confirmation per act inside the unlock (stepUpOnActions)', () => {
  it('should ask for a step-up again for a gated act, 403 grant_step_up_required, once the unlock’s own is gone', async () => {
    // Arrange
    const world = await machine({ stepUpOnActions: true });
    await world.unlock();
    world.registry.forgetDevice(deviceId);

    // Act
    const terminal = await world.openTerminal();
    const start = await world.startSession();

    // Assert — the unlock is no longer the step-up; a session start has no gated demand.
    refusedAs(terminal, 403, STEP_UP_REQUIRED_CODE);
    should(start.status).equal(201);
    should(world.service.unlockRequired(phone)).be.false();
  });

  it('should admit the first act after unlocking on the unlock’s own step-up, and spend it at window 0', async () => {
    // Arrange
    const world = await machine({ stepUpOnActions: true, stepUpWindowMinutes: 0 });
    await world.unlock();

    // Act
    const first = await world.openTerminal();
    const second = await world.openTerminal();

    // Assert — and the unlock itself is untouched by the spend.
    should(first.status).equal(201);
    refusedAs(second, 403, STEP_UP_REQUIRED_CODE);
    should(world.service.unlockRequired(phone)).be.false();
  });

  it('should hold a per-act step-up for the window, then ask again', async () => {
    // Arrange
    const world = await machine({ stepUpOnActions: true, stepUpWindowMinutes: 10 });
    await world.unlock();

    // Act
    const within = await world.openTerminal();
    world.clock.now = T0 + 11 * 60_000;
    const after = await world.openTerminal();

    // Assert
    should(within.status).equal(201);
    refusedAs(after, 403, STEP_UP_REQUIRED_CODE);
  });

  it('should ask for a step-up for a start with its own flags, or outside every project, as for a terminal', async () => {
    // Review R2-H1: `--settings` with a hook runs any host command, so per-act settings must cover it.
    // Arrange
    const world = await machine({ stepUpOnActions: true });
    await world.unlock();
    world.registry.forgetDevice(deviceId);

    // Act
    const flagged = await world.startWith({ harnessFlags: ['--settings', '{"hooks":{}}'] });
    const elsewhere = await world.startWith({ cwd: '/etc' });
    const climbedOut = await world.startWith({ cwd: `${PROJECT}/../../etc` });
    const lookalike = await world.startWith({ cwd: `${PROJECT}-evil` });
    const inProject = await world.startWith({ cwd: `${PROJECT}/packages/app` });

    // Assert — each terminal-class start names the terminal on its prompt; a project start is ordinary
    for (const response of [flagged, elsewhere, climbedOut, lookalike]) {
      refusedAs(response, 403, STEP_UP_REQUIRED_CODE);
      should(JSON.parse(response.body)).containDeep({ demand: { capability: 'terminal', axis: 'use' } });
    }
    should(inProject.status).equal(201);
    should(world.control.starts).have.length(1);
  });

  it('should ask for a step-up for a flagged start with the unlock off, and serve it once confirmed', async () => {
    // Arrange — no unlock at all: every device holds full grants, so this was round-1 H1 exactly
    const world = await machine({ unlockOnOpen: false, stepUpOnActions: false, stepUpWindowMinutes: 10 });

    // Act
    const refused = await world.startWith({ harnessFlags: ['--dangerously-skip-permissions'] });
    await world.ask('POST', '/v1/step-up/options', originBody);
    await world.ask('POST', '/v1/step-up', assertionBody);
    const served = await world.startWith({ harnessFlags: ['--dangerously-skip-permissions'] });

    // Assert
    refusedAs(refused, 403, STEP_UP_REQUIRED_CODE);
    should(served.status).equal(201);
  });

  it('should ask for a step-up per act with the unlock off even though stepUpOnActions is off', async () => {
    // Arrange
    const world = await machine({ unlockOnOpen: false, stepUpOnActions: false });

    // Act
    const terminal = await world.openTerminal();

    // Assert
    refusedAs(terminal, 403, STEP_UP_REQUIRED_CODE);
  });
});

describe('changing the settings from a device inside an unlock', () => {
  it('should let an unlocked device tighten: stepUpOnActions on, and a shorter unlock, which then applies', async () => {
    // Arrange
    const world = await machine({ unlockValidityHours: 8 });
    await world.unlock();
    world.registry.forgetDevice(deviceId);

    // Act
    const tightened = await world.ask('PATCH', '/v1/security', json({ stepUpOnActions: true, unlockValidityHours: 1 }));
    const terminal = await world.openTerminal();
    world.clock.now = T0 + HOUR_MS;
    const lapsed = await world.ask('GET', '/v1/sessions/s1/terminals');

    // Assert — the unlock was the step-up that allowed the change, and the change then asks per act.
    should(tightened.status).equal(200);
    should(world.security.current()).containDeep({ stepUpOnActions: true, unlockValidityHours: 1 });
    refusedAs(terminal, 403, STEP_UP_REQUIRED_CODE);
    refusedAs(lapsed, 401, UNLOCK_REQUIRED_CODE);
  });

  it('should refuse loosening remotely, 403 security_widen_at_machine, whatever the unlock', async () => {
    // Arrange
    const world = await machine({ stepUpOnActions: true, unlockValidityHours: 4 });
    await world.unlock();
    world.registry.forgetDevice(deviceId);
    // Under stepUpOnActions the unlock no longer stands in for the act: take the step-up the device would.
    world.registry.grant(phone, world.clock.now);

    // Act
    const turnOff = await world.ask('PATCH', '/v1/security', json({ stepUpOnActions: false }));
    const longer = await world.ask('PATCH', '/v1/security', json({ unlockValidityHours: 24 }));
    const unlockOff = await world.ask('PATCH', '/v1/security', json({ unlockOnOpen: false }));

    // Assert
    for (const response of [turnOff, longer, unlockOff]) refusedAs(response, 403, SECURITY_WIDEN_REFUSED_CODE);
    should(world.security.current()).containDeep({ stepUpOnActions: true, unlockValidityHours: 4, unlockOnOpen: true });
  });

  it('should refuse the same change before an unlock with 401, not as a widen', async () => {
    // Arrange
    const world = await machine();

    // Act
    const change = await world.ask('PATCH', '/v1/security', json({ unlockValidityHours: 24 }));

    // Assert
    refusedAs(change, 401, UNLOCK_REQUIRED_CODE);
  });
});

describe('typing into the Console, governed exactly as a session terminal (docs/grants.md)', () => {
  const consoleBody = json({ data: 'y\r' });

  it('should refuse a locked device 401 unlock_required, before the pane is touched', async () => {
    // Arrange
    const world = await machine();

    // Act
    const response = await world.typeConsole();

    // Assert
    refusedAs(response, 401, UNLOCK_REQUIRED_CODE);
    should(world.consoleKeys.commands).deepEqual([]);
  });

  it('should type for an unlocked device with no per-act step-up left, as a terminal open is', async () => {
    // Arrange
    const world = await machine();
    await world.unlock();
    world.registry.forgetDevice(deviceId);

    // Act
    const response = await world.typeConsole();

    // Assert
    should([response.status, jsonBody(response)]).deepEqual([200, { written: 2 }]);
    should(world.consoleKeys.commands).have.length(1);
  });

  it('should type for a caller at the machine, locked or not, because loopback is ungoverned', async () => {
    // Arrange — no device, no unlock, and `terminal` switched off for everybody who is governed.
    const world = await machine({}, { ...DEFAULT_CAPABILITY_GRANTS, terminal: { use: false, configure: false } });

    // Act
    const response = await world.http.dispatch(
      request({
        method: 'POST',
        path: '/v1/sessions/s1/console/input',
        headers: { authorization: 'Bearer admin-secret', 'x-ferretry-client': 'cli' },
        loopback: true,
        body: consoleBody,
      }),
    );

    // Assert
    should(response.status).equal(200);
    should(world.consoleKeys.commands).have.length(1);
  });

  it('should refuse an unlocked device when the operator has not granted terminal use', async () => {
    // Arrange
    const world = await machine({}, { ...DEFAULT_CAPABILITY_GRANTS, terminal: { use: false, configure: false } });
    await world.unlock();

    // Act
    const response = await world.typeConsole();

    // Assert — an unlock buys what the grants allow and nothing more.
    should(response.status).equal(403);
    should(String(jsonBody(response).error)).match(/has not granted the UI the use of session terminals/u);
    should(world.consoleKeys.commands).deepEqual([]);
  });

  it('should treat a RELAYED request as remote, refusing it locked and serving it unlocked', async () => {
    // Arrange — a relay terminates on this host, so the request looks local in every way but one.
    const world = await machine();
    const relayed = () =>
      world.http.dispatch(
        tunnelApiRequest(
          {
            method: 'POST',
            path: '/v1/sessions/s1/console/input',
            headers: { host: '127.0.0.1:7432', 'x-forwarded-for': '127.0.0.1' },
            body: consoleBody,
          },
          phone,
          'rendezvous-session',
        ),
      );

    // Act
    const locked = await relayed();
    await world.unlock();
    const unlocked = await relayed();

    // Assert
    refusedAs(locked, 401, UNLOCK_REQUIRED_CODE);
    should(unlocked.status).equal(200);
    should(world.consoleKeys.commands).have.length(1);
  });

  it('should fail closed when this machine cannot say what it granted', async () => {
    // Arrange — an unreadable grant document, with the device unlocked.
    const world = await machine();
    await world.unlock();
    const undetermined = new ApiDispatcher(
      new ApiRouter(
        sessionConsoleRoutes(consoleSubsystem({}, world.consoleKeys), sessionDirectory([sessionView('s1')])),
      ),
      {
        admin: 'admin-secret',
        warden: 'warden-secret',
        devices: { has: (id: string) => id === deviceId, grants: () => DEFAULT_CAPABILITY_GRANTS },
      },
      grantSubsystem({ broken: true }),
      undefined,
      world.service,
    );

    // Act
    const response = await undetermined.dispatch(
      request({
        method: 'POST',
        path: '/v1/sessions/s1/console/input',
        device: phone,
        loopback: false,
        body: consoleBody,
      }),
    );

    // Assert
    should(response.status).equal(403);
    should(jsonBody(response)).have.property('code', 'grant_undetermined');
    should(world.consoleKeys.commands).deepEqual([]);
  });
});

describe('the MCP sign-in behind the unlock (docs/mcp-oauth.md)', () => {
  it('should refuse a remote device every MCP sign-in act until it unlocks, and never reach the service', async () => {
    // Arrange — the phone is off this host (`loopback: false`), which is what a relayed caller always is.
    const world = await machine();
    const callback = json({ callback: 'https://pwa.example.test/oauth/mcp-callback/x?code=c&state=s' });

    // Act
    const blocked = [
      await world.ask('GET', '/v1/fleet/mcp-auth'),
      await world.ask('POST', '/v1/fleet/mcp-auth/linear', json({})),
      await world.ask('POST', '/v1/fleet/mcp-auth/flows/f1', callback),
      await world.ask('DELETE', '/v1/fleet/mcp-auth/flows/f1'),
      await world.ask('DELETE', '/v1/fleet/mcp-auth/linear'),
    ];
    await world.unlock();
    const signedOut = await world.ask('DELETE', '/v1/fleet/mcp-auth/linear');

    // Assert
    for (const response of blocked) refusedAs(response, 401, UNLOCK_REQUIRED_CODE);
    should(signedOut.status).equal(200);
    should(world.mcpCalls).deepEqual(['signOut linear']);
  });
});

describe('answering a permission prompt, governed exactly as the Console is (docs/grants.md)', () => {
  const permissionPath = '/v1/sessions/s1/permission';
  const stale = json({ kind: 'choice', requestId: STALE_PERMISSION_ID, number: 1 });
  /** A permitted call that reaches the service: the prompt it names is not the one up, so it is 409 gone. */
  const passedAuthorization = (response: { status: number; body: string }) =>
    refusedAs(response, 409, 'permission_prompt_gone');

  it('should refuse a locked device 401 unlock_required, before the pane is read or touched', async () => {
    // Arrange
    const world = await machine();

    // Act
    const response = await world.answerPermission();

    // Assert
    refusedAs(response, 401, UNLOCK_REQUIRED_CODE);
    should([world.permissionKeys.commands, world.permissionKeys.captures]).deepEqual([[], []]);
  });

  it('should answer for an unlocked device, as a terminal open is served', async () => {
    // Arrange
    const world = await machine();
    await world.unlock();

    // Act
    const response = await world.answerPermission();

    // Assert
    should([response.status, jsonBody(response)]).deepEqual([200, { requestId: PERMISSION_ID, cleared: true }]);
    should(world.permissionKeys.commands).have.length(1);
  });

  it('should pass authorization for an unlocked device with no per-act step-up left', async () => {
    // Arrange
    const world = await machine();
    await world.unlock();
    world.registry.forgetDevice(deviceId);

    // Act
    const response = await world.ask('POST', permissionPath, stale);

    // Assert
    passedAuthorization(response);
    should(world.permissionKeys.commands).deepEqual([]);
  });

  it('should answer for a caller at the machine, locked or not, because loopback is ungoverned', async () => {
    // Arrange — no device, no unlock, and `terminal` switched off for everybody who is governed.
    const world = await machine({}, { ...DEFAULT_CAPABILITY_GRANTS, terminal: { use: false, configure: false } });

    // Act
    const response = await world.http.dispatch(
      request({
        method: 'POST',
        path: permissionPath,
        headers: { authorization: 'Bearer admin-secret', 'x-ferretry-client': 'cli' },
        loopback: true,
        body: stale,
      }),
    );

    // Assert
    passedAuthorization(response);
  });

  it('should refuse an unlocked device when the operator has not granted terminal use', async () => {
    // Arrange
    const world = await machine({}, { ...DEFAULT_CAPABILITY_GRANTS, terminal: { use: false, configure: false } });
    await world.unlock();

    // Act
    const response = await world.answerPermission();

    // Assert — an unlock buys what the grants allow and nothing more.
    should(response.status).equal(403);
    should(String(jsonBody(response).error)).match(/has not granted the UI the use of session terminals/u);
    should([world.permissionKeys.commands, world.permissionKeys.captures]).deepEqual([[], []]);
  });

  it('should treat a RELAYED request as remote, refusing it locked and serving it unlocked', async () => {
    // Arrange — a relay terminates on this host, so the request looks local in every way but one.
    const world = await machine();
    const relayed = () =>
      world.http.dispatch(
        tunnelApiRequest(
          {
            method: 'POST',
            path: permissionPath,
            headers: { host: '127.0.0.1:7432', 'x-forwarded-for': '127.0.0.1' },
            body: stale,
          },
          phone,
          'rendezvous-session',
        ),
      );

    // Act
    const locked = await relayed();
    await world.unlock();
    const unlocked = await relayed();

    // Assert
    refusedAs(locked, 401, UNLOCK_REQUIRED_CODE);
    passedAuthorization(unlocked);
  });

  it('should fail closed when this machine cannot say what it granted', async () => {
    // Arrange — an unreadable grant document, with the device unlocked.
    const world = await machine();
    await world.unlock();
    const undetermined = new ApiDispatcher(
      new ApiRouter(
        sessionPermissionRoutes(permissionSubsystem({}, world.permissionKeys), sessionDirectory([sessionView('s1')])),
      ),
      {
        admin: 'admin-secret',
        warden: 'warden-secret',
        devices: { has: (id: string) => id === deviceId, grants: () => DEFAULT_CAPABILITY_GRANTS },
      },
      grantSubsystem({ broken: true }),
      undefined,
      world.service,
    );

    // Act
    const response = await undetermined.dispatch(
      request({ method: 'POST', path: permissionPath, device: phone, loopback: false, body: stale }),
    );

    // Assert
    should(response.status).equal(403);
    should(jsonBody(response)).have.property('code', 'grant_undetermined');
    should([world.permissionKeys.commands, world.permissionKeys.captures]).deepEqual([[], []]);
  });
});
