import { expect, test } from 'bun:test';
import type { Arrival, PluginId } from '@ferretry/kernel/contract';
import { ADMIN, FERRET_TOKEN, WARDEN, admit, descriptor, request, world } from '../support.ts';

const arrival: Arrival = { kind: 'door', plugin: 'connector' as PluginId, door: 'own' };
test('door arrival authenticates no admin, warden, ferret or device credential', () => {
  const w = world();
  w.enrol('phone');
  for (const options of [{ bearer: ADMIN }, { bearer: WARDEN }, { bearer: FERRET_TOKEN }, { device: 'phone' }, {}]) {
    expect(admit(w, descriptor(), { ...options, arrival }).outcome).toBe('401 unauthorized');
    const publicDecision = admit(w, descriptor({ minimum: 'none', door: 'public' }), { ...options, arrival }).decision;
    expect(publicDecision).toEqual({ outcome: 'admitted', standing: {}, actor: 'owner-viewer' });
  }
});
test('no credential header is even read on a door, including inventory and re-admission', () => {
  const w = world();
  const call = request({ arrival });
  let reads = 0;
  call.headers.get = () => {
    reads++;
    throw new Error('credentials must not be parsed');
  };
  expect(w.gate.readmit(call, descriptor())).toBe(false);
  expect(w.gate.inventory(call, [], { routes: [], sockets: [], tools: [] } as never)).toEqual([]);
  expect(reads).toBe(0);
});
