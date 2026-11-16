import { describe, expect, test } from 'bun:test';
import { readingVerbs } from '../../../cli/reading/verbs.ts';

const harness = (answers: Record<string, unknown> = {}) => {
  const calls: Array<{ route: string; init?: unknown }> = [];
  const out: string[] = [];
  const err: string[] = [];
  const verbs = readingVerbs({
    client: {
      call: (async (route: string, init?: unknown) => {
        calls.push({ route, init });
        return answers[route];
      }) as never,
      subscribe: () => () => undefined,
    },
    io: { out: (text: string) => void out.push(text), err: (text: string) => void err.push(text), isTty: false },
  } as never);
  return { verbs, calls, out, err };
};

const run = (
  verb: (invocation: never) => Promise<number>,
  args: string[],
  options: Record<string, string | boolean> = {},
) => verb({ args, options } as never);

describe('the reading verbs', () => {
  test('logs reads the ferret tail with --turn and prints the text', async () => {
    const { verbs, calls, out } = harness({ 'GET /v1/ferrets/:ferretId/logs': 'user/message: hi' });
    expect(await run(verbs.logs, ['lead'], { turn: '2' })).toBe(0);
    expect(calls[0]).toEqual({
      route: 'GET /v1/ferrets/:ferretId/logs',
      init: { params: { ferretId: 'lead' }, query: { turn: '2' } },
    });
    expect(out.join('')).toBe('user/message: hi\n');
  });

  test('logs without a ferret is a usage error, exit 2, said on stderr', async () => {
    const { verbs, err } = harness();
    expect(await run(verbs.logs, [])).toBe(2);
    expect(err.join('')).toContain('name the ferret');
  });

  test('search prints aligned hits and says when more exist', async () => {
    const { verbs, out } = harness({
      'GET /v1/search': {
        hits: [
          {
            kind: 'card',
            id: 'F303',
            project: 'p',
            ferret: null,
            standing: 'In progress',
            title: 'Search backend',
            match: { field: 'title', line: 'Search backend' },
          },
          {
            kind: 'ask',
            id: 'A3',
            ferret: 'lead',
            standing: 'open',
            title: 'Pick one',
            match: { field: 'ask', line: 'which backend' },
          },
        ],
        total: 5,
        indexed: { cards: 4, asks: 1 },
        olderHidden: 2,
      },
    });
    expect(await run(verbs.search, ['backend'])).toBe(0);
    const text = out.join('');
    expect(text).toContain('&F303  card  In progress  Search backend');
    expect(text).toContain('!A3    ask   open         Pick one — which backend');
    expect(text).toContain('Showing 2 of 5');
    expect(text).toContain('2 older closed items hidden');
  });

  test('search refuses an unknown kind and an empty query', async () => {
    const { verbs } = harness();
    expect(await run(verbs.search, ['x'], { kind: 'task' })).toBe(2);
    expect(await run(verbs.search, [])).toBe(2);
  });

  test('render guide prints the overview with one line per type, and refuses an unknown type', async () => {
    const { verbs, out, err } = harness();
    expect(await run(verbs['render guide'], [])).toBe(0);
    expect(out.join('')).toContain('fy render guide mermaid');
    expect(await run(verbs['render guide'], ['hologram'])).toBe(2);
    expect(err.join('')).toContain('no type hologram');
    expect(await run(verbs.render, [])).toBe(0);
  });

  test('Q19 link keep sends the conversations as links and exits 1 when any is refused', async () => {
    const { verbs, calls, out } = harness({
      'POST /v1/links/conversations/keep': {
        kept: [{ id: 'c1', ferret: 'login-page', name: 'login page', state: 'stopped' }],
        refused: [{ id: 'c2', code: 'already_kept', reason: 'Ferret x already keeps it.' }],
      },
    });
    expect(await run(verbs['link keep'], ['claude-code', 'default', 'c1', 'c2'], { start: true })).toBe(1);
    expect(calls[0]?.init).toEqual({
      body: {
        harness: 'claude-code',
        runtime: 'default',
        conversations: [
          { id: 'c1', start: true },
          { id: 'c2', start: true },
        ],
      },
    });
    expect(out.join('')).toContain('kept c1 as login page');
    expect(out.join('')).toContain('refused c2');
  });

  test('link lists, with the kept-by mark, and link preview prints the exchanges', async () => {
    const { verbs, out } = harness({
      'GET /v1/links/conversations': {
        conversations: [
          {
            id: 'c1',
            harness: 'codex',
            project: '/w',
            preview: 'hello',
            lastActivityAt: '2026-02-01T09:05:00.000Z',
            turns: 3,
            turnsAtLeast: true,
            keptBy: 'lead',
          },
        ],
        matched: 1,
        skipped: 0,
      },
      'GET /v1/links/conversations/:harness/:conversationId/preview': {
        id: 'c1',
        harness: 'codex',
        messages: [{ role: 'user', text: 'hello' }],
      },
    });
    await run(verbs['link [query...]'], []);
    expect(out.join('')).toContain('3+ turns');
    expect(out.join('')).toContain('(kept by lead)');
    await run(verbs['link preview'], ['codex', 'c1']);
    expect(out.join('')).toContain('user: hello');
  });

  test('G41 transcript pages rows and prints the next cursor', async () => {
    const { verbs, calls, out } = harness({
      'GET /v1/ferrets/:ferretId/messages': {
        v: 1,
        ferret: 'lead',
        messages: [{ point: '10.0', role: 'user', text: 'please fix', selectionBinding: 'b' }],
        nextCursor: 'c2.abc',
      },
    });
    await run(verbs.transcript, ['lead'], { tail: true, limit: '5' });
    expect(calls[0]?.init).toEqual({ params: { ferretId: 'lead' }, query: { tail: '1', limit: '5' } });
    expect(out.join('')).toContain('10.0  user: please fix');
    expect(out.join('')).toContain('next: --cursor c2.abc');
  });
});
