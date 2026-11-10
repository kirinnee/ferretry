import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  type Actor,
  type CallStanding,
  type ConfigPort,
  type ConfigWriteJudgement,
  defineConfig,
  jsonResponse,
} from '@ferretry/kernel/contract';
import {
  config as kernelConfig,
  currentActor,
  currentStanding,
  runInCall,
  state as kernelState,
} from '@ferretry/kernel/host';
import { definePlugin, implementDaemon, route } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import { DEFAULT_GATE_CONFIG, FULL_DEVICE_GRANTS } from '../../../../contract/index.ts';
import { holder, StandInAdmission } from '../../../../contract/testing/index.ts';
import { CLIENT_HEADER, SESSION_ID_HEADER } from '../../../../daemon/lib/api/admission.ts';
import { judgeLooseningWrite, judgeOwnerSecretAdd } from '../../../../daemon/lib/policy/config-judge.ts';
import {
  ADMIN,
  admit,
  carried,
  descriptor,
  FERRET_TOKEN,
  fleetConfigure,
  later,
  local,
  type World,
  world,
} from '../support.ts';

/**
 * `ConfigPort.writeAsCaller` through the REAL config writer, Gate's REAL judge and Gate's real admission standings: one
 * edit (an env value `${secret:ACME_TOKEN}`), asked as every kind of caller. Only the owner's add goes into effect.
 */
const FAKE_VALUE = 'FAKE-VALUE-3b2d8e-not-a-real-secret';
const HOME = '/home/fy';
const ADD = 'env:\n  TOKEN: ${secret:ACME_TOKEN}\n';

const mcpDef = defineConfig({
  collection: 'mcp',
  name: /^[a-z]{1,20}$/,
  schema: z.strictObject({
    env: z.record(z.string(), z.string()).default({}),
    note: z.string().optional(),
    limit: z.number().int().default(10),
  }),
  axis: 'configure',
  loosens: (before, after) => (after.limit > (before?.limit ?? 10) ? ['raises the limit'] : []),
});

/** A route that asks no capability of its own but reads the grants, which is where a plugin's config write can run. */
const route0 = descriptor({ consultsGrants: true });
const subjectOf = (id: string) => ({ deviceId: id, appSession: `s-${id}` });
const atMachine = { bearer: ADMIN, arrival: local(), headers: { [CLIENT_HEADER]: 'cli' } };
const relayed = { bearer: ADMIN, arrival: carried(), headers: { [CLIENT_HEADER]: 'cli' } };

interface Call {
  readonly actor: Actor;
  readonly standing?: CallStanding;
}

/** The admission that minted each standing: the judge below asks it, as the built daemon asks its own. */
const mintedBy = new WeakMap<object, World>();
const nobody = world();

function callOf(w: World, options: Parameters<typeof admit>[2] = {}, route = route0): Call {
  const { decision, outcome } = admit(w, route, options);
  if (decision.outcome !== 'admitted') throw new Error(`expected admitted, got ${outcome}`);
  mintedBy.set(decision.standing, w);
  return { actor: decision.actor, standing: decision.standing };
}

/** The host's wiring, as `host.ts` makes it: the ambient call at the moment the writer asks, and nothing else. */
const hostJudge = (input: Omit<ConfigWriteJudgement, 'actor' | 'standing'>): boolean => {
  try {
    const standing = currentStanding();
    const gate = (standing === undefined ? undefined : mintedBy.get(standing)) ?? nobody;
    return gate.gate.judgeConfigWrite({ ...input, actor: currentActor(), standing }) === 'apply';
  } catch {
    return false;
  }
};

async function realPort(): Promise<{ port: ConfigPort; lines: string[] }> {
  const lines: string[] = [];
  const log = {
    debug: (m: string) => void lines.push(m),
    info: (m: string) => void lines.push(m),
    warn: (m: string) => void lines.push(m),
    error: (m: string) => void lines.push(m),
    child: () => log,
  };
  const cancel = () => undefined;
  const files = kernelConfig.createConfigFiles({
    home: HOME,
    fs: kernelState.createMemoryHostFs(),
    clock: { nowMs: () => 0, after: () => cancel, every: () => cancel },
    log: log as never,
    binary: 'fy',
    defs: [{ plugin: 'mcp', def: mcpDef }],
    judge: hostJudge,
  });
  await files.reload();
  return { port: files.port('mcp'), lines };
}

/** Writes the one edit as `call` (`undefined`: no ambient scope at all, a job) and answers the outcome's kind. */
async function writeAs(
  call: Call | undefined,
  edit = ADD,
): Promise<{ kind: string; inEffect: unknown; lines: string[] }> {
  const { port, lines } = await realPort();
  const run = async () => (await port.writeAsCaller(mcpDef, 'acme', edit)).kind;
  const kind = call === undefined ? await run() : await runInCall(call, run);
  return { kind, inEffect: port.collection(mcpDef).get('acme'), lines };
}

describe('writeAsCaller: one edit, every kind of caller', () => {
  test('writeAsCaller the host admin where the request arrived on the host: in effect', async () => {
    const result = await writeAs(callOf(world(), atMachine));
    expect(result.kind).toBe('written');
    expect(result.inEffect).toMatchObject({ env: { TOKEN: '${secret:ACME_TOKEN}' } });
    expect(result.lines).toContain('config mcp/acme.yaml: the owner put a secret reference into effect (ACME_TOKEN)');
  });

  test('writeAsCaller the admin token relayed from off the host is remote: held', async () => {
    const result = await writeAs(callOf(world(), relayed));
    expect(result.kind).toBe('held');
    expect(result.inEffect).toBeUndefined();
  });

  test('writeAsCaller G129 G131 a governed device with the configure capability and only the unlock: held, as the route holds it', async () => {
    const w = world();
    w.enrol('phone');
    const result = await writeAs(callOf(w, { device: 'phone' }));
    expect(result.kind).toBe('held');
    expect(result.inEffect).toBeUndefined();
  });

  test('writeAsCaller G129 G131 a governed device with the configure capability and a passkey proved for the act: in effect, the proof spent', async () => {
    const w = world();
    w.enrol('phone');
    w.stepUps.grant(subjectOf('phone'));
    const call = callOf(w, { device: 'phone' });
    const first = await writeAs(call);
    expect(first.kind).toBe('written');
    expect(first.inEffect).toMatchObject({ env: { TOKEN: '${secret:ACME_TOKEN}' } });
    // one proof, one act: the same call cannot add a second reference
    expect((await writeAs(call)).kind).toBe('held');
  });

  test('writeAsCaller G129 G131 a device with a proof but without the configure capability: held', async () => {
    const w = world();
    w.enrol('phone', { ...FULL_DEVICE_GRANTS, fleet: { use: true, configure: false } });
    w.stepUps.grant(subjectOf('phone'));
    expect((await writeAs(callOf(w, { device: 'phone' }))).kind).toBe('held');
  });

  test('writeAsCaller G129 G131 the host admin over loopback needs no proof: unchanged', async () => {
    expect((await writeAs(callOf(world(), atMachine))).kind).toBe('written');
  });

  test('writeAsCaller a governed device with the capability that is NOT unlocked (unlock off, no proof): held', async () => {
    const w = world({
      policy: { ...DEFAULT_GATE_CONFIG, security: { ...DEFAULT_GATE_CONFIG.security, unlockOnOpen: false } },
    });
    w.enrol('phone');
    const result = await writeAs(callOf(w, { device: 'phone' }));
    expect(result.kind).toBe('held');
    expect(result.inEffect).toBeUndefined();
  });

  test('writeAsCaller a LOCKED device never reaches a handler; with no standing the write is held', async () => {
    const w = world();
    w.enrol('phone', FULL_DEVICE_GRANTS, false);
    expect(admit(w, route0, { device: 'phone' }).decision.outcome).not.toBe('admitted');
    expect((await writeAs(undefined)).kind).toBe('held');
  });

  test('writeAsCaller a device unlocked WITHOUT the configure capability: held', async () => {
    const w = world();
    w.enrol('phone', { ...FULL_DEVICE_GRANTS, fleet: { use: true, configure: false } });
    const result = await writeAs(callOf(w, { device: 'phone' }));
    expect(result.kind).toBe('held');
    expect(result.inEffect).toBeUndefined();
  });

  test('writeAsCaller a device the owner kept off the fleet is held even with configure', async () => {
    const w = world();
    w.enrol('phone', { ...FULL_DEVICE_GRANTS, fleet: { use: false, configure: true } });
    expect((await writeAs(callOf(w, { device: 'phone' }))).kind).toBe('held');
  });

  test('writeAsCaller a ferret session credential: held', async () => {
    const result = await writeAs(callOf(world(), { bearer: FERRET_TOKEN, arrival: local(true) }));
    expect(result.kind).toBe('held');
    expect(result.inEffect).toBeUndefined();
  });

  test('writeAsCaller a ferret session credential cannot be lifted by a standing that says the owner is calling', async () => {
    const w = world();
    const ferret = callOf(w, { bearer: FERRET_TOKEN, arrival: local(true) });
    expect((await writeAs({ actor: 'owner-tools', standing: ferret.standing })).kind).toBe('held');
  });

  test('writeAsCaller a job (no call in progress): held', async () => {
    expect((await writeAs(undefined)).kind).toBe('held');
  });

  test('writeAsCaller a member call (a call with no standing): held, whoever the actor says it is', async () => {
    expect((await writeAs({ actor: 'owner-viewer' })).kind).toBe('held');
    expect((await writeAs({ actor: 'owner-tools' })).kind).toBe('held');
  });

  test('writeAsCaller no ambient scope at all: held', async () => {
    const result = await writeAs(undefined);
    expect(result.kind).toBe('held');
    expect(result.inEffect).toBeUndefined();
  });

  test('writeAsCaller a plain write of the same edit by the host admin stays held: only writeAsCaller asks', async () => {
    const { port } = await realPort();
    const kind = await runInCall(callOf(world(), atMachine), async () => (await port.write(mcpDef, 'acme', ADD)).kind);
    expect(kind).toBe('held');
  });

  test('writeAsCaller an owner edit with no secret in it is judged as write judges it', async () => {
    for (const call of [callOf(world(), atMachine), callOf(world(), relayed)]) {
      const { port } = await realPort();
      const viaCaller = await runInCall(
        call,
        async () => (await port.writeAsCaller(mcpDef, 'acme', 'limit: 50\n')).kind,
      );
      const { port: other } = await realPort();
      const viaWrite = await runInCall(call, async () => (await other.write(mcpDef, 'acme', 'limit: 50\n')).kind);
      expect(viaCaller).toBe(viaWrite);
    }
  });

  test('writeAsCaller the log names the secret and the file and holds no value of the edit', async () => {
    const edit = `${ADD}note: ${FAKE_VALUE}\n`;
    const result = await writeAs(callOf(world(), atMachine), edit);
    expect(result.kind).toBe('written');
    expect(JSON.stringify(result.lines)).not.toContain(FAKE_VALUE);
  });
});

describe('writeAsCaller: the owner question takes the one proof a loosening takes (G129, G131)', () => {
  const askOf = (call: Call, extra: Partial<ConfigWriteJudgement> = {}): ConfigWriteJudgement => ({
    plugin: 'mcp',
    path: 'mcp/acme.yaml',
    removal: false,
    sentences: ['names the secret ACME_TOKEN, which only the owner may add to a configuration'],
    actor: call.actor,
    standing: call.standing,
    secretAdd: true,
    ...extra,
  });

  test('writeAsCaller G131 judgeOwnerSecretAdd and a loosening share one proof: whichever goes first applies, the other holds', () => {
    const w = world();
    w.enrol('phone');
    w.stepUps.grant(subjectOf('phone'));
    const call = callOf(w, { device: 'phone' });
    expect(judgeOwnerSecretAdd(askOf(call))).toBe('apply');
    expect(judgeOwnerSecretAdd(askOf(call))).toBe('hold');
    expect(judgeLooseningWrite(askOf(call, { secretAdd: undefined, sentences: ['raises the limit'] }))).toBe('hold');
    w.stepUps.grant(subjectOf('phone'));
    const next = callOf(w, { device: 'phone' });
    expect(judgeLooseningWrite(askOf(next, { secretAdd: undefined, sentences: ['raises the limit'] }))).toBe('apply');
    expect(judgeOwnerSecretAdd(askOf(next))).toBe('hold');
  });

  test('writeAsCaller G131 a device with only the unlock holds a secret add and a loosening alike', () => {
    const w = world();
    w.enrol('phone');
    const call = callOf(w, { device: 'phone' });
    expect(judgeLooseningWrite(askOf(call, { secretAdd: undefined, sentences: ['raises the limit'] }))).toBe('hold');
    expect(judgeLooseningWrite(askOf(call))).toBe('hold');
    expect(judgeOwnerSecretAdd(askOf(call))).toBe('hold');
  });

  test('writeAsCaller G129 G131 warden.yaml asks the warden capability, not the fleet’s, for a secret add too', () => {
    const w = world();
    w.enrol('phone', { ...FULL_DEVICE_GRANTS, warden: { use: true, configure: false } });
    w.stepUps.grant(subjectOf('phone'));
    expect(judgeOwnerSecretAdd(askOf(callOf(w, { device: 'phone' }), { path: 'warden.yaml' }))).toBe('hold');
  });
});

describe('writeAsCaller: the testing host judges the same, from the same Gate judge and the ambient call', () => {
  class Judging extends StandInAdmission {
    judgeConfigWrite(input: ConfigWriteJudgement): 'apply' | 'hold' {
      return judgeLooseningWrite(input);
    }
  }

  const scoped = { minimum: 'authenticated', caller: 'any', audit: { skip: 'test' }, guard: { none: 'test' } } as const;
  const manifest = definePlugin({
    id: 'mcp',
    title: 'MCP',
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: [],
    data: { config: [mcpDef] },
    actions: { routes: [route('POST /v1/test/add', scoped)] },
  });

  async function twinAs(standing: CallStanding | undefined) {
    let config: ConfigPort | undefined;
    const half = implementDaemon(manifest, {
      build: ctx => {
        config = ctx.kernel.config;
        return {
          routes: {
            'POST /v1/test/add': async () =>
              jsonResponse({ kind: (await ctx.kernel.config.writeAsCaller(mcpDef, 'acme', ADD)).kind }),
          },
        };
      },
    });
    const host = await testHost({ plugins: [half], gate: new Judging(() => standing) });
    const answer = await host.request('POST', '/v1/test/add', { body: {} });
    const inEffect = config?.collection(mcpDef).get('acme');
    await host.stop();
    return {
      status: answer.status,
      kind: answer.status === 200 ? answer.json<{ kind: string }>().kind : undefined,
      inEffect,
    };
  }

  test('writeAsCaller twin: the host admin is in effect; relayed, a ferret and an unjudged device are held', async () => {
    const owner = await twinAs(callOf(world(), atMachine).standing);
    expect(owner.kind).toBe('written');
    expect(owner.inEffect).toMatchObject({ env: { TOKEN: '${secret:ACME_TOKEN}' } });
    for (const standing of [
      callOf(world(), relayed).standing,
      callOf(world(), { bearer: FERRET_TOKEN, arrival: local(true) }).standing,
    ]) {
      const held = await twinAs(standing);
      expect(held.status === 200 ? held.kind : 'refused').not.toBe('written');
      expect(held.inEffect).toBeUndefined();
    }
  });

  test('writeAsCaller G131 twin: a device with the capability and a proof for the act is in effect, one with the unlock only or without the capability is held', async () => {
    const w = world();
    w.enrol('phone');
    expect((await twinAs(callOf(w, { device: 'phone' }).standing)).kind).toBe('held');
    w.stepUps.grant(subjectOf('phone'));
    expect((await twinAs(callOf(w, { device: 'phone' }).standing)).kind).toBe('written');
    const v = world();
    v.enrol('phone', { ...FULL_DEVICE_GRANTS, fleet: { use: true, configure: false } });
    v.stepUps.grant(subjectOf('phone'));
    const held = await twinAs(callOf(v, { device: 'phone' }).standing);
    expect(held.kind).toBe('held');
    expect(held.inEffect).toBeUndefined();
  });
});

describe('writeAsCaller: the owner question is judged from the standing as it is when the write happens', () => {
  const perAct = {
    policy: {
      ...DEFAULT_GATE_CONFIG,
      security: { ...DEFAULT_GATE_CONFIG.security, stepUpOnActions: true, stepUpWindowMinutes: 0 },
    },
  };
  /** A device that holds the proof for the act and the capability: the add is in effect for it, as admitted. */
  const provedDevice = (w: World): Call => {
    w.enrol('phone');
    w.stepUps.grant(subjectOf('phone'));
    return callOf(w, { device: 'phone' });
  };

  test('writeAsCaller M1 a device revoked after the call was admitted holds the add', async () => {
    const w = world();
    const call = provedDevice(w);
    w.devices.revoke(holder('phone'));
    expect((await writeAs(call)).kind).toBe('held');
  });

  test('writeAsCaller M1 a device whose unlock ran out after the call was admitted holds the add', async () => {
    const w = world();
    const call = provedDevice(w);
    w.now = later(w.now, 3 * 60 * 60 * 1000);
    w.stepUps.grant(subjectOf('phone'));
    expect((await writeAs(call)).kind).toBe('held');
  });

  test('writeAsCaller M1 a device whose configure grant was narrowed after the call was admitted holds the add', async () => {
    const w = world();
    const call = provedDevice(w);
    w.devices.narrow(holder('phone'), { ...FULL_DEVICE_GRANTS, fleet: { use: true, configure: false } });
    expect((await writeAs(call)).kind).toBe('held');
  });

  test('writeAsCaller M1 the same call, with nothing changed since admission, still writes', async () => {
    const w = world();
    expect((await writeAs(provedDevice(w))).kind).toBe('written');
  });

  test('writeAsCaller M1 work the call started writes after the device was revoked: held', async () => {
    const w = world();
    const call = provedDevice(w);
    const { port } = await realPort();
    let late: Promise<{ kind: string }> | undefined;
    await runInCall(call, async () => {
      late = new Promise(resolve => setTimeout(() => void port.writeAsCaller(mcpDef, 'late', ADD).then(resolve), 20));
    });
    w.devices.revoke(holder('phone'));
    expect((await (late as Promise<{ kind: string }>)).kind).toBe('held');
    expect(port.collection(mcpDef).get('late')).toBeUndefined();
  });

  test('writeAsCaller M1 work the call started writes while the device still stands: written, on its one proof', async () => {
    const w = world();
    const call = provedDevice(w);
    const { port } = await realPort();
    let late: Promise<{ kind: string }> | undefined;
    await runInCall(call, async () => {
      late = new Promise(resolve => setTimeout(() => void port.writeAsCaller(mcpDef, 'late', ADD).then(resolve), 20));
    });
    expect((await (late as Promise<{ kind: string }>)).kind).toBe('written');
  });

  test('writeAsCaller G79 the machine asks a step-up per act: held without one', async () => {
    const w = world(perAct);
    w.enrol('phone');
    expect((await writeAs(callOf(w, { device: 'phone' }))).kind).toBe('held');
  });

  test('writeAsCaller G79 window 0: one step-up buys exactly one act — the add spends it, the second add and a fleet.configure route are refused', async () => {
    const w = world(perAct);
    w.enrol('phone');
    w.stepUps.grant(subjectOf('phone'));
    const call = callOf(w, { device: 'phone' });
    expect((await writeAs(call)).kind).toBe('written');
    // the same standing cannot add again, and a later configure route is not admitted on the spent step-up
    expect((await writeAs(call)).kind).toBe('held');
    expect(admit(w, fleetConfigure, { device: 'phone' }).outcome).not.toBe('admitted');
  });

  test('writeAsCaller G79 a step-up already spent by a configure route does not carry a later add', async () => {
    const w = world(perAct);
    w.enrol('phone');
    w.stepUps.grant(subjectOf('phone'));
    const call = callOf(w, { device: 'phone' });
    expect(admit(w, fleetConfigure, { device: 'phone' }).outcome).toBe('admitted');
    expect((await writeAs(call)).kind).toBe('held');
  });

  test('writeAsCaller M1 the judge input names the secret and never a value of the edit', async () => {
    const seen: ConfigWriteJudgement[] = [];
    const spy = (input: Omit<ConfigWriteJudgement, 'actor' | 'standing'>): boolean => {
      seen.push(input as ConfigWriteJudgement);
      return hostJudge(input);
    };
    const lines: string[] = [];
    const log = { debug() {}, info: (m: string) => void lines.push(m), warn() {}, error() {}, child: () => log };
    const cancel = () => undefined;
    const files = kernelConfig.createConfigFiles({
      home: HOME,
      fs: kernelState.createMemoryHostFs(),
      clock: { nowMs: () => 0, after: () => cancel, every: () => cancel },
      log: log as never,
      binary: 'fy',
      defs: [{ plugin: 'mcp', def: mcpDef }],
      judge: spy,
    });
    await files.reload();
    await runInCall(callOf(world(), atMachine), async () =>
      files.port('mcp').writeAsCaller(mcpDef, 'acme', `note: ${FAKE_VALUE}\nenv:\n  T: \${secret:ACME_TOKEN}\n`),
    );
    const text = JSON.stringify(seen);
    expect(seen.some(input => input.secretAdd === true)).toBe(true);
    expect(text).toContain('ACME_TOKEN');
    expect(text).not.toContain(FAKE_VALUE);
  });
});

describe('writeAsCaller: nothing a plugin passes can reach the judge’s secretAdd question', () => {
  test('writeAsCaller (1a) a plain write carrying secretAdd or judge fields in its options stays held for the owner', async () => {
    const { port } = await realPort();
    const owner = callOf(world(), atMachine);
    const injected = { judgeSecretAdds: () => true, secretAdd: true, confirmedLoosening: true } as never;
    expect((await runInCall(owner, async () => port.write(mcpDef, 'acme', ADD, injected))).kind).toBe('held');
  });

  test('writeAsCaller (1a) writeAsCaller with owner-looking options is judged as the call is', async () => {
    const { port } = await realPort();
    const injected = { asOwner: true, secretAdd: true, judgeSecretAdds: () => true } as never;
    const ferret = callOf(world(), {
      bearer: ADMIN,
      arrival: local(),
      headers: { [SESSION_ID_HEADER]: 'F12', [CLIENT_HEADER]: 'cli' },
    });
    expect((await runInCall(ferret, async () => port.writeAsCaller(mcpDef, 'acme', ADD, injected))).kind).toBe('held');
  });

  test('writeAsCaller a route with no capability and no consultsGrants holds the add of every caller, the host admin’s too', async () => {
    const bare = descriptor({});
    for (const options of [atMachine, relayed, { device: 'phone' }]) {
      const { port } = await realPort();
      const w = world();
      w.enrol('phone');
      w.stepUps.grant(subjectOf('phone'));
      const call = callOf(w, options, bare);
      expect((await runInCall(call, async () => port.writeAsCaller(mcpDef, 'acme', ADD))).kind).toBe('held');
      expect(port.collection(mcpDef).get('acme')).toBeUndefined();
    }
  });

  test('writeAsCaller a warden.yaml add asks the warden capability and the fleet use, not the fleet configure', async () => {
    const wardenDef = defineConfig({
      file: 'warden.yaml',
      schema: z.strictObject({ env: z.record(z.string(), z.string()).default({}) }),
      axis: 'configure',
      loosens: () => [],
    });
    /** One device with these grants and a proof, writing the add to a warden.yaml of its own (a fresh disk each time). */
    const addAs = async (grants: typeof FULL_DEVICE_GRANTS): Promise<string> => {
      const w = world();
      w.enrol('phone', grants);
      w.stepUps.grant(subjectOf('phone'));
      const files = kernelConfig.createConfigFiles({
        home: HOME,
        fs: kernelState.createMemoryHostFs(),
        clock: { nowMs: () => 0, after: () => () => undefined, every: () => () => undefined },
        log: {
          debug() {},
          info() {},
          warn() {},
          error() {},
          child() {
            return this;
          },
        } as never,
        binary: 'fy',
        defs: [{ plugin: 'mcp', def: wardenDef }],
        judge: hostJudge,
      });
      await files.reload();
      const call = callOf(w, { device: 'phone' });
      return (await runInCall(call, async () => files.port('mcp').writeAsCaller(wardenDef, undefined, ADD))).kind;
    };
    // the fleet's configure is not what a warden.yaml add asks: the warden capability's is
    expect(await addAs({ ...FULL_DEVICE_GRANTS, warden: { use: true, configure: false } })).toBe('held');
    expect(
      await addAs({
        ...FULL_DEVICE_GRANTS,
        warden: { use: true, configure: true },
        fleet: { use: true, configure: false },
      }),
    ).toBe('written');
    // and the fleet's use is asked too
    expect(
      await addAs({
        ...FULL_DEVICE_GRANTS,
        warden: { use: true, configure: true },
        fleet: { use: false, configure: true },
      }),
    ).toBe('held');
  });
});

describe('writeAsCaller: the owner answers only for the references its own edit adds, never for a held edit', () => {
  const ferretCall = (w: World = world()): Call =>
    callOf(w, { bearer: ADMIN, arrival: local(), headers: { [SESSION_ID_HEADER]: 'F12', [CLIENT_HEADER]: 'cli' } });
  const HELD_SECRET = 'env:\n  EVIL: ${secret:GITHUB_TOKEN}\n';
  const OWNER_NAMES = (lines: readonly string[]) => lines.filter(line => line.includes('the owner put a secret'));

  test('writeAsCaller C1 an owner patch of one field does not put a ferret’s held secret reference into effect', async () => {
    const { port, lines } = await realPort();
    const held = await runInCall(ferretCall(), async () => port.writeAsCaller(mcpDef, 'acme', HELD_SECRET));
    expect(held.kind).toBe('held');
    expect(port.collection(mcpDef).get('acme')).toBeUndefined();
    const owner = await runInCall(callOf(world(), atMachine), async () =>
      port.writeAsCaller(mcpDef, 'acme', { patch: { note: 'owner renamed it' } }),
    );
    // the owner's one field is in effect (made to the version in effect AND the held text); the ferret's reference is not
    expect(owner.kind).toBe('written');
    expect(port.collection(mcpDef).get('acme')).toEqual({ env: {}, note: 'owner renamed it', limit: 10 });
    expect(JSON.stringify(port.collection(mcpDef).get('acme'))).not.toContain('GITHUB_TOKEN');
    expect(OWNER_NAMES(lines)).toEqual([]);
    // visibly held, with the existing held sentence, and the owner is told another edit still waits
    expect(lines.some(line => line.includes('an edit is held for the owner') && line.includes('GITHUB_TOKEN'))).toBe(
      true,
    );
    expect(port.fileState(mcpDef, 'acme').state).toBe('held');
  });

  test('writeAsCaller C1 an owner who adds its OWN secret over a ferret’s held one still leaves the whole write held', async () => {
    const { port, lines } = await realPort();
    await runInCall(ferretCall(), async () => port.writeAsCaller(mcpDef, 'acme', HELD_SECRET));
    const owner = await runInCall(callOf(world(), atMachine), async () =>
      port.writeAsCaller(mcpDef, 'acme', {
        patch: { note: 'x', env: { EVIL: '${secret:GITHUB_TOKEN}', OWN: '${secret:OWN_TOKEN}' } },
      }),
    );
    expect(owner.kind).toBe('held');
    expect(port.collection(mcpDef).get('acme')).toBeUndefined();
    expect(OWNER_NAMES(lines)).toEqual([]);
  });

  test('writeAsCaller C1 an owner adds its own secret on top of a ferret’s held non-secret edit: credited for its own reference only', async () => {
    const { port, lines } = await realPort();
    const staged = await runInCall(ferretCall(), async () => port.writeAsCaller(mcpDef, 'acme', 'limit: 99\n'));
    expect(staged.kind).toBe('held');
    const owner = await runInCall(callOf(world(), atMachine), async () =>
      port.writeAsCaller(mcpDef, 'acme', { patch: { env: { OWN: '${secret:OWN_TOKEN}' } } }),
    );
    expect(owner.kind).toBe('written');
    // the ferret's `limit: 99` is NOT written into effect with the owner's reference (the V3 hole), and stays held
    expect(port.collection(mcpDef).get('acme')).toEqual({ env: { OWN: '${secret:OWN_TOKEN}' }, limit: 10 });
    expect(port.fileState(mcpDef, 'acme').state).toBe('held');
    expect(OWNER_NAMES(lines)).toEqual([
      'config mcp/acme.yaml: the owner put a secret reference into effect (OWN_TOKEN)',
    ]);
  });

  test('writeAsCaller C1 an owner adds its own secret on a clean file: written, the intended path', async () => {
    const { port, lines } = await realPort();
    const owner = await runInCall(callOf(world(), atMachine), async () =>
      port.writeAsCaller(mcpDef, 'acme', { patch: { env: { OWN: '${secret:OWN_TOKEN}' } } }),
    );
    expect(owner.kind).toBe('written');
    expect(OWNER_NAMES(lines)).toEqual([
      'config mcp/acme.yaml: the owner put a secret reference into effect (OWN_TOKEN)',
    ]);
  });
});

describe('writeAsCaller held-edit patch: one field patched beside a held edit never puts the held edit into effect', () => {
  const ferretCall = (w: World = world()): Call =>
    callOf(w, { bearer: ADMIN, arrival: local(), headers: { [SESSION_ID_HEADER]: 'F12', [CLIENT_HEADER]: 'cli' } });
  const ownerLines = (lines: readonly string[]) => lines.filter(line => line.includes('the owner put a secret'));
  const stagedLimit = async () => {
    const world0 = await realPort();
    const staged = await runInCall(ferretCall(), async () => world0.port.writeAsCaller(mcpDef, 'acme', 'limit: 99\n'));
    expect(staged.kind).toBe('held');
    return world0;
  };

  test('held-edit patch: the host admin patching another field leaves a ferret’s held `limit: 99` out of effect', async () => {
    const { port } = await stagedLimit();
    const owner = await runInCall(callOf(world(), atMachine), async () =>
      port.writeAsCaller(mcpDef, 'acme', { patch: { note: 'owner note' } }),
    );
    expect(owner.kind).toBe('written');
    expect(port.collection(mcpDef).get('acme')).toEqual({ env: {}, note: 'owner note', limit: 10 });
    expect(port.fileState(mcpDef, 'acme').state).toBe('held');
  });

  test('held-edit patch: the host admin changing the very field a ferret staged makes its own value the value in both versions', async () => {
    const { port } = await stagedLimit();
    const owner = await runInCall(callOf(world(), atMachine), async () =>
      port.writeAsCaller(mcpDef, 'acme', { patch: { limit: 20 } }),
    );
    // 20 is the owner's own number; 99 is not, and nothing stays held
    expect(owner.kind).toBe('written');
    expect(port.collection(mcpDef).get('acme')).toMatchObject({ limit: 20 });
    expect(port.fileState(mcpDef, 'acme').state).toBe('valid');
  });

  test('held-edit patch: a relayed admin token is remote, so its loosening waits WITH the held edit and nothing changes', async () => {
    const { port } = await stagedLimit();
    const remote = await runInCall(callOf(world(), relayed), async () =>
      port.writeAsCaller(mcpDef, 'acme', { patch: { limit: 20 } }),
    );
    expect(remote.kind).toBe('held');
    expect(port.collection(mcpDef).get('acme')).toBeUndefined();
  });

  test('held-edit patch: a governed device with only the unlock is held for a loosening, and its tightening is in effect', async () => {
    const w = world();
    w.enrol('phone');
    const { port } = await stagedLimit();
    const loosening = await runInCall(callOf(w, { device: 'phone' }), async () =>
      port.writeAsCaller(mcpDef, 'acme', { patch: { limit: 30 } }),
    );
    expect(loosening.kind).toBe('held');
    const tightening = await runInCall(callOf(w, { device: 'phone' }), async () =>
      port.writeAsCaller(mcpDef, 'acme', { patch: { note: 'device note' } }),
    );
    expect(tightening.kind).toBe('written');
    expect(port.collection(mcpDef).get('acme')).toMatchObject({ note: 'device note', limit: 10 });
  });

  test('held-edit patch: a ferret’s own patch beside its held edit puts its non-loosening field in effect and nothing loosening', async () => {
    const { port } = await stagedLimit();
    const note = await runInCall(ferretCall(), async () =>
      port.writeAsCaller(mcpDef, 'acme', { patch: { note: 'f' } }),
    );
    expect(note.kind).toBe('written');
    expect(port.collection(mcpDef).get('acme')).toMatchObject({ note: 'f', limit: 10 });
    const raise = await runInCall(ferretCall(), async () =>
      port.writeAsCaller(mcpDef, 'acme', { patch: { limit: 50 } }),
    );
    expect(raise.kind).toBe('held');
    expect(port.collection(mcpDef).get('acme')).toMatchObject({ limit: 10 });
  });

  test('held-edit patch: a plain patch by a ferret beside its own held edit is judged alone: its non-loosening field is in effect, the held edit stays held, a loosening patch is itself held', async () => {
    const { port } = await stagedLimit();
    const plain = await runInCall(ferretCall(), async () => port.write(mcpDef, 'acme', { patch: { note: 'f' } }));
    expect(plain.kind).toBe('written');
    expect(port.collection(mcpDef).get('acme')).toEqual({ env: {}, note: 'f', limit: 10 });
    expect(port.fileState(mcpDef, 'acme').state).toBe('held');
    const raise = await runInCall(ferretCall(), async () => port.write(mcpDef, 'acme', { patch: { limit: 50 } }));
    expect(raise.kind).toBe('held');
    expect(port.collection(mcpDef).get('acme')).toMatchObject({ limit: 10 });
    expect(port.fileState(mcpDef, 'acme').state).toBe('held');
  });

  test('held-edit patch: V1 and V2 secret cases stay held: the host admin’s one field is in effect, the reference never, no owner line', async () => {
    const { port, lines } = await realPort();
    const staged = await runInCall(ferretCall(), async () =>
      port.writeAsCaller(mcpDef, 'acme', 'limit: 99\nenv:\n  EVIL: ${secret:GITHUB_TOKEN}\n'),
    );
    expect(staged.kind).toBe('held');
    const one = await runInCall(callOf(world(), atMachine), async () =>
      port.writeAsCaller(mcpDef, 'acme', { patch: { note: 'n' } }),
    );
    expect(one.kind).toBe('written');
    expect(port.collection(mcpDef).get('acme')).toEqual({ env: {}, note: 'n', limit: 10 });
    const again = await runInCall(callOf(world(), atMachine), async () =>
      port.writeAsCaller(mcpDef, 'acme', {
        patch: { env: { EVIL: '${secret:GITHUB_TOKEN}', MINE: '${secret:OWN_TOKEN}' } },
      }),
    );
    expect(again.kind).toBe('held');
    expect(JSON.stringify(port.collection(mcpDef).get('acme'))).not.toContain('secret:');
    expect(ownerLines(lines)).toEqual([]);
  });

  test('held-edit patch: a governed device with a proof adds its own secret beside a held loosening, the proof spent once', async () => {
    const w = world();
    w.enrol('phone');
    w.stepUps.grant(subjectOf('phone'));
    const { port } = await stagedLimit();
    const call = callOf(w, { device: 'phone' });
    const first = await runInCall(call, async () =>
      port.writeAsCaller(mcpDef, 'acme', { patch: { env: { OWN: '${secret:OWN_TOKEN}' } } }),
    );
    expect(first.kind).toBe('written');
    expect(port.collection(mcpDef).get('acme')).toEqual({ env: { OWN: '${secret:OWN_TOKEN}' }, limit: 10 });
    const second = await runInCall(call, async () =>
      port.writeAsCaller(mcpDef, 'acme', {
        patch: { env: { OWN: '${secret:OWN_TOKEN}', TWO: '${secret:TWO_TOKEN}' } },
      }),
    );
    expect(second.kind).toBe('held');
    expect(JSON.stringify(port.collection(mcpDef).get('acme'))).not.toContain('TWO_TOKEN');
  });
});
