/** A command is answered synchronously from what was looked up before, and a name never looked up is not found. */
import { describe, expect, it } from 'bun:test';
import { CommandCache } from '../../../daemon/adapters/command-cache.ts';

describe('the command cache', () => {
  it('finds nothing before a prime, then the path the host found, and not found for a name the host did not find', async () => {
    const asked: string[] = [];
    const cache = new CommandCache(
      {
        which: async name => {
          asked.push(name);
          return name === 'claude' ? '/bin/claude' : undefined;
        },
      },
      () => 0,
    );
    expect(cache.which('claude')).toBeUndefined();

    await cache.prime(['claude', 'codex', 'claude']);

    expect(cache.which('claude')).toBe('/bin/claude');
    expect(cache.which('codex')).toBeUndefined();
    expect(asked.toSorted()).toEqual(['claude', 'codex']);
  });

  it('asks again only once the window has passed, so a tool installed since is seen by a later read', async () => {
    let now = 0;
    let installed = false;
    let asks = 0;
    const cache = new CommandCache(
      {
        which: async () => {
          asks += 1;
          return installed ? '/bin/codex' : undefined;
        },
      },
      () => now,
      1_000,
    );
    await cache.prime(['codex']);
    installed = true;
    now = 999;
    await cache.prime(['codex']);
    expect(cache.which('codex')).toBeUndefined();
    expect(asks).toBe(1);

    now = 1_000;
    await cache.prime(['codex']);

    expect(cache.which('codex')).toBe('/bin/codex');
    expect(asks).toBe(2);
  });

  it('counts a lookup that throws as not found and never throws itself', async () => {
    const cache = new CommandCache(
      {
        which: async () => {
          throw new Error('the lookup failed');
        },
      },
      () => 0,
    );

    await cache.prime(['claude']);

    expect(cache.which('claude')).toBeUndefined();
  });
});
