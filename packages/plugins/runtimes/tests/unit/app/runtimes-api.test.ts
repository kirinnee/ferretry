import { describe, expect, it } from 'bun:test';
import { RUNTIMES_ROUTE, readNeedsRuntime, readRuntimes } from '../../../app/lib/runtimes-api.ts';
import { RUNTIMES } from './features/fleet/account-support.ts';
import { type Call, scripted } from './support/client.ts';

describe('readRuntimes', () => {
  it('reads the machine’s runtimes through the route key and parses them', async () => {
    const calls: Call[] = [];
    const catalog = await readRuntimes(scripted({ [RUNTIMES_ROUTE]: RUNTIMES }, calls));
    expect(catalog.runtimes.map(runtime => runtime.name)).toEqual(RUNTIMES.runtimes.map(runtime => runtime.name));
    expect(calls.map(call => call.route)).toEqual(['GET /v1/runtimes']);
  });

  it('refuses an answer that is not a runtime catalog', async () => {
    await expect(readRuntimes(scripted({ [RUNTIMES_ROUTE]: { runtimes: 'none' } }))).rejects.toThrow();
  });
});

describe('readNeedsRuntime', () => {
  it('says a machine with no runtime needs one, and one with a runtime does not', async () => {
    expect(await readNeedsRuntime(scripted({ [RUNTIMES_ROUTE]: { format: 'none', runtimes: [] } }))).toBe(true);
    expect(await readNeedsRuntime(scripted({ [RUNTIMES_ROUTE]: RUNTIMES }))).toBe(false);
  });

  it('claims nothing for a machine it cannot read', async () => {
    expect(await readNeedsRuntime(scripted({ [RUNTIMES_ROUTE]: new Error('unreachable') }))).toBeUndefined();
    expect(await readNeedsRuntime(scripted({}))).toBeUndefined();
  });
});
