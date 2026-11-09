import { describe, expect, test } from 'bun:test';
import type { CliContext, Manifest, PluginClient, VerbInvocation } from '@ferretry/kernel/manifest';
import cli from '../../../cli/index.ts';
import { FERRET_ROUTES } from '../../../cli/lib/client.ts';
import { WORKTREE_ROUTES } from '../../../cli/lib/worktrees/gateway.ts';
import manifest from '../../../manifest.ts';
import { READY_PREVIEW } from '../cli/move/fixtures.ts';
import { sessionView } from '../cli/session/session-fixtures.ts';
import { blocker, created, decision, listResponse, removed, WORKTREE_PATH } from '../cli/worktrees/fixtures.ts';

interface Call {
  readonly route: string;
  readonly init?: unknown;
}

type Options = VerbInvocation['options'];

/** A shell refusal (the daemon's final "no"): it carries its own exit code. */
class LostDaemon extends Error {
  override readonly name = 'TransportError';
}

interface World {
  readonly answers?: Readonly<Record<string, unknown>>;
  readonly fail?: Error;
  readonly env?: Readonly<Record<string, string>>;
  readonly exists?: NonNullable<CliContext<Manifest>['exists']>;
  readonly readText?: NonNullable<CliContext<Manifest>['readText']>;
  readonly readBytes?: NonNullable<CliContext<Manifest>['readBytes']>;
}

/** The cli half's verbs, run against a recording API: what each asks the daemon, what it prints, how it exits. */
function run(world: World = {}) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const client: PluginClient = {
    call: async (route, init) => {
      calls.push(init === undefined ? { route } : { route, init });
      if (world.fail !== undefined) throw world.fail;
      return (world.answers?.[route] ?? {}) as never;
    },
    subscribe: () => () => undefined,
  };
  let time = 0;
  const half = cli.build?.({
    manifest,
    client,
    io: { out: text => out.push(text), err: text => err.push(text), isTty: false },
    clock: { now: () => '2026-11-06T09:00:00.000Z' as never, nowMs: () => time },
    sleep: async delay => {
      time += Number(delay);
    },
    ...(world.env === undefined ? {} : { env: world.env }),
    ...(world.exists === undefined ? {} : { exists: world.exists }),
    ...(world.readText === undefined ? {} : { readText: world.readText }),
    ...(world.readBytes === undefined ? {} : { readBytes: world.readBytes }),
  });
  if (half === undefined) throw new Error('the cli half is real');
  const verbs = half.verbs as Readonly<Record<string, (invocation: VerbInvocation) => Promise<number>>>;
  const verb = async (line: string, args: readonly string[] = [], options: Options = {}) => {
    const handler = verbs[line];
    if (handler === undefined) throw new Error(`no verb ${line}`);
    return await handler({ args, options });
  };
  return { verb, verbs, calls, out, err };
}

const lead = sessionView({ id: 'lead', name: 'wren' });
const helper = sessionView({ id: 'mid', name: 'fern', parent: 'lead' });
const FINISHED = '2026-11-06T09:00:00.000Z' as never;
const STARTED = { id: 'lead' };

/** Each row this file proves, with the 5.0 verb it lives at (the TSV's `name5`, without the binary's name). */
const ROWS: readonly (readonly [id: string, v5: string])[] = [
  ['V-0290', 'instructions'],
  ['V-0329', 'ferret move <id>'],
  ['V-0334', 'new [words...]'],
  ['V-0366', 'ps'],
  ['V-0371', 'rename <session> [name]'],
  ['V-0375', 'restart [ids...]'],
  ['V-0376', 'resume <id> [message...]'],
  ['V-0431', 'session'],
  ['V-0433', 'session pin <session>'],
  ['V-0434', 'session revoke-credential <session>'],
  ['V-0435', 'session unpin <session>'],
  ['V-0437', 'signal <kind> [message...]'],
  ['V-0443', 'start [prompt...]'],
  ['V-0445', 'status [id]'],
  ['V-0447', 'stop'],
  ['V-0448', 'stop cascade <session>'],
  ['V-0449', 'stop children <session>'],
  ['V-0450', 'stop label <label>'],
  ['V-0451', 'stop orphan <session>'],
  ['V-0496', 'wait <id>'],
  ['V-0497', 'worktree'],
  ['V-0499', 'worktree check <path>'],
  ['V-0500', 'worktree fork <branch>'],
  ['V-0502', 'worktree ls'],
  ['V-0504', 'worktree rm <path>'],
];

describe('commands parity', () => {
  test('V-0333 fy name -n 2 asks GET /v1/names for two and prints the names, one per line', async () => {
    const { verb, calls, out } = run({ answers: { 'GET /v1/names': ['ash', 'elm'] } });
    expect(await verb('name', [], { n: '2' })).toBe(0);
    expect(calls).toEqual([{ route: 'GET /v1/names', init: { query: { count: '2' } } }]);
    expect(out.join('\n')).toBe('ash\nelm');
  });

  describe('declared', () => {
    for (const [id, v5] of ROWS) {
      test(`${id} fy ${v5} is declared by the manifest and implemented by the cli half`, () => {
        expect(manifest.actions.cli?.some(decl => decl.verb === v5)).toBe(true);
        expect(typeof run().verbs[v5]).toBe('function');
      });
    }
  });

  describe('instructions and move', () => {
    const launched = {
      FY_SESSION_ID: 'wren',
      FY_SESSION_MODE: 'auto',
      FY_HYPERMEDIA: '1',
      FY_PACK: '0',
      FY_AGENDA: '0',
      FY_LEARNING_PASSIVE: '1',
    };

    test('V-0290 fy instructions prints the sections this ferret launched with; --json prints them as data; no network', async () => {
      const text = run({ env: launched });
      expect(await text.verb('instructions')).toBe(0);
      expect(text.out.join('\n')).toContain('Sections ferret wren launched with (auto):');
      expect(text.out.join('\n')).toContain('✓ Hypermedia: on');
      expect(text.out.join('\n')).toContain('✗ Pack mode: off');
      const data = run({ env: launched });
      expect(await data.verb('instructions', [], { json: true })).toBe(0);
      const report = JSON.parse(data.out.join('\n')) as { sections: { id: string; on: boolean }[] };
      expect(report.sections.map(section => [section.id, section.on])).toEqual([
        ['hypermedia', true],
        ['pack', false],
        ['agenda', false],
        ['lessons', true],
      ]);
      expect([...text.calls, ...data.calls]).toEqual([]);
      const outside = run();
      expect(await outside.verb('instructions')).toBe(0);
      expect(outside.out.join('\n')).toContain('not running inside a ferret');
    });

    test('V-0329 fy ferret move <id> posts the move under a request id with v4 flags; --preview reads and moves nothing', async () => {
      const MOVE = 'POST /v1/ferrets/:ferretId/move';
      const moved = run({ answers: { [MOVE]: lead } });
      expect(
        await moved.verb('ferret move <id>', ['wren'], {
          agent: 'codex-beta',
          model: 'gpt-5.6-sol',
          'allow-context-downgrade': true,
          'force-inflight': true,
          conversation: 'fresh',
          'request-id': 'k1',
          json: true,
        }),
      ).toBe(0);
      expect(moved.calls).toEqual([
        {
          route: MOVE,
          init: {
            params: { ferretId: 'wren' },
            body: {
              agent: 'codex-beta',
              model: 'gpt-5.6-sol',
              allowContextDowngrade: true,
              forceInflight: true,
              conversation: 'fresh',
            },
            headers: { 'x-fy-request-id': 'k1' },
          },
        },
      ]);
      expect(JSON.parse(moved.out.join('\n'))).toMatchObject({ id: 'lead' });

      const short = run({ answers: { [MOVE]: lead } });
      expect(await short.verb('ferret move <id>', ['wren'], { a: 'codex-beta', convert: true })).toBe(0);
      expect(short.calls[0]?.init).toMatchObject({
        body: { agent: 'codex-beta', conversation: 'convert', allowContextDowngrade: false, forceInflight: false },
        headers: { 'x-fy-request-id': expect.any(String) },
      });

      const previewed = run({
        answers: { 'POST /v1/ferrets/:ferretId/conversion-preview': READY_PREVIEW },
      });
      expect(
        await previewed.verb('ferret move <id>', ['wren'], { a: 'codex-beta', convert: true, preview: true }),
      ).toBe(0);
      expect(previewed.calls.map(call => call.route)).toEqual(['POST /v1/ferrets/:ferretId/conversion-preview']);

      const bare = run();
      expect(await bare.verb('ferret move <id>', ['wren'])).toBe(1);
      expect(bare.err.join('\n')).toContain('--agent');
      expect(bare.calls).toEqual([]);
    });
  });

  describe('reads', () => {
    test('V-0366 fy ps lists GET /v1/ferrets, -a adds stopped ones, --json prints data; -l is refused with the word that replaced it', async () => {
      const stopped = sessionView({ id: 'old', name: 'oak', state: 'stopped' });
      const answers = { [FERRET_ROUTES.list]: [lead, stopped] };
      const plain = run({ answers });
      expect(await plain.verb('ps')).toBe(0);
      expect(plain.calls).toEqual([{ route: 'GET /v1/ferrets' }]);
      expect(plain.out.join('\n')).toContain('wren');
      expect(plain.out.join('\n')).not.toContain('oak');
      for (const flag of ['a', 'all']) {
        const all = run({ answers });
        expect(await all.verb('ps', [], { [flag]: true })).toBe(0);
        expect(all.out.join('\n')).toContain('oak');
      }
      const json = run({ answers });
      expect(await json.verb('ps', [], { json: true })).toBe(0);
      expect(JSON.parse(json.out.join('\n'))).toBeArray();
      for (const flag of ['l', 'label']) {
        const labelled = run({ answers });
        expect(await labelled.verb('ps', [], { [flag]: 'mine' })).toBe(2);
        expect(labelled.err.join('\n')).toContain('--pack');
        expect(labelled.calls).toEqual([]);
      }
    });

    test('V-0445 fy status [id] reads one ferret, --json prints it, --subtree reads the lineage table; no id is a usage error', async () => {
      const one = run({ answers: { [FERRET_ROUTES.get]: lead } });
      expect(await one.verb('status [id]', ['wren'])).toBe(0);
      expect(one.calls).toEqual([{ route: 'GET /v1/ferrets/:ferretId', init: { params: { ferretId: 'wren' } } }]);
      expect(one.out.join('\n')).toContain('wren');
      const json = run({ answers: { [FERRET_ROUTES.get]: lead } });
      expect(await json.verb('status [id]', ['wren'], { json: true })).toBe(0);
      expect(JSON.parse(json.out.join('\n'))).toMatchObject({ id: 'lead', name: 'wren' });
      const tree = run({
        answers: {
          [FERRET_ROUTES.subtree]: {
            root: { id: 'lead', name: 'wren' },
            at: '2026-11-06T09:00:00.000Z',
            endedWindowMs: 7_200_000,
            rows: [{ id: 'mid', parent: 'lead', name: 'fern', depth: 1, state: 'running', ferretState: 'working' }],
          },
        },
      });
      expect(await tree.verb('status [id]', ['wren'], { subtree: true })).toBe(0);
      expect(tree.calls).toEqual([
        { route: 'GET /v1/ferrets/:ferretId/subtree', init: { params: { ferretId: 'wren' } } },
      ]);
      expect(tree.out.join('\n')).toContain('fern');
      const none = run();
      expect(await none.verb('status [id]')).toBe(2);
      expect(none.err.join('\n')).toContain('status <id>');
      expect(await none.verb('status [id]', [], { subtree: true })).toBe(2);
      expect(none.calls).toEqual([]);
    });

    test('V-0496 fy wait <id> exits 0 completed, 1 ended, 3 needs a human, 69 daemon lost, 124 timeout; --json, --interval, --timeout, --until-marker', async () => {
      const exitOf = async (
        state: Partial<Parameters<typeof sessionView>[0]>,
        options: Options = {},
        world?: World,
      ) => {
        const wait = run({ answers: { [FERRET_ROUTES.get]: sessionView({ id: 'lead', ...state }) }, ...world });
        return { code: await wait.verb('wait <id>', ['lead'], options), ...wait };
      };
      const completed = await exitOf({ state: 'stopped', finishedAt: FINISHED });
      expect(completed.code).toBe(0);
      expect(completed.out).toEqual(['lead is stopped']);
      const json = await exitOf({ state: 'stopped', finishedAt: FINISHED }, { json: true });
      expect(JSON.parse(json.out.join(''))).toMatchObject({ id: 'lead', state: 'stopped' });
      const ended = await exitOf({ state: 'stopped' });
      expect(ended.code).toBe(1);
      expect(ended.err.join('')).toContain('the ferret ended as stopped');
      const parked = await exitOf({ state: 'idle' });
      expect(parked.code).toBe(3);
      const slow = await exitOf({ state: 'working' }, { timeout: '2', interval: '1' });
      expect(slow.code).toBe(124);
      const marker = await exitOf({ state: 'working' }, { 'until-marker': 'out.md' }, { exists: async () => true });
      expect(marker.code).toBe(0);
      const lost = run({ fail: new LostDaemon('connection refused') });
      expect(await lost.verb('wait <id>', ['lead'])).toBe(69);
      expect(lost.err.join('')).toContain('fy wait:');
      const blank = run();
      expect(await blank.verb('wait <id>', [''])).toBe(2);
      expect(blank.calls).toEqual([]);
    });
  });

  describe('starting', () => {
    const startAnswers = { [FERRET_ROUTES.start]: STARTED, [FERRET_ROUTES.get]: lead };

    test('V-0443 fy start sends every flag Ferrets takes under its wire name, in v4 forms (-a, --no-fast, repeated --harness-flag)', async () => {
      const start = run({ answers: startAnswers });
      expect(
        await start.verb('start [prompt...]', ['fix', 'login'], {
          a: 'claude-alpha',
          cwd: '/abs',
          teammate: 'wren',
          'teammate-fallback': true,
          parent: 'boss',
          name: 'Fix login',
          label: 'mine',
          card: '&F21',
          model: 'opus',
          fast: true,
          rc: false,
          'harness-flag': ['--a', '--b'],
          interval: '30',
          'turn-timeout': '3600',
          'nudge-after': '120',
          'stall-kill-after': '900',
          'direct-max': '0',
          'max-snapshots': '5',
          json: true,
        }),
      ).toBe(0);
      expect(start.calls[0]).toEqual({
        route: 'POST /v1/ferrets',
        init: {
          headers: { 'x-fy-request-id': expect.any(String) },
          body: {
            folder: '/abs',
            runtime: 'claude-alpha',
            name: 'wren',
            parent: 'boss',
            prompt: 'fix login',
            mode: 'auto',
            teammateFallback: true,
            title: 'Fix login',
            label: 'mine',
            card: 'F21',
            model: 'opus',
            fast: true,
            remoteControl: false,
            harnessFlags: ['--a', '--b'],
            intervalSeconds: 30,
            timeoutSeconds: 3600,
            nudgeAfterSeconds: 120,
            killAfterSeconds: 900,
            directSendMaxChars: 0,
            maxSnapshots: 5,
          },
        },
      });
      expect(JSON.parse(start.out.join('\n'))).toMatchObject({ id: 'lead' });
      const negated = run({ answers: startAnswers });
      expect(
        await negated.verb('start [prompt...]', [], {
          agent: 'claude-alpha',
          mode: 'interactive',
          fast: false,
          rc: true,
        }),
      ).toBe(0);
      expect(negated.calls[0]?.init).toMatchObject({ body: { mode: 'interactive', fast: false, remoteControl: true } });
    });

    test('V-0443 fy start refuses, by name and unsent, a flag whose job another plugin took (--compact-at, --detach) and a bad number or mode', async () => {
      for (const options of [{ 'compact-at': '250k' }, { detach: true }] as Options[]) {
        const refused = run({ answers: startAnswers });
        expect(await refused.verb('start [prompt...]', ['x'], options)).toBe(2);
        expect(refused.err.join('\n')).toContain(`--${Object.keys(options)[0]}`);
        expect(refused.calls).toEqual([]);
      }
      const bad = run({ answers: startAnswers });
      expect(await bad.verb('start [prompt...]', ['x'], { cwd: '/abs', interval: 'banana' })).toBe(2);
      expect(await bad.verb('start [prompt...]', ['x'], { cwd: '/abs', mode: 'sideways' })).toBe(2);
      expect(await bad.verb('start [prompt...]', [], { cwd: '/abs' })).toBe(2);
      expect(bad.err.join('\n')).toContain('provide a prompt');
      expect(bad.calls).toEqual([]);
    });

    test('V-0443 fy start --prompt-file reads the brief on the caller’s machine and sends its text AFTER the typed words; no path is sent to the daemon', async () => {
      const files: Record<string, string> = { 'brief.md': '\n  Fix the login page.\n\nThen run the tests.  \n' };
      const reads: string[] = [];
      const readText = async (path: string): Promise<string> => {
        reads.push(path);
        const found = files[path];
        if (found === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
        return found;
      };
      const only = run({ answers: startAnswers, readText });
      expect(await only.verb('start [prompt...]', [], { cwd: '/abs', 'prompt-file': 'brief.md' })).toBe(0);
      expect(reads).toEqual(['brief.md']);
      expect(only.calls[0]?.init).toMatchObject({
        body: { folder: '/abs', prompt: 'Fix the login page.\n\nThen run the tests.', mode: 'auto' },
      });
      expect(JSON.stringify(only.calls)).not.toContain('brief.md');
      const both = run({ answers: startAnswers, readText });
      expect(await both.verb('start [prompt...]', ['read', 'this'], { cwd: '/abs', 'prompt-file': 'brief.md' })).toBe(
        0,
      );
      expect(both.calls[0]?.init).toMatchObject({
        body: { prompt: 'read this\n\nFix the login page.\n\nThen run the tests.' },
      });
    });

    test('V-0443 fy start --prompt-file refuses an unreadable path naming it, an empty file with no other prompt, a bare flag, and a shell with no reader; each sends nothing', async () => {
      const readText = async (path: string): Promise<string> => {
        if (path === 'empty.md') return '  \n\n';
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      };
      const missing = run({ answers: startAnswers, readText });
      expect(await missing.verb('start [prompt...]', ['x'], { cwd: '/abs', 'prompt-file': 'nope.md' })).toBe(2);
      expect(missing.err.join('\n')).toContain('cannot read nope.md: ENOENT');
      const empty = run({ answers: startAnswers, readText });
      expect(await empty.verb('start [prompt...]', [], { cwd: '/abs', 'prompt-file': 'empty.md' })).toBe(2);
      expect(empty.err.join('\n')).toContain('provide a prompt (arguments and/or --prompt-file)');
      // An interactive start may be bare, so an empty file there adds nothing and the start goes ahead.
      const bare = run({ answers: startAnswers, readText });
      expect(
        await bare.verb('start [prompt...]', [], { cwd: '/abs', mode: 'interactive', 'prompt-file': 'empty.md' }),
      ).toBe(0);
      expect(bare.calls[0]?.init).toEqual({
        headers: { 'x-fy-request-id': expect.any(String) },
        body: { folder: '/abs', mode: 'interactive' },
      });
      const noPath = run({ answers: startAnswers, readText });
      expect(await noPath.verb('start [prompt...]', ['x'], { cwd: '/abs', 'prompt-file': true })).toBe(2);
      expect(noPath.err.join('\n')).toContain('--prompt-file needs the path of a file to read');
      const noReader = run({ answers: startAnswers });
      expect(await noReader.verb('start [prompt...]', ['x'], { cwd: '/abs', 'prompt-file': 'brief.md' })).toBe(1);
      expect(noReader.err.join('\n')).toContain('file reader');
      for (const refused of [missing, empty, noPath, noReader]) expect(refused.calls).toEqual([]);
    });

    test('V-0443 fy start -f/--file reads each file as raw bytes on the caller’s machine and sends it inline as base64 (repeatable; a type only for an image); no path reaches the daemon', async () => {
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00]);
      const docx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x80]);
      const reads: string[] = [];
      const files: Record<string, Uint8Array> = { 'shots/Login.PNG': png, '/abs/brief.docx': docx };
      const readBytes = async (path: string): Promise<Uint8Array> => {
        reads.push(path);
        const found = files[path];
        if (found === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
        return found;
      };
      const short = run({ answers: startAnswers, readBytes });
      expect(
        await short.verb('start [prompt...]', ['fix', 'it'], {
          cwd: '/abs',
          f: ['shots/Login.PNG', '/abs/brief.docx'],
        }),
      ).toBe(0);
      expect(reads).toEqual(['shots/Login.PNG', '/abs/brief.docx']);
      expect(short.calls[0]?.init).toMatchObject({
        body: {
          folder: '/abs',
          prompt: 'fix it',
          initialAttachments: [
            { filename: 'Login.PNG', mime: 'image/png', base64: Buffer.from(png).toString('base64') },
            { filename: 'brief.docx', base64: Buffer.from(docx).toString('base64') },
          ],
        },
      });
      expect(JSON.stringify(short.calls)).not.toContain('shots/');
      const long = run({ answers: startAnswers, readBytes });
      expect(await long.verb('start [prompt...]', ['x'], { cwd: '/abs', file: '/abs/brief.docx' })).toBe(0);
      expect(long.calls[0]?.init).toMatchObject({ body: { initialAttachments: [{ filename: 'brief.docx' }] } });
      // A start with no file sends no member at all.
      const none = run({ answers: startAnswers, readBytes });
      expect(await none.verb('start [prompt...]', ['x'], { cwd: '/abs' })).toBe(0);
      expect(none.calls[0]?.init).not.toHaveProperty('body.initialAttachments');
    });

    test('V-0443 fy start -f refuses an unreadable path naming it, an empty file, two files of one name, a bare flag, a start with no opening message and a shell with no byte reader; each sends nothing', async () => {
      const readBytes = async (path: string): Promise<Uint8Array> => {
        if (path === 'empty.png') return new Uint8Array();
        if (path !== 'nope.png' && path.endsWith('.png')) return new Uint8Array([1, 2, 3]);
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      };
      const refusals: readonly [string, readonly string[], Options, string][] = [
        ['missing', ['x'], { f: 'nope.png', cwd: '/abs' }, 'cannot read attachment nope.png: ENOENT'],
        ['empty', ['x'], { file: 'empty.png', cwd: '/abs' }, 'attachment empty.png is empty'],
        ['same name', ['x'], { f: ['a/one.png', 'b/one.png'], cwd: '/abs' }, 'two attachments are named one.png'],
        ['bare flag', ['x'], { f: true, cwd: '/abs' }, '-f/--file needs the path of a file to attach'],
        ['no prompt', [], { f: 'a.png', cwd: '/abs', mode: 'interactive' }, 'attachments belong to an opening message'],
      ];
      for (const [, args, options, message] of refusals) {
        const refused = run({ answers: startAnswers, readBytes });
        expect(await refused.verb('start [prompt...]', args, options)).toBe(2);
        expect(refused.err.join('\n')).toContain(message);
        expect(refused.calls).toEqual([]);
      }
      const noReader = run({ answers: startAnswers });
      expect(await noReader.verb('start [prompt...]', ['x'], { f: 'a.png', cwd: '/abs' })).toBe(1);
      expect(noReader.err.join('\n')).toContain('byte reader');
      expect(noReader.calls).toEqual([]);
      // A prompt file is a prompt: files attach to a start whose brief came from a file.
      const filed = run({ answers: startAnswers, readBytes, readText: async () => 'the brief' });
      expect(await filed.verb('start [prompt...]', [], { f: 'a.png', 'prompt-file': 'b.md', cwd: '/abs' })).toBe(0);
      expect(filed.calls[0]?.init).toMatchObject({
        body: { prompt: 'the brief', initialAttachments: [{ filename: 'a.png' }] },
      });
    });

    test('V-0334 fy new takes no attachments: --file is refused by name and unsent', async () => {
      const refused = run({ answers: startAnswers });
      expect(await refused.verb('new [words...]', ['x'], { runtime: 'codex-beta', file: 'a.png' })).toBe(2);
      expect(refused.err.join('\n')).toContain('--file');
      expect(refused.calls).toEqual([]);
    });

    test('V-0443 fy start --request-id sends the caller’s key as the start’s request id, so a retry with it answers the same ferret; a blank key is refused', async () => {
      const first = run({ answers: startAnswers });
      expect(await first.verb('start [prompt...]', ['x'], { cwd: '/abs', 'request-id': ' retry-7 ' })).toBe(0);
      const again = run({ answers: startAnswers });
      expect(await again.verb('start [prompt...]', ['x'], { cwd: '/abs', 'request-id': 'retry-7' })).toBe(0);
      for (const sent of [first, again])
        expect(sent.calls[0]).toEqual({
          route: 'POST /v1/ferrets',
          init: {
            headers: { 'x-fy-request-id': 'retry-7' },
            body: { folder: '/abs', prompt: 'x', mode: 'auto' },
          },
        });
      const blank = run({ answers: startAnswers });
      expect(await blank.verb('start [prompt...]', ['x'], { cwd: '/abs', 'request-id': '  ' })).toBe(2);
      expect(blank.err.join('\n')).toContain('--request-id must not be blank');
      const bare = run({ answers: startAnswers });
      expect(await bare.verb('start [prompt...]', ['x'], { cwd: '/abs', 'request-id': true })).toBe(2);
      expect([...blank.calls, ...bare.calls]).toEqual([]);
    });

    test('V-0334 fy new --prompt-file takes the file as THE brief (the typed words give way); an unreadable path, an empty file and a bare flag are refused unsent', async () => {
      const readText = async (path: string): Promise<string> => {
        if (path === 'brief.md') return '\nLook at the build.\n';
        if (path === 'empty.md') return '\n';
        throw new Error(`EACCES: permission denied, open '${path}'`);
      };
      const filed = run({ answers: startAnswers, readText });
      expect(
        await filed.verb('new [words...]', ['ignored', 'words'], {
          runtime: 'codex-beta',
          cwd: '/abs',
          'prompt-file': 'brief.md',
        }),
      ).toBe(0);
      expect(filed.calls[0]?.init).toMatchObject({
        body: { folder: '/abs', runtime: 'codex-beta', prompt: 'Look at the build.' },
      });
      const refusals: readonly [Options, string][] = [
        [{ 'prompt-file': 'locked.md' }, 'cannot read locked.md: EACCES'],
        [{ 'prompt-file': 'empty.md' }, 'provide a prompt (arguments and/or --prompt-file)'],
        [{ 'prompt-file': true }, '--prompt-file needs the path of a file to read'],
      ];
      for (const [options, message] of refusals) {
        const refused = run({ answers: startAnswers, readText });
        expect(await refused.verb('new [words...]', ['x'], { runtime: 'codex-beta', cwd: '/abs', ...options })).toBe(2);
        expect(refused.err.join('\n')).toContain(message);
        expect(refused.calls).toEqual([]);
      }
    });

    test('V-0334 fy new has no idempotency key of its own: --request-id is refused by name and unsent', async () => {
      const refused = run({ answers: startAnswers });
      expect(await refused.verb('new [words...]', ['x'], { runtime: 'codex-beta', 'request-id': 'k' })).toBe(2);
      expect(refused.err.join('\n')).toContain('--request-id');
      expect(refused.calls).toEqual([]);
    });

    test('V-0334 fy new starts a helper on a named --runtime or --auto (never both), with --model, --effort, --name, --card, --json', async () => {
      const named = run({ answers: startAnswers });
      expect(
        await named.verb('new [words...]', ['look', 'around'], {
          runtime: 'codex-beta',
          model: 'gpt-5.6-sol',
          effort: 'high',
          name: 'Look',
          card: 'F3',
          cwd: '/abs',
          json: true,
        }),
      ).toBe(0);
      expect(named.calls[0]?.init).toMatchObject({
        body: {
          folder: '/abs',
          runtime: 'codex-beta',
          prompt: 'look around',
          model: 'gpt-5.6-sol',
          effort: 'high',
          title: 'Look',
          card: 'F3',
        },
      });
      const auto = run({ answers: startAnswers });
      expect(await auto.verb('new [words...]', ['look'], { auto: true, cwd: '/abs' })).toBe(0);
      expect(auto.calls[0]?.init).toMatchObject({ body: { auto: true } });
      const both = run({ answers: startAnswers });
      expect(await both.verb('new [words...]', ['look'], { auto: true, runtime: 'codex-beta' })).toBe(2);
      expect(both.err.join('\n')).toContain('--auto picks the runtime');
      expect(await both.verb('new [words...]', ['look'], { cwd: '/abs' })).toBe(2);
      expect(both.err.join('\n')).toContain('name a --runtime, or pass --auto');
      for (const flag of ['continue', 'since', 'allow-scratch', 'compact-at', 'request-id']) {
        expect(await both.verb('new [words...]', ['look'], { runtime: 'codex-beta', [flag]: 'x' })).toBe(2);
        expect(both.err.at(-1)).toContain(`--${flag}`);
      }
      expect(both.calls).toEqual([]);
    });
  });

  describe('lifecycle', () => {
    test('V-0371 fy rename <session> [name] renames by first name, by --title, or both; --json prints the ferret', async () => {
      const answers = { [FERRET_ROUTES.rename]: lead };
      const first = run({ answers });
      expect(await first.verb('rename <session> [name]', ['lead', 'wren'])).toBe(0);
      expect(first.calls).toEqual([
        { route: 'POST /v1/ferrets/:ferretId/rename', init: { params: { ferretId: 'lead' }, body: { name: 'wren' } } },
      ]);
      const both = run({ answers });
      expect(await both.verb('rename <session> [name]', ['lead', 'wren'], { title: 'Fix login', json: true })).toBe(0);
      expect(both.calls[0]?.init).toEqual({
        params: { ferretId: 'lead' },
        body: { name: 'wren', title: 'Fix login' },
      });
      expect(JSON.parse(both.out.join('\n'))).toMatchObject({ id: 'lead' });
      const bare = run({ answers });
      expect(await bare.verb('rename <session> [name]', ['lead'])).toBe(2);
      expect(await bare.verb('rename <session> [name]')).toBe(2);
      expect(bare.calls).toEqual([]);
    });

    test('V-0376 fy resume <id> [message...] revives a stopped ferret, carrying the message words; --json prints it', async () => {
      const answers = { [FERRET_ROUTES.resume]: STARTED, [FERRET_ROUTES.get]: lead };
      const plain = run({ answers });
      expect(await plain.verb('resume <id> [message...]', ['wren'])).toBe(0);
      expect(plain.calls[0]).toEqual({
        route: 'POST /v1/ferrets/:ferretId/resume',
        init: { params: { ferretId: 'wren' } },
      });
      const said = run({ answers });
      expect(await said.verb('resume <id> [message...]', ['wren', 'carry', 'on'], { json: true })).toBe(0);
      expect(said.calls[0]?.init).toEqual({ params: { ferretId: 'wren' }, body: { message: 'carry on' } });
      expect(JSON.parse(said.out.join('\n'))).toMatchObject({ id: 'lead' });
      const none = run({ answers });
      expect(await none.verb('resume <id> [message...]')).toBe(2);
      expect(none.calls).toEqual([]);
    });

    test('V-0375 fy restart [ids...] reads the queue bare, restarts ids/--outdated/--all, --cancel clears it, one mode at a time', async () => {
      const result = { restarted: ['lead'], queued: [], skipped: [], failed: [] };
      const answers = {
        [FERRET_ROUTES.restarts]: { outdated: [], queued: [] },
        [FERRET_ROUTES.restart]: result,
        [FERRET_ROUTES.cancelRestarts]: { cancelled: 2 },
      };
      const cases: readonly [args: string[], options: Options, call: Call][] = [
        [[], {}, { route: 'GET /v1/restarts' }],
        [['wren', 'fern'], {}, { route: 'POST /v1/restarts', init: { body: { scope: 'ids', ids: ['wren', 'fern'] } } }],
        [[], { outdated: true }, { route: 'POST /v1/restarts', init: { body: { scope: 'outdated' } } }],
        [[], { all: true }, { route: 'POST /v1/restarts', init: { body: { scope: 'all' } } }],
        [[], { cancel: true }, { route: 'DELETE /v1/restarts' }],
      ];
      for (const [args, options, call] of cases) {
        const restart = run({ answers });
        expect(await restart.verb('restart [ids...]', args, options)).toBe(0);
        expect(restart.calls).toEqual([call]);
      }
      const json = run({ answers });
      expect(await json.verb('restart [ids...]', [], { cancel: true, json: true })).toBe(0);
      expect(JSON.parse(json.out.join('\n'))).toEqual({ cancelled: 2 });
      const refused = run({ answers });
      expect(await refused.verb('restart [ids...]', ['wren'], { all: true })).toBe(2);
      expect(refused.calls).toEqual([]);
      const failed = run({
        answers: { ...answers, [FERRET_ROUTES.restart]: { ...result, failed: [{ id: 'lead', reason: 'gone' }] } },
      });
      expect(await failed.verb('restart [ids...]', ['wren'])).toBe(1);
    });

    test('V-0375 fy restart --request-id sends the caller’s key with the restart, so an explicit retry is answered not run again; a blank key is refused unsent', async () => {
      const result = { restarted: ['lead'], queued: [], skipped: [], failed: [] };
      const answers = { [FERRET_ROUTES.restart]: result };
      const keyed = run({ answers });
      expect(await keyed.verb('restart [ids...]', ['wren'], { 'request-id': ' retry-3 ' })).toBe(0);
      expect(keyed.calls).toEqual([
        {
          route: 'POST /v1/restarts',
          init: { body: { scope: 'ids', ids: ['wren'] }, headers: { 'x-fy-request-id': 'retry-3' } },
        },
      ]);
      const unkeyed = run({ answers });
      expect(await unkeyed.verb('restart [ids...]', [], { outdated: true })).toBe(0);
      expect(unkeyed.calls[0]?.init).toEqual({ body: { scope: 'outdated' } });
      for (const bad of ['  ', true]) {
        const blank = run({ answers });
        expect(await blank.verb('restart [ids...]', ['wren'], { 'request-id': bad })).toBe(2);
        expect(blank.err.join('\n')).toContain('--request-id must not be blank');
        expect(blank.calls).toEqual([]);
      }
    });

    test('V-0437 fy signal <kind> [message...] sends done/help/waiting/working for --session, with --until, --on and --peer on waiting only', async () => {
      const answers = {
        [FERRET_ROUTES.signal]: { waiting: { since: '2026-11-06T09:00:00.000Z', condition: 'CI' } },
      };
      const done = run({ answers });
      expect(await done.verb('signal <kind> [message...]', ['done', 'all', 'green'], { session: 'wren' })).toBe(0);
      expect(done.calls).toEqual([
        {
          route: 'POST /v1/ferrets/:ferretId/signal',
          init: { params: { ferretId: 'wren' }, body: { kind: 'done', message: 'all green' } },
        },
      ]);
      const waiting = run({ answers });
      expect(
        await waiting.verb('signal <kind> [message...]', ['waiting'], {
          session: 'wren',
          on: 'CI',
          until: '10m',
          peer: 'fern',
          json: true,
        }),
      ).toBe(0);
      expect(waiting.calls[0]?.init).toEqual({
        params: { ferretId: 'wren' },
        body: { kind: 'waiting', until: '10m', condition: 'CI', peer: 'fern' },
      });
      expect(JSON.parse(waiting.out.join('\n'))).toMatchObject({ waiting: { condition: 'CI' } });
      const note = run({ answers });
      expect(await note.verb('signal <kind> [message...]', ['waiting'], { session: 'wren', on: 'CI' })).toBe(0);
      expect(note.out.join('\n')).toContain('waiting recorded for CI');
      const refusals: readonly [string[], Options, string][] = [
        [['bogus'], { session: 'wren' }, 'kind must be one of done, help, waiting, working'],
        [['done'], {}, '--session'],
        [['help'], { session: 'wren' }, 'signal help requires a message'],
        [['done'], { session: 'wren', on: 'CI' }, '--until/--on/--peer apply to `signal waiting`'],
      ];
      for (const [args, options, message] of refusals) {
        const refused = run({ answers });
        expect(await refused.verb('signal <kind> [message...]', args, options)).toBe(2);
        expect(refused.err.join('\n')).toContain(message);
        expect(refused.calls).toEqual([]);
      }
    });
  });

  describe('session group', () => {
    test('V-0431 fy session prints its verbs and is a usage error; V-0433 V-0435 pin/unpin call their route and say so, --json prints the ferret; V-0434 revoke-credential cuts the token', async () => {
      const bare = run();
      expect(await bare.verb('session')).toBe(2);
      expect(bare.out.join('\n')).toContain("act on a ferret's own standing");
      expect(bare.out.join('\n')).toContain('session revoke-credential');
      expect(bare.calls).toEqual([]);

      const pinned = { ...lead, pinnedAt: '2026-11-01T10:00:00.000Z' };
      const pin = run({ answers: { [FERRET_ROUTES.pin]: pinned, [FERRET_ROUTES.unpin]: lead } });
      expect(await pin.verb('session pin <session>', ['wren'])).toBe(0);
      expect(pin.out.join('\n')).toContain('pinned wren (lead) to the top of the sidebar');
      expect(await pin.verb('session unpin <session>', ['wren'])).toBe(0);
      expect(pin.out.join('\n')).toContain('unpinned wren (lead)');
      expect(await pin.verb('session pin <session>', ['wren'], { json: true })).toBe(0);
      expect(JSON.parse(pin.out.at(-1) ?? '')).toMatchObject({ pinnedAt: '2026-11-01T10:00:00.000Z' });
      expect(pin.calls.map(call => call.route)).toEqual([
        'POST /v1/ferrets/:ferretId/pin',
        'POST /v1/ferrets/:ferretId/unpin',
        'POST /v1/ferrets/:ferretId/pin',
      ]);
      expect(await pin.verb('session pin <session>', [])).toBe(2);
      expect(await pin.verb('session unpin <session>', [])).toBe(2);

      const revoke = run({
        answers: { [FERRET_ROUTES.revoke]: { id: 'lead', revoked: true }, [FERRET_ROUTES.get]: lead },
      });
      expect(await revoke.verb('session revoke-credential <session>', ['wren'])).toBe(0);
      expect(revoke.calls.map(call => call.route)).toEqual([
        'POST /v1/ferrets/:ferretId/revoke-credential',
        'GET /v1/ferrets/:ferretId',
      ]);
      expect(await revoke.verb('session revoke-credential <session>', ['wren'], { json: true })).toBe(0);
      expect(JSON.parse(revoke.out.at(-1) ?? '')).toMatchObject({ revoked: true });
      expect(await revoke.verb('session revoke-credential <session>', [])).toBe(2);
    });
  });

  describe('stop', () => {
    const answers = { [FERRET_ROUTES.get]: lead, [FERRET_ROUTES.list]: [lead, helper] };
    const stops = (calls: readonly Call[]) => calls.filter(call => call.route === FERRET_ROUTES.stop);

    test('V-0447 fy stop with no mode prints the modes and is a usage error, touching nothing', async () => {
      const bare = run({ answers });
      expect(await bare.verb('stop')).toBe(2);
      expect(bare.out[0]).toContain('stop ferrets');
      for (const mode of ['orphan', 'cascade', 'children', 'label'])
        expect(bare.out.join('\n')).toContain(`fy stop ${mode}`);
      expect(bare.calls).toEqual([]);
    });

    test('V-0447 fy stop keeps the issuing ferret (FY_SESSION_ID) out of the plan unless --include-caller, and says so', async () => {
      const env = { FY_SESSION_ID: 'mid' };
      const without = run({ answers, env });
      expect(await without.verb('stop cascade <session>', ['wren'], { yes: true })).toBe(0);
      expect(stops(without.calls).map(call => (call.init as { params: { ferretId: string } }).params.ferretId)).toEqual(
        ['lead'],
      );
      expect(without.out.join('\n')).toContain('--include-caller');
      const within = run({ answers, env });
      expect(await within.verb('stop cascade <session>', ['wren'], { yes: true, 'include-caller': true })).toBe(0);
      expect(
        stops(within.calls)
          .map(call => (call.init as { params: { ferretId: string } }).params.ferretId)
          .sort(),
      ).toEqual(['lead', 'mid']);
      // Outside a ferret there is no caller to keep out: both spellings stop the same set.
      const owner = run({ answers });
      expect(await owner.verb('stop cascade <session>', ['wren'], { yes: true })).toBe(0);
      expect(stops(owner.calls)).toHaveLength(2);
    });

    test('V-0448 V-0449 V-0451 stop cascade/children/orphan plan from the list; --dry-run stops nothing, no --yes off a terminal refuses with exit 1, --yes stops, -r gives the reason', async () => {
      const modes = [
        ['V-0448', 'stop cascade <session>', ['lead', 'mid']],
        ['V-0449', 'stop children <session>', ['mid']],
        ['V-0451', 'stop orphan <session>', ['lead']],
      ] as [string, string, string[]][];
      for (const [, line, stopped] of modes) {
        const dry = run({ answers });
        expect(await dry.verb(line, ['wren'], { n: true })).toBe(0);
        expect(dry.out.join('\n')).toContain('Dry run');
        expect(stops(dry.calls)).toEqual([]);
        const longDry = run({ answers });
        expect(await longDry.verb(line, ['wren'], { 'dry-run': true })).toBe(0);
        expect(stops(longDry.calls)).toEqual([]);

        const unconfirmed = run({ answers });
        expect(await unconfirmed.verb(line, ['wren'])).toBe(1);
        expect(unconfirmed.err.join('\n')).toContain('--yes');
        expect(stops(unconfirmed.calls)).toEqual([]);

        for (const yes of [{ y: true }, { yes: true }] as Record<string, boolean>[]) {
          const confirmed = run({ answers });
          expect(await confirmed.verb(line, ['wren'], { ...yes, r: 'shift over', 'include-caller': true })).toBe(0);
          expect(
            stops(confirmed.calls).map(call => (call.init as { params: { ferretId: string } }).params.ferretId),
          ).toEqual(stopped);
          expect(stops(confirmed.calls).map(call => (call.init as { body: unknown }).body)).toEqual(
            stopped.map(() => ({ reason: 'shift over' })),
          );
        }
      }
      const reasoned = run({ answers });
      expect(await reasoned.verb('stop orphan <session>', ['wren'], { reason: 'because', yes: true })).toBe(0);
      expect(stops(reasoned.calls)[0]?.init).toMatchObject({ body: { reason: 'because' } });
      const unnamed = run({ answers });
      expect(await unnamed.verb('stop cascade <session>', [], { yes: true })).toBe(2);
      expect(stops(unnamed.calls)).toEqual([]);
    });

    test('V-0450 fy stop label <label> stops every ferret carrying exactly that label, independent of lineage', async () => {
      const labelled = [
        { ...sessionView({ id: 'p1' }), label: 'batch' },
        { ...sessionView({ id: 'p2', parent: 'p1' }), label: 'batch' },
        { ...sessionView({ id: 'other' }), label: 'batches' },
      ];
      const world = { answers: { [FERRET_ROUTES.list]: labelled } };
      const stop = run(world);
      expect(await stop.verb('stop label <label>', ['batch'], { yes: true, reason: 'sweep' })).toBe(0);
      expect(stops(stop.calls).map(call => (call.init as { params: { ferretId: string } }).params.ferretId)).toEqual([
        'p1',
        'p2',
      ]);
      const dry = run(world);
      expect(await dry.verb('stop label <label>', ['batch'], { 'dry-run': true })).toBe(0);
      expect(stops(dry.calls)).toEqual([]);
      const unconfirmed = run(world);
      expect(await unconfirmed.verb('stop label <label>', ['batch'])).toBe(1);
      expect(stops(unconfirmed.calls)).toEqual([]);
      const none = run(world);
      expect(await none.verb('stop label <label>', ['nobody'], { yes: true })).toBe(0);
      expect(none.out.join('\n')).toContain('Nothing eligible to stop');
      const blank = run(world);
      expect(await blank.verb('stop label <label>', [], { yes: true })).toBe(2);
    });
  });

  describe('worktrees', () => {
    test('V-0497 V-0502 fy worktree and fy worktree ls list GET /v1/worktrees, --json prints the answer', async () => {
      for (const line of ['worktree', 'worktree ls']) {
        const list = run({ answers: { [WORKTREE_ROUTES.list]: listResponse() } });
        expect(await list.verb(line)).toBe(0);
        expect(list.calls).toEqual([{ route: 'GET /v1/worktrees' }]);
        expect(list.out.join('\n')).toContain(WORKTREE_PATH);
        const json = run({ answers: { [WORKTREE_ROUTES.list]: listResponse() } });
        expect(await json.verb(line, [], { json: true })).toBe(0);
        expect(JSON.parse(json.out.join('\n'))).toMatchObject({ managedRoot: '/managed' });
      }
    });

    test('V-0499 fy worktree check <path> asks GET /v1/worktrees/removal with the path and the folder it stands in; --json prints the verdict', async () => {
      const blocked = decision({ removable: false, blockers: [blocker()] });
      const check = run({ answers: { [WORKTREE_ROUTES.check]: blocked } });
      expect(await check.verb('worktree check <path>', [WORKTREE_PATH])).toBe(0);
      expect(check.calls).toEqual([
        { route: 'GET /v1/worktrees/removal', init: { query: { path: WORKTREE_PATH, cwd: process.cwd() } } },
      ]);
      expect(check.out.join('\n')).toContain('the worktree has uncommitted edits');
      expect(check.out.join('\n')).toContain('--discard-changes');
      const json = run({ answers: { [WORKTREE_ROUTES.check]: blocked } });
      expect(await json.verb('worktree check <path>', [WORKTREE_PATH], { json: true })).toBe(0);
      expect(JSON.parse(json.out.join('\n'))).toMatchObject({ removable: false });
      expect(await json.verb('worktree check <path>', [])).toBe(2);
    });

    test('V-0504 fy worktree rm <path> checks first, refuses off a terminal without --yes, and each consent flag grants exactly its own loss', async () => {
      const unconfirmed = run({ answers: { [WORKTREE_ROUTES.check]: decision() } });
      expect(await unconfirmed.verb('worktree rm <path>', [WORKTREE_PATH])).toBe(1);
      expect(unconfirmed.calls.map(call => call.route)).toEqual(['GET /v1/worktrees/removal']);
      expect(unconfirmed.err.join('\n')).toContain('pass --yes');

      const plain = run({ answers: { [WORKTREE_ROUTES.check]: decision(), [WORKTREE_ROUTES.remove]: removed() } });
      expect(await plain.verb('worktree rm <path>', [WORKTREE_PATH], { y: true })).toBe(0);
      expect(plain.calls[1]).toEqual({
        route: 'POST /v1/worktrees/remove',
        init: {
          body: {
            path: WORKTREE_PATH,
            overrides: [],
            deleteBranch: false,
            confirmations: [],
            currentWorkingDirectory: process.cwd(),
          },
        },
      });

      const blockedDecision = decision({
        removable: false,
        blockers: [
          blocker(),
          blocker({
            code: 'unpushed_commits',
            message: 'commits exist nowhere else',
            override: 'accept_unpushed_commits',
          }),
        ],
      });
      const answers = { [WORKTREE_ROUTES.check]: blockedDecision, [WORKTREE_ROUTES.remove]: removed() };
      const refused = run({ answers });
      expect(await refused.verb('worktree rm <path>', [WORKTREE_PATH], { yes: true })).toBe(1);
      expect(refused.err.join('\n')).toContain('--discard-changes');
      expect(refused.err.join('\n')).toContain('--accept-unpushed');
      expect(refused.calls.map(call => call.route)).toEqual(['GET /v1/worktrees/removal']);

      const granted = run({ answers });
      expect(
        await granted.verb('worktree rm <path>', [WORKTREE_PATH], {
          yes: true,
          'discard-changes': true,
          'accept-unpushed': true,
          'delete-branch': true,
          'delete-unmerged': true,
          'delete-preexisting': true,
          json: true,
        }),
      ).toBe(0);
      expect(granted.calls[1]?.init).toMatchObject({
        body: {
          overrides: ['discard_worktree_changes', 'accept_unpushed_commits'],
          deleteBranch: true,
          confirmations: ['delete_preexisting_branch', 'delete_unpushed_branch', 'delete_unmerged_branch'],
        },
      });
      expect(JSON.parse(granted.out.join('\n'))).toMatchObject({
        path: WORKTREE_PATH,
      });
      expect(granted.err.join('\n')).toContain('"phase":"preflight"');
      const missing = run();
      expect(await missing.verb('worktree rm <path>', [], { yes: true })).toBe(2);
      expect(missing.calls).toEqual([]);
    });

    test('V-0500 fy worktree fork <branch> creates a checkout from --base, --from-default or --from-head (one only), --from, --session, --json', async () => {
      const answers = { [WORKTREE_ROUTES.create]: created() };
      const cases: readonly [Options, unknown][] = [
        [{}, { kind: 'auto' }],
        [{ base: 'origin/main' }, { kind: 'commit', reference: 'origin/main' }],
        [{ 'from-default': true }, { kind: 'default-branch' }],
        [{ 'from-head': true }, { kind: 'head' }],
      ];
      for (const [options, base] of cases) {
        const fork = run({ answers });
        expect(await fork.verb('worktree fork <branch>', ['feat/new'], options)).toBe(0);
        expect(fork.calls).toEqual([
          {
            route: 'POST /v1/worktrees',
            init: { body: { sourcePath: process.cwd(), branch: 'feat/new', base } },
          },
        ]);
        expect(fork.out.join('\n')).toContain('/managed/ferretry-new');
      }
      const owned = run({ answers });
      expect(
        await owned.verb('worktree fork <branch>', ['feat/new'], {
          from: '/repos/ferretry',
          session: 'lead',
          json: true,
        }),
      ).toBe(0);
      expect(owned.calls[0]?.init).toEqual({
        body: { sourcePath: '/repos/ferretry', branch: 'feat/new', base: { kind: 'auto' }, sessionId: 'lead' },
      });
      expect(JSON.parse(owned.out.join('\n'))).toMatchObject({ cwd: '/managed/ferretry-new/packages/cli' });
      const two = run({ answers });
      expect(await two.verb('worktree fork <branch>', ['feat/new'], { base: 'x', 'from-head': true })).toBe(1);
      expect(two.err.join('\n')).toContain('pass only one of --base, --from-head');
      expect(await two.verb('worktree fork <branch>', [])).toBe(2);
      expect(two.calls).toEqual([]);
    });
  });
});
