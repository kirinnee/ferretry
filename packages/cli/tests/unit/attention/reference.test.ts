import { describe, it } from 'bun:test';
import should from 'should';
import { attentionOrdinal, attentionReference, parseAttentionReference } from '../../../src/lib/attention/reference';

describe('attention references', () => {
  it('should cite an item with its sigil', () => {
    // Act
    const actual = attentionReference('A3');

    // Assert
    should(actual).equal('!A3');
  });

  it('should accept either sigil and none at all', () => {
    // Act + Assert — both styles circulate; rejecting one only punishes a copy-paste.
    should(parseAttentionReference('!A3')).equal('A3');
    should(parseAttentionReference('?A3')).equal('A3');
    should(parseAttentionReference('A3')).equal('A3');
    should(parseAttentionReference('  !A12  ')).equal('A12');
  });

  it('should reject anything that is not an attention id', () => {
    // Act + Assert
    for (const value of ['', 'A0', 'A', '!B3', 'A3x', '3', '!!A3', 'A03']) {
      should(() => parseAttentionReference(value)).throw(/is not an attention reference/u);
    }
  });

  it('should read the ordinal out of an id so items can be ordered', () => {
    // Act + Assert
    should(attentionOrdinal('A3')).equal(3);
    should(attentionOrdinal('A17')).equal(17);
  });
});
