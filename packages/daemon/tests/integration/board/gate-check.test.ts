import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BoardTaskResponse } from '@ferretry/protocol';
import should from 'should';
import { armAgendaNudge, StorageAgendaNudgeSessions } from '../../../src/adapters/agenda/storage-agenda-nudge.ts';
import { BOARD_GATE_NUDGED_EVENT, JournalBoardChecks } from '../../../src/adapters/board/session-board-adapters.ts';
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
import { BoardGateCheck, type GateCheckItem } from '../../../src/lib/board/index.ts';
import { parseSessionId } from '../../../src/lib/index.ts';
import type { TranscriptEvent } from '../../../src/lib/transcript/types.ts';
import { card, lanes } from '../../unit/board/support.ts';
import { waitFor } from '../support/wait-for.ts';

/**
 * The gate check against a real storage: a turn end journalled by the real append path, the session read
 * from its own configuration, the nudge journalled back. The send is a ledger that keeps one message per
 * send id, as the real send slice does. No daemon, no tmux, no harness.
 */

const homes = new Set<string>();
const storages = new Set<{ close(): Promise<void> | void }>();
const NOW = '2026-10-30T10:00:00.000Z';
const LEAD = parseSessionId('lead-1');
const CHILD = parseSessionId('child-1');

const owner = (text: string): TranscriptEvent => ({
  kind: 'message',
  harness: 'claude',
  role: 'user',
  text,
  timestamp: NOW,
});
const raised = {
  kind: 'tool-call',
  harness: 'claude',
  role: 'assistant',
  call: { id: 'c1', name: 'Bash', input: { command: 'fy agenda add --title "Try it" "please test" --task F412' } },
} as TranscriptEvent;

const mine: GateCheckItem = {
  id: 'A44',
  raisedBy: 'agent',
  sourceRef: null,
  task: { id: 'F412' },
  waitingSince: '2026-10-30T10:00:05.000Z',
};
const gate: GateCheckItem = {
  id: 'A31',
  raisedBy: 'daemon',
  sourceRef: 'gate:F412:tested:3',
  task: { id: 'F412' },
  waitingSince: '2026-10-30T09:00:00.000Z',
};

async function open(boardOn = true) {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-gate-check-'));
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
  const { storage } = await factory.open();
  storages.add(storage);
  const config = (id: string, extra: Record<string, unknown>) => ({
    id,
    name: id,
    agent: '/opt/fleet/bin/claude',
    harness: 'claude',
    command: ['/opt/fleet/bin/claude'],
    cwd: '/workspace/project',
    mode: 'interactive',
    turn: 1,
    tmuxSession: `fy-${id}`,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  });
  await storage.writeConfig(LEAD, config('lead-1', {}));
  await storage.writeConfig(CHILD, config('child-1', { parent: 'lead-1' }));

  const transcripts = new Map<string, readonly TranscriptEvent[]>();
  const items = new Map<string, readonly GateCheckItem[]>();
  const cardAt = { laneId: 'tested' };
  const delivered = new Map<string, { sessionId: string; message: string }>();
  const sessions = new StorageAgendaNudgeSessions(storage);
  const journal = new JournalBoardChecks(storage);
  const check = new BoardGateCheck(
    {
      // A sub-ferret raises no agenda items: it is never read.
      readable: async sessionId => (await sessions.subject(sessionId))?.parent === false,
      boardOn: async () => boardOn,
      tail: async sessionId => transcripts.get(sessionId) ?? [],
      open: async sessionId => items.get(sessionId) ?? [],
      card: async () =>
        ({ task: card({ id: 'F412', laneId: cardAt.laneId }), laneSet: lanes() }) as unknown as BoardTaskResponse,
      send: async (sessionId, sendId, message) => {
        if (!delivered.has(sendId)) delivered.set(sendId, { sessionId, message });
      },
      record: async (sessionId, ids, cards) => await journal.recordGate(sessionId, ids, cards),
    },
    'fy',
  );
  const scheduled: Array<() => void> = [];
  let finished = 0;
  const counted = {
    check: async (sessionId: string) => {
      try {
        return await check.check(sessionId);
      } finally {
        finished += 1;
      }
    },
  };
  armAgendaNudge(storage, counted, 2_000, run => {
    scheduled.push(run);
  });
  const settle = async (): Promise<void> => {
    const runs = scheduled.splice(0);
    const target = finished + runs.length;
    for (const run of runs) run();
    await waitFor(() => finished >= target, 'every scheduled gate check to finish');
  };
  const turnEnds = async (id: typeof LEAD): Promise<void> => {
    await storage.append(id, 'turn.state', { from: 'working', to: 'your-turn' });
  };
  const nudged = async (id: typeof LEAD) =>
    (await storage.tailEvents()).filter(event => event.sessionId === id && event.type === BOARD_GATE_NUDGED_EVENT);
  return { transcripts, items, cardAt, delivered, settle, turnEnds, nudged };
}

afterEach(async () => {
  for (const storage of storages) await storage.close();
  storages.clear();
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('the turn-end gate check', () => {
  it('should nudge a lead that raised its own item on a gate card, exactly once, and journal it', async () => {
    // Arrange
    const world = await open();
    world.transcripts.set('lead-1', [owner('ship it'), raised]);
    world.items.set('lead-1', [mine, gate]);

    // Act — the same turn end, then seen again (a replay, a restart).
    await world.turnEnds(LEAD);
    await world.settle();
    await world.turnEnds(LEAD);
    await world.settle();

    // Assert
    should([...world.delivered.values()]).eql([
      {
        sessionId: 'lead-1',
        message: '&F412 is at a gate; the daemon already asked the owner (!A31). Drop yours: fy agenda dismiss !A44',
      },
    ]);
    const journal = await world.nudged(LEAD);
    should(journal.length).equal(1);
    should(journal[0]?.data).deepEqual({ items: ['A44'], cards: ['F412'] });
  });

  it('should say nothing once the card has left the gate, for a sub-ferret, or on a board that is off', async () => {
    // Arrange
    const moved = await open();
    moved.transcripts.set('lead-1', [owner('ship it'), raised]);
    moved.items.set('lead-1', [mine, gate]);
    moved.cardAt.laneId = 'implement';
    const sub = await open();
    sub.transcripts.set('child-1', [owner('ship it'), raised]);
    sub.items.set('child-1', [mine, gate]);
    const off = await open(false);
    off.transcripts.set('lead-1', [owner('ship it'), raised]);
    off.items.set('lead-1', [mine, gate]);

    // Act
    await moved.turnEnds(LEAD);
    await moved.settle();
    await sub.turnEnds(CHILD);
    await sub.settle();
    await off.turnEnds(LEAD);
    await off.settle();

    // Assert
    should([...moved.delivered.values(), ...sub.delivered.values(), ...off.delivered.values()]).eql([]);
    should((await moved.nudged(LEAD)).length).equal(0);
  });
});
