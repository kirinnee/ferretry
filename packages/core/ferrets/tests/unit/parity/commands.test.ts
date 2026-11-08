import { describe, expect, test } from 'bun:test';
import type { PluginClient, VerbInvocation } from '@ferretry/kernel/manifest';
import cli from '../../../cli/index.ts';
import manifest from '../../../manifest.ts';

/** The names verb, run against a recording API: what it asks the daemon, and what it prints. */
function run(answers: Readonly<Record<string, unknown>>) {
  const calls: { readonly route: string; readonly init?: unknown }[] = [];
  const out: string[] = [];
  const client: PluginClient = {
    call: async (route, init) => {
      calls.push(init === undefined ? { route } : { route, init });
      return (answers[route] ?? {}) as never;
    },
    subscribe: () => () => undefined,
  };
  const half = cli.build?.({
    manifest,
    client,
    io: { out: text => out.push(text), err: () => undefined, isTty: false },
    clock: { now: () => '2026-11-06T09:00:00.000Z' as never, nowMs: () => 0 },
    sleep: async () => undefined,
  });
  if (half === undefined) throw new Error('the cli half is real');
  const verbs = half.verbs as Readonly<Record<string, (invocation: VerbInvocation) => Promise<number>>>;
  return { verbs, calls, out };
}

describe('commands parity', () => {
  test('V-0333 fy name -n 2 asks GET /v1/names for two and prints the names, one per line', async () => {
    const { verbs, calls, out } = run({ 'GET /v1/names': ['ash', 'elm'] });
    expect(await verbs.name?.({ args: [], options: { n: '2' } })).toBe(0);
    expect(calls).toEqual([{ route: 'GET /v1/names', init: { query: { count: '2' } } }]);
    expect(out.join('\n')).toBe('ash\nelm');
  });
});
