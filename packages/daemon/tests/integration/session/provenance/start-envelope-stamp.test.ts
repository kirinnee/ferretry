import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionConfigSchema } from '@ferretry/protocol';
import should from 'should';
import {
  BunSqliteIndexFactory,
  DaemonStorageFactory,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  type SessionProtocolEnvelope,
  StorageSessionLifecycleRepository,
  StorageSessionProvenanceStore,
  SystemClock,
} from '../../../../src/adapters/index.ts';
import {
  createSessionRecord,
  defaultSessionLifecycleSettings,
  parseSessionId,
  SessionProvenanceStamper,
} from '../../../../src/lib/index.ts';

/**
 * The guard for the START path, which nothing else in CI covers.
 *
 * `createSessionControlSubsystem` has no unit test — its composition is proved by `tests/e2e`, and
 * THE E2E TIER DOES NOT RUN IN CI. So without this, "an ordinary start now carries a stamp" would be
 * an unproved claim about the one path every session goes through.
 *
 * It proves the two halves that must agree, over a real state home:
 *
 * 1. A stamp placed on the create envelope survives into the durable document and parses back out of
 *    `SessionConfigSchema` — the same read every mounted surface performs.
 * 2. THE LABEL AND THE STAMP ARE ONE DECISION. `resolveSpawnLabel` force-labels a warden descendant,
 *    so writing the request's label beside a `wardenLineage: true` stamp would produce a session
 *    whose two shield mechanisms disagree — and `inWardenLineage` returns true on the LABEL, which
 *    masks the disagreement until somebody edits it. Both come from one `stamp()` call here for
 *    exactly that reason.
 *
 * It also pins the merge order the whole re-stamp design turns on: `configDocument` merges
 * `{ ...envelope, ...stored, ...record.config }`, so a STORED stamp beats the envelope. Right for
 * monotonicity, and the reason a revive needs its own writer rather than riding a transition.
 */

const NOW = '2026-08-06T10:00:00.000Z';
const homes = new Set<string>();

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

async function openTemporaryStorage() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-start-stamp-'));
  homes.add(home);
  const factory = new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date(NOW)),
    () => new KeyedSerialExecutor(),
  );
  return (await factory.open()).storage;
}

const stamper = new SessionProvenanceStamper({ now: () => NOW });

/**
 * The protocol fields a START decides, as `createSessionControlSubsystem` builds them.
 *
 * The envelope exists because the lifecycle record alone is NOT a protocol-complete configuration:
 * the id, title, cwd, mode, parent and instants are the lifecycle's, and everything else — including
 * the stamp — comes from here. Spelled out rather than faked so the read below exercises the same
 * document shape every mounted surface parses.
 */
function envelope(overrides: Record<string, unknown>): SessionProtocolEnvelope {
  return {
    incarnation: 'x-1',
    runtimeGeneration: 1,
    boardAccess: 'none',
    agent: 'claude-auto-loge',
    harness: 'claude',
    modelHint: '',
    remoteControl: false,
    harnessFlags: [],
    turn: 1,
    intervalSeconds: 30,
    timeoutSeconds: 600,
    nudgeAfterSeconds: 120,
    killAfterSeconds: 900,
    directSendMaxChars: 4000,
    resumeMenuChoice: 'full',
    maxSnapshots: 5,
    retry: { transientAttempts: 2, stalledAttempts: 1, waitForQuotaReset: true, allowAccountFailover: false },
    ...overrides,
  } as SessionProtocolEnvelope;
}

describe('a started session carries its spawn stamp', () => {
  it('should persist an unshielded stamp from the create envelope and read it back', async () => {
    // Arrange
    const storage = await openTemporaryStorage();
    const id = parseSessionId('started-root');
    const stamped = stamper.stamp({ id, requestedByHuman: true }, new Map());
    const created = createSessionRecord(
      { agent: '/opt/fleet/bin/claude-auto-loge', cwd: '/workspace/project', mode: 'auto', prompt: 'Persist me' },
      { id, cwd: '/workspace/project', at: NOW, settings: defaultSessionLifecycleSettings },
    );

    // Act
    await new StorageSessionLifecycleRepository(storage, envelope({ provenance: stamped.provenance })).write(
      created.record,
      created.event,
    );
    const config = SessionConfigSchema.safeParse(await storage.readConfig(id));

    // Assert
    should(config.success).be.true();
    should(config.success && config.data.provenance).eql(stamped.provenance);
    should(config.success && config.data.provenance?.origin).eql('human');
    should(config.success && config.data.provenance?.wardenLineage).be.false();
    await storage.close();
  });

  it('should store the label the stamper forced, so the two shield mechanisms agree', async () => {
    // Arrange: a session spawned under a warden. The caller asked for `team`; the stamper overrides.
    const storage = await openTemporaryStorage();
    const id = parseSessionId('started-descendant');
    const fleet = new Map([['warden-7', { id: 'warden-7', label: 'fleet-warden' }]]);
    const stamped = stamper.stamp({ id, label: 'team', parent: 'warden-7', requestedByHuman: false }, fleet);
    const created = createSessionRecord(
      { agent: '/opt/fleet/bin/claude-auto-loge', cwd: '/workspace/project', mode: 'auto', prompt: 'Persist me' },
      { id, cwd: '/workspace/project', at: NOW, settings: defaultSessionLifecycleSettings },
    );

    // Act
    await new StorageSessionLifecycleRepository(
      storage,
      envelope({ provenance: stamped.provenance, ...(stamped.label === undefined ? {} : { label: stamped.label }) }),
    ).write(created.record, created.event);
    const config = SessionConfigSchema.safeParse(await storage.readConfig(id));

    // Assert: the stamp says descendant AND the label says warden. Writing `team` here would leave a
    // document whose label check and stamp check disagree about one session.
    should(config.success).be.true();
    should(config.success && config.data.provenance?.wardenLineage).be.true();
    should(config.success && config.data.provenance?.warden).eql('warden-7');
    should(config.success && config.data.label).eql('fleet-warden');
    await storage.close();
  });

  it('should never let a later write replace a stamp already on disk', async () => {
    // Arrange: the merge order `{ ...envelope, ...stored, ...record.config }` is what makes the
    // shield monotonic — and what makes a revive-time writer necessary.
    const storage = await openTemporaryStorage();
    const id = parseSessionId('started-then-transitioned');
    const original = stamper.stamp({ id, requestedByHuman: true }, new Map()).provenance;
    const created = createSessionRecord(
      { agent: '/opt/fleet/bin/claude-auto-loge', cwd: '/workspace/project', mode: 'auto', prompt: 'Persist me' },
      { id, cwd: '/workspace/project', at: NOW, settings: defaultSessionLifecycleSettings },
    );
    await new StorageSessionLifecycleRepository(storage, envelope({ provenance: original })).write(
      created.record,
      created.event,
    );

    // Act: a later transition, constructed with no envelope at all, as every non-create is.
    await new StorageSessionLifecycleRepository(storage).write(created.record, created.event);

    // Assert
    should((await new StorageSessionProvenanceStore(storage).read(id)).provenance).eql(original);
    await storage.close();
  });
});
