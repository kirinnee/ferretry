/** Parity row V-0250: `fy daemon update` is `fy update` (docs/design/rebuild-parity.tsv). */
import { describe, expect, test } from 'bun:test';
import type { PluginClient, TerminalIo, VerbInvocation } from '@ferretry/kernel/manifest';
import cli from '../../cli/index.ts';
import { DaemonUpdateViewSchema, planUpdate } from '../../contract/index.ts';
import manifest from '../../manifest.ts';

const method = { kind: 'nix-profile', element: 'ferretry' } as const;
const view = (overrides: Record<string, unknown> = {}) =>
  DaemonUpdateViewSchema.parse({
    current: '4.28.0',
    method,
    plan: planUpdate(method, { product: 'ferretry', clientName: 'fy' }),
    check: {
      state: 'ok',
      checkedAt: '2026-10-18T09:00:00.000Z',
      latest: { version: '4.29.0', url: 'https://github.com/kirinnee/ferretry/releases/tag/v4.29.0' },
    },
    available: true,
    midTurn: 0,
    autoInstall: false,
    job: null,
    ...overrides,
  });

function run(options: VerbInvocation['options']) {
  const calls: { route: string; body: unknown }[] = [];
  const out: string[] = [];
  const io: TerminalIo = { out: text => void out.push(text), err: text => void out.push(text), isTty: false };
  const client: PluginClient = {
    call: (async (route: string, init?: { body?: unknown }) => {
      calls.push({ route, body: init?.body });
      return route.startsWith('POST')
        ? view({ job: { state: 'running', target: '4.29.0', startedAt: '2026-10-18T09:59:00.000Z' } })
        : view();
    }) as PluginClient['call'],
    subscribe: () => () => undefined,
  };
  const half = cli.build?.({ manifest, client, io });
  return { calls, out, verb: () => half?.verbs.update({ args: [], options }) };
}

describe('fy update', () => {
  test('V-0250 the verb is `update`, and it asks the daemon about itself', async () => {
    expect(manifest.actions.cli.map(verb => verb.verb)).toEqual(['update']);
    const checked = run({ check: true });
    expect(await checked.verb()).toBe(0);
    expect(checked.calls).toEqual([{ route: 'GET /v1/daemon/update', body: undefined }]);
  });

  test('V-0250 --yes --to --when-idle start the version the person named, now or when no ferret is mid-turn', async () => {
    const now = run({ yes: true, to: '4.29.0' });
    await now.verb();
    expect(now.calls.at(-1)).toEqual({ route: 'POST /v1/daemon/update', body: { target: '4.29.0', when: 'now' } });
    const idle = run({ yes: true, 'when-idle': true });
    await idle.verb();
    expect(idle.calls.at(-1)).toEqual({
      route: 'POST /v1/daemon/update',
      body: { target: '4.29.0', when: 'when-idle' },
    });
  });

  test('V-0250 --json prints the view the daemon answered', async () => {
    const json = run({ check: true, json: true });
    await json.verb();
    expect(DaemonUpdateViewSchema.parse(JSON.parse(json.out.join('')))).toMatchObject({ current: '4.28.0' });
  });

  test('V-0250 --report and --switch-to-profile belong to the transaction (--run), which waits on the shell’s machine ports', async () => {
    const run2 = run({ run: true, report: '/tmp/report.json', 'switch-to-profile': true });
    expect(await run2.verb()).toBe(69);
  });
});
