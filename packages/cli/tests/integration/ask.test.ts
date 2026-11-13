import { describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { definePlugin, route } from '@ferretry/kernel/manifest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { createWorld } from '../../src/adapters/world.ts';
import { ASK_ROUTES } from '../../src/lib/commands/ask.ts';
import { runFy } from '../../src/lib/run.ts';
import { capturedIo, inventoryOf, registryOf, skeletonEntry } from '../unit/fakes.ts';
import { HEALTH, standInDaemon } from './support/stand-in-daemon.ts';

/** No test may start a real daemon. */
const NO_PROCESS = {
  exists: () => false,
  which: () => null,
  spawnDetached: () => {
    throw new Error('a test must not start a real process');
  },
};

const open = { minimum: 'operator', caller: 'any', audit: { skip: 'test' }, guard: { none: 'ids' } } as const;
const declare = (id: string, title: string, ...keys: string[]) =>
  definePlugin({
    id,
    title,
    version: '5.0.0',
    api: 5,
    core: true,
    kinds: [],
    actions: { routes: keys.map(key => route(key, open)) },
  });

const PLUGINS = inventoryOf();

const board = (...items: unknown[]) => ({ v: 1, items, resolved: [], count: items.length });

/** A temp FY_HOME and a stand-in daemon holding two boards; the world is the real one, over real HTTP. */
async function withDaemon<T>(
  use: (
    run: (words: string[]) => Promise<{ code: number; out: string; err: string }>,
    seen: readonly { method: string; path: string; body: string }[],
  ) => Promise<T>,
  ferrets: unknown = [
    { id: 'f1', name: 'alpha' },
    { id: 'f2', name: 'beta' },
  ],
): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'fy-ask-'));
  try {
    const { url, seen } = standInDaemon((request, path) => {
      if (path === '/v1/health') return Response.json(HEALTH);
      if (path === '/v1/plugins') return Response.json(PLUGINS);
      if (path === '/v1/ferrets') return Response.json(ferrets);
      if (path === '/v1/ferrets/f1/agenda' && request.method === 'GET')
        return Response.json(
          board({ id: 'A3', title: 'Move c1?', subject: 's', kind: 'yesno', waitingSince: '2026-11-12T00:00:00.000Z' }),
        );
      if (path === '/v1/ferrets/f2/agenda' && request.method === 'GET') return Response.json(board());
      if (path === '/v1/ferrets/f1/agenda/A3') return Response.json({ id: 'A3', subject: 's' });
      if (path === '/v1/ferrets/f1/agenda' && request.method === 'POST') return Response.json(board());
      return Response.json({ error: 'no' }, { status: 404 });
    });
    const run = async (words: string[]) => {
      const io = capturedIo();
      const world = createWorld({
        io,
        environment: { FY_URL: url, FY_TOKEN: 'owner-token' },
        userHome: home,
        identity: { binary: 'fy', version: '5.0.0' },
        product: 'ferretry',
        registry: registryOf(
          skeletonEntry(declare('asks', 'Asks', ASK_ROUTES.board, ASK_ROUTES.item, ASK_ROUTES.answer), 'h-asks'),
          skeletonEntry(declare('ferrets', 'Ferrets', ASK_ROUTES.ferrets), 'h-ferrets'),
        ),
        selfPath: join(home, 'bin', 'fy'),
        process: NO_PROCESS,
      });
      return { code: await runFy(words, world), out: io.stdout(), err: io.stderr() };
    };
    return await use(run, seen);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe('fy ask over the wire', () => {
  it('lists the waiting asks across ferrets and says what is on none', async () => {
    await withDaemon(async (run, seen) => {
      const listed = await run(['ask']);
      should(listed.code).equal(0);
      should(listed.out).match(/f1\/A3\s+alpha\s+yesno\s+Move c1\?/u);
      should(seen.filter(request => request.path.endsWith('/agenda')).map(request => request.path)).containEql(
        '/v1/ferrets/f2/agenda',
      );
    });
    await withDaemon(async run => {
      const empty = await run(['ask', 'list']);
      should(empty.code).equal(0);
      should(empty.out).equal('no asks are waiting\n');
    }, []);
  });

  it('shows one ask', async () => {
    await withDaemon(async run => {
      const shown = await run(['ask', 'show', 'f1/A3']);
      should(shown.code).equal(0);
      should(JSON.parse(shown.out)).deepEqual({ id: 'A3', subject: 's' });
    });
  });

  it('answers an ask on its own ferret, sending the resolve the board route takes', async () => {
    await withDaemon(async (run, seen) => {
      const answered = await run(['ask', 'answer', 'f1/A3', '--yes']);
      should(answered.code).equal(0);
      should(answered.out).equal('answered f1/A3\n');
      const posted = seen.find(request => request.method === 'POST');
      should(posted?.path).equal('/v1/ferrets/f1/agenda');
      should(JSON.parse(posted?.body ?? '{}')).deepEqual({
        action: 'resolve',
        id: 'A3',
        response: { kind: 'multiple-choice', choice: 'Yes' },
      });
    });
  });
});
