import { describe, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import should from 'should';
import { explainBoardRefusal, explainingRefusals, proposeLanesCommand } from '../../../src/lib/board/board-refusal';

const context = { binary: 'fy', project: 'Ferretry' };
const refused = (code: string | undefined, body?: unknown, message = 'the daemon says no') =>
  new FyHttpError(message, 409, code, body);

const TEMPLATES = 'pr-release-verify|pr-release|pr|ops|writing|quick';

describe('proposeLanesCommand', () => {
  it('should name the project when the command knew the board', () => {
    // Act + Assert
    should(proposeLanesCommand(context)).equal(`fy board lanes propose --template <${TEMPLATES}> --project Ferretry`);
  });

  it('should leave a placeholder when it did not', () => {
    // Act + Assert
    should(proposeLanesCommand({ binary: 'fy' })).equal(
      `fy board lanes propose --template <${TEMPLATES}> --project <project>`,
    );
  });
});

describe('explainBoardRefusal', () => {
  it('should print the daemon’s message with its code', () => {
    // Act + Assert
    should(explainBoardRefusal(refused('reason-required', undefined, 'a move back says why'), context)).equal(
      'a move back says why (reason-required)',
    );
  });

  it('should list who may do it instead, in words, when the refusal carries standings', () => {
    // Arrange
    const standings = ['owner-human', 'owner', 'ancestor', 'assignee', 'daemon', 'reader'];

    // Act
    const text = explainBoardRefusal(refused('forbidden', { allowed: standings }), context);

    // Assert
    should(text).equal(
      [
        'the daemon says no (forbidden)',
        'who may do this instead:',
        '  - the owner (a person, from the app or the CLI outside a ferret)',
        "  - the card's owner ferret",
        "  - a ferret above the card's owner (its lead)",
        '  - the ferret it is assigned to',
        '  - the daemon itself',
        '  - anyone who can read the board',
      ].join('\n'),
    );
  });

  it('should echo a standing it does not know, and ignore non-string entries', () => {
    // Act
    const text = explainBoardRefusal(refused('forbidden', { allowed: ['wizard', 7, null] }), context);

    // Assert
    should(text).equal('the daemon says no (forbidden)\nwho may do this instead:\n  - wizard');
  });

  it('should print no standings when the body has none, is not an object, or holds a non-list', () => {
    // Act + Assert
    for (const body of [undefined, null, 'text', {}, { allowed: 'owner' }, { allowed: [] }]) {
      should(explainBoardRefusal(refused('forbidden', body), context)).equal('the daemon says no (forbidden)');
    }
  });

  it('should print the exact lanes propose command for a project with no lane set', () => {
    // Act
    const text = explainBoardRefusal(refused('no-lane-set', undefined, 'Ferretry has no lanes'), context);

    // Assert
    should(text).equal(
      [
        'Ferretry has no lanes (no-lane-set)',
        'give the project lanes first:',
        `  fy board lanes propose --template <${TEMPLATES}> --project Ferretry`,
      ].join('\n'),
    );
  });

  it('should leave anything that is not a board refusal alone', () => {
    // Act + Assert
    should(explainBoardRefusal(new Error('boom'), context)).be.undefined();
    should(explainBoardRefusal('text', context)).be.undefined();
    should(explainBoardRefusal(refused('rate_limited'), context)).be.undefined();
    should(explainBoardRefusal(refused(undefined), context)).be.undefined();
  });
});

describe('explainingRefusals', () => {
  it('should return the work’s value untouched', async () => {
    // Act + Assert
    should(await explainingRefusals(context, () => Promise.resolve(7))).equal(7);
  });

  it('should turn a board refusal into a CLI refusal carrying the explanation', async () => {
    // Act
    const failure = await explainingRefusals(context, () =>
      Promise.reject(refused('cycle', undefined, 'F1 would wait on itself')),
    ).catch((error: unknown) => error);

    // Assert
    should(failure).be.an.Error();
    should((failure as Error).name).equal('CliInputError');
    should((failure as Error).message).equal('F1 would wait on itself (cycle)');
  });

  it('should let every other failure through unchanged', async () => {
    // Arrange
    const boom = new Error('socket closed');

    // Act
    const failure = await explainingRefusals(context, () => Promise.reject(boom)).catch((error: unknown) => error);

    // Assert
    should(failure).equal(boom);
  });
});
