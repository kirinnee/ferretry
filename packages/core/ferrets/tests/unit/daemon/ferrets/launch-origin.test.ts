import { describe, expect, test } from 'bun:test';
import { ferretActor } from '@ferretry/core-gate/contract';
import { deviceStanding, ferretStanding, ownerStanding, wardenStanding } from '@ferretry/core-gate/contract/testing';
import { ferretId } from '../../../../contract/testing/index.ts';
import type { CallStanding } from '@ferretry/kernel/contract';
import { ok } from '@ferretry/std';
import {
  AGENT_ORIGIN,
  DAEMON_ORIGIN,
  type FerretId,
  type FerretsApi,
  type LaunchOrigin,
  LaunchOriginSchema,
  originIsAgent,
  PERSON_ORIGIN,
} from '../../../../contract/index.ts';
import { launchOriginOf } from '../../../../daemon/lib/ferrets/launch-origin.ts';
import { ferretsPort } from '../../../../daemon/lib/ferrets/port.ts';
import type { FerretsService } from '../../../../daemon/lib/ferrets/service.ts';

const F1 = 'f1' as FerretId;

describe('launchOriginOf: the origin is the admitted credential’s, and nothing else', () => {
  test('the owner and a paired device are a person', () => {
    expect(launchOriginOf(ownerStanding('cli'))).toEqual(PERSON_ORIGIN);
    expect(launchOriginOf(ownerStanding('ui'))).toEqual(PERSON_ORIGIN);
    expect(launchOriginOf(deviceStanding('phone'))).toEqual(PERSON_ORIGIN);
  });

  test('a ferret’s token is an agent naming that ferret', () => {
    expect(launchOriginOf(ferretStanding(F1))).toEqual({ kind: 'agent', ferret: F1 });
  });

  test('the admin token with a ferret behind it is that ferret’s agent', () => {
    const behind: CallStanding = { ...ownerStanding(), actor: ferretActor('f9') };
    expect(launchOriginOf(behind)).toEqual({ kind: 'agent', ferret: ferretId('f9') });
  });

  test('the Warden’s token is an agent with no ferret, however its attribution reads', () => {
    expect(launchOriginOf(wardenStanding('w1' as FerretId))).toEqual(AGENT_ORIGIN);
  });

  test('no credential at all is not an agent’s, but nothing asks for a launch without one', () => {
    expect(launchOriginOf({})).toEqual(PERSON_ORIGIN);
  });
});

describe('the origin schema and its helpers', () => {
  test('accepts the three kinds and nothing wider', () => {
    for (const good of [PERSON_ORIGIN, DAEMON_ORIGIN, AGENT_ORIGIN, { kind: 'agent', ferret: F1 }])
      expect(LaunchOriginSchema.safeParse(good).success).toBe(true);
    for (const bad of [
      undefined,
      null,
      'person',
      {},
      { kind: 'owner' },
      { kind: 'person', extra: 1 },
      { kind: 'agent', ferret: '' },
    ])
      expect(LaunchOriginSchema.safeParse(bad).success).toBe(false);
  });

  test('only an agent is fenced', () => {
    expect(originIsAgent(PERSON_ORIGIN)).toBe(false);
    expect(originIsAgent(DAEMON_ORIGIN)).toBe(false);
    expect(originIsAgent(AGENT_ORIGIN)).toBe(true);
    expect(originIsAgent({ kind: 'agent', ferret: F1 })).toBe(true);
  });
});

/** A service that records what reached it; the port is what is under test. */
function spy() {
  const reached: { readonly member: string; readonly args: readonly unknown[] }[] = [];
  const note =
    (member: string, answer: unknown) =>
    async (...args: unknown[]) => {
      reached.push({ member, args });
      return answer;
    };
  const service = {
    start: note('start', ok(F1)),
    resume: note('resume', ok(F1)),
    move: note('move', ok({})),
    get: async () => undefined,
    inWardenLineage: async () => false,
  } as unknown as FerretsService;
  return { reached, port: (consumer: string): FerretsApi => ferretsPort(service, consumer) };
}

const NO_ORIGIN = {
  ok: false,
  error: {
    code: 'refused',
    reason: 'a launch must say who it is for: its origin is missing or not one of person, daemon or agent',
  },
} as const;

describe('the consumer port: every launch states who it is for', () => {
  test('a start, a resume and a move with no origin (or one that is not a LaunchOrigin) are refused, and nothing launches', async () => {
    const w = spy();
    const port = w.port('board');
    const bad = [undefined, null, 'owner', {}, { kind: 'owner' }] as unknown as LaunchOrigin[];
    for (const origin of bad) {
      expect(await port.start({ folder: '/work', by: 'owner' }, origin)).toEqual(NO_ORIGIN);
      expect(await port.resume(F1, 'go', { origin })).toEqual(NO_ORIGIN);
      expect(await port.move!(F1, 'codex-two', { origin })).toEqual(NO_ORIGIN);
    }
    expect(w.reached).toEqual([]);
  });

  test('a caller-stated attribution is never authority: actor peer or warden changes no origin', async () => {
    const w = spy();
    await w.port('warden').resume(F1, 'go', { origin: AGENT_ORIGIN, actor: 'warden', automatic: true });
    await w.port('board').resume(F1, 'go', { origin: AGENT_ORIGIN, actor: 'peer' });
    expect(w.reached.map(r => (r.args[2] as { origin: LaunchOrigin }).origin)).toEqual([AGENT_ORIGIN, AGENT_ORIGIN]);
  });

  test('the origin forwarded is a validated copy: the caller changing its own object afterwards changes nothing', async () => {
    const w = spy();
    const origin = { kind: 'agent' } as { kind: string };
    await w.port('board').resume(F1, 'go', { origin: origin as LaunchOrigin });
    origin.kind = 'person';
    const forwarded = (w.reached[0]!.args[2] as { origin: LaunchOrigin }).origin;
    expect(forwarded).toEqual({ kind: 'agent' });
    expect(forwarded).not.toBe(origin);
  });

  test('a start and a move forward the origin they were given', async () => {
    const w = spy();
    const agent: LaunchOrigin = { kind: 'agent', ferret: F1 };
    await w.port('board').start({ folder: '/work', by: 'owner' }, agent);
    await w.port('board').move!(F1, 'codex-two', { origin: agent, movedBy: 'owner' });
    expect(w.reached[0]!.args[1]).toEqual(agent);
    expect((w.reached[1]!.args[2] as { origin: LaunchOrigin }).origin).toEqual(agent);
  });
});
