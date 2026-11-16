import { describe, expect, test } from 'bun:test';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { shellsClient } from '../../../app/lib/shells-client.ts';
import { ShellNameSchema } from '../../../contract/index.ts';
import { HASH_A, REV_A } from '../support.ts';

const lock = {
  format: 1,
  name: 'web',
  source: { kind: 'flake', ref: 'github:me/shells#web', rev: REV_A, narHash: HASH_A },
  resolvedAt: '2026-11-07T10:00:00.000Z',
  floating: false,
};
const summary = { name: 'web', kind: 'flake', locked: true, floating: false, build: 'built', usedBy: [] };

function harness() {
  const sent: { route: string; init: unknown }[] = [];
  const answers: Record<string, unknown> = {
    'GET /v1/shells': { shells: [summary] },
    'GET /v1/shells/:name': { name: 'web', item: { flake: 'github:me/shells#web' }, lock, summary },
    'GET /v1/shells/nix': { present: true, version: '2.24.1', path: 'nix' },
    'POST /v1/shells/preview': { name: 'web', lock },
    'POST /v1/shells': { name: 'web', lock },
    'POST /v1/shells/:name/relock': { name: 'web', lock, changedFrom: HASH_A },
    'POST /v1/shells/:name/build': {
      name: 'web',
      narHash: HASH_A,
      outcome: 'built',
      builtAt: '2026-11-07T10:00:00.000Z',
    },
    'DELETE /v1/shells/:name': { name: 'web', removed: true },
  };
  const client: PluginClient = {
    call: async (route, init) => {
      sent.push({ route, init });
      return answers[route] as never;
    },
    subscribe: () => () => {},
  };
  return { sent, shells: shellsClient(client), answers };
}

describe('the shells app client', () => {
  const web = ShellNameSchema.parse('web');
  const request = { name: web, item: { flake: 'github:me/shells#web' } } as never;

  test('each call goes to its own route and returns the parsed answer', async () => {
    const { sent, shells } = harness();
    expect(await shells.list()).toEqual([summary as never]);
    expect((await shells.detail(web)).name).toBe('web');
    expect(await shells.nix()).toMatchObject({ present: true });
    expect((await shells.preview(request)).name).toBe('web');
    expect((await shells.add(request)).name).toBe('web');
    expect((await shells.relock(web, HASH_A)).changedFrom).toBe(HASH_A);
    expect((await shells.build(web)).outcome).toBe('built');
    expect(await shells.remove(web)).toBeUndefined();
    expect(sent.map(call => call.route)).toEqual([
      'GET /v1/shells',
      'GET /v1/shells/:name',
      'GET /v1/shells/nix',
      'POST /v1/shells/preview',
      'POST /v1/shells',
      'POST /v1/shells/:name/relock',
      'POST /v1/shells/:name/build',
      'DELETE /v1/shells/:name',
    ]);
    expect(sent[5]?.init).toEqual({ params: { name: 'web' }, body: { expectedHash: HASH_A } });
  });

  test('an answer that does not match the contract is refused, not passed on', async () => {
    const { shells, answers } = harness();
    answers['POST /v1/shells/:name/relock'] = { nope: true };
    answers['DELETE /v1/shells/:name'] = { name: 'web', removed: false };
    await expect(shells.relock(web, HASH_A)).rejects.toThrow();
    await expect(shells.remove(web)).rejects.toThrow();
  });
});
