/**
 * The Lessons-owned V rows of docs/design/rebuild-parity.tsv, one test per row, each named by its id. Each verb runs
 * through the real CLI half (`cli/index.ts`) over a scripted plugin client, and the test checks the route it reached
 * and what it printed. `fy learning …` is `fy lesson …` (design §1.4).
 */
import { describe, expect, test } from 'bun:test';
import cli from '../../../cli/index.ts';
import manifest from '../../../manifest.ts';
import { must } from '../../support/app/dom.ts';
import {
  applyPreview,
  learningConfig,
  learningStatus,
  patchResponse,
  proposal,
  runManifest,
  scanEstimate,
  scanProgress,
} from '../cli/fixtures.ts';

const ANSWERS: Readonly<Record<string, unknown>> = {
  'GET /v1/lessons/proposals': [proposal('p1')],
  'POST /v1/lessons/proposals/:id': proposal('p1', { state: 'accepted' }),
  'GET /v1/lessons/proposals/:id/apply-preview': applyPreview(),
  'POST /v1/lessons/proposals/:id/apply': proposal('p1', { state: 'applied' }),
  'GET /v1/lessons/proposals/:id/patch': patchResponse(),
  'GET /v1/lessons/config': learningConfig(),
  'GET /v1/lessons/status': learningStatus(),
  'POST /v1/lessons/run': runManifest(),
  'POST /v1/lessons/scan/estimate': scanEstimate(),
  'POST /v1/lessons/scan': scanProgress(),
  'POST /v1/lessons/suggest': { summary: 'Filed a new Global lesson for the owner to review.', outcome: 'filed' },
};

async function run(verb: string, args: string[] = [], options: Record<string, string | boolean> = {}) {
  const calls: { route: string; init: { params?: Record<string, string>; body?: unknown; query?: unknown } }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const half = must(
    cli.build,
    'the CLI half builder',
  )({
    manifest,
    client: {
      call: async (route: string, init = {}) => {
        calls.push({ route, init: init as never });
        if (!(route in ANSWERS)) throw new Error(`unscripted ${route}`);
        return ANSWERS[route];
      },
    } as never,
    io: { out: text => out.push(text), err: text => err.push(text), isTty: false },
  });
  const handler = (half.verbs as Record<string, (invocation: unknown) => Promise<number>>)[verb];
  if (handler === undefined) throw new Error(`no verb ${verb}`);
  const code = await handler({ args, options });
  return { code, calls, out: out.join(''), err: err.join('') };
}

const declared = new Set<string>(manifest.actions.cli.map(entry => entry.verb));

describe('fy lesson', () => {
  test('V-0292 V-0307 bare fy lesson (today fy learning) lists the pending lessons', async () => {
    expect(declared.has('lesson')).toBe(true);
    const result = await run('lesson');
    expect(result.code).toBe(0);
    expect(result.calls[0]).toMatchObject({
      route: 'GET /v1/lessons/proposals',
      init: { query: { state: 'pending' } },
    });
  });

  test('V-0299 fy lesson ls is the same listing (today’s default verb)', async () => {
    expect(declared.has('lesson ls')).toBe(true);
    const bare = await run('lesson', [], { all: true });
    const ls = await run('lesson ls', [], { all: true });
    expect(ls.code).toBe(0);
    expect(ls.calls).toEqual(bare.calls);
    expect(ls.out).toBe(bare.out);
  });

  test('V-0298 fy learning list is removed by design (§1.4: no aliases); only ls and bare lesson list', () => {
    expect(declared.has('lesson list')).toBe(false);
  });

  test('V-0305 fy lesson show <id> prints one lesson with its quotes', async () => {
    const result = await run('lesson show', ['p1']);
    expect(result.code).toBe(0);
    expect(result.calls[0]?.route).toBe('GET /v1/lessons/proposals');
  });

  for (const [id, verb, args, body] of [
    ['V-0293', 'lesson accept', ['p1'], { action: 'accept' }],
    ['V-0301', 'lesson reject', ['p1'], { action: 'reject' }],
    ['V-0297', 'lesson edit', ['p1', 'Use', 'bun.'], { action: 'edit', ruleText: 'Use bun.' }],
    ['V-0295', 'lesson categorize', ['p1', 'repo'], { action: 'categorize', category: 'repo' }],
    ['V-0302', 'lesson reopen', ['p1'], { action: 'reopen' }],
  ] as const)
    test(`${id} fy ${verb} posts the verdict to /v1/lessons/proposals/:id`, async () => {
      const result = await run(verb, [...args]);
      expect(result.code).toBe(0);
      expect(result.calls[0]).toMatchObject({
        route: 'POST /v1/lessons/proposals/:id',
        init: { params: { id: 'p1' }, body },
      });
    });

  test('V-0294 fy lesson apply <id> shows the diff; --yes writes it with the preview’s etag', async () => {
    const shown = await run('lesson apply', ['p1']);
    expect(shown.calls.map(call => call.route)).toEqual(['GET /v1/lessons/proposals/:id/apply-preview']);
    const written = await run('lesson apply', ['p1'], { yes: true });
    expect(written.calls.map(call => call.route)).toEqual([
      'GET /v1/lessons/proposals/:id/apply-preview',
      'POST /v1/lessons/proposals/:id/apply',
    ]);
    expect(written.calls[1]?.init.body).toEqual({ etag: applyPreview().etag });
  });

  test('V-0300 fy lesson patch <id> prints the file the lesson edits', async () => {
    const result = await run('lesson patch', ['p1']);
    expect(result.calls[0]?.route).toBe('GET /v1/lessons/proposals/:id/patch');
    expect(result.out).toContain(patchResponse().contents.trim().split('\n')[0] ?? '');
  });

  test('V-0296 fy lesson config prints the schedule and the agent', async () => {
    const result = await run('lesson config');
    expect(result.calls[0]?.route).toBe('GET /v1/lessons/config');
    expect(result.out).toContain('miner:');
  });

  test('V-0306 fy lesson status prints whether mining is on and what is pending', async () => {
    const result = await run('lesson status');
    expect(result.code).toBe(0);
    expect(result.calls[0]?.route).toBe('GET /v1/lessons/status');
  });

  test('V-0303 fy lesson run asks for a run; --spawn asks for miners', async () => {
    expect((await run('lesson run')).calls[0]).toMatchObject({
      route: 'POST /v1/lessons/run',
      init: { body: { spawn: false } },
    });
    expect((await run('lesson run', [], { spawn: true })).calls[0]?.init.body).toEqual({ spawn: true });
  });

  test('V-0304 fy lesson scan estimates; it starts only with --start', async () => {
    const estimated = await run('lesson scan', [], { estimate: true });
    expect(estimated.calls.map(call => call.route)).toEqual(['POST /v1/lessons/scan/estimate']);
    const started = await run('lesson scan', [], { start: true, model: 'claude-haiku-5-5' });
    expect(started.calls.map(call => call.route)).toContain('POST /v1/lessons/scan');
    expect(started.calls.find(call => call.route === 'POST /v1/lessons/scan')?.init.body).toMatchObject({
      model: 'claude-haiku-5-5',
    });
  });

  test('V-0308 fy lesson suggest <rule> files one lesson as the calling ferret', async () => {
    const result = await run('lesson suggest', ['Use bun, not Python.'], { scope: 'global' });
    expect(result.code).toBe(0);
    expect(result.calls[0]).toMatchObject({
      route: 'POST /v1/lessons/suggest',
      init: { body: { rule: 'Use bun, not Python.', scope: 'global' } },
    });
  });
});
