import { describe, expect, test } from 'bun:test';

import {
  initialVimState,
  vimReduce,
  type VimDocument,
  type VimKey,
  type VimOutcome,
  type VimState,
} from '../../src/lib/composer-vim.ts';

const NORMAL: VimState = { mode: 'normal', operator: null, column: null };
const INSERT: VimState = { mode: 'insert', operator: null, column: null };

const bare = (key: string): VimKey => ({ key, ctrlKey: false, metaKey: false, altKey: false });

interface Editor {
  readonly state: VimState;
  readonly doc: VimDocument;
}

const at = (value: string, caret: number, state: VimState = NORMAL): Editor => ({
  state,
  doc: { value, selectionStart: caret, selectionEnd: caret },
});

const press = (editor: Editor, key: string): VimOutcome => vimReduce(editor.state, bare(key), editor.doc);

/** Applies keys in order and fails loudly on any key the engine declines, which is never expected here. */
const type = (editor: Editor, ...keys: readonly string[]): Editor =>
  keys.reduce((current, key) => {
    const outcome = press(current, key);
    if (!outcome.handled) throw new Error(`engine declined ${key}`);
    return {
      state: outcome.state,
      doc: { value: outcome.value, selectionStart: outcome.selectionStart, selectionEnd: outcome.selectionEnd },
    };
  }, editor);

const caretOf = (editor: Editor): number => editor.doc.selectionStart;

describe('composer vim engine — what it declines', () => {
  test('never claims a key held with a browser or system modifier', () => {
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      const key: VimKey = { ...bare('x'), [modifier]: true };
      expect(vimReduce(NORMAL, key, at('abc', 1).doc).handled).toBe(false);
    }
  });

  test('claims nothing but Escape while inserting, so typing stays the platform’s', () => {
    expect(press(at('abc', 1, INSERT), 'a').handled).toBe(false);
    expect(press(at('abc', 1, INSERT), 'Enter').handled).toBe(false);
    expect(press(at('abc', 1, INSERT), 'Escape').handled).toBe(true);
  });

  test('leaves every key with no printable character to the host in normal mode', () => {
    for (const key of ['Enter', 'Tab', 'Backspace', 'Delete', 'ArrowLeft', 'Escape', 'F2'])
      expect(press(at('abc', 1), key).handled).toBe(false);
  });

  test('claims an unimplemented printable key inertly, so a stray letter is never typed', () => {
    for (const key of ['z', 'q', '9', ' ']) {
      const outcome = press(at('abc', 1), key);
      expect(outcome).toMatchObject({ handled: true, value: 'abc', selectionStart: 1, selectionEnd: 1 });
      expect(outcome.handled && outcome.state).toEqual(NORMAL);
    }
  });

  test('opens as an ordinary text field', () => {
    expect(initialVimState).toEqual(INSERT);
  });
});

describe('composer vim engine — mode transitions', () => {
  test('Escape leaves insert and pulls the caret back onto a character', () => {
    const after = type(at('abc', 3, INSERT), 'Escape');
    expect(after.state).toEqual(NORMAL);
    expect(caretOf(after)).toBe(2);
  });

  test('Escape at a line start has nowhere to go back to', () => {
    expect(caretOf(type(at('abc', 0, INSERT), 'Escape'))).toBe(0);
    expect(caretOf(type(at('ab\ncd', 3, INSERT), 'Escape'))).toBe(3);
    expect(caretOf(type(at('', 0, INSERT), 'Escape'))).toBe(0);
  });

  test('i inserts before the caret and a inserts after it', () => {
    expect(type(at('hi', 0), 'i')).toEqual(at('hi', 0, INSERT));
    expect(type(at('hi', 0), 'a')).toEqual(at('hi', 1, INSERT));
  });

  test('a at the last character reaches the end of the line, and no further', () => {
    expect(caretOf(type(at('hi', 1), 'a'))).toBe(2);
    expect(caretOf(type(at('hi\ncd', 1), 'a'))).toBe(2);
    expect(caretOf(type(at('', 0), 'a'))).toBe(0);
  });

  test('I opens at the first non-blank of the line and A at its end', () => {
    expect(caretOf(type(at('  ab', 3), 'I'))).toBe(2);
    expect(caretOf(type(at('   ', 0), 'I'))).toBe(3);
    expect(caretOf(type(at('  ab', 0), 'A'))).toBe(4);
    expect(caretOf(type(at('ab\r\ncd', 0), 'A'))).toBe(2);
  });

  test('o opens a line below and O opens one above', () => {
    expect(type(at('ab\ncd', 0), 'o')).toEqual(at('ab\n\ncd', 3, INSERT));
    expect(type(at('ab\ncd', 4), 'O')).toEqual(at('ab\n\ncd', 3, INSERT));
    expect(type(at('ab\ncd', 0), 'O')).toEqual(at('\nab\ncd', 0, INSERT));
    expect(type(at('ab', 1), 'o')).toEqual(at('ab\n', 3, INSERT));
    expect(type(at('', 0), 'o')).toEqual(at('\n', 1, INSERT));
  });

  test('o keeps a CRLF terminator intact', () => {
    expect(type(at('ab\r\ncd', 0), 'o')).toEqual(at('ab\r\n\ncd', 4, INSERT));
  });
});

describe('composer vim engine — motion', () => {
  test('h and l walk the line and stop at both ends', () => {
    expect(caretOf(type(at('abc', 1), 'h'))).toBe(0);
    expect(caretOf(type(at('abc', 0), 'h'))).toBe(0);
    expect(caretOf(type(at('abc', 1), 'l'))).toBe(2);
    expect(caretOf(type(at('abc', 2), 'l'))).toBe(2);
  });

  test('h and l never stop between the halves of a surrogate pair', () => {
    expect(caretOf(type(at('a😀b', 1), 'l'))).toBe(3);
    expect(caretOf(type(at('a😀b', 3), 'h'))).toBe(1);
  });

  test('h and l stay inside their own line', () => {
    expect(caretOf(type(at('ab\ncd', 3), 'h'))).toBe(3);
    expect(caretOf(type(at('ab\ncd', 1), 'l'))).toBe(1);
  });

  test('0 and $ reach the ends of the line, and $ never lands on a CRLF', () => {
    expect(caretOf(type(at('ab cd', 4), '0'))).toBe(0);
    expect(caretOf(type(at('ab cd', 0), '$'))).toBe(4);
    expect(caretOf(type(at('ab\r\ncd', 0), '$'))).toBe(1);
    expect(caretOf(type(at('', 0), '$'))).toBe(0);
    expect(caretOf(type(at('ab\n\ncd', 3), '$'))).toBe(3);
  });

  test('w walks to the next word, treating punctuation as its own', () => {
    expect(caretOf(type(at('foo bar baz', 0), 'w'))).toBe(4);
    expect(caretOf(type(at('foo bar baz', 0), 'w', 'w'))).toBe(8);
    expect(caretOf(type(at('foo bar baz', 8), 'w'))).toBe(10);
    expect(caretOf(type(at('foo.bar', 0), 'w'))).toBe(3);
    expect(caretOf(type(at('foo.bar', 3), 'w'))).toBe(4);
    expect(caretOf(type(at('a  b', 1), 'w'))).toBe(3);
  });

  test('b walks back to the start of a word', () => {
    expect(caretOf(type(at('foo bar', 5), 'b'))).toBe(4);
    expect(caretOf(type(at('foo bar', 4), 'b'))).toBe(0);
    expect(caretOf(type(at('foo   bar', 6), 'b'))).toBe(0);
    expect(caretOf(type(at('foo', 0), 'b'))).toBe(0);
    expect(caretOf(type(at('foo.bar', 4), 'b'))).toBe(3);
  });

  test('e reaches the end of the word, then of the next one', () => {
    expect(caretOf(type(at('foo bar', 0), 'e'))).toBe(2);
    expect(caretOf(type(at('foo bar', 2), 'e'))).toBe(6);
    expect(caretOf(type(at('foo bar', 6), 'e'))).toBe(6);
    expect(caretOf(type(at('', 0), 'e'))).toBe(0);
  });

  test('w and b stop on an empty line, the way a paragraph break should', () => {
    expect(caretOf(type(at('foo\n\nbar', 0), 'w'))).toBe(4);
    expect(caretOf(type(at('foo\n\nbar', 5), 'b'))).toBe(4);
  });

  test('word motions treat non-Latin text as words', () => {
    expect(caretOf(type(at('日本語 text', 0), 'w'))).toBe(4);
    expect(caretOf(type(at('日本語 text', 0), 'e'))).toBe(2);
  });
});

describe('composer vim engine — vertical movement', () => {
  const grid = 'abcdef\nxy\nghijkl';

  test('j and k hold the column across a shorter line', () => {
    const down = type(at(grid, 4), 'j');
    expect(caretOf(down)).toBe(8);
    expect(down.state.column).toBe(4);
    expect(caretOf(type(down, 'j'))).toBe(14);
    expect(caretOf(type(down, 'k'))).toBe(4);
  });

  test('any other command forgets the held column', () => {
    const after = type(at(grid, 4), 'j', '0');
    expect(after.state.column).toBe(null);
    expect(caretOf(after)).toBe(7);
    expect(caretOf(type(after, 'j'))).toBe(10);
  });

  test('j and k stay put at the first and last line', () => {
    expect(caretOf(type(at('ab', 1), 'j'))).toBe(1);
    expect(caretOf(type(at('ab', 1), 'k'))).toBe(1);
    expect(caretOf(type(at('ab\ncd', 4), 'j'))).toBe(4);
  });

  test('j and k land on an empty line rather than skipping it', () => {
    expect(caretOf(type(at('abc\n\ndef', 2), 'j'))).toBe(4);
    expect(caretOf(type(at('abc\n\ndef', 6), 'k'))).toBe(4);
  });

  test('j lands on a trailing empty final line', () => {
    expect(caretOf(type(at('ab\n', 1), 'j'))).toBe(3);
  });
});

describe('composer vim engine — deletion', () => {
  test('x deletes the character under the caret', () => {
    expect(type(at('abc', 1), 'x')).toEqual(at('ac', 1));
  });

  test('x at the end of a line pulls the caret back', () => {
    expect(type(at('abc', 2), 'x')).toEqual(at('ab', 1));
  });

  test('x never eats a line terminator, and is inert on an empty line', () => {
    expect(type(at('a\nb', 0), 'x')).toEqual(at('\nb', 0));
    expect(type(at('\nb', 0), 'x')).toEqual(at('\nb', 0));
    expect(type(at('', 0), 'x')).toEqual(at('', 0));
    expect(type(at('ab\r\ncd', 1), 'x')).toEqual(at('a\r\ncd', 0));
  });

  test('x deletes a whole code point, never half a surrogate pair', () => {
    expect(type(at('a😀b', 1), 'x')).toEqual(at('ab', 1));
  });

  test('dd deletes the line and lands on the next line’s first word', () => {
    expect(type(at('one\ntwo\nthree', 0), 'd', 'd')).toEqual(at('two\nthree', 0));
    expect(type(at('one\ntwo\nthree', 4), 'd', 'd')).toEqual(at('one\nthree', 4));
    expect(type(at('one\n   two', 0), 'd', 'd')).toEqual(at('   two', 3));
  });

  test('dd on the final line takes the terminator before it and lands on the new last line', () => {
    expect(type(at('one\ntwo', 5), 'd', 'd')).toEqual(at('one', 0));
    expect(type(at('one\r\ntwo', 6), 'd', 'd')).toEqual(at('one', 0));
    expect(type(at('  one\ntwo', 7), 'd', 'd')).toEqual(at('  one', 2));
  });

  test('dd on the only line empties the draft', () => {
    expect(type(at('one', 1), 'd', 'd')).toEqual(at('', 0));
    expect(type(at('', 0), 'd', 'd')).toEqual(at('', 0));
    expect(type(at('a\n', 0), 'd', 'd')).toEqual(at('', 0));
  });

  test('d waits for its second key and says so', () => {
    const pending = type(at('one\ntwo', 0), 'd');
    expect(pending.state).toEqual({ mode: 'normal', operator: 'd', column: null });
    expect(pending.doc.value).toBe('one\ntwo');
  });

  test('any key other than d cancels the operator without changing the draft', () => {
    for (const key of ['x', 'Escape', 'w', 'Enter']) {
      const cancelled = type(at('one\ntwo', 0), 'd', key);
      expect(cancelled).toEqual(at('one\ntwo', 0));
    }
  });
});

describe('composer vim engine — what it assumes about the host', () => {
  test('collapses a range to its start, because there is no visual mode here', () => {
    const outcome = vimReduce(NORMAL, bare('x'), { value: 'abcd', selectionStart: 1, selectionEnd: 3 });
    expect(outcome).toEqual({
      handled: true,
      state: NORMAL,
      value: 'acd',
      selectionStart: 1,
      selectionEnd: 1,
    });
  });

  test('normalises a caret the host left past the end of a line', () => {
    expect(type(at('abc', 3), 'x')).toEqual(at('ab', 1));
    expect(type(at('abc', 99), 'i')).toEqual(at('abc', 2, INSERT));
    expect(type(at('abc', -5), 'i')).toEqual(at('abc', 0, INSERT));
  });
});
