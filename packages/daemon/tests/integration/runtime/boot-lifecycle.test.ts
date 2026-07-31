import { afterEach, describe, it } from 'bun:test';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionConfigSchema, SessionStateSchema } from '@ferretry/protocol';
import should from 'should';
import { buildWorld, start, type DaemonWorld } from '../../../bin/fyd.ts';
import { EXIT_ALREADY_RUNNING, parseSessionId } from '../../../src/lib/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

/**
 * The daemon's boot lifecycle, driven through the real composition root.
 *
 * Everything here runs against a throwaway `FY_HOME` and an ephemeral loopback port: no real state
 * home is resolved, no known port is bound, and no daemon is left running — `untilShutdown` resolves
 * when the test says so, so `start` returns instead of serving forever.
 */

/** Bun declares `port` optional for the unix-socket case; a loopback `serve` always reports one. */
function boundPort(server: { readonly port?: number }): number {
  if (server.port === undefined) throw new Error('the fixture server reported no port');
  return server.port;
}

/** A port nothing is listening on, learned by letting the kernel pick one and then releasing it. */
async function freeLoopbackPort(): Promise<number> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('probe') });
  const port = boundPort(server);
  await server.stop(true);
  return port;
}

/**
 * A state home that already has its layout, holding a configuration that binds the given port.
 *
 * The layout is established through the daemon's own storage rather than by hand, because a home
 * with hand-made directories and no version marker is exactly the foreign state the layout gate
 * exists to refuse. Configuration is written afterwards for the same reason.
 */
async function seedHome(home: string, port: number): Promise<void> {
  process.env.FY_HOME = home;
  const opened = await buildWorld().storage.open();
  await opened.storage.close();
  await writeFile(join(home, 'config', 'daemon.json'), JSON.stringify({ host: '127.0.0.1', port }), { mode: 0o600 });
}

const SESSION_ID = 'wire-1';

/**
 * A real session in the state home, written through the daemon's own storage.
 *
 * Both documents go through the protocol schemas first, so the fixture cannot drift from what the
 * daemon will parse back out — a hand-written config that the schema rejects would make the live
 * view silently empty and the test would still pass.
 */
async function seedSession(home: string, at: string): Promise<void> {
  process.env.FY_HOME = home;
  const opened = await buildWorld().storage.open();
  const id = parseSessionId(SESSION_ID);
  await opened.storage.writeConfig(
    id,
    SessionConfigSchema.parse({
      id: SESSION_ID,
      incarnation: `${SESSION_ID}-1`,
      runtimeGeneration: 1,
      name: 'Wire Subsystems',
      boardAccess: 'none',
      agent: 'claude-auto',
      harness: 'claude',
      modelHint: 'opus',
      mode: 'auto',
      remoteControl: false,
      harnessFlags: [],
      cwd: home,
      createdAt: at,
      updatedAt: at,
      turn: 1,
      intervalSeconds: 30,
      timeoutSeconds: 0,
      nudgeAfterSeconds: 0,
      killAfterSeconds: 0,
      directSendMaxChars: 4_096,
      resumeMenuChoice: 'full',
      maxSnapshots: 10,
      retry: { transientAttempts: 0, stalledAttempts: 0, waitForQuotaReset: false, allowAccountFailover: false },
    }),
  );
  await opened.storage.writeState(
    id,
    SessionStateSchema.parse({ id: SESSION_ID, status: 'running', turn: 1, lastActivityAt: at }),
  );
  await opened.storage.close();
}

/** Boots the production world against a seeded temp home, with shutdown driven by the test. */
async function worldAt(home: string, port: number, untilShutdown: () => Promise<void>): Promise<DaemonWorld> {
  await seedHome(home, port);
  return { ...buildWorld(), untilShutdown };
}

async function runCleanups(cleanups: ReadonlyArray<() => void | Promise<void>>): Promise<void> {
  for (const cleanup of cleanups) await cleanup();
}

describe('daemon boot lifecycle', () => {
  const previousHome = process.env.FY_HOME;

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.FY_HOME;
    else process.env.FY_HOME = previousHome;
    await cleanupTempDirectories();
  });

  it('should serve health and usage over the configured address, then release everything', async () => {
    // Arrange
    const home = await tempDirectory('fyd-boot');
    const port = await freeLoopbackPort();
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    const world = await worldAt(home, port, async () => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
    });

    // Act
    const exit = start(world, cleanups);
    // The server is listening once /healthz answers; the poll bounds how long boot may take.
    let health: Response | undefined;
    for (let attempt = 0; attempt < 100 && health === undefined; attempt += 1) {
      health = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined);
      if (health === undefined) await Bun.sleep(50);
    }
    const usage = await fetch(`http://127.0.0.1:${port}/usage`);
    const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/usage`);
    // A mounted subsystem, reached with the token the boot minted. The session does not exist, so a
    // MOUNTED pin board answers `not-found`; an unmounted one would answer `unknown_route`.
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const pins = await fetch(`http://127.0.0.1:${port}/v1/sessions/absent/pins`, {
      headers: { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' },
    });
    release();
    const code = await exit;
    await runCleanups(cleanups);
    const afterStop = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined);

    // Assert
    should(code).equal(0);
    should(health?.status).equal(200);
    should((await health!.json()) as { status: string }).have.property('status', 'ok');
    should(usage.status).equal(200);
    should((await usage.json()) as { ready: boolean }).have.property('ready', false);
    should(unauthorized.status).equal(401);
    should(pins.status).equal(404);
    should((await pins.json()) as { code: string }).have.property('code', 'not-found');
    should(afterStop).be.undefined();
    // The API tokens were minted into the home, which only a boot that reached the server does.
    should(await readdir(home)).containEql('api-token');
  });

  /**
   * The task board, driven through the production composition root over a real socket.
   *
   * This is the test the unit "is it mounted" assertion cannot be: it proves the board DOES ITS JOB —
   * the record is created by the real reducer, committed by the real file store into the real session
   * directory inside the state home, read back by a second request, enriched from the real session
   * index, and visible to the fleet-wide read. Nothing here is faked but the shutdown signal.
   */
  it('should create, persist, enrich and re-read a task through the mounted board', async () => {
    // Arrange
    const home = await tempDirectory('fyd-tasks');
    const port = await freeLoopbackPort();
    const at = '2026-07-31T09:00:00.000Z';
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    const world = await worldAt(home, port, async () => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
    });
    await seedSession(home, at);
    const exit = start(world, cleanups);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined)) !== undefined) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' };
    const base = `http://127.0.0.1:${port}/v1/sessions/${SESSION_ID}/tasks`;

    // Act
    const created = await fetch(base, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'feature',
        title: 'Mount the task boards',
        ask: { text: 'the daemon had no boards', source: 'human' },
      }),
    });
    const createdBody = (await created.json()) as { id: string; assignee: string; live: { assigneeName: string } };
    const advanced = await fetch(`${base}/${createdBody.id}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'status', status: 'in_progress', reason: 'wiring it' }),
    });
    const listed = await fetch(base, { headers });
    const detail = await fetch(`${base}/${createdBody.id}`, { headers });
    const fleet = await fetch(`http://127.0.0.1:${port}/v1/tasks`, { headers });
    const listedBody = (await listed.json()) as { tasks: { id: string; status: string }[]; parseErrors: number };
    const detailBody = (await detail.json()) as { activity: { type: string }[] };
    const fleetBody = (await fleet.json()) as { sessionId: null; tasks: { sessionId: string; id: string }[] };
    // The board is one atomic snapshot inside the session's own private directory.
    const snapshot = await readFile(join(home, 'state', 'sessions', SESSION_ID, 'tasks.json'), 'utf8');
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    should(created.status).equal(201);
    should(createdBody.id).equal('F1');
    // An omitted assignee means the owning session, which the mount must not collapse to `null`.
    should(createdBody.assignee).equal(SESSION_ID);
    // Enrichment came from the real session index, not from anything the request carried.
    should(createdBody.live.assigneeName).equal('Wire Subsystems');
    should(advanced.status).equal(200);
    should(listed.status).equal(200);
    should(listedBody.parseErrors).equal(0);
    should(listedBody.tasks.map(task => [task.id, task.status])).deepEqual([['F1', 'in_progress']]);
    // The history survived the second request, which only a durable board can do.
    should(detailBody.activity.map(event => event.type)).deepEqual(['created', 'status']);
    should(fleetBody.sessionId).be.null();
    should(fleetBody.tasks.map(task => [task.sessionId, task.id])).deepEqual([[SESSION_ID, 'F1']]);
    should(JSON.parse(snapshot) as { tasks: unknown[] }).have.property('tasks').with.length(1);
  });

  it('should release the home lock so a second boot of the same home succeeds', async () => {
    // Arrange
    const home = await tempDirectory('fyd-relock');
    const port = await freeLoopbackPort();
    const boot = async (): Promise<number> => {
      const cleanups: Array<() => void | Promise<void>> = [];
      process.env.FY_HOME = home;
      const code = await start({ ...buildWorld(), untilShutdown: async () => {} }, cleanups);
      await runCleanups(cleanups);
      return code;
    };
    await seedHome(home, port);

    // Act
    const first = await boot();
    const second = await boot();

    // Assert
    should(first).equal(0);
    should(second).equal(0);
  });

  it('should report already-running when another owner holds the home lock', async () => {
    // Arrange
    const home = await tempDirectory('fyd-locked');
    const port = await freeLoopbackPort();
    await seedHome(home, port);
    const incumbent = await buildWorld().storage.open();
    const cleanups: Array<() => void | Promise<void>> = [];

    // Act
    const code = await start({ ...buildWorld(), untilShutdown: async () => {} }, cleanups);
    await incumbent.storage.close();

    // Assert
    should(code).equal(EXIT_ALREADY_RUNNING);
    // The open failed, so nothing was acquired and there is nothing to release.
    should(cleanups).be.empty();
  });

  it('should refuse to boot when the configured address already has a responder', async () => {
    // Arrange
    const home = await tempDirectory('fyd-incumbent');
    const incumbent = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ status: 'ok' }) });
    const cleanups: Array<() => void | Promise<void>> = [];
    const world = await worldAt(home, boundPort(incumbent), async () => {});

    // Act
    const code = await start(world, cleanups);
    await runCleanups(cleanups);
    await incumbent.stop(true);

    // Assert
    should(code).equal(EXIT_ALREADY_RUNNING);
    // The home was opened before the address was probed, so its release is the one registered step.
    should(cleanups).have.length(1);
  });
});
