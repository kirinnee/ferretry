import { describe, expect, test } from 'bun:test';
import type { TestHost } from '@ferretry/kernel/testing';
import type { FerretSummary } from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import { host, record } from './route-fixture.ts';

/** `fy stop <name>` ends something, so a name two records hold is refused, whatever state each is in (G13 review). */

const stop = async (h: TestHost, reference: string) =>
  await h.request('POST', `/v1/ferrets/${reference}/stop`, { body: {} });
const stateOf = async (h: TestHost, id: string) =>
  (await h.request('GET', `/v1/ferrets/${id}`)).json<FerretSummary>().state;

/** A stopped record and an active one that answer to the same callsign (as a record from an earlier life does). */
const twoHolders = async () =>
  await host(
    [
      { ...record('old-wren'), name: 'wren', state: 'stopped' },
      { ...record('new-wren'), name: 'wren' },
      { ...record('fern-1'), name: 'fern' },
    ],
    { harness: new FakeHarness(), runner: new FakeRunner() },
  );

describe('stop by a name more than one record holds', () => {
  test('a callsign held by one stopped and one active record is refused and stops nothing', async () => {
    const h = await twoHolders();
    const answer = await stop(h, 'wren');
    expect([answer.status, answer.json<{ code: string }>().code]).toEqual([409, 'ambiguous_name']);
    expect(JSON.stringify(answer.json())).toContain('old-wren');
    expect(JSON.stringify(answer.json())).toContain('new-wren');
    expect(await stateOf(h, 'new-wren')).not.toBe('stopped');
    await h.stop();
  });

  test('the exact id still stops the one it names', async () => {
    const h = await twoHolders();
    expect((await stop(h, 'new-wren')).status).toBe(200);
    expect(await stateOf(h, 'new-wren')).toBe('stopped');
    await h.stop();
  });

  test('a name only one record holds is still enough', async () => {
    const h = await twoHolders();
    expect((await stop(h, 'fern')).status).toBe(200);
    expect(await stateOf(h, 'fern-1')).toBe('stopped');
    await h.stop();
  });
});
