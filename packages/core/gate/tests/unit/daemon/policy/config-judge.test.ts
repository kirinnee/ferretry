import { describe, expect, test } from 'bun:test';
import type { Actor, CallStanding, ConfigWriteJudgement } from '@ferretry/kernel/contract';
import * as contract from '../../../../contract/index.ts';
import { claimOwnerOnly, FULL_DEVICE_GRANTS, type OwnerOnlyCall, remedyRef } from '../../../../contract/index.ts';
import { CLIENT_HEADER, SESSION_ID_HEADER } from '../../../../daemon/lib/api/admission.ts';
import { judgeLooseningWrite } from '../../../../daemon/lib/policy/config-judge.ts';
import {
  ADMIN,
  admit,
  carried,
  descriptor,
  FERRET,
  FERRET_TOKEN,
  local,
  WARDEN,
  type World,
  world,
} from '../support.ts';

/** A route that asks no capability of its own but reads the grants, which is where a plugin's config write can run. */
const route = descriptor({ consultsGrants: true });
const subjectOf = (id: string) => ({ deviceId: id, appSession: `s-${id}` });
const atMachine = { bearer: ADMIN, arrival: local(), headers: { [CLIENT_HEADER]: 'cli' } };

function standingOf(w: World, options: Parameters<typeof admit>[2] = {}): CallStanding {
  const { decision, outcome } = admit(w, route, options);
  if (decision.outcome !== 'admitted') throw new Error(`expected admitted, got ${outcome}`);
  return decision.standing;
}

const judgement = (actor: Actor, standing: CallStanding | undefined, path = 'fleet.yaml'): ConfigWriteJudgement => ({
  plugin: 'fleet',
  path,
  removal: false,
  sentences: ['the budget rose'],
  actor,
  ...(standing === undefined ? {} : { standing }),
});

/** The kernel's side of the contract: a judge that throws holds the edit. */
const kernelsReading = (input: ConfigWriteJudgement): boolean => {
  try {
    return judgeLooseningWrite(input) === 'apply';
  } catch {
    return false;
  }
};

describe('G131 the owner at the machine puts a plugin’s own loosening into effect', () => {
  test('G131 the admin token that arrived on the host applies it, for the fleet files and for warden.yaml', () => {
    const w = world();
    const standing = standingOf(w, atMachine);
    expect(judgeLooseningWrite(judgement('owner-tools', standing))).toBe('apply');
    expect(judgeLooseningWrite(judgement('owner-tools', standing, 'warden.yaml'))).toBe('apply');
  });

  test('G131 the admin token relayed from off the host is governed, so it holds without a proof', () => {
    const w = world();
    const standing = standingOf(w, { bearer: ADMIN, arrival: carried(), headers: { [CLIENT_HEADER]: 'cli' } });
    expect(judgeLooseningWrite(judgement('owner-tools', standing))).toBe('hold');
  });
});

describe('G131 G126 a remote device loosens only as today’s config route lets it', () => {
  test('G131 a device that holds only the unlock, not a passkey proved for the act, holds', () => {
    const w = world();
    w.enrol('phone');
    expect(judgeLooseningWrite(judgement('owner-viewer', standingOf(w, { device: 'phone' })))).toBe('hold');
  });

  test('G131 G126 a device with the configure grant and a fresh passkey applies, and one proof buys one loosening', () => {
    const w = world();
    w.enrol('phone');
    w.stepUps.grant(subjectOf('phone'));
    const standing = standingOf(w, { device: 'phone' });
    expect(judgeLooseningWrite(judgement('owner-viewer', standing))).toBe('apply');
    // The proof is spent: the same call cannot loosen a second time, nor can a later call without a new proof.
    expect(judgeLooseningWrite(judgement('owner-viewer', standing))).toBe('hold');
    expect(judgeLooseningWrite(judgement('owner-viewer', standingOf(w, { device: 'phone' })))).toBe('hold');
    w.stepUps.grant(subjectOf('phone'));
    expect(judgeLooseningWrite(judgement('owner-viewer', standingOf(w, { device: 'phone' })))).toBe('apply');
  });

  test('G131 a device without the file’s configure grant holds even with a fresh passkey', () => {
    const w = world();
    w.enrol('phone', { ...FULL_DEVICE_GRANTS, fleet: { use: true, configure: false } });
    w.stepUps.grant(subjectOf('phone'));
    expect(judgeLooseningWrite(judgement('owner-viewer', standingOf(w, { device: 'phone' })))).toBe('hold');
  });

  test('G131 warden.yaml asks the warden capability, not the fleet’s', () => {
    const w = world();
    w.enrol('phone', { ...FULL_DEVICE_GRANTS, warden: { use: true, configure: false } });
    w.stepUps.grant(subjectOf('phone'));
    expect(judgeLooseningWrite(judgement('owner-viewer', standingOf(w, { device: 'phone' }), 'warden.yaml'))).toBe(
      'hold',
    );
    w.stepUps.grant(subjectOf('phone'));
    expect(judgeLooseningWrite(judgement('owner-viewer', standingOf(w, { device: 'phone' })))).toBe('apply');
  });

  test('G131 a device the owner kept off the fleet’s use holds', () => {
    const w = world();
    w.enrol('phone', { ...FULL_DEVICE_GRANTS, fleet: { use: false, configure: true } });
    w.stepUps.grant(subjectOf('phone'));
    expect(judgeLooseningWrite(judgement('owner-viewer', standingOf(w, { device: 'phone' })))).toBe('hold');
  });
});

describe('G131 a ferret’s write, a warden’s and a job’s are always held', () => {
  test('G131 a ferret holds, and so does the admin token naming a ferret', () => {
    const w = world();
    const ferret = standingOf(w, { bearer: FERRET_TOKEN, arrival: local(true) });
    expect(judgeLooseningWrite(judgement('ferret', ferret))).toBe('hold');
    // Even a judgement that mislabels the actor cannot lift what the credential says.
    expect(judgeLooseningWrite(judgement('owner-tools', ferret))).toBe('hold');
    const named = standingOf(w, { bearer: ADMIN, arrival: local(), headers: { [SESSION_ID_HEADER]: FERRET } });
    expect(judgeLooseningWrite(judgement('owner-tools', named))).toBe('hold');
    expect(judgeLooseningWrite(judgement('ferret', standingOf(w, atMachine)))).toBe('hold');
  });

  test('G131 a warden holds, by actor and by its own credential', () => {
    const w = world();
    const { decision } = admit(w, descriptor({ consultsGrants: true, minimum: 'authenticated' }), {
      bearer: WARDEN,
      arrival: local(),
    });
    if (decision.outcome !== 'admitted') throw new Error('expected the warden admitted');
    const warden = decision.standing;
    expect(judgeLooseningWrite(judgement('warden', warden))).toBe('hold');
    expect(judgeLooseningWrite(judgement('owner-tools', warden))).toBe('hold');
    const owner = standingOf(w, atMachine);
    const remedy = { ...owner, wardenRemedy: { remedy: remedyRef('leave') } } as unknown as CallStanding;
    expect(judgeLooseningWrite(judgement('owner-tools', remedy))).toBe('hold');
  });

  test('G131 no standing (no call in progress, a job) holds, whoever the actor claims to be', () => {
    for (const actor of ['ferret', 'warden', 'owner-viewer', 'owner-tools', 'owner-input'] as const)
      expect(judgeLooseningWrite(judgement(actor, undefined))).toBe('hold');
  });

  test('G131 a standing with no grant standing, or an empty one, is undetermined and holds', () => {
    const w = world();
    const { decision } = admit(w, descriptor(), atMachine);
    if (decision.outcome !== 'admitted') throw new Error('expected admitted');
    expect(decision.standing.governance).toBeUndefined();
    expect(judgeLooseningWrite(judgement('owner-tools', decision.standing))).toBe('hold');
    expect(judgeLooseningWrite(judgement('owner-tools', {} as CallStanding))).toBe('hold');
  });

  test('G131 a judge that throws holds: the grant check failing never reads as apply', () => {
    const w = world();
    const owner = standingOf(w, atMachine);
    const failing = {
      ...owner,
      governance: {
        governed: false,
        decide: () => {
          throw new Error('the grants could not be read');
        },
      },
    } as unknown as CallStanding;
    expect(() => judgeLooseningWrite(judgement('owner-tools', failing))).toThrow();
    expect(kernelsReading(judgement('owner-tools', failing))).toBe(false);
  });

  test('G131 a proof that cannot be claimed is not taken: a standing without its claim holds', () => {
    const w = world();
    w.enrol('phone');
    w.stepUps.grant(subjectOf('phone'));
    const device = standingOf(w, { device: 'phone' });
    const { claimFreshStepUp: _claim, ...unclaimable } = device;
    expect(judgeLooseningWrite(judgement('owner-viewer', unclaimable as CallStanding))).toBe('hold');
    // Nothing was taken: the same proof still serves a standing that can claim it.
    expect(judgeLooseningWrite(judgement('owner-viewer', device))).toBe('apply');
  });
});

describe('G131 the built admission asks this rule', () => {
  test('G131 Admission.judgeConfigWrite is the judge: the owner at the machine applies, a ferret holds', () => {
    const w = world();
    expect(w.gate.judgeConfigWrite(judgement('owner-tools', standingOf(w, atMachine)))).toBe('apply');
    expect(w.gate.judgeConfigWrite(judgement('ferret', standingOf(w, atMachine)))).toBe('hold');
  });
});

/** The kernel builds a call as a COPY of the standing (`{ request, params, ...standing }`), so a route's `call` is not the judge's standing. */
const callOf = (standing: CallStanding): OwnerOnlyCall =>
  ({ request: {}, params: new Map(), ...standing }) as unknown as OwnerOnlyCall;

/** Counts the fresh proofs actually taken from the registry (a claim answered `true`). */
function countTaken(w: World): () => number {
  let taken = 0;
  const real = w.stepUps.claimFresh;
  Object.assign(w.stepUps, {
    claimFresh: (...args: Parameters<typeof real>) => {
      const claimed = real(...args);
      if (claimed) taken += 1;
      return claimed;
    },
  });
  return () => taken;
}

/** A paired device holding ONE fresh proof; every standing taken before a request runs snapshots it as fresh. */
function deviceWithOneProof() {
  const w = world();
  w.enrol('phone');
  w.stepUps.grant(subjectOf('phone'));
  const taken = countTaken(w);
  const standings = (count: number): CallStanding[] => {
    const all = Array.from({ length: count }, () => standingOf(w, { device: 'phone' }));
    for (const standing of all) expect(standing.presentation?.freshStepUp).toBe(true);
    return all;
  };
  return { w, taken, standings };
}

const applied = (answer: 'apply' | 'hold'): boolean => answer === 'apply';
const admitted = (answer: ReturnType<typeof claimOwnerOnly>): boolean => answer === undefined;

describe('G22 G25 G131 one proof cannot carry a second act', () => {
  test('G22 G131 a loosening write and the autoInstall-on act admitted on one proof: the claim goes first, one applies', () => {
    const { taken, standings } = deviceWithOneProof();
    const [update, config] = standings(2) as [CallStanding, CallStanding];
    const act = claimOwnerOnly(callOf(update), 'turn on automatic updates');
    const loosening = judgeLooseningWrite(judgement('owner-viewer', config));
    expect([admitted(act), applied(loosening)]).toEqual([true, false]);
    expect(taken()).toBe(1);
  });

  test('G22 G131 a loosening write and the autoInstall-on act admitted on one proof: the judge goes first, one applies', () => {
    const { taken, standings } = deviceWithOneProof();
    const [update, config] = standings(2) as [CallStanding, CallStanding];
    const loosening = judgeLooseningWrite(judgement('owner-viewer', config));
    const act = claimOwnerOnly(callOf(update), 'turn on automatic updates');
    expect([applied(loosening), admitted(act)]).toEqual([true, false]);
    expect(act?.status).toBe(403);
    expect(JSON.parse(act?.body ?? '{}')).toMatchObject({ demand: { capability: 'fleet', axis: 'configure' } });
    expect(taken()).toBe(1);
  });

  test('G22 G25 G131 two owner-only acts (a proxy test and an update) and a loosening on one proof: exactly one of the three', () => {
    const { taken, standings } = deviceWithOneProof();
    const [proxyTest, update, config] = standings(3) as [CallStanding, CallStanding, CallStanding];
    const results = [
      admitted(claimOwnerOnly(callOf(proxyTest), 'test the browser proxy')),
      admitted(claimOwnerOnly(callOf(update), 'update this machine')),
      applied(judgeLooseningWrite(judgement('owner-viewer', config))),
    ];
    expect(results).toEqual([true, false, false]);
    expect(taken()).toBe(1);
  });

  test('G22 G131 the autoInstall-on PATCH with a fresh proof still applies on its own claim, and takes the proof exactly once', () => {
    const { w, taken, standings } = deviceWithOneProof();
    const [update] = standings(1) as [CallStanding];
    expect(claimOwnerOnly(callOf(update), 'turn on automatic updates')).toBeUndefined();
    // The act's own write: the judge reads THIS call's standing, whose proof the act already claimed.
    expect(judgeLooseningWrite(judgement('owner-viewer', update))).toBe('apply');
    expect(taken()).toBe(1);
    // That claim buys one loosening, not two, and no later call rides on it.
    expect(judgeLooseningWrite(judgement('owner-viewer', update))).toBe('hold');
    expect(judgeLooseningWrite(judgement('owner-viewer', standingOf(w, { device: 'phone' })))).toBe('hold');
    expect(taken()).toBe(1);
  });

  test('G131 a governed loosening write with a fresh proof and no prior claim applies and takes the proof', () => {
    const { w, taken, standings } = deviceWithOneProof();
    const [config] = standings(1) as [CallStanding];
    expect(judgeLooseningWrite(judgement('owner-viewer', config))).toBe('apply');
    expect(taken()).toBe(1);
    expect(judgeLooseningWrite(judgement('owner-viewer', config))).toBe('hold');
    expect(claimOwnerOnly(callOf(standingOf(w, { device: 'phone' })), 'update this machine')?.status).toBe(403);
    expect(taken()).toBe(1);
  });

  test('G131 a claim by one standing is not another standing’s: a second PATCH on the same proof is held', () => {
    const { taken, standings } = deviceWithOneProof();
    const [first, second] = standings(2) as [CallStanding, CallStanding];
    expect(claimOwnerOnly(callOf(first), 'turn on automatic updates')).toBeUndefined();
    expect(claimOwnerOnly(callOf(second), 'turn on automatic updates')?.status).toBe(403);
    expect(judgeLooseningWrite(judgement('owner-viewer', second))).toBe('hold');
    expect(taken()).toBe(1);
  });

  test('G131 the owner at the machine claims nothing, and a ferret is refused before any claim', () => {
    const w = world();
    const taken = countTaken(w);
    const owner = standingOf(w, atMachine);
    expect(claimOwnerOnly(callOf(owner), 'update this machine')).toBeUndefined();
    expect(judgeLooseningWrite(judgement('owner-tools', owner))).toBe('apply');
    const ferret = standingOf(w, { bearer: FERRET_TOKEN, arrival: local(true) });
    expect(() => claimOwnerOnly(callOf(ferret), 'update this machine')).toThrow();
    expect(judgeLooseningWrite(judgement('ferret', ferret))).toBe('hold');
    expect(taken()).toBe(0);
  });

  test('G131 the relayed admin token is governed: with no device behind it nothing can be claimed, so it holds and is refused', () => {
    const w = world();
    const taken = countTaken(w);
    const relayed = standingOf(w, { bearer: ADMIN, arrival: carried(), headers: { [CLIENT_HEADER]: 'cli' } });
    expect(judgeLooseningWrite(judgement('owner-tools', relayed))).toBe('hold');
    expect(claimOwnerOnly(callOf(relayed), 'update this machine')?.status).toBe(403);
    expect(taken()).toBe(0);
  });

  test('G131 one proof buys one loosening whichever object carries it: a { ...standing } copy gets no second apply', () => {
    const { w, taken, standings } = deviceWithOneProof();
    const [standing] = standings(1) as [CallStanding];
    expect(judgeLooseningWrite(judgement('owner-viewer', standing))).toBe('apply');
    expect(judgeLooseningWrite(judgement('owner-viewer', { ...standing }))).toBe('hold');
    expect(judgeLooseningWrite(judgement('owner-viewer', { ...standing, request: {} } as CallStanding))).toBe('hold');
    expect(taken()).toBe(1);
    // A new proof on a new admission is a new claim function: it is not shut out by the first one's mark.
    w.stepUps.grant(subjectOf('phone'));
    expect(judgeLooseningWrite(judgement('owner-viewer', standingOf(w, { device: 'phone' })))).toBe('apply');
  });

  test('G22 G131 a proof an owner-only act claimed buys one loosening on a { ...standing } copy too, not two', () => {
    const { taken, standings } = deviceWithOneProof();
    const [update] = standings(1) as [CallStanding];
    expect(claimOwnerOnly(callOf(update), 'turn on automatic updates')).toBeUndefined();
    expect(judgeLooseningWrite(judgement('owner-viewer', { ...update }))).toBe('apply');
    expect(judgeLooseningWrite(judgement('owner-viewer', update))).toBe('hold');
    expect(judgeLooseningWrite(judgement('owner-viewer', { ...update }))).toBe('hold');
    expect(taken()).toBe(1);
  });

  test('G131 the marker is Gate-private: no contract export names it', () => {
    expect(Object.keys(contract).filter(name => /claimed|markProof|proofClaimed/iu.test(name))).toEqual([]);
  });
});
