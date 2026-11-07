import { expect, test } from 'bun:test';
import type { PluginClient, TerminalIo } from '@ferretry/kernel/manifest';
import cli from '../../cli/index.ts';
import { DaemonUpdateViewSchema, planUpdate } from '../../contract/index.ts';
import manifest from '../../manifest.ts';

const method = { kind: 'nix-profile', element: 'ferretry' } as const;
const view = DaemonUpdateViewSchema.parse({
  current: '5.0.0',
  method,
  plan: planUpdate(method, { product: 'ferretry', clientName: 'fy' }),
  check: { state: 'never' },
  available: false,
  midTurn: 0,
  autoInstall: false,
  job: null,
});

test('the Updates CLI only reads the daemon cached state; the shell owns the transaction', async () => {
  const calls: string[] = [];
  const output: string[] = [];
  const client: PluginClient = {
    call: async route => {
      calls.push(route);
      return view as never;
    },
    subscribe: () => () => {},
  };
  const io: TerminalIo = {
    out: text => {
      output.push(text);
    },
    err: () => {},
    isTty: false,
  };
  const half = cli.build?.({ manifest, client, io });
  expect(Object.keys(half?.verbs ?? {})).toEqual(['update check']);
  expect(await half?.verbs['update check']({ args: [], options: { json: true } })).toBe(0);
  expect(calls).toEqual(['GET /v1/daemon/update']);
  expect(JSON.parse(output.join(''))).toEqual(view);
});
