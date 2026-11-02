import { describe, it } from 'bun:test';
import type { BoardTaskId, BoardTaskResponse } from '@ferretry/protocol';
import should from 'should';
import { BoardError, CardStartRefused, startOnCard, type StartOnCardPorts } from '../../../src/lib/board/index.ts';
import { card, lanes } from './support.ts';

const ID = 'F1' as BoardTaskId;
const response = (
  task: Parameters<typeof card>[0],
  laneSet: ReturnType<typeof lanes> | null = lanes(),
): BoardTaskResponse => ({ task: card(task), laneSet }) as unknown as BoardTaskResponse;
const OWNER = { kind: 'owner' } as const;

/** Ports over one card whose ferret is `worker`; `resumed` records every turn handed over. */
const ports = (
  overrides: Partial<StartOnCardPorts> = {},
): { readonly ports: StartOnCardPorts; readonly resumed: { sessionId: string; message: string }[] } => {
  const resumed: { sessionId: string; message: string }[] = [];
  return {
    resumed,
    ports: {
      task: async () => response({ id: 'F1', laneId: 'implement', assignee: 'worker' }),
      exists: async () => true,
      isSubFerret: async () => false,
      resume: async (sessionId, message) => {
        resumed.push({ sessionId, message });
      },
      ...overrides,
    },
  };
};

describe('starting a ferret on a card', () => {
  it('should resume the ferret the card is assigned to, with the card as its brief', async () => {
    // Arrange
    const { ports: wired, resumed } = ports();

    // Act
    const started = await startOnCard(wired, ID, OWNER);

    // Assert
    should(started).eql({ task: 'F1', sessionId: 'worker' });
    should(resumed).have.length(1);
    should(resumed[0]?.sessionId).equal('worker');
    should(resumed[0]?.message).startWith('The owner asked for you to carry on with your card.');
    should(resumed[0]?.message).containEql('Your card: &F1');
    should(resumed[0]?.message).containEql('build the board');
  });

  it('should resume the owner ferret when the card has no separate assignee', async () => {
    // Arrange
    const { ports: wired, resumed } = ports({
      task: async () => response({ id: 'F1', laneId: 'implement', owner: 'lead', assignee: null }, null),
    });

    // Act
    const started = await startOnCard(wired, ID, OWNER);

    // Assert
    should(started.sessionId).equal('lead');
    should(resumed[0]?.sessionId).equal('lead');
  });

  it('should not tell a sub-ferret to move the card itself', async () => {
    // Arrange
    const { ports: wired, resumed } = ports({ isSubFerret: async () => true });

    // Act
    await startOnCard(wired, ID, OWNER);

    // Assert
    should(resumed[0]?.message).containEql('your card moves itself');
    should(resumed[0]?.message).not.containEql('fy task move');
  });

  it('should refuse anybody but the owner, and resume nothing', async () => {
    // Arrange
    const { ports: wired, resumed } = ports();

    // Act
    const failure = await startOnCard(wired, ID, { kind: 'ferret', sessionId: 'lead' }).catch(
      (error: unknown) => error,
    );

    // Assert
    should(failure).be.instanceOf(BoardError);
    should((failure as BoardError).code).equal('forbidden');
    should(resumed).eql([]);
  });

  it('should say so, and point at assign, when the ferret is no longer on this machine', async () => {
    // Arrange
    const { ports: wired, resumed } = ports({ exists: async () => false });

    // Act
    const failure = await startOnCard(wired, ID, OWNER).catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceOf(BoardError);
    should((failure as BoardError).code).equal('not-found');
    should((failure as BoardError).message).containEql('no longer on this machine');
    should((failure as BoardError).message).containEql('fy task assign F1');
    should(resumed).eql([]);
  });

  it("should carry the resume domain's refusal in plain words", async () => {
    // Arrange
    const { ports: wired } = ports({
      resume: async () => {
        throw new CardStartRefused('it is already running');
      },
    });

    // Act
    const failure = await startOnCard(wired, ID, OWNER).catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceOf(BoardError);
    should((failure as BoardError).code).equal('invalid');
    should((failure as BoardError).message).equal("&F1's ferret did not start: it is already running");
  });

  it('should let any other failure propagate as the defect it is', async () => {
    // Arrange
    const defect = new Error('disk gone');
    const { ports: wired } = ports({
      resume: async () => {
        throw defect;
      },
    });

    // Act
    const failure = await startOnCard(wired, ID, OWNER).catch((error: unknown) => error);

    // Assert
    should(failure).equal(defect);
  });
});
