import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AnsweredAsk,
  approvalProblem,
  cardLicence,
  offBoardRefusal,
  TRACK_QUESTION,
} from '../../../daemon/lib/board/index.ts';

const FERRET = 'mvysjsw0-7071db05';

/** The owner's answered "Track this on the board?" on the ferret's own ledger, with whatever a case changes. */
const answered = (extra: Partial<AnsweredAsk> = {}): AnsweredAsk => ({
  raisedBy: 'ferret',
  raisedByFerret: FERRET,
  subject: 'Track this on the board?',
  options: ['Yes', 'No'],
  answer: { by: 'owner', choice: 'Yes' },
  ...extra,
});

const facts = { boardOn: false, parent: false, approved: false };

describe('whether a ferret may make a card', () => {
  it('should let any card through where the board is on', () => {
    should(cardLicence({ boardOn: true, parent: true, approved: true })).equal('board-on');
  });

  it('should let a card under a parent the ferret holds through where the board is off', () => {
    should(cardLicence({ ...facts, parent: true, approved: true })).equal('parent');
  });

  it("should let a card on the owner's Yes through where the board is off", () => {
    should(cardLicence({ ...facts, approved: true })).equal('approval');
  });

  it('should refuse a card with nothing behind it', () => {
    should(cardLicence(facts)).be.null();
  });
});

describe('the question the Yes must answer', () => {
  it('should be "Track … on the board?", in the ferret\'s words for what', () => {
    for (const words of [
      'Track this on the board?',
      'track the login fix on the board',
      '  Track it on the board ? ',
    ]) {
      should(TRACK_QUESTION.test(words)).be.true(words);
    }
  });

  it('should not be any yes/no that names a card, a board or tracking', () => {
    for (const words of [
      'Remove the credit card field?',
      'Track down the leak?',
      'Is the board page slow?',
      'Should I keep tracking it on the board? Or ship?',
      'Untrack this on the board?',
    ]) {
      should(TRACK_QUESTION.test(words)).be.false(words);
    }
  });
});

describe("the owner's Yes", () => {
  it('should count an answered yes/no about tracking that the ferret raised', () => {
    should(approvalProblem('A12', answered(), FERRET, undefined)).be.null();
  });

  it('should count a Yes however it is cased', () => {
    // Arrange
    const item = answered({ options: ['yes', 'NO'], answer: { by: 'owner', choice: 'yes' } });

    // Act
    const problem = approvalProblem('A12', item, FERRET, undefined);

    // Assert
    should(problem).be.null();
  });

  it('should refuse an item that is not answered on the ferret’s agenda', () => {
    should(approvalProblem('A12', undefined, FERRET, undefined)).equal('!A12 is not an answered ask on your ledger');
  });

  it('should refuse an item another ferret, the daemon or the owner raised', () => {
    const others = [
      answered({ raisedByFerret: 'someone-else' }),
      answered({ raisedBy: 'daemon' }),
      answered({ raisedBy: 'owner' }),
    ];
    for (const item of others) {
      should(approvalProblem('A12', item, FERRET, undefined)).equal('!A12 is not an ask you raised');
    }
  });

  it('should refuse an item that is not a yes/no question', () => {
    // Arrange
    const choice = answered({ options: ['Yes', 'Later'] });
    const open = answered({ options: [], answer: undefined });

    // Act & Assert
    should(approvalProblem('A12', choice, FERRET, undefined)).equal('!A12 is not a yes/no question');
    should(approvalProblem('A12', open, FERRET, undefined)).equal('!A12 is not a yes/no question');
  });

  it('should refuse a Yes to another question, even one that names a card or tracking', () => {
    for (const subject of ['Ship the fix?', 'Remove the credit card field?', 'Track down the leak?']) {
      // Arrange
      const item = answered({ subject });

      // Act
      const problem = approvalProblem('A12', item, FERRET, undefined);

      // Assert
      should(problem).equal('!A12 does not ask "Track this on the board?"', subject);
    }
  });

  it('should count the question in the title when the ask says it differently', () => {
    // Arrange
    const item = answered({ title: 'Track this on the board?', subject: 'Should the login fix get a card?' });

    // Act
    const problem = approvalProblem('A12', item, FERRET, undefined);

    // Assert
    should(problem).be.null();
  });

  it('should refuse an ask the ferret or the daemon closed', () => {
    const closers = [answered({ answer: { by: 'other', choice: 'Yes' } }), answered({ answer: { by: 'other' } })];
    for (const item of closers) {
      should(approvalProblem('A12', item, FERRET, undefined)).equal('!A12 was not answered by the owner');
    }
  });

  it('should refuse a No, a dismissal and a reply', () => {
    const notYes = [
      answered({ answer: { by: 'owner', choice: 'No' } }),
      answered({ answer: { by: 'owner' } }),
      answered({ answer: { by: 'owner', choice: 'not yet' } }),
    ];
    for (const item of notYes) {
      should(approvalProblem('A12', item, FERRET, undefined)).equal('the owner did not answer Yes to !A12');
    }
  });

  it('should refuse a Yes that already made a card', () => {
    should(approvalProblem('A12', answered(), FERRET, { id: 'F7' })).equal(
      '!A12 already made &F7; one Yes makes one card',
    );
  });
});

describe('the refusal', () => {
  it('should say the board is off, what to do instead and how to ask', () => {
    should(offBoardRefusal('ferretry')).equal(
      'The ferretry board is off, so this work needs no card: put only what the owner must decide or do in an ask (fy ask …). To track it anyway, ask first: fy ask -k yesno "Track this on the board?" — then, once the owner says Yes, fy card new … --approval !A<n>.',
    );
  });

  it('should say why a named approval did not count', () => {
    should(offBoardRefusal('ferretry', 'the owner did not answer Yes to !A12')).containEql(
      'The approval does not count: the owner did not answer Yes to !A12.',
    );
  });
});
