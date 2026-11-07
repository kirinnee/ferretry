import { describe, expect, test } from 'bun:test';
import type { Actor, CallStanding, ConfigAccessJudgement, ConfigAct } from '@ferretry/kernel/contract';
import { FULL_DEVICE_GRANTS, STEP_UP_ACTS } from '../../../../contract/index.ts';
import { CLIENT_HEADER, SESSION_ID_HEADER } from '../../../../daemon/lib/api/admission.ts';
import { judgeConfigAccess } from '../../../../daemon/lib/policy/config-access.ts';
import { ADMIN, admit, carried, descriptor, FERRET, FERRET_TOKEN, local, type World, world } from '../support.ts';

/** The kernel's config routes ask the fleet's `use` at the boundary, so the standing carries the grants. */
const route = descriptor({ capability: { capability: 'fleet', axis: 'use' } as never });
const subjectOf = (id: string) => ({ deviceId: id, appSession: `s-${id}` });
const atMachine = { bearer: ADMIN, arrival: local(), headers: { [CLIENT_HEADER]: 'cli' } };

/** A route that only consults the grants, so the judge's own second wall is reached (the boundary would refuse first). */
const consulting = descriptor({ consultsGrants: true });

function standingOf(w: World, options: Parameters<typeof admit>[2] = {}, routeOf: typeof route = route): CallStanding {
  const { decision, outcome } = admit(w, routeOf, options);
  if (decision.outcome !== 'admitted') throw new Error(`expected admitted, got ${outcome}`);
  return decision.standing;
}

const ask = (
  act: ConfigAct,
  actor: Actor,
  standing: CallStanding | undefined,
  path = 'machine.yaml',
): ConfigAccessJudgement => ({ plugin: 'runtimes', path, act, actor, ...(standing === undefined ? {} : { standing }) });

const refusedWith = (
  verdict: ReturnType<typeof judgeConfigAccess>,
): { status: number; body: Record<string, unknown> } => {
  if (verdict.allowed) throw new Error('expected a refusal');
  return { status: verdict.response.status, body: JSON.parse(verdict.response.body) as Record<string, unknown> };
};

describe('R-0072 reading a file asks the FILE’s capability on `use`', () => {
  test('the owner at the machine reads; a device with the grant reads', () => {
    const w = world();
    expect(judgeConfigAccess(ask('read', 'owner-tools', standingOf(w, atMachine))).allowed).toBe(true);
    w.enrol('phone');
    expect(judgeConfigAccess(ask('read', 'owner-viewer', standingOf(w, { device: 'phone' }))).allowed).toBe(true);
  });

  test('a device the owner kept off the file’s capability is refused 403 with the grant code, naming the file', () => {
    const w = world();
    w.enrol('phone', { ...FULL_DEVICE_GRANTS, warden: { use: false, configure: false } });
    const warden = refusedWith(
      judgeConfigAccess(ask('read', 'owner-viewer', standingOf(w, { device: 'phone' }), 'warden.yaml')),
    );
    expect(warden.status).toBe(403);
    expect(String(warden.body.error)).toContain('warden.yaml');
    expect(String(warden.body.code)).toStartWith('grant_');
    // the fleet's files are the fleet's question, not the warden's
    expect(judgeConfigAccess(ask('read', 'owner-viewer', standingOf(w, { device: 'phone' }))).allowed).toBe(true);
  });

  test('no standing at all is refused (undetermined fails closed)', () => {
    expect(refusedWith(judgeConfigAccess(ask('read', 'owner-tools', undefined))).status).toBe(403);
  });
});

describe('R-0419 writing a file asks `configure`, then the fleet’s `use`, and says whether this call may loosen', () => {
  test('the owner at the machine may loosen in this same act, with no proof to spend', () => {
    const w = world();
    const verdict = judgeConfigAccess(ask('write', 'owner-tools', standingOf(w, atMachine)));
    expect(verdict).toEqual({ allowed: true, mayLoosen: true });
  });

  test('a device with the grant but no passkey proved for the act may write, and may not loosen', () => {
    const w = world();
    w.enrol('phone');
    const verdict = judgeConfigAccess(ask('write', 'owner-viewer', standingOf(w, { device: 'phone' })));
    expect(verdict.allowed).toBe(true);
    if (verdict.allowed) expect(verdict.mayLoosen).toBe(false);
  });

  test('a device with a fresh passkey may loosen, and the proof it carries is spent by `spend` (one proof, one loosening)', () => {
    const w = world();
    w.enrol('phone');
    w.stepUps.grant(subjectOf('phone'));
    const standing = standingOf(w, { device: 'phone' });
    const verdict = judgeConfigAccess(ask('write', 'owner-viewer', standing));
    expect(verdict.allowed && verdict.mayLoosen).toBe(true);
    if (!verdict.allowed || verdict.spend === undefined) throw new Error('expected a spend for a governed caller');
    verdict.spend();
    const next = judgeConfigAccess(ask('write', 'owner-viewer', standingOf(w, { device: 'phone' })));
    expect(next.allowed && next.mayLoosen).toBe(false);
  });

  test('a device without the file’s `configure` is refused, for warden.yaml by the warden capability', () => {
    const w = world();
    w.enrol('phone', { ...FULL_DEVICE_GRANTS, fleet: { use: true, configure: false } });
    const fleet = refusedWith(judgeConfigAccess(ask('write', 'owner-viewer', standingOf(w, { device: 'phone' }))));
    expect(fleet.status).toBe(403);
    expect(String(fleet.body.error)).toContain('machine.yaml');
    // warden.yaml asks the warden capability, which this device holds
    expect(
      judgeConfigAccess(ask('write', 'owner-viewer', standingOf(w, { device: 'phone' }), 'warden.yaml')).allowed,
    ).toBe(true);
  });

  test('a device the owner kept off the fleet’s `use` may change no file, warden.yaml included', () => {
    const w = world();
    w.enrol('phone', { ...FULL_DEVICE_GRANTS, fleet: { use: false, configure: false } });
    const refusal = refusedWith(
      judgeConfigAccess(ask('write', 'owner-viewer', standingOf(w, { device: 'phone' }, consulting), 'warden.yaml')),
    );
    expect(refusal.status).toBe(403);
    expect(String(refusal.body.error)).toContain('agent fleet');
  });

  test('a ferret, a warden and a call that mislabels its actor are refused `owner_only`', () => {
    const w = world();
    const ferret = standingOf(w, { bearer: FERRET_TOKEN, arrival: local(true) });
    expect(refusedWith(judgeConfigAccess(ask('write', 'ferret', ferret))).body.code).toBe('owner_only');
    expect(refusedWith(judgeConfigAccess(ask('write', 'owner-tools', ferret))).body.code).toBe('owner_only');
    const named = standingOf(w, { bearer: ADMIN, arrival: local(), headers: { [SESSION_ID_HEADER]: FERRET } });
    expect(refusedWith(judgeConfigAccess(ask('write', 'owner-tools', named))).body.code).toBe('owner_only');
    expect(refusedWith(judgeConfigAccess(ask('write', 'warden', standingOf(w, atMachine)))).body.code).toBe(
      'owner_only',
    );
  });

  test('the admin token relayed from off the host is governed: no loosening without a proof', () => {
    const w = world();
    const verdict = judgeConfigAccess(
      ask(
        'write',
        'owner-tools',
        standingOf(w, { bearer: ADMIN, arrival: carried(), headers: { [CLIENT_HEADER]: 'cli' } }),
      ),
    );
    expect(verdict.allowed && verdict.mayLoosen).not.toBe(true);
  });
});

describe('R-0274 confirming a held edit is the owner’s act, with today’s step-up rule', () => {
  test('the owner at the machine confirms with nothing to spend', () => {
    const w = world();
    expect(judgeConfigAccess(ask('confirm', 'owner-tools', standingOf(w, atMachine)))).toEqual({ allowed: true });
  });

  test('a governed device needs a passkey proved for THIS act (`loosen-config`): asked for it, then spent', () => {
    const w = world();
    w.enrol('phone');
    const without = refusedWith(judgeConfigAccess(ask('confirm', 'owner-viewer', standingOf(w, { device: 'phone' }))));
    expect(without.status).toBe(403);
    expect(without.body.code).toBe('grant_step_up_required');
    expect(without.body.demand).toEqual({ capability: 'fleet', axis: 'configure', act: STEP_UP_ACTS.loosenConfig });
    w.stepUps.grant(subjectOf('phone'));
    const verdict = judgeConfigAccess(ask('confirm', 'owner-viewer', standingOf(w, { device: 'phone' })));
    if (!verdict.allowed || verdict.spend === undefined)
      throw new Error('expected an allowed confirm with a proof to spend');
    verdict.spend();
    expect(judgeConfigAccess(ask('confirm', 'owner-viewer', standingOf(w, { device: 'phone' }))).allowed).toBe(false);
  });

  test('a ferret never confirms, and a device without `configure` for the file may not', () => {
    const w = world();
    const ferret = standingOf(w, { bearer: FERRET_TOKEN, arrival: local(true) });
    expect(refusedWith(judgeConfigAccess(ask('confirm', 'ferret', ferret))).body.code).toBe('forbidden');
    w.enrol('phone', { ...FULL_DEVICE_GRANTS, fleet: { use: true, configure: false } });
    w.stepUps.grant(subjectOf('phone'));
    expect(judgeConfigAccess(ask('confirm', 'owner-viewer', standingOf(w, { device: 'phone' }))).allowed).toBe(false);
  });
});
