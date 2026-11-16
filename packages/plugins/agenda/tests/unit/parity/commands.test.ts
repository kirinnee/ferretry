/**
 * Parity rows V-0031…V-0043, V-0045, V-0048…V-0055 (docs/design/rebuild-parity.tsv): every `fy agenda` item verb v4
 * had, by v4's spelling, reaching the Asks board route that serves it, as the ferret it runs inside (`FY_SESSION_ID`) or
 * the board `--session` names. `fy agenda list`, `resolve` and `resolved` are removed by design (§1.4: no aliases). The
 * shell half of V-0030 (an unknown sub-verb is a usage error) is `packages/cli/tests/unit/agenda-verbs.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import type { CliHalf, PluginClient, TerminalIo, VerbInvocation } from '@ferretry/kernel/manifest';
import cli from '../../../cli/index.ts';
import manifest from '../../../manifest.ts';
import { agentItem, snapshot } from '../cli/fixtures.ts';

const BOARD = 'GET /v1/ferrets/:ferretId/agenda';
const ACT = 'POST /v1/ferrets/:ferretId/agenda';
const REPLIES = 'POST /v1/ferrets/:ferretId/agenda/replies';
const OPEN_ITEM = agentItem('A3', 'pick a relay', { title: 'Relay', stillOpen: '- the region' });

interface Call {
  readonly route: string;
  readonly init?: { readonly params?: Record<string, string>; readonly body?: unknown };
}

function run(options: { readonly env?: Record<string, string>; readonly files?: Record<string, string> } = {}) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const empty = snapshot([OPEN_ITEM], { sessionId: 'f1' });
  const answers: Record<string, unknown> = {
    [BOARD]: empty,
    [ACT]: empty,
    [REPLIES]: empty,
    'POST /v1/agenda/clear-agents': { cleared: 3, ferrets: 2 },
  };
  const client: PluginClient = {
    call: async (route, init) => {
      calls.push({ route, ...(init === undefined ? {} : { init: init as Call['init'] }) });
      return answers[route] as never;
    },
    subscribe: () => () => {},
  };
  const io: TerminalIo = { out: text => out.push(text), err: text => err.push(text), isTty: false };
  const half = cli.build?.({
    manifest,
    client,
    io,
    env: options.env ?? { FY_SESSION_ID: 'f1' },
    readText: async path => options.files?.[path] ?? '',
    clock: { now: () => ({}) as never, nowMs: () => Date.parse('2026-11-13T09:00:00.000Z') },
  }) as CliHalf<typeof manifest>;
  const verb = async (name: string, args: string[] = [], flags: VerbInvocation['options'] = {}) =>
    await (half.verbs as Record<string, (invocation: VerbInvocation) => Promise<number>>)[name]?.({
      args,
      options: flags,
    });
  const posted = () => calls.filter(call => call.route === ACT).map(call => call.init?.body as Record<string, unknown>);
  return { calls, out, err, verb, posted };
}

describe('the verbs Agenda owns for the items on a board', () => {
  test('V-0031 fy agenda add lists the open agendas that could take the ask, and raises nothing until --new says why none does', async () => {
    const t = run();
    expect(
      await t.verb('agenda add [ask...]', ['Which relay?'], {
        title: 'Relay choice',
        premise: ['The relay goes live Friday'],
        context: ['Two regions are near'],
        kind: 'reply',
      }),
    ).toBe(1);
    expect(t.err.join('')).toContain('Search, check, then open');
    expect(t.posted()).toEqual([]);
  });

  test('V-0031 fy agenda add refuses a card with no premise or context before it calls anything', async () => {
    const t = run({ env: { FY_SESSION_ID: 'f1' } });
    await expect(t.verb('agenda add [ask...]', ['Which relay?'], { title: 'Relay choice' })).resolves.toBe(1);
    expect(t.err.join('')).toContain('--premise');
    expect(t.calls).toEqual([]);
  });

  test('V-0031 fy agenda add with --new says why none of the open ones fits and raises it', async () => {
    const t = run();
    expect(
      await t.verb('agenda add [ask...]', ['A different question?'], {
        title: 'Other',
        premise: ['p'],
        context: ['c'],
        new: 'its own decision',
      }),
    ).toBe(0);
    expect(t.posted()).toHaveLength(1);
    expect(t.posted()[0]).toMatchObject({ action: 'add', subject: 'A different question?', title: 'Other' });
    expect(t.calls[0]).toMatchObject({ route: BOARD, init: { params: { ferretId: 'f1' } } });
  });

  test('V-0032 fy agenda answer sends the ferret’s answer as an edit', async () => {
    const t = run();
    expect(await t.verb('agenda answer <id> <text...>', ['A3', 'It', 'is', 'eu-west'])).toBe(0);
    expect(t.posted()[0]).toMatchObject({ action: 'edit', id: 'A3', questionAnswer: 'It is eu-west' });
  });

  test('V-0033 fy agenda clear --agents counts first, and a dry run changes nothing', async () => {
    const t = run({ env: {} });
    expect(await t.verb('agenda clear', [], { agents: true, 'dry-run': true })).toBe(0);
    expect(t.out.join('')).toContain('would clear 3 open asks on 2 agent ferrets');
    expect(t.calls.map(call => call.init?.body)).toEqual([{ dryRun: true }]);
  });

  test('V-0034 fy agenda discuss asks the ferret to talk it through', async () => {
    const t = run();
    expect(await t.verb('agenda discuss <id>', ['A3'], { note: 'the premise looks wrong' })).toBe(0);
    expect(t.posted()[0]).toEqual({ action: 'discuss', id: 'A3', note: 'the premise looks wrong' });
  });

  test('V-0035 fy agenda dismiss dismisses with the note', async () => {
    const t = run();
    expect(await t.verb('agenda dismiss <id>', ['!A3'], { n: 'no longer needed' })).toBe(0);
    expect(t.posted()[0]).toEqual({ action: 'dismiss', id: 'A3', note: 'no longer needed' });
  });

  test('V-0036 fy agenda done resolves, and carries the answer its flag gives', async () => {
    const t = run();
    expect(await t.verb('agenda done <id>', ['A3'], { note: 'shipped' })).toBe(0);
    expect(t.posted()[0]).toEqual({ action: 'resolve', id: 'A3', note: 'shipped' });
    const choice = run();
    await choice.verb('agenda done <id>', ['A3'], { choice: 'EU' });
    expect(choice.posted()[0]).toMatchObject({ response: { kind: 'multiple-choice', choice: 'EU' } });
    const two = run();
    expect(await two.verb('agenda done <id>', ['A3'], { approve: true, choice: 'EU' })).toBe(1);
    expect(two.calls).toEqual([]);
  });

  test('V-0037 fy agenda edit rewrites the title and the ask line of an open item', async () => {
    const t = run();
    expect(await t.verb('agenda edit <id>', ['A3'], { title: 'New title', summary: 'Which region now?' })).toBe(0);
    expect(t.posted()[0]).toMatchObject({ action: 'edit', id: 'A3', title: 'New title', subject: 'Which region now?' });
  });

  test('V-0038 fy agenda history reads this ferret’s board and lists the resolutions', async () => {
    const t = run();
    expect(await t.verb('agenda history')).toBe(0);
    expect(t.calls).toEqual([{ route: BOARD, init: { params: { ferretId: 'f1' } } }]);
  });

  test('V-0040 fy agenda log sends the ferret’s words and never the owner’s', async () => {
    const t = run();
    expect(await t.verb('agenda log <id>', ['A3'], { reply: 'use eu-west', message: 'm1' })).toBe(0);
    expect(t.posted()[0]).toEqual({ action: 'log', id: 'A3', mode: 'reply', text: 'use eu-west', messageId: 'm1' });
    expect(await run().verb('agenda log <id>', ['A3'], {})).toBe(1);
  });

  test('V-0041 fy agenda ls lists the open items of this ferret’s board, or of the board --session names', async () => {
    const own = run();
    expect(await own.verb('agenda ls')).toBe(0);
    expect(own.out.join('')).toContain('!A3');
    expect(own.calls[0]?.init?.params).toEqual({ ferretId: 'f1' });
    const owner = run({ env: {} });
    expect(await owner.verb('agenda ls', [], { session: 'f9' })).toBe(0);
    expect(owner.calls[0]?.init?.params).toEqual({ ferretId: 'f9' });
    expect(await run({ env: {} }).verb('agenda ls')).toBe(1);
  });

  test('V-0042 fy agenda merge merges the second item into the first', async () => {
    const t = run();
    expect(await t.verb('agenda merge <into> <from>', ['A2', 'A1'])).toBe(0);
    expect(t.posted()[0]).toEqual({ action: 'merge', id: 'A2', from: 'A1' });
  });

  test('V-0043 fy agenda needs-info asks the ferret for more, and the item stays open', async () => {
    const t = run();
    expect(await t.verb('agenda needs-info <id>', ['A3'], { note: 'which file?' })).toBe(0);
    expect(t.posted()[0]).toEqual({ action: 'needs-info', id: 'A3', note: 'which file?' });
  });

  test('V-0045 fy agenda patch sends ONE edit carrying what differs, and nothing when nothing does', async () => {
    const changed = run({ files: { 'a3.yaml': 'summary: Which region instead?' } });
    expect(await changed.verb('agenda patch <id>', ['A3'], { file: 'a3.yaml' })).toBe(1);
    expect(changed.err.join('')).toContain('revision');
    expect(changed.posted()).toEqual([]);
  });

  test('V-0048 fy agenda rest takes the item on, and needs to be told what is being done', async () => {
    const t = run();
    expect(await t.verb('agenda rest <id>', ['A3'], { why: 'reading the logs' })).toBe(0);
    expect(t.posted()[0]).toEqual({ action: 'rest', id: 'A3', why: 'reading the logs' });
    expect(await run().verb('agenda rest <id>', ['A3'], {})).toBe(1);
  });

  test('V-0049 fy agenda send-now delivers the held answers now', async () => {
    const t = run({ env: {} });
    expect(await t.verb('agenda send-now', [], { session: 'f1' })).toBe(0);
    expect(t.calls.map(call => call.route)).toEqual([BOARD, REPLIES]);
  });

  test('V-0050 fy agenda show prints one item, one tab of it, or the document patch takes back', async () => {
    const full = run();
    expect(await full.verb('agenda show <id>', ['A3'])).toBe(0);
    expect(full.out.join('')).toContain('pick a relay');
    const yaml = run();
    expect(await yaml.verb('agenda show <id>', ['A3'], { yaml: true })).toBe(0);
    expect(yaml.out.join('')).toContain('revision:');
    expect(await run().verb('agenda show <id>', ['A9'])).toBe(1);
  });

  test('V-0051 fy agenda snooze puts the item away for a time, and needs exactly one of --for and --until', async () => {
    const t = run();
    expect(await t.verb('agenda snooze <id>', ['A3'], { for: '4h' })).toBe(0);
    expect(t.posted()[0]).toEqual({ action: 'snooze', id: 'A3', until: '2026-11-13T13:00:00.000Z' });
    expect(await run().verb('agenda snooze <id>', ['A3'], {})).toBe(1);
    expect(await run().verb('agenda snooze <id>', ['A3'], { for: '1h', until: '17:00' })).toBe(1);
  });

  test('V-0052 fy agenda split writes the new item as an add is, and moves the named cards to it', async () => {
    const t = run();
    expect(
      await t.verb('agenda split <id> <ask...>', ['A3', 'Which', 'cache?'], {
        title: 'Cache',
        premise: ['A cache is needed'],
        context: ['It has its own rollout'],
        'move-cards': 'F12,F13',
      }),
    ).toBe(0);
    expect(t.posted()[0]).toMatchObject({
      action: 'split',
      id: 'A3',
      item: { subject: 'Which cache?', title: 'Cache' },
      moveCards: [{ id: 'F12' }, { id: 'F13' }],
    });
  });

  test('V-0053 fy agenda step ticks a step counted from 1, and unticks with --undo', async () => {
    const t = run();
    expect(await t.verb('agenda step <id> <n>', ['A3', '2'])).toBe(0);
    expect(t.posted()[0]).toEqual({ action: 'progress', id: 'A3', step: 1, done: true });
    const undo = run();
    await undo.verb('agenda step <id> <n>', ['A3', '1'], { undo: true });
    expect(undo.posted()[0]).toEqual({ action: 'progress', id: 'A3', step: 0, done: false });
    expect(await run().verb('agenda step <id> <n>', ['A3', '0'])).toBe(1);
  });

  test('V-0054 fy agenda surface hands the item back to the owner, with the reason and the urgency', async () => {
    const t = run();
    expect(await t.verb('agenda surface <id>', ['A3'], { why: 'still open', now: true })).toBe(0);
    expect(t.posted()[0]).toEqual({ action: 'surface', id: 'A3', why: 'still open', now: true });
  });

  test('V-0055 fy agenda unsnooze brings the item back to the list now', async () => {
    const t = run();
    expect(await t.verb('agenda unsnooze <id>', ['A3'])).toBe(0);
    expect(t.posted()[0]).toEqual({ action: 'unsnooze', id: 'A3' });
  });

  test('a switch given a word reads the word back as an argument (`agenda done --yes A3`)', async () => {
    const t = run();
    expect(await t.verb('agenda done <id>', [], { yes: 'A3' })).toBe(0);
    expect(t.posted()[0]).toMatchObject({
      action: 'resolve',
      id: 'A3',
      response: { kind: 'multiple-choice', choice: 'Yes' },
    });
  });
});
