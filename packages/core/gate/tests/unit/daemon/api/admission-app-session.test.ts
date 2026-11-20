import { describe, expect, test } from 'bun:test';
import type { ConfigWriteJudgement } from '@ferretry/kernel/contract';
import { DEFAULT_GATE_CONFIG, DEFAULT_GATE_SECURITY, STEP_UP_ACTS } from '../../../../contract/index.ts';
import { admit, fleetUse, later, type World, world } from '../support.ts';

/**
 * A step-up proof is keyed by (device, the page's own app session). A real kernel stamps `principal.session` with the
 * per-connection transcript hash and the page's id as `principal.appSession`; the old fixture set only `session`, so
 * the two were one value and a proof keyed by the wrong one looked right. Here they always differ.
 */

const PAGE = 'app-page-one';
const TRANSCRIPT_OF = 's-phone';
const proofFor = (deviceId: string, appSession: string) => ({ deviceId, appSession });

function claimOf(w: World, options: Parameters<typeof admit>[2]) {
  const { decision } = admit(w, fleetUse, options);
  if (decision.outcome !== 'admitted') throw new Error('expected admitted');
  return decision.standing.claimFreshStepUp;
}

describe('a fresh passkey proof is found by the page that made it, not by the connection transcript', () => {
  test('the proof a good passkey granted for (device, appSession) is claimed on the FIRST try, once', () => {
    const w = world();
    w.enrol('phone');
    w.stepUps.grant(proofFor('phone', PAGE), true, STEP_UP_ACTS.addDevice);
    const claim = claimOf(w, { device: 'phone', appSession: PAGE });
    expect(claim?.(STEP_UP_ACTS.addDevice)).toBe(true);
    expect(claim?.(STEP_UP_ACTS.addDevice)).toBe(false);
  });

  test('a proof keyed by the transcript hash is NOT this page’s proof', () => {
    const w = world();
    w.enrol('phone');
    w.stepUps.grant(proofFor('phone', TRANSCRIPT_OF), true, STEP_UP_ACTS.addDevice);
    expect(claimOf(w, { device: 'phone', appSession: PAGE })?.(STEP_UP_ACTS.addDevice)).toBe(false);
  });

  test('a proof from another device is refused', () => {
    const w = world();
    w.enrol('phone');
    w.enrol('laptop');
    w.stepUps.grant(proofFor('laptop', PAGE), true, STEP_UP_ACTS.addDevice);
    expect(claimOf(w, { device: 'phone', appSession: PAGE })?.(STEP_UP_ACTS.addDevice)).toBe(false);
  });

  test('a proof from another app session of the same device is refused', () => {
    const w = world();
    w.enrol('phone');
    w.stepUps.grant(proofFor('phone', 'app-page-two'), true, STEP_UP_ACTS.addDevice);
    expect(claimOf(w, { device: 'phone', appSession: PAGE })?.(STEP_UP_ACTS.addDevice)).toBe(false);
  });

  test('an expired proof is refused', () => {
    const w = world();
    w.enrol('phone');
    w.stepUps.grant(proofFor('phone', PAGE), true, STEP_UP_ACTS.addDevice);
    w.now = later(w.now, 121_000);
    expect(claimOf(w, { device: 'phone', appSession: PAGE })?.(STEP_UP_ACTS.addDevice)).toBe(false);
  });

  test('a principal with no appSession still keys by its session (a credential that named no page)', () => {
    const w = world();
    w.enrol('phone');
    w.stepUps.grant(proofFor('phone', TRANSCRIPT_OF), true, STEP_UP_ACTS.addDevice);
    expect(claimOf(w, { device: 'phone' })?.(STEP_UP_ACTS.addDevice)).toBe(true);
  });
});

describe('the live re-read of a standing (a secret add) finds the page’s step-up too', () => {
  const perAct = { ...DEFAULT_GATE_CONFIG, security: { ...DEFAULT_GATE_SECURITY, stepUpOnActions: true } };
  const add = (w: World, standing: NonNullable<ConfigWriteJudgement['standing']>): 'apply' | 'hold' =>
    w.gate.judgeConfigWrite({
      plugin: 'mcp',
      path: 'mcp/acme.yaml',
      removal: false,
      sentences: ['names the secret ACME_TOKEN'],
      actor: 'owner-viewer',
      standing,
      secretAdd: true,
    });

  function standingAfter(grantedFor: { deviceId: string; appSession: string }) {
    const w = world({ policy: perAct });
    w.enrol('phone');
    w.stepUps.grant(grantedFor, true, STEP_UP_ACTS.loosenConfig);
    const { decision } = admit(w, { ...fleetUse, consultsGrants: true }, { device: 'phone', appSession: PAGE });
    if (decision.outcome !== 'admitted') throw new Error('expected admitted');
    return { w, standing: decision.standing };
  }

  test('a good passkey for this page lets the add apply on the first try', () => {
    const { w, standing } = standingAfter(proofFor('phone', PAGE));
    expect(add(w, standing)).toBe('apply');
  });

  test('a passkey from another page of the device holds the add', () => {
    const { w, standing } = standingAfter(proofFor('phone', 'app-page-two'));
    expect(add(w, standing)).toBe('hold');
  });
});
