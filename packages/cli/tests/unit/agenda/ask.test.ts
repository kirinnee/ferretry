import { describe, it } from 'bun:test';
import should from 'should';
import { ASK_KIND_NAMES, parseAsk, parseKind, TOO_MANY_ANSWERS } from '../../../src/lib/agenda/ask';

describe('ask kinds', () => {
  it('should default to a reply', () => {
    // Act
    const actual = parseAsk({});

    // Assert
    should(actual).deepEqual({ kind: 'reply', ask: { kind: 'open-question' } });
  });

  it('should map every card kind to the ask it carries', () => {
    // Act + Assert
    should(parseAsk({ kind: 'task' })).deepEqual({ kind: 'task', ask: { kind: 'task' } });
    should(parseAsk({ kind: 'permission' })).deepEqual({ kind: 'permission', ask: { kind: 'permission' } });
    should(parseAsk({ kind: 'review' })).deepEqual({ kind: 'review', ask: { kind: 'answer-review' } });
    should(parseAsk({ kind: 'reply' })).deepEqual({ kind: 'reply', ask: { kind: 'open-question' } });
    should(parseAsk({ kind: 'yesno' })).deepEqual({
      kind: 'yesno',
      ask: { kind: 'multiple-choice', options: [{ label: 'Yes' }, { label: 'No' }] },
    });
  });

  it('should give an info card no ask at all', () => {
    // Act
    const actual = parseAsk({ kind: 'info' });

    // Assert
    should(actual).deepEqual({ kind: 'info', ask: undefined });
  });

  it('should still accept the older names and the protocol kind spelled in full', () => {
    // Act + Assert
    should(parseKind('open')).equal('reply');
    should(parseKind('  open-question  ')).equal('reply');
    should(parseKind('answer-review')).equal('review');
    should(parseKind('multiple-choice')).equal('choice');
  });

  it('should name no kind when the flag is absent or blank', () => {
    // Act + Assert
    should(parseKind(undefined)).be.undefined();
    should(parseKind('   ')).be.undefined();
  });

  it('should list the accepted names when the kind is unknown', () => {
    // Act + Assert
    should(() => parseAsk({ kind: 'maybe' })).throw(
      new RegExp(`unknown --kind "maybe" — use ${ASK_KIND_NAMES.join(', ')}`, 'u'),
    );
  });
});

describe('choice asks', () => {
  it('should build a choice from two options', () => {
    // Act
    const actual = parseAsk({ kind: 'choice', option: ['ship it', 'hold'] });

    // Assert
    should(actual).deepEqual({
      kind: 'choice',
      ask: { kind: 'multiple-choice', options: [{ label: 'ship it' }, { label: 'hold' }] },
    });
  });

  it('should take a third option, the most a card can swipe', () => {
    // Act
    const actual = parseAsk({ option: ['a', 'b', 'c'] });

    // Assert
    should(actual.kind).equal('choice');
    should(actual.ask).have.property('options').with.length(3);
  });

  it('should infer a choice when options are given without a kind', () => {
    // Act
    const actual = parseAsk({ option: ['a', 'b'] });

    // Assert
    should(actual.kind).equal('choice');
  });

  it('should read exactly Yes and No as a yesno card, in either order and case', () => {
    // Act + Assert
    should(parseAsk({ option: ['Yes', 'No'] }).kind).equal('yesno');
    should(parseAsk({ option: ['no', 'YES'] }).kind).equal('yesno');
  });

  it('should keep a choice named as one even when its options are Yes and No', () => {
    // Act + Assert
    should(parseAsk({ kind: 'choice', option: ['Yes', 'No'] }).kind).equal('choice');
  });

  it('should accept the protocol spelling of the kind', () => {
    // Act
    const actual = parseAsk({ kind: 'multiple-choice', option: ['a', 'b'] });

    // Assert
    should(actual.kind).equal('choice');
  });

  it('should drop blank options before counting them', () => {
    // Act + Assert — two labels and a stray empty --option is still a valid two-option choice.
    should(parseAsk({ kind: 'choice', option: ['a', '   ', 'b'] }).ask).deepEqual({
      kind: 'multiple-choice',
      options: [{ label: 'a' }, { label: 'b' }],
    });
  });

  it('should refuse a choice with fewer than two options', () => {
    // Act + Assert
    should(() => parseAsk({ kind: 'choice', option: ['only'] })).throw(/needs 2 to 3 distinct --option labels/u);
  });

  it('should refuse a choice with duplicate labels', () => {
    // Act + Assert
    should(() => parseAsk({ kind: 'choice', option: ['same', 'same'] })).throw(/distinct --option labels/u);
  });

  it('should refuse more than three options with the advice to split the item', () => {
    // Act + Assert
    should(() => parseAsk({ kind: 'choice', option: ['a', 'b', 'c', 'd'] })).throw(TOO_MANY_ANSWERS);
    should(TOO_MANY_ANSWERS).equal(
      'a card offers at most 3 answers (swipe left, up, right). Split this into several items, or use --kind reply and let the owner answer in words.',
    );
  });

  it('should refuse an option label spanning more than one line', () => {
    // Act + Assert
    should(() => parseAsk({ kind: 'choice', option: ['fine', 'two\nlines'] })).throw(/each one line/u);
  });

  it('should refuse options on a kind that has none', () => {
    // Act + Assert
    should(() => parseAsk({ kind: 'permission', option: ['a', 'b'] })).throw(
      /--option only makes sense with --kind choice, not permission/u,
    );
  });

  it('should refuse options on a yesno, which brings its own Yes and No', () => {
    // Act + Assert
    should(() => parseAsk({ kind: 'yesno', option: ['Yes', 'No'] })).throw(
      /--kind yesno brings its own Yes and No: drop --option/u,
    );
  });
});

describe('task asks', () => {
  it('should map the to-do kind and list it among the accepted names', () => {
    // Act + Assert
    should(parseAsk({ kind: 'todo' })).deepEqual({ kind: 'task', ask: { kind: 'task' } });
    should(ASK_KIND_NAMES).containEql('todo');
  });

  it('should still read --kind task as the older spelling, but never document it: "task" means a board card', () => {
    // Act + Assert — the wire value stays `task`, so a released daemon's strict add schema keeps accepting it.
    should(parseAsk({ kind: 'task' })).deepEqual({ kind: 'task', ask: { kind: 'task' } });
    should(ASK_KIND_NAMES).not.containEql('task');
  });
});
