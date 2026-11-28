import { describe, expect, test } from 'bun:test';
import type { CallStanding, RootWriteJudgement } from '@ferretry/kernel/contract';
import { CAPABILITIES, FULL_DEVICE_GRANTS } from '../../../../contract/index.ts';
import { judgeRootWrite } from '../../../../daemon/lib/policy/root-write.ts';
import { ADMIN, admit, descriptor, local, world } from '../support.ts';

const ask = (standing?: CallStanding): RootWriteJudgement => ({
  plugin: 'projects',
  root: 'imports',
  capability: CAPABILITIES.filesystem,
  actor: 'owner-viewer',
  standing,
});
const refusal = { allowed: false, refusal: 'not-granted' } as const;

describe('SEC-K1 write-pin caller authority', () => {
  test('missing caller or missing grant standing refuses', () => {
    expect(judgeRootWrite(ask())).toBe(false);
    expect(judgeRootWrite(ask({}))).toBe(false);
  });

  test('an authenticated ungoverned standing permits without a governed grant decision', () => {
    expect(
      judgeRootWrite(
        ask({
          governance: {
            governed: false,
            decide: () => {
              throw new Error('not asked');
            },
          },
        }),
      ),
    ).toBe(true);
  });

  test('a governed caller needs the declaration’s configure grant; the check only narrows this admitted act', () => {
    const seen: unknown[] = [];
    const standing: CallStanding = {
      governance: {
        governed: true,
        decide: demand => {
          seen.push(demand);
          return demand.capability === CAPABILITIES.filesystem && demand.axis === 'configure'
            ? { allowed: true, refusal: 'granted' }
            : refusal;
        },
      },
    };
    expect(judgeRootWrite(ask(standing))).toBe(true);
    expect(seen).toEqual([{ capability: CAPABILITIES.filesystem, axis: 'configure', narrowing: true }]);
    expect(judgeRootWrite({ ...ask(standing), capability: CAPABILITIES.fleet })).toBe(false);
    expect(judgeRootWrite(ask({ governance: { governed: true, decide: () => refusal } }))).toBe(false);
  });

  test('an undetermined throwing grant provider refuses', () => {
    expect(
      judgeRootWrite(
        ask({
          governance: {
            governed: true,
            decide: () => {
              throw new Error('unavailable');
            },
          },
        }),
      ),
    ).toBe(false);
  });

  test('GateAdmission uses live standing, so a device losing its configure grant cannot keep a previous yes', () => {
    const w = world();
    w.enrol('phone');
    const route = descriptor({ capability: { capability: CAPABILITIES.fleet, axis: 'use' } });
    const decision = admit(w, route, { device: 'phone' }).decision;
    if (decision.outcome !== 'admitted') throw new Error('fixture refused');
    expect(w.gate.judgeRootWrite(ask(decision.standing))).toBe(true);
    w.enrol('phone', { ...FULL_DEVICE_GRANTS, filesystem: { use: true, configure: false } });
    expect(w.gate.judgeRootWrite(ask(decision.standing))).toBe(false);
    expect(w.gate.judgeRootWrite(ask())).toBe(false);
    const owner = admit(w, route, { bearer: ADMIN, arrival: local() }).decision;
    if (owner.outcome !== 'admitted') throw new Error('loopback fixture refused');
    expect(w.gate.judgeRootWrite(ask(owner.standing))).toBe(true);
  });
});
