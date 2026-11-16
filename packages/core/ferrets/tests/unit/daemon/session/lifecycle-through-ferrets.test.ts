import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { RootHandle, RootsPort } from '@ferretry/kernel/contract';
import { diskPaths, diskSessionsRoot } from '@ferretry/kernel/testing';
import { ok } from '@ferretry/std';
import type { FerretRecord, RunnerHandle } from '../../../../contract/index.ts';
import {
  emptyChildEnvironment,
  FakeHarness,
  FakeRunner,
  fenced,
  ferretId,
  T0,
} from '../../../../contract/testing/index.ts';
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
  async release(sessionId: string): Promise<void> {
    this.calls.push(`release ${sessionId}`);
  }
}

async function wired(
  options: { readonly leases?: SessionConversationLeases; readonly record?: Partial<FerretRecord> } = {},
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
    ...(options.leases === undefined ? {} : { leases: options.leases }),
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
  await lifecycle.create({ agent: '/opt/fleet/bin/claude', cwd: `${parent}/work`, mode: 'auto', prompt: 'work' });
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

    // Assert — one claim for this session, made before the launch, and one release after the stop
    expect(leases.calls[0]?.startsWith(`claim ${FERRET} `)).toBe(true);
    expect(claimedAt).toBe(1);
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
