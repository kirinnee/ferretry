import { describe, expect, test } from 'bun:test';
import type { PluginClient, TerminalIo, VerbInvocation } from '@ferretry/kernel/manifest';
import cli from '../../cli/index.ts';
import { composeNoticeRequest } from '../../cli/lib/notify.ts';

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

  test("--ping, v4's spelling of --buzz, buzzes the phone too", async () => {
    const loud = world({ 'POST /v1/ferrets/:ferretId/agenda': {} });
    await loud.verb('notify', { args: ['Deploy needs you'], options: { ferret: 'f1', ping: true } });
    expect(loud.calls[0]?.init?.body).toMatchObject({ ping: true });
    const early = world({ 'POST /v1/ferrets/:ferretId/agenda': {} });
    await early.verb('notify', { args: ['for', 'you'], options: { ferret: 'f1', ping: 'Deploy' } });
    expect(early.calls[0]?.init?.body).toMatchObject({ ping: true, subject: 'Deploy for you' });
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

describe('composeNoticeRequest bounds', () => {
  test('refuses a summary or a body longer than the daemon takes, saying how long it was', () => {
    expect(() => composeNoticeRequest(['x'.repeat(241)], {})).toThrow(/the summary is 241 characters; keep it to 240/u);
    expect(() => composeNoticeRequest(['ok'], { body: 'y'.repeat(200_001) })).toThrow(
      /--body is 200001 characters; the most it takes is 200000/u,
    );
  });
});
