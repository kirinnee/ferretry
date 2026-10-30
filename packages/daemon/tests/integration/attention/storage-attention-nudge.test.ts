import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  ATTENTION_NUDGED_EVENT,
  armAttentionNudge,
  StorageAttentionNudgeSessions,
} from '../../../src/adapters/attention/storage-attention-nudge.ts';
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
import { ATTENTION_NUDGE_MARK, AttentionTurnNudge } from '../../../src/lib/attention/index.ts';
import { parseSessionId } from '../../../src/lib/index.ts';
import type { TranscriptEvent } from '../../../src/lib/transcript/types.ts';
import { waitFor } from '../support/wait-for.ts';

/**
 * The turn-end check against a real storage: turn ends journalled by the real append path, the session's
 * own configuration read from disk, the nudge journalled back. The send is a ledger that keeps one message
 * per send id, as the real send slice does. No daemon, no tmux, no harness.
 */

const homes = new Set<string>();
const storages = new Set<{ close(): Promise<void> | void }>();
const NOW = '2026-10-29T10:00:00.000Z';
const LEAD = parseSessionId('lead-1');
const CHILD = parseSessionId('child-1');

const REPLY =
  'Opened the PR.\n\n**Next steps**\n- You: run `hms` to link the new skill\n- You: approve the deploy\n- Me: babysit CI';

const owner = (text: string): TranscriptEvent => ({ kind: 'message', harness: 'claude', role: 'user', text });
const said = (text: string, messageId: string): TranscriptEvent => ({
  kind: 'message',
  harness: 'claude',
  role: 'assistant',
  text,
  messageId,
});

async function open(agendaOn = true) {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-attention-nudge-'));
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
  await storage.writeConfig(CHILD, config('child-1', { parent: 'lead-1', mode: 'auto' }));

  // What each session's transcript holds now; a test moves it on between turns.
  const transcripts = new Map<string, readonly TranscriptEvent[]>();
  // The send slice's ledger: one message per send id, the rest are duplicates of it.
  const delivered = new Map<string, { sessionId: string; message: string }>();
  let enabled = true;
  const agenda = new Map<string, boolean>([
    ['lead-1', agendaOn],
    ['child-1', agendaOn],
  ]);
  const sessions = new StorageAttentionNudgeSessions(storage, { read: async id => agenda.get(id) ?? false });
  const nudge = new AttentionTurnNudge(
    {
      enabled: async () => enabled,
      subject: async sessionId => await sessions.subject(sessionId),
      tail: async sessionId => transcripts.get(sessionId) ?? [],
      send: async (sessionId, sendId, message) => {
        if (!delivered.has(sendId)) delivered.set(sendId, { sessionId, message });
      },
      record: async (sessionId, asks) => await sessions.record(sessionId, asks),
    },
    'fy',
  );
  // The settle delay is the composition root's timer; here each scheduled check is collected and run on demand.
  const scheduled: Array<() => void> = [];
  let finished = 0;
  const counted = {
    check: async (sessionId: string) => {
      try {
        return await nudge.check(sessionId);
      } finally {
        finished += 1;
      }
    },
  };
  const unsubscribe = armAttentionNudge(storage, counted, 2_000, run => {
    scheduled.push(run);
  });
  const settle = async (): Promise<void> => {
    const runs = scheduled.splice(0);
    const target = finished + runs.length;
    for (const run of runs) run();
    await waitFor(() => finished >= target, 'every scheduled nudge check to finish');
  };
  const turnEnds = async (id: typeof LEAD): Promise<void> => {
    await storage.append(id, 'turn.state', { from: 'working', to: 'your-turn' });
  };
  const nudged = async (id: typeof LEAD) =>
    (await storage.tailEvents()).filter(event => event.sessionId === id && event.type === ATTENTION_NUDGED_EVENT);
  return {
    storage,
    transcripts,
    delivered,
    settle,
    turnEnds,
    nudged,
    unsubscribe,
    scheduled,
    disable: () => {
      enabled = false;
    },
  };
}

afterEach(async () => {
  for (const storage of storages) await storage.close();
  storages.clear();
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('the turn-end Attention check', () => {
  it('should nudge a lead whose reply asks the owner to act exactly once, however often the turn end is seen', async () => {
    // Arrange
    const world = await open();
    world.transcripts.set('lead-1', [owner('ship it'), said(REPLY, 'msg-1')]);

    // Act — the same turn end, journalled, then seen again after the first check (a replay, a restart).
    await world.turnEnds(LEAD);
    await world.settle();
    await world.turnEnds(LEAD);
    await world.settle();

    // Assert
    should(world.delivered.size).equal(1);
    const [message] = [...world.delivered.values()];
    should(message?.sessionId).equal('lead-1');
    should(message?.message).startWith(ATTENTION_NUDGE_MARK);
    should(message?.message).containEql('- run `hms` to link the new skill\n- approve the deploy');
    should(message?.message).containEql('`fy agenda add --title');
    should(message?.message).containEql('or your question tool');
    const journal = await world.nudged(LEAD);
    should(journal.length).be.aboveOrEqual(1);
    should(journal[0]?.data).deepEqual({ asks: ['run `hms` to link the new skill', 'approve the deploy'] });
  });

  it('should word the nudge as a notice when the session’s agenda mode is off', async () => {
    // Arrange
    const world = await open(false);
    world.transcripts.set('lead-1', [owner('ship it'), said(REPLY, 'msg-1')]);

    // Act
    await world.turnEnds(LEAD);
    await world.settle();

    // Assert
    const [message] = [...world.delivered.values()];
    should(message?.message).containEql('`fy notify "<summary>"`');
    should(message?.message).not.containEql('agenda add');
    should(message?.message).not.containEql('question tool');
  });

  it('should not nudge again on the turn the nudge started, even when the reply still lists asks', async () => {
    // Arrange
    const world = await open();
    world.transcripts.set('lead-1', [owner('ship it'), said(REPLY, 'msg-1')]);
    await world.turnEnds(LEAD);
    await world.settle();
    const [first] = [...world.delivered.values()];

    // Act — the ferret answers the nudge with the same list, and that turn ends.
    world.transcripts.set('lead-1', [
      owner('ship it'),
      said(REPLY, 'msg-1'),
      owner(first?.message ?? ''),
      said(`Not raising: the owner is at the keyboard.\n\n${REPLY}`, 'msg-2'),
    ]);
    await world.turnEnds(LEAD);
    await world.settle();

    // Assert
    should(world.delivered.size).equal(1);
  });

  it('should check one turn end per session at a time, dropping one seen while a check is pending', async () => {
    // Arrange
    const world = await open();
    world.transcripts.set('lead-1', [owner('ship it'), said(REPLY, 'msg-1')]);

    // Act
    await world.turnEnds(LEAD);
    await world.turnEnds(LEAD);

    // Assert
    should(world.scheduled).have.length(1);
    await world.settle();
    should(world.delivered.size).equal(1);
  });

  it('should leave a sub-ferret alone, and every ferret once the machine’s switch is off', async () => {
    // Arrange
    const world = await open();
    world.transcripts.set('child-1', [owner('do part 2'), said(REPLY, 'c-1')]);
    world.transcripts.set('lead-1', [owner('ship it'), said(REPLY, 'msg-1')]);

    // Act
    await world.turnEnds(CHILD);
    await world.settle();
    world.disable();
    await world.turnEnds(LEAD);
    await world.settle();

    // Assert
    should(world.delivered.size).equal(0);
    should(await world.nudged(CHILD)).be.empty();
    should(await world.nudged(LEAD)).be.empty();
  });

  it('should ignore every event that is not a turn end, and stop listening once unsubscribed', async () => {
    // Arrange
    const world = await open();
    world.transcripts.set('lead-1', [owner('ship it'), said(REPLY, 'msg-1')]);

    // Act
    await world.storage.append(LEAD, 'turn.state', { from: 'working', to: 'needs-input' });
    world.unsubscribe();
    await world.turnEnds(LEAD);

    // Assert
    should(world.scheduled).be.empty();
  });
});

describe('armAttentionNudge', () => {
  it('should swallow a failed check and take the next turn end', async () => {
    // Arrange
    const world = await open();
    const scheduled: Array<() => void> = [];
    let checks = 0;
    armAttentionNudge(
      world.storage,
      {
        check: async () => {
          checks += 1;
          throw new Error('transcript unreadable');
        },
      },
      2_000,
      run => {
        scheduled.push(run);
      },
    );

    // Act
    await world.turnEnds(LEAD);
    for (const run of scheduled.splice(0)) run();
    await waitFor(() => checks === 1, 'the failing check to have run');
    await world.turnEnds(LEAD);

    // Assert
    should(checks).equal(1);
    should(scheduled).have.length(1);
  });
});

describe('StorageAttentionNudgeSessions', () => {
  it('should answer nothing for an id that is not a session id or a document that names no harness', async () => {
    // Arrange
    const world = await open();
    const sessions = new StorageAttentionNudgeSessions(world.storage);
    const bare = parseSessionId('bare-1');
    await world.storage.writeConfig(bare, { id: 'bare-1', mode: 'auto' });

    // Act + Assert
    should(await sessions.subject('../escape')).be.undefined();
    should(await sessions.subject('missing-1')).be.undefined();
    should(await sessions.subject('bare-1')).be.undefined();
    should(await sessions.subject('child-1')).deepEqual({
      parent: true,
      mode: 'auto',
      agenda: false,
      harness: 'claude',
    });
    await sessions.record('../escape', ['x']);
  });

  it('should read a Codex session’s harness', async () => {
    // Arrange
    const world = await open();
    const codex = parseSessionId('codex-1');
    await world.storage.writeConfig(codex, { id: 'codex-1', harness: 'codex', parent: '' });

    // Act + Assert
    should(await new StorageAttentionNudgeSessions(world.storage).subject('codex-1')).deepEqual({
      parent: false,
      mode: 'auto',
      agenda: false,
      harness: 'codex',
    });
  });

  it('should take the agenda flag from the store it is given, and read a store that fails as off', async () => {
    // Arrange
    const world = await open();
    const on = new StorageAttentionNudgeSessions(world.storage, { read: async () => true });
    const broken = new StorageAttentionNudgeSessions(world.storage, {
      read: async () => {
        throw new Error('launch settings unreadable');
      },
    });

    // Act + Assert
    should((await on.subject('lead-1'))?.agenda).be.true();
    should((await broken.subject('lead-1'))?.agenda).be.false();
  });
});
