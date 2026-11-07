import { describe, expect, test } from 'bun:test';
import type { Actor, CallStanding, ConfigWriteJudgement } from '@ferretry/kernel/contract';
import { FULL_DEVICE_GRANTS, remedyRef } from '../../../../contract/index.ts';
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

  test('G131 a proof that cannot be spent is not taken: a standing without its spend holds', () => {
    const w = world();
    w.enrol('phone');
    w.stepUps.grant(subjectOf('phone'));
    const device = standingOf(w, { device: 'phone' });
    const { spendFreshStepUp: _spend, ...unspendable } = device;
    expect(judgeLooseningWrite(judgement('owner-viewer', unspendable as CallStanding))).toBe('hold');
  });
});

describe('G131 the built admission asks this rule', () => {
  test('G131 Admission.judgeConfigWrite is the judge: the owner at the machine applies, a ferret holds', () => {
    const w = world();
    expect(w.gate.judgeConfigWrite(judgement('owner-tools', standingOf(w, atMachine)))).toBe('apply');
    expect(w.gate.judgeConfigWrite(judgement('ferret', standingOf(w, atMachine)))).toBe('hold');
  });
});
