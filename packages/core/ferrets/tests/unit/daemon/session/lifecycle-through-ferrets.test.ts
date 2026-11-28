import { afterEach, describe, expect, test } from 'bun:test';
import { factsOfKey } from '../../../support/daemon/harness-facts.ts';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { RootHandle, RootsPort } from '@ferretry/kernel/contract';
import { diskPaths, diskSessionsRoot } from '@ferretry/kernel/testing';
import { err, ok } from '@ferretry/std';
import {
  type ConversationId,
  ConversationIdSchema,
  type ConversationLeaseDisk,
  ConversationLeaseStore,
  type HistoryHarness,
} from '../../../../contract/conversation-lease.ts';
import type { FerretRecord, RunnerHandle } from '../../../../contract/index.ts';
import {
  emptyChildEnvironment,
  FakeHarness,
  FakeRunner,
  fenced,
  ferretId,
  T0,
} from '../../../../contract/testing/index.ts';
import {
  ConversationLeases,
  registryLeaseSessions,
} from '../../../../daemon/lib/session/lifecycle/conversation-leases.ts';
import { heldLifecycleLauncher } from '../../../../daemon/adapters/session/lifecycle/ferret-session-lifecycle-launcher.ts';
import { FerretsService } from '../../../../daemon/lib/ferrets/service.ts';
import { FerretRegistry } from '../../../../daemon/lib/registry/registry.ts';
import { parseSessionId } from '../../../../daemon/lib/session-id.ts';
import type { SessionConversationLeases } from '../../../../daemon/lib/session/peers/conversation-lease.ts';
import { FerretTokenDirectory } from '../../../../daemon/lib/tokens/tokens.ts';
import { SessionFiles } from '../../../../daemon/modules/session-files.ts';
import { memoryStorage, sessionEnvelope } from '../../../support/daemon/storage.ts';

/**
 * A lifecycle start of a ferret the registry holds opens its pane through Ferrets' own launch (one launch path), types
 * its first turn through the runner on the handle the registry then holds, and stops through Ferrets' own stop. The
 * lifecycle holds the ferret's key on the shared queue for the whole of it, so a launch or stop that took the key again
 * would never return. Fakes and temp folders only.
 */

const NOW = '2026-11-08T10:00:00.000Z';
const FERRET = parseSessionId('mw7bp88g-50e00159');
const parents: string[] = [];

afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

/** Records every claim and release the lifecycle makes. */
class RecordingLeases implements SessionConversationLeases {
  readonly calls: string[] = [];
  claimError: Error | undefined;
  async claim(sessionId: string, command: readonly string[]): Promise<void> {
    this.calls.push(`claim ${sessionId} ${command.join(' ')}`);
    if (this.claimError !== undefined) throw this.claimError;
  }
  async moveToPane(sessionId: string, _command: readonly string[], pid: number): Promise<void> {
    this.calls.push(`move ${sessionId} ${pid}`);
  }
  async release(sessionId: string): Promise<void> {
    this.calls.push(`release ${sessionId}`);
  }
}

async function wired(
  options: {
    readonly leases?: SessionConversationLeases;
    readonly record?: Partial<FerretRecord>;
    readonly command?: readonly string[];
    /** The daemon's REAL leases over this pool, instead of `leases`. */
    readonly pool?: MemoryPool;
  } = {},
) {
  const parent = await mkdtemp(`${tmpdir()}/fy-lifecycle-through-ferrets-`);
  parents.push(parent);
  await mkdir(`${parent}/work`);
  const sessions = await diskSessionsRoot(parent, FERRET);
  const roots: Pick<RootsPort, 'root'> = { root: (): RootHandle => sessions.root };
  const { storage } = await memoryStorage({ clock: { now: () => NOW } });
  const record: FerretRecord = {
    format: 1,
    id: ferretId(FERRET),
    name: 'child',
    role: 'lead',
    harness: 'claude-code',
    runner: 'tmux',
    folder: `${parent}/work`,
    state: 'stopped',
    birth: 'person',
    createdAt: T0,
    ...options.record,
    stateAt: T0,
  };
  const registry = new FerretRegistry([record]);
  const tokens = new FerretTokenDirectory();
  const runner = new FakeRunner();
  const harness = new FakeHarness();
  // Built after the files (the files take the launcher, the launcher takes the service): every call is made later.
  let service: FerretsService | undefined;
  const live = (): FerretsService => {
    if (service === undefined) throw new Error('the service is built');
    return service;
  };
  const files = new SessionFiles({
    roots,
    storage,
    clock: { now: () => NOW },
    sleep: async () => undefined,
    paths: diskPaths(),
    fleet: () => registry.list().map(ferret => ({ id: ferret.id })),
    seed: id => {
      const held = registry.get(ferretId(id));
      return held === undefined ? undefined : { record: held, details: registry.detailsOf(held.id) };
    },
    launcher: heldLifecycleLauncher(live, {
      handleOf: ferret => registry.get(ferret)?.handle as RunnerHandle | undefined,
      runner: () => runner,
      sleep: async () => undefined,
      nowMs: () => 0,
    }),
    ...(options.pool !== undefined
      ? { leases: realLeases(options.pool, registry) }
      : options.leases === undefined
        ? {}
        : { leases: options.leases }),
    log: { warn: () => undefined },
  });
  service = new FerretsService(registry, tokens, {
    now: () => T0,
    newId: () => ferretId('never-minted'),
    newName: () => 'never-named',
    save: async () => {},
    saveTokens: async () => {},
    harness: () => harness,
    harnessKeys: () => [harness.key],
    runner: () => runner,
    decide: async () => ({ allow: true }),
    launchParts: () => [],
    sitrepSources: () => [],
    instructions: () => [],
    folder: path => ok(fenced(path)),
    changed: () => {},
    vault: { childEnvironment: async () => ok(emptyChildEnvironment()) },
    asks: { open: async () => [] },
    session: files.port,
    serial: files.serial,
    cutOffMark: files.cutOffMark,
  });
  const lifecycle = files.createLifecycle(FERRET, sessionEnvelope());
  await lifecycle.create({
    agent: options.command?.[0] ?? '/opt/fleet/bin/claude',
    cwd: `${parent}/work`,
    mode: 'auto',
    prompt: 'work',
    ...(options.command === undefined ? {} : { command: options.command }),
  });
  return { files, lifecycle, registry, runner, service, storage };
}

describe('a lifecycle start of a ferret the registry holds', () => {
  test('should open its pane through the service, type the first turn through the runner, and finish running', async () => {
    // Arrange
    const f = await wired();

    // Act
    const started = await f.lifecycle.start(FERRET);

    // Assert
    expect(started.state.status).toBe('running');
    expect(f.runner.starts).toBe(1);
    expect(f.registry.get(ferretId(FERRET))?.state).toBe('working');
    expect(f.runner.deliveries).toHaveLength(1);
    expect(f.runner.deliveries[0]?.handle).toBe(f.registry.get(ferretId(FERRET))?.handle as RunnerHandle);
    expect(f.runner.deliveries[0]?.delivery.text).toContain('turn-001.md');
  });

  test('should stop the pane through the service and record the ferret stopped', async () => {
    // Arrange
    const f = await wired();
    await f.lifecycle.start(FERRET);
    const handle = f.registry.get(ferretId(FERRET))?.handle as RunnerHandle;

    // Act
    const stopped = await f.lifecycle.stop(FERRET);

    // Assert
    expect(stopped.state.status).toBe('stopped');
    expect(f.registry.get(ferretId(FERRET))?.state).toBe('stopped');
    expect(await f.runner.alive(handle)).toBe(false);
  });

  test('should launch nothing for a ferret the owner cut off through the service', async () => {
    // Arrange
    const f = await wired();
    await f.service.revokeToken(ferretId(FERRET));

    // Act
    const starting = f.lifecycle.start(FERRET);

    // Assert — refused ahead, before the record, the credential or a lease is touched, on the one cut-off fact
    await expect(starting).rejects.toThrow('the owner cut off this ferret; a confirmed owner resume is required');
    expect(f.runner.starts).toBe(0);
  });

  test('should claim the conversation the record names through the files’ leases before the pane opens, and free it on stop', async () => {
    // Arrange
    const leases = new RecordingLeases();
    const f = await wired({ leases });

    // Act
    await f.lifecycle.start(FERRET);
    const claimedAt = leases.calls.length;
    await f.lifecycle.stop(FERRET);

    // Assert — one claim for this session, made before the launch, then its move onto the pane's pid, and one release after the stop
    expect(leases.calls[0]?.startsWith(`claim ${FERRET} `)).toBe(true);
    expect(leases.calls[1]).toBe(`move ${FERRET} 1001`);
    expect(claimedAt).toBe(2);
    expect(leases.calls.at(-1)).toBe(`release ${FERRET}`);
  });

  test('should open no pane when the conversation is held, and say who holds it', async () => {
    // Arrange
    const leases = new RecordingLeases();
    leases.claimError = new Error('conversation c is being written by session mw7bp89h-61f11260');
    const f = await wired({ leases });

    // Act
    const starting = f.lifecycle.start(FERRET);

    // Assert
    await expect(starting).rejects.toThrow('being written by session mw7bp89h-61f11260');
    expect(f.runner.starts).toBe(0);
  });

  test.each([{ kind: 'stopped' as const }, { kind: 'completed' as const }])(
    'should never revive a ferret that ended on purpose ($kind), and leave its session and credential as they were',
    async cause => {
      // Arrange
      const leases = new RecordingLeases();
      const f = await wired({ leases, record: { cause } });
      const before = await f.files.environmentStore(FERRET).read(FERRET);

      // Act
      const starting = f.lifecycle.start(FERRET);

      // Assert
      await expect(starting).rejects.toThrow('stopped on purpose or finished its work');
      expect(f.runner.starts).toBe(0);
      expect(f.registry.get(ferretId(FERRET))?.state).toBe('stopped');
      expect(((await f.storage.readState(parseSessionId(FERRET))) as { status: string }).status).toBe('created');
      expect(await f.files.environmentStore(FERRET).read(FERRET)).toEqual(before);
      expect(leases.calls).toEqual([]);
    },
  );

  test('should refuse, before re-issuing the credential, a ferret the registry calls live whose terminal is not visible', async () => {
    // Arrange — recorded `working` with no handle: a launch would answer "already running" and only rotate the hash
    const leases = new RecordingLeases();
    const f = await wired({ leases, record: { state: 'working' } });
    const before = await f.files.environmentStore(FERRET).read(FERRET);

    // Act
    const starting = f.lifecycle.start(FERRET);

    // Assert
    await expect(starting).rejects.toThrow('would open no pane and only re-issue its credential');
    expect(f.runner.starts).toBe(0);
    expect(await f.files.environmentStore(FERRET).read(FERRET)).toEqual(before);
    expect(leases.calls).toEqual([]);
  });

  test('should refuse, and open no pane, for a session whose ferret the registry does not hold', async () => {
    // Arrange — a session document the registry knows nothing about
    const f = await wired();
    const stranger = parseSessionId('mw7bp88g-aaaa0001');
    await f.files.createLifecycle(stranger, sessionEnvelope()).create({
      agent: '/opt/fleet/bin/claude',
      cwd: f.registry.get(ferretId(FERRET))?.folder ?? '/',
      mode: 'auto',
      prompt: 'work',
    });

    // Act
    const starting = f.files.createLifecycle(stranger).start(stranger);

    // Assert
    await expect(starting).rejects.toThrow(`no ferret ${stranger}`);
    expect(f.runner.starts).toBe(0);
  });
});

const DAEMON_PID = 4000;
const CONVERSATION = ConversationIdSchema.parse('0b7e4c1a-1d2f-4c3b-9a8e-7f6d5c4b3a21');
const FRESH = ['/opt/fleet/bin/claude', '--session-id', CONVERSATION];

/** The daemon's REAL leases over an in-memory pool; every process is running unless it is named `dead`. */
class MemoryPool implements ConversationLeaseDisk {
  readonly files = new Map<string, string>();
  readonly dead = new Set<number>();
  async exclusive<T>(_harness: HistoryHarness, work: () => Promise<T>): Promise<T> {
    return await work();
  }
  async read(harness: HistoryHarness, conversation: ConversationId): Promise<string | undefined> {
    return this.files.get(`${harness}/${conversation}`);
  }
  async write(harness: HistoryHarness, conversation: ConversationId, text: string): Promise<void> {
    this.files.set(`${harness}/${conversation}`, text);
  }
  async remove(harness: HistoryHarness, conversation: ConversationId): Promise<void> {
    this.files.delete(`${harness}/${conversation}`);
  }
  async list(harness: HistoryHarness): Promise<readonly string[]> {
    return [...this.files.keys()]
      .filter(key => key.startsWith(`${harness}/`))
      .map(key => key.slice(harness.length + 1));
  }
  async startOf(pid: number): Promise<number | undefined> {
    return this.dead.has(pid) ? undefined : 1;
  }
}

/** The real leases, built over the registry the way the daemon's root builds them. */
function realLeases(pool: MemoryPool, registry: FerretRegistry): ConversationLeases {
  return new ConversationLeases(
    new ConversationLeaseStore(pool, () => new Date(NOW)),
    registryLeaseSessions(registry, async () => undefined, factsOfKey),
    DAEMON_PID,
  );
}

/** What `fy history claim` in a person's terminal asks: no session, so a session's lease is only ever read by its pid. */
async function terminalClaim(pool: MemoryPool, harness: HistoryHarness) {
  return await new ConversationLeaseStore(pool, () => new Date(NOW)).claim(
    { harness, conversation: CONVERSATION, holder: { pid: 9000 } },
    async () => 'unknown',
  );
}

describe('a lifecycle start with the daemon’s real conversation leases (c58-36c-r1)', () => {
  test('should keep a pane’s conversation held against a terminal claim after the daemon that launched it is gone', async () => {
    // Arrange — the pane is launched by the real launch path (the runner, never the wrapper)
    const pool = new MemoryPool();
    const f = await wired({ pool, command: FRESH });

    // Act — a daemon restart: the daemon pid is dead, the pane is still running
    await f.lifecycle.start(FERRET);
    pool.dead.add(DAEMON_PID);
    const claim = await terminalClaim(pool, 'claude');

    // Assert
    expect(claim.kind).toBe('held');
    expect(claim.lease.holder.pid).not.toBe(DAEMON_PID);
    expect(claim.lease.holder.session).toBe(FERRET);
  });

  test('should still let a terminal claim take the conversation once the pane itself has ended', async () => {
    // Arrange
    const pool = new MemoryPool();
    const f = await wired({ pool, command: FRESH });
    await f.lifecycle.start(FERRET);
    const held = await terminalClaim(pool, 'claude');
    pool.dead.add(DAEMON_PID);
    pool.dead.add(held.lease.holder.pid);

    // Act
    const claim = await terminalClaim(pool, 'claude');

    // Assert
    expect(claim.kind).toBe('claimed');
  });

  test('should stop the pane and fail the start, saying why, when the lease cannot be moved onto the pane', async () => {
    // Arrange — the runner cannot say which process the pane runs
    const pool = new MemoryPool();
    const f = await wired({ pool, command: FRESH });
    f.runner.attach = async () => err('gone');

    // Act
    const starting = f.lifecycle.start(FERRET);

    // Assert — nothing keeps writing, and the lease is freed with it
    await expect(starting).rejects.toThrow('could not tell which process runs its terminal');
    expect(await f.runner.alive('%1' as RunnerHandle)).toBe(false);
    expect(pool.files.size).toBe(0);
    expect(f.registry.get(ferretId(FERRET))?.state).toBe('stopped');
  });
});
