import { describe, expect, test } from 'bun:test';
import type { PluginClient, VerbInvocation } from '@ferretry/kernel/manifest';
import cli from '../../../cli/index.ts';
import { FERRET_ROUTES } from '../../../cli/lib/client.ts';
import { WORKTREE_ROUTES } from '../../../cli/lib/worktrees/gateway.ts';
import manifest from '../../../manifest.ts';
import { sessionView } from './session/session-fixtures.ts';
import { decision, WORKTREE_PATH } from './worktrees/fixtures.ts';

interface Call {
  readonly route: string;
  readonly init?: unknown;
}

/** A shell refusal (the daemon's final "no", a paused plugin): it carries its own exit code. */
class ShellRefusal extends Error {
  readonly exitCode = 69;
}

function run(answers: Readonly<Record<string, unknown>> = {}, fail?: Error) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const client: PluginClient = {
    call: async (route, init) => {
      calls.push(init === undefined ? { route } : { route, init });
      if (fail !== undefined) throw fail;
      return (answers[route] ?? {}) as never;
    },
    subscribe: () => () => undefined,
  };
  let time = 0;
  const half = cli.build?.({
    manifest,
    client,
    io: { out: t => out.push(t), err: t => err.push(t), isTty: false },
    clock: { now: () => '2026-11-06T09:00:00.000Z' as never, nowMs: () => time },
    sleep: async delay => {
      time += Number(delay);
    },
  });
  if (half === undefined) throw new Error('the cli half is real');
  const verbs = half.verbs as Readonly<Record<string, (invocation: VerbInvocation) => Promise<number>>>;
  const verb = async (line: string, args: readonly string[] = [], options: VerbInvocation['options'] = {}) => {
    const handler = verbs[line];
    if (handler === undefined) throw new Error(`no verb ${line}`);
    return await handler({ args, options });
  };
  return { verb, verbs, calls, out, err };
}

const ferret = sessionView({ id: 'lead', name: 'wren' });

describe('the ferrets cli half', () => {
  test('implements exactly the verbs the manifest declares', () => {
    const declared = (manifest.actions.cli ?? []).map(decl => decl.verb).sort();
    expect(Object.keys(run().verbs).sort()).toEqual(declared);
  });

  test('Z1 Conversation owns compact-at: Ferrets declares and implements no session compact-at verb', () => {
    expect(Object.keys(run().verbs).some(verb => verb.includes('compact-at'))).toBe(false);
    expect(manifest.actions.cli?.some(decl => decl.verb.includes('compact-at'))).toBe(false);
  });

  test('V-0366 ps reads GET /v1/ferrets; -a shows stopped ones; -l (a label) is refused with the word that replaced it', async () => {
    const stopped = sessionView({ id: 'old', name: 'oak', state: 'stopped' });
    const { verb, calls, out, err } = run({ [FERRET_ROUTES.list]: [ferret, stopped] });
    expect(await verb('ps')).toBe(0);
    expect(calls).toEqual([{ route: 'GET /v1/ferrets' }]);
    expect(out.join('\n')).not.toContain('oak');
    expect(await verb('ps', [], { a: true })).toBe(0);
    expect(out.join('\n')).toContain('oak');
    expect(await verb('ps', [], { l: 'mine' })).toBe(2);
    expect(err.at(-1)).toContain('--pack');
  });

  test('V-0445 status reads one ferret by the reference typed; without one it is a usage error', async () => {
    const { verb, calls, err } = run({ [FERRET_ROUTES.get]: ferret });
    expect(await verb('status [id]', ['wren'], { json: true })).toBe(0);
    expect(calls).toEqual([{ route: 'GET /v1/ferrets/:ferretId', init: { params: { ferretId: 'wren' } } }]);
    expect(await verb('status [id]')).toBe(2);
    expect(err.at(-1)).toContain('status <id>');
  });

  test('V-0443 start posts the body Ferrets start takes and refuses, by name, a flag another plugin decides now', async () => {
    const { verb, calls, err } = run({ [FERRET_ROUTES.start]: { id: 'lead' }, [FERRET_ROUTES.get]: ferret });
    expect(await verb('start [prompt...]', ['fix', 'it'], { a: 'claude-alpha', cwd: '/abs', teammate: 'wren' })).toBe(
      0,
    );
    expect(calls[0]).toEqual({
      route: 'POST /v1/ferrets',
      init: {
        body: { folder: '/abs', runtime: 'claude-alpha', name: 'wren', prompt: 'fix it', mode: 'auto' },
        headers: { 'x-fy-request-id': expect.any(String) },
      },
    });
    expect(await verb('start [prompt...]', ['x'], { 'compact-at': '250k', 'prompt-file': 'brief.md' })).toBe(2);
    expect(err.at(-1)).toContain('--compact-at, --prompt-file');
    expect(await verb('start [prompt...]', ['x'], { mode: 'sideways' })).toBe(2);
    expect(calls).toHaveLength(2);
  });

  test('V-0443 start sends today’s flags under today’s wire names; --no-fast and a repeated --harness-flag carry', async () => {
    const { verb, calls, err } = run({ [FERRET_ROUTES.start]: { id: 'lead' }, [FERRET_ROUTES.get]: ferret });
    expect(
      await verb('start [prompt...]', ['go'], {
        cwd: '/abs',
        name: 'Fix login',
        label: 'mine',
        card: 'F21',
        model: 'opus',
        fast: false,
        rc: true,
        'harness-flag': ['--a', '--b'],
        'teammate-fallback': true,
        interval: '30',
        'turn-timeout': '3600',
        'nudge-after': '120',
        'stall-kill-after': '900',
        'direct-max': '0',
        'max-snapshots': '5',
      }),
    ).toBe(0);
    expect(calls[0]?.init).toEqual({
      headers: { 'x-fy-request-id': expect.any(String) },
      body: {
        folder: '/abs',
        prompt: 'go',
        mode: 'auto',
        teammateFallback: true,
        title: 'Fix login',
        label: 'mine',
        card: 'F21',
        model: 'opus',
        fast: false,
        remoteControl: true,
        harnessFlags: ['--a', '--b'],
        intervalSeconds: 30,
        timeoutSeconds: 3600,
        nudgeAfterSeconds: 120,
        killAfterSeconds: 900,
        directSendMaxChars: 0,
        maxSnapshots: 5,
      },
    });
    expect(await verb('start [prompt...]', ['go'], { cwd: '/abs', interval: 'banana' })).toBe(2);
    expect(err.at(-1)).toContain('--interval must be an integer of at least 1');
    expect(calls).toHaveLength(2);
  });

  test('V-0334 new sends today’s model routing; it names a runtime or passes --auto, never both', async () => {
    const { verb, calls, err } = run({ [FERRET_ROUTES.start]: { id: 'lead' }, [FERRET_ROUTES.get]: ferret });
    expect(await verb('new [words...]', ['look'], { runtime: 'codex-beta', cwd: '/abs' })).toBe(0);
    expect(calls[0]).toEqual({
      route: 'POST /v1/ferrets',
      init: {
        body: { folder: '/abs', runtime: 'codex-beta', prompt: 'look', mode: 'auto' },
        headers: { 'x-fy-request-id': expect.any(String) },
      },
    });
    expect(
      await verb('new [words...]', ['look'], {
        auto: true,
        model: 'opus',
        effort: 'high',
        name: 'Look',
        card: '&F3',
        cwd: '/abs',
      }),
    ).toBe(0);
    expect(calls.at(-2)?.init).toEqual({
      headers: { 'x-fy-request-id': expect.any(String) },
      body: {
        folder: '/abs',
        prompt: 'look',
        mode: 'auto',
        title: 'Look',
        card: 'F3',
        model: 'opus',
        effort: 'high',
        auto: true,
      },
    });
    const before = calls.length;
    expect(await verb('new [words...]', ['look'], { auto: true, runtime: 'codex-beta' })).toBe(2);
    expect(err.at(-1)).toContain('--auto picks the runtime');
    expect(await verb('new [words...]', ['look'], { cwd: '/abs' })).toBe(2);
    expect(err.at(-1)).toContain('name a --runtime, or pass --auto');
    expect(await verb('new [words...]', ['look'], { runtime: 'codex-beta', continue: true })).toBe(2);
    expect(err.at(-1)).toContain('--continue');
    expect(calls).toHaveLength(before);
  });

  test('V-0447 a bare stop prints its modes and is a usage error', async () => {
    const { verb, out, calls } = run();
    expect(await verb('stop')).toBe(2);
    expect(out[0]).toContain('stop ferrets');
    expect(calls).toEqual([]);
  });

  test('V-0448 V-0449 V-0450 V-0451 stop resolves the root, plans from the list and stops only with --yes', async () => {
    const mid = sessionView({ id: 'mid', name: 'fern', parent: 'lead' });
    const answers = { [FERRET_ROUTES.get]: ferret, [FERRET_ROUTES.list]: [ferret, mid] };
    const cascade = run(answers);
    expect(await cascade.verb('stop cascade <session>', ['wren'])).toBe(1);
    expect(cascade.err.at(-1)).toContain('--yes');
    expect(cascade.calls.map(call => call.route)).toEqual(['GET /v1/ferrets/:ferretId', 'GET /v1/ferrets']);

    const confirmed = run(answers);
    expect(await confirmed.verb('stop children <session>', ['wren'], { yes: true })).toBe(0);
    expect(confirmed.calls.filter(call => call.route === FERRET_ROUTES.stop)).toEqual([
      {
        route: 'POST /v1/ferrets/:ferretId/stop',
        init: { params: { ferretId: 'mid' }, body: { reason: 'stopped by fy stop children lead' } },
      },
    ]);

    const dry = run(answers);
    expect(await dry.verb('stop orphan <session>', ['wren'], { n: true })).toBe(0);
    expect(dry.out.join('\n')).toContain('Dry run');

    const byPack = run({
      [FERRET_ROUTES.list]: [{ ...sessionView({ id: 'p1', pack: 'separate-pack' as never }), label: 'batch' }],
    });
    expect(await byPack.verb('stop label <label>', ['batch'], { yes: true })).toBe(0);
    expect(byPack.calls.at(-2)).toEqual({
      route: FERRET_ROUTES.stop,
      init: { params: { ferretId: 'p1' }, body: { reason: 'stopped by fy stop label batch' } },
    });

    const reasoned = run(answers);
    expect(await reasoned.verb('stop orphan <session>', ['wren'], { reason: 'shift over', yes: true })).toBe(0);
    expect(reasoned.calls.filter(call => call.route === FERRET_ROUTES.stop)).toEqual([
      { route: FERRET_ROUTES.stop, init: { params: { ferretId: 'lead' }, body: { reason: 'shift over' } } },
    ]);
  });

  test('V-0371 V-0333 V-0376 rename, name and resume each call their one route', async () => {
    const { verb, calls } = run({
      [FERRET_ROUTES.rename]: ferret,
      [FERRET_ROUTES.names]: ['ash'],
      [FERRET_ROUTES.resume]: { id: 'lead' },
      [FERRET_ROUTES.get]: ferret,
    });
    expect(await verb('rename <session> [name]', ['lead', 'wren'])).toBe(0);
    expect(await verb('name', [], { n: '3' })).toBe(0);
    expect(await verb('resume <id> [message...]', ['wren'])).toBe(0);
    expect(await verb('resume <id> [message...]', ['wren', 'carry', 'on'])).toBe(0);
    expect(await verb('rename <session> [name]', ['lead'], { title: 'Fix login' })).toBe(0);
    expect(calls).toEqual([
      { route: 'POST /v1/ferrets/:ferretId/rename', init: { params: { ferretId: 'lead' }, body: { name: 'wren' } } },
      { route: 'GET /v1/names', init: { query: { count: '3' } } },
      { route: 'POST /v1/ferrets/:ferretId/resume', init: { params: { ferretId: 'wren' } } },
      { route: 'GET /v1/ferrets/:ferretId', init: { params: { ferretId: 'lead' } } },
      {
        route: 'POST /v1/ferrets/:ferretId/resume',
        init: { params: { ferretId: 'wren' }, body: { message: 'carry on' } },
      },
      { route: 'GET /v1/ferrets/:ferretId', init: { params: { ferretId: 'lead' } } },
      {
        route: 'POST /v1/ferrets/:ferretId/rename',
        init: { params: { ferretId: 'lead' }, body: { title: 'Fix login' } },
      },
    ]);
  });

  test('V-0437 signal names its ferret with --session and sends the wait facts', async () => {
    const { verb, calls, err } = run({ [FERRET_ROUTES.signal]: {} });
    expect(await verb('signal <kind> [message...]', ['done', 'all', 'green'], { session: 'wren' })).toBe(0);
    expect(calls).toEqual([
      {
        route: 'POST /v1/ferrets/:ferretId/signal',
        init: { params: { ferretId: 'wren' }, body: { kind: 'done', message: 'all green' } },
      },
    ]);
    expect(await verb('signal <kind> [message...]', ['done'])).toBe(2);
    expect(err.at(-1)).toContain('--session');
  });

  test('V-0375 restart reads, restarts and cancels through /v1/restarts; --request-id is refused', async () => {
    const result = { restarted: [], queued: [], skipped: [], failed: [] };
    const { verb, calls } = run({
      [FERRET_ROUTES.restarts]: { outdated: [], queued: [] },
      [FERRET_ROUTES.restart]: result,
      [FERRET_ROUTES.cancelRestarts]: { cancelled: 0 },
    });
    expect(await verb('restart [ids...]')).toBe(0);
    expect(await verb('restart [ids...]', ['wren'])).toBe(0);
    expect(await verb('restart [ids...]', [], { cancel: true })).toBe(0);
    expect(calls).toEqual([
      { route: 'GET /v1/restarts' },
      { route: 'POST /v1/restarts', init: { body: { scope: 'ids', ids: ['wren'] } } },
      { route: 'DELETE /v1/restarts' },
    ]);
    expect(await verb('restart [ids...]', [], { all: true, 'request-id': 'k' })).toBe(2);
  });

  test('V-0431 V-0434 V-0433 V-0435 the session verbs call their routes; a bare session prints them', async () => {
    const { verb, calls, out } = run({
      [FERRET_ROUTES.revoke]: { id: 'lead', revoked: true },
      [FERRET_ROUTES.get]: ferret,
      [FERRET_ROUTES.pin]: { ...ferret, pinnedAt: '2026-11-01T10:00:00.000Z' },
      [FERRET_ROUTES.unpin]: ferret,
    });
    expect(await verb('session')).toBe(2);
    expect(out[0]).toContain("act on a ferret's own standing");
    expect(await verb('session revoke-credential <session>', ['wren'])).toBe(0);
    expect(await verb('session pin <session>', ['wren'])).toBe(0);
    expect(await verb('session unpin <session>', ['wren'])).toBe(0);
    expect(calls.map(call => call.route)).toEqual([
      'POST /v1/ferrets/:ferretId/revoke-credential',
      'GET /v1/ferrets/:ferretId',
      'POST /v1/ferrets/:ferretId/pin',
      'POST /v1/ferrets/:ferretId/unpin',
    ]);
  });

  test('V-0497 V-0505 V-0501 the worktree group lists by default under every spelling', async () => {
    const { verb, calls } = run({ [WORKTREE_ROUTES.list]: { worktrees: [] } });
    for (const line of ['worktree', 'worktrees', 'worktree ls', 'worktree list']) expect(await verb(line)).toBe(0);
    expect(calls.map(call => call.route)).toEqual(Array(4).fill('GET /v1/worktrees'));
  });

  test('V-0503 a worktree removal off a terminal needs --yes', async () => {
    const { verb, calls, err } = run({ [WORKTREE_ROUTES.check]: decision() });
    expect(await verb('worktree remove <path>', [WORKTREE_PATH])).toBe(1);
    expect(calls.map(call => call.route)).toEqual(['GET /v1/worktrees/removal']);
    expect(err.at(-1)).toBe(`refusing to remove ${WORKTREE_PATH} without a confirmation — pass --yes to authorize it`);
  });

  test('R502 ps keeps one last list per connection: the second read names its etag and a 304 serves the held list', async () => {
    const named: (string | undefined)[] = [];
    const out: string[] = [];
    const client: PluginClient = {
      call: async () => {
        throw new Error('a list read goes through the conditional read when the shell has one');
      },
      subscribe: () => () => undefined,
      conditional: async (key, _params, init) => {
        expect(key).toBe(FERRET_ROUTES.list);
        named.push(init?.ifNoneMatch);
        return init?.ifNoneMatch === undefined
          ? { status: 200, etag: '"t1"', body: [ferret] }
          : { status: 304, etag: '"t1"' };
      },
    };
    const half = cli.build?.({ manifest, client, io: { out: t => out.push(t), err: () => undefined, isTty: false } });
    const ps = (half?.verbs as Readonly<Record<string, (invocation: VerbInvocation) => Promise<number>>>).ps;
    if (ps === undefined) throw new Error('ps is implemented');
    expect(await ps({ args: [], options: {} })).toBe(0);
    expect(await ps({ args: [], options: {} })).toBe(0);
    expect(named).toEqual([undefined, '"t1"']);
    expect(out.filter(text => text.includes('wren')).length).toBe(2);
  });

  test('a shell refusal goes back to the shell with its own exit code, never re-worded', async () => {
    const refusal = new ShellRefusal('Ferrets is paused on this daemon');
    const { verb } = run({}, refusal);
    expect(await verb('ps').catch((error: unknown) => error)).toBe(refusal);
  });
});

describe('wait and instructions', () => {
  test('V-wait reads GET /v1/ferrets/:id until the ferret settles and exits with the way it settled', async () => {
    const done = sessionView({
      id: 'lead',
      name: 'wren',
      state: 'stopped',
      finishedAt: '2026-11-06T09:00:00.000Z' as never,
    });
    const finished = run({ [FERRET_ROUTES.get]: done });
    expect(await finished.verb('wait <id>', ['lead'])).toBe(0);
    expect(finished.calls).toEqual([{ route: 'GET /v1/ferrets/:ferretId', init: { params: { ferretId: 'lead' } } }]);
    expect(finished.out).toEqual(['lead is stopped']);
    const ended = run({ [FERRET_ROUTES.get]: sessionView({ id: 'lead', state: 'stopped' }) });
    expect(await ended.verb('wait <id>', ['lead'])).toBe(1);
    expect(ended.err.join('')).toContain('fy wait: the ferret ended as stopped');
  });

  test('V-instructions answers from the environment the shell handed over, and says so when there is none', async () => {
    const { verb, out } = run();
    expect(await verb('instructions')).toBe(0);
    expect(out.join('\n')).toContain('not running inside a ferret');
  });
});
