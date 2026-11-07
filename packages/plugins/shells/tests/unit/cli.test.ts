import { describe, expect, test } from 'bun:test';
import type { PluginClient, VerbInvocation } from '@ferretry/kernel/manifest';
import cli from '../../cli/index.ts';
import manifest from '../../manifest.ts';
import { flakeFacts, HASH_A, HASH_B, REV_A } from './support.ts';

interface Sent {
  readonly route: string;
  readonly body?: unknown;
  readonly params?: unknown;
}

function harness(answers: Record<string, unknown> = {}) {
  const sent: Sent[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const client: PluginClient = {
    call: async (route, init) => {
      sent.push({
        route,
        ...(init?.body === undefined ? {} : { body: init.body }),
        ...(init?.params === undefined ? {} : { params: init.params }),
      });
      return answers[route] as never;
    },
    subscribe: () => () => {},
  };
  const build = cli.build;
  if (build === undefined) throw new Error('the shells cli half has no build');
  const verbs = build({ manifest, client, io: { out: t => out.push(t), err: t => err.push(t), isTty: false } })
    .verbs as Record<string, (i: VerbInvocation) => Promise<number>>;
  const run = (verb: string, args: string[] = [], options: VerbInvocation['options'] = {}) =>
    (verbs[verb] as (i: VerbInvocation) => Promise<number>)({ args, options });
  return { sent, out, err, run, verbs };
}

const facts = flakeFacts();
const lock = {
  format: 1,
  name: 'web',
  source: { kind: 'flake', ref: `${facts.url}#web`, rev: REV_A, narHash: HASH_A },
  resolvedAt: '2026-11-07T10:00:00.000Z',
  floating: false,
};

describe('fy shell', () => {
  test('every verb the manifest declares has a handler', () => {
    expect(Object.keys(harness().verbs).toSorted()).toEqual(manifest.actions.cli.map(verb => verb.verb).toSorted());
  });

  test('ls says how to add the first shell when there is none', async () => {
    const { run, out } = harness({ 'GET /v1/shells': { shells: [] } });
    await run('shell ls');
    expect(out[0]).toContain('fy shell add');
  });

  test('ls lists each shell with whether it is locked and built', async () => {
    const { run, out } = harness({
      'GET /v1/shells': {
        shells: [{ name: 'web', kind: 'flake', locked: true, floating: false, build: 'not-built', usedBy: [] }],
      },
    });
    await run('shell ls');
    expect(out).toEqual(['web  flake, locked, not built']);
  });

  test('add without --yes previews, shows what it resolved to, and pins nothing', async () => {
    const { run, sent, out } = harness({ 'POST /v1/shells/preview': { name: 'web', lock } });
    expect(await run('shell add', ['web'], { flake: `github:me/shells/${REV_A}#web` })).toBe(0);
    expect(sent.map(call => call.route)).toEqual(['POST /v1/shells/preview']);
    expect(out.join('\n')).toContain(HASH_A);
    expect(out.at(-1)).toContain('--yes');
  });

  test('add --yes pins it, and a held shell says it waits for confirmation', async () => {
    const { run, sent, out } = harness({
      'POST /v1/shells/preview': { name: 'tools', lock },
      'POST /v1/shells': { name: 'tools', lock, held: ['a new shell will build git'] },
    });
    await run('shell add', ['tools'], { packages: 'git, jq', yes: true, floating: true });
    expect(sent[1]).toEqual({
      route: 'POST /v1/shells',
      body: { name: 'tools', item: { packages: ['git', 'jq'], floating: true } },
    });
    expect(out.join('\n')).toContain('waiting for your confirmation');
    expect(out.join('\n')).toContain('a new shell will build git');
  });

  test('add needs a name and exactly one of --flake and --packages', async () => {
    const { run, sent, err } = harness();
    expect(await run('shell add', [], { flake: 'x' })).toBe(2);
    expect(await run('shell add', ['a'], {})).toBe(2);
    expect(await run('shell add', ['a'], { flake: 'x', packages: 'git' })).toBe(2);
    expect(sent).toEqual([]);
    expect(err.every(line => line.startsWith('usage: '))).toBe(true);
  });

  test('relock shows a changed hash and waits for --yes; an unchanged one relocks at once', async () => {
    const moved = { name: 'web', lock: { ...lock, source: { ...lock.source, narHash: HASH_B } }, changedFrom: HASH_A };
    const item = { flake: 'github:me/shells#web', floating: true };
    const first = harness({ 'GET /v1/shells/:name': { item }, 'POST /v1/shells/preview': moved });
    await first.run('shell relock', ['web']);
    expect(first.sent.map(call => call.route)).toEqual(['GET /v1/shells/:name', 'POST /v1/shells/preview']);
    expect(first.out[0]).toContain(`was ${HASH_A}`);

    const second = harness({
      'GET /v1/shells/:name': { item },
      'POST /v1/shells/preview': moved,
      'POST /v1/shells/:name/relock': moved,
    });
    await second.run('shell relock', ['web'], { yes: true });
    expect(second.sent.at(-1)).toEqual({ route: 'POST /v1/shells/:name/relock', params: { name: 'web' } });

    const same = harness({
      'GET /v1/shells/:name': { item },
      'POST /v1/shells/preview': { name: 'web', lock },
      'POST /v1/shells/:name/relock': { name: 'web', lock },
    });
    await same.run('shell relock', ['web']);
    expect(same.sent.at(-1)?.route).toBe('POST /v1/shells/:name/relock');
  });

  test('build, rm, show and nix each make their call and speak plainly', async () => {
    const { run, sent, out } = harness({
      'POST /v1/shells/:name/build': { name: 'web', narHash: HASH_A, outcome: 'cached', builtAt: 'x' },
      'DELETE /v1/shells/:name': { name: 'web', removed: true },
      'GET /v1/shells/nix': { present: false, consequence: 'ferrets use the machine’s tools', remedy: 'install nix' },
      'GET /v1/shells/:name': { name: 'web', item: { flake: 'x', floating: false }, summary: { build: 'built' }, lock },
    });
    await run('shell build', ['web']);
    await run('shell rm', ['web']);
    await run('shell nix');
    await run('shell show', ['web']);
    expect(out).toContain('web was already built');
    expect(out).toContain('removed web');
    expect(out).toContain('install nix');
    expect(out.join('\n')).toContain(`narHash  ${HASH_A}`);
    expect(sent.map(call => call.route)).toEqual([
      'POST /v1/shells/:name/build',
      'DELETE /v1/shells/:name',
      'GET /v1/shells/nix',
      'GET /v1/shells/:name',
    ]);
  });

  test('a verb without its name is a usage error and calls nothing', async () => {
    const { run, sent } = harness();
    for (const verb of ['shell show', 'shell relock', 'shell build', 'shell rm']) expect(await run(verb)).toBe(2);
    expect(sent).toEqual([]);
  });
});
