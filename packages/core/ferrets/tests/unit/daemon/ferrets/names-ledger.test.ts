import { describe, expect, test } from 'bun:test';
import type { TestHost } from '@ferretry/kernel/testing';
import { FerretFiles, NamesFile } from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import { DEFAULT_CALLSIGN_POOL } from '../../../../daemon/lib/names/index.ts';
import { as, host } from './route-fixture.ts';

/**
 * A start and a rename take their callsign through the claim ledger (`names.json`, F-0232), with the registry the one
 * owner of "a running ferret holds this name"; `GET /v1/names` suggests free names (R-0114). Through the real daemon
 * index wiring.
 */

let sequence = 0;
const start = async (h: TestHost, body: Record<string, unknown>) => {
  sequence += 1;
  return await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': `names-${sequence}` },
    body: { folder: '/work/a', ...body },
  });
};
const fresh = async () => await host([], { harness: new FakeHarness(), runner: new FakeRunner() });
/** Starts a ferret answering to `name` and gives its server-minted id. */
const running = async (h: TestHost, name: string) => (await start(h, { name })).json<{ id: string }>().id;
const ledger = (h: TestHost) =>
  JSON.parse(h.state('ferrets').raw(NamesFile) ?? '{"claims":[]}') as {
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

  test('a damaged ledger never costs an automatic start: the ferret answers to its own id, not a pool name', async () => {
    const h = await fresh();
    h.state('ferrets').plant(NamesFile, '{not json');
    const answer = await start(h, {});
    expect(answer.status).toBeLessThan(300);
    const { id } = answer.json<{ id: string }>();
    const [summary] = (await h.request('GET', '/v1/ferrets')).json<{ id: string; name: string }[]>();
    expect(summary?.name).toBe(id);
    expect(DEFAULT_CALLSIGN_POOL).not.toContain(summary?.name as string);
    expect(h.state('ferrets').raw(NamesFile)).toBe('{not json');
  });

  test('--teammate-fallback takes a free pool name when the requested one is held by a running ferret', async () => {
    const h = await fresh();
    await running(h, 'wren');
    const refused = await start(h, { name: 'wren' });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    const answer = await start(h, { name: 'wren', teammateFallback: true });
    expect(answer.status).toBeLessThan(300);
    const names = (await h.request('GET', '/v1/ferrets')).json<{ name: string }[]>().map(summary => summary.name);
    expect(names).toHaveLength(2);
    expect(names).toContain('wren');
    const other = names.find(name => name !== 'wren') as string;
    expect(DEFAULT_CALLSIGN_POOL).toContain(other);
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

const DAY_MS = 24 * 60 * 60 * 1_000;

describe('a name is held for the window after the STOP, as today (F-0232)', () => {
  test('a ferret that ran past the window and then stopped keeps its name for five days after the stop', async () => {
    const h = await fresh();
    const wren = await running(h, 'wren');
    // It runs longer than the ledger row lives (five days from the claim), then stops.
    await h.clock.advance(6 * DAY_MS);
    expect((await h.request('POST', `/v1/ferrets/${wren}/stop`, { body: {} })).status).toBeLessThan(300);
    const refused = await start(h, { name: 'wren', folder: '/work/b' });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    await h.clock.advance(4 * DAY_MS);
    expect((await start(h, { name: 'wren', folder: '/work/b' })).status).toBeGreaterThanOrEqual(400);
    await h.clock.advance(DAY_MS + 1_000);
    expect((await start(h, { name: 'wren', folder: '/work/b' })).status).toBeLessThan(300);
  });

  test('R-0114 GET /v1/names does not suggest the name of a ferret stopped inside the window', async () => {
    const taken = DEFAULT_CALLSIGN_POOL[0]!;
    const h = await fresh();
    const id = await running(h, taken);
    await h.clock.advance(6 * DAY_MS);
    await h.request('POST', `/v1/ferrets/${id}/stop`, { body: {} });
    const many = (await h.request('GET', '/v1/names', { query: { count: '5' } })).json<string[]>();
    expect(many).not.toContain(taken);
  });
});

describe('an automatic start the ledger cannot reserve answers to its id and never takes a pool name (F-0232)', () => {
  test('two concurrent automatic starts over a damaged ledger end with their own ids as names', async () => {
    const h = await fresh();
    h.state('ferrets').plant(NamesFile, '{not json');
    const [a, b] = await Promise.all([start(h, {}), start(h, { folder: '/work/b' })]);
    expect(a.status).toBeLessThan(300);
    expect(b.status).toBeLessThan(300);
    const summaries = (await h.request('GET', '/v1/ferrets')).json<{ id: string; name: string }[]>();
    expect(summaries).toHaveLength(2);
    // Each answers to its own id: unique by construction, and never a pool name.
    for (const summary of summaries) expect(summary.name).toBe(summary.id);
  });
});

describe('a rename always goes through the ledger (F-0232)', () => {
  test('a name that is not a callsign is refused (400 invalid_request) and never written', async () => {
    const h = await fresh();
    const lead = await running(h, 'lead');
    const refused = await h.request('POST', `/v1/ferrets/${lead}/rename`, { body: { name: 'Not A Callsign!' } });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.json())).toContain('invalid_request');
    expect(JSON.parse(h.state('ferrets').raw(FerretFiles, lead) as string).name).toBe('lead');
  });

  test('a damaged ledger refuses a rename with 503 name_unavailable, not name_taken, and leaves the file as it was', async () => {
    const h = await fresh();
    const lead = await running(h, 'lead');
    h.state('ferrets').plant(NamesFile, '{not json');
    const refused = await h.request('POST', `/v1/ferrets/${lead}/rename`, { body: { name: 'finch' } });
    expect(refused.status).toBe(503);
    expect(JSON.stringify(refused.json())).toContain('name_unavailable');
    expect(h.state('ferrets').raw(NamesFile)).toBe('{not json');
    expect(JSON.parse(h.state('ferrets').raw(FerretFiles, lead) as string).name).toBe('lead');
  });

  test('the claimed canonical callsign is what is written, not the raw request', async () => {
    const h = await fresh();
    const lead = await running(h, 'lead');
    const renamed = await h.request('POST', `/v1/ferrets/${lead}/rename`, { body: { name: '  Finch ' } });
    expect(renamed.status).toBeLessThan(300);
    expect(JSON.parse(h.state('ferrets').raw(FerretFiles, lead) as string).name).toBe('finch');
  });

  test('R-0362 a ferret cannot rename a ferret that is neither itself nor its helper (403)', async () => {
    const h = await fresh();
    const lead = await running(h, 'lead');
    const other = await running(h, 'wing');
    const refused = await h.request('POST', `/v1/ferrets/${other}/rename`, { ...as(lead), body: { name: 'finch' } });
    expect(refused.status).toBe(403);
    expect(JSON.parse(h.state('ferrets').raw(FerretFiles, other) as string).name).toBe('wing');
    const own = await h.request('POST', `/v1/ferrets/${lead}/rename`, { ...as(lead), body: { name: 'finch' } });
    expect(own.status).toBeLessThan(300);
  });
});

describe('a start that throws gives its claim back (F-0232)', () => {
  test('a start whose admission throws leaves the name free for the next start', async () => {
    const h = await fresh();
    const lead = await running(h, 'lead');
    // A helper start throws at admission (Packs admission is not bound), after the name was claimed.
    const thrown = await start(h, { name: 'wren', parent: lead });
    expect(thrown.status).toBeGreaterThanOrEqual(400);
    expect(ledger(h).claims.map(claim => claim.callsign)).not.toContain('wren');
  });
});
