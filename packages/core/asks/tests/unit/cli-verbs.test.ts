/**
 * The verbs a ferret raises and follows its own ask with (`fy agenda add|show|ls|done|dismiss`) are Asks' (core), so they
 * work with the Agenda plugin off: the same words as Agenda's owner-side ones, one implementation (Agenda's controller
 * extends this controller). Here only Asks' half is built: no Agenda, no Board.
 */
import { describe, expect, test } from 'bun:test';
import type { PluginClient, TerminalIo, VerbInvocation } from '@ferretry/kernel/manifest';
import cli from '../../cli/index.ts';
import manifest from '../../manifest.ts';
import { agentItem, snapshot } from './cli/fixtures.ts';

const BOARD = 'GET /v1/ferrets/:ferretId/agenda';
const ACT = 'POST /v1/ferrets/:ferretId/agenda';
const OPEN_ITEM = agentItem('A3', 'pick a relay', { title: 'Relay' });

function run(options: { readonly env?: Record<string, string>; readonly tty?: boolean } = {}) {
  const calls: { route: string; init?: { params?: Record<string, string>; body?: unknown } }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const board = snapshot([OPEN_ITEM], { sessionId: 'f1' });
  const answers: Record<string, unknown> = {
    [BOARD]: board,
    [ACT]: board,
    'GET /v1/ferrets/:ferretId/agenda/:id': OPEN_ITEM,
  };
  const client: PluginClient = {
    call: async (route, init) => {
      calls.push({ route, ...(init === undefined ? {} : { init: init as never }) });
      return answers[route] as never;
    },
    subscribe: () => () => {},
  };
  const io: TerminalIo = { out: text => out.push(text), err: text => err.push(text), isTty: options.tty === true };
  const half = cli.build?.({
    manifest,
    client,
    io,
    env: options.env ?? { FY_SESSION_ID: 'f1' },
    readText: async () => '',
    clock: { now: () => ({}) as never, nowMs: () => Date.parse('2026-11-22T09:00:00.000Z') },
    ...(options.tty === true ? { confirm: async () => false } : {}),
  });
  if (half === undefined) throw new Error('missing CLI half');
  const verb = async (name: string, args: string[] = [], flags: VerbInvocation['options'] = {}) =>
    await (half.verbs as unknown as Record<string, (invocation: VerbInvocation) => Promise<number>>)[name]?.({
      args,
      options: flags,
    });
  const posted = () => calls.filter(call => call.route === ACT).map(call => call.init?.body as Record<string, unknown>);
  return { calls, out, err, verb, posted, half };
}

describe('the raise verbs, with the Agenda plugin off', () => {
  test('Asks declares every item verb and notify, and the half implements exactly those', () => {
    const declared = (manifest.actions?.cli ?? []).map(entry => entry.verb).sort();
    expect(declared).toHaveLength(21);
    expect(declared).toContain('notify');
    expect(declared).not.toContain('agenda open');
    expect(declared).not.toContain('agenda mode');
    expect(Object.keys(run().half.verbs).sort()).toEqual(declared);
  });

  test('fy agenda add raises the ask on the ferret’s own board, with the words and the brief it was given', async () => {
    const t = run();
    const code = await t.verb('agenda add [ask...]', ['Which', 'region?'], {
      title: 'Region',
      premise: ['The relay ships Friday'],
      context: ['Two regions are near'],
      new: 'none of the open ones fits',
    });
    expect(code).toBe(0);
    expect(t.calls.find(call => call.route === ACT)?.init?.params).toEqual({ ferretId: 'f1' });
    expect(t.posted()[0]).toMatchObject({ action: 'add', subject: 'Which region?', title: 'Region' });
    expect(t.out.join('')).toMatch(/agenda .* recorded/u);
  });

  test('fy agenda add refuses a bad flag with its sentence and exit 1, and calls nothing', async () => {
    const t = run();
    expect(await t.verb('agenda add [ask...]', ['x'], { nonsense: true })).toBe(1);
    expect(t.err.join('')).toContain('unknown option --nonsense');
    expect(t.calls).toEqual([]);
  });

  test('fy agenda add says why it failed when the brief is missing', async () => {
    const t = run();
    expect(await t.verb('agenda add [ask...]', ['Which region?'], { title: 'Region' })).toBe(1);
    expect(t.err.join('')).toMatch(/--premise/u);
  });

  test('fy agenda ls, show, done and dismiss follow the ask on the same board', async () => {
    const t = run();
    expect(await t.verb('agenda ls')).toBe(0);
    expect(t.out.join('')).toContain('A3');
    expect(await t.verb('agenda show <id>', ['A3'])).toBe(0);
    expect(await t.verb('agenda done <id>', ['A3'], { note: 'shipped' })).toBe(0);
    expect(await t.verb('agenda dismiss <id>', ['A3'], { note: 'no longer needed' })).toBe(0);
    expect(t.posted().map(body => body.action)).toEqual(['resolve', 'dismiss']);
  });

  test('a person at a terminal is asked, and a ferret outside a session is told to name one', async () => {
    const asked = run({ tty: true });
    expect(await asked.verb('agenda ls')).toBe(0);
    const stray = run({ env: {} });
    expect(await stray.verb('agenda ls')).toBe(1);
    expect(stray.err.join('')).toContain('no session id');
  });

  test('a fy with no clock says so rather than guessing a time', async () => {
    const errors: string[] = [];
    const bare = cli.build?.({
      manifest,
      client: {
        call: async () => snapshot([], { sessionId: 'f1' }),
        subscribe: () => () => {},
      } as unknown as PluginClient,
      io: { out: () => {}, err: text => errors.push(text), isTty: false },
      env: { FY_SESSION_ID: 'f1' },
    });
    if (bare === undefined) throw new Error('missing CLI half');
    expect(
      await (bare.verbs as never as Record<string, (i: VerbInvocation) => Promise<number>>)['agenda ls']?.({
        args: [],
        options: {},
      }),
    ).toBe(1);
    expect(errors.join('')).toContain('no clock');
  });
});
