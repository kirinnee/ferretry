import { afterEach, describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
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
  BrowserLoginStatusSchema,
  TerminalListViewSchema,
  TerminalViewSchema,
} from '@ferretry/protocol';
import should from 'should';
import { z } from 'zod';
import { buildWorld, start, type DaemonWorld } from '../../../bin/fyd.ts';
import { daemonVersion } from '../../../src/lib/version.ts';
import {
  EXIT_ALREADY_RUNNING,
  MigrationPreflight,
  parseSessionId,
  DEFAULT_CALLSIGN_POOL,
  type PaneObservation,
  type ProcessInventoryPort,
  type ProcessObservation,
  type ResumeLauncher,
  type SessionLifecycleLauncher,
  type SessionLifecycleRecord,
  type TerminalRecord,
  type TerminalRuntimePort,
} from '../../../src/lib/index.ts';
import {
  BrowserLoginWindowService,
  BrowserProfileStore,
  type BrowserLoginChild,
  type BrowserLoginRuntime,
} from '../../../src/adapters/index.ts';
import { docxBytes } from '../../fixtures/docx.ts';
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

/**
 * A process inventory that reports what the case decided instead of walking the host.
 *
 * Substituted inside a REAL `MigrationPreflight`, so every verdict, blind-spot rule and refusal the
 * gate applies is production's — only the `ps` walk it cannot perform against work that is not
 * actually running is replaced. It starts EMPTY, which is a pane with nothing in flight rather than
 * a pane nobody could read.
 */
class StubProcessInventory implements ProcessInventoryPort {
  observation: ProcessObservation = { kind: 'observed', processes: [] };

  async collect(): Promise<ProcessObservation> {
    return this.observation;
  }
}

/** The wrapper name the seeded fleet publishes. It must match the lifecycle's auto-wrapper rule. */
const WRAPPER = 'claude-auto-boot';
/** The account a migration moves onto: a different harness family, so the relaunch argv must change. */
const TARGET_WRAPPER = 'codex-auto-target';

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
  // The wrapper DECLARES its harness home, which is how a real fleet wrapper is written and the only
  // evidence the daemon has for where this account's transcripts land. `seedMigrationFleet` below
  // deliberately does not, so the no-provenance path stays covered too.
  await writeFile(executable, `#!/bin/sh\nexport CLAUDE_CONFIG_DIR="${join(home, 'harness')}"\nexit 0\n`, {
    mode: 0o755,
  });
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

/**
 * A fleet with somewhere to migrate TO.
 *
 * The two accounts differ in the two ways a migration has to survive: a different harness family, so
 * the relaunch argv cannot be the old one patched, and a smaller context window, so the downgrade
 * refusal is reachable without inventing a session state. The `[1m]` marker is the configuration
 * convention `contextWindowFor` reads — it is how a session comes to be running in a million-token
 * window in the first place.
 */
async function seedMigrationFleet(home: string): Promise<void> {
  const binary = join(home, 'bin');
  await mkdir(binary, { recursive: true });
  for (const wrapper of [WRAPPER, TARGET_WRAPPER])
    await writeFile(join(binary, wrapper), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await mkdir(join(home, 'fleet'), { recursive: true });
  await writeFile(
    join(home, 'fleet', 'manifest.json'),
    JSON.stringify({
      accounts: [
        {
          id: 'account-origin',
          agent: WRAPPER,
          kind: 'claude',
          mode: 'auto',
          displayName: 'Origin',
          defaultModel: 'claude-opus-5[1m]',
          models: [{ id: 'claude-opus-5[1m]', available: true }],
          available: true,
        },
        {
          id: 'account-target',
          agent: TARGET_WRAPPER,
          kind: 'codex',
          mode: 'auto',
          displayName: 'Target',
          defaultModel: 'gpt-5.6-terra',
          models: [{ id: 'gpt-5.6-terra', available: true }],
          available: true,
        },
      ],
    }),
    { mode: 0o600 },
  );
  process.env.PATH = `${binary}:${process.env.PATH ?? ''}`;
}

/**
 * The host effects the login window performs, with no host behind them.
 *
 * This is the seam `bin/fyd.ts` already builds the window over, and it is substituted for exactly the
 * reason the world declares it: a real one starts an X server, a Chrome and a VNC server on whatever
 * machine runs the suite. Everything ABOVE it stays production — the window's state machine, the real
 * `BrowserProfileStore` over the test's own state home, the mount, the dispatcher and the socket — so
 * what is proved is that the daemon leases the profile, records the human's verdict and serves a
 * status the reader can parse.
 */
class RecordingLoginRuntime implements BrowserLoginRuntime {
  readonly spawned: string[][] = [];
  readonly terminated: string[] = [];
  readonly platform = 'linux' as const;
  readonly environmentSource = { PATH: '/usr/bin', HOME: '/home/operator' } as const;
  readonly hostname = 'boot-host';
  readonly sshUser = 'operator';
  private clock = Date.parse('2026-07-31T12:00:00.000Z');

  async display(): Promise<string> {
    return ':77';
  }

  chromeExecutable(): string {
    return '/usr/bin/google-chrome';
  }

  x11vncExecutable(): string {
    return '/usr/bin/x11vnc';
  }

  timeoutExecutable(): string {
    return '/usr/bin/timeout';
  }

  async chromeVersion(): Promise<string> {
    return 'Google Chrome 130.0.6723.116';
  }

  spawn(argv: readonly string[]): BrowserLoginChild {
    this.spawned.push([...argv]);
    return { pid: 1_000 + this.spawned.length, exited: new Promise<number>(() => undefined), kill: () => undefined };
  }

  async freePort(): Promise<number> {
    return 5_912;
  }

  async writePassword(): Promise<string> {
    return '/tmp/does-not-matter';
  }

  async waitForChrome(): Promise<void> {
    return undefined;
  }

  async waitForVnc(): Promise<void> {
    return undefined;
  }

  async removePassword(): Promise<void> {
    return undefined;
  }

  async terminateChrome(): Promise<void> {
    this.terminated.push('chrome');
  }

  async terminateVnc(): Promise<void> {
    this.terminated.push('vnc');
  }

  now(): number {
    return this.clock;
  }

  advance(milliseconds: number): void {
    this.clock += milliseconds;
  }
}

/**
 * A dictation surface that records what it was handed and answers from memory.
 *
 * It stands in for `SttService` for one reason: the real one spawns a Whisper worker and downloads
 * model files. Everything the mount is responsible for stays production — the route table, the
 * credentials, the dispatcher and the transport.
 */
class RecordingSttSurface {
  readonly seen: string[] = [];
  closed = 0;

  async handle(request: Request): Promise<Response | undefined> {
    const path = new URL(request.url).pathname;
    this.seen.push(`${request.method} ${path}`);
    if (path.endsWith('/transcribe')) {
      return Response.json({ bytes: [...new Uint8Array(await request.arrayBuffer())] });
    }
    return Response.json({ available: false });
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
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
    // Assigned by CALLSIGN, which is what `fy task create --assignee <who>` documents its argument as,
    // and by a name nothing answers to.
    const byCallsign = await fetch(base, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'chore',
        title: 'Resolve the assignee',
        ask: { text: 'a teammate owns it', source: 'human' },
        assignee: SEEDED_CALLSIGN,
      }),
    });
    const byCallsignBody = (await byCallsign.json()) as {
      id: string;
      live: { assigneeSessionId: string | null; assigneeName: string | null; assigneeStatus: string | null };
    };
    const byStranger = await fetch(base, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'chore',
        title: 'Owned by nobody here',
        ask: { text: 'nothing answers to this', source: 'human' },
        assignee: 'not-a-teammate',
      }),
    });
    const byStrangerBody = (await byStranger.json()) as { live: { assigneeSessionId: string | null } };
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
    // A teammate CALLSIGN resolved to the session that answers to it, over the real session
    // documents. This is the capability `exactWorkerAssignee` was built for and nothing called: the
    // daemon matched session ids only, so every task a person assigned by name reported a null live
    // column.
    should(byCallsign.status).equal(201);
    should(byCallsignBody.live.assigneeSessionId).equal(SESSION_ID);
    should(byCallsignBody.live.assigneeName).equal('Wire Subsystems');
    should(byCallsignBody.live.assigneeStatus).equal('running');
    // A name nothing answers to stays honestly unknown rather than being attached to whoever was
    // nearest in the index.
    should(byStrangerBody.live.assigneeSessionId).be.null();
    should(advanced.status).equal(200);
    should(listed.status).equal(200);
    should(listedBody.parseErrors).equal(0);
    should(listedBody.tasks.map(task => [task.id, task.status])).deepEqual([
      ['F1', 'in_progress'],
      ['C1', 'todo'],
      ['C2', 'todo'],
    ]);
    // The history survived the second request, which only a durable board can do.
    should(detailBody.activity.map(event => event.type)).deepEqual(['created', 'status']);
    should(fleetBody.sessionId).be.null();
    should(fleetBody.tasks.map(task => [task.sessionId, task.id])).deepEqual([
      [SESSION_ID, 'F1'],
      [SESSION_ID, 'C1'],
      [SESSION_ID, 'C2'],
    ]);
    should(JSON.parse(snapshot) as { tasks: unknown[] })
      .have.property('tasks')
      .with.length(3);
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
    // The third step of the retry contract: after a start whose answer was lost, the client asks which
    // session its request id produced, proving with the digest of the very body it posted.
    const digest = createHash('sha256').update(body, 'utf8').digest('hex');
    const recovery = (value: string): string =>
      `${sessions}/by-request/req-boot-1?payload=${encodeURIComponent(value)}`;
    const recovered = await fetch(recovery(digest), { headers });
    const recoveredBody = SessionViewSchema.parse(await recovered.json());
    const wrongDigest = await fetch(recovery(createHash('sha256').update('{}', 'utf8').digest('hex')), { headers });
    const neverSent = await fetch(`${sessions}/by-request/req-never?payload=${digest}`, { headers });
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
    // directory — not a bare name the lifecycle would have refused. It carries the harness session
    // id this start MINTED, which is what makes the transcript path below true rather than guessed.
    const launched = launcher.launched[0];
    should(launched?.cwd).equal(home);
    should(launched?.command.slice(0, 2)).deepEqual([executable, '--session-id']);
    // The transcript record is on the session's own document, in the same write as everything else
    // the start decided — and it names the exact file the harness will write.
    const provenance = startedBody.config.transcript;
    should(provenance).have.properties({ home: join(home, 'harness'), identity: 'minted' });
    should(provenance?.harnessSessionId).equal(launched?.command[2]);
    should(provenance?.file).equal(
      join(
        home,
        'harness',
        'projects',
        home.replaceAll(/[^a-zA-Z0-9]/gu, '-'),
        `${provenance?.harnessSessionId}.jsonl`,
      ),
    );
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
    // The recovery read answers with the session that request id actually started, so a start whose
    // response was lost in transport is recoverable instead of leaving a running session nobody knows
    // about. The digest is the proof: without it any holder of the admin token could enumerate other
    // callers' request ids, and a digest of a different body names a start this was not.
    should(recovered.status).equal(200);
    should(recoveredBody.config.id).equal(startedBody.config.id);
    should(wrongDigest.status).equal(409);
    should((await wrongDigest.json()) as { code: string }).have.property('code', 'request_id_reused');
    // A request id no start ever carried is the honest miss: that start never reached the daemon.
    should(neverSent.status).equal(404);
  });

  /**
   * A damaged callsign ledger must NOT leak its absolute path, and must read as the unavailable
   * condition it is rather than a launch defect.
   *
   * The reservation file is the only proof an in-flight start owns its name, so the store fails closed
   * over a damaged one. That refusal used to surface as `500 session_launch_failed` carrying the
   * adapter's verbatim error — ledger path and all — in the body. It is now a stable `503
   * callsign_unavailable` with a fixed, path-free message: the caller may retry once the store is
   * mended, and no agent on the host learns where the daemon keeps its state.
   */
  it('should answer a path-free 503 for a start over a damaged callsign ledger', async () => {
    // Arrange
    const home = await tempDirectory('fyd-callsign-damaged');
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
    await seedFleet(home);
    const exit = start(world, cleanups);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined)) !== undefined) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' };
    // Corrupt the reservation ledger AFTER boot: a missing file is an empty ledger, so the damage must
    // be real bytes the decoder refuses.
    const ledger = join(home, 'state', 'callsigns.json');
    await mkdir(join(home, 'state'), { recursive: true });
    const damaged = 'not json at all';
    await writeFile(ledger, damaged, { mode: 0o600 });

    // Act — a start that asks for a callsign must claim it before launch, and the claim reads this file.
    const refused = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'x-fy-request-id': 'req-callsign-1' },
      body: JSON.stringify({ agent: WRAPPER, mode: 'auto', prompt: 'claim a name', teammate: 'atlas', cwd: home }),
    });
    const body = (await refused.json()) as { code: string; error: string };
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    should(refused.status).equal(503);
    should(body.code).equal('callsign_unavailable');
    // The message is the allocator's fixed, path-free string; the whole body omits the temp home the
    // ledger path would have exposed.
    should(body.error).equal('callsign persistence failed');
    should(JSON.stringify(body)).not.containEql(home);
    // Nothing launched — the start failed at the claim, before the pane.
    should(launcher.launched).have.length(0);
    // And the damaged evidence is left untouched for diagnosis.
    should(await readFile(ledger, 'utf8')).equal(damaged);
  });

  /**
   * `fy start --board-access worker`, driven end to end through the production composition root.
   *
   * The start refused this with `501` on the belief that it "would launch a pane holding a capability
   * that authorizes nothing until a third party acts". It hands the pane no capability at all: a child
   * grant is a PENDING INTENT by construction, so the state the refusal was avoiding is the only state
   * the domain can produce, and refusing it meant the flag could not be used.
   *
   * This proves the grant DOES ITS JOB rather than merely being reachable: a real board is created over
   * two real sessions, the creator's capability is read from the file the daemon actually delivered it
   * to, and the intent the start produced is read back out of `task-boards.json` on disk.
   *
   * It also pins the ORDERING, which is the part a unit test cannot see. The grant is requested after
   * the session record exists — the board's directory reads the session's own documents — and before
   * the launch, so a refusal costs no agent: the refused start's session is `stopped` and the launcher
   * never saw it.
   */
  it('should request a child grant for a start that asked for board access', async () => {
    // Arrange
    const home = await tempDirectory('fyd-board-access-start');
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
    await seedFleet(home);
    const exit = start(world, cleanups);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined)) !== undefined) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' };
    const sessions = `http://127.0.0.1:${port}/v1/sessions`;
    const startSession = async (
      requestId: string,
      fields: Readonly<Record<string, unknown>>,
      extra: Readonly<Record<string, string>> = {},
    ): Promise<Response> =>
      await fetch(sessions, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', 'x-fy-request-id': requestId, ...extra },
        body: JSON.stringify({ agent: WRAPPER, cwd: home, prompt: 'work the board', ...fields }),
      });

    // Act
    // The membership ROOT: live, interactive and top-level, which is the only shape the domain lets
    // request a child grant.
    const root = SessionViewSchema.parse(await (await startSession('req-board-root', { mode: 'interactive' })).json());
    const coordinator = SessionViewSchema.parse(
      await (await startSession('req-board-coordinator', { mode: 'auto', parent: root.config.id })).json(),
    );
    // The operator's capability is minted LAZILY, on the first request that has to check one — the
    // same shape as the API token, which the first authenticated request mints. So this is the
    // operator's real first move: try, be refused, then read what `fyd` issued.
    const createBoard = async (adminCapability: string): Promise<Response> =>
      await fetch(`http://127.0.0.1:${port}/v1/task-boards/create`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', 'x-fy-board-admin-capability': adminCapability },
        body: JSON.stringify({ creatorSessionId: root.config.id, coordinatorSessionId: coordinator.config.id }),
      });
    const beforeMint = await createBoard('not-the-operator');
    const adminCapability = (await readFile(join(home, 'board-admin-capability'), 'utf8')).trim();
    const created = await createBoard(adminCapability);
    // The root's own board capability, read from the file the daemon delivered it to rather than from
    // the response — the response never carries one, which is the point of the environment channel.
    const rootEnvironment = JSON.parse(
      await readFile(join(home, 'state', 'sessions', root.config.id, 'environment.json'), 'utf8'),
    ) as Readonly<Record<string, string>>;
    const rootCapability = rootEnvironment.FY_BOARD_CAPABILITY ?? '';
    const launchesBeforeRefusals = launcher.launched.length;
    // The start under test.
    const granted = await startSession(
      'req-board-child',
      { mode: 'auto', parent: root.config.id, boardAccess: 'worker' },
      { 'x-fy-board-capability': rootCapability },
    );
    const grantedBody = SessionViewSchema.parse(await granted.json());
    const boardDocument = JSON.parse(await readFile(join(home, 'task-boards.json'), 'utf8')) as {
      readonly boards: ReadonlyArray<{
        readonly childGrantIntents: ReadonlyArray<{
          readonly targetSessionId: string;
          readonly requestedRole: string;
          readonly status: string;
        }>;
      }>;
    };
    // No capability at all, and a capability that names no membership: the two refusals a caller can
    // actually produce.
    const noCapability = await startSession('req-board-bare', {
      mode: 'auto',
      parent: root.config.id,
      boardAccess: 'worker',
    });
    const refused = await startSession(
      'req-board-stranger',
      { mode: 'auto', parent: root.config.id, boardAccess: 'worker' },
      { 'x-fy-board-capability': 'not-anybody-s-capability' },
    );
    const listed = SessionListSchema.parse(await (await fetch(sessions, { headers })).json());
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    should(beforeMint.status).equal(403);
    should(created.status).equal(201);
    should(rootCapability).not.be.empty();
    // The start was SERVED, where it used to answer 501.
    should(granted.status).equal(201);
    // And the document it wrote records what the caller asked for. Recording `none` here would make
    // every surface reading this session disagree with the intent the board is holding for it.
    should(grantedBody.config.boardAccess).equal('worker');
    // The intent is real, durable and PENDING — which is the only status the request reducer produces,
    // for any requester, coordinator included.
    should(
      boardDocument.boards
        .flatMap(board => board.childGrantIntents)
        .map(intent => [intent.targetSessionId, intent.requestedRole, intent.status]),
    ).deepEqual([[grantedBody.config.id, 'worker', 'pending']]);
    // A missing secret is reported the way the eight board routes report one.
    should(noCapability.status).equal(401);
    should((await noCapability.json()) as { code: string }).have.property('code', 'missing_capability');
    // A capability naming no membership is the board's own refusal, in the board's own vocabulary
    // rather than flattened into `session_launch_failed`.
    should(refused.status).equal(403);
    should((await refused.json()) as { code: string }).have.property('code', 'forbidden');
    // NEITHER refusal cost an agent: the grant is requested before the launch, so the only session the
    // two refusals left behind is the stranger's, and it is stopped rather than running.
    should(launcher.launched).have.length(launchesBeforeRefusals + 1);
    const refusedSessions = listed.filter(session => session.config.boardAccess === 'worker');
    should(refusedSessions.map(session => session.state.status).sort()).deepEqual(['running', 'stopped']);
    should(refusedSessions.find(session => session.state.status === 'stopped')?.state.reason).containEql(
      'board access refused',
    );
  });

  /**
   * The files an opening message attached, driven through the production composition root.
   *
   * `initialAttachments` was refused with `501` for four units on the belief that attachments need a
   * multipart route the daemon does not have. They do not: the bytes are INLINE in this very start
   * body, and the only place they are spent is the turn-one document the same start writes. This
   * proves the extractor DOES ITS JOB rather than merely being reachable — the DOCX is a real OOXML
   * archive, the text comes out of `word/document.xml` through the production inflater, and the
   * agent is pointed at both files by absolute path.
   */
  it('should store the files an opening message attached and name them in turn one', async () => {
    // Arrange
    const home = await tempDirectory('fyd-session-attachments');
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
    await seedFleet(home);
    const exit = start(world, cleanups);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined)) !== undefined) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' };
    const sessions = `http://127.0.0.1:${port}/v1/sessions`;
    const post = async (requestId: string, body: Readonly<Record<string, unknown>>): Promise<Response> =>
      await fetch(sessions, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', 'x-fy-request-id': requestId },
        body: JSON.stringify(body),
      });

    // Act
    const started = await post('req-attach-1', {
      agent: WRAPPER,
      mode: 'auto',
      prompt: 'summarize the attached brief',
      cwd: home,
      initialAttachments: [
        { filename: 'brief.docx', base64: Buffer.from(docxBytes('the brief in a real docx')).toString('base64') },
        { filename: 'diagram.png', mime: 'image/png', base64: Buffer.from([1, 2, 3]).toString('base64') },
      ],
    });
    const startedBody = SessionViewSchema.parse(await started.json());
    const directory = join(home, 'state', 'sessions', startedBody.config.id);
    const turnOne = await readFile(join(directory, 'turns', 'turn-001.md'), 'utf8');
    const extracted = await readFile(join(directory, 'attachments', 'brief.docx.txt'), 'utf8');
    const storedFiles = (await readdir(join(directory, 'attachments'))).sort();
    // A file with nothing to attach it to: the CLI refuses the same combination on `fy send`.
    const bare = await post('req-attach-2', {
      agent: WRAPPER,
      mode: 'interactive',
      cwd: home,
      initialAttachments: [{ filename: 'brief.docx', base64: 'QUJD' }],
    });
    // A filename that names no file is the caller's mistake, named as one rather than turned into a
    // directory the attachment would be written outside of.
    const unnamed = await post('req-attach-3', {
      agent: WRAPPER,
      mode: 'auto',
      prompt: 'summarize this',
      cwd: home,
      initialAttachments: [{ filename: '..', base64: 'QUJD' }],
    });
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    should(started.status).equal(201);
    // The opening message the agent is handed names both files, and the extracted text beside one.
    should(turnOne).containEql('summarize the attached brief');
    should(turnOne).containEql(join(directory, 'attachments', 'brief.docx'));
    should(turnOne).containEql(join(directory, 'attachments', 'diagram.png'));
    should(turnOne).containEql(`extracted text: ${join(directory, 'attachments', 'brief.docx.txt')}`);
    // And the words really came out of the archive: this is the capability the four allowlist lines
    // were holding, proved end to end rather than asserted.
    should(extracted).equal('the brief in a real docx');
    should(storedFiles).deepEqual(['brief.docx', 'brief.docx.txt', 'diagram.png']);
    // The agent was pointed at the turn document, which is what carries the paths.
    should(launcher.delivered[0]).containEql('turns/turn-001.md');
    should(bare.status).equal(400);
    should((await bare.json()) as { code: string }).have.property('code', 'invalid_request');
    should(unnamed.status).equal(400);
    should((await unnamed.json()) as { code: string }).have.property('code', 'invalid_request');
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
   * Migrating a session onto another account, driven through the production composition root.
   *
   * This proves the destructive-migration SAFETY GATE does its job rather than merely being
   * constructed: `MigrationPreflight` was built, tested and assigned to a world field that nothing
   * ever called, so `POST /v1/sessions/:id/migrate` — a route the protocol client has always spoken —
   * answered `unknown_route`, and the one gate in the product that refuses to destroy work guarded an
   * operation the product could not perform.
   *
   * THE GATE ITSELF IS REAL HERE. Only its two host probes are doubled — the process-table walk and
   * the pane capture, which cannot be driven without running the very work they inspect — so the
   * verdicts, the blind-spot rules, the refusal, the report and the handoff are production's.
   *
   * The order of the four calls is the argument:
   *
   *   * A SMALLER CONTEXT WINDOW is refused before anything is inspected, because a migration that
   *     truncates the conversation it exists to preserve is not one the caller asked for.
   *   * A DESTRUCTIVE process in the pane is refused with the inventory in the message, and nothing
   *     is written: no report, and a configuration document still naming the account it started on.
   *   * A CLEAN pane migrates: the document is restamped, the LIVE pane is replaced rather than typed
   *     into, and the replacement agent is handed a turn document pointing at the report.
   *   * AN AGENT THE FLEET DOES NOT PUBLISH is a 404 about the agent, not about the session.
   */
  it('should refuse an unsafe migration and move a session the gate clears', async () => {
    // Arrange
    const home = await tempDirectory('fyd-session-migrate');
    const port = await freeLoopbackPort();
    const cleanups: Array<() => void | Promise<void>> = [];
    const launcher = new RecordingSessionLauncher();
    const reviver = new RecordingResumeLauncher();
    const inventory = new StubProcessInventory();
    let release = (): void => {};
    const world = {
      ...(await worldAt(home, port, async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      })),
      sessionLauncher: launcher,
      createResumeLauncher: () => reviver,
      // The REAL gate over doubled host probes: everything it decides is production's.
      migratePreflight: new MigrationPreflight(inventory, { visible: async () => undefined }),
    };
    await seedMigrationFleet(home);
    const exit = start(world, cleanups);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined)) !== undefined) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const cli = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-ferretry-client': 'cli' };
    const sessions = `http://127.0.0.1:${port}/v1/sessions`;
    const startResponse = await fetch(sessions, {
      method: 'POST',
      headers: { ...cli, 'x-fy-request-id': 'req-migrate-1' },
      body: JSON.stringify({ agent: WRAPPER, mode: 'auto', prompt: 'wire the migration', cwd: home }),
    });
    // Answered rather than cast, so a start that failed fails HERE with the daemon's own reason
    // instead of surfacing as an unrelated assertion about a session that was never created.
    const startedRaw: unknown = await startResponse.json();
    if (startResponse.status !== 201) throw new Error(`the fixture start failed: ${JSON.stringify(startedRaw)}`);
    const started = SessionViewSchema.parse(startedRaw);
    const id = started.config.id;
    const configFile = join(home, 'state', 'sessions', id, 'config.json');
    const reportFile = join(home, 'state', 'sessions', id, 'migration-inflight.md');
    // Each ask carries its OWN request id, because each is a different question put to a world that
    // has changed since the last one. Reusing an id is how the route recognises a retried POST, and a
    // retry is exactly what these are not.
    const migrate = async (body: unknown, requestId: string): Promise<Response> =>
      await fetch(`${sessions}/${id}/migrate`, {
        method: 'POST',
        headers: { ...cli, 'x-fy-request-id': requestId },
        body: JSON.stringify(body),
      });
    const storedConfig = async (): Promise<Record<string, unknown>> =>
      JSON.parse(await readFile(configFile, 'utf8')) as Record<string, unknown>;

    // Act
    // The pane is alive and at a prompt throughout: a migration must replace it anyway.
    reviver.pane = { alive: true, dead: false, promptReady: true };
    // The session is `running` and its pane holds nothing: an agent mid-turn is work this gate will
    // not interrupt, and it says so rather than moving a session out from under a thinking agent.
    const midTurn = await migrate({ agent: TARGET_WRAPPER, allowContextDowngrade: true }, 'req-migrate-ask-1');
    const midTurnBody = (await midTurn.json()) as { error: string; code: string };
    const afterMidTurn = await storedConfig();
    // The account runs out of quota. Nothing mounted produces this status — the quota reader that
    // would is not mounted — so the state document is seeded directly, which is the whole reason a
    // migration exists: an operator moves a rate-limited session onto an account with headroom.
    const stateFile = join(home, 'state', 'sessions', id, 'state.json');
    await writeFile(
      stateFile,
      JSON.stringify({ ...(JSON.parse(await readFile(stateFile, 'utf8')) as object), status: 'rate_limited' }),
      { mode: 0o600 },
    );
    // The target serves a 200k window and this session was started on a 1M model.
    const downgrade = await migrate({ agent: TARGET_WRAPPER }, 'req-migrate-ask-2');
    const afterDowngrade = await storedConfig();
    // A destructive command in the pane, which the gate must refuse to interrupt.
    inventory.observation = {
      kind: 'observed',
      processes: [{ pid: 4242, argv: 'git push origin main', verdict: 'destructive_to_interrupt' }],
    };
    const refused = await migrate({ agent: TARGET_WRAPPER, allowContextDowngrade: true }, 'req-migrate-ask-3');
    const refusedBody = (await refused.json()) as { error: string; code: string };
    const afterRefusal = await storedConfig();
    const reportAfterRefusal = await readFile(reportFile, 'utf8').catch(() => undefined);
    // The command finished; nothing is in flight.
    inventory.observation = { kind: 'observed', processes: [] };
    // THE SESSION HAS A TOOL OPEN, AND ITS TRANSCRIPT SAYS WHAT IT IS. Before a session recorded its
    // transcript this joined to nothing and the open id was classified `unknown`, which this gate
    // refuses on — so seeding an open tool here would have made the migration below impossible. The
    // provenance record names a real file, the file says the tool is a `Read`, and a `Read` is
    // `safe_to_kill`. That is `world.transcripts` deciding the outcome of a mounted operation.
    const harnessHome = join(home, 'harness');
    const transcriptFile = join(harnessHome, 'projects', 'seeded', 'session.jsonl');
    await mkdir(join(harnessHome, 'projects', 'seeded'), { recursive: true });
    await writeFile(
      transcriptFile,
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'record-open-tool',
        timestamp: '2026-07-31T23:00:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-open-1', name: 'Read', input: { file_path: '/work/open.ts' } }],
        },
      })}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      configFile,
      JSON.stringify({
        ...(await storedConfig()),
        transcript: {
          v: 1,
          home: harnessHome,
          harnessSessionId: 'seeded-harness-session',
          identity: 'minted',
          file: transcriptFile,
          resolvedAt: '2026-07-31T22:00:00.000Z',
        },
      }),
      { mode: 0o600 },
    );
    await writeFile(
      stateFile,
      JSON.stringify({ ...(JSON.parse(await readFile(stateFile, 'utf8')) as object), openTools: ['tool-open-1'] }),
      { mode: 0o600 },
    );
    const moved = await migrate({ agent: TARGET_WRAPPER, allowContextDowngrade: true }, 'req-migrate-ask-4');
    const movedRaw: unknown = await moved.json();
    // Same reason: a refused migration must fail with the refusal it answered, not with a schema
    // complaint about an error envelope.
    if (moved.status !== 200) throw new Error(`the cleared migration was refused: ${JSON.stringify(movedRaw)}`);
    const movedBody = SessionViewSchema.parse(movedRaw);
    const afterMove = await storedConfig();
    const report = await readFile(reportFile, 'utf8');
    const turnTwo = await readFile(join(home, 'state', 'sessions', id, 'turns', 'turn-002.md'), 'utf8');
    // The replacement runs out of quota too. Seeded the same way and for the same reason: a migrated
    // session comes back `running`, and an agent mid-turn is not one this gate interrupts. The open
    // tool goes with it: the pane was REPLACED, so the previous harness's tool ids are stale.
    await writeFile(
      stateFile,
      JSON.stringify({
        ...(JSON.parse(await readFile(stateFile, 'utf8')) as object),
        status: 'rate_limited',
        openTools: [],
      }),
      { mode: 0o600 },
    );
    // Straight back again, which is the case that used to destroy work: the turn a revive hands over
    // is recorded on the STATE document, and reading the configuration's frozen copy first made every
    // second relaunch write `turn-002.md` a second time — over an assignment the agent may not have
    // read yet.
    const movedBack = await migrate({ agent: WRAPPER }, 'req-migrate-back');
    const turnsAfterSecond = (await readdir(join(home, 'state', 'sessions', id, 'turns'))).sort();
    const secondReport = await readFile(reportFile, 'utf8');
    const unknownAgent = await migrate(
      { agent: 'claude-auto-nowhere', allowContextDowngrade: true },
      'req-migrate-unknown',
    );
    const absent = await fetch(`${sessions}/no-such-session/migrate`, {
      method: 'POST',
      headers: { ...cli, 'x-fy-request-id': 'req-migrate-absent' },
      body: JSON.stringify({ agent: TARGET_WRAPPER }),
    });
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    // An agent that is mid-turn is not migrated out from under itself, and the refusal names why:
    // the record claims work the inspection could not see, which is a blind spot, not an all-clear.
    should(midTurn.status).equal(409);
    should(midTurnBody.code).equal('migration_refused');
    should(midTurnBody.error).containEql('reports running work but nothing was observable');
    should(afterMidTurn).have.property('agent', WRAPPER);
    // A smaller window is refused BEFORE the pane is even looked at, and nothing moved.
    should(downgrade.status).equal(409);
    should((await downgrade.json()) as { code: string }).have.property('code', 'context_downgrade_refused');
    should(afterDowngrade).have.property('agent', WRAPPER);
    // The refusal carries the inventory that produced it: a bare 409 would leave the operator with
    // no way to tell "a push is running" from "we could not look".
    should(refused.status).equal(409);
    should(refusedBody.code).equal('migration_refused');
    should(refusedBody.error).containEql('git push origin main');
    should(refusedBody.error).containEql('DESTRUCTIVE');
    // NOTHING was written by the refusal — not the document, and not even the report.
    should(afterRefusal).have.property('agent', WRAPPER);
    should(reportAfterRefusal).be.undefined();
    // The clean migration moved the session: same id, same directory, new account.
    should(moved.status).equal(200);
    should(movedBody.config.id).equal(id);
    should(movedBody.config.agent).equal(TARGET_WRAPPER);
    should(movedBody.config.harness).equal('codex');
    // The argv the NEXT relaunch will run is the target's executable, not the account it left.
    should((afterMove.command as readonly string[])[0]).equal(join(home, 'bin', TARGET_WRAPPER));
    // The transcript record went with the account. The target wrapper declares no harness home, so
    // the honest answer is NO transcript — never the departed account's file under a codex parser.
    should(afterMove).not.have.property('transcript');
    // The stamp analytics reads to call a session migrated, with both ends of the move in it.
    should(afterMove.migration).have.properties({ from: WRAPPER, to: TARGET_WRAPPER });
    // A new incarnation, because a different program is answering the next turn.
    should(afterMove).have.property('runtimeGeneration', 2);
    should(afterMove).have.property('incarnation', `${id}-2`);
    // THE LIVE PANE WAS REPLACED, not typed into — for BOTH moves. Without that the old account
    // would still be serving the session while its own record named the new one.
    should(reviver.snapshots).deepEqual([id, id]);
    should(reviver.relaunched).deepEqual([id, id]);
    // The replacement agent is pointed at the report, through the same turn document a revive writes.
    should(reviver.delivered[0]).containEql('turns/turn-002.md');
    should(turnTwo).containEql('migration-inflight.md');
    // Both halves of the report: the inventory written before the pane died, and the outcome that is
    // the only part allowed to claim the move happened.
    should(report).containEql('# Migration in-flight report');
    // The open tool was NAMED, from the session's own transcript. Without provenance this line reads
    // `? … (command not found in chat tail)` and the migration above is refused instead of run.
    should(report).containEql('Read');
    should(report).containEql('/work/open.ts');
    should(report).not.containEql('command not found in chat tail');
    should(report).containEql('## Outcome — MIGRATION SUCCEEDED');
    should(report).containEql(`onto \`${TARGET_WRAPPER}\``);
    // The way back needs no downgrade flag — the origin's window is the larger one — and it writes a
    // THIRD turn document beside the other two rather than overwriting the second.
    should(movedBack.status).equal(200);
    should(turnsAfterSecond).deepEqual(['turn-001.md', 'turn-002.md', 'turn-003.md']);
    // ONE report per session, replaced rather than appended to: the handoff message can only name one
    // file, and this one describes the move that just happened.
    should(secondReport.split('# Migration in-flight report')).have.length(2);
    should(secondReport).containEql(`onto \`${WRAPPER}\``);
    // An agent the fleet does not publish is a fact about the agent, not about the session.
    should(unknownAgent.status).equal(404);
    should((await unknownAgent.json()) as { code: string }).have.property('code', 'unknown_agent');
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
  /**
   * The human browser-login window, driven through the production composition root over a real socket.
   *
   * The read half runs against the PRODUCTION window — the one `buildWorld` builds, over the real
   * `BrowserProfileStore` in the real state home — because asking a closed window for its status
   * spawns nothing. That alone is what `fy browser login` and the PWA's banner have been unable to do
   * since they were ported: the route answered `unknown_route`.
   *
   * The write half swaps the runtime beneath the same production window, because a `start` genuinely
   * launches an X server, a Chrome and a VNC listener, and a test suite must never put those on the
   * host. Everything else stays real, so what this proves is the job rather than the construction:
   * the profile is leased inside the state home, the argv Chrome would have been launched with is the
   * domain's own, and the human's "I signed in" is written to a primed marker a LATER read reports.
   */
  it('should serve, open and prime the human login window through the mounted subsystem', async () => {
    // Arrange
    const home = await tempDirectory('fyd-browser-login');
    const port = await freeLoopbackPort();
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    const base = await worldAt(home, port, async () => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
    });
    // The production status read, before anything is substituted: proof the route the boot mounts is
    // answered by the real profile store over this home.
    const production = await base.browserLogin.window.status();
    const runtime = new RecordingLoginRuntime();
    const world = {
      ...base,
      browserLogin: {
        window: new BrowserLoginWindowService({ profile: new BrowserProfileStore(home), runtime }),
        close: async () => undefined,
      },
    };
    const exit = start(world, cleanups);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined)) !== undefined) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' };
    const json = { ...headers, 'content-type': 'application/json' };
    const url = `http://127.0.0.1:${port}/v1/browser/login`;
    const act = (body: unknown) => fetch(url, { method: 'POST', headers: json, body: JSON.stringify(body) });

    // Act
    const closed = await fetch(url, { headers });
    const closedBody = BrowserLoginStatusSchema.parse(await closed.json());
    const opened = await act({ action: 'start', minutes: 20 });
    const openedBody = BrowserLoginStatusSchema.parse(await opened.json());
    const whileOpen = BrowserLoginStatusSchema.parse(await (await fetch(url, { headers })).json());
    const tooLong = await act({ action: 'start', minutes: 600 });
    const stopped = await act({ action: 'stop', primed: true });
    const stoppedBody = BrowserLoginStatusSchema.parse(await stopped.json());
    const afterPrime = BrowserLoginStatusSchema.parse(await (await fetch(url, { headers })).json());
    const confirmWithNoWindow = await act({ action: 'confirm' });
    // The per-session browser surface: a shipped command told what is missing rather than a 404.
    const automation = await fetch(`http://127.0.0.1:${port}/v1/sessions/${SESSION_ID}/browser`, { headers });
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    // The production window, over the real profile store: nothing has ever been signed in here.
    should(production).deepEqual({ state: 'closed', profilePrimed: false });
    should(closed.status).equal(200);
    should(closedBody).deepEqual({ state: 'closed', profilePrimed: false });
    // A window a person can actually connect to: loopback only, with the tunnel they must open.
    should(opened.status).equal(200);
    should(openedBody.state).equal('open');
    should(openedBody.state === 'open' ? openedBody.connection : undefined).deepEqual({
      host: '127.0.0.1',
      port: 5_912,
      password: openedBody.state === 'open' ? openedBody.connection.password : '',
      sshTunnel: 'ssh -N -L 5912:127.0.0.1:5912 operator@boot-host',
    });
    // The minutes the caller asked for are the minutes the window expires after.
    should(openedBody.state === 'open' ? Date.parse(openedBody.expiresAt) - Date.parse(openedBody.openedAt) : 0).equal(
      20 * 60_000,
    );
    // A second read sees the SAME window rather than opening another: the subsystem is one instance
    // the boot constructed, not one per request.
    should(whileOpen).deepEqual(openedBody);
    // Chrome was launched into the daemon's own private profile, on the display the runtime owns, with
    // the sign-in page the domain names.
    should(runtime.spawned[0]?.[0]).equal('/usr/bin/google-chrome');
    should(runtime.spawned[0]).containEql(`--user-data-dir=${join(home, 'browser', 'profile')}`);
    should(runtime.spawned[0]).containEql('https://accounts.google.com/');
    // The VNC server is supervised by `timeout` for exactly the window's own duration.
    should(runtime.spawned[1]?.slice(0, 4)).deepEqual(['/usr/bin/timeout', '--signal=TERM', '--kill-after=10', '1200']);
    // A duration the contract refuses never reaches the host.
    should(tooLong.status).equal(400);
    should(stopped.status).equal(200);
    should(stoppedBody).deepEqual({ state: 'closed', profilePrimed: true });
    // The human's verdict is DURABLE, not in memory: a later read over the real state home reports it,
    // and the marker is a file inside the daemon's own browser directory.
    should(afterPrime).deepEqual({ state: 'closed', profilePrimed: true });
    should(await readdir(join(home, 'browser'))).containEql('profile.primed.json');
    // Both processes were released when the window closed, VNC before Chrome.
    should(runtime.terminated).deepEqual(['vnc', 'chrome']);
    // Confirming a window that is not open is a statement about the WINDOW, not about the request, so
    // it travels as the domain classified it: this daemon has no window to confirm.
    should(confirmWithNoWindow.status).equal(503);
    should((await confirmWithNoWindow.json()) as { error: string }).have.property(
      'error',
      'the human browser login window is not open',
    );
    should(automation.status).equal(501);
  });

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
    // The warden sweep timer IS armed now, and the report says so rather than making a running
    // supervisor look absent — the distinction this flag exists to draw.
    should(view.wardenTimerArmed).be.true();
    // Not asserted precisely: arming fires a boot sweep that is deliberately NOT awaited, so whether
    // it has completed by the time this request lands is a race. Either answer is correct — `null`
    // means "no sweep has finished yet", a number means one has — and the assertion is that it is one
    // of exactly those two rather than a fabricated zero.
    should(view.wardenLastSweepSeconds === null || view.wardenLastSweepSeconds >= 0).be.true();
    // Scratch GC IS mounted now. Enabled means the collector runs, not that it deletes: the policy
    // refuses anything that is not a daemon-owned entry, not terminal, or under the TTL, and refuses
    // outright when there is no finishedAt and no mtime to age from.
    should(view.scratchGcEnabled).be.true();
    // Liveness stays public and unchanged, so nothing that probes for it needs a token.
    should(liveness.status).equal(200);
    should((await liveness.json()) as { status: string }).have.property('status', 'ok');
    // The report answers a caller holding no credential and reports the SAME daemon, which is what
    // lets `fy daemon status` work on a host where no token has been minted yet.
    should(anonymous.status).equal(200);
    should(HealthViewSchema.parse(await anonymous.json()).pid).equal(view.pid);
  });

  /**
   * Dictation, driven through the production composition root over a real socket.
   *
   * The subsystem was CONSTRUCTED by the composition root and called by nothing for five wiring
   * units: `fy stt status`, `models`, `install`, `transcribe` and `enhance` are shipped commands
   * whose gateway spoke these exact paths to a daemon that answered `unknown_route`.
   *
   * The SURFACE is substituted and everything else is real — the boot, the credentials, the raw
   * route table, the dispatcher and the transport. It has to be: the production one spawns a Whisper
   * worker that loads a multi-gigabyte model, and a test suite must never put that on the host. What
   * is proved here is therefore the wiring the fake cannot fake — that a request reaches the surface
   * at all, that the BYTES arrive unmangled, that the token is demanded, and that shutdown releases
   * the worker.
   */
  it('should reach the dictation surface with its bytes intact and release it on shutdown', async () => {
    // Arrange
    const home = await tempDirectory('fyd-stt');
    const port = await freeLoopbackPort();
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    const base = await worldAt(home, port, async () => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
    });
    const surface = new RecordingSttSurface();
    const exit = start({ ...base, stt: surface }, cleanups);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined)) !== undefined) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' };
    // A NUL and a lone 0xFF: neither survives a round trip through a string body, so decoding these
    // back out is what proves the request reached the surface over the RAW seam rather than through
    // `ApiRequest.text()`.
    const audio = new Uint8Array([0x00, 0xff, 0x10, 0x00]);

    // Act
    const status = await fetch(`http://127.0.0.1:${port}/v1/stt/status`, { headers });
    const anonymous = await fetch(`http://127.0.0.1:${port}/v1/stt/status`);
    const transcribed = await fetch(`http://127.0.0.1:${port}/v1/stt/transcribe`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'audio/L16; rate=16000; channels=1' },
      body: audio,
    });
    // The public model-file prefix is deliberately NOT mounted: it exists to hand a browser the
    // weights and nothing in this repository mints such a URL yet. It must fall through to the HTTP
    // table rather than be served by a raw route nobody asked for.
    const publicFile = await fetch(`http://127.0.0.1:${port}/stt-models/base.en/model.bin`, { headers });
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    // Reached: an unmounted surface answers `unknown_route`, not the surface's own body.
    should(status.status).equal(200);
    should((await status.json()) as { available: boolean }).have.property('available', false);
    // The daemon version travels on a response the surface built for itself, like every other.
    should(status.headers.get('x-ferretry-version')).equal(daemonVersion);
    // The raw table is behind the SAME authorization boundary as the rest of the surface.
    should(anonymous.status).equal(401);
    should(transcribed.status).equal(200);
    should((await transcribed.json()) as { bytes: number[] }).have.property('bytes', [0, 255, 16, 0]);
    should(surface.seen).deepEqual(['GET /v1/stt/status', 'POST /v1/stt/transcribe']);
    should(publicFile.status).equal(404);
    should((await publicFile.json()) as { code: string }).have.property('code', 'unknown_route');
    // The worker is released with the rest of the host acquisitions: a daemon that exited holding it
    // would leave a process with a multi-gigabyte model loaded and nothing left to reap it.
    should(surface.closed).equal(1);
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
