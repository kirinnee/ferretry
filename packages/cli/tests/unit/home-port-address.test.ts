import { describe, expect, test } from 'bun:test';
import { resolveDaemonUrl } from '../../src/lib/address.ts';

const run = { format: 1 as const, socket: '/s', host: '127.0.0.1', port: 7777, pid: 5, version: '5.0.0' };

describe('where the client dials: FY_URL, the run record, the home’s configured port, then 7457', () => {
  test('with no run record the home’s configured port is dialled, never 7457', () => {
    expect(resolveDaemonUrl('', undefined, 7603)).toBe('http://127.0.0.1:7603');
  });
  test('the run record (the bind the daemon really took) beats the configured port', () => {
    expect(resolveDaemonUrl('', run, 7603)).toBe('http://127.0.0.1:7777');
  });
  test('FY_URL beats everything', () => {
    expect(resolveDaemonUrl(' http://127.0.0.1:1 ', run, 7603)).toBe('http://127.0.0.1:1');
  });
  test('nothing configured keeps the well-known default', () => {
    expect(resolveDaemonUrl('', undefined, undefined)).toBe('http://127.0.0.1:7457');
    expect(resolveDaemonUrl('', undefined)).toBe('http://127.0.0.1:7457');
  });
});
