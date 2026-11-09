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
import { StandInAdmission } from '../../../../contract/testing/index.ts';
import { CLIENT_HEADER } from '../../../../daemon/lib/api/admission.ts';
import { judgeLooseningWrite, judgeOwnerSecretAdd } from '../../../../daemon/lib/policy/config-judge.ts';
import { ADMIN, admit, carried, descriptor, FERRET_TOKEN, local, type World, world } from '../support.ts';

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
const atMachine = { bearer: ADMIN, arrival: local(), headers: { [CLIENT_HEADER]: 'cli' } };
const relayed = { bearer: ADMIN, arrival: carried(), headers: { [CLIENT_HEADER]: 'cli' } };

interface Call {
  readonly actor: Actor;
  readonly standing?: CallStanding;
}

function callOf(w: World, options: Parameters<typeof admit>[2] = {}): Call {
  const { decision, outcome } = admit(w, route0, options);
  if (decision.outcome !== 'admitted') throw new Error(`expected admitted, got ${outcome}`);
  return { actor: decision.actor, standing: decision.standing };
}

/** The host's wiring, as `host.ts` makes it: the ambient call at the moment the writer asks, and nothing else. */
const hostJudge = (input: Omit<ConfigWriteJudgement, 'actor' | 'standing'>): boolean => {
  try {
    return judgeLooseningWrite({ ...input, actor: currentActor(), standing: currentStanding() }) === 'apply';
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

  test('writeAsCaller a governed device that holds the configure capability and is unlocked: in effect, no proof spent', async () => {
    const w = world();
    w.enrol('phone');
    const result = await writeAs(callOf(w, { device: 'phone' }));
    expect(result.kind).toBe('written');
    expect(result.inEffect).toMatchObject({ env: { TOKEN: '${secret:ACME_TOKEN}' } });
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

describe('writeAsCaller: the owner question claims no step-up proof', () => {
  test('writeAsCaller judgeOwnerSecretAdd never spends the device’s fresh proof: a loosening can still take it', () => {
    const w = world();
    w.enrol('phone');
    w.stepUps.grant({ deviceId: 'phone', appSession: 's-phone' });
    const standing = callOf(w, { device: 'phone' });
    const ask: ConfigWriteJudgement = {
      plugin: 'mcp',
      path: 'mcp/acme.yaml',
      removal: false,
      sentences: ['names the secret ACME_TOKEN, which only the owner may add to a configuration'],
      actor: standing.actor,
      standing: standing.standing,
      secretAdd: true,
    };
    expect(judgeOwnerSecretAdd(ask)).toBe('apply');
    expect(judgeOwnerSecretAdd(ask)).toBe('apply');
    expect(judgeLooseningWrite(ask)).toBe('apply');
    // the loosening that is not a secret add still takes the one proof
    const plain = { ...ask, secretAdd: undefined, sentences: ['raises the limit'] } as ConfigWriteJudgement;
    expect(judgeLooseningWrite(plain)).toBe('apply');
    expect(judgeLooseningWrite(plain)).toBe('hold');
  });

  test('writeAsCaller a plain judgement without secretAdd for a device with only the unlock still holds', () => {
    const w = world();
    w.enrol('phone');
    const standing = callOf(w, { device: 'phone' });
    const ask: ConfigWriteJudgement = {
      plugin: 'mcp',
      path: 'mcp/acme.yaml',
      removal: false,
      sentences: ['raises the limit'],
      actor: standing.actor,
      standing: standing.standing,
    };
    expect(judgeLooseningWrite(ask)).toBe('hold');
    expect(judgeLooseningWrite({ ...ask, secretAdd: true })).toBe('apply');
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

  test('writeAsCaller twin: an unlocked device with the capability is in effect, one without it is held', async () => {
    const w = world();
    w.enrol('phone');
    expect((await twinAs(callOf(w, { device: 'phone' }).standing)).kind).toBe('written');
    const v = world();
    v.enrol('phone', { ...FULL_DEVICE_GRANTS, fleet: { use: true, configure: false } });
    const held = await twinAs(callOf(v, { device: 'phone' }).standing);
    expect(held.kind).toBe('held');
    expect(held.inEffect).toBeUndefined();
  });
});
