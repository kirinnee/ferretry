import { describe, expect, test } from 'bun:test';
import type { PluginClient, PluginSocketListeners, VerbInvocation } from '@ferretry/kernel/manifest';
import cli from '../../../../cli/index.ts';
import { FS_ROUTES } from '../../../../cli/lib/fs/gateway.ts';
import { PIN_ROUTES } from '../../../../cli/lib/pins/gateway.ts';
import manifest from '../../../../manifest.ts';
import { sessionView } from '../session/session-fixtures.ts';

/**
 * Today's `fy events` (and `fy view`), `fy fs …` and `fy pin …` (v4 packages/cli/src/lib/{reads,filesystem,pins}) on the
 * Ferrets cli half: a fake guarded client, the verbs run as the shell runs them, what each asks the daemon and prints.
 */

interface Call {
  readonly route: string;
  readonly init?: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown };
}

interface World {
  readonly answers?: Readonly<Record<string, unknown>>;
  /** The frames the journal socket plays after it opens, as the daemon's JSON text. */
  readonly frames?: readonly unknown[];
  readonly env?: Readonly<Record<string, string>>;
  /** The session id the daemon resolves a typed reference to (a callsign); a reference not listed is its own id. */
  readonly resolves?: Readonly<Record<string, string>>;
  /** A route the daemon refuses, with the status and sentence it answers. */
  readonly refuses?: Readonly<Record<string, { readonly status: number; readonly message: string }>>;
  /** How the journal socket ends after its frames: the reason and code a close carries (no code: a failure). */
  readonly closes?: readonly [reason: string, code?: number];
}

function run(world: World = {}) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const sockets: { key: string; query?: Record<string, string>; closed?: { code?: number; reason?: string } }[] = [];
  const client: PluginClient = {
    call: async (route, init) => {
      calls.push(init === undefined ? { route } : { route, init: init as Call['init'] });
      const refusal = world.refuses?.[route];
      if (refusal !== undefined) throw Object.assign(new Error(refusal.message), { status: refusal.status });
      if (route === 'GET /v1/ferrets/:ferretId' && world.answers?.[route] === undefined) {
        const reference = (init as Call['init'])?.params?.ferretId ?? '';
        return sessionView({ id: world.resolves?.[reference] ?? reference, name: reference }) as never;
      }
      return world.answers?.[route] as never;
    },
    subscribe: () => () => undefined,
    socket: (key, _params, listeners: PluginSocketListeners, query) => {
      const record: (typeof sockets)[number] = { key, ...(query === undefined ? {} : { query }) };
      sockets.push(record);
      queueMicrotask(() => {
        for (const frame of world.frames ?? []) listeners.onFrame(JSON.stringify(frame));
        if (world.closes !== undefined) listeners.onClose(...world.closes);
      });
      return {
        send: () => undefined,
        close: (code?: number, reason?: string) => {
          record.closed = { ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) };
        },
      } as never;
    },
  };
  const half = cli.build?.({
    manifest,
    client,
    io: { out: t => out.push(t.replace(/\n$/u, '')), err: t => err.push(t.replace(/\n$/u, '')), isTty: false },
    clock: { now: () => '2026-11-06T09:00:00.000Z' as never, nowMs: () => 0 },
    sleep: async () => undefined,
    ...(world.env === undefined ? {} : { env: world.env }),
  });
  if (half === undefined) throw new Error('the cli half is real');
  const verbs = half.verbs as Readonly<Record<string, (invocation: VerbInvocation) => Promise<number>>>;
  const verb = async (line: string, args: readonly string[] = [], options: VerbInvocation['options'] = {}) => {
    const handler = verbs[line];
    if (handler === undefined) throw new Error(`no verb ${line}`);
    return await handler({ args, options });
  };
  return { verb, verbs, calls, out, err, sockets };
}

const declared = (line: string) => manifest.actions.cli?.find(decl => decl.verb === line);

// ── fy events ──────────────────────────────────────────────────────────────────────────────────────────────────────

const AT = '2026-11-06T09:00:00.000Z';
const event = (sequence: number, extra: Record<string, unknown> = {}) => ({
  kind: 'event',
  event: {
    sequence,
    time: AT,
    sessionId: 'wren',
    type: 'turn.started',
    source: 'daemon',
    data: { n: sequence },
    ...extra,
  },
});
const opening = { kind: 'idle', idleSeconds: 30, scope: { kind: 'session', sessionId: 'wren', after: 3 } };

describe('fy events — one ferret’s journal, read through the stream socket', () => {
  test('V-0258 reads the replay after --after, prints one line per event, and leaves at the daemon’s opening idle proof', async () => {
    const world = run({ frames: [event(8), event(9, { turn: 2 }), opening, event(10)] });
    expect(await world.verb('events <id>', ['wren'], { after: '7' })).toBe(0);
    expect(world.sockets).toEqual([
      {
        key: 'GET /v1/events',
        query: { after: '7', sessionId: 'wren' },
        closed: { code: 1000, reason: 'event stream cancelled' },
      },
    ]);
    expect(world.out).toEqual([
      `#8 ${AT} turn.started (daemon) {"n":8}`,
      `#9 ${AT} turn.started turn=2 (daemon) {"n":9}`,
    ]);
    // The only thing asked of the daemon besides the socket is who `wren` is.
    expect(world.calls).toEqual([{ route: 'GET /v1/ferrets/:ferretId', init: { params: { ferretId: 'wren' } } }]);
  });

  test('V-0258 --limit stops after that many events and closes the socket', async () => {
    const world = run({ frames: [event(1), event(2), event(3), opening] });
    expect(await world.verb('events <id>', ['wren'], { limit: '2' })).toBe(0);
    expect(world.out).toEqual([`#1 ${AT} turn.started (daemon) {"n":1}`, `#2 ${AT} turn.started (daemon) {"n":2}`]);
    expect(world.sockets[0]?.query).toEqual({ after: '0', sessionId: 'wren' });
    expect(world.sockets[0]?.closed?.code).toBe(1000);
  });

  test('V-0258 --json prints one protocol event per line', async () => {
    const world = run({ frames: [event(1), event(2), opening] });
    expect(await world.verb('events <id>', ['wren'], { json: true })).toBe(0);
    expect(world.out.map(line => JSON.parse(line).sequence)).toEqual([1, 2]);
    expect(JSON.parse(world.out[0] as string).sessionId).toBe('wren');
  });

  test('V-0258 a ferret with no events prints nothing and exits 0', async () => {
    const world = run({ frames: [opening] });
    expect(await world.verb('events <id>', ['wren'])).toBe(0);
    expect(world.out).toEqual([]);
  });

  test('V-0258 refuses a cursor or a count a caller mistyped before any socket opens (exit 2)', async () => {
    const world = run();
    expect(await world.verb('events <id>', ['wren'], { after: '-1' })).toBe(2);
    expect(world.err.at(-1)).toBe('--after must be a non-negative integer');
    expect(await world.verb('events <id>', ['wren'], { limit: '0' })).toBe(2);
    expect(world.err.at(-1)).toBe('--limit must be a positive integer');
    expect(await world.verb('events <id>', ['wren'], { limit: 'many' })).toBe(2);
    expect(await world.verb('events <id>', [])).toBe(2);
    expect(world.sockets).toEqual([]);
  });

  test('V-0258 refuses another ferret’s event, and a sequence that does not advance (exit 1)', async () => {
    const other = run({ frames: [event(1, { sessionId: 'fern' })] });
    expect(await other.verb('events <id>', ['wren'])).toBe(1);
    expect(other.err.at(-1)).toContain('an event for fern while reading wren');
    const stuck = run({ frames: [event(4), event(4)] });
    expect(await stuck.verb('events <id>', ['wren'], { after: '3' })).toBe(1);
    expect(stuck.err.at(-1)).toContain('non-advancing event sequence #4');
  });

  test('V-0258 a callsign is resolved by the daemon and the socket is opened with the ferret’s id, three calls in a row', async () => {
    for (let call = 1; call <= 3; call += 1) {
      const world = run({
        resolves: { kraig: 'mwk8l2ul-d4357aff' },
        frames: [
          event(1, { sessionId: 'mwk8l2ul-d4357aff' }),
          { ...opening, scope: { kind: 'session', sessionId: 'mwk8l2ul-d4357aff', after: 0 } },
        ],
      });
      expect(await world.verb('events <id>', ['kraig'])).toBe(0);
      expect(world.calls).toEqual([{ route: 'GET /v1/ferrets/:ferretId', init: { params: { ferretId: 'kraig' } } }]);
      expect(world.sockets[0]?.query).toEqual({ after: '0', sessionId: 'mwk8l2ul-d4357aff' });
      expect(world.out).toEqual([`#1 ${AT} turn.started (daemon) {"n":1}`]);
      expect(world.err).toEqual([]);
    }
  });

  test('V-0258 a name two ferrets hold is refused with the daemon’s sentence before any socket opens', async () => {
    const message =
      'the name kraig is held by 2 sessions on this machine: a (working), b (working); address one by its session id';
    const world = run({ refuses: { 'GET /v1/ferrets/:ferretId': { status: 409, message } } });
    expect(await world.verb('events <id>', ['kraig'])).toBe(1);
    expect(world.err.at(-1)).toBe(message);
    expect(world.sockets).toEqual([]);
  });

  test('V-0258 a reference the daemon does not list is still tried as an id (an archived ferret), and a refusal says no ferret', async () => {
    const archived = run({
      refuses: { 'GET /v1/ferrets/:ferretId': { status: 404, message: 'no ferret old-one' } },
      frames: [
        event(1, { sessionId: 'old-one' }),
        { ...opening, scope: { kind: 'session', sessionId: 'old-one', after: 0 } },
      ],
    });
    expect(await archived.verb('events <id>', ['old-one'])).toBe(0);
    expect(archived.sockets[0]?.query).toEqual({ after: '0', sessionId: 'old-one' });
    const missing = run({
      refuses: { 'GET /v1/ferrets/:ferretId': { status: 404, message: 'no ferret nosuch' } },
      closes: ['WebSocket stream failed: the daemon refused the stream (HTTP 404)'],
    });
    expect(await missing.verb('events <id>', ['nosuch'])).toBe(1);
    expect(missing.err).toEqual(['no ferret nosuch']);
  });

  test('V-0258 a stream that fails for another reason shows that reason once, never a doubled sentence', async () => {
    const world = run({ closes: ['WebSocket stream failed: the daemon refused the stream (HTTP 403)'] });
    expect(await world.verb('events <id>', ['wren'])).toBe(1);
    expect(world.err).toEqual(['WebSocket stream failed: the daemon refused the stream (HTTP 403)']);
  });

  test('V-0258 declares v4’s flags: --after, --limit and --json (and no view alias: v4 aliases are removed by design)', () => {
    expect(run().verbs['view <id>']).toBeUndefined();
    expect(declared('events <id>')?.options?.map(option => option.flag)).toEqual([
      '--after <sequence>',
      '--limit <count>',
      '--json',
    ]);
  });
});

// ── fy fs ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const at = (ferretId: string, query?: Record<string, string>) => ({
  params: { ferretId },
  ...(query === undefined ? {} : { query }),
});

describe('fy fs — a ferret’s working tree, read only', () => {
  test('V-0262 every fs sub-verb is declared and none writes: only GET routes are used', () => {
    for (const line of [
      'fs ls <id> [path]',
      'fs index <id>',
      'fs cat <id> <path>',
      'fs changes <id>',
      'fs diff <id> <path>',
    ])
      expect(declared(line)).toBeDefined();
    expect(Object.values(FS_ROUTES).every(route => route.startsWith('GET '))).toBe(true);
  });

  test('V-0262 a bare fy fs prints the sub-verbs it has and exits 2', async () => {
    const world = run();
    expect(await world.verb('fs')).toBe(2);
    expect(world.out.join('\n')).toContain('fy fs cat <ferret> <path>');
    expect(world.calls).toEqual([]);
  });

  test('V-0269 fs ls lists the root, or a directory by the path typed, with every safety badge', async () => {
    const listing = {
      root: '/work/alpha',
      path: 'src',
      entries: [
        { name: 'app', type: 'dir' },
        { name: 'index.ts', type: 'file', size: 120 },
        { name: '.env', type: 'file', size: 4, denied: true },
        { name: 'out.log', type: 'file', ignored: true },
        { name: 'link', type: 'symlink', escapes: true },
      ],
      truncated: true,
    };
    const world = run({ answers: { [FS_ROUTES.list]: listing } });
    expect(await world.verb('fs ls <id> [path]', ['wren', 'src'])).toBe(0);
    expect(world.calls).toEqual([{ route: FS_ROUTES.list, init: at('wren', { path: 'src' }) }]);
    expect(world.out[0]).toBe(
      [
        '/work/alpha:src (truncated)',
        '  d         -  app',
        '  f       120  index.ts',
        '  f         4  .env  [denied]',
        '  f         -  out.log  [ignored]',
        '  l         -  link  [escapes]',
      ].join('\n'),
    );
    expect(await world.verb('fs ls <id> [path]', ['wren'], { json: true })).toBe(0);
    expect(world.calls[1]).toEqual({ route: FS_ROUTES.list, init: at('wren') });
    expect(JSON.parse(world.out[1] as string)).toEqual(listing);
  });

  test('V-0269 an empty directory says so', async () => {
    const world = run({ answers: { [FS_ROUTES.list]: { root: '/w', path: '', entries: [] } } });
    expect(await world.verb('fs ls <id> [path]', ['wren'])).toBe(0);
    expect(world.out[0]).toBe('/w:.\n  No entries.');
  });

  test('V-0263 fs cat reads the working tree, --head reads Git HEAD; a withheld file says why, never as empty', async () => {
    const world = run({ answers: { [FS_ROUTES.file]: { path: 'a.txt', size: 3, content: 'hi\n' } } });
    expect(await world.verb('fs cat <id> <path>', ['wren', 'a.txt'])).toBe(0);
    expect(world.calls[0]).toEqual({ route: FS_ROUTES.file, init: at('wren', { path: 'a.txt' }) });
    expect(world.out[0]).toBe('hi\n');
    expect(await world.verb('fs cat <id> <path>', ['wren', 'a.txt'], { head: true })).toBe(0);
    expect(world.calls[1]).toEqual({ route: FS_ROUTES.file, init: at('wren', { path: 'a.txt', rev: 'head' }) });
    expect(await world.verb('fs cat <id> <path>', ['wren', 'a.txt'], { json: true })).toBe(0);
    expect(JSON.parse(world.out.at(-1) as string)).toEqual({ path: 'a.txt', size: 3, content: 'hi\n' });
    const withheld = async (view: Record<string, unknown>) => {
      const refused = run({ answers: { [FS_ROUTES.file]: { path: 'k', size: 9, ...view } } });
      await refused.verb('fs cat <id> <path>', ['wren', 'k']);
      return refused.out[0];
    };
    expect(await withheld({ denied: true })).toBe('k: denied by the repository secrets policy (9 bytes)');
    expect(await withheld({ ignored: true })).toBe('k: gitignored or not proven safe to serve (9 bytes)');
    expect(await withheld({ binary: true, rev: 'head' })).toBe('k: binary (9 bytes) [HEAD]');
    expect(await withheld({ tooLarge: true })).toBe('k: too large (9 bytes)');
    expect(await withheld({ reason: 'escapes' })).toBe('k: escapes (9 bytes)');
    expect(await withheld({})).toBe('k: content unavailable (9 bytes)');
  });

  test('V-0263 fs cat refuses a blank path before any request (exit 1)', async () => {
    const world = run();
    expect(await world.verb('fs cat <id> <path>', ['wren', '  '])).toBe(1);
    expect(world.err.at(-1)).toBe('a relative file path is required');
    expect(world.calls).toEqual([]);
  });

  test('V-0264 fs changes lists branch, status, rename source and counts; says so for a clean tree and a non-repository', async () => {
    const changes = {
      repo: true,
      branch: 'main',
      truncated: true,
      changes: [
        { path: 'a.ts', status: ' M', additions: 3, deletions: 1 },
        { path: 'b.ts', status: 'R ', from: 'old.ts' },
        { path: 'c.ts', status: '??' },
      ],
    };
    const world = run({ answers: { [FS_ROUTES.changes]: changes } });
    expect(await world.verb('fs changes <id>', ['wren'])).toBe(0);
    expect(world.calls[0]).toEqual({ route: FS_ROUTES.changes, init: at('wren') });
    expect(world.out[0]).toBe('branch main (truncated)\n   M  a.ts  +3/-1\n  R   b.ts ← old.ts\n  ??  c.ts');
    expect(await world.verb('fs changes <id>', ['wren'], { json: true })).toBe(0);
    expect(JSON.parse(world.out[1] as string)).toEqual(changes);
    const clean = run({ answers: { [FS_ROUTES.changes]: { repo: true, changes: [] } } });
    await clean.verb('fs changes <id>', ['wren']);
    expect(clean.out[0]).toBe('branch (detached)\n  No working-tree changes.');
    const plain = run({ answers: { [FS_ROUTES.changes]: { repo: false, changes: [] } } });
    await plain.verb('fs changes <id>', ['wren']);
    expect(plain.out[0]).toBe('The session working directory is not a Git worktree.');
  });

  test('V-0265 fs diff prints the unified diff as text; an empty diff is stated; --json stays parseable', async () => {
    const diff = '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\n';
    const world = run({ answers: { [FS_ROUTES.diff]: diff } });
    expect(await world.verb('fs diff <id> <path>', ['wren', 'a.ts'])).toBe(0);
    expect(world.calls[0]).toEqual({ route: FS_ROUTES.diff, init: at('wren', { path: 'a.ts' }) });
    expect(world.out[0]).toBe(diff);
    expect(await world.verb('fs diff <id> <path>', ['wren', 'a.ts'], { json: true })).toBe(0);
    expect(JSON.parse(world.out[1] as string)).toBe(diff);
    const empty = run({ answers: { [FS_ROUTES.diff]: undefined } });
    expect(await empty.verb('fs diff <id> <path>', ['wren', 'a.ts'])).toBe(0);
    expect(empty.out[0]).toBe('No diff for a.ts.');
    const odd = run({ answers: { [FS_ROUTES.diff]: { not: 'text' } } });
    expect(await odd.verb('fs diff <id> <path>', ['wren', 'a.ts'])).toBe(1);
  });

  const index = (files: readonly string[], extra: Record<string, unknown> = {}) => ({
    v: 1,
    sessionId: 'wren',
    root: '/work/alpha',
    coverage: 'complete',
    skipped: [],
    files: files.map(path => ({ path, name: path.split('/').at(-1) })),
    ...extra,
  });

  test('V-0267 fs index lists every searchable file and always says what it could not cover', async () => {
    const world = run({
      answers: {
        [FS_ROUTES.index]: index(['src/a.ts', 'README.md'], {
          coverage: 'partial',
          skipped: [{ reason: 'truncated', count: 4 }],
        }),
      },
    });
    expect(await world.verb('fs index <id>', ['wren'])).toBe(0);
    expect(world.calls).toEqual([{ route: FS_ROUTES.index, init: at('wren') }]);
    expect(world.out[0]).toBe(
      '/work/alpha: 2 of 2 indexed files (partial) — not indexed: 4 truncated\n  src/a.ts\n  README.md',
    );
    const one = run({ answers: { [FS_ROUTES.index]: index(['a.ts']) } });
    await one.verb('fs index <id>', ['wren']);
    expect(one.out[0]).toBe('/work/alpha: 1 of 1 indexed file (complete)\n  a.ts');
  });

  test('V-0267 --query narrows the held index by name or path, says so when nothing matched, and keeps the skip record', async () => {
    const answers = {
      [FS_ROUTES.index]: index(['src/a.ts', 'src/deep/readme.md', 'b.ts'], {
        skipped: [{ reason: 'excluded', count: 1 }],
      }),
    };
    const world = run({ answers });
    expect(await world.verb('fs index <id>', ['wren'], { query: 'README' })).toBe(0);
    expect(world.calls).toHaveLength(1);
    expect(world.out[0]).toBe(
      '/work/alpha: 1 of 3 indexed files (complete) — not indexed: 1 excluded\n  src/deep/readme.md',
    );
    expect(await world.verb('fs index <id>', ['wren'], { query: 'src/' })).toBe(0);
    expect(world.out[1]).toContain('2 of 3');
    expect(await world.verb('fs index <id>', ['wren'], { query: 'zzz' })).toBe(0);
    expect(world.out[2]).toBe(
      '/work/alpha: 0 of 3 indexed files (complete) — not indexed: 1 excluded\n  No matching files.',
    );
    expect(await world.verb('fs index <id>', ['wren'], { query: 'b', json: true })).toBe(0);
    expect(JSON.parse(world.out[3] as string).files.map((file: { path: string }) => file.path)).toEqual(
      ['src/a.ts', 'src/deep/readme.md', 'b.ts'].filter(path => path.includes('b')),
    );
  });

  test('V-0267 a malformed --query is refused before any request', async () => {
    const world = run({ answers: { [FS_ROUTES.index]: index([]) } });
    for (const query of ['   ', 'x'.repeat(201), 'a\u0000b']) {
      expect(await world.verb('fs index <id>', ['wren'], { query })).toBe(1);
      expect(world.err.at(-1)).toBe('--query must be between 1 and 200 characters of search text');
    }
    expect(world.calls).toEqual([]);
  });

  test('V-0262 an answer that is not the declared shape is a failure (exit 1), never rendered', async () => {
    const world = run({ answers: { [FS_ROUTES.list]: { entries: 'nope' } } });
    expect(await world.verb('fs ls <id> [path]', ['wren'])).toBe(1);
    expect(world.out).toEqual([]);
  });
});

// ── fy pin ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const NOTE = '11111111-1111-4111-8111-111111111111';
const NOTE_B = '11112222-1111-4111-8111-111111111111';
const MESSAGE = '22222222-2222-4222-8222-222222222222';
const human = { by: 'human', createdBy: null, createdByName: null } as const;
const note = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  id,
  at: 1,
  kind: 'note',
  text,
  ...human,
  ...extra,
});
const message = {
  id: MESSAGE,
  at: 2,
  kind: 'message',
  blockId: 'b1',
  blockKind: 'assistant',
  preview: 'the plan',
  ...human,
};
const board = (...pins: unknown[]) => ({ v: 1, sessionId: 'wren', pins, updatedAt: AT });
const inside = { FY_SESSION_ID: 'wren' };

describe('fy pin — a ferret’s pin board', () => {
  test('V-0341 fy pin <words> is fy pin add <words>: add is the declared default of the group', () => {
    expect(declared('pin add <text...>')).toMatchObject({ default: true });
    expect(manifest.actions.cli?.filter(decl => decl.verb.startsWith('pin') && decl.default === true)).toHaveLength(1);
  });

  test('V-0342 pin add joins the words into one note for the ferret it runs inside, and confirms with the board size', async () => {
    const world = run({ env: inside, answers: { [PIN_ROUTES.apply]: board(note(NOTE, 'remember to rebase')) } });
    expect(await world.verb('pin add <text...>', ['remember', 'to', 'rebase'])).toBe(0);
    expect(world.calls).toEqual([
      {
        route: PIN_ROUTES.apply,
        init: { params: { ferretId: 'wren' }, body: { action: 'add', kind: 'note', text: 'remember to rebase' } },
      },
    ]);
    expect(world.out[0]).toBe('pinned — 1 pin in wren');
    expect(await world.verb('pin add <text...>', ['x'], { json: true })).toBe(0);
    expect(JSON.parse(world.out[1] as string).pins).toHaveLength(1);
  });

  test('V-0342 -s/--session targets another board; no session at all is refused; a blank or oversized note never reaches the daemon', async () => {
    const world = run({ env: inside, answers: { [PIN_ROUTES.apply]: board() } });
    await world.verb('pin add <text...>', ['x'], { s: 'fern' });
    await world.verb('pin add <text...>', ['y'], { session: 'oak' });
    expect(world.calls.map(call => call.init?.params?.ferretId)).toEqual(['fern', 'oak']);
    const bare = run();
    expect(await bare.verb('pin add <text...>', ['x'])).toBe(1);
    expect(bare.err.at(-1)).toBe('no session id — run inside a session or pass --session <id>');
    expect(await bare.verb('pin add <text...>', ['x'], { session: '  ' })).toBe(1);
    expect(await world.verb('pin add <text...>', [' ', ''])).toBe(1);
    expect(world.err.at(-1)).toBe('nothing to pin — give a note or a link');
    expect(await world.verb('pin add <text...>', ['x'.repeat(501)])).toBe(1);
    expect(world.err.at(-1)).toBe('a pin note may not exceed 500 characters (got 501)');
    expect(world.calls).toHaveLength(2);
  });

  test('V-0345 pin ls lists id, kind, provenance and body in aligned columns; an empty board names the ferret', async () => {
    const agent = note(NOTE_B, 'a very long note '.repeat(8), { by: 'agent', createdBy: 'mid', createdByName: 'fern' });
    const world = run({
      env: inside,
      answers: { [PIN_ROUTES.list]: board(note(NOTE, 'rebase\nfirst'), message, agent) },
    });
    expect(await world.verb('pin ls', [])).toBe(0);
    expect(world.calls).toEqual([{ route: PIN_ROUTES.list, init: { params: { ferretId: 'wren' } } }]);
    const lines = (world.out[0] as string).split('\n');
    expect(lines[0]).toBe('3 pins in wren');
    expect(lines[1]).toBe(`  11111111  note${' '.repeat(19)}rebase first`);
    expect(lines[2]).toBe(`  22222222  message${' '.repeat(16)}assistant: the plan`);
    expect(lines[3]).toMatch(/^ {2}11112222 {2}note {5}\[agent fern\] {2}a very long note .*…$/u);
    expect(lines[3]?.split('  ').at(-1)).toHaveLength(80);
    const empty = run({ env: inside, answers: { [PIN_ROUTES.list]: board() } });
    await empty.verb('pin ls', []);
    expect(empty.out[0]).toBe('No pins in wren.');
    expect(await world.verb('pin ls', [], { json: true })).toBe(0);
    expect(JSON.parse(world.out[1] as string).sessionId).toBe('wren');
  });

  test('V-0343 pin edit resolves the printed short id, then sends the replacement; it confirms naming the pin', async () => {
    const world = run({
      env: inside,
      answers: { [PIN_ROUTES.list]: board(note(NOTE, 'old'), message), [PIN_ROUTES.apply]: board(note(NOTE, 'new')) },
    });
    expect(await world.verb('pin edit <id> <text...>', ['11111111', 'new', 'words'])).toBe(0);
    expect(world.calls.map(call => call.route)).toEqual([PIN_ROUTES.list, PIN_ROUTES.apply]);
    expect(world.calls[1]?.init?.body).toEqual({ action: 'edit', id: NOTE, text: 'new words' });
    expect(world.out[0]).toBe('edited 11111111 — 1 pin in wren');
  });

  test('V-0343 pin edit refuses a message pin and an empty note before sending anything to change', async () => {
    const world = run({ env: inside, answers: { [PIN_ROUTES.list]: board(note(NOTE, 'old'), message) } });
    expect(await world.verb('pin edit <id> <text...>', ['22222222', 'x'])).toBe(1);
    expect(world.err.at(-1)).toBe('22222222 is a message pin — only note pins have editable text');
    expect(await world.verb('pin edit <id> <text...>', ['11111111', ' '])).toBe(1);
    expect(world.calls.map(call => call.route)).toEqual([PIN_ROUTES.list]);
    expect(await world.verb('pin edit <id> <text...>', [])).toBe(2);
  });

  test('V-0347 pin rm resolves a short id, a full uuid or a case-mixed prefix, removes it, and confirms', async () => {
    const world = run({
      env: inside,
      answers: { [PIN_ROUTES.list]: board(note(NOTE, 'a'), message), [PIN_ROUTES.apply]: board(note(NOTE, 'a')) },
    });
    expect(await world.verb('pin rm <id>', ['22222222'])).toBe(0);
    expect(world.calls[1]?.init?.body).toEqual({ action: 'remove', id: MESSAGE });
    expect(world.out[0]).toBe('removed 22222222 — 1 pin in wren');
    await world.verb('pin rm <id>', [NOTE.toUpperCase()]);
    await world.verb('pin rm <id>', [' 1111 ']);
    expect(
      world.calls
        .filter(call => call.route === PIN_ROUTES.apply)
        .map(call => (call.init?.body as { id: string } | undefined)?.id),
    ).toEqual([MESSAGE, NOTE, NOTE]);
  });

  test('V-0347 pin rm names an unknown, too short or ambiguous id itself, and never asks the daemon to remove it', async () => {
    const world = run({ env: inside, answers: { [PIN_ROUTES.list]: board(note(NOTE, 'a'), note(NOTE_B, 'b')) } });
    expect(await world.verb('pin rm <id>', ['9999'])).toBe(1);
    expect(world.err.at(-1)).toBe('no pin matches "9999" — run `pin ls` to see them');
    expect(await world.verb('pin rm <id>', ['111'])).toBe(1);
    expect(world.err.at(-1)).toBe('pin id "111" is too short — give at least 4 characters');
    expect(await world.verb('pin rm <id>', ['1111'])).toBe(1);
    expect(world.err.at(-1)).toBe('"1111" matches 2 pins (11111111, 11112222) — give more characters');
    expect(world.calls.every(call => call.route === PIN_ROUTES.list)).toBe(true);
  });

  test('V-0345 a pin board answer that is not the declared shape is a failure, never rendered', async () => {
    const world = run({ env: inside, answers: { [PIN_ROUTES.list]: { pins: 'nope' } } });
    expect(await world.verb('pin ls', [])).toBe(1);
    expect(world.out).toEqual([]);
  });
});
