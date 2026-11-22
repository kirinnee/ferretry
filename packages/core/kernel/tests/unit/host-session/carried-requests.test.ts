import { describe, expect, test } from 'bun:test';
import { CarriedRequests } from '../../../host/session/carried-requests.ts';

const principal = {
  kind: 'device',
  holder: 'phone',
  session: 's-phone',
  leaseUntil: 0,
} as unknown as Parameters<CarriedRequests['build']>[1];
const origin = { carrier: 'relay', clientAddress: undefined } as unknown as Parameters<CarriedRequests['build']>[2];
const source = { method: 'GET', path: '/v1/x', headers: {}, body: '' } as unknown as Parameters<
  CarriedRequests['build']
>[0];

describe('a carried request ends when it settles, with its session still open (E2 L129)', () => {
  test('settling one request aborts only its own signal', () => {
    const carried = new CarriedRequests();
    const a = carried.build(source, principal, origin);
    const b = carried.build(source, principal, origin);
    expect(a.signal?.aborted).toBe(false);
    carried.settled(a);
    expect(a.signal?.aborted).toBe(true);
    expect(b.signal?.aborted).toBe(false);
  });

  test('the session ending still aborts every request that has not settled', () => {
    const carried = new CarriedRequests();
    const a = carried.build(source, principal, origin);
    const b = carried.build(source, principal, origin);
    carried.settled(a);
    carried.end();
    expect(b.signal?.aborted).toBe(true);
  });

  test('settling a request the session never built is a no-op', () => {
    const carried = new CarriedRequests();
    expect(() => carried.settled(carried.build(source, principal, origin))).not.toThrow();
    expect(() => carried.settled({} as never)).not.toThrow();
  });
});
