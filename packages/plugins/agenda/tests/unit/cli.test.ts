import { describe, expect, test } from 'bun:test';
import type { PluginClient, TerminalIo, VerbInvocation } from '@ferretry/kernel/manifest';
import cli from '../../cli/index.ts';
import { composeNoticeRequest } from '../../cli/lib/notify.ts';
import { renderOpen } from '../../cli/lib/render.ts';

type Call = { route: string; init?: Parameters<PluginClient['call']>[1] };

function world(
  answers: Record<string, unknown>,
  terminal?: { readonly confirm: (question: string) => Promise<boolean> },
) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const client = {
    call: async (route: string, init?: Call['init']) => {
      calls.push({ route, ...(init === undefined ? {} : { init }) });
      const answer = answers[route];
      return typeof answer === 'function' ? (answer as (init?: Call['init']) => unknown)(init) : answer;
    },
    subscribe: () => () => undefined,
  } as unknown as PluginClient;
  const io: TerminalIo = {
    out: text => void out.push(text),
    err: text => void err.push(text),
    isTty: terminal !== undefined,
  };
  const half = cli.build?.({ manifest: cli.manifest, client, io, ...(terminal === undefined ? {} : terminal) });
  if (half === undefined) throw new Error('missing CLI half');
  const verb = (line: string, invocation: Partial<VerbInvocation> = {}) =>
    (half.verbs as Record<string, (i: VerbInvocation) => Promise<number>>)[line]?.({
      args: [],
      options: {},
      ...invocation,
    }) as Promise<number>;
  return { verb, calls, out, err };
}

describe('fy notify', () => {
  test('raises a plain notice on the ferret’s board and says the phone buzzes only with --buzz', async () => {
    const quiet = world({ 'POST /v1/ferrets/:ferretId/agenda': {} });
    expect(await quiet.verb('notify', { args: ['Build', 'is', 'green'], options: { ferret: 'f1' } })).toBe(0);
    expect(quiet.calls[0]?.init?.params).toEqual({ ferretId: 'f1' });
    expect(quiet.calls[0]?.init?.body).toMatchObject({ notice: true, subject: 'Build is green' });
    expect(quiet.calls[0]?.init?.body).not.toHaveProperty('ping');
    expect(quiet.out.join('')).not.toMatch(/buzz/u);
    const loud = world({ 'POST /v1/ferrets/:ferretId/agenda': {} });
    await loud.verb('notify', { args: ['Deploy needs you'], options: { ferret: 'f1', buzz: true } });
    expect(loud.calls[0]?.init?.body).toMatchObject({ ping: true });
    expect(loud.out.join('')).toMatch(/phone buzzes/u);
  });

  test('refuses an empty or two-line summary, and a missing ferret, without calling the daemon', async () => {
    const w = world({});
    expect(await w.verb('notify', { args: [], options: { ferret: 'f1' } })).toBe(1);
    expect(await w.verb('notify', { args: ['a\nb'], options: { ferret: 'f1' } })).toBe(1);
    expect(await w.verb('notify', { args: ['x'] })).toBe(1);
    expect(w.calls).toEqual([]);
  });

  test('cuts the card title at a word and keeps the whole summary as the subject', () => {
    const request = composeNoticeRequest(['word '.repeat(30)], {});
    expect(request.title.length).toBeLessThanOrEqual(40);
    expect(request.subject.length).toBeGreaterThan(40);
  });
});

const summary = (id: string, subject: string) => ({
  id,
  subject,
  kind: 'task',
  source: 'question',
  sourceRef: null,
  why: 'Ready',
  howToResolve: 'Choose',
  waitingSince: '2026-11-07T12:00:00.000Z',
  raisedBy: 'daemon',
  raisedBySession: null,
  raisedByName: null,
});

describe('fy agenda', () => {
  const page = { sessions: [{ sessionId: 'f1', items: [summary('A1', 'Pick a colour')] }] };

  test('prints each ferret with its asks, and says when nothing waits', async () => {
    const w = world({ 'GET /v1/agenda/open': page });
    expect(await w.verb('agenda')).toBe(0);
    expect(w.out.join('')).toContain('!A1 [task] Pick a colour');
    expect(renderOpen({ sessions: [] })).toBe('Nothing is waiting on you.');
  });

  test('follows every page for `agenda` and one page for `agenda open`', async () => {
    let served = 0;
    const answers = {
      'GET /v1/agenda/open': () =>
        ++served === 1 ? { ...page, next: 'f1' } : { sessions: [{ sessionId: 'f2', items: [summary('A1', 'Two')] }] },
    };
    const all = world(answers);
    await all.verb('agenda');
    expect(all.calls).toHaveLength(2);
    expect(all.out.join('')).toContain('f2');
    served = 0;
    const one = world(answers);
    await one.verb('agenda open');
    expect(one.calls).toHaveLength(1);
    expect(one.out.join('')).toContain('--after f1');
  });

  test('refuses a limit that is not a whole number', async () => {
    const w = world({});
    expect(await w.verb('agenda open', { options: { limit: 'many' } })).toBe(1);
  });
});

describe('fy agenda mode and clear', () => {
  test('reads and switches the mode of a named ferret', async () => {
    const w = world({
      'GET /v1/ferrets/:ferretId/agenda-mode': { enabled: false, restartRequired: false, note: 'Agenda mode is off.' },
      'PATCH /v1/ferrets/:ferretId/agenda-mode': { enabled: true, note: 'takes effect at the next launch' },
    });
    await w.verb('agenda mode', { options: { ferret: 'f1' } });
    await w.verb('agenda mode', { args: ['on'], options: { ferret: 'f1' } });
    expect(w.out.join('')).toContain('Agenda mode is off.');
    expect(w.out.join('')).toContain('Agenda mode is now on.');
    expect(w.calls[1]?.init?.body).toEqual({ enabled: true });
    expect(await w.verb('agenda mode', { args: ['maybe'], options: { ferret: 'f1' } })).toBe(1);
  });

  test('counts first, goes ahead only with --yes, and a dry run changes nothing', async () => {
    const answers = { 'POST /v1/agenda/clear-agents': { cleared: 3, ferrets: 2 } };
    const refused = world(answers);
    expect(await refused.verb('agenda clear', { options: { agents: true } })).toBe(1);
    expect(refused.err.join('')).toContain('re-run with --yes');
    expect(refused.calls).toHaveLength(1);
    const dry = world(answers);
    expect(await dry.verb('agenda clear', { options: { agents: true, 'dry-run': true } })).toBe(0);
    expect(dry.out.join('')).toContain('would clear 3 open asks on 2 agent ferrets');
    const done = world(answers);
    expect(await done.verb('agenda clear', { options: { agents: true, yes: true } })).toBe(0);
    expect(done.calls.at(-1)?.init?.body).toEqual({});
    expect(done.out.join('')).toContain('cleared 3 open asks on 2 agent ferrets');
    expect(await world(answers).verb('agenda clear')).toBe(1);
  });
});

describe('fy agenda clear: it says so when it cleared less than it listed', () => {
  const route = 'POST /v1/agenda/clear-agents';
  /** A daemon that lists `found` on the dry run and then clears `went`. */
  const answering = (found: { cleared: number; ferrets: number }, went: { cleared: number; ferrets: number }) => ({
    [route]: (init?: Call['init']) =>
      (init?.body as { dryRun?: boolean } | undefined)?.dryRun === true ? found : went,
  });

  test('exits 1 and names both counts when fewer went than the dry run listed', async () => {
    const w = world(answering({ cleared: 1, ferrets: 1 }, { cleared: 0, ferrets: 0 }));
    expect(await w.verb('agenda clear', { options: { agents: true, yes: true } })).toBe(1);
    expect(w.err.join('')).toContain(
      'only 0 open asks on 0 agent ferrets were cleared, of the 1 open ask on 1 agent ferret',
    );
  });

  test('exits 0 only when every listed ask went', async () => {
    const w = world(answering({ cleared: 2, ferrets: 1 }, { cleared: 2, ferrets: 1 }));
    expect(await w.verb('agenda clear', { options: { agents: true, yes: true } })).toBe(0);
  });

  test('asks at a terminal instead of refusing, goes on a yes and stops on a no', async () => {
    const asked: string[] = [];
    const yes = world(answering({ cleared: 2, ferrets: 1 }, { cleared: 2, ferrets: 1 }), {
      confirm: async question => {
        asked.push(question);
        return true;
      },
    });
    expect(await yes.verb('agenda clear', { options: { agents: true } })).toBe(0);
    expect(asked).toEqual(['Dismiss 2 open asks on 1 agent ferret? [y/N]']);
    expect(yes.out.join('')).toContain('cleared 2 open asks on 1 agent ferret');
    const no = world(answering({ cleared: 2, ferrets: 1 }, { cleared: 2, ferrets: 1 }), { confirm: async () => false });
    expect(await no.verb('agenda clear', { options: { agents: true } })).toBe(0);
    expect(no.out.join('')).toContain('Nothing was cleared.');
    expect(
      no.calls.filter(call => (call.init?.body as { dryRun?: boolean } | undefined)?.dryRun !== true),
    ).toHaveLength(0);
  });
});

describe('composeNoticeRequest bounds', () => {
  test('refuses a summary or a body longer than the daemon takes, saying how long it was', () => {
    expect(() => composeNoticeRequest(['x'.repeat(241)], {})).toThrow(/the summary is 241 characters; keep it to 240/u);
    expect(() => composeNoticeRequest(['ok'], { body: 'y'.repeat(200_001) })).toThrow(
      /--body is 200001 characters; the most it takes is 200000/u,
    );
  });
});
