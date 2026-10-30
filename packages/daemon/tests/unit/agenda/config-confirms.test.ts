import { describe, it } from 'bun:test';
import { MAX_AGENDA_DETAIL_LENGTH, MAX_AGENDA_REASON_LENGTH } from '@ferretry/protocol';
import should from 'should';
import {
  allowLine,
  confirmationCard,
  confirmationDecision,
  confirmationNote,
  confirmationPremise,
} from '../../../src/lib/agenda/config-confirms.ts';

const PRICE = 'the Jev price the cap counts with goes down from 2 to 0.042';

describe('the card of an item that confirms a held configuration change', () => {
  it('should offer Allow, Deny and Discard change as the three swipes, each saying what it does', () => {
    // Arrange / Act
    const card = confirmationCard('warden.yaml');

    // Assert
    should(card.kind).equal('choice');
    should(card.answers.map(answer => `${answer.direction}:${answer.label}`)).deepEqual([
      'right:Allow',
      'left:Deny',
      'up:Discard change',
    ]);
    should(card.answers[0]?.description).equal('Apply this change to warden.yaml now');
  });

  describe('its premise', () => {
    it('should state each change and then what Allow does', () => {
      // Arrange / Act / Assert
      should(confirmationPremise('warden.yaml', [PRICE])).equal(
        `- ${PRICE}\n- Allow applies this change to warden.yaml.`,
      );
    });

    it('should add the raiser’s point as a bullet whether or not it was written as one', () => {
      // Arrange / Act / Assert
      should(confirmationPremise('warden.yaml', [PRICE], 'the cap was miscounted')).endWith(
        '\n- the cap was miscounted',
      );
      should(confirmationPremise('warden.yaml', [PRICE], '- one\n- two')).endWith('.\n- one\n- two');
      should(confirmationPremise('warden.yaml', [PRICE], '   ')).equal(confirmationPremise('warden.yaml', [PRICE]));
    });

    it('should drop the raiser’s points before any change when they do not fit', () => {
      // Arrange
      const long = 'x '.repeat(MAX_AGENDA_REASON_LENGTH);

      // Act
      const premise = confirmationPremise('warden.yaml', [PRICE], long);

      // Assert
      should(premise).equal(confirmationPremise('warden.yaml', [PRICE]));
    });

    it('should keep the changes that fit and count the rest, never cutting the line about Allow', () => {
      // Arrange
      const changes = Array.from({ length: 12 }, (_, index) => `${String(index)} ${'word '.repeat(19)}`.trim());

      // Act
      const premise = confirmationPremise('warden.yaml', changes);

      // Assert
      should(premise.length).be.belowOrEqual(MAX_AGENDA_REASON_LENGTH);
      should(premise).match(/- …and \d+ more \(fy config status lists them all\)\n/u);
      should(premise).endWith(`- ${allowLine('warden.yaml')}`);
    });

    it('should clip a single change too long to state whole', () => {
      // Arrange
      const huge = 'word '.repeat(400).trim();

      // Act
      const premise = confirmationPremise('warden.yaml', [huge]);

      // Assert
      should(premise.length).be.belowOrEqual(MAX_AGENDA_REASON_LENGTH);
      should(premise).match(/…\n- Allow applies this change to warden\.yaml\.$/u);
    });

    it('should still say what Allow does with no change to state', () => {
      // Arrange
      const path = `${'deep/'.repeat(250)}warden.yaml`;

      // Act
      const premise = confirmationPremise(path, []);

      // Assert
      should(premise).endWith(allowLine(path));
    });
  });

  describe('what an answer decides', () => {
    it('should read each option by its label, and nothing else as a decision', () => {
      // Arrange / Act / Assert
      should(confirmationDecision({ kind: 'multiple-choice', choice: 'Allow' })).equal('allow');
      should(confirmationDecision({ kind: 'multiple-choice', choice: ' Deny ' })).equal('deny');
      should(confirmationDecision({ kind: 'multiple-choice', choice: 'Discard change' })).equal('discard');
      should(confirmationDecision({ kind: 'multiple-choice', choice: 'Maybe' })).be.undefined();
      should(confirmationDecision({ kind: 'other', answer: 'later' })).be.undefined();
    });
  });

  describe('the note the ferret reads', () => {
    it('should say what was done, then the owner’s own words', () => {
      // Arrange / Act / Assert
      should(confirmationNote('allow', 'warden.yaml')).equal('confirmed warden.yaml: the change is in effect');
      should(confirmationNote('deny', 'warden.yaml', '  ')).equal(
        'denied: the change to warden.yaml stays held, not in effect',
      );
      should(confirmationNote('discard', 'warden.yaml', 'too pricey')).equal(
        'discarded the held change to warden.yaml: the version in effect stays\ntoo pricey',
      );
    });

    it('should clip the owner’s words so the whole note fits', () => {
      // Arrange
      const words = 'long '.repeat(MAX_AGENDA_DETAIL_LENGTH).trim();

      // Act
      const note = confirmationNote('allow', 'warden.yaml', words);

      // Assert
      should(note.length).be.belowOrEqual(MAX_AGENDA_DETAIL_LENGTH);
      should(note).startWith('confirmed warden.yaml: the change is in effect\nlong');
      should(note).endWith('…');
    });
  });
});
