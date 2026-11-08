import { describe, expect, test } from 'bun:test';
import type { TestHost } from '@ferretry/kernel/testing';
import { FerretFiles, NamesFile } from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import { DEFAULT_CALLSIGN_POOL } from '../../../../daemon/lib/names/index.ts';
import { host } from './route-fixture.ts';

/**
 * A start and a rename take their callsign through the claim ledger (`names.json`, F-0232), with the registry the one
 * owner of "a running ferret holds this name"; `GET /v1/names` suggests free names (R-0114). Through the real daemon
 * index wiring.
 */

let sequence = 0;
const start = async (h: TestHost, body: Record<string, unknown>) =>
  await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': `names-${(sequence += 1)}` },
    body: { folder: '/work/a', ...body },
  });
const fresh = async () => await host([], { harness: new FakeHarness(), runner: new FakeRunner() });
/** Starts a ferret answering to `name` and gives its server-minted id. */
const running = async (h: TestHost, name: string) => (await start(h, { name })).json<{ id: string }>().id;
const ledger = (h: TestHost) => JSON.parse(h.state('ferrets').raw(NamesFile) ?? '{"claims":[]}') as {
  claims: { callsign: string; ownerId: string }[];
};

describe('the start takes its name through the ledger (F-0232)', () => {
  test('a requested name is claimed on names.json for the new ferret and a second start for it is refused', async () => {
    const h = await fresh();
    const first = await start(h, { name: 'wren' });
    expect(first.status).toBeLessThan(300);
    expect(ledger(h).claims.map(claim => claim.callsign)).toEqual(['wren']);
    const again = await start(h, { name: 'wren' });
    expect(again.status).toBeGreaterThanOrEqual(400);
  });

  test('a name a running ferret holds is refused with the registry sentence, before the ledger is touched', async () => {
    const h = await fresh();
    await running(h, 'lead');
    const answer = await start(h, { name: 'lead' });
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(answer.json())).toContain('is held by running ferret');
    expect(ledger(h).claims).toHaveLength(1);
  });

  test('a start that names nothing takes the first free pool name the ledger hands over', async () => {
    const h = await fresh();
    const answer = await start(h, {});
    expect(answer.status).toBeLessThan(300);
    const [claim] = ledger(h).claims;
    expect(DEFAULT_CALLSIGN_POOL).toContain(claim?.callsign as string);
  });

  test('a damaged ledger refuses a requested name and leaves the file as it was', async () => {
    const h = await fresh();
    h.state('ferrets').plant(NamesFile, '{not json');
    const answer = await start(h, { name: 'wren' });
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(answer.json())).toContain('callsign persistence failed');
    expect(h.state('ferrets').raw(NamesFile)).toBe('{not json');
  });

  test('a damaged ledger never costs an automatic start: it falls back to the pool scan', async () => {
    const h = await fresh();
    h.state('ferrets').plant(NamesFile, '{not json');
    const answer = await start(h, {});
    expect(answer.status).toBeLessThan(300);
    expect(h.state('ferrets').raw(NamesFile)).toBe('{not json');
  });

  test('a start refused before its record exists gives the claim back', async () => {
    const h = await fresh();
    const answer = await start(h, { name: 'wren', folder: 'relative/path' });
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(ledger(h).claims).toEqual([]);
    expect((await start(h, { name: 'wren' })).status).toBeLessThan(300);
  });
});

describe('a rename takes its name through the ledger (F-0232)', () => {
  test('the new name is claimed for that ferret and another ferret is refused it', async () => {
    const h = await fresh();
    const lead = await running(h, 'lead');
    const wing = await running(h, 'wing');
    const renamed = await h.request('POST', `/v1/ferrets/${lead}/rename`, { body: { name: 'finch' } });
    expect(renamed.status).toBeLessThan(300);
    // One owner holds one name: lead's old reservation went with the rename.
    expect(ledger(h).claims.map(claim => [claim.callsign, claim.ownerId])).toEqual([
      ['wing', wing],
      ['finch', lead],
    ]);
    const taken = await h.request('POST', `/v1/ferrets/${wing}/rename`, { body: { name: 'finch' } });
    expect(taken.status).toBe(409);
    expect(JSON.stringify(taken.json())).toContain('finch');
  });

  test('renaming to the name it already answers to claims nothing', async () => {
    const h = await fresh();
    const lead = await running(h, 'lead');
    const before = h.state('ferrets').raw(NamesFile);
    const renamed = await h.request('POST', `/v1/ferrets/${lead}/rename`, { body: { name: 'lead' } });
    expect(renamed.status).toBeLessThan(300);
    expect(h.state('ferrets').raw(NamesFile)).toBe(before);
  });

  test('a stored ferret record is unchanged by a refused rename', async () => {
    const h = await fresh();
    const lead = await running(h, 'lead');
    const wing = await running(h, 'wing');
    await h.request('POST', `/v1/ferrets/${lead}/rename`, { body: { name: 'finch' } });
    await h.request('POST', `/v1/ferrets/${wing}/rename`, { body: { name: 'finch' } });
    expect(JSON.parse(h.state('ferrets').raw(FerretFiles, wing) as string).name).toBe('wing');
  });
});

describe('GET /v1/names (R-0114)', () => {
  test('R-0114 suggests free pool names, one by default and as many as asked, never one a running ferret holds', async () => {
    const taken = DEFAULT_CALLSIGN_POOL[0]!;
    const h = await fresh();
    await running(h, taken);
    const one = await h.request('GET', '/v1/names');
    expect(one.json<string[]>()).toHaveLength(1);
    const many = (await h.request('GET', '/v1/names', { query: { count: '5' } })).json<string[]>();
    expect(many).toHaveLength(5);
    expect(many).not.toContain(taken);
    expect(new Set(many).size).toBe(5);
  });

  test('R-0114 refuses a count that is not a whole number of at least one', async () => {
    const h = await fresh();
    for (const count of ['0', '-2', '1.5', 'banana']) {
      const answer = await h.request('GET', '/v1/names', { query: { count } });
      expect(answer.status).toBe(400);
      expect(answer.json<{ code: string }>().code).toBe('invalid_count');
    }
  });
});
