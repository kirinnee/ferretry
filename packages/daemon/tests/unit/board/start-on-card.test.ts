import { describe, it } from 'bun:test';
import type {
  BoardTask,
  BoardTaskId,
  BoardTaskResponse,
  BoardTaskStartResponse,
  BoardTaskView,
} from '@ferretry/protocol';
import should from 'should';
import { KeyedSerialExecutor } from '../../../src/adapters/system/keyed-serial-executor.ts';
import {
  BoardError,
  CardStartRefused,
  startOnCard,
  startOnCardBrief,
  type NewFerretOnCard,
  type StartOnCardPorts,
} from '../../../src/lib/board/index.ts';
import { card, lanes, OTHER_PROJECT, PROJECT } from './support.ts';

const ID = 'F1' as BoardTaskId;
const OWNER = { kind: 'owner' } as const;
const FOLDERS: Readonly<Record<string, string>> = { [PROJECT]: '/work/board', [OTHER_PROJECT]: '/work/relay' };

/**
 * One card and the ferrets on this machine, with `start` doing what the daemon's start does to them: the new ferret
 * is alive, holds the card as its focus, and is the card's assignee.
 */
const world = (initial: Partial<BoardTask> = {}, overrides: Partial<StartOnCardPorts> = {}) => {
  let current = card({ id: 'F1', laneId: 'todo', ...initial });
  const alive = new Map<string, BoardTaskId | null>();
  const started: NewFerretOnCard[] = [];
  const keyed = new KeyedSerialExecutor();
  const stopped: { sessionId: string; reason: string }[] = [];
  const kept = new Map<string, BoardTaskStartResponse>();
  const ports: StartOnCardPorts = {
    task: async () => ({ task: current, laneSet: lanes(current.projectId) }) as unknown as BoardTaskResponse,
    folderOf: async row => FOLDERS[row.projectId],
    live: async () => new Map(alive),
    exclusive: async (id, work) => await keyed.run(id, work),
    start: async request => {
      started.push(request);
      await Promise.resolve();
      const sessionId = `new-${started.length}`;
      current = { ...current, assignee: sessionId, laneId: 'plan' };
      alive.set(sessionId, request.card.id);
      return { sessionId, status: 'running' };
    },
    recall: key => kept.get(key),
    remember: (key, result) => {
      kept.set(key, result);
    },
    stop: async (sessionId, reason) => {
      stopped.push({ sessionId, reason });
      alive.delete(sessionId);
    },
    bin: 'fy',
    ...overrides,
  };
  return {
    ports,
    started,
    stopped,
    alive,
    edit: (change: Partial<BoardTask>) => {
      current = { ...current, ...change };
    },
  };
};

describe('starting a ferret on a card', () => {
  it('should start a NEW ferret on the card, with the card as its brief, and say which one', async () => {
    // Arrange
    const { ports, started } = world({ assignee: 'gone', laneId: 'implement' });

    // Act
    const result = await startOnCard(ports, ID, OWNER);

    // Assert
    should(result).eql({ task: 'F1', sessionId: 'new-1', started: true });
    should(started).have.length(1);
    should(started[0]?.card.id).equal('F1');
    should(started[0]?.name).equal('Board store');
    should(started[0]?.prompt).startWith('The owner asked you to take over card &F1.');
    should(started[0]?.prompt).containEql('Your card: &F1');
    should(started[0]?.prompt).containEql('build the board');
  });

  it("should start it in the card's own project's folder", async () => {
    // Arrange
    const { ports, started } = world();

    // Act
    await startOnCard(ports, ID, OWNER);

    // Assert
    should(started[0]?.folder).equal('/work/board');
  });

  it('should start it in the folder of the project the card was refiled to, not the one it began in', async () => {
    // Arrange
    const { ports, started } = world({ projectId: OTHER_PROJECT, laneId: 'todo' });

    // Act
    await startOnCard(ports, ID, OWNER);

    // Assert
    should(started[0]?.folder).equal('/work/relay');
  });

  it('should leave the new ferret holding the card: assigned to it, and the focus it was started with', async () => {
    // Arrange
    const { ports, started, alive } = world({ assignee: 'gone' });

    // Act
    const result = await startOnCard(ports, ID, OWNER);

    // Assert
    should(alive.get(result.sessionId)).equal(started[0]?.card.id);
    should(alive.get(result.sessionId)).equal('F1');
  });

  it('should refuse anybody but the owner, and start nothing', async () => {
    // Arrange
    const { ports, started } = world();

    // Act
    const failure = await startOnCard(ports, ID, { kind: 'ferret', sessionId: 'lead' }).catch(
      (error: unknown) => error,
    );

    // Assert
    should(failure).be.instanceOf(BoardError);
    should((failure as BoardError).code).equal('forbidden');
    should(started).eql([]);
  });

  it('should refuse a closed card, and a dropped one, and start nothing', async () => {
    // Arrange
    const closedCard = world({ laneId: 'closed' });
    const droppedCard = world({ dropped: { at: '2026-10-30T10:00:00.000Z', reason: 'no' } });

    // Act
    const closed = await startOnCard(closedCard.ports, ID, OWNER).catch((error: unknown) => error);
    const dropped = await startOnCard(droppedCard.ports, ID, OWNER).catch((error: unknown) => error);

    // Assert
    should((closed as BoardError).code).equal('invalid');
    should((closed as BoardError).message).equal('This card was closed; reopen it first.');
    should((dropped as BoardError).message).equal('This card was closed; reopen it first.');
    should(closedCard.started).eql([]);
    should(droppedCard.started).eql([]);
  });

  it('should refuse a stale Start from a second client once the card was closed under it', async () => {
    // Arrange
    const { ports, started, edit } = world();
    const first = await startOnCard(ports, ID, OWNER);
    edit({ assignee: null, laneId: 'closed', dropped: { at: '2026-10-30T10:00:00.000Z', reason: 'no' } });

    // Act
    const stale = await startOnCard(ports, ID, OWNER).catch((error: unknown) => error);

    // Assert
    should(first.started).be.true();
    should((stale as BoardError).message).equal('This card was closed; reopen it first.');
    should(started).have.length(1);
  });

  it('should answer a card a live ferret holds with that ferret, and start nothing', async () => {
    // Arrange
    const { ports, started, alive } = world({ assignee: 'worker', laneId: 'implement' });
    alive.set('worker', ID);

    // Act
    const result = await startOnCard(ports, ID, OWNER);

    // Assert
    should(result).eql({ task: 'F1', sessionId: 'worker', started: false });
    should(started).eql([]);
  });

  it("should answer a card with no assignee its live owner's ferret holds, unless it is unclaimed in the backlog", async () => {
    // Arrange
    const working = world({ owner: 'lead', assignee: null, laneId: 'implement' });
    const backlog = world({ owner: 'lead', assignee: null, laneId: 'todo' });
    working.alive.set('lead', null);
    backlog.alive.set('lead', null);

    // Act
    const held = await startOnCard(working.ports, ID, OWNER);
    const free = await startOnCard(backlog.ports, ID, OWNER);

    // Assert
    should(held).eql({ task: 'F1', sessionId: 'lead', started: false });
    should(free.started).be.true();
  });

  it('should answer a card some other live ferret has as its focus with that ferret', async () => {
    // Arrange
    const { ports, started, alive } = world({ assignee: 'gone' });
    alive.set('helper', ID);

    // Act
    const result = await startOnCard(ports, ID, OWNER);

    // Assert
    should(result).eql({ task: 'F1', sessionId: 'helper', started: false });
    should(started).eql([]);
  });

  it('should start a new ferret when the assignee is gone and no live ferret has the card', async () => {
    // Arrange
    const { ports, alive } = world({ assignee: 'gone', laneId: 'implement' });
    alive.set('other', 'F9' as BoardTaskId);

    // Act
    const result = await startOnCard(ports, ID, OWNER);

    // Assert
    should(result.started).be.true();
  });

  it('should start exactly one ferret for overlapping Starts, and give the others that ferret', async () => {
    // Arrange
    const { ports, started } = world();

    // Act
    const results = await Promise.all([startOnCard(ports, ID, OWNER), startOnCard(ports, ID, OWNER)]);

    // Assert
    should(started).have.length(1);
    should(results.map(result => result.sessionId)).eql(['new-1', 'new-1']);
    should(results.map(result => result.started).sort()).eql([false, true]);
  });

  it('should hand a retry after a lost response the same ferret, and start no second one', async () => {
    // Arrange
    const { ports, started } = world();
    const first = await startOnCard(ports, ID, OWNER);

    // Act
    const retry = await startOnCard(ports, ID, OWNER);

    // Assert
    should(retry.sessionId).equal(first.sessionId);
    should(retry.started).be.false();
    should(started).have.length(1);
  });

  it("should hand a retry with the same key the first start's result even after that ferret finished", async () => {
    // Arrange
    const { ports, started, alive } = world();
    const first = await startOnCard(ports, ID, OWNER, 'click-1');
    alive.delete(first.sessionId);

    // Act
    const retry = await startOnCard(ports, ID, OWNER, 'click-1');

    // Assert
    should(retry).eql(first);
    should(started).have.length(1);
  });

  it('should start new work for a new click once the first ferret has finished', async () => {
    // Arrange
    const { ports, started, alive } = world();
    const first = await startOnCard(ports, ID, OWNER, 'click-1');
    alive.delete(first.sessionId);

    // Act
    const second = await startOnCard(ports, ID, OWNER, 'click-2');

    // Assert
    should(second).eql({ task: 'F1', sessionId: 'new-2', started: true });
    should(started).have.length(2);
  });

  it('should keep a key to its own card, and remember nothing for a start without a key', async () => {
    // Arrange
    const { ports, started, alive } = world();
    const first = await startOnCard(ports, ID, OWNER);
    alive.delete(first.sessionId);

    // Act
    const again = await startOnCard(ports, ID, OWNER);

    // Assert
    should(again.sessionId).equal('new-2');
    should(started).have.length(2);
  });

  it('should stop the new ferret and say the card was closed when a close raced the start', async () => {
    // Arrange
    const { ports, stopped, edit } = world(
      {},
      {
        start: async () => {
          edit({ dropped: { at: '2026-10-30T10:00:00.000Z', reason: 'no' } });
          return { sessionId: 'late', status: 'running' };
        },
      },
    );

    // Act
    const failure = await startOnCard(ports, ID, OWNER).catch((error: unknown) => error);

    // Assert
    should((failure as BoardError).message).equal('This card was closed; reopen it first.');
    should(stopped).have.length(1);
    should(stopped[0]?.sessionId).equal('late');
  });

  it('should stop the new ferret when the card was assigned to it and THEN dropped, which keeps the assignee', async () => {
    // Arrange
    const { ports, stopped, edit } = world(
      {},
      {
        start: async () => {
          edit({ assignee: 'late', laneId: 'plan' });
          edit({ dropped: { at: '2026-10-30T10:00:00.000Z', reason: 'no' } });
          return { sessionId: 'late', status: 'running' };
        },
      },
    );

    // Act
    const failure = await startOnCard(ports, ID, OWNER).catch((error: unknown) => error);

    // Assert
    should((failure as BoardError).message).equal('This card was closed; reopen it first.');
    should(stopped.map(entry => entry.sessionId)).eql(['late']);
  });

  it('should stop the new ferret when the card was assigned to it and THEN moved into a closed lane', async () => {
    // Arrange
    const { ports, stopped, edit } = world(
      {},
      {
        start: async () => {
          edit({ assignee: 'late', laneId: 'closed' });
          return { sessionId: 'late', status: 'running' };
        },
      },
    );

    // Act
    const failure = await startOnCard(ports, ID, OWNER).catch((error: unknown) => error);

    // Assert
    should((failure as BoardError).message).equal('This card was closed; reopen it first.');
    should(stopped.map(entry => entry.sessionId)).eql(['late']);
  });

  it('should say why, and not report a start, when the launch failed after the session existed', async () => {
    // Arrange
    const { ports, stopped } = world(
      {},
      { start: async () => ({ sessionId: 'dead', status: 'failed', reason: 'tmux could not open a window' }) },
    );

    // Act
    const failure = await startOnCard(ports, ID, OWNER, 'click-1').catch((error: unknown) => error);
    const unreasoned = await startOnCard(
      world({}, { start: async () => ({ sessionId: 'dead', status: 'failed' }) }).ports,
      ID,
      OWNER,
    ).catch((error: unknown) => error);

    // Assert
    should((failure as BoardError).code).equal('invalid');
    should((failure as BoardError).message).equal('No ferret was started on &F1: tmux could not open a window');
    should((unreasoned as BoardError).message).equal('No ferret was started on &F1: it did not launch');
    should(stopped).eql([]);
  });

  it('should not remember a failed start, so the same click may try again', async () => {
    // Arrange
    let attempts = 0;
    const { ports, edit } = world(
      {},
      {
        start: async () => {
          attempts += 1;
          if (attempts === 1) return { sessionId: 'dead', status: 'failed', reason: 'no window' };
          edit({ assignee: 'ok', laneId: 'plan' });
          return { sessionId: 'ok', status: 'running' };
        },
      },
    );
    const first = await startOnCard(ports, ID, OWNER, 'click-1').catch((error: unknown) => error);

    // Act
    const retry = await startOnCard(ports, ID, OWNER, 'click-1');

    // Assert
    should(first).be.instanceOf(BoardError);
    should(retry).eql({ task: 'F1', sessionId: 'ok', started: true });
  });

  it('should say so, and start nothing, when the card is filed under no project folder', async () => {
    // Arrange
    const { ports, started } = world({}, { folderOf: async () => undefined });

    // Act
    const failure = await startOnCard(ports, ID, OWNER).catch((error: unknown) => error);

    // Assert
    should((failure as BoardError).code).equal('invalid');
    should((failure as BoardError).message).containEql('nowhere to start a ferret on it');
    should(started).eql([]);
  });

  it("should carry the start's refusal in plain words", async () => {
    // Arrange
    const { ports } = world(
      {},
      {
        start: async () => {
          throw new CardStartRefused('the machine is full');
        },
      },
    );

    // Act
    const failure = await startOnCard(ports, ID, OWNER).catch((error: unknown) => error);

    // Assert
    should((failure as BoardError).code).equal('invalid');
    should((failure as BoardError).message).equal('No ferret was started on &F1: the machine is full');
  });

  it('should let any other failure propagate as the defect it is', async () => {
    // Arrange
    const defect = new Error('disk gone');
    const { ports } = world(
      {},
      {
        start: async () => {
          throw defect;
        },
      },
    );

    // Act
    const failure = await startOnCard(ports, ID, OWNER).catch((error: unknown) => error);

    // Assert
    should(failure).equal(defect);
  });
});

describe('the brief of a ferret started on a card', () => {
  it("should carry the card's summary, why it exists, context and how to test it, and the shipped command name", () => {
    // Arrange
    const row = card({
      summary: 'Store the board',
      premise: 'cards get lost',
      context: 'see the relay',
      howToTest: 'run the suite',
    });

    // Act
    const brief = startOnCardBrief(row as unknown as BoardTaskView, lanes(), 'fy');

    // Assert
    should(brief).containEql('Summary:\nStore the board');
    should(brief).containEql('Why it exists:\ncards get lost');
    should(brief).containEql('Context:\nsee the relay');
    should(brief).containEql('How to test:\nrun the suite');
    should(brief).containEql('`fy task note`');
  });

  it('should leave out a section the card does not have', () => {
    // Arrange / Act
    const brief = startOnCardBrief(card() as unknown as BoardTaskView, lanes(), 'fy');

    // Assert
    should(brief).not.containEql('Why it exists:');
    should(brief).not.containEql('How to test:');
  });
});
