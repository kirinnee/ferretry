import { describe, expect, test } from 'bun:test';
import cli from '../../cli/index.ts';
import type { PackHost } from '../../cli/lib/host.ts';
import manifest from '../../manifest.ts';
import { INVENTORY, JOB, packView, recommendation, SUGGESTION, started } from '../unit/cli/fixtures.ts';

type Init = { body?: unknown; params?: Record<string, string> };
type Answer = unknown | ((init?: Init) => unknown);
type Verb = (invocation: unknown) => Promise<number>;

/** Builds the CLI half over a fake client that answers by route, and returns what it saw. */
function harness(answers: Record<string, Answer>, host: PackHost = {}) {
  const calls: { route: string; init?: Init }[] = [];
  let out = '';
  let err = '';
  const half = (cli as unknown as { build: (context: unknown) => { verbs: Record<string, Verb> } }).build({
    manifest,
    client: {
      call: async (route: string, init?: Init) => {
        calls.push({ route, ...(init === undefined ? {} : { init }) });
        const answer = answers[route];
        if (answer === undefined) throw new Error(`no answer faked for ${route}`);
        return typeof answer === 'function' ? (answer as (i?: Init) => unknown)(init) : answer;
      },
    },
    io: { out: (text: string) => void (out += text), err: (text: string) => void (err += text), isTty: false },
    ...host,
  });
  return {
    calls,
    verbs: half.verbs,
    out: () => out,
    err: () => err,
    run: async (verb: string, args: string[] = [], options: Record<string, string | boolean | string[]> = {}) => {
      const handler = half.verbs[verb];
      if (handler === undefined) throw new Error(`no verb ${verb}`);
      return await handler({ args, options });
    },
  };
}

const TABLE = {
  root: { id: 'lead-1', name: 'rhett' },
  at: '2026-11-03T12:00:00.000Z',
  endedWindowMs: 7_200_000,
  rows: [{ id: 'c1', name: 'ada', depth: 1, model: 'sonnet', state: 'running', ferretState: 'working' }],
};

const ACCEPT = { outcome: 'applied', message: 'Accepted.' };

describe('command parity', () => {
  test('every verb the manifest declares has a handler in the half', () => {
    const declared = Object.keys(harness({}).verbs).toSorted();

    expect(declared).toHaveLength(11);
    expect(declared).toEqual(
      [
        'guide',
        'guide accept <run>',
        'guide clean-up',
        'guide inventory',
        'guide show',
        'guide undo',
        'guide write',
        'new [words...]',
        'pack [id]',
        'recommend [task...]',
        'wait <id>',
      ].toSorted(),
    );
  });

  test('V-0272 guide names its subcommands on stderr and exits 1, like a command group with no subcommand', async () => {
    const run = harness({});

    expect(await run.run('guide')).toBe(1);
    expect(run.err()).toContain('show');
    expect(run.err()).toContain('clean-up');
    expect(run.calls).toEqual([]);
  });

  test('V-0273 guide accept <run> reads the run and writes its checked rewrite as the routing prompt', async () => {
    const run = harness({
      'GET /v1/pack/routing/jobs/:jobId': { job: { ...JOB, status: 'suggested' }, suggestion: SUGGESTION },
      'POST /v1/pack/routing/accept': ACCEPT,
    });

    expect(await run.run('guide accept <run>', ['run-1'])).toBe(0);
    expect(run.calls.map(call => call.route)).toEqual([
      'GET /v1/pack/routing/jobs/:jobId',
      'POST /v1/pack/routing/accept',
    ]);
    expect(run.calls[0]?.init?.params).toEqual({ jobId: 'run-1' });
  });

  test('V-0273 guide accept without a run is a usage error before anything is asked', async () => {
    const run = harness({});

    expect(await run.run('guide accept <run>')).toBe(2);
    expect(run.calls).toEqual([]);
  });

  test('V-0274 guide clean-up takes --prompt, --runtime, --model and --apply and posts them to the clean-up route', async () => {
    const run = harness({
      'POST /v1/pack/routing/clean-up': { outcome: 'started', job: JOB },
      'GET /v1/pack/routing/jobs/:jobId': { job: { ...JOB, status: 'suggested' }, suggestion: SUGGESTION },
      'POST /v1/pack/routing/accept': ACCEPT,
    });

    const code = await run.run('guide clean-up', [], {
      prompt: ' rough words ',
      runtime: 'claude-work',
      model: 'opus',
      apply: true,
    });

    expect(code).toBe(0);
    expect(run.calls[0]).toEqual({
      route: 'POST /v1/pack/routing/clean-up',
      init: { body: { prompt: 'rough words', runtime: 'claude-work', model: 'opus' } },
    });
    expect(run.calls.at(-1)?.route).toBe('POST /v1/pack/routing/accept');
  });

  test('V-0274 -y is --apply', async () => {
    const run = harness({
      'POST /v1/pack/routing/clean-up': { outcome: 'started', job: JOB },
      'GET /v1/pack/routing/jobs/:jobId': { job: { ...JOB, status: 'suggested' }, suggestion: SUGGESTION },
      'POST /v1/pack/routing/accept': ACCEPT,
    });

    await run.run('guide clean-up', [], { y: true });

    expect(run.calls.at(-1)?.route).toBe('POST /v1/pack/routing/accept');
  });

  test('V-0274 guide clean-up reads --prompt-file through the terminal', async () => {
    const run = harness(
      { 'POST /v1/pack/routing/clean-up': { outcome: 'refused', message: 'no runtime is ready' } },
      { readFile: async path => (path === '/p.txt' ? 'from a file' : '') },
    );

    await run.run('guide clean-up', [], { 'prompt-file': '/p.txt' });

    expect(run.calls[0]?.init?.body).toEqual({ prompt: 'from a file' });
  });

  test('V-0275 guide inventory reads the inventory; --json prints the payload', async () => {
    const plain = harness({ 'GET /v1/pack/inventory': INVENTORY });
    const json = harness({ 'GET /v1/pack/inventory': INVENTORY });

    expect(await plain.run('guide inventory')).toBe(0);
    expect(plain.out()).toContain('Runtimes (2):');
    await json.run('guide inventory', [], { json: true });
    expect(JSON.parse(json.out()).runtimes).toHaveLength(2);
    expect(plain.calls.map(call => call.route)).toEqual(['GET /v1/pack/inventory']);
  });

  test('V-0276 guide show prints the routing prompt in effect; --json prints it with its undo', async () => {
    const plain = harness({ 'GET /v1/pack': packView() });
    const json = harness({ 'GET /v1/pack': packView() });

    expect(await plain.run('guide show')).toBe(0);
    expect(plain.out()).toContain('Routing prompt');
    await json.run('guide show', [], { json: true });
    expect(Object.keys(JSON.parse(json.out()))).toContain('routing');
  });

  test('V-0277 guide undo posts to the undo route', async () => {
    const run = harness({ 'POST /v1/pack/routing/undo': { outcome: 'applied', message: 'Undone.' } });

    expect(await run.run('guide undo')).toBe(0);
    expect(run.calls).toEqual([{ route: 'POST /v1/pack/routing/undo', init: { body: {} } }]);
  });

  test('V-0278 guide write starts the builder in generate mode with the idea trimmed', async () => {
    const run = harness({
      'POST /v1/pack/routing/clean-up': { outcome: 'refused', message: 'no runtime is ready' },
    });

    await run.run('guide write', [], { idea: '  cheap chores  ', runtime: 'claude-work', model: 'opus' });

    expect(run.calls[0]?.init?.body).toEqual({
      mode: 'generate',
      idea: 'cheap chores',
      runtime: 'claude-work',
      model: 'opus',
    });
  });

  test('V-0370 recommend joins the task words and posts them; --json prints the payload', async () => {
    const plain = harness({ 'POST /v1/pack/recommend': recommendation() });
    const json = harness({ 'POST /v1/pack/recommend': recommendation() });

    expect(await plain.run('recommend [task...]', ['rename', ' a\n', 'helper'])).toBe(0);
    expect(plain.calls).toEqual([{ route: 'POST /v1/pack/recommend', init: { body: { task: 'rename a helper' } } }]);
    await json.run('recommend [task...]', [], { json: true });
    expect(json.calls[0]?.init?.body).toEqual({});
    expect(JSON.parse(json.out()).available).toBeDefined();
  });

  test('V-0444 pack [id] shows the table of the named ferret, defaulting to the calling one; --json prints it', async () => {
    const named = harness({ 'GET /v1/ferrets/:ferretId/pack': TABLE });
    const ambient = harness({ 'GET /v1/ferrets/:ferretId/pack': TABLE }, { env: { FY_SESSION_ID: 'lead-1' } });
    const bare = harness({});

    expect(await named.run('pack [id]', ['lead-1'])).toBe(0);
    expect(named.out()).toContain('rhett (lead-1): 1 helper');
    expect(named.calls[0]?.init?.params).toEqual({ ferretId: 'lead-1' });
    await ambient.run('pack [id]', [], { json: true });
    expect(ambient.calls[0]?.init?.params).toEqual({ ferretId: 'lead-1' });
    expect(JSON.parse(ambient.out()).rows).toHaveLength(1);
    expect(await bare.run('pack [id]')).toBe(2);
  });

  test('V-0334 new starts a helper: the brief is the words, the lead is the calling ferret, and the flags travel in the request', async () => {
    const run = harness({ 'POST /v1/pack/new': started() }, { env: { FY_SESSION_ID: 'lead-1' }, cwd: '/here' });

    const code = await run.run('new [words...]', ['do', 'the', 'thing'], {
      runtime: 'claude-work',
      model: 'claude-haiku-5-5',
      effort: 'low',
      name: 'Do Thing',
      'allow-scratch': true,
    });

    expect(code).toBe(0);
    const body = run.calls[0]?.init?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      task: 'do the thing',
      parent: 'lead-1',
      runtime: 'claude-work',
      model: 'claude-haiku-5-5',
      effort: 'low',
      allowScratch: true,
      name: 'Do Thing',
    });
    expect(run.out()).toContain('Started child-1 on claude-work');
    expect(run.out()).toContain('fy wait child-1');
  });

  test('V-0334 new from a person’s shell runs in the folder fy was run in, and --auto sends no runtime', async () => {
    const run = harness({ 'POST /v1/pack/new': started() }, { cwd: '/here' });

    await run.run('new [words...]', ['x'], { auto: true });

    expect(run.calls[0]?.init?.body).toMatchObject({ task: 'x', auto: true, cwd: '/here' });
    expect(run.calls[0]?.init?.body).not.toHaveProperty('runtime');
  });

  test('V-0334 --continue is not Packs’ to do', async () => {
    const run = harness({});

    expect(await run.run('new [words...]', ['x'], { continue: true })).toBe(2);
    expect(run.err()).toContain('fy link');
    expect(run.calls).toEqual([]);
  });

  test('V-0496 wait <id> polls the ferret’s result, prints it, and exits 0 for a ferret that reported', async () => {
    let asked = 0;
    const run = harness(
      {
        'GET /v1/ferrets/:ferretId/result': () =>
          ++asked < 2
            ? { id: 'c1', state: 'working', finished: false }
            : { id: 'c1', state: 'stopped', finished: true, summary: 'the answer' },
      },
      { sleep: async () => undefined, nowMs: () => 0 },
    );

    const code = await run.run('wait <id>', ['c1'], { timeout: '60', interval: '1' });

    expect(code).toBe(0);
    expect(run.calls.every(call => call.route === 'GET /v1/ferrets/:ferretId/result')).toBe(true);
    expect(run.out()).toBe('c1 is stopped\n\nthe answer\n');
  });

  test('V-0496 wait exits 1 for a ferret that ended without reporting, 124 on timeout, and refuses a bad --timeout', async () => {
    const ended = harness({ 'GET /v1/ferrets/:ferretId/result': { id: 'c1', state: 'stopped', finished: true } });
    let now = 0;
    const slow = harness(
      { 'GET /v1/ferrets/:ferretId/result': { id: 'c1', state: 'working', finished: false } },
      { sleep: async ms => void (now += ms), nowMs: () => now },
    );
    const bad = harness({});

    expect(await ended.run('wait <id>', ['c1'])).toBe(1);
    expect(await slow.run('wait <id>', ['c1'], { timeout: '3' })).toBe(124);
    expect(await bad.run('wait <id>', ['c1'], { timeout: 'soon' })).toBe(2);
    expect(bad.err()).toBe('--timeout must be a positive integer\n');
  });

  test('V-0496 wait --until-marker needs a terminal that can look for files', async () => {
    const run = harness({});

    expect(await run.run('wait <id>', ['c1'], { 'until-marker': 'done.md' })).toBe(2);
    expect(run.err()).toContain('--until-marker needs a terminal');
  });
});
