import { describe, expect, test } from 'bun:test';
import { DEFAULT_GATE_CONFIG, FULL_DEVICE_GRANTS } from '../../../../contract/index.ts';
import { ADMIN, admit, carried, declaredRoute, local, terminalUse, world } from '../support.ts';

/**
 * Finding 3 of the structured-questions review: `POST /v1/ferrets/:ferretId/answer` types native keys and pastes into a
 * pane, so it must ask the same remote grant as any route that types. v4 declared no capability (R-0335 `capability=none`);
 * this is a recorded, deliberate parity correction (descriptor-parity-changes.tsv). Both arrivals are decided by the REAL
 * GateAdmission over the SHIPPED manifest descriptor.
 */

const allOff = Object.fromEntries(
  Object.keys(FULL_DEVICE_GRANTS).map(name => [name, { use: false, configure: false }]),
) as typeof FULL_DEVICE_GRANTS;

const ANSWER = 'POST /v1/ferrets/:ferretId/answer';

describe('answering a native question form asks the terminal grant', () => {
  test('a relayed admin bearer claiming 127.0.0.1, every daemon grant off, is refused like any terminal.use route', async () => {
    const w = world({ policy: { ...DEFAULT_GATE_CONFIG, grants: allOff } });
    const route = await declaredRoute(ANSWER);
    const options = { bearer: ADMIN, arrival: carried('relay'), clientAddress: '127.0.0.1' };
    expect(admit(w, terminalUse, options).outcome).toBe('403 grant_not_granted');
    expect(admit(w, route, options).outcome).toBe('403 grant_not_granted');
  });

  test('a device holding no grants is refused like any terminal.use route', async () => {
    const w = world();
    w.enrol('phone', allOff);
    const route = await declaredRoute(ANSWER);
    expect(admit(w, terminalUse, { device: 'phone' }).outcome).toBe('403 grant_device_not_granted');
    expect(admit(w, route, { device: 'phone' }).outcome).toBe('403 grant_device_not_granted');
  });

  test('the local owner keeps its usual exemption with every grant off', async () => {
    const w = world({ policy: { ...DEFAULT_GATE_CONFIG, grants: allOff } });
    const route = await declaredRoute(ANSWER);
    const options = { bearer: ADMIN, arrival: local() };
    expect(admit(w, route, options).outcome).toBe(admit(w, terminalUse, options).outcome);
    expect(admit(w, route, options).outcome).not.toMatch(/^403/);
  });

  test('stays person-only', async () => {
    const route = await declaredRoute(ANSWER);
    expect(route.caller).toBe('person');
    expect(route.capability).toEqual(terminalUse.capability);
  });
});
