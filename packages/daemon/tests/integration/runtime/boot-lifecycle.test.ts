import { afterEach, describe, it } from 'bun:test';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AnalyticsResponseSchema,
  HealthViewSchema,
  LearningConfigSchema,
  LearningPatchResponseSchema,
  LearningStatusSchema,
  ProposalViewSchema,
  SessionConfigSchema,
  SessionListSchema,
  SessionStateSchema,
  SessionViewSchema,
  NameSuggestionsSchema,
  TerminalListViewSchema,
  TerminalViewSchema,
} from '@ferretry/protocol';
import should from 'should';
import { z } from 'zod';
import { buildWorld, start, type DaemonWorld } from '../../../bin/fyd.ts';
import {
  EXIT_ALREADY_RUNNING,
  parseSessionId,
  DEFAULT_CALLSIGN_POOL,
  type PaneObservation,
  type ResumeLauncher,
  type SessionLifecycleLauncher,
  type SessionLifecycleRecord,
  type TerminalRecord,
  type TerminalRuntimePort,
} from '../../../src/lib/index.ts';
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
/** The callsign the seeded session answers to. Taken from the shipped pool so the suggestion route
 *  is proved to skip a name it would otherwise have offered. */
const SEEDED_CALLSIGN = DEFAULT_CALLSIGN_POOL[0]!;

/**
 * A real session in the state home, written through the daemon's own storage.
 *
 * Both documents go through the protocol schemas first, so the fixture cannot drift from what the
 * daemon will parse back out — a hand-written config that the schema rejects would make the live
 * view silently empty and the test would still pass.
 */
async function seedSession(
  home: string,
  at: string,
  sessionId: string = SESSION_ID,
  /** Merged over the default running state, so a case can seed a FINISHED session without
   *  restating every field the schema demands. */
  state: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  process.env.FY_HOME = home;
  const opened = await buildWorld().storage.open();
  const id = parseSessionId(sessionId);
  await opened.storage.writeConfig(
    id,
    SessionConfigSchema.parse({
      id: sessionId,
      incarnation: `${sessionId}-1`,
      runtimeGeneration: 1,
      name: 'Wire Subsystems',
      teammate: SEEDED_CALLSIGN,
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
    SessionStateSchema.parse({ id: sessionId, status: 'running', turn: 1, lastActivityAt: at, ...state }),
  );
  await opened.storage.close();
}

/**
 * A terminal runtime that records instead of spawning.
 *
 * Substituted at `DaemonWorld.terminalRuntime` so the boot test never starts a shell or touches a
 * tmux socket. It behaves like tmux does in the one way the mount depends on: `list` is the
 * authority, so a rename that did not reach the runtime would not survive the next read.
 */
class RecordingTerminalRuntime implements TerminalRuntimePort {
  readonly opened: TerminalRecord[] = [];
  readonly killed: string[] = [];
  private readonly records = new Map<string, TerminalRecord>();

  async list(): Promise<readonly TerminalRecord[]> {
    return [...this.records.values()];
  }

  async create(input: Parameters<TerminalRuntimePort['create']>[0]): Promise<TerminalRecord> {
    const record: TerminalRecord = {
      id: input.id,
      ownerId: input.ownerId,
      title: input.title,
      root: input.cwd,
      tmuxSession: `fy-webterm-${input.ownerId}-${input.id}`,
      createdAtMs: 1_700_000_000_000,
      lastActivityAtMs: 1_700_000_000_000,
      ...input.size,
    };
    this.records.set(record.id, record);
    this.opened.push(record);
    return record;
  }

  async rename(record: TerminalRecord, title: string): Promise<void> {
    this.records.set(record.id, { ...record, title });
  }

  async resize(record: TerminalRecord, size: { readonly cols: number; readonly rows: number }): Promise<void> {
    this.records.set(record.id, { ...record, ...size });
  }

  /** Bytes a viewer typed, decoded, so a case can assert what actually reached the pane. */
  readonly written: string[] = [];
  /** What the pane would draw. Non-empty so a real socket frame carries something assertable. */
  screen = 'ready $ ';

  async write(_record: TerminalRecord, bytes: Uint8Array): Promise<void> {
    this.written.push(new TextDecoder().decode(bytes));
  }

  async capture(): Promise<Uint8Array> {
    return new TextEncoder().encode(this.screen);
  }

  async kill(record: TerminalRecord): Promise<void> {
    this.records.delete(record.id);
    this.killed.push(record.id);
  }
}

/**
 * An agent launcher that records instead of spawning.
 *
 * Substituted at `DaemonWorld.sessionLauncher` so the boot test never starts an agent, never touches
 * a tmux socket and never binds a pane. It behaves like tmux does in the two ways the lifecycle
 * depends on: a session is not alive until it has been launched, and it stops being alive when it is
 * killed — which is what makes a retried start idempotent rather than a second pane.
 */
class RecordingSessionLauncher implements SessionLifecycleLauncher {
  /** Every launch, as the argv and the directory it was launched in. */
  readonly launched: Array<{ readonly command: readonly string[]; readonly cwd: string }> = [];
  /** Every instruction typed into a ready pane. */
  readonly delivered: string[] = [];
  readonly stopped: string[] = [];
  private readonly live = new Set<string>();

  async alive(record: SessionLifecycleRecord): Promise<boolean> {
    return this.live.has(record.config.tmuxSession);
  }

  async launch(record: SessionLifecycleRecord): Promise<void> {
    this.launched.push({ command: [...record.config.command], cwd: record.config.cwd });
    this.live.add(record.config.tmuxSession);
  }

  async deliver(_record: SessionLifecycleRecord, instruction: string): Promise<void> {
    this.delivered.push(instruction);
  }

  async stop(record: SessionLifecycleRecord): Promise<void> {
    this.stopped.push(record.config.tmuxSession);
    this.live.delete(record.config.tmuxSession);
  }
}

/**
 * A reviver that records instead of replacing a pane.
 *
 * Substituted at `DaemonWorld.createResumeLauncher` so the boot test never kills a tmux session and
 * never respawns an agent. It is the only thing a revive does that a test cannot let happen on the
 * host, so everything else stays production: the real resume service, the real turn-document store,
 * the real journalled transitions over the real state home, and the real route.
 *
 * `pane` is what the harness would be observed doing, set by the case. That single value is what
 * `planResume` branches on — a live pane is typed into, a gone one is relaunched — so making it a
 * field is what lets one boot prove both halves of the mount.
 */
class RecordingResumeLauncher implements ResumeLauncher {
  /** What `observe` reports. A session nothing is running: the revive must relaunch it. */
  pane: PaneObservation = { alive: false, dead: false, promptReady: false };
  /** Every session relaunched, in order. */
  readonly relaunched: string[] = [];
  /** Every instruction typed into a pane, live or replacement. */
  readonly delivered: string[] = [];
  readonly killed: string[] = [];
  readonly snapshots: string[] = [];

  async observe(): Promise<PaneObservation> {
    return this.pane;
  }

  async snapshot(id: string): Promise<void> {
    this.snapshots.push(id);
  }

  async kill(id: string): Promise<void> {
    this.killed.push(id);
  }

  async relaunch(id: string): Promise<void> {
    this.relaunched.push(id);
  }

  async deliver(_id: string, instruction: string): Promise<void> {
    this.delivered.push(instruction);
  }

  async confirmExit(): Promise<{ readonly confirmed: boolean; readonly pane: PaneObservation }> {
    return { confirmed: true, pane: this.pane };
  }
}

/** The wrapper name the seeded fleet publishes. It must match the lifecycle's auto-wrapper rule. */
const WRAPPER = 'claude-auto-boot';

/**
 * A fleet whose one account is published under a wrapper this host can actually run.
 *
 * The executable is REAL and on `PATH` for the duration of the test, because resolving a published
 * name into an absolute program is a step the start genuinely performs — the lifecycle's own
 * authorization refuses anything that is not an absolute fleet wrapper. It is never executed: the
 * launcher above is what would have run it.
 */
async function seedFleet(home: string): Promise<string> {
  const binary = join(home, 'bin');
  await mkdir(binary, { recursive: true });
  const executable = join(binary, WRAPPER);
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await mkdir(join(home, 'fleet'), { recursive: true });
  await writeFile(
    join(home, 'fleet', 'manifest.json'),
    JSON.stringify({
      accounts: [
        {
          id: 'account-boot',
          agent: WRAPPER,
          kind: 'claude',
          mode: 'auto',
          displayName: 'Boot',
          defaultModel: 'claude-opus-5',
          models: [{ id: 'claude-opus-5', available: true }],
          available: true,
        },
      ],
    }),
    { mode: 0o600 },
  );
  process.env.PATH = `${binary}:${process.env.PATH ?? ''}`;
  return executable;
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
  const previousPath = process.env.PATH;

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.FY_HOME;
    else process.env.FY_HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
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
    should(JSON.parse(snapshot) as { tasks: unknown[] })
      .have.property('tasks')
      .with.length(1);
  });

  /**
   * The session read, driven through the production composition root over a real socket.
   *
   * It proves the mount DOES ITS JOB rather than merely existing: the fleet comes from the real
   * session index, both documents are parsed back out by the same protocol schemas that wrote them,
   * and the directory each view reports is the one the layout actually put the documents in — which
   * the case checks by reading a file out of it. A session the index does not hold is absent, and a
   * session whose documents no longer satisfy the protocol is refused rather than reported missing.
   */
  it('should list and read the seeded sessions through the mounted session read', async () => {
    // Arrange
    const home = await tempDirectory('fyd-sessions');
    const port = await freeLoopbackPort();
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    const world = await worldAt(home, port, async () => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
    });
    await seedSession(home, '2026-07-30T09:00:00.000Z', 'wire-one');
    await seedSession(home, '2026-07-31T09:00:00.000Z', 'wire-two', { status: 'completed', turn: 4 });
    // A session the index holds whose state document the protocol will refuse. Written straight into
    // the session directory, because the storage writer would not accept it either.
    await seedSession(home, '2026-07-31T10:00:00.000Z', 'wire-bad');
    await writeFile(join(home, 'state', 'sessions', 'wire-bad', 'state.json'), JSON.stringify({ id: 'wire-bad' }), {
      mode: 0o600,
    });
    const exit = start(world, cleanups);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined)) !== undefined) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' };
    const sessions = `http://127.0.0.1:${port}/v1/sessions`;

    // Act
    const listed = await fetch(sessions, { headers });
    const one = await fetch(`${sessions}/wire-one`, { headers });
    const absent = await fetch(`${sessions}/wire-ghost`, { headers });
    const unusable = await fetch(`${sessions}/wire-bad`, { headers });
    const listedBody = SessionListSchema.parse(await listed.json());
    const oneBody = SessionViewSchema.parse(await one.json());
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    should(listed.status).equal(200);
    // The two usable sessions, in the real index's newest-first order. The third is omitted rather
    // than half-reported.
    should(listedBody.map(session => [session.config.id, session.state.status])).deepEqual([
      ['wire-two', 'completed'],
      ['wire-one', 'running'],
    ]);
    should(one.status).equal(200);
    should(oneBody.config.name).equal('Wire Subsystems');
    should(oneBody.config.cwd).equal(home);
    // The reported directory is the layout's own, proved by reading the marker the storage wrote.
    should(oneBody.directory).equal(join(home, 'state', 'sessions', 'wire-one'));
    should(await readFile(join(oneBody.directory, 'session-version'), 'utf8')).not.be.empty();
    should(absent.status).equal(404);
    should((await absent.json()) as { code: string }).have.property('code', 'not-found');
    // Omitted from the list, but answerable here: "it does not exist" would be a lie.
    should(unusable.status).equal(500);
    should((await unusable.json()) as { code: string }).have.property('code', 'unusable_session_document');
  });

  /**
   * Starting and stopping a session, driven through the production composition root over a real
   * socket. This is the capability the daemon did not have: every other mount is addressed by a
   * session id, and nothing could create one.
   *
   * Only the agent launcher is substituted, at the seam `DaemonWorld` exposes for exactly this —
   * spawning an agent is not something a suite may do. EVERYTHING else is production: the fleet
   * manifest resolves the wrapper, this host's `PATH` resolves the executable, the real planner shapes
   * the session, the real lifecycle service writes the real state home, and the answer comes back
   * through the same reader `GET /v1/sessions` serves.
   *
   * The assertion that matters most is that the session is VISIBLE afterwards. The lifecycle and the
   * protocol describe a session with two different documents in one file, and a start that wrote only
   * the lifecycle's half would answer 201 and then be dropped by every mounted read — the session list,
   * the task board's enrichment, analytics and the callsign pool all `safeParse` that document.
   */
  it('should start, launch, list and stop a session through the mounted lifecycle', async () => {
    // Arrange
    const home = await tempDirectory('fyd-session-start');
    const port = await freeLoopbackPort();
    const cleanups: Array<() => void | Promise<void>> = [];
    const launcher = new RecordingSessionLauncher();
    let release = (): void => {};
    const world = {
      ...(await worldAt(home, port, async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      })),
      sessionLauncher: launcher,
    };
    // AFTER the layout is established: a home holding files with no version marker is exactly the
    // foreign state the layout gate refuses.
    const executable = await seedFleet(home);
    const exit = start(world, cleanups);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined)) !== undefined) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' };
    const sessions = `http://127.0.0.1:${port}/v1/sessions`;
    const body = JSON.stringify({
      agent: WRAPPER,
      mode: 'auto',
      prompt: 'wire the session lifecycle',
      name: 'Wire Session Lifecycle',
      teammate: SEEDED_CALLSIGN,
      cwd: home,
    });
    const startCall = async (requestId: string): Promise<Response> =>
      await fetch(sessions, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', 'x-fy-request-id': requestId },
        body,
      });

    // Act
    const started = await startCall('req-boot-1');
    const startedBody = SessionViewSchema.parse(await started.json());
    // The retry the protocol client performs itself after a transport error.
    const retried = await startCall('req-boot-1');
    const retriedBody = SessionViewSchema.parse(await retried.json());
    // Counted here rather than at the end: two more starts follow, and both are meant to launch.
    const launchesAfterRetry = launcher.launched.length;
    const listed = SessionListSchema.parse(await (await fetch(sessions, { headers })).json());
    const names = NameSuggestionsSchema.parse(
      await (await fetch(`http://127.0.0.1:${port}/v1/names?count=8`, { headers })).json(),
    );
    // The turn-one document the agent is told to read, inside the session's own private directory.
    const turnOne = await readFile(
      join(home, 'state', 'sessions', startedBody.config.id, 'turns', 'turn-001.md'),
      'utf8',
    );
    const stopped = await fetch(`${sessions}/${startedBody.config.id}/stop`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'the task is done' }),
    });
    const stoppedBody = SessionViewSchema.parse(await stopped.json());
    const unknownAgent = await fetch(sessions, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'x-fy-request-id': 'req-boot-2' },
      body: JSON.stringify({ agent: 'claude-auto-absent', mode: 'auto', prompt: 'nobody can serve this', cwd: home }),
    });
    // A second session asking for the callsign the first one claimed, then the same start allowing a
    // fallback. The claim is what makes the first a refusal rather than a duplicate name.
    const contested = async (requestId: string, fallback: boolean): Promise<Response> =>
      await fetch(sessions, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', 'x-fy-request-id': requestId },
        body: JSON.stringify({
          agent: WRAPPER,
          mode: 'auto',
          prompt: 'contest the callsign',
          teammate: SEEDED_CALLSIGN,
          teammateFallback: fallback,
          cwd: home,
        }),
      });
    const taken = await contested('req-boot-3', false);
    const fellBack = await contested('req-boot-4', true);
    const fellBackBody = SessionViewSchema.parse(await fellBack.json());
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    should(started.status).equal(201);
    // The document records the wrapper NAME every account is published under, never the absolute
    // program: the fleet manifest, `fy ps` and the analytics index all join on this value.
    should(startedBody.config.agent).equal(WRAPPER);
    should(startedBody.config.harness).equal('claude');
    // The model came from the manifest's own default through the real planner.
    should(startedBody.config.model).equal('claude-opus-5');
    should(startedBody.config.name).equal('Wire Session Lifecycle');
    should(startedBody.state.status).equal('running');
    // The agent that was launched is the ABSOLUTE executable this host resolved, in the caller's
    // directory — not a bare name the lifecycle would have refused.
    should(launcher.launched[0]).deepEqual({ command: [executable], cwd: home });
    // The assignment was handed over by pointing the agent at a file, and the file is really there.
    should(launcher.delivered[0]).containEql('turns/turn-001.md');
    should(turnOne).containEql('wire the session lifecycle');
    // The retry answered with the SAME session and launched nothing further: one request id, one agent.
    should(retriedBody.config.id).equal(startedBody.config.id);
    should(launchesAfterRetry).equal(1);
    // Visible to the fleet read, which only a document satisfying BOTH schemas can be.
    should(listed.map(session => session.config.id)).deepEqual([startedBody.config.id]);
    // And visible to the callsign pool: the name this session took is no longer offered.
    should(names).not.containEql(SEEDED_CALLSIGN);
    should(stopped.status).equal(200);
    should(stoppedBody.state.status).equal('stopped');
    should(stoppedBody.state.reason).equal('the task is done');
    // The stop merged over the document rather than replacing it: the protocol half survived a
    // transition that knows nothing about it.
    should(stoppedBody.config.agent).equal(WRAPPER);
    should(stoppedBody.config.model).equal('claude-opus-5');
    should(launcher.stopped).have.length(1);
    // A fleet that publishes no such account is the caller's mistake, named as one.
    should(unknownAgent.status).equal(404);
    should((await unknownAgent.json()) as { code: string }).have.property('code', 'unknown_agent');
    // The callsign was CLAIMED, not merely recorded: a second session cannot answer to it, because a
    // bare callsign that resolved to two sessions would name neither.
    should(startedBody.config.teammate).equal(SEEDED_CALLSIGN);
    should(taken.status).equal(409);
    should((await taken.json()) as { code: string }).have.property('code', 'callsign_taken');
    // A caller who allows a substitute gets a real free pool name instead of a refusal.
    should(fellBack.status).equal(201);
    should(fellBackBody.config.teammate).not.equal(SEEDED_CALLSIGN);
    should(DEFAULT_CALLSIGN_POOL).containEql(fellBackBody.config.teammate);
  });

  /**
   * Reviving a session, driven through the production composition root over a real socket.
   *
   * This proves the revive DOES ITS JOB rather than merely being constructed, and it needs a session
   * only the mounted start can produce: the resume launcher relaunches the terminal named in that
   * session's own configuration document, and it reads the command out of the argv the start recorded.
   *
   * All three branches the domain plans are driven against ONE real state home, because they differ
   * only in what the pane is doing:
   *
   *   * A LIVE pane and a message is a SEND — the message is typed into the running agent rather than
   *     its terminal being replaced, and the daemon's own turn counter does not move, because nothing
   *     observed an answer.
   *   * A LIVE pane and NO message is a refusal: there is nothing to hand a running agent.
   *   * A GONE pane is a relaunch: the turn counter moves, a numbered turn document is written into
   *     the session's own private directory, and the agent is pointed at that file.
   */
  it('should send into a live session, refuse an empty revive, and relaunch a stopped one', async () => {
    // Arrange
    const home = await tempDirectory('fyd-session-resume');
    const port = await freeLoopbackPort();
    const cleanups: Array<() => void | Promise<void>> = [];
    const launcher = new RecordingSessionLauncher();
    const reviver = new RecordingResumeLauncher();
    let release = (): void => {};
    const world = {
      ...(await worldAt(home, port, async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      })),
      sessionLauncher: launcher,
      createResumeLauncher: () => reviver,
    };
    await seedFleet(home);
    const exit = start(world, cleanups);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined)) !== undefined) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const cli = { ...headers, 'x-ferretry-client': 'cli' };
    const sessions = `http://127.0.0.1:${port}/v1/sessions`;
    const startResponse = await fetch(sessions, {
      method: 'POST',
      headers: { ...cli, 'x-fy-request-id': 'req-resume-1' },
      body: JSON.stringify({
        agent: WRAPPER,
        mode: 'auto',
        prompt: 'wire the revive',
        name: 'Wire Session Revive',
        cwd: home,
      }),
    });
    // Parsed rather than cast, so a start that failed fails HERE with the daemon's own reason instead
    // of surfacing as an unrelated assertion about a session that was never created.
    const started = SessionViewSchema.parse(await startResponse.json());
    const id = started.config.id;
    const resume = async (body: unknown): Promise<Response> =>
      await fetch(`${sessions}/${id}/resume`, { method: 'POST', headers: cli, body: JSON.stringify(body) });

    // Act
    // A live harness at a prompt: the revive types into it rather than replacing it.
    reviver.pane = { alive: true, dead: false, promptReady: true };
    const sent = await resume({ message: 'keep going, the gate is green' });
    const sentBody = SessionViewSchema.parse(await sent.json());
    // Counted here rather than at the end, because a relaunch follows and is meant to.
    const relaunchesAfterSend = reviver.relaunched.length;
    const emptyIntoLive = await resume({});
    // The session ends, and its pane goes with it.
    const stopped = await fetch(`${sessions}/${id}/stop`, {
      method: 'POST',
      headers: cli,
      body: JSON.stringify({ reason: 'the turn finished' }),
    });
    reviver.pane = { alive: false, dead: false, promptReady: false };
    const revived = await resume({ message: 'pick the migration back up' });
    const revivedBody = SessionViewSchema.parse(await revived.json());
    // Both turn documents, in the session's own private directory: the assignment the start handed
    // over, and the one the revive did.
    const turnDirectory = join(home, 'state', 'sessions', id, 'turns');
    const turns = (await readdir(turnDirectory)).sort();
    const turnOne = await readFile(join(turnDirectory, 'turn-001.md'), 'utf8');
    const turnTwo = await readFile(join(turnDirectory, 'turn-002.md'), 'utf8');
    // The same revive over the WARDEN token, which must not be able to relaunch an agent.
    const wardenToken = (await readFile(join(home, 'api-warden-token'), 'utf8')).trim();
    const asWarden = await fetch(`${sessions}/${id}/resume`, {
      method: 'POST',
      headers: { authorization: `Bearer ${wardenToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'a warden should not reach this' }),
    });
    const absent = await fetch(`${sessions}/no-such-session/resume`, { method: 'POST', headers: cli, body: '{}' });
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    // A live pane was SENT into: the instruction is the message itself, not a turn-file pointer, and
    // no relaunch happened at all.
    should(sent.status).equal(200);
    should(reviver.delivered[0]).equal('keep going, the gate is green');
    should(relaunchesAfterSend).equal(0);
    // The daemon's turn counter did not move, because a send is not a turn the daemon wrote.
    should(sentBody.state.turn).equal(started.state.turn);
    // Nothing to hand a running agent is a stated refusal, not a silent no-op that reports success.
    should(emptyIntoLive.status).equal(409);
    should((await emptyIntoLive.json()) as { code: string }).have.property('code', 'resume_refused');
    should(stopped.status).equal(200);
    // The stopped session came back: a real relaunch of the terminal its own document names.
    should(revived.status).equal(200);
    should(reviver.relaunched).deepEqual([id]);
    should(revivedBody.state.status).equal('running');
    // The counter moved for the relaunch, because THIS turn is one the daemon itself wrote.
    should(revivedBody.state.turn).equal(started.state.turn + 1);
    // And it wrote it where the agent was pointed: the instruction names the very file on disk.
    should(reviver.delivered.at(-1)).containEql('turns/turn-002.md');
    should(turnTwo).containEql('pick the migration back up');
    // The NEW document, beside the original — not over it. A start records which turn it handed over
    // precisely so a revive numbers the next one rather than overwriting the session's own assignment.
    should(turns).deepEqual(['turn-001.md', 'turn-002.md']);
    should(turnOne).containEql('wire the revive');
    // The revive merged over the document rather than replacing it: the protocol half survived a
    // transition that knows nothing about it.
    should(revivedBody.config.agent).equal(WRAPPER);
    should(revivedBody.config.name).equal('Wire Session Revive');
    // `admin` scope, matching the start and the stop: a revive relaunches a process holding the
    // daemon's own privileges, so the warden token is refused rather than served.
    should(asWarden.status).equal(403);
    should(absent.status).equal(404);
    should((await absent.json()) as { code: string }).have.property('code', 'not-found');
  });

  /**
   * The recommender, driven through the production composition root over a real socket.
   *
   * It proves the mount DOES ITS JOB rather than merely existing: the fleet comes from the manifest
   * file a provisioner publishes into the state home, the doctrine comes from the operator's routing
   * catalog, and the team that comes back names an account from that manifest with a model that
   * catalog declares. Unlike every other mount here it needs no session at all, which is why it is
   * the one capability this daemon gains that works on a fresh install.
   *
   * The two halves are one case on purpose: the catalog is written BETWEEN the two requests, so the
   * refusal proves the daemon does not invent a doctrine and the answer proves the read is live
   * rather than cached at boot.
   */
  it('should recommend a team from the fleet manifest and the routing catalog', async () => {
    // Arrange
    const home = await tempDirectory('fyd-recommend');
    const port = await freeLoopbackPort();
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    const world = await worldAt(home, port, async () => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
    });
    await mkdir(join(home, 'fleet'), { recursive: true });
    await writeFile(
      join(home, 'fleet', 'manifest.json'),
      JSON.stringify({
        accounts: [
          {
            id: 'account-primary',
            agent: 'agent-primary',
            kind: 'claude',
            mode: 'auto',
            displayName: 'Primary',
            defaultModel: 'apex',
            models: [{ id: 'apex', available: true }],
            available: true,
          },
        ],
      }),
      { mode: 0o600 },
    );
    const exit = start(world, cleanups);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined)) !== undefined) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const body = JSON.stringify({ task: 'port the remaining command groups and their tests', usage: false });
    const call = async (): Promise<Response> =>
      await fetch(`http://127.0.0.1:${port}/v1/recommend`, { method: 'POST', headers, body });

    // Act
    const unconfigured = await call();
    // The operator's doctrine, written while the daemon is already serving.
    await writeFile(
      join(home, 'config', 'routing.json'),
      JSON.stringify({
        models: [
          {
            id: 'apex',
            label: 'Apex',
            family: 'claude',
            tier: 'generalist',
            speed: 'medium',
            cost: 'high',
            power: 90,
            roleScore: { planner: 90, researcher: 85, reviewer: 80 },
            implementerFit: { mechanical: 70, mid: 85, hard: 80 },
            note: 'dependable across generic work',
          },
        ],
        accounts: [{ accountId: 'account-primary', options: [{ model: 'apex' }] }],
        floors: { planner: 50, reviewer: 50, hardAndDemanding: 60, hardOrCritical: 55, mid: 40, qualityFirst: 60 },
        costPenalty: { balanced: { high: 4 } },
      }),
      { mode: 0o600 },
    );
    const recommended = await call();
    const recommendedBody = (await recommended.json()) as {
      task: string;
      classification: string;
      roles: { role: string; primary: { accountId: string; model: string } }[];
      exclusions: unknown[];
      warnings: unknown[];
    };
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    // No catalog is the operator's gap, named as one, not a 500 and not an invented doctrine.
    should(unconfigured.status).equal(503);
    should((await unconfigured.json()) as { code: string }).have.property('code', 'recommender_unconfigured');
    should(recommended.status).equal(200);
    // The pick came from the manifest file and the model from the catalog file — nothing hardcoded.
    should(recommendedBody.roles.length).be.above(0);
    should(recommendedBody.roles.map(role => [role.primary.accountId, role.primary.model])).matchEvery(
      (pair: readonly string[]) => should(pair).deepEqual(['account-primary', 'apex']),
    );
    // The domain's own one-liner, so the guide states what it read and the words that produced it.
    should(recommendedBody.classification).match(/^Read as /u);
    should(recommendedBody.task).equal('port the remaining command groups and their tests');
  });

  /**
   * The analytics read, driven through the production composition root over a real socket.
   *
   * It proves the mount DOES ITS JOB rather than merely existing: the index is derived from the real
   * session documents in the state home, a session that has not finished is left out of it, the real
   * query parser answers the CLI's own `?q=`, and the durations reported are the ones the seeded
   * instants imply.
   */
  it('should derive and query analytics from the real session documents', async () => {
    // Arrange
    const home = await tempDirectory('fyd-analytics');
    const port = await freeLoopbackPort();
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    const world = await worldAt(home, port, async () => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
    });
    await seedSession(home, '2026-07-30T09:00:00.000Z', 'wire-done', {
      status: 'completed',
      turn: 6,
      startedAt: '2026-07-30T09:00:00.000Z',
      finishedAt: '2026-07-30T09:45:00.000Z',
    });
    // Still running: no finish instant, so it must not be measured as a run of some length.
    await seedSession(home, '2026-07-31T09:00:00.000Z', 'wire-live');
    const exit = start(world, cleanups);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined)) !== undefined) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' };
    const analytics = `http://127.0.0.1:${port}/v1/analytics`;

    // Act
    const grouped = await fetch(`${analytics}?q=${encodeURIComponent('sum by (id)')}`, { headers });
    const raw = await fetch(`${analytics}?q=${encodeURIComponent('{status=completed}')}`, { headers });
    const refused = await fetch(`${analytics}?q=${encodeURIComponent('sum by (nonsense)')}`, { headers });
    const groupedBody = AnalyticsResponseSchema.parse(await grouped.json());
    const rawBody = AnalyticsResponseSchema.parse(await raw.json());
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    should(grouped.status).equal(200);
    // One of the two seeded sessions has finished, so exactly one is indexed.
    should(groupedBody.index.sessions).equal(1);
    should(groupedBody.scope).deepEqual({ allSessions: true, indexed: 1, matched: 1 });
    should(groupedBody.kind === 'aggregate' ? groupedBody.results.map(row => row.labels.id) : []).deepEqual([
      'wire-done',
    ]);
    // 09:00 to 09:45 in the seeded state, measured by the daemon rather than asserted by the client.
    should(groupedBody.kind === 'aggregate' ? groupedBody.results.map(row => row.durationMs.value) : []).deepEqual([
      45 * 60_000,
    ]);
    should(groupedBody.kind === 'aggregate' ? groupedBody.results.map(row => row.turns.value) : []).deepEqual([6]);
    // No token evidence is indexed, so the cost is honestly unknown rather than zero.
    should(groupedBody.index.tokenSessions).equal(0);
    should(
      groupedBody.kind === 'aggregate' ? groupedBody.results.map(row => row.equivalentApiCostUsdMicros.value) : [],
    ).deepEqual([null]);
    should(rawBody.kind).equal('raw');
    should(rawBody.kind === 'raw' ? rawBody.results.map(row => [row.id, row.cwd]) : []).deepEqual([
      ['wire-done', home],
    ]);
    // A malformed query is the caller's mistake, not a 500 from the daemon.
    should(refused.status).equal(400);
    should((await refused.json()) as { code: string }).have.property('code', 'invalid_query');
  });

  /**
   * The terminal lifecycle, driven through the production composition root over a real socket.
   *
   * Only the tmux runtime is substituted, at the seam `DaemonWorld` already exposes for exactly this:
   * spawning shells on a test machine is not something a suite may do, and the tmux adapter has its
   * own integration coverage. Everything above it is production — the lifecycle service, the error
   * translation, the routes, and the session resolver reading the real config document — so the cwd
   * a terminal opens in is the one the state home actually records for that session.
   */
  it('should open, retitle, list and close a terminal through the mounted lifecycle', async () => {
    // Arrange
    const home = await tempDirectory('fyd-terminals');
    const port = await freeLoopbackPort();
    const cleanups: Array<() => void | Promise<void>> = [];
    const runtime = new RecordingTerminalRuntime();
    let release = (): void => {};
    const world = {
      ...(await worldAt(home, port, async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      })),
      terminalRuntime: runtime,
    };
    await seedSession(home, '2026-07-31T09:00:00.000Z');
    const exit = start(world, cleanups);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined)) !== undefined) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' };
    const base = `http://127.0.0.1:${port}/v1/sessions/${SESSION_ID}/terminals`;

    // Act
    const created = await fetch(base, { method: 'POST', headers });
    const opened = TerminalViewSchema.parse(await created.json());
    const renamed = await fetch(`${base}/${opened.id}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Deploy log' }),
    });
    const listed = await fetch(base, { headers });
    const listedBody = TerminalListViewSchema.parse(await listed.json());
    const absent = await fetch(`http://127.0.0.1:${port}/v1/sessions/nope/terminals`, { headers });
    const closed = await fetch(`${base}/${opened.id}`, { method: 'DELETE', headers });
    const afterClose = TerminalListViewSchema.parse(await (await fetch(base, { headers })).json());
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    should(created.status).equal(201);
    // The terminal opened in the SESSION's working directory, read from its real config document.
    should(runtime.opened.map(record => [record.ownerId, record.root])).deepEqual([[SESSION_ID, home]]);
    should(renamed.status).equal(200);
    should(TerminalViewSchema.parse(await renamed.json()).title).equal('Deploy log');
    // The retitle reached the runtime, so it survives a process that re-reads tmux rather than a map.
    should(listedBody.terminals.map(row => [row.id, row.title])).deepEqual([[opened.id, 'Deploy log']]);
    // A session the index does not hold cannot have a terminal opened against it.
    should(absent.status).equal(404);
    should(closed.status).equal(200);
    should(await closed.json()).deepEqual({ closed: true, id: opened.id });
    should(afterClose.terminals).be.empty();
    should(runtime.killed).deepEqual([opened.id]);
  });

  /**
   * The terminal STREAM, driven through the production composition root over a real WebSocket.
   *
   * This is the case the unit tier cannot be. Everything between the client and tmux is production:
   * the bound host switches the protocol, `ApiSocketDispatcher` authenticates the upgrade off the
   * loopback query-parameter token a browser is limited to, the mount proves the terminal exists
   * BEFORE the switch, and `TerminalStreamBridge` polls the pane and writes the viewer's keystrokes
   * through the SAME lifecycle service the HTTP routes use. Only the tmux pane is substituted.
   */
  it('should carry pane bytes out and keystrokes in over a real terminal socket', async () => {
    // Arrange
    const home = await tempDirectory('fyd-terminal-stream');
    const port = await freeLoopbackPort();
    const cleanups: Array<() => void | Promise<void>> = [];
    const runtime = new RecordingTerminalRuntime();
    let release = (): void => {};
    const world = {
      ...(await worldAt(home, port, async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      })),
      terminalRuntime: runtime,
    };
    await seedSession(home, '2026-07-31T09:00:00.000Z');
    const exit = start(world, cleanups);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined)) !== undefined) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const base = `http://127.0.0.1:${port}/v1/sessions/${SESSION_ID}/terminals`;
    const opened = TerminalViewSchema.parse(
      await (
        await fetch(base, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' } })
      ).json(),
    );

    // Act
    // A socket aimed at a terminal nobody opened is refused on the HANDSHAKE, so the client sees a
    // failed upgrade rather than a socket that dies for reasons it cannot name.
    const absent = await fetch(`${base}/0123456789ab/stream?token=${token}`, {
      headers: {
        upgrade: 'websocket',
        connection: 'upgrade',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'AAAAAAAAAAAAAAAAAAAAAA==',
      },
    }).catch(() => undefined);
    const viewer = new WebSocket(
      `ws://127.0.0.1:${port}/v1/sessions/${SESSION_ID}/terminals/${opened.id}/stream?token=${token}`,
    );
    viewer.binaryType = 'arraybuffer';
    const frames: string[] = [];
    const closes: number[] = [];
    viewer.addEventListener('message', event => {
      frames.push(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data));
    });
    viewer.addEventListener('close', event => closes.push(event.code));
    await new Promise<void>((resolve, reject) => {
      viewer.addEventListener('open', () => resolve());
      viewer.addEventListener('error', () => reject(new Error('the terminal socket never opened')));
    });
    for (let attempt = 0; attempt < 200 && frames.length === 0; attempt += 1) await Bun.sleep(10);
    viewer.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    viewer.send(new TextEncoder().encode('echo hi\r'));
    for (let attempt = 0; attempt < 200 && runtime.written.length === 0; attempt += 1) await Bun.sleep(10);
    const resized = TerminalViewSchema.parse(
      await (
        await fetch(`${base}/${opened.id}`, {
          headers: { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' },
        })
      ).json(),
    );
    release();
    const code = await exit;
    await runCleanups(cleanups);
    for (let attempt = 0; attempt < 200 && closes.length === 0; attempt += 1) await Bun.sleep(10);

    // Assert
    should(code).equal(0);
    // The upgrade was authenticated by the query-parameter token alone, which is all a browser
    // `WebSocket` can carry, and the first frame is the pane as tmux would draw it.
    should(frames[0]).equal('ready $ ');
    // The keystrokes reached the real pane through the lifecycle service.
    should(runtime.written).deepEqual(['echo hi\r']);
    // The resize control frame was parsed with the protocol's own schema and applied to the pane, so
    // a later HTTP read of the same terminal reports the new geometry.
    should([resized.cols, resized.rows]).deepEqual([100, 30]);
    // A stream aimed at a terminal that does not exist never becomes a socket.
    should(absent?.status).equal(404);
    // Shutdown ended the stream rather than leaving a redraw timer firing at a dead socket.
    should(closes).deepEqual([1000]);
  });

  /**
   * Callsign suggestions, driven through the production composition root over a real socket.
   *
   * The claim set is not a fixture: it is derived from the `teammate` recorded in a real session's
   * configuration document, which is what makes "this name is taken" a fact rather than a guess.
   */
  it('should never suggest a callsign a live session already answers to', async () => {
    // Arrange
    const home = await tempDirectory('fyd-names');
    const port = await freeLoopbackPort();
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    const world = await worldAt(home, port, async () => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
    });
    await seedSession(home, new Date().toISOString());
    const exit = start(world, cleanups);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined)) !== undefined) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' };

    // Act
    const answered = await fetch(`http://127.0.0.1:${port}/v1/names?count=8`, { headers });
    const names = NameSuggestionsSchema.parse(await answered.json());
    const refused = await fetch(`http://127.0.0.1:${port}/v1/names?count=0`, { headers });
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    should(answered.status).equal(200);
    should(names).have.length(8);
    should(new Set(names).size).equal(8);
    // The seeded session took this callsign minutes ago, so the pool must not offer it back.
    should(names).not.containEql(SEEDED_CALLSIGN);
    // Every suggestion is a real pool entry, not something the route invented.
    should(names.every(name => DEFAULT_CALLSIGN_POOL.includes(name))).be.true();
    should(refused.status).equal(400);
  });

  /**
   * The learning review board, driven through the production composition root over a real socket.
   *
   * Nothing is faked but the shutdown signal. The evidence is written into the state home in the
   * exact on-disk shape `FileLearningStore` owns — a JSONL append log and a JSON board — which is the
   * contract the daemon shares with whoever produces it, and then every answer comes back through the
   * real store, the real policy and the real routes.
   *
   * It proves the mount DOES ITS JOB rather than merely existing: the counters are recomputed from
   * the evidence on disk, a verdict rewrites the board durably, the rejection writes the tombstone
   * that stops the rule coming back, and the accepted patch lands inside the state home rather than
   * anywhere near the operator's own guidance file.
   */
  it('should serve, judge and durably record learning proposals through the mounted board', async () => {
    // Arrange
    const home = await tempDirectory('fyd-learning');
    const port = await freeLoopbackPort();
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    const world = await worldAt(home, port, async () => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
    });
    const learningHome = join(home, 'state', 'learning');
    await mkdir(learningHome, { recursive: true, mode: 0o700 });
    const evidence = (id: string, sessionId: string, repo: string, quote: string): string =>
      JSON.stringify({
        id,
        sessionId,
        mode: 'auto',
        cwd: home,
        repo,
        at: '2026-07-30T09:00:00.000Z',
        kind: 'correction',
        gist: 'run the repo task surface',
        quote,
        source: 'human',
        verified: true,
        runId: 'run-1',
      });
    await writeFile(
      join(learningHome, 'observations.jsonl'),
      `${evidence('obs_1', 'wire-1', 'ferretry', 'use task test')}\n${evidence('obs_2', 'wire-2', 'kteam', 'not bun test')}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(learningHome, 'proposals.json'),
      JSON.stringify([
        {
          id: 'proposal_a',
          category: 'global',
          state: 'pending',
          title: 'Always run the repo task surface',
          ruleText: 'Run `task test` rather than invoking the test runner directly.',
          target: { kind: 'global-agent-guidance', path: 'guidance.md', anchor: '## Agent rules' },
          // Claims three observations; only two exist, so the counters must come down.
          observationIds: ['obs_1', 'obs_2', 'obs_gone'],
          occurrences: 9,
          crossRepoCount: 7,
          firstSeen: '2026-07-30T09:00:00.000Z',
          lastSeen: '2026-07-30T09:00:00.000Z',
          identity: 'always-run-the-repo-task-surface',
          history: [{ at: '2026-07-30T09:00:00.000Z', event: 'proposed:run-1', by: 'miner' }],
        },
        {
          id: 'proposal_b',
          category: 'global',
          state: 'pending',
          title: 'Never bypass the commit hooks',
          ruleText: 'Do not pass --no-verify.',
          target: { kind: 'automation-guidance', path: 'automation.md' },
          observationIds: ['obs_2'],
          occurrences: 1,
          crossRepoCount: 1,
          firstSeen: '2026-07-30T09:00:00.000Z',
          lastSeen: '2026-07-30T09:00:00.000Z',
          identity: 'never-bypass-the-commit-hooks',
          history: [{ at: '2026-07-30T09:00:00.000Z', event: 'proposed:run-1', by: 'miner' }],
        },
      ]),
      { mode: 0o600 },
    );
    const exit = start(world, cleanups);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined)) !== undefined) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' };
    const learning = `http://127.0.0.1:${port}/v1/learning`;
    const judge = async (id: string, body: unknown): Promise<Response> =>
      await fetch(`${learning}/proposals/${id}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    // Act
    const status = LearningStatusSchema.parse(await (await fetch(`${learning}/status`, { headers })).json());
    const config = LearningConfigSchema.parse(await (await fetch(`${learning}/config`, { headers })).json());
    const listed = z.array(ProposalViewSchema).parse(await (await fetch(`${learning}/proposals`, { headers })).json());
    const accepted = ProposalViewSchema.parse(await (await judge('proposal_a', { action: 'accept' })).json());
    const rejected = ProposalViewSchema.parse(
      await (await judge('proposal_b', { action: 'reject', note: 'covered by the hook' })).json(),
    );
    const patch = LearningPatchResponseSchema.parse(
      await (await fetch(`${learning}/proposals/proposal_a/patch`, { headers })).json(),
    );
    const run = await fetch(`${learning}/run`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ spawn: false }),
    });
    const pendingAfter = z
      .array(ProposalViewSchema)
      .parse(await (await fetch(`${learning}/proposals?state=pending`, { headers })).json());
    // Read back off disk, which is the only thing that proves the verdicts are durable.
    const board = JSON.parse(await readFile(join(learningHome, 'proposals.json'), 'utf8')) as {
      id: string;
      state: string;
    }[];
    const tombstones = JSON.parse(await readFile(join(learningHome, 'tombstones.json'), 'utf8')) as {
      identity: string;
    }[];
    const patchFiles = await readdir(join(learningHome, 'patches'));
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    // Mining is off because no miner is mounted, and the store held no run to report.
    should(config.enabled).be.false();
    should(status.enabled).be.false();
    should(status.running).be.false();
    should(status.lastRun).be.undefined();
    should(status.totals).deepEqual({ observations: 2, proposals: 2, tombstones: 0 });
    should(status.pending).deepEqual({ total: 2, strong: 0, weak: 2 });
    // The counters came down to the evidence that actually exists on disk.
    should(listed.map(view => [view.id, view.occurrences, view.crossRepoCount])).deepEqual([
      ['proposal_a', 2, 2],
      ['proposal_b', 1, 1],
    ]);
    should(listed[0]?.evidence.map(entry => entry.quote)).deepEqual(['use task test', 'not bun test']);
    should(accepted.state).equal('accepted');
    should(rejected.state).equal('rejected');
    // Both verdicts survived into the file, which a response alone would not prove.
    should(board.map(entry => [entry.id, entry.state])).deepEqual([
      ['proposal_a', 'accepted'],
      ['proposal_b', 'rejected'],
    ]);
    should(tombstones.map(entry => entry.identity)).deepEqual(['never-bypass-the-commit-hooks']);
    should(pendingAfter).be.empty();
    // The patch is the rule as a document aimed at the operator's file — not that file rewritten.
    should(patch.path).equal('guidance.md');
    should(patch.contents).containEql('Run `task test`');
    // What the human agreed to was recorded INSIDE the state home and nowhere else.
    should(patchFiles.some(file => file.startsWith('always-run-the-repo-task-surface-'))).be.true();
    // Mining refuses with a reason rather than answering with a manifest that scanned nothing.
    should(run.status).equal(501);
    should((await run.json()) as { code: string }).have.property('code', 'mining_not_mounted');
  });

  /**
   * The daemon's own health, driven through the production composition root over a real socket.
   *
   * This is the mount that turns a BROKEN surface into a working one, so the proof is the CLI's own
   * probe: `ProtocolDaemonHealth` parses `/v1/health` against `HealthViewSchema` and treats a parse
   * failure as "the daemon did not answer". Against the previous three-field liveness body it always
   * failed, so `fy daemon status` reported a serving daemon as unreachable and `DirectSupervisor` had
   * no pid to signal. Parsing the response with that same schema here is the whole assertion.
   *
   * Nothing is faked but the shutdown signal. The counts come from the real session index, the ledger
   * from the self-check `start` actually ran before it bound the port, and the version from the
   * daemon's own package.
   */
  it('should report its own health, measured by the self-check the boot ran', async () => {
    // Arrange
    const home = await tempDirectory('fyd-health');
    const port = await freeLoopbackPort();
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    const world = await worldAt(home, port, async () => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
    });
    await seedSession(home, '2026-07-31T09:00:00.000Z', 'wire-live');
    await seedSession(home, '2026-07-30T09:00:00.000Z', 'wire-done', {
      status: 'completed',
      finishedAt: '2026-07-30T09:45:00.000Z',
    });
    const exit = start(world, cleanups);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined)) !== undefined) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();

    // Act
    const liveness = await fetch(`http://127.0.0.1:${port}/healthz`);
    // No token, because the daemon commands must answer "is it up" before one exists — the state a
    // fresh `fy daemon install` leaves a host in.
    const anonymous = await fetch(`http://127.0.0.1:${port}/v1/health`);
    const answered = await fetch(`http://127.0.0.1:${port}/v1/health`, {
      headers: { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' },
    });
    // Parsed exactly as `ProtocolDaemonHealth` parses it; a body this schema refuses is a daemon the
    // CLI reports as unreachable.
    const view = HealthViewSchema.parse(await answered.json());
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    should(answered.status).equal(200);
    // The fleet came from the real session index: two known, one still able to run.
    should([view.sessions, view.running]).deepEqual([2, 1]);
    // This process is the one serving, which is the fact the supervisor reads instead of a pid file.
    should(view.pid).equal(process.pid);
    should(view.ok).be.true();
    should(view.bootstrapState).equal('complete');
    // The boot ran a self-check BEFORE binding, so the very first answer is a measurement rather than
    // an empty ledger.
    should(view.lastSelfCheckAt).not.be.null();
    // Neither subsystem is mounted, so the daemon says so instead of reporting a broken one.
    should(view.wardenTimerArmed).be.false();
    should(view.wardenLastSweepSeconds).be.null();
    should(view.scratchGcEnabled).be.false();
    // Liveness stays public and unchanged, so nothing that probes for it needs a token.
    should(liveness.status).equal(200);
    should((await liveness.json()) as { status: string }).have.property('status', 'ok');
    // The report answers a caller holding no credential and reports the SAME daemon, which is what
    // lets `fy daemon status` work on a host where no token has been minted yet.
    should(anonymous.status).equal(200);
    should(HealthViewSchema.parse(await anonymous.json()).pid).equal(view.pid);
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
