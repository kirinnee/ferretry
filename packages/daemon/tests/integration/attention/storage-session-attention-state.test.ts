import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStateSchema } from '@ferretry/protocol';
import should from 'should';
import {
  ATTENTION_CHANGED_EVENT,
  StorageSessionAttentionState,
} from '../../../src/adapters/attention/storage-session-attention-state.ts';
import {
  BunSqliteIndexFactory,
  DaemonStorageFactory,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  SystemClock,
} from '../../../src/adapters/index.ts';
import type { AttentionBoardChange } from '../../../src/lib/attention/index.ts';
import { parseSessionId } from '../../../src/lib/index.ts';

/**
 * A session's open-Attention summary, written into the state document the list serves, and the journal
 * entry that makes the fleet feed re-read it. Runs against a temp `FY_HOME`; no daemon, no port.
 */

const homes = new Set<string>();
const NOW = '2026-10-23T10:00:00.000Z';
const ID = parseSessionId('session-1');
const SUMMARY = { open: 2, first: 'A1', ask: 'Rebase onto main now?', latestAt: NOW } as const;

async function openStorage() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-attention-state-'));
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
  const opened = await factory.open();
  await opened.storage.writeConfig(ID, {
    id: 'session-1',
    name: 'Attention',
    agent: '/opt/fleet/bin/claude',
    command: ['/opt/fleet/bin/claude'],
    cwd: '/workspace/project',
    mode: 'auto',
    turn: 1,
    tmuxSession: 'fy-session-1',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await opened.storage.writeState(ID, { id: 'session-1', status: 'running', turn: 1 });
  return opened.storage;
}

const change = (kind: AttentionBoardChange['change'], id: string): AttentionBoardChange =>
  ({ change: kind, actor: { kind: 'human' }, via: 'board', item: { id } }) as unknown as AttentionBoardChange;

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('the session attention state adapter', () => {
  it('should write the summary the protocol parses, clear it to ABSENT, and journal each change', async () => {
    // Arrange
    const storage = await openStorage();
    const subject = new StorageSessionAttentionState(storage);

    // Act
    await subject.write('session-1', SUMMARY, change('created', 'A2'));
    const raised = await storage.readState(ID);
    await subject.write('session-1', undefined, change('answered', 'A1'));
    const cleared = await storage.readState(ID);
    const journal = (await storage.replay(ID)).events.filter(event => event.type === ATTENTION_CHANGED_EVENT);

    // Assert
    should(SessionStateSchema.parse(raised).attention).deepEqual(SUMMARY);
    should(SessionStateSchema.parse(raised).agenda).deepEqual(SUMMARY);
    should(cleared).not.have.property('attention');
    should(cleared).not.have.property('agenda');
    should(SessionStateSchema.safeParse(cleared).success).be.true();
    should(journal.map(event => event.data)).deepEqual([
      { change: 'created', id: 'A2', open: 2 },
      { change: 'answered', id: 'A1', open: 0 },
    ]);
    await storage.close();
  });

  it('should reconcile silently when the stored summary is already right, and say so when it was wrong', async () => {
    // Arrange
    const storage = await openStorage();
    const subject = new StorageSessionAttentionState(storage);

    // Act
    await subject.write('session-1', undefined, undefined);
    await subject.write('session-1', SUMMARY, undefined);
    await subject.write('session-1', SUMMARY, undefined);
    const journal = (await storage.replay(ID)).events.filter(event => event.type === ATTENTION_CHANGED_EVENT);

    // Assert
    should(journal.map(event => event.data)).deepEqual([{ change: 'reconciled', open: 2 }]);
    should(SessionStateSchema.parse(await storage.readState(ID)).attention).deepEqual(SUMMARY);
    await storage.close();
  });

  it('should do nothing for an id the layout refuses or a session with no state', async () => {
    // Arrange
    const storage = await openStorage();
    const subject = new StorageSessionAttentionState(storage);

    // Act
    await subject.write('../escape', SUMMARY, change('created', 'A1'));
    await subject.write('session-9', SUMMARY, change('created', 'A1'));

    // Assert
    should(storage.findSession(parseSessionId('session-9'))).be.undefined();
    await storage.close();
  });
});
