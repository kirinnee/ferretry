import { describe, it } from 'bun:test';
import should from 'should';
import { agendaOrdinal, agendaReference, parseAgendaReference } from '../../../src/lib/agenda/reference';

describe('attention references', () => {
  it('should cite an item with its sigil', () => {
    // Act
    const actual = agendaReference('A3');

    // Assert
    should(actual).equal('!A3');
  });

  it('should accept either sigil and none at all', () => {
    // Act + Assert — both styles circulate; rejecting one only punishes a copy-paste.
    should(parseAgendaReference('!A3')).equal('A3');
    should(parseAgendaReference('?A3')).equal('A3');
    should(parseAgendaReference('A3')).equal('A3');
    should(parseAgendaReference('  !A12  ')).equal('A12');
  });

  it('should reject anything that is not an attention id', () => {
    // Act + Assert
    for (const value of ['', 'A0', 'A', '!B3', 'A3x', '3', '!!A3', 'A03']) {
      should(() => parseAgendaReference(value)).throw(/is not an agenda reference/u);
    }
  });

  it('should read the ordinal out of an id so items can be ordered', () => {
    // Act + Assert
    should(agendaOrdinal('A3')).equal(3);
    should(agendaOrdinal('A17')).equal(17);
  });
});
