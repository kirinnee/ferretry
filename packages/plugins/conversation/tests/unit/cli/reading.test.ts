import { describe, expect, test } from 'bun:test';
import { readingVerbs } from '../../../cli/reading/verbs.ts';

const harness = (answers: Record<string, unknown> = {}, clock?: { nowMs(): number }) => {
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
    ...(clock === undefined ? {} : { clock }),
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
    expect(text).toContain('^A3    ask   open         Pick one — which backend');
    expect(text).toContain('Showing 2 of 5');
    expect(text).toContain('2 older closed items hidden');
  });

  test('search refuses an unknown kind and an empty query', async () => {
    const { verbs } = harness();
    expect(await run(verbs.search, ['x'], { kind: 'hologram' })).toBe(2);
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

  test('render guide answers for the task type, and still for the card name an older agent types', async () => {
    const { verbs, out } = harness();
    expect(await run(verbs['render guide'], [])).toBe(0);
    expect(out.join('')).toContain('fy render guide task');
    expect(out.join('')).not.toContain('fy render guide card');
    out.length = 0;
    expect(await run(verbs['render guide'], ['task'])).toBe(0);
    const task = out.join('');
    expect(task).toContain('`task` and `board` point at tasks on the board');
    out.length = 0;
    expect(await run(verbs['render guide'], ['board'])).toBe(0);
    expect(out.join('')).toBe(task);
    out.length = 0;
    expect(await run(verbs['render guide'], ['card'])).toBe(0);
    expect(out.join('')).toBe(task);
  });

  test('search takes task and the former card for --kind, and refuses anything else', async () => {
    const { verbs, calls } = harness({ 'GET /v1/search': { hits: [], total: 0, indexed: { cards: 0, asks: 0 } } });
    expect(await run(verbs.search, ['x'], { kind: 'task' })).toBe(0);
    expect(await run(verbs.search, ['x'], { kind: 'card' })).toBe(0);
    expect(calls.map(call => (call.init as { query: { kind: string } }).query.kind)).toEqual(['task', 'card']);
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

  test('link prints a name on every row (the ferret’s name leads), says when a copy is also in the owner’s history, and says the index is still being read', async () => {
    const { verbs, out } = harness({
      'GET /v1/links/conversations': {
        conversations: [
          {
            id: 'c1',
            harness: 'claude-code',
            project: '/w',
            name: 'Billing scout — Invoice dig',
            ferretName: 'Billing scout',
            title: 'Invoice dig',
            preview: 'look at invoices',
            lastActivityAt: '2026-02-01T09:05:00.000Z',
            turns: 3,
            keptIn: 'ferretry',
            alsoOnComputer: true,
          },
          {
            id: 'c2',
            harness: 'codex',
            project: '/w',
            preview: 'take notes\nfor the meeting',
            lastActivityAt: '2026-02-01T08:05:00.000Z',
            turns: 1,
          },
        ],
        matched: 2,
        skipped: 0,
        indexing: true,
      },
    });
    await run(verbs['link [query...]'], []);
    const text = out.join('');
    expect(text).toContain('Billing scout — Invoice dig');
    expect(text).toContain('(also in your own history)');
    expect(text).toContain('take notes for the meeting');
    expect(text).toContain('Still reading your conversation history');
  });

  test('link --since <n>d|h|w goes to the wire as the ISO instant that long ago (v4’s sinceInstant), by the shell’s clock', async () => {
    const now = Date.parse('2026-03-10T12:00:00.000Z');
    const empty = { 'GET /v1/links/conversations': { conversations: [], matched: 0, skipped: 0 } };
    for (const [typed, instant] of [
      ['7d', '2026-03-03T12:00:00.000Z'],
      ['3h', '2026-03-10T09:00:00.000Z'],
      ['2w', '2026-02-24T12:00:00.000Z'],
    ] as const) {
      const { verbs, calls } = harness(empty, { nowMs: () => now });
      expect(await run(verbs['link [query...]'], ['login'], { since: typed, harness: 'codex' })).toBe(0);
      expect(calls[0]?.init).toEqual({ query: { q: 'login', harness: 'codex', since: instant } });
    }
  });

  test('link --since says so, exit 1 and asking nothing, when the shell gives no clock; without --since no clock is needed', async () => {
    const { verbs, calls, err } = harness({
      'GET /v1/links/conversations': { conversations: [], matched: 0, skipped: 0 },
    });
    expect(await run(verbs['link [query...]'], [], { since: '1d' })).toBe(1);
    expect(err.join('')).toContain('--since needs the shell’s clock');
    expect(calls).toEqual([]);
    expect(await run(verbs['link [query...]'], [], {})).toBe(0);
  });

  test('link --since refuses anything but <n>d, <n>h or <n>w in v4’s words, exit 2, and asks nothing', async () => {
    const { verbs, calls, err } = harness();
    expect(await run(verbs['link [query...]'], [], { since: 'soon' })).toBe(2);
    expect(err.join('')).toContain('--since takes <n>d, <n>h or <n>w (e.g. 7d), not "soon"');
    expect(calls).toEqual([]);
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
