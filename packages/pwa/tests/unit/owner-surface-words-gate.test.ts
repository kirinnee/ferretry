import { describe, expect, test } from 'bun:test';
import { scan } from '../../../../scripts/validate/owner-surface-words.ts';

/**
 * The owner-surface words gate (scripts/validate/owner-surface-words.sh), on its planted violations: the exact shapes
 * that came back on screen (&B165), and the code shapes that must NOT trip it because nobody sees them.
 */
const found = (code: string, file = 'example.tsx'): readonly string[] =>
  scan(file, code).violations.map(violation => violation.name);

describe('the owner-surface words gate', () => {
  test('finds the old heading, split across JSX text and an expression', () => {
    expect(found('const a = <h5>Card &amp;{ask.gate.cardId}: your answer for the card</h5>;')).toEqual([
      '"your answer for the card"',
      '"Card &…:" heading',
    ]);
  });

  test('finds the words in a string, a template and plain JSX text', () => {
    expect(found("const a = 'You answered a card ask';", 'example.ts')).toEqual(['"card ask"']);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the gate reads this template literal as source text
    expect(found('const a = `Card &${id}: Done?`;', 'example.ts')).toEqual(['"Card &…:" heading']);
    expect(found('const a = <p>Use it as your answer for the card?</p>;')).toEqual(['"your answer for the card"']);
    expect(found("const a = 'Card &F12: try it';", 'example.ts')).toEqual(['"Card &…:" heading']);
  });

  test('finds the card narrated as the one acting: "the card goes back", "the card stays"', () => {
    expect(found("const a = 'The card goes back with your words.';", 'example.ts')).toEqual([
      '"the card <verb>s" narration',
    ]);
    expect(found('const a = <p>The card stays put and the ferret reads your words.</p>;')).toEqual([
      '"the card <verb>s" narration',
    ]);
    expect(found("const a = 'Then the card comes back here.';", 'example.ts')).toEqual([
      '"the card <verb>s" narration',
    ]);
    // The same words in a comment, or in the ferret's own terms, are not read.
    expect(
      found("// the card goes back with the words\nconst a = 'The ferret gets your words and tries again.';"),
    ).toEqual([]);
  });

  test('reads nothing nobody sees: comments, identifiers, data attributes, selectors and module paths', () => {
    expect(
      found(`
        // a card ask's own heading said "Card &F12: your answer for the card"
        /* every card ask */
        import { CardAskAnswer } from './agenda-card-ask-answer.tsx';
        const cardAsk = itemCardAsks(item);
        const a = <div data-agenda-card-ask={key}>{cardAsk.key}</div>;
        const b = root.querySelector('[data-agenda-card-ask]');
      `),
    ).toEqual([]);
  });

  test('lets the card be named once as a plain reference', () => {
    expect(found("const a = <p>For &amp;F12 Badge colour</p>; const b = 'Card &F1';")).toEqual([]);
  });

  test('says a file it cannot parse is a broken gate, never a clean one', () => {
    expect(scan('broken.ts', 'const = ;').unparsable).toBeDefined();
  });
});
