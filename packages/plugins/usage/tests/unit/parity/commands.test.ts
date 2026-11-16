/** Parity rows V-0056, V-0211, V-0235 (docs/design/rebuild-parity.md, usage). */
import { describe, expect, test } from 'bun:test';
import type { CliHalf, PluginClient, TerminalIo, VerbInvocation } from '@ferretry/kernel/manifest';
import cli, { UNSUPPORTED_OUT, UNSUPPORTED_TRACE } from '../../../cli/index.ts';
import manifest from '../../../manifest.ts';
import { minimalReport } from '../contract/performance-report-fixtures.ts';

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
  const verb = (
    name: 'usage' | 'login budget' | 'daemon profile',
    args: string[],
    options: VerbInvocation['options'] = {},
  ) => half.verbs[name]({ args, options });
  return { calls, out, err, verb };
}

const FILE = (text: string) => ({ path: 'usage.yaml', exists: true, text, etag: 'e1' });
/** `GET /v1/logins` as the daemon answers it: the logins this machine has (`work` and `claude-a`). */
const LOGINS = { 'GET /v1/logins': { format: 1, machine: 'laptop', logins: [{ id: 'work' }, { id: 'claude-a' }] } };
const EMPTY_FILE = { path: 'usage.yaml', exists: false, text: '', etag: 'e0' };

describe('fy usage (was fy analytics)', () => {
  test('V-0056 the words after the verb are one insights query, read from the daemon', async () => {
    const t = run({ 'GET /v1/usage/insights': { kind: 'aggregate', results: [], scope: { indexed: 0, matched: 0 } } });

    await t.verb('usage', ['sum', 'by', '(model)'], { json: true });

    expect(t.calls).toEqual([{ route: 'GET /v1/usage/insights', init: { query: { q: 'sum by (model)' } } }]);
    expect(JSON.parse(t.out.join('')).kind).toBe('aggregate');
  });

  test('V-0056 no words reads the default query, with no q sent', async () => {
    const t = run({ 'GET /v1/usage/insights': { kind: 'aggregate', results: [], scope: { indexed: 0, matched: 0 } } });

    await t.verb('usage', [], { json: true });

    expect(t.calls).toEqual([{ route: 'GET /v1/usage/insights', init: {} }]);
  });
});

describe('fy login budget (was fy credential budget)', () => {
  test('V-0211 with no level it shows the login’s budget and its standing', async () => {
    const t = run({
      ...LOGINS,
      'GET /v1/config/file': FILE('budgets:\n  work:\n    daily:\n      hard: 60\n'),
      'GET /v1/usage/budgets': { budgets: [] },
    });

    expect(await t.verb('login budget', ['work'])).toBe(0);

    expect(t.out[0]).toContain('work:');
    expect(t.out[0]).toContain('60');
    // v4's line ends with where to see what it spent.
    expect(t.out[0]).toEndWith('What it spent: `fy login check work`.');
  });

  test('V-0211 / F6 a login this machine does not have is refused as v4 refused it, and nothing is read or written', async () => {
    const t = run({ ...LOGINS, 'GET /v1/config/file': EMPTY_FILE, 'PUT /v1/config/file': { outcome: 'applied' } });

    expect(await t.verb('login budget', ['nope'])).toBe(1);
    expect(await t.verb('login budget', ['nope'], { 'daily-hard': '60' })).toBe(1);

    expect(t.err[0]).toBe('No login "nope" on this machine.\n');
    expect(t.out).toEqual([]);
    expect(t.calls.map(call => call.route)).toEqual(['GET /v1/logins', 'GET /v1/logins']);
  });

  test('V-0211 a level is written into usage.yaml through the checked config write, with the etag it read', async () => {
    const t = run({
      ...LOGINS,
      'GET /v1/config/file': EMPTY_FILE,
      'PUT /v1/config/file': { outcome: 'applied' },
    });

    expect(await t.verb('login budget', ['work'], { 'daily-hard': '60' })).toBe(0);

    const put = t.calls.find(call => call.route === 'PUT /v1/config/file');
    const body = put?.init?.body as { path: string; etag: string; text: string };
    expect(body).toMatchObject({ path: 'usage.yaml', etag: 'e0' });
    expect(body.text).toContain('hard: 60');
  });

  test('V-0211 --dry-run says what would change and writes nothing; a raised limit is held for the owner', async () => {
    const dry = run({ ...LOGINS, 'GET /v1/config/file': EMPTY_FILE });
    expect(await dry.verb('login budget', ['work'], { 'daily-hard': '60', 'dry-run': true })).toBe(0);
    expect(dry.calls.map(call => call.route)).toEqual(['GET /v1/logins', 'GET /v1/config/file']);
    expect(dry.out[0]).toContain('Would set');

    const held = run({
      ...LOGINS,
      'GET /v1/config/file': FILE('budgets:\n  work:\n    daily:\n      hard: 60\n'),
      'PUT /v1/config/file': { outcome: 'pending', pending: { changes: ['a limit goes up'] } },
    });
    await held.verb('login budget', ['work'], { 'daily-hard': '90' });
    expect(held.out[0]).toContain('held for the owner');
  });

  test('V-0211 a missing login id, a bad level and a bad zone are refused before the daemon is asked to write', async () => {
    const noId = run({});
    expect(await noId.verb('login budget', [])).toBe(2);
    expect(noId.calls).toEqual([]);

    const bad = run({ 'GET /v1/config/file': EMPTY_FILE });
    expect(await bad.verb('login budget', ['work'], { 'daily-hard': 'lots' })).toBe(1);
    expect(await bad.verb('login budget', ['work'], { 'time-zone': 'Mars/Olympus' })).toBe(1);
    expect(bad.calls.some(call => call.route === 'PUT /v1/config/file')).toBe(false);
  });
});

describe('fy daemon profile', () => {
  const finished = { 'POST /v1/diagnostics/profile': { state: 'finished', id: 'p1', report: minimalReport() } };

  test('V-0235 --seconds is a whole number from 5 to 300, checked before a window opens', async () => {
    const t = run(finished);
    expect(await t.verb('daemon profile', [], { seconds: '4' })).toBe(1);
    expect(await t.verb('daemon profile', [], { seconds: '301' })).toBe(1);
    expect(await t.verb('daemon profile', [], { seconds: '5.5' })).toBe(1);
    expect(t.calls).toEqual([]);
  });

  test('V-0235 a finished report is printed readably, or as the protocol document with --json', async () => {
    const readable = run(finished);
    expect(await readable.verb('daemon profile', [], { seconds: '5' })).toBe(0);
    expect(readable.calls[0]).toEqual({ route: 'POST /v1/diagnostics/profile', init: { body: { seconds: 5 } } });
    expect(readable.out.join('')).not.toBe('');

    const json = run(finished);
    await json.verb('daemon profile', [], { json: true });
    expect(JSON.parse(json.out.join('')).version).toBe(1);
  });

  test('V-0235 --out and --trace-syscalls are refused out loud, naming the CLI shell facility they need', async () => {
    const out = run(finished);
    expect(await out.verb('daemon profile', [], { out: 'report.json' })).toBe(2);
    expect(out.err).toEqual([UNSUPPORTED_OUT]);

    const trace = run(finished);
    expect(await trace.verb('daemon profile', [], { 'trace-syscalls': true })).toBe(2);
    expect(trace.err).toEqual([UNSUPPORTED_TRACE]);
    expect(out.calls.concat(trace.calls)).toEqual([]);
  });

  test.skip('V-0235 --out writes the full report to a file and --trace-syscalls adds the strace/fs_usage table — pending port: the CLI shell’s file-write and process-run facilities (CliContext carries only `client` and `io`)', () => {});
});
