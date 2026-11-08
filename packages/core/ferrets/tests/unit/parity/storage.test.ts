import { describe, expect, test } from 'bun:test';
import { FakeHarness, FakeRunner } from '../../../contract/testing/index.ts';
import { FerretsPort } from '../../../contract/index.ts';
import manifest from '../../../manifest.ts';
import { host } from '../daemon/ferrets/route-fixture.ts';

const fresh = async () => await host([], { harness: new FakeHarness(), runner: new FakeRunner() });

describe('storage parity', () => {
  test('F-0232 a started ferret lands in state/ferrets/names.json as { format: 1, claims: [{ callsign, ownerId }] }', async () => {
    const h = await fresh();
    const started = await h.request('POST', '/v1/ferrets', {
      headers: { 'x-fy-request-id': 'parity-names-1' },
      body: { folder: '/work/a', name: 'wren' },
    });
    expect(started.status).toBeLessThan(300);
    const { id } = started.json<{ id: string }>();
    const stored = JSON.parse(h.state('ferrets').files.get('names.json') as string) as {
      format: number;
      claims: { callsign: string; ownerId: string }[];
    };
    expect(stored.format).toBe(1);
    expect(stored.claims.map(({ callsign, ownerId }) => ({ callsign, ownerId }))).toEqual([
      { callsign: 'wren', ownerId: id },
    ]);
    expect(manifest.data.state.map(file => file.path)).toContain('names.json');
  });

  test('F-0349 the first system callsign for a prefix lands in state/ferrets/system-callsigns.json as { learning: 1 }', async () => {
    const h = await fresh();
    expect(await h.provided(FerretsPort).systemCallsign?.('learning')).toBe('learning-000001');
    const stored = JSON.parse(h.state('ferrets').files.get('system-callsigns.json') as string) as Record<
      string,
      number
    >;
    expect(stored).toEqual({ format: 1, learning: 1 });
    expect(manifest.data.state.map(file => file.path)).toContain('system-callsigns.json');
  });
});
