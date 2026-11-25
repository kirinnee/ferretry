import { expect, test } from 'bun:test';
import { PROTOCOL, type Arrival } from '@ferretry/kernel/contract';
import { AUDIT_KINDS, cap, DEFAULT_GATE_CONFIG, STEP_UP_ACTS } from '../../../../contract/index.ts';
import { routeAuditDraft } from '../../../../daemon/lib/audit/policy.ts';
import { ADMIN, admit, carried, descriptor, request, WARDEN, world } from '../support.ts';

const grant = 'cg_abcdefghij';
const arrival: Arrival = { kind: 'delegated', by: 'connector', grant };

test('a connector authenticates from its delegated arrival and audits its grant without host authority', () => {
  const w = world();
  const route = descriptor({ caller: 'person', capability: cap('fleet', 'use') });
  const { decision, call } = admit(w, route, { arrival });
  expect(decision.outcome).toBe('admitted');
  if (decision.outcome !== 'admitted') throw new Error('connector was refused');
  expect(decision.standing).toMatchObject({
    actor: `connector:${grant}`,
    credential: { kind: 'authenticated', tokenClass: 'connector', grant },
    presentation: { local: false, adminToken: false, stepUp: false },
    governance: { governed: true },
  });
  expect(decision.standing.claimFreshStepUp?.()).toBe(false);
  expect(
    routeAuditDraft(AUDIT_KINDS['session.opened'], { ...decision.standing, request: call, params: new Map() }, 200),
  ).toEqual({
    event: AUDIT_KINDS['session.opened'],
    actor: { kind: 'connector' },
    outcome: 'succeeded',
    detail: { grant },
  });
  expect(admit(w, route, { arrival: { ...arrival, grant: 'invalid' } }).outcome).toBe('401 unauthorized');
});

test('public and capability-free connector routes still require determined fleet.use on every call', () => {
  const w = world();
  for (const minimum of ['none', 'operator'] as const) {
    const route = descriptor({ path: '/v1/projects', minimum });
    w.policy = DEFAULT_GATE_CONFIG;
    const allowed = admit(w, route, { arrival });
    expect(allowed.outcome).toBe('admitted');
    if (allowed.decision.outcome !== 'admitted') throw new Error('read was refused');
    expect(allowed.decision.standing.governance?.governed).toBe(true);
    w.policy = {
      ...DEFAULT_GATE_CONFIG,
      grants: { ...DEFAULT_GATE_CONFIG.grants, fleet: { use: false, configure: false } },
    };
    expect(admit(w, route, { arrival }).outcome).toBe('403 grant_not_granted');
    w.policy = undefined;
    expect(admit(w, route, { arrival }).outcome).toBe('403 grant_undetermined');
  }
});

test('only start and restart waive fleet.configure confirmation, keeping extra passkey demands', () => {
  const w = world();
  for (const path of ['/v1/ferrets', '/v1/restarts']) {
    const route = descriptor({ method: 'POST', path, capability: cap('fleet', 'configure') });
    expect(admit(w, route, { arrival }).outcome).toBe('admitted');
    expect(admit(w, { ...route, method: 'DELETE' }, { arrival }).outcome).toBe('403 grant_step_up_required');
    expect(
      admit(w, { ...route, capability: cap('fleet', 'configure', { act: STEP_UP_ACTS.catalogInstall }) }, { arrival })
        .outcome,
    ).toBe('403 grant_step_up_required');
    expect(admit(w, { ...route, capability: cap('secrets', 'use') }, { arrival }).outcome).toBe(
      '403 grant_step_up_required',
    );
  }
});

test('connector inventory is projected as a remote governed caller, never the owner at this machine', () => {
  const w = world();
  const inventory = { protocol: PROTOCOL, plugins: [{ id: 'fixture', on: true, contract: 'fixture' }] };
  const surfaces = new Map([['fixture', [descriptor({ minimum: 'admin-token' })]]]);
  const delegated = w.gate.project(request({ arrival }), inventory, surfaces);
  expect(delegated).toEqual(w.gate.project(request({ bearer: ADMIN, arrival: carried() }), inventory, surfaces));
  expect(delegated.plugins).toEqual([]);
  expect(w.gate.project(request({ bearer: ADMIN }), inventory, surfaces).plugins).toHaveLength(1);
});

test('the kernel-facing literal mask removes both host credentials and keeps ordinary text', () => {
  const { gate } = world();
  expect(gate.maskHostCredentials(`${ADMIN} safe ${WARDEN} ${ADMIN}`)).toBe('[redacted] safe [redacted] [redacted]');
  expect(gate.maskHostCredentials('safe fixture')).toBe('safe fixture');
});
