import { describe, expect, test } from 'bun:test';
import type { PluginClient, VerbInvocation } from '@ferretry/kernel/manifest';
import { DEFAULT_LAYOUT, DEFAULT_THEME } from '../../contract/index.ts';
import cli, { DEVICE_SENTENCE } from '../../cli/index.ts';
import manifest from '../../manifest.ts';

interface Sent {
  readonly route: string;
  readonly body?: unknown;
}

function harness(answers: Record<string, unknown> = {}) {
  const sent: Sent[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const client: PluginClient = {
    call: async (route, init) => {
      sent.push({ route, ...(init?.body === undefined ? {} : { body: init.body }) });
      return answers[route] as never;
    },
    subscribe: () => () => {},
  };
  const build = cli.build;
  if (build === undefined) throw new Error('the layouts cli half has no build');
  const verbs = build({ manifest, client, io: { out: t => out.push(t), err: t => err.push(t), isTty: false } })
    .verbs as Record<string, (i: VerbInvocation) => Promise<number>>;
  const run = (verb: string, args: string[] = [], options: VerbInvocation['options'] = {}) =>
    (verbs[verb] as (i: VerbInvocation) => Promise<number>)({ args, options });
  return { sent, out, err, run };
}

const current = { layout: DEFAULT_LAYOUT, theme: DEFAULT_THEME };

describe('fy layout and fy theme', () => {
  test('every verb the manifest declares has a handler', () => {
    const half = harness().run;
    expect(half).toBeDefined();
    const built = cli.build?.({ manifest, client: {} as PluginClient, io: { out() {}, err() {}, isTty: false } });
    expect(Object.keys(built?.verbs ?? {}).toSorted()).toEqual(manifest.actions.cli.map(verb => verb.verb).toSorted());
  });

  test('layout show prints the layout and theme in words, or JSON with --json', async () => {
    const { run, out } = harness({ 'GET /v1/layouts/current': current });
    expect(await run('layout show')).toBe(0);
    expect(out.join('\n')).toContain('nav      left, rail: agenda, ferrets, board, insights, settings');
    expect(out.join('\n')).toContain('theme    default');
    out.length = 0;
    await run('layout show', [], { json: true });
    expect(JSON.parse(out[0] as string)).toEqual(JSON.parse(JSON.stringify(current)));
  });

  test('layout list marks the layout and theme in use', async () => {
    const { run, out } = harness({
      'GET /v1/layouts': {
        layouts: [
          { id: 'default', origin: 'built-in' },
          { id: 'compact', origin: 'built-in' },
        ],
        themes: [{ id: 'default', origin: 'built-in' }],
        current: { layout: 'compact', theme: 'default' },
      },
    });
    await run('layout list');
    expect(out).toContain('    default  (built-in)');
    expect(out).toContain('  * compact  (built-in)');
    expect(out).toContain('  * default  (built-in)');
  });

  test('layout set sends one change; the rest of the words are the value', async () => {
    const { run, sent, out } = harness({ 'PATCH /v1/layouts/current': { current: DEFAULT_LAYOUT } });
    expect(await run('layout set', ['nav.items', 'agenda', 'board'])).toBe(0);
    expect(sent).toEqual([
      { route: 'PATCH /v1/layouts/current', body: { changes: [{ path: 'nav.items', value: 'agenda,board' }] } },
    ]);
    expect(out.length).toBeGreaterThan(0);
  });

  test('layout use, theme use and layout save each make their one call', async () => {
    const { run, sent } = harness({
      'PUT /v1/layouts/current': { current: DEFAULT_LAYOUT },
      'PUT /v1/layouts/theme': { current: DEFAULT_THEME },
      'POST /v1/layouts': { id: 'mine', origin: 'saved' },
      'POST /v1/layouts/reset': { current: DEFAULT_LAYOUT },
    });
    await run('layout use', ['compact']);
    await run('theme use', ['dusk']);
    await run('layout save', ['mine']);
    await run('layout reset');
    expect(sent).toEqual([
      { route: 'PUT /v1/layouts/current', body: { layout: 'compact' } },
      { route: 'PUT /v1/layouts/theme', body: { theme: 'dusk' } },
      { route: 'POST /v1/layouts', body: { id: 'mine' } },
      { route: 'POST /v1/layouts/reset' },
    ]);
  });

  test('theme list prints the themes with the one in use marked', async () => {
    const { run, out } = harness({
      'GET /v1/layouts/themes': {
        themes: [
          { id: 'default', origin: 'built-in' },
          { id: 'dusk', origin: 'saved' },
        ],
        current: 'dusk',
      },
    });
    await run('theme list');
    expect(out).toEqual(['  default  (built-in)', '* dusk  (saved)']);
  });

  test('a verb without what it needs is a usage error (2) and calls nothing', async () => {
    const { run, sent, err } = harness();
    for (const [verb, args] of [
      ['layout set', []],
      ['layout set', ['nav.side']],
      ['layout use', []],
      ['layout save', []],
      ['theme use', []],
    ] as const)
      expect(await run(verb, [...args])).toBe(2);
    expect(sent).toEqual([]);
    expect(err.every(line => line.startsWith('usage: '))).toBe(true);
  });

  test('--device is explained, not guessed: the daemon keeps no per-device layout', async () => {
    const { run, sent, err } = harness();
    for (const verb of ['layout set', 'layout use', 'layout reset', 'theme use'])
      expect(await run(verb, ['nav.side', 'right'], { device: true })).toBe(2);
    expect(sent).toEqual([]);
    expect(err.every(line => line === DEVICE_SENTENCE)).toBe(true);
  });
});
