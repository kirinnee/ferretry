import { describe, expect, test } from 'bun:test';
import cli from '../../../cli/index.ts';
import type { PackHost } from '../../../cli/lib/host.ts';
import { packVerbs } from '../../../cli/lib/verbs.ts';
import manifest from '../../../manifest.ts';
import { INVENTORY, JOB, packView, recommendation, SUGGESTION } from '../cli/fixtures.ts';

type Init = { body?: unknown; params?: Record<string, string> };
type Answer = unknown | ((init?: Init) => unknown);
type Verb = (invocation: unknown) => Promise<number>;

/**
 * Builds the CLI half over a fake client that answers by route, and returns what it saw. With no `host` it is the half
 * exactly as `fy` builds it (`CliContext`: manifest, client, io); with one, the verbs are built over that host, the
 * parts the shell's context is to carry (lead decision 21).
 */
function harness(answers: Record<string, Answer>, host?: PackHost) {
  const calls: { route: string; init?: Init }[] = [];
  let out = '';
  let err = '';
  const client = {
    call: async <T>(route: string, init?: Init): Promise<T> => {
      calls.push({ route, ...(init === undefined ? {} : { init }) });
      const answer = answers[route];
      if (answer === undefined) throw new Error(`no answer faked for ${route}`);
      return (typeof answer === 'function' ? (answer as (i?: Init) => unknown)(init) : answer) as T;
    },
  };
  const io = {
    out: (text: string) => {
      out += text;
    },
    err: (text: string) => {
      err += text;
    },
    isTty: false,
  };
  const half: { verbs: Record<string, Verb> } =
    host === undefined
      ? (cli as unknown as { build: (context: unknown) => { verbs: Record<string, Verb> } }).build({
          manifest,
          client,
          io,
        })
      : { verbs: packVerbs({ client, io, host }) as unknown as Record<string, Verb> };
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

    expect(declared).toHaveLength(9);
    expect(declared).toEqual(
      [
        'guide',
        'guide accept <run>',
        'guide clean-up',
        'guide inventory',
        'guide show',
        'guide undo',
        'guide write',
        'pack [id]',
        'recommend [task...]',
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

  test('V-0274 through the context fy gives a plugin verb (no file read on this base) --prompt-file says so and asks nothing', async () => {
    const run = harness({});

    expect(await run.run('guide clean-up', [], { 'prompt-file': '/p.txt' })).toBe(2);
    expect(run.err()).toContain('this terminal cannot read files for a plugin verb yet; pass the text with --prompt');
    expect(run.calls).toEqual([]);
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
    expect(bare.err()).toContain('name the ferret whose pack to show');
  });

  test('V-0444 with no terminal clock the table is dated against when the daemon read it', async () => {
    const run = harness({
      'GET /v1/ferrets/:ferretId/pack': {
        ...TABLE,
        rows: [{ ...TABLE.rows[0], last: { at: '2026-11-03T11:57:00.000Z', source: 'note', text: 'halfway' } }],
      },
    });

    expect(await run.run('pack [id]', ['lead-1'])).toBe(0);
    expect(run.out()).toContain('[3m] halfway');
  });

  test('V-0334 V-0496 new and wait are not Packs’ verbs: fy new is Ferrets’, fy wait Conversation’s', () => {
    const verbs = Object.keys(harness({}).verbs);

    expect(verbs).not.toContain('new [words...]');
    expect(verbs).not.toContain('wait <id>');
    expect(manifest.actions?.routes?.map(route => route.key)).not.toContain('POST /v1/pack/new');
  });
});
