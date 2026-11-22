/**
 * C59 O5-10b `openLooseningAct`: ONE request that writes several owners' files (an import, a clone) is ONE act on ONE
 * passkey proof, claimed before anything is written; outside an open act the old rule stands (one proof, one loosening).
 * Real Gate admission over the support world; fixture values only.
 */
import { describe, expect, test } from 'bun:test';
import type { Actor, CallStanding, ConfigWriteJudgement } from '@ferretry/kernel/contract';
import { openLooseningAct, type OwnerOnlyCall, STEP_UP_ACTS } from '../../../../contract/index.ts';
import { CLIENT_HEADER } from '../../../../daemon/lib/api/admission.ts';
import { judgeLooseningWrite } from '../../../../daemon/lib/policy/config-judge.ts';
import { ADMIN, admit, descriptor, FERRET_TOKEN, local, type World, world } from '../support.ts';

const route = descriptor({ consultsGrants: true });
const subjectOf = (id: string) => ({ deviceId: id, appSession: `s-${id}` });

function standingOf(w: World, options: Parameters<typeof admit>[2] = {}): CallStanding {
  const { decision, outcome } = admit(w, route, options);
  if (decision.outcome !== 'admitted') throw new Error(`expected admitted, got ${outcome}`);
  return decision.standing;
}

const callOf = (standing: CallStanding): OwnerOnlyCall =>
  ({ request: {}, params: new Map(), ...standing }) as unknown as OwnerOnlyCall;

const judgement = (standing: CallStanding, path: string, actor: Actor = 'owner-viewer'): ConfigWriteJudgement => ({
  plugin: 'runtimes',
  path,
  removal: false,
  sentences: ['agents now run with a new instructions component'],
  actor,
  standing,
});

function counted(w: World): () => number {
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

describe('C59 O5-10b one import is one loosening act on one passkey', () => {
  test('an unlocked device with no fresh proof is answered 403 loosen-config and claims nothing', () => {
    const w = world();
    w.enrol('phone');
    const taken = counted(w);
    const act = openLooseningAct(callOf(standingOf(w, { device: 'phone' })), 'import this setup');
    expect('refused' in act ? act.refused.status : 0).toBe(403);
    expect('refused' in act ? JSON.parse(act.refused.body) : {}).toMatchObject({
      code: 'grant_step_up_required',
      demand: { capability: 'fleet', axis: 'configure', act: 'loosen-config' },
    });
    expect(taken()).toBe(0);
  });

  test('a fresh proof for ANOTHER act, or for none, is not the named one: refused, and it stays where it is', () => {
    for (const act of [STEP_UP_ACTS.addDevice, undefined]) {
      const w = world();
      w.enrol('phone');
      w.stepUps.grant(subjectOf('phone'), true, act as never);
      const opened = openLooseningAct(callOf(standingOf(w, { device: 'phone' })), 'import this setup');
      expect('refused' in opened ? opened.refused.status : 0).toBe(403);
      // Nothing was taken: the proof is still there for the act it was proved for.
      expect(w.stepUps.freshlyHeld(subjectOf('phone'))).toBe(true);
    }
  });

  test('with one fresh proof for loosen-config the act claims it once, and every loosening of the act applies on it', () => {
    const w = world();
    w.enrol('phone');
    w.stepUps.grant(subjectOf('phone'), true, STEP_UP_ACTS.loosenConfig);
    const taken = counted(w);
    const standing = standingOf(w, { device: 'phone' });
    const act = openLooseningAct(callOf(standing), 'import this setup');
    expect('covered' in act && act.covered).toBe(true);
    // Three owners' loosenings in one request, the kernel's `{ ...standing }` copy included.
    expect(judgeLooseningWrite(judgement(standing, 'claude-code/settings/imported.yaml'))).toBe('apply');
    expect(judgeLooseningWrite(judgement(standing, 'instructions/claude-instructions.yaml'))).toBe('apply');
    expect(judgeLooseningWrite(judgement({ ...standing }, 'instructions/codex-instructions.yaml'))).toBe('apply');
    expect(taken()).toBe(1);
    if ('end' in act) act.end();
    // The act ended with its request: the same standing loosens nothing more, and the proof is gone for any other.
    expect(judgeLooseningWrite(judgement(standing, 'instructions/later.yaml'))).toBe('hold');
    expect(judgeLooseningWrite(judgement(standingOf(w, { device: 'phone' }), 'instructions/other.yaml'))).toBe('hold');
    expect(taken()).toBe(1);
  });

  test('`covered` is the LIVE Gate mark: true while the act is open, false the moment it ends, never a stale copy', () => {
    const w = world();
    w.enrol('phone');
    w.stepUps.grant(subjectOf('phone'), true, STEP_UP_ACTS.loosenConfig);
    const act = openLooseningAct(callOf(standingOf(w, { device: 'phone' })), 'import this setup');
    if ('refused' in act) throw new Error('expected the act to open');
    expect(act.covered).toBe(true);
    act.end();
    expect(act.covered).toBe(false);
  });

  test('outside an act the old rule stands: one proof buys one loosening on the same call', () => {
    const w = world();
    w.enrol('phone');
    w.stepUps.grant(subjectOf('phone'));
    const standing = standingOf(w, { device: 'phone' });
    expect(judgeLooseningWrite(judgement(standing, 'instructions/a.yaml'))).toBe('apply');
    expect(judgeLooseningWrite(judgement(standing, 'instructions/b.yaml'))).toBe('hold');
  });

  test('an act covers grants it does not have: a device without the file’s configure grant still holds', () => {
    const w = world();
    w.enrol('phone', { fleet: { use: true, configure: false } } as never);
    w.stepUps.grant(subjectOf('phone'));
    const standing = standingOf(w, { device: 'phone' });
    const act = openLooseningAct(callOf(standing), 'import this setup');
    expect(judgeLooseningWrite(judgement(standing, 'instructions/a.yaml'))).toBe('hold');
    if ('end' in act) act.end();
  });

  test('somebody at the machine claims nothing and still applies; a ferret is refused before any claim', () => {
    const w = world();
    const taken = counted(w);
    const owner = standingOf(w, { bearer: ADMIN, arrival: local(), headers: { [CLIENT_HEADER]: 'cli' } });
    const act = openLooseningAct(callOf(owner), 'import this setup');
    expect('covered' in act && act.covered).toBe(false);
    expect(judgeLooseningWrite(judgement(owner, 'instructions/a.yaml', 'owner-tools'))).toBe('apply');
    const ferret = standingOf(w, { bearer: FERRET_TOKEN, arrival: local(true) });
    expect(() => openLooseningAct(callOf(ferret), 'import this setup')).toThrow();
    expect(taken()).toBe(0);
  });
});
