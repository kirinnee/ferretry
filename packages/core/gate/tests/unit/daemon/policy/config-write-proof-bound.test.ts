// K1 (kcw-review2): a standing claims ONLY a passkey proof that already existed when its call was admitted, once. The
// real config writer, Gate's real judge and real standings: no stand-in for the question being asked. Fake values only.
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { type Actor, type CallStanding, defineConfig } from '@ferretry/kernel/contract';
import {
  config as kernelConfig,
  currentActor,
  currentStanding,
  runInCall,
  state as kernelState,
} from '@ferretry/kernel/host';
import { holder } from '../../../../contract/testing/index.ts';
import { admit, descriptor, later, type World, world } from '../support.ts';

const route = descriptor({ consultsGrants: true });

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
const subjectOf = (id: string) => ({ deviceId: id, appSession: `s-${id}` });
const ADD = 'env:\n  T: ${secret:ACME_TOKEN}\n';
const LOOSEN = 'limit: 99\n';
const HOUR = 60 * 60 * 1000;

interface Call {
  readonly actor: Actor;
  readonly standing?: CallStanding;
}
const mintedBy = new WeakMap<object, World>();

function callOf(w: World, options: Parameters<typeof admit>[2] = {}): Call {
  const { decision, outcome } = admit(w, route, options);
  if (decision.outcome !== 'admitted') throw new Error(`expected admitted, got ${outcome}`);
  mintedBy.set(decision.standing, w);
  return { actor: decision.actor, standing: decision.standing };
}

/** A device enrolled and holding one fresh passkey proof BEFORE its call is admitted. */
function provedDevice(w: World): Call {
  w.enrol('phone');
  w.stepUps.grant(subjectOf('phone'));
  return callOf(w, { device: 'phone' });
}

async function writer() {
  const cancel = () => undefined;
  const log = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => log,
  };
  const files = kernelConfig.createConfigFiles({
    home: '/home/fy',
    fs: kernelState.createMemoryHostFs(),
    clock: { nowMs: () => 0, after: () => cancel, every: () => cancel },
    log: log as never,
    binary: 'fy',
    defs: [{ plugin: 'mcp', def: mcpDef }],
    judge: input => {
      try {
        const standing = currentStanding();
        const gate = standing === undefined ? undefined : mintedBy.get(standing);
        return gate?.gate.judgeConfigWrite({ ...input, actor: currentActor(), standing }) === 'apply';
      } catch {
        return false;
      }
    },
  });
  await files.reload();
  return files.port('mcp');
}
type Port = Awaited<ReturnType<typeof writer>>;

/** Work the call spawns: started inside the call's scope, it writes only once released, after the request is over. */
async function spawnWrite(
  call: Call,
  port: Port,
  write: (port: Port) => Promise<{ kind: string }>,
): Promise<{ release: () => void; outcome: Promise<{ kind: string }> }> {
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let outcome: Promise<{ kind: string }> = Promise.resolve({ kind: 'never started' });
  await runInCall(call, async () => {
    outcome = (async () => {
      await gate;
      return await write(port);
    })();
  });
  return { release, outcome };
}

const secretAdd = (port: Port) => port.writeAsCaller(mcpDef, 'late', ADD);
const plainLoosening = (port: Port) => port.write(mcpDef, 'late', LOOSEN);

describe('K1: a call claims only a passkey proof that existed when it was admitted', () => {
  test('K1 a proof made before admission still works for a live request: writeAsCaller secret add is written', async () => {
    const w = world();
    const call = provedDevice(w);
    const outcome = await runInCall(call, async () => (await writer()).writeAsCaller(mcpDef, 'acme', ADD));
    expect(outcome.kind).toBe('written');
    expect(w.stepUps.freshlyHeld(subjectOf('phone'))).toBe(false);
  });

  test('K1 a proof made before admission still works for a live request: plain-write loosening is written', async () => {
    const w = world();
    const call = provedDevice(w);
    const outcome = await runInCall(call, async () => (await writer()).write(mcpDef, 'acme', LOOSEN));
    expect(outcome.kind).toBe('written');
    expect(w.stepUps.freshlyHeld(subjectOf('phone'))).toBe(false);
  });

  test('K1 work the call spawns may still use the proof it was admitted with, once', async () => {
    const w = world();
    const call = provedDevice(w);
    const port = await writer();
    const first = await spawnWrite(call, port, secretAdd);
    const second = await spawnWrite(call, port, p => p.writeAsCaller(mcpDef, 'later', ADD));
    first.release();
    expect((await first.outcome).kind).toBe('written');
    second.release();
    expect((await second.outcome).kind).toBe('held');
  });

  describe.each([
    ['writeAsCaller secret add', secretAdd],
    ['plain-write loosening', plainLoosening],
  ] as const)('K1 %s from work the call spawned', (_title, write) => {
    test('K1 the admission proof used elsewhere, then a NEW proof for another act: held, the new proof left in place', async () => {
      const w = world();
      const call = provedDevice(w);
      expect(w.stepUps.claimFresh(subjectOf('phone'))).toBe(true); // the act the call's own proof was for
      const spawned = await spawnWrite(call, await writer(), write);
      w.now = later(w.now, 60 * 1000);
      w.stepUps.grant(subjectOf('phone')); // the owner proves a passkey for some OTHER act
      spawned.release();
      expect((await spawned.outcome).kind).toBe('held');
      expect(w.stepUps.freshlyHeld(subjectOf('phone'))).toBe(true);
      expect(w.stepUps.claimFresh(subjectOf('phone'))).toBe(true); // still there for the act it was given for
    });

    test('K1 the proof made after admission replaces the admission proof: held, the new proof left in place', async () => {
      const w = world();
      const call = provedDevice(w);
      const spawned = await spawnWrite(call, await writer(), write);
      w.now = later(w.now, 60 * 1000);
      w.stepUps.grant(subjectOf('phone'));
      spawned.release();
      expect((await spawned.outcome).kind).toBe('held');
      expect(w.stepUps.freshlyHeld(subjectOf('phone'))).toBe(true);
    });

    test('K1 after the unlock expired and the owner unlocked again with a new proof: still held, proof left in place', async () => {
      const w = world();
      const call = provedDevice(w);
      expect(w.stepUps.claimFresh(subjectOf('phone'))).toBe(true);
      const spawned = await spawnWrite(call, await writer(), write);
      w.now = later(w.now, 2 * HOUR); // the unlock expired
      w.devices.unlock(holder('phone'), later(w.now, HOUR)); // and the owner unlocked again
      w.stepUps.grant(subjectOf('phone')); // proving a passkey for some OTHER act
      spawned.release();
      expect((await spawned.outcome).kind).toBe('held');
      expect(w.stepUps.freshlyHeld(subjectOf('phone'))).toBe(true);
    });
  });
});
