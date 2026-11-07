import { describe, it } from 'bun:test';
import type { Card, CardId, CardResponse, CardStartResponse, CardView } from '../../../contract/index.ts';
import should from 'should';
import { KeyedSerial } from '../../../daemon/lib/lanes/serial.ts';
import {
  BoardError,
  CardStartRefused,
  startOnCard,
  startOnCardBrief,
  type NewFerretOnCard,
  type StartOnCardPorts,
} from '../../../daemon/lib/board/index.ts';
import { card, lanes, OTHER_PROJECT, PROJECT } from './support.ts';

const ID = 'F1' as CardId;
const OWNER = { kind: 'owner' } as const;
const FOLDERS: Readonly<Record<string, string>> = { [PROJECT]: '/work/board', [OTHER_PROJECT]: '/work/relay' };

/**
 * One card and the ferrets on this machine, with `start` doing what the daemon's start does to them: the new ferret
 * is alive, holds the card as its focus, and is the card's assignee.
 */
const world = (initial: Partial<Card> = {}, overrides: Partial<StartOnCardPorts> = {}) => {
  let current = card({ id: 'F1', laneId: 'todo', ...initial });
  const alive = new Map<string, CardId | null>();
  const wedged = new Map<string, CardId | null>();
  const started: NewFerretOnCard[] = [];
  const keyed = new KeyedSerial();
  const stopped: { ferret: string; reason: string }[] = [];
  const kept = new Map<string, CardStartResponse>();
  const ports: StartOnCardPorts = {
    card: async () => ({ card: current, laneSet: lanes(current.projectId) }) as unknown as CardResponse,
    folderOf: async row => FOLDERS[row.projectId],
    live: async () => new Map(alive),
    stuck: async () => new Map(wedged),
    exclusive: async (id, work) => await keyed.run(id, work),
    start: async request => {
      started.push(request);
      await Promise.resolve();
      const ferret = `new-${started.length}`;
      current = { ...current, assignee: ferret, laneId: 'plan' };
      alive.set(ferret, request.card.id);
      return { ferret, status: 'started' };
    },
    recall: key => kept.get(key),
    remember: (key, result) => {
      kept.set(key, result);
    },
    stop: async (ferret, reason) => {
      stopped.push({ ferret, reason });
      alive.delete(ferret);
    },
    bin: 'fy',
    ...overrides,
  };
  return {
    ports,
    started,
    stopped,
    alive,
    wedged,
    edit: (change: Partial<Card>) => {
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
    should(result).eql({ card: 'F1', ferret: 'new-1', started: true });
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
    should(alive.get(result.ferret)).equal(started[0]?.card.id);
    should(alive.get(result.ferret)).equal('F1');
  });

  it('should refuse anybody but the owner, and start nothing', async () => {
    // Arrange
    const { ports, started } = world();

    // Act
    const failure = await startOnCard(ports, ID, { kind: 'ferret', ferret: 'lead' }).catch((error: unknown) => error);

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
    should(result).eql({ card: 'F1', ferret: 'worker', started: false });
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
    should(held).eql({ card: 'F1', ferret: 'lead', started: false });
    should(free.started).be.true();
  });

  it('should answer a card some other live ferret has as its focus with that ferret', async () => {
    // Arrange
    const { ports, started, alive } = world({ assignee: 'gone' });
    alive.set('helper', ID);

    // Act
    const result = await startOnCard(ports, ID, OWNER);

    // Assert
    should(result).eql({ card: 'F1', ferret: 'helper', started: false });
    should(started).eql([]);
  });

  it('should start a new ferret when the assignee is gone and no live ferret has the card', async () => {
    // Arrange
    const { ports, alive } = world({ assignee: 'gone', laneId: 'implement' });
    alive.set('other', 'F9' as CardId);

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
    should(results.map(result => result.ferret)).eql(['new-1', 'new-1']);
    should(results.map(result => result.started).sort()).eql([false, true]);
  });

  it('should hand a retry after a lost response the same ferret, and start no second one', async () => {
    // Arrange
    const { ports, started } = world();
    const first = await startOnCard(ports, ID, OWNER);

    // Act
    const retry = await startOnCard(ports, ID, OWNER);

    // Assert
    should(retry.ferret).equal(first.ferret);
    should(retry.started).be.false();
    should(started).have.length(1);
  });

  it("should hand a retry with the same key the first start's result even after that ferret finished", async () => {
    // Arrange
    const { ports, started, alive } = world();
    const first = await startOnCard(ports, ID, OWNER, 'click-1');
    alive.delete(first.ferret);

    // Act
    const retry = await startOnCard(ports, ID, OWNER, 'click-1');

    // Assert
    should(retry).eql(first);
    should(started).have.length(1);
  });

  it('should hand a retry with the same key the held answer even after the holder finished', async () => {
    // Arrange: a live ferret holds the card, the first reply is lost, the holder completes.
    const { ports, started, alive } = world({ assignee: 'holder' });
    alive.set('holder', ID);
    const first = await startOnCard(ports, ID, OWNER, 'click-1');
    alive.delete('holder');

    // Act
    const retry = await startOnCard(ports, ID, OWNER, 'click-1');

    // Assert
    should(first).eql({ card: 'F1', ferret: 'holder', started: false });
    should(retry).eql(first);
    should(started).have.length(0);
  });

  it('should start new work for a new click once the first ferret has finished', async () => {
    // Arrange
    const { ports, started, alive } = world();
    const first = await startOnCard(ports, ID, OWNER, 'click-1');
    alive.delete(first.ferret);

    // Act
    const second = await startOnCard(ports, ID, OWNER, 'click-2');

    // Assert
    should(second).eql({ card: 'F1', ferret: 'new-2', started: true });
    should(started).have.length(2);
  });

  it('should keep a key to its own card, and remember nothing for a start without a key', async () => {
    // Arrange
    const { ports, started, alive } = world();
    const first = await startOnCard(ports, ID, OWNER);
    alive.delete(first.ferret);

    // Act
    const again = await startOnCard(ports, ID, OWNER);

    // Assert
    should(again.ferret).equal('new-2');
    should(started).have.length(2);
  });

  it('should stop the new ferret and say the card was closed when a close raced the start', async () => {
    // Arrange
    const { ports, stopped, edit } = world(
      {},
      {
        start: async () => {
          edit({ dropped: { at: '2026-10-30T10:00:00.000Z', reason: 'no' } });
          return { ferret: 'late', status: 'started' };
        },
      },
    );

    // Act
    const failure = await startOnCard(ports, ID, OWNER).catch((error: unknown) => error);

    // Assert
    should((failure as BoardError).message).equal('This card was closed; reopen it first.');
    should(stopped).have.length(1);
    should(stopped[0]?.ferret).equal('late');
  });

  it('should stop the new ferret when the card was assigned to it and THEN dropped, which keeps the assignee', async () => {
    // Arrange
    const { ports, stopped, edit } = world(
      {},
      {
        start: async () => {
          edit({ assignee: 'late', laneId: 'plan' });
          edit({ dropped: { at: '2026-10-30T10:00:00.000Z', reason: 'no' } });
          return { ferret: 'late', status: 'started' };
        },
      },
    );

    // Act
    const failure = await startOnCard(ports, ID, OWNER).catch((error: unknown) => error);

    // Assert
    should((failure as BoardError).message).equal('This card was closed; reopen it first.');
    should(stopped.map(entry => entry.ferret)).eql(['late']);
  });

  it('should stop the new ferret when the card was assigned to it and THEN moved into a closed lane', async () => {
    // Arrange
    const { ports, stopped, edit } = world(
      {},
      {
        start: async () => {
          edit({ assignee: 'late', laneId: 'closed' });
          return { ferret: 'late', status: 'started' };
        },
      },
    );

    // Act
    const failure = await startOnCard(ports, ID, OWNER).catch((error: unknown) => error);

    // Assert
    should((failure as BoardError).message).equal('This card was closed; reopen it first.');
    should(stopped.map(entry => entry.ferret)).eql(['late']);
  });

  it('should say why, and not report a start, when the launch failed after the session existed', async () => {
    // Arrange
    const { ports, stopped } = world(
      {},
      { start: async () => ({ ferret: 'dead', status: 'failed', reason: 'tmux could not open a window' }) },
    );

    // Act
    const failure = await startOnCard(ports, ID, OWNER, 'click-1').catch((error: unknown) => error);
    const unreasoned = await startOnCard(
      world({}, { start: async () => ({ ferret: 'dead', status: 'failed' }) }).ports,
      ID,
      OWNER,
    ).catch((error: unknown) => error);

    // Assert
    should((failure as BoardError).code).equal('invalid');
    should((failure as BoardError).message).equal('No ferret was started on &F1: tmux could not open a window');
    should((unreasoned as BoardError).message).equal('No ferret was started on &F1: it did not launch');
    should(stopped.map(entry => entry.ferret)).eql(['dead']);
  });

  it('should stop the pane of a launch that failed AFTER its first turn was delivered, so a retry never runs two', async () => {
    // Arrange: delivery succeeded and settling threw, so the record says failed while the pane is up.
    let attempts = 0;
    const panes = new Set<string>();
    let most = 0;
    const { ports, edit, stopped } = world(
      {},
      {
        start: async () => {
          attempts += 1;
          const ferret = `w${attempts}`;
          panes.add(ferret);
          most = Math.max(most, panes.size);
          edit({ assignee: ferret, laneId: 'plan' });
          return attempts === 1 ? { ferret, status: 'failed', reason: 'settle threw' } : { ferret, status: 'started' };
        },
        stop: async ferret => {
          panes.delete(ferret);
        },
      },
    );

    // Act
    const first = await startOnCard(ports, ID, OWNER, 'click-1').catch((error: unknown) => error);
    const retry = await startOnCard(ports, ID, OWNER, 'click-1');

    // Assert
    should(first).be.instanceOf(BoardError);
    should(retry).eql({ card: 'F1', ferret: 'w2', started: true });
    should(most).equal(1);
    should([...panes]).eql(['w2']);
    should(stopped).eql([]);
  });

  it('should not call the start failed, nor start another, when the failed pane cannot be stopped', async () => {
    // Arrange: the stop throws and the lifecycle records kill_failed, which the roster counts as terminal.
    let attempts = 0;
    const { ports, edit, wedged } = world(
      {},
      {
        start: async () => {
          attempts += 1;
          edit({ assignee: 'stuck', laneId: 'plan' });
          return { ferret: 'stuck', status: 'failed', reason: 'settle threw' };
        },
        stop: async () => {
          wedged.set('stuck', ID);
          throw new Error('the pane refused to die');
        },
      },
    );

    // Act
    const failure = await startOnCard(ports, ID, OWNER, 'click-1').catch((error: unknown) => error);
    const retry = await startOnCard(ports, ID, OWNER, 'click-2').catch((error: unknown) => error);

    // Assert
    should((failure as BoardError).code).equal('invalid');
    should((failure as BoardError).message).equal(
      'No ferret was started on &F1: settle threw. It could not be stopped (the pane refused to die), so check it before starting another.',
    );
    should((retry as BoardError).code).equal('invalid');
    should((retry as BoardError).message).equal('A ferret on &F1 could not be stopped; stop it first.');
    should(attempts).equal(1);
  });

  it('should say the stop failure even when it was not an Error', async () => {
    // Arrange
    const { ports } = world(
      {},
      {
        start: async () => ({ ferret: 's', status: 'failed' }),
        stop: async () => Promise.reject('gone'),
      },
    );

    // Act
    const failure = await startOnCard(ports, ID, OWNER).catch((error: unknown) => error);

    // Assert
    should((failure as BoardError).message).containEql('It could not be stopped (gone)');
  });

  it('should refuse a start while a stuck pane has the card as its focus, though it is not the assignee', async () => {
    // Arrange
    const { ports, started, wedged } = world({ assignee: 'other' });
    wedged.set('stuck', ID);

    // Act
    const refused = await startOnCard(ports, ID, OWNER).catch((error: unknown) => error);

    // Assert
    should((refused as BoardError).message).equal('A ferret on &F1 could not be stopped; stop it first.');
    should(started).have.length(0);
  });

  it('should not be held by a stuck pane that belongs to another card', async () => {
    // Arrange
    const { ports, started, wedged } = world({ assignee: 'gone' });
    wedged.set('elsewhere', 'F9' as CardId);
    wedged.set('unfocused', null);

    // Act
    const result = await startOnCard(ports, ID, OWNER);

    // Assert
    should(result.started).equal(true);
    should(started).have.length(1);
  });

  it('should not remember a failed start, so the same click may try again', async () => {
    // Arrange
    let attempts = 0;
    const { ports, edit } = world(
      {},
      {
        start: async () => {
          attempts += 1;
          if (attempts === 1) return { ferret: 'dead', status: 'failed', reason: 'no window' };
          edit({ assignee: 'ok', laneId: 'plan' });
          return { ferret: 'ok', status: 'started' };
        },
      },
    );
    const first = await startOnCard(ports, ID, OWNER, 'click-1').catch((error: unknown) => error);

    // Act
    const retry = await startOnCard(ports, ID, OWNER, 'click-1');

    // Assert
    should(first).be.instanceOf(BoardError);
    should(retry).eql({ card: 'F1', ferret: 'ok', started: true });
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
      progress: { now: 'half way', doneSoFar: '- the route', next: '' },
    });

    // Act
    const brief = startOnCardBrief(row as unknown as CardView, lanes(), 'fy');

    // Assert
    should(brief).containEql('Summary:\nStore the board');
    should(brief).containEql('Why it exists:\ncards get lost');
    should(brief).containEql('Context:\nsee the relay');
    should(brief).containEql('How to test:\nrun the suite');
    should(brief).containEql('Progress:\nNow:\nhalf way\n\nDone so far:\n- the route');
    should(brief).not.containEql('Next:');
    should(brief).containEql('`fy card note`');
  });

  it('should leave out a section the card does not have', () => {
    // Arrange / Act
    const brief = startOnCardBrief(card() as unknown as CardView, lanes(), 'fy');

    // Assert
    should(brief).not.containEql('Why it exists:');
    should(brief).not.containEql('How to test:');
    should(brief).not.containEql('Status:');
  });
});
