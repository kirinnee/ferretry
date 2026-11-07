/**
 * THE TWO-RELEASE FIXTURE, fy's leg (redesign §10.5, §9.6).
 *
 * `fy` of THIS commit (release A) is run for real — `runFy` over `createWorld`, the same path `bin/fy.ts` takes — against
 * a real daemon of release A or of a release BUILT WITH A CHANGE: the real generator produced both registries from a
 * fixture workspace, and the real kernel host booted the daemon over its own. Everything goes over loopback HTTP
 * through a recording proxy, so "nothing was attempted" is read three ways: the proxy saw only the inventory, the
 * daemon's own hit counters stayed at zero, and the agent-tool client refused before it sent a byte.
 *
 * The app's leg is `packages/app/tests/integration/two-release/`. The rig is `scripts/test/two-release/`.
 *
 * An assertion that is RED because a piece of 5.0 is not built yet carries the gap's id in its title and in its failure
 * message (G1 Gate's inventory sees no surfaces, G2 no event stream route, G3 no HTTP tool route, G4 Catalogs' member
 * table). They are not skipped: they turn green when the gap lands.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ApiRequest, type EventDef, headersFrom, queryFrom } from '@ferretry/kernel/contract';
import { buildModelOnly, buildRelease, type Release } from '../../../../../scripts/test/two-release/releases.ts';
import { type StartedDaemon, startDaemon } from '../../../../../scripts/test/two-release/daemon.ts';
import { hits, hitTotal, resetCounters } from '../../../../../scripts/test/two-release/hits.ts';
import { type RecordingProxy, recordingProxy } from '../../../../../scripts/test/two-release/proxy.ts';
import { createWorld } from '../../../src/adapters/world.ts';
import { type ClientDeps, ensureAllowed, surfacesOf } from '../../../src/lib/client.ts';
import { PluginPausedError } from '../../../src/lib/guard.ts';
import { runFy } from '../../../src/lib/run.ts';
import { ToolClient } from '../../../src/lib/tool-client.ts';
import { capturedIo } from '../../unit/fakes.ts';
import { waitFor } from '../support/wait-for.ts';

const CORE_IDS = ['kernel', 'gate', 'asks', 'vault', 'ferrets', 'access'] as const;
const EXIT_UNAVAILABLE = 69;
const UPDATE = 'restart the daemon with `fy daemon restart`';

/** No test may start a real daemon: the launcher finds nothing and spawns nothing. */
const NO_PROCESS = {
  exists: () => false,
  which: () => null,
  spawnDetached: () => {
    throw new Error('a test must not start a real process');
  },
};

let A: Release;
let Bb: Release;
let Bc: Release;
let Bd: Release;
let userHome: string;

beforeAll(async () => {
  userHome = await mkdtemp(join(tmpdir(), 'fy-tworel-user-'));
  await mkdir(join(userHome, 'bin'), { recursive: true });
  [A, Bb, Bc, Bd] = await Promise.all([
    buildRelease('A'),
    buildRelease('B_b'),
    buildRelease('B_c'),
    buildRelease('B_d'),
  ]);
});

afterAll(async () => {
  for (const release of [A, Bb, Bc, Bd]) release?.dispose();
  await rm(userHome, { recursive: true, force: true });
});

/** A gap in 5.0 that makes an assertion red, said in the failure. */
function gap(id: 'G1' | 'G2' | 'G3', what: string, detail: string): Error {
  return new Error(`${id} (${what}): ${detail}`);
}

interface Session {
  readonly daemon: StartedDaemon;
  readonly proxy: RecordingProxy;
  /** Runs one `fy` invocation of release A against this daemon. */
  fy(argv: readonly string[]): Promise<{ readonly code: number; readonly out: string; readonly err: string }>;
  /** The guarded client deps a verb or a ferret's tool call stands on. */
  deps(): Promise<ClientDeps>;
  stop(): Promise<void>;
}

/** A daemon of `daemonRelease`, a recording proxy in front of it, and an `fy` of release A aimed at the proxy. */
async function open(daemonRelease: Release, version = A.appVersion): Promise<Session> {
  const daemon = await startDaemon(daemonRelease, { version });
  const proxy = recordingProxy(daemon.url);
  const token = await daemon.adminToken();
  const worldFor = (io = capturedIo()) =>
    createWorld({
      io,
      environment: { HOME: userHome, FY_HOME: daemon.home, FY_URL: proxy.url, FY_TOKEN: token, NO_COLOR: '1' },
      userHome,
      identity: { binary: 'fy', version: '5.0.0' },
      product: 'ferretry',
      registry: A.commands,
      selfPath: join(userHome, 'bin', 'fy'),
      process: NO_PROCESS,
    });
  return {
    daemon,
    proxy,
    fy: async argv => {
      const io = capturedIo();
      const code = await runFy(argv, worldFor(io));
      return { code, out: io.stdout(), err: io.stderr() };
    },
    deps: async () => {
      const connection = await worldFor().connect({ asOwner: false });
      return {
        transport: connection.transport,
        inventory: connection.inventory,
        surfaces: surfacesOf(A.commands),
        inPane: false,
        binary: 'fy',
      };
    },
    stop: async () => {
      await proxy.stop();
      await daemon.stop();
    },
  };
}

const INVENTORY_READ = 'GET /v1/plugins';

/** Nothing but inventory reads reached the daemon, and nothing tried to open a stream. */
function expectOnlyInventoryReads(session: Session, reads?: number): void {
  const paths = session.proxy.paths();
  expect(paths.filter(path => path !== INVENTORY_READ)).toEqual([]);
  if (reads !== undefined) expect(paths).toHaveLength(reads);
  expect(session.proxy.upgrades()).toEqual([]);
}

/** Zero daemon-side work for each named fixture plugin: the second witness. */
function expectNoDaemonWork(...ids: ('alpha' | 'beta' | 'gamma' | 'delta')[]): void {
  for (const id of ids) expect(hitTotal(id)).toBe(0);
}

async function pausedWith(promise: Promise<unknown>): Promise<PluginPausedError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PluginPausedError) return error;
    throw error;
  }
  throw new Error('the call was sent; it should have been refused without being sent');
}

// ─── the generator table: B_b is a real build, not a hand-picked hash ──────────────────────────────────────────────────

describe('(b) the generator table: each of the four changes alone moves the provider and its consumers, and only them', () => {
  for (const alone of ['B_1', 'B_2', 'B_3', 'B_4'] as const) {
    test(`${alone}: alpha's canonical hash moves; beta and gamma move through it; delta and every core piece do not`, async () => {
      const built = await buildModelOnly(alone);
      try {
        expect(built.model.failures).toEqual([]);
        const before = A.hashes;
        const after = built.model.hashes;
        expect(after.get('alpha')?.canonical).not.toBe(before.get('alpha')?.canonical);
        expect(after.get('beta')?.effective).not.toBe(before.get('beta')?.effective);
        expect(after.get('gamma')?.effective).not.toBe(before.get('gamma')?.effective);
        expect(after.get('delta')?.effective).toBe(before.get('delta')?.effective);
        for (const core of CORE_IDS) expect(after.get(core)?.effective).toBe(before.get(core)?.effective);
      } finally {
        built.dispose();
      }
    });
  }

  test('B_c moves only alpha; gamma is consumed through its RENDERER alone (its own canonical hash is unchanged)', () => {
    expect(Bc.hashes.get('alpha')?.canonical).not.toBe(A.hashes.get('alpha')?.canonical);
    expect(Bc.hashes.get('gamma')?.canonical).toBe(A.hashes.get('gamma')?.canonical);
    expect(Bc.hashes.get('gamma')?.effective).not.toBe(A.hashes.get('gamma')?.effective);
    expect(Bc.hashes.get('beta')?.effective).not.toBe(A.hashes.get('beta')?.effective);
    expect(Bc.hashes.get('delta')?.effective).toBe(A.hashes.get('delta')?.effective);
    for (const core of CORE_IDS) expect(Bc.hashes.get(core)?.effective).toBe(A.hashes.get(core)?.effective);
  });

  test('B_d moves Asks, a core piece; Gate, the Kernel and the unchanged fixture plugin do not', () => {
    expect(Bd.hashes.get('asks')?.canonical).not.toBe(A.hashes.get('asks')?.canonical);
    expect(Bd.hashes.get('gate')?.effective).toBe(A.hashes.get('gate')?.effective);
    expect(Bd.hashes.get('kernel')?.effective).toBe(A.hashes.get('kernel')?.effective);
    expect(Bd.hashes.get('delta')?.effective).toBe(A.hashes.get('delta')?.effective);
  });
});

// ─── (a) nothing changed ───────────────────────────────────────────────────────────────────────────────────────────────

describe('(a) nothing changed: fy of this commit against a daemon of this commit', () => {
  let session: Session;
  beforeAll(async () => {
    session = await open(A);
  });
  afterAll(async () => {
    await session.stop();
  });

  test('`fy delta show` and `fy alpha show` exit 0 with the plugin’s own answer, after one inventory read', async () => {
    resetCounters();
    session.proxy.reset();
    const delta = await session.fy(['delta', 'show']);
    expect(delta.code).toBe(0);
    expect(JSON.parse(delta.out)).toEqual({ plugin: 'delta', item: 'one' });
    expect(session.proxy.paths()).toEqual([INVENTORY_READ, 'GET /v1/delta']);
    expect(hits.delta.route).toBe(1);
    const alpha = await session.fy(['alpha', 'show']);
    expect(alpha.code).toBe(0);
    expect(JSON.parse(alpha.out)).toEqual({ plugin: 'alpha', item: 'one' });
    expect(hits.alpha.route).toBe(1);
  });

  test('G2 an unchanged event reaches `fy delta watch` (the kernel has no event stream route)', async () => {
    const { DeltaChangedEvent } = await A.load('packages/plugins/delta/contract/index.ts');
    let finished: { code: number; err: string } | undefined;
    void session.fy(['delta', 'watch']).then(result => {
      finished = result;
    });
    try {
      await waitFor(
        () => {
          // Published until fy has subscribed and heard one (a feed opened late would miss a single publish).
          session.daemon.host.events.publish(DeltaChangedEvent as EventDef, { item: 'one' });
          return finished;
        },
        '`fy delta watch` to end',
        { within: 20_000, pollMs: 100 },
      );
    } catch (error) {
      throw gap('G2', 'no event stream route on the kernel', error instanceof Error ? error.message : String(error));
    }
    if (finished?.code !== 0)
      throw gap(
        'G2',
        'no event stream route on the kernel',
        `fy delta watch ended ${finished?.code}: ${finished?.err}`,
      );
  });

  test('G3 an unchanged tool works over loopback (the kernel mounts no HTTP tool route)', async () => {
    resetCounters();
    const tools = new ToolClient(await session.deps());
    try {
      await tools.call('delta', 'delta_get', {});
    } catch (error) {
      throw gap('G3', 'no HTTP tool route', error instanceof Error ? error.message : String(error));
    }
    expect(hits.delta.tool).toBe(1);
  });
});

// ─── (b) one provider's route, tool, event and socket schema changed ──────────────────────────────────────────────────

describe('(b) a provider’s route, tool, event and socket schema changed: daemon B_b', () => {
  let session: Session;
  beforeAll(async () => {
    session = await open(Bb);
  });
  afterAll(async () => {
    await session.stop();
  });

  test('`fy alpha show`, `fy alpha watch` and `fy beta show` exit 69 and say what to do; nothing but the inventory is read', async () => {
    const said: Record<string, string> = {
      alpha: `Alpha differs between fy and the daemon: ${UPDATE}.`,
      beta: `Beta differs between fy and the daemon: ${UPDATE}.`,
    };
    for (const [argv, owner] of [
      [['alpha', 'show'], 'alpha'],
      [['alpha', 'watch'], 'alpha'],
      [['beta', 'show'], 'beta'],
    ] as const) {
      resetCounters();
      session.proxy.reset();
      const result = await session.fy(argv);
      expect(result.code).toBe(EXIT_UNAVAILABLE);
      expect(result.err).toContain(said[owner] as string);
      // `ensureAllowed` reads the inventory, and once more before it blocks (a daemon that restarted is not judged by its old answer).
      expectOnlyInventoryReads(session, 2);
      expectNoDaemonWork('alpha', 'beta', 'gamma');
    }
  });

  test('an agent tool of the provider is refused with `plugin_paused` before a byte is sent', async () => {
    session.proxy.reset();
    const tools = new ToolClient(await session.deps());
    const refused = await pausedWith(tools.call('alpha', 'alpha_get', {}));
    expect(refused.code).toBe('plugin_paused');
    expect(refused.reason).toBe('different');
    expect(refused.message).toContain(`Alpha differs between fy and the daemon: ${UPDATE}.`);
    expect(session.proxy.paths().some(path => path.includes('/v1/tools'))).toBe(false);
    expectOnlyInventoryReads(session);
    expectNoDaemonWork('alpha');
  });

  test('delta, which consumes nothing that changed, still works after the blocked attempts', async () => {
    resetCounters();
    const delta = await session.fy(['delta', 'show']);
    expect(delta.code).toBe(0);
    expect(hits.delta.route).toBe(1);
    expectNoDaemonWork('alpha', 'beta', 'gamma');
  });
});

// ─── (c) a consumer's renderer for that provider ──────────────────────────────────────────────────────────────────────

describe('(c) a consumer that only RENDERS the provider’s ask source: daemon B_c', () => {
  let session: Session;
  beforeAll(async () => {
    session = await open(Bc);
  });
  afterAll(async () => {
    await session.stop();
  });

  test('gamma, which imports nothing of alpha, is paused through its renderer edge; the inventory is all that is read', async () => {
    resetCounters();
    session.proxy.reset();
    const refused = await pausedWith(ensureAllowed(await session.deps(), 'gamma'));
    expect(refused.plugin).toBe('gamma');
    expect(refused.reason).toBe('different');
    expect(refused.message).toContain(`Gamma differs between fy and the daemon: ${UPDATE}.`);
    expectOnlyInventoryReads(session);
    expectNoDaemonWork('alpha', 'beta', 'gamma');
  });

  test('alpha and beta are paused too, and delta works', async () => {
    resetCounters();
    expect((await session.fy(['alpha', 'show'])).code).toBe(EXIT_UNAVAILABLE);
    expect((await session.fy(['beta', 'show'])).code).toBe(EXIT_UNAVAILABLE);
    expectNoDaemonWork('alpha', 'beta', 'gamma');
    expect((await session.fy(['delta', 'show'])).code).toBe(0);
    expect(hits.delta.route).toBe(1);
  });
});

// ─── (d) a core contract changed ──────────────────────────────────────────────────────────────────────────────────────

describe('(d) a core contract changed: daemon B_d', () => {
  let session: Session;
  beforeAll(async () => {
    session = await open(Bd);
  });
  afterAll(async () => {
    await session.stop();
  });

  test('every verb is refused, even the unchanged plugin’s; the sentence names the first core piece that differs', async () => {
    resetCounters();
    session.proxy.reset();
    const delta = await session.fy(['delta', 'show']);
    expect(delta.code).toBe(EXIT_UNAVAILABLE);
    expect(delta.err).toContain(
      `Asks, which everything needs, differs between fy and the daemon, so fy sends nothing to it: ${UPDATE}, or update fy.`,
    );
    expectOnlyInventoryReads(session, 2);
    expectNoDaemonWork('alpha', 'beta', 'gamma', 'delta');
    expect((await session.fy(['alpha', 'show'])).code).toBe(EXIT_UNAVAILABLE);
    expectNoDaemonWork('alpha', 'beta', 'gamma', 'delta');
  });
});

// ─── (e) a limited device and a member reading the inventory ──────────────────────────────────────────────────────────

describe('(e) who may read the inventory: daemon A', () => {
  let session: Session;
  beforeAll(async () => {
    session = await open(A);
  });
  afterAll(async () => {
    await session.stop();
  });

  /** A request as a carrier delivers it: not local, with a principal when a session proved one. */
  const request = (principal?: ApiRequest['principal']): ApiRequest => ({
    method: 'GET',
    path: '/v1/plugins',
    query: queryFrom(new URLSearchParams()),
    headers: headersFrom({}),
    arrival: { kind: 'carried', carrier: 'direct' as never },
    ...(principal === undefined ? {} : { principal }),
    text: async () => '',
  });

  test('a member session is refused the main table’s inventory: 403, before anything else', async () => {
    const member = { kind: 'member', holder: 'fy_member_fixture', session: 'fixture', leaseUntil: Date.now() + 60_000 };
    const answer = await session.daemon.host.dispatch(request(member as unknown as ApiRequest['principal']));
    expect(answer.status).toBe(403);
  });

  test('a caller with no credential at all is refused: 401', async () => {
    const answer = await session.daemon.host.dispatch(request());
    expect(answer.status).toBe(401);
  });

  test.todo(
    "G4 a member reads its own table's contract hash (`GET /v1/shared/contract` does not exist on Catalogs yet, §9.6)",
  );
});
