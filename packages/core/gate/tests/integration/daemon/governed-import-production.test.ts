/**
 * C59 O5-10b R1: a REMOTE phone's import is ONE loosening act on ONE named passkey, proved with Gate's PRODUCTION
 * admission (`GateAdmission`, never `StandInAdmission`) over the REAL Access step-up service and registry, the real
 * Runtimes and Claude Code halves, and the kernel's real config service (temp FY_HOME, fake person home, no network).
 *
 * What the stand-in suite (`governed-import.test.ts`) cannot see, because it hands the handler a claim function of its own:
 * 1. the claim takes only a passkey proved for `loosen-config` (a proof for another act, or for none, never confirms);
 * 2. under `stepUpOnActions` with a ZERO-minute window the admission spends the step-up it rode on, and the claim must
 *    still take the passkey that admitted the call (one step-up, one act) — and the FIRST refusal already names the act;
 * 3. the act opens inside the service's serialised apply, so an apply that raced another cannot run outside it;
 * 4. an apply whose request ended while it waited writes and consumes nothing;
 * 5. the log names only ids the daemon minted and fixed codes, and tells what a `200` left held or refused.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { epochMs, instantFromEpochMs } from '@ferretry/std';
import type { DaemonImplementation } from '@ferretry/kernel/manifest';
import { device, fixedClock, type TestHost, testHost } from '@ferretry/kernel/testing';
import { FakeFerrets } from '../../../../ferrets/contract/testing/index.ts';
import { nodeFs } from '../../../../kernel/host/adapters/node-fs.ts';
import { rootsPortFor } from '../../../../kernel/host/roots.ts';
import { daemonImplementations } from '../../../../kernel/src/generated/plugins.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import {
  fakeLoginChanges,
  fakeLoginEnvImport,
  fakeLogins,
} from '../../../../../plugins/logins/contract/testing/index.ts';
import { stepUpProvider } from '../../../../../plugins/access/daemon/step-up-provider.ts';
import { fixture, phone } from '../../../../../plugins/access/tests/support/daemon/step-up-fixture.ts';
import {
  DEFAULT_GATE_CONFIG,
  DEFAULT_GATE_SECURITY,
  FULL_DEVICE_GRANTS,
  STEP_UP_ACTS,
  type GateConfig,
} from '../../../contract/index.ts';
import { FakeDeviceProvider, FakeFerretBearers, holder } from '../../../contract/testing/index.ts';
import { GateAdmission } from '../../../daemon/lib/api/admission.ts';
import { FailClosedStepUps } from '../../../daemon/lib/step-up/witness.ts';

const made: string[] = [];
const hosts: TestHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  for (const folder of made.splice(0)) await rm(folder, { recursive: true, force: true });
});

const half = (id: string): DaemonImplementation<any> => {
  const found = daemonImplementations.find(implementation => implementation.manifest.id === id);
  if (found === undefined) throw new Error(`the generated registry has no ${id} half`);
  return found;
};

async function fleetWorld() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'fy-governed-import-prod-')));
  made.push(parent);
  const home = join(parent, 'fy-home');
  const person = join(parent, 'person');
  await mkdir(join(home, 'fleet'), { recursive: true });
  await mkdir(join(person, '.claude', 'skills'), { recursive: true });
  const roots = rootsPortFor(
    nodeFs(() => crypto.randomUUID()),
    { home, plugin: 'runtimes', worktrees: join(parent, 'worktrees') },
    ['fleet', 'harness-home'],
    () => undefined,
    { harnessFiles: ['.claude.json'], setMode: true },
  );
  return { person, roots };
}

/** The owner's own Claude settings, with the permission mode the owner really runs. Fixture values only. */
const OWNER_SETTINGS = JSON.stringify({
  model: 'claude-opus-5-5',
  permissions: { defaultMode: 'bypassPermissions' },
  skipDangerousModePermissionPrompt: true,
});

/** How the owner has set the machine's two switches: a passkey on every act, with a window of `minutes`. */
interface Mode {
  readonly perAct: boolean;
  readonly minutes: number;
}
const ZERO_MINUTE: Mode = { perAct: true, minutes: 0 };
const UNLOCKED: Mode = { perAct: false, minutes: 15 };

const NOW_MS = Date.parse('2026-11-01T12:00:00.000Z');

/**
 * The machine: Gate's PRODUCTION admission over Access's REAL step-up service (its registry, window and settings), the
 * paired phone enrolled and unlocked, and the real Runtimes + Claude Code halves behind it.
 */
async function machine(mode: Mode, settings: object = JSON.parse(OWNER_SETTINGS)) {
  const world = await fleetWorld();
  const person = world.person;
  await writeFile(join(person, '.claude', 'CLAUDE.md'), 'Be kind to Claude.\n');
  await writeFile(join(person, '.claude', 'settings.json'), JSON.stringify(settings));
  const runtimes = half('runtimes');
  const build = runtimes.build;
  if (build === undefined) throw new Error('the runtimes half has no build');
  const overRealRoots = {
    ...runtimes,
    build: (ctx: Parameters<typeof build>[0]) =>
      build({ ...ctx, kernel: { ...ctx.kernel, roots: world.roots } } as never),
  } as DaemonImplementation<any>;

  // Access's real step-up service: the registry holds the window; `stepUpOnActions` and the window are ONE setting for both.
  const access = fixture({
    nowMs: NOW_MS,
    settings: { stepUpOnActions: mode.perAct, stepUpWindowMinutes: mode.minutes, unlockOnOpen: false },
    window: { minutes: mode.minutes },
  });
  const subject = { deviceId: phone.deviceId, appSession: `session-${phone.deviceId}` };
  access.registry.open(subject);
  const policy: GateConfig = {
    ...DEFAULT_GATE_CONFIG,
    security: {
      ...DEFAULT_GATE_SECURITY,
      unlockOnOpen: false,
      stepUpOnActions: mode.perAct,
      stepUpWindowMinutes: mode.minutes,
    },
  };
  const devices = new FakeDeviceProvider();
  devices.enrol(holder(phone.deviceId), FULL_DEVICE_GRANTS, instantFromEpochMs(NOW_MS + 3_600_000));
  const witness = stepUpProvider(() => access.service);
  const gate = new GateAdmission({
    tokens: () => ({
      admin: 'admin-token-for-tests-0000000000000000000000',
      warden: 'warden-token-for-tests-000000000000000000000',
    }),
    ferrets: () => new FakeFerretBearers(),
    devices: () => devices,
    members: () => undefined,
    policy: () => policy,
    remedies: () => undefined,
    stepUps: new FailClosedStepUps(() => witness),
    now: () => instantFromEpochMs(NOW_MS),
    refused: () => undefined,
    recorded: () => undefined,
    clientName: 'fy',
  });

  const loginEnvImport = fakeLoginEnvImport();
  const loginChanges = fakeLoginChanges();
  // The Logins door an import asks first (`createLogins`): a case can hold it, to keep an apply INSIDE the serialised
  // section, or make it throw.
  const inner = fakeLogins([]);
  const door = {
    armed: false,
    /** How many `list` calls to let through once armed, before the door holds: later calls are the apply's own writes. */
    skip: 0,
    calls: 0,
    failure: undefined as Error | undefined,
    entered: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
  };
  const logins = {
    ...inner,
    list: async () => {
      door.calls += 1;
      if (door.armed && door.skip > 0) door.skip -= 1;
      else if (door.armed) {
        door.armed = false;
        door.entered.resolve();
        await door.release.promise;
      }
      if (door.failure !== undefined) throw door.failure;
      return await inner.list();
    },
  };
  const host = await testHost({
    plugins: [overRealRoots, half('claude-code')],
    fakes: {
      ferrets: new FakeFerrets(),
      logins,
      loginChanges,
      loginEnvImport,
      vault: new FakeVault(),
    },
    gate,
    config: {},
    clock: fixedClock('2026-11-01T12:00:00.000Z'),
    ownerHome: person,
    executables: ['/fixture/bin/claude'],
    searchPath: '/fixture/bin',
    spawn: () => ({ code: 0, stdout: '', stderr: '' }) as never,
  });
  hosts.push(host);
  /** The passkey was just proved, FOR `act` (or for no act): a step-up and the fresh proof stamped with it. */
  const prove = (act?: Parameters<typeof access.registry.grant>[3]): void => {
    access.registry.grant(subject, epochMs(instantFromEpochMs(NOW_MS)) - 1_000, true, act);
  };
  /** The phone confirmed it is the person (an unlock-style step-up): it holds the window, never a fresh proof. */
  const confirm = (): void => {
    access.registry.grant(subject, epochMs(instantFromEpochMs(NOW_MS)) - 1_000, false);
  };
  return { host, access, subject, prove, confirm, loginEnvImport, loginChanges, door };
}

const as = { as: device(phone.deviceId) } as const;

/** The phone stages the import: its own `fleet.configure` act, on the step-up it just confirmed with. */
const stage = async ({ host, confirm }: { readonly host: TestHost; readonly confirm: () => void }): Promise<string> => {
  confirm();
  const staged = await host.request('POST', '/v1/runtimes/proposals', {
    ...as,
    body: { change: { kind: 'setup.import', include: ['claude-code'] } },
  });
  expect([staged.status, staged.status === 200 ? '' : staged.body]).toEqual([200, '']);
  return staged.json<{ id: string }>().id;
};

const apply = async (host: TestHost, id: string, init: { readonly signal?: AbortSignal } = {}) =>
  await host.request('POST', `/v1/runtimes/proposals/${id}/apply`, { ...as, body: {}, ...init });

const written = (host: TestHost): string[] => host.configChanges.map(change => change.path).toSorted();

const FILES = [
  'claude-code/settings/claude-settings.yaml',
  'instructions/claude-instructions.yaml',
  'model-sets/claude-models.yaml',
  'profiles/claude-default.yaml',
  'runtimes/claude-default.yaml',
];

const notApplied = (host: TestHost) =>
  host.logs.filter(line => line.level === 'warn' && line.message === 'runtimes: a change was not fully applied');

describe('C59 O5-10b R1 item 1: the act claims the NAMED passkey (production admission, real Access registry)', () => {
  test('a passkey proved for ANOTHER act, or for none, never confirms an import: 403 loosen-config, nothing written, the change stays pending', async () => {
    const m = await machine(UNLOCKED);
    const { host, prove } = m;
    const id = await stage(m);

    prove(STEP_UP_ACTS.addDevice);
    const other = await apply(host, id);
    expect(other.status).toBe(403);
    expect(other.json()).toMatchObject({
      code: 'grant_step_up_required',
      demand: { capability: 'fleet', axis: 'configure', act: 'loosen-config' },
    });
    expect(written(host)).toEqual([]);
  });

  test('an act-less passkey is not the named one either', async () => {
    const m = await machine(UNLOCKED);
    const { host, prove } = m;
    const id = await stage(m);

    prove(undefined);
    const unstamped = await apply(host, id);

    expect(unstamped.status).toBe(403);
    expect(written(host)).toEqual([]);
    const pending = await host.request('GET', `/v1/runtimes/proposals/${id}`, as);
    expect(pending.json<{ state: string }>().state).toBe('pending');
  });

  test('the passkey proved for loosen-config covers settings, instructions, model set, profile and runtime: ONE proof, ONE act', async () => {
    const m = await machine(UNLOCKED);
    const { host, access, subject, prove } = m;
    const id = await stage(m);

    prove(STEP_UP_ACTS.loosenConfig);
    const applied = await apply(host, id);

    expect([applied.status, applied.status === 200 ? '' : applied.body]).toEqual([200, '']);
    expect(written(host)).toEqual(FILES);
    // The proof is used up: it was claimed once, for the whole import.
    expect(access.registry.freshlyHeld(subject, NOW_MS)).toBe(false);
  });
});

describe('C59 O5-10b R1 item 2: stepUpOnActions with a ZERO-minute window (production admission, real Access registry)', () => {
  test('the first refusal already names the act, so ONE ceremony for it completes the import', async () => {
    const m = await machine(ZERO_MINUTE);
    const { host, prove } = m;
    const id = await stage(m);

    // Nothing held: the admission's own step-up refusal says which act the passkey is for.
    const first = await apply(host, id);
    expect(first.status).toBe(403);
    expect(first.json()).toMatchObject({
      code: 'grant_step_up_required',
      demand: { capability: 'fleet', axis: 'configure', act: 'loosen-config' },
    });
    expect(written(host)).toEqual([]);

    // The carrier proves the passkey for exactly that act and sends the same apply again: it completes.
    prove(STEP_UP_ACTS.loosenConfig);
    const second = await apply(host, id);
    expect([second.status, second.status === 200 ? '' : second.body]).toEqual([200, '']);
    expect(written(host)).toEqual(FILES);
  });

  test('one step-up is one act: a second import needs its own passkey', async () => {
    const m = await machine(ZERO_MINUTE);
    const { host, prove } = m;
    const first = await stage(m);
    prove(STEP_UP_ACTS.loosenConfig);
    expect((await apply(host, first)).status).toBe(200);

    const again = await stage(m);
    const refused = await apply(host, again);
    expect(refused.status).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'grant_step_up_required' });
  });
});

describe('C59 O5-10b R1 item 3: the act opens inside the serialised apply, on the change as it really is', () => {
  test('two applies of ONE import raced on ONE passkey: exactly one runs, inside the act; the other writes nothing', async () => {
    const m = await machine(UNLOCKED);
    const { host, prove, door, loginChanges } = m;
    const id = await stage(m);
    prove(STEP_UP_ACTS.loosenConfig);

    // The first apply is inside the section (held at the Logins door) when the second one arrives.
    door.armed = true;
    const first = apply(host, id);
    await door.entered.promise;
    const second = apply(host, id);
    await host.settle();
    door.release.resolve();
    const answers = await Promise.all([first, second]);

    expect(answers.map(answer => answer.status).toSorted()).toEqual([200, 409]);
    // One import landed, once: every file written a single time, one login created.
    expect(written(host)).toEqual(FILES);
    expect(loginChanges.staged.filter(change => change.kind === 'login.add')).toHaveLength(1);
  });

  test('an import that reaches the section without a passkey is refused THERE, before anything is written: the act is never skipped', async () => {
    const m = await machine(UNLOCKED);
    const { host, prove, door } = m;
    const held = await stage(m);
    const waiting = await stage(m);
    prove(STEP_UP_ACTS.loosenConfig);

    // The first import holds the section with the device's one proof; the second waits for its turn with none left.
    door.armed = true;
    const first = apply(host, held);
    await door.entered.promise;
    const second = apply(host, waiting);
    await host.settle();
    door.release.resolve();
    const [landed, refused] = await Promise.all([first, second]);

    expect(landed.status).toBe(200);
    expect(refused.status).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'grant_step_up_required', demand: { act: 'loosen-config' } });
    expect(written(host)).toEqual(FILES);
    const pending = await host.request('GET', `/v1/runtimes/proposals/${waiting}`, as);
    expect(pending.json<{ state: string }>().state).toBe('pending');
  });
});

describe('C59 O5-10b R1 item 4: the act is bound to the request, including while it is queued', () => {
  test('a request that ended while it waited its turn consumes nothing, takes no passkey and writes nothing', async () => {
    const m = await machine(UNLOCKED);
    const { host, prove, door, access, subject } = m;
    const running = await stage(m);
    const left = await stage(m);
    prove(STEP_UP_ACTS.loosenConfig);

    door.armed = true;
    const first = apply(host, running);
    await door.entered.promise;
    // The device's NEXT passkey, proved while the first apply runs: an aborted request must not take it either.
    const caller = new AbortController();
    const second = apply(host, left, { signal: caller.signal });
    await host.settle();
    prove(STEP_UP_ACTS.loosenConfig);
    caller.abort();
    door.release.resolve();
    const [landed, aborted] = await Promise.all([first, second]);

    expect(landed.status).toBe(200);
    expect([aborted.status, aborted.json<{ code: string }>().code]).toEqual([499, 'request_aborted']);
    // Only the first import wrote anything, once; the second is still pending and its passkey is still unspent.
    expect(written(host)).toEqual(FILES);
    expect((await host.request('GET', `/v1/runtimes/proposals/${left}`, as)).json<{ state: string }>().state).toBe(
      'pending',
    );
    expect(access.registry.freshlyHeld(subject, NOW_MS)).toBe(true);
  });
});

describe('C59 O5-10b R2 item 4b: an apply whose request ends once it has STARTED stops before its next owner write', () => {
  test('aborted while the Logins door is held: no login is created, no component or settings file is written, the log says so', async () => {
    const m = await machine(UNLOCKED);
    const { host, prove, door, loginChanges } = m;
    const id = await stage(m);
    prove(STEP_UP_ACTS.loosenConfig);

    // The apply is INSIDE execution (Logins' door is held in `createLogins`, after the Vault was filed) when its request
    // ends. Its first three reads of Logins are the review's (current model, two scans), so the fourth is the write path.
    door.armed = true;
    door.skip = 3;
    const caller = new AbortController();
    const running = apply(host, id, { signal: caller.signal });
    await door.entered.promise;
    caller.abort();
    door.release.resolve();
    const answered = await running;
    // The handler may outlive the answer the caller already left: let everything it still does land before looking.
    await host.settle();

    expect([answered.status, answered.json<{ code: string }>().code]).toEqual([499, 'request_aborted']);
    expect(loginChanges.staged).toEqual([]);
    expect(written(host)).toEqual([]);
    expect(notApplied(host).map(line => line.fields)).toEqual([
      { change: id, kind: 'setup.import', status: 499, code: 'request_aborted' },
    ]);
  });
});

describe('C59 O5-10b R1 item 5: the log names minted ids and fixed codes, and what a 200 left behind', () => {
  test('an id of the right SHAPE that the catalogue does not hold is the fixed `unknown-proposal`, never the segment', async () => {
    const m = await machine(UNLOCKED);
    const { host, prove } = m;
    const shaped = `fy_fprop_${'Z'.repeat(22)}`;
    prove(STEP_UP_ACTS.loosenConfig);

    const missing = await apply(host, shaped);

    expect(missing.status).toBe(404);
    expect(notApplied(host).map(line => line.fields)).toEqual([
      { change: 'unknown-proposal', kind: 'unknown', status: 404, code: 'fleet_change_unknown' },
    ]);
    expect(JSON.stringify(host.logs)).not.toContain(shaped);
  });

  test('a path segment that is no change id is never logged, and neither is the text of what failed', async () => {
    const m = await machine(UNLOCKED);
    const { host, prove, door } = m;
    const id = await stage(m);
    prove(STEP_UP_ACTS.loosenConfig);

    const missing = await apply(host, 'secret-looking-path-segment');
    expect(missing.status).toBe(404);
    prove(STEP_UP_ACTS.loosenConfig);
    door.failure = Object.assign(new Error('a failure'), { name: 'SensitiveErrorName' });
    const failed = await apply(host, id);
    expect(failed.status).toBe(409);

    // Ids the daemon minted and codes it chose: no segment from the path, no error name, no sentence.
    expect(notApplied(host).map(line => line.fields)).toEqual([
      { change: 'unknown-proposal', kind: 'unknown', status: 404, code: 'fleet_change_unknown' },
      { change: id, kind: 'setup.import', status: 409, code: 'fleet_catalog_unreadable' },
    ]);
    expect(JSON.stringify(host.logs)).not.toContain('secret-looking-path-segment');
    expect(JSON.stringify(host.logs)).not.toContain('SensitiveErrorName');
    expect(JSON.stringify(host.logs)).not.toContain('a failure');
  });

  test("a 200 that left a login's variables held is a log line, read from structured state", async () => {
    const env = { env: { ANTHROPIC_BASE_URL: 'https://proxy.example.invalid' } };
    const m = await machine(UNLOCKED, { ...JSON.parse(OWNER_SETTINGS), ...env });
    const { host, prove, loginEnvImport } = m;
    const id = await stage(m);
    loginEnvImport.setOutcome({
      outcome: 'held',
      added: ['ANTHROPIC_BASE_URL'],
      kept: [],
      skipped: [],
      sentences: ['waits'],
    });
    prove(STEP_UP_ACTS.loosenConfig);

    const applied = await apply(host, id);

    expect(applied.status).toBe(200);
    expect(loginEnvImport.asked.length).toBeGreaterThan(0);
    expect(notApplied(host).map(line => line.fields)).toEqual([
      { change: id, kind: 'setup.import', status: 200, code: 'held' },
    ]);
  });

  test("a 200 that left a login's variables refused is a log line too", async () => {
    const env = { env: { ANTHROPIC_BASE_URL: 'https://proxy.example.invalid' } };
    const m = await machine(UNLOCKED, { ...JSON.parse(OWNER_SETTINGS), ...env });
    const { host, prove, loginEnvImport } = m;
    const id = await stage(m);
    loginEnvImport.setOutcome({ outcome: 'refused', reason: 'that login is not yours to change' });
    prove(STEP_UP_ACTS.loosenConfig);

    const applied = await apply(host, id);

    expect(applied.status).toBe(200);
    expect(notApplied(host).map(line => line.fields)).toEqual([
      { change: id, kind: 'setup.import', status: 200, code: 'refused' },
    ]);
    // The refusal's sentence is for the person, never for the log.
    expect(JSON.stringify(host.logs)).not.toContain('not yours to change');
  });
});
