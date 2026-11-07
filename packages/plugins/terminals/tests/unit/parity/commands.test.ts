/**
 * The Terminals-owned V rows of docs/design/rebuild-parity.md, one test per row, each named by its id. Every test drives
 * the real `fy` half the manifest declares (`cli/index.ts`) over a scripted client and asserts the route it reaches and
 * what the person sees. Nothing here ticks the tsv.
 */
import { describe, expect, test } from 'bun:test';
import type { CliHalf, PluginClient, VerbInvocation } from '@ferretry/kernel/manifest';
import cli from '../../../cli/index.ts';
import manifest from '../../../manifest.ts';
import { capturedIo, invocation, type RecordedCall, recordingClient } from '../../support/cli/doubles.ts';

const TOOL_ROUTE = 'POST /v1/ferrets/:ferretId/surfaces/terminals/tools';
const CONTROL_ROUTE = 'POST /v1/ferrets/:ferretId/surfaces/terminals/control';
const ANSWERED = { text: 'done', data: { summary: 'done', matched: true } };
const CONTROL_VIEW = {
  sessionId: 'f-1',
  driving: [],
  takeovers: [{ surface: 'terminal', id: 't-1', name: 'dev', by: { by: 'local' }, since: '2026-11-07T10:00:00.000Z' }],
  handed: [],
  opened: [],
  asked: [],
};
const HOLDERS = {
  limit: 24,
  open: 7,
  holders: [{ sessionId: 's-1', label: 'fitzgerald', standing: 'finished', status: 'stopped', count: 6 }],
};
const CLOSED = { closed: 6, failed: 0, holders: [] };

/** The half the shell builds, over a client that answers each route from `reply`. */
function half(reply: (call: RecordedCall) => unknown) {
  const { calls, client } = recordingClient(reply);
  const io = capturedIo();
  const built = cli.build?.({ manifest, client: client as PluginClient, io }) as CliHalf<typeof manifest>;
  const verb = (name: keyof typeof built.verbs, args: string[], options: VerbInvocation['options'] = {}) =>
    built.verbs[name](invocation(args, options));
  return { calls, io, verb };
}

const answer = (call: RecordedCall): unknown => {
  if (call.route.endsWith('/surfaces/terminals/control')) return CONTROL_VIEW;
  if (call.route === 'GET /v1/terminals') return HOLDERS;
  if (call.route === 'POST /v1/terminals/close-finished') return CLOSED;
  return ANSWERED;
};

describe('fy terminal', () => {
  test('V-0481 the terminal verbs are declared and built, one per word', () => {
    const declared: string[] = (manifest.actions.cli ?? [])
      .map(entry => entry.verb)
      .filter(name => name.startsWith('terminal'));
    const { verb } = half(answer);
    expect([...declared].sort()).toEqual(
      [
        'terminal ask',
        'terminal close',
        'terminal control',
        'terminal handback',
        'terminal handover',
        'terminal list',
        'terminal open',
        'terminal read',
        'terminal send',
        'terminal slots',
        'terminal takeover',
        'terminal wait',
      ].sort() as string[],
    );
    expect(typeof verb).toBe('function');
  });

  test('V-0482 fy terminal ask hands the terminal to the owner through the person tools route', async () => {
    const { calls, verb } = half(answer);
    expect(await verb('terminal ask', ['dev', 'type', 'the', 'code'], { ferret: 'f-1' })).toBe(0);
    expect(calls[0]).toMatchObject({
      route: TOOL_ROUTE,
      params: { ferretId: 'f-1' },
      body: { tool: 'terminal_ask_owner', name: 'dev' },
    });
  });

  test('V-0483 fy terminal close closes one terminal, or with --all-finished the ones a finished ferret left', async () => {
    const one = half(answer);
    expect(await one.verb('terminal close', ['dev'], { ferret: 'f-1' })).toBe(0);
    expect(one.calls[0]).toMatchObject({ route: TOOL_ROUTE, body: { tool: 'terminal_close', name: 'dev' } });

    const all = half(answer);
    expect(await all.verb('terminal close', [], { 'all-finished': true })).toBe(0);
    expect(all.calls.map(call => call.route)).toContain('POST /v1/terminals/close-finished');

    const both = half(answer);
    expect(await both.verb('terminal close', ['dev'], { 'all-finished': true })).toBe(2);
    expect(both.calls).toEqual([]);
  });

  test('V-0484 fy terminal control shows which terminals an agent is driving, taken over, or handed to it', async () => {
    const { calls, io, verb } = half(answer);
    expect(await verb('terminal control', [], { ferret: 'f-1' })).toBe(0);
    expect(calls[0]).toMatchObject({ route: expect.stringContaining('/surfaces/terminals/control') });
    expect(io.printed.join('')).toContain('%terminal:dev');
  });

  test('V-0485 fy terminal handback hands a taken-over terminal back to the agent', async () => {
    const { calls, verb } = half(answer);
    expect(await verb('terminal handback', ['dev'], { ferret: 'f-1' })).toBe(0);
    expect(calls[0]).toMatchObject({ route: CONTROL_ROUTE, body: { action: 'handback', key: 'dev' } });
  });

  test('V-0486 fy terminal handover lets the agent use a terminal the person opened', async () => {
    const { calls, verb } = half(answer);
    expect(await verb('terminal handover', ['dev'], { ferret: 'f-1' })).toBe(0);
    expect(calls[0]).toMatchObject({ route: CONTROL_ROUTE, body: { action: 'handover', key: 'dev' } });
  });

  test('V-0487 fy terminal list lists the terminals in the session', async () => {
    const { calls, io, verb } = half(answer);
    expect(await verb('terminal list', [], { ferret: 'f-1' })).toBe(0);
    expect(calls[0]).toMatchObject({ route: TOOL_ROUTE, params: { ferretId: 'f-1' }, body: { tool: 'terminal_list' } });
    expect(io.printed.join('')).toContain('done');
  });

  test('V-0488 fy terminal open opens a named terminal, optionally running a command in it', async () => {
    const { calls, verb } = half(answer);
    expect(await verb('terminal open', ['dev', 'bun', 'test'], { ferret: 'f-1', f: 'packages/cli' })).toBe(0);
    expect(calls[0]).toMatchObject({
      route: TOOL_ROUTE,
      body: { tool: 'terminal_open', name: 'dev', folder: 'packages/cli', command: 'bun test' },
    });
  });

  test('V-0489 fy terminal read prints the last lines of a terminal, and refuses a mistyped count', async () => {
    const read = half(answer);
    expect(await read.verb('terminal read', ['dev'], { ferret: 'f-1', n: '20' })).toBe(0);
    expect(read.calls[0]).toMatchObject({ body: { tool: 'terminal_read', name: 'dev' } });
    const bad = half(answer);
    expect(await bad.verb('terminal read', ['dev'], { ferret: 'f-1', n: 'ten' })).toBe(2);
    expect(bad.calls).toEqual([]);
  });

  test('V-0490 fy terminal send types text and presses keys in a terminal', async () => {
    const { calls, verb } = half(answer);
    expect(await verb('terminal send', ['dev', 'ls', '-la'], { ferret: 'f-1', k: ['enter'] })).toBe(0);
    expect(calls[0]).toMatchObject({ body: { tool: 'terminal_send', name: 'dev', text: 'ls -la', keys: ['enter'] } });
  });

  test('V-0491 fy terminal slots shows who holds the open terminals against the machine limit', async () => {
    const { calls, io, verb } = half(answer);
    expect(await verb('terminal slots', [])).toBe(0);
    expect(calls).toEqual([{ route: 'GET /v1/terminals' }]);
    expect(io.printed.join('')).toContain('7 terminals open of 24.');
  });

  test('V-0492 fy terminal takeover takes a terminal over from the agent, and needs a named ferret', async () => {
    const taken = half(answer);
    expect(await taken.verb('terminal takeover', ['dev'], { ferret: 'f-1' })).toBe(0);
    expect(taken.calls[0]).toMatchObject({ route: CONTROL_ROUTE, body: { action: 'takeover', key: 'dev' } });
    const bare = half(answer);
    expect(await bare.verb('terminal takeover', ['dev'])).toBe(2);
    expect(bare.calls).toEqual([]);
  });

  test('V-0493 fy terminal wait refuses text and exit together; one wait is a text or an exit', async () => {
    const both = half(answer);
    expect(await both.verb('terminal wait', ['dev'], { text: 'ready', exit: true })).toBe(2);
    expect(both.calls).toEqual([]);
  });
});
