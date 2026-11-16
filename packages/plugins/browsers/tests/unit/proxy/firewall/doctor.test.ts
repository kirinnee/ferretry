import { describe, expect, test } from 'bun:test';
import { loopbackFirewallDoctor } from '../../../../daemon/proxy/firewall/doctor.ts';
import type { LoopbackFirewallState } from '../../../../daemon/proxy/wire/firewall.ts';

const run = async (state: LoopbackFirewallState | undefined) => await loopbackFirewallDoctor(async () => state)();

describe('loopback-firewall: whether this account’s fixed browser ports are fenced (v4 loopbackFirewall row)', () => {
  test('V-0257 random ports have nothing to fence, so there is no row at all', async () => {
    expect(await run(undefined)).toBeUndefined();
  });

  test('V-0257 an applied firewall is an ok `loopback firewall` capability row', async () => {
    expect(await run({ state: 'applied', detail: 'applied' })).toEqual({
      state: 'ok',
      name: 'loopback firewall',
      requirement: 'capability',
      detail: 'applied',
      fix: 'Other users on this host cannot reach this account’s browser ports.',
    });
  });

  test('V-0257 every other state is a WARNING that carries the remedy, never a failure', async () => {
    const summaries = {
      failed: 'the last check reached this account’s ports from another user',
      missing: 'no firewall rule for this account in the marker at /run/ferretry/loopback-firewall.json',
      stale: 'the marker does not list this account’s ports',
      unverified: 'the 5-minute firewall check is not running',
    } as const;
    for (const [state, summary] of Object.entries(summaries) as [keyof typeof summaries, string][])
      expect(await run({ state, detail: `remedy for ${state}` })).toEqual({
        state: 'warn',
        name: 'loopback firewall',
        requirement: 'capability',
        detail: summary,
        fix: `remedy for ${state}`,
      });
  });

  test('V-0257 a reading that throws is no row', async () => {
    expect(
      await loopbackFirewallDoctor(async () => {
        throw new Error('boom');
      })(),
    ).toBeUndefined();
  });
});
