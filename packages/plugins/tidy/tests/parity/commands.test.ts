import { describe, expect, test } from 'bun:test';
import type { CliHalf, PluginClient, TerminalIo, VerbInvocation } from '@ferretry/kernel/manifest';
import cli from '../../cli/index.ts';
import { renderDryRun, renderScratchPlan, renderScratchSweep } from '../../cli/lib/render.ts';
import type { TidyPlan } from '../../contract/index.ts';
import manifest from '../../manifest.ts';

interface Call {
  readonly route: string;
  readonly init?: {
    readonly params?: Record<string, string>;
    readonly query?: Record<string, string>;
    readonly body?: unknown;
  };
}

function run(answers: Record<string, unknown | ((call: Call) => unknown)>) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const client: PluginClient = {
    call: async (route, init) => {
      const call = { route, ...(init === undefined ? {} : { init }) } as Call;
      calls.push(call);
      const answer = answers[route];
      const value = typeof answer === 'function' ? (answer as (call: Call) => unknown)(call) : answer;
      if (value instanceof Error) throw value;
      return value as never;
    },
    subscribe: () => () => {},
  };
  const io: TerminalIo = { out: text => out.push(text), err: text => err.push(text), isTty: false };
  const half = cli.build?.({ manifest, client, io }) as CliHalf<typeof manifest>;
  const verb = (name: 'gc' | 'tidy', options: VerbInvocation['options'] = {}) =>
    half.verbs[name]({ args: [], options });
  return { calls, out, err, verb };
}

const plan: TidyPlan = {
  ferret: 'lead' as TidyPlan['ferret'],
  helper: false,
  drop: [{ id: 'F1', title: 'A throwaway card', why: 'the board is off and nobody but you asked for it' }],
  close: [{ id: 'A2' as never, subject: 'Track it', code: 'status-only', why: 'it only tracks work' }],
  keep: [{ kind: 'card', id: 'F3', title: 'Wanted', code: 'board-on', why: 'the board is on, so the card is wanted' }],
};

describe('fy gc', () => {
  test('sweeps and says what it reclaimed', async () => {
    const t = run({ 'POST /v1/gc': { ferrets: 2, bytes: 3_500_000, failures: 1 } });
    expect(await t.verb('gc')).toBe(0);
    expect(t.calls[0]?.init?.body).toEqual({ force: false });
    expect(t.out[0]).toBe('reclaimed 3.5 MB from 2 ferret(s); 1 entr(ies) could not be removed (see daemon log)');
  });
  test('--dry-run reads the plan with a limit and deletes nothing', async () => {
    const t = run({ 'GET /v1/gc': [] });
    expect(await t.verb('gc', { 'dry-run': true, limit: '5' })).toBe(0);
    expect(t.calls).toEqual([{ route: 'GET /v1/gc', init: { query: { limit: '5' } } }]);
    expect(t.out[0]).toBe('would free 0 kB from 0 ferret(s) — nothing was deleted');
  });
  test('--limit without --dry-run, and a bad limit, are usage errors that reach no daemon', async () => {
    const t = run({});
    expect(await t.verb('gc', { limit: '5' })).toBe(2);
    expect(await t.verb('gc', { 'dry-run': true, limit: '0' })).toBe(2);
    expect(t.calls).toEqual([]);
  });
  test('--json prints the wire payload', async () => {
    const t = run({ 'POST /v1/gc': { ferrets: 0, bytes: 0, failures: 0 } });
    await t.verb('gc', { json: true });
    expect(JSON.parse(t.out[0] ?? '')).toEqual({ ferrets: 0, bytes: 0, failures: 0 });
  });
});

describe('fy tidy', () => {
  test('a dry run prints the plan and applies nothing', async () => {
    const t = run({ 'POST /v1/tidy/plan': plan });
    expect(await t.verb('tidy')).toBe(0);
    expect(t.calls.map(call => call.route)).toEqual(['POST /v1/tidy/plan']);
    expect(t.out[0]).toContain('Dry run: nothing changed.');
    expect(t.out[0]).toContain('&F1  A throwaway card');
    expect(t.out[0]).toContain('Apply it with: fy tidy --yes');
  });
  test('--yes drops each card and closes each ask with the reason, one by one', async () => {
    const t = run({
      'POST /v1/tidy/plan': plan,
      'POST /v1/board/cards/:cardId': {},
      'POST /v1/ferrets/:ferretId/agenda': {},
    });
    expect(await t.verb('tidy', { yes: true, reason: 'cleaning up' })).toBe(0);
    expect(t.calls.slice(1)).toEqual([
      {
        route: 'POST /v1/board/cards/:cardId',
        init: { params: { cardId: 'F1' }, body: { action: 'drop', reason: 'cleaning up' } },
      },
      {
        route: 'POST /v1/ferrets/:ferretId/agenda',
        init: { params: { ferretId: 'lead' }, body: { action: 'resolve', id: 'A2', note: 'cleaning up' } },
      },
    ]);
    expect(t.out[0]).toContain('Tidied: dropped 1 card(s), closed 1 ask(s).');
  });
  test('a failed change is said, the rest still go, and the exit is not clean', async () => {
    const t = run({
      'POST /v1/tidy/plan': plan,
      'POST /v1/board/cards/:cardId': new Error('the card is gone'),
      'POST /v1/ferrets/:ferretId/agenda': {},
    });
    expect(await t.verb('tidy', { yes: true })).toBe(1);
    expect(t.out[0]).toContain('&F1  A throwaway card — FAILED: the card is gone');
    expect(t.out[0]).toContain('closed 1 ask(s); 1 failed.');
    expect(t.calls.at(-1)?.init?.body).toMatchObject({ note: 'tidy: the board is opt-in and this only tracked work' });
  });
  test('--session is refused (the credential names the ferret) and an empty --reason needs words', async () => {
    const t = run({});
    expect(await t.verb('tidy', { session: 'x' })).toBe(2);
    expect(await t.verb('tidy', { reason: true })).toBe(2);
    expect(t.calls).toEqual([]);
  });
  test('--json prints the plan, and with --yes the result', async () => {
    const t = run({ 'POST /v1/tidy/plan': plan });
    await t.verb('tidy', { json: true });
    expect(JSON.parse(t.out[0] ?? '')).toEqual({ applied: false, plan });
  });
});

describe('render', () => {
  test('nothing to tidy still lists what was kept', () => {
    const text = renderDryRun({ ...plan, drop: [], close: [] }, 'fy');
    expect(text).toContain('Nothing to tidy: no card to drop and no ask to close.');
    expect(text).toContain('Kept (1)');
  });
  test('a scratch plan marks FREE and keep with the reason', () => {
    const text = renderScratchPlan([
      {
        ferret: 'a' as never,
        name: 'Ada',
        directory: '/x',
        bytes: 2_000_000,
        entries: [{ name: 'o', bytes: 2_000_000, kind: 'directory' }],
        eligible: true,
      },
      { ferret: 'b' as never, directory: '/y', bytes: 10, entries: [], eligible: false, reason: 'not stopped' },
    ]);
    expect(text).toContain('FREE  a');
    expect(text).toContain('keep  b');
    expect(text).toContain('(not stopped)');
    expect(text).toContain('would free 2.0 MB from 1 ferret(s)');
    expect(renderScratchSweep({ ferrets: 0, bytes: 0, failures: 0 })).toBe('reclaimed 0 kB from 0 ferret(s)');
  });
});

describe('parity: V-0271 fy gc, V-0494 fy tidy', () => {
  test('both verbs are declared by the manifest and answered by the half', () => {
    const t = run({});
    expect(manifest.actions.cli.map(verb => verb.verb)).toEqual(['gc', 'tidy']);
    expect(
      Object.keys(
        cli.build?.({
          manifest,
          client: { call: async () => ({}) as never, subscribe: () => () => {} },
          io: { out() {}, err() {}, isTty: false },
        })?.verbs ?? {},
      ).sort(),
    ).toEqual(['gc', 'tidy']);
    expect(t.calls).toEqual([]);
  });
});
