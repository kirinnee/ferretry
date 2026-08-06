import { afterEach, describe, it } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildFleetManifest } from '@ferretry/fleet';
import {
  ACTOR_AUTHORITY_SPLIT_SEMANTICS,
  SessionViewSchema,
  TaskActivitySchema,
  type TaskActivity,
} from '@ferretry/protocol';
import should from 'should';
import { buildWorld, type DaemonWorld, start } from '../../../bin/fyd.ts';
import type { SessionLifecycleLauncher, SessionLifecycleRecord } from '../../../src/lib/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

/**
 * Completing shared live work, driven end to end through the production composition root.
 *
 * The permission this proves is not a UI affordance and not a unit-level stub: a real board is
 * created over two real sessions, each session's own capability is read from the file the daemon
 * delivered it to, and the `live → done` move is attempted by a real peer actor over a real socket
 * against the real authorizer and the real task store.
 *
 * It also pins the PROVENANCE, which is the part the route status codes cannot show. A grant is
 * what let a non-human close the task, so the durable record says `verifiedByTopAgent` — not
 * `verifiedByHuman`, which is the question "did a human check this?" and which no board grant
 * answers. The two are asserted together because a fix that only stopped writing the wrong flag
 * would leave the completion unattributed.
 */

/** The wrapper name the seeded fleet publishes; it must match the lifecycle's auto-wrapper rule. */
const WRAPPER = 'claude-auto-boot';
const ACCOUNT = '00000000-0000-4000-8000-000000000b07';
/** The caller's own id for the one logical completion this journey performs. */
const REQUEST_ID = 'mark-done-click-1';

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
 * A launcher that records instead of spawning a pane.
 *
 * It is the only production seam this test replaces: everything a board authorization depends on —
 * the session records, the capability files, the board repository and the task store — stays real,
 * because a recorded launch still produces a genuine session document to bind a membership to.
 */
class RecordingSessionLauncher implements SessionLifecycleLauncher {
  private readonly live = new Set<string>();

  async alive(record: SessionLifecycleRecord): Promise<boolean> {
    return this.live.has(record.config.tmuxSession);
  }

  async launch(record: SessionLifecycleRecord): Promise<void> {
    this.live.add(record.config.tmuxSession);
  }

  async deliver(): Promise<void> {
    return undefined;
  }

  async snapshot(): Promise<void> {
    return undefined;
  }

  async stop(record: SessionLifecycleRecord): Promise<void> {
    this.live.delete(record.config.tmuxSession);
  }
}

/**
 * A state home with its layout, established through the daemon's own storage.
 *
 * A home with hand-made directories and no version marker is exactly the foreign state the layout
 * gate exists to refuse, so the seed opens and closes the real store rather than writing the tree.
 */
async function seedHome(home: string, port: number): Promise<void> {
  process.env.FY_HOME = home;
  const opened = await buildWorld().storage.open();
  await opened.storage.close();
  await writeFile(join(home, 'config', 'daemon.json'), JSON.stringify({ host: '127.0.0.1', port }), { mode: 0o600 });
}

/** A fleet whose one account is published under a wrapper this host could actually run. */
async function seedFleet(home: string): Promise<void> {
  const binary = join(home, 'bin');
  await mkdir(binary, { recursive: true });
  const executable = join(binary, WRAPPER);
  await writeFile(executable, `#!/bin/sh\nexport CLAUDE_CONFIG_DIR="${join(home, 'harness')}"\nexit 0\n`, {
    mode: 0o755,
  });
  await mkdir(join(home, 'fleet'), { recursive: true });
  await writeFile(
    join(home, 'fleet', 'manifest.json'),
    JSON.stringify(
      buildFleetManifest({
        generatedAt: '2027-01-15T08:00:00.000Z',
        accounts: [
          {
            id: ACCOUNT,
            kind: 'claude',
            mode: 'auto',
            wrapper: executable,
            home: join(home, 'harness'),
            displayName: 'Boot',
            defaultModel: 'claude-opus-5',
            models: [{ id: 'claude-opus-5', available: true }],
            available: true,
            unavailableReason: null,
          },
        ],
      }),
    ),
    { mode: 0o600 },
  );
}

async function worldAt(home: string, port: number, untilShutdown: () => Promise<void>): Promise<DaemonWorld> {
  await seedHome(home, port);
  return { ...buildWorld(), untilShutdown };
}

/**
 * Waits for the boot to serve.
 *
 * Generously, and deliberately: this boot opens a real state home, a real analytics index and a
 * real pairing identity, which on a loaded machine has taken eight seconds here. A tight bound
 * would make the suite flaky about the one thing it is not testing.
 */
async function untilListening(port: number): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined)) !== undefined) return;
    await Bun.sleep(50);
  }
  throw new Error('the daemon never started listening');
}

const lastStatusActivity = (activity: readonly TaskActivity[]): TaskActivity => {
  const status = [...activity].reverse().find(entry => entry.type === 'status');
  if (status === undefined) throw new Error('the task recorded no status activity');
  return status;
};

describe('completing shared live work', () => {
  const previousHome = process.env.FY_HOME;

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.FY_HOME;
    else process.env.FY_HOME = previousHome;
    await cleanupTempDirectories();
  });

  it('should honour the board grant and journal the completion as the top agent', async () => {
    // Arrange
    const home = await tempDirectory('fyd-task-done-authorization');
    const port = await freeLoopbackPort();
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    const world = {
      ...(await worldAt(home, port, async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      })),
      sessionLauncher: new RecordingSessionLauncher(),
    };
    await seedFleet(home);
    const exit = start(world, cleanups);
    await untilListening(port);
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' };
    const startSession = async (requestId: string, fields: Readonly<Record<string, unknown>>): Promise<Response> =>
      await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', 'x-fy-request-id': requestId },
        body: JSON.stringify({ agent: WRAPPER, cwd: home, prompt: 'work the board', ...fields }),
      });
    // The membership ROOT is live, interactive and top-level, which is the shape a creator grant
    // attaches to. The coordinator exists to be the WRONG capability: a real member of the same
    // board, holding every action except this one.
    const root = SessionViewSchema.parse(await (await startSession('req-done-root', { mode: 'interactive' })).json());
    const coordinator = SessionViewSchema.parse(
      await (await startSession('req-done-coordinator', { mode: 'auto', parent: root.config.id })).json(),
    );
    const createBoard = async (adminCapability: string): Promise<Response> =>
      await fetch(`http://127.0.0.1:${port}/v1/task-boards/create`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', 'x-fy-board-admin-capability': adminCapability },
        body: JSON.stringify({
          creatorSessionId: root.config.id,
          coordinatorSessionId: coordinator.config.id,
          creatorMarkDone: true,
        }),
      });
    // The operator capability is minted lazily by the first request that has to check one, so the
    // real first move is to try, be refused, and then read what `fyd` issued.
    await createBoard('not-the-operator');
    const created = await createBoard((await readFile(join(home, 'board-admin-capability'), 'utf8')).trim());
    // Each session's own capability, read from the file the daemon delivered it to — the response
    // never carries one, which is the point of the environment channel.
    const capabilityOf = async (sessionId: string): Promise<string> => {
      const environment = JSON.parse(
        await readFile(join(home, 'state', 'sessions', sessionId, 'environment.json'), 'utf8'),
      ) as Readonly<Record<string, string>>;
      return environment.FY_BOARD_CAPABILITY ?? '';
    };
    const rootCapability = await capabilityOf(root.config.id);
    const coordinatorCapability = await capabilityOf(coordinator.config.id);
    const tasks = `http://127.0.0.1:${port}/v1/sessions/${root.config.id}/tasks`;
    const openedTask = await fetch(tasks, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'feature',
        title: 'Prove the done grant',
        ask: { text: 'prove the grant', source: 'integration' },
        status: 'live',
      }),
    });
    const taskId = ((await openedTask.json()) as { readonly id: string }).id;
    const markDone = async (extra: Readonly<Record<string, string>>): Promise<Response> =>
      await fetch(`${tasks}/${encodeURIComponent(taskId)}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', ...extra },
        body: JSON.stringify({ action: 'phase', phase: 'done', reason: 'Marked done from Tasks.' }),
      });
    const peer = { 'x-ferretry-session-id': root.config.id };

    // Act — the same peer, four credentials.
    const withoutCapability = await markDone(peer);
    const withWrongGrant = await markDone({ ...peer, 'x-fy-board-capability': coordinatorCapability });
    // The capability is a proof for ROOT, not a license to claim any other peer as the actor.
    // A disagreement must fail before task state or provenance moves.
    const withMismatchedPeer = await markDone({
      'x-ferretry-session-id': coordinator.config.id,
      'x-fy-board-capability': rootCapability,
      'x-fy-request-id': 'mark-done-mismatched-peer',
    });
    const withoutRequestId = await markDone({ ...peer, 'x-fy-board-capability': rootCapability });
    const withGrant = await markDone({
      ...peer,
      'x-fy-board-capability': rootCapability,
      'x-fy-request-id': REQUEST_ID,
    });
    const completed = (await withGrant.json()) as { readonly phase: string };
    // Read back from the store rather than from the response, so the assertion is about what the
    // daemon DURABLY recorded and not about what one handler happened to return.
    const detail = (await (await fetch(`${tasks}/${encodeURIComponent(taskId)}`, { headers })).json()) as {
      readonly activity: readonly unknown[];
    };
    release();
    const code = await exit;
    for (const cleanup of cleanups) await cleanup();

    // Assert
    should(code).equal(0);
    should(created.status).equal(201);
    should(openedTask.status).equal(201);
    should(rootCapability).not.be.empty();
    should(coordinatorCapability).not.be.empty();
    // A capability is required, and the coordinator's real membership is not this grant.
    should(withoutCapability.status).equal(401);
    should(withWrongGrant.status).equal(403);
    should(withMismatchedPeer.status).equal(403);
    // Authorized, and still refused: the record this completion writes is keyed by the caller's own
    // id for it, and the daemon will not invent one.
    should(withoutRequestId.status).equal(400);
    // The grant is served, and the answer already carries the new phase: nothing has to be polled
    // for the client to show the completion.
    should(withGrant.status).equal(200);
    should(completed.phase).equal('done');
    const recorded = TaskActivitySchema.parse(lastStatusActivity(detail.activity.map(entry => entry as TaskActivity)));
    should(recorded.actor).equal(`peer:${root.config.id}`);
    should(recorded.data).have.property('phaseFrom', 'live');
    should(recorded.data).have.property('phaseTo', 'done');
    // POSITIVE: which attestation, and the grant it was made under, resolved by the real board.
    should(recorded.data).have.property('verifiedByTopAgent', true);
    const authorization = (recorded.data as { readonly authorization?: Record<string, unknown> }).authorization;
    should(authorization).have.property('role', 'top_agent');
    should(authorization).have.property('action', 'mark_done');
    should(authorization).have.property('requestId', REQUEST_ID);
    should(authorization?.boardId).not.be.empty();
    should(authorization).have.property('boardEpoch');
    should(authorization).have.property('coordinatorEpoch');
    // The defect this test exists for: a peer completion recorded as a human verification.
    should(recorded.data).not.have.property('verifiedByHuman');
    // A record this daemon wrote is trustworthy on its face, so it carries no legacy marker.
    should(recorded.data).have.property('attestationSemantics', ACTOR_AUTHORITY_SPLIT_SEMANTICS);
    should(recorded.data).not.have.property('legacyAttestation');
  });
});
