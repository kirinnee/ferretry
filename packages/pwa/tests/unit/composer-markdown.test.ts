import { describe, test } from 'bun:test';
import should from 'should';
import { type MdToken, tokenizeMarkdown } from '../../src/lib/composer-markdown.ts';

/** The overlay's correctness contract: the tokens concatenate to the input. */
const roundTrip = (input: string): readonly MdToken[] => {
  const tokens = tokenizeMarkdown(input);
  should(tokens.map(token => token.text).join('')).equal(input);
  return tokens;
};

const types = (tokens: readonly MdToken[]): readonly string[] => tokens.map(token => token.type);

const ofType = (tokens: readonly MdToken[], type: MdToken['type']): readonly string[] =>
  tokens.filter(token => token.type === type).map(token => token.text);

describe('tokenizeMarkdown losslessness', () => {
  const fixtures = [
    '',
    'plain text',
    'multi\nline\n\ntext\n',
    '# heading\n\nbody **bold** and *italic* and `code`',
    '```ts\nconst a = 1;\n```\nafter',
    '```\nunterminated fence\nstill code',
    '~~~\ntilde fence\n~~~',
    '- item one\n- item two\n  - nested\n1. ordered\n2) also ordered',
    '> quoted\n> > nested quote',
    '[label](https://example.com) trailing',
    'a * b * c stays plain',
    'trailing spaces   \nand\ttabs\t',
    '`unclosed inline code',
    '**unclosed bold',
    'mixed ``double `tick`` spans',
    '\\*escaped\\* asterisks',
    '****',
    '***everything***',
    'ends with newline\n',
    '\n\n\n',
  ];

  for (const fixture of fixtures) {
    test(`should reproduce ${JSON.stringify(fixture.slice(0, 40))} byte for byte`, () => {
      // Act & Assert — roundTrip asserts the concatenation itself.
      roundTrip(fixture);
    });
  }
});

describe('tokenizeMarkdown fenced code blocks', () => {
  test('should split a terminated backtick fence into fence, code, fence', () => {
    // Act
    const tokens = roundTrip('```ts\nconst a = 1;\nlet b;\n```');

    // Assert
    should(types(tokens)).deepEqual(['fence', 'text', 'codeBlock', 'text', 'codeBlock', 'text', 'fence']);
    should(ofType(tokens, 'fence')).deepEqual(['```ts', '```']);
  });

  test('should run an unterminated fence to the end of the draft as code', () => {
    // Act
    const tokens = roundTrip('before\n```py\nstill typing');

    // Assert
    should(ofType(tokens, 'codeBlock')).deepEqual(['still typing']);
    should(tokens[0]).deepEqual({ type: 'text', text: 'before' });
  });

  test('should treat markdown syntax inside a fence as code', () => {
    // Act
    const tokens = roundTrip('```\n**not bold** `not inline`\n# not a heading\n```');

    // Assert
    should(ofType(tokens, 'bold')).deepEqual([]);
    should(ofType(tokens, 'inlineCode')).deepEqual([]);
    should(ofType(tokens, 'heading')).deepEqual([]);
    should(ofType(tokens, 'codeBlock')).deepEqual(['**not bold** `not inline`', '# not a heading']);
  });

  test('should close a shorter opener with a longer run but not the reverse', () => {
    // Act
    const closed = roundTrip('```\ncode\n````');
    const open = roundTrip('````\ncode\n```\nstill code');

    // Assert
    should(ofType(closed, 'fence')).deepEqual(['```', '````']);
    should(ofType(open, 'codeBlock')).deepEqual(['code', '```', 'still code']);
  });

  test('should not let a tilde fence close a backtick fence', () => {
    // Act
    const tokens = roundTrip('```\n~~~\nstill code\n```');

    // Assert
    should(ofType(tokens, 'codeBlock')).deepEqual(['~~~', 'still code']);
    should(ofType(tokens, 'fence')).deepEqual(['```', '```']);
  });

  test('should not open a fence whose backtick info string contains a backtick', () => {
    // Act
    const tokens = roundTrip('``` `not-a-fence`\nprose');

    // Assert
    should(ofType(tokens, 'fence')).deepEqual([]);
    should(tokens.some(token => token.type === 'codeBlock')).equal(false);
  });

  test('should open a fence indented by up to three spaces', () => {
    // Act
    const tokens = roundTrip('   ```\ncode\n   ```');

    // Assert
    should(ofType(tokens, 'fence')).deepEqual(['   ```', '   ```']);
  });

  test('should not accept a tab as one of the three permitted leading spaces', () => {
    // Act
    const tokens = roundTrip('\t```ts\nprose');

    // Assert
    should(ofType(tokens, 'fence')).deepEqual([]);
    should(ofType(tokens, 'codeBlock')).deepEqual([]);
  });
});

describe('tokenizeMarkdown inline code', () => {
  test('should include the backticks in a single-backtick span', () => {
    // Act
    const tokens = roundTrip('run `bun test` now');

    // Assert
    should(ofType(tokens, 'inlineCode')).deepEqual(['`bun test`']);
  });

  test('should let a double-backtick span contain single backticks', () => {
    // Act
    const tokens = roundTrip('a ``lit `tick` span`` b');

    // Assert
    should(ofType(tokens, 'inlineCode')).deepEqual(['``lit `tick` span``']);
  });

  test('should leave an unclosed backtick as plain text', () => {
    // Act
    const tokens = roundTrip('typing `not done');

    // Assert
    should(ofType(tokens, 'inlineCode')).deepEqual([]);
    should(types(tokens)).deepEqual(['text']);
  });

  test('should keep a backslash literal so it cannot escape a closing backtick', () => {
    // Act
    const tokens = roundTrip('`a \\` b`');

    // Assert
    should(ofType(tokens, 'inlineCode')).deepEqual(['`a \\`']);
  });
});

describe('tokenizeMarkdown emphasis', () => {
  test('should separate emphasis content from its delimiter marks', () => {
    // Act & Assert
    should(types(roundTrip('**b**'))).deepEqual(['mark', 'bold', 'mark']);
    should(types(roundTrip('*i*'))).deepEqual(['mark', 'italic', 'mark']);
    should(types(roundTrip('___bi___'))).deepEqual(['mark', 'boldItalic', 'mark']);
  });

  test('should read spaced asterisks as arithmetic, not emphasis', () => {
    // Act & Assert
    should(types(roundTrip('a * b * c'))).deepEqual(['text']);
  });

  test('should never open a span on an escaped delimiter', () => {
    // Act & Assert
    should(types(roundTrip('\\*nope\\*'))).deepEqual(['text']);
  });

  test('should leave a trailing delimiter with nothing after it as plain text', () => {
    // Act & Assert — the mid-keystroke state: the reader has typed the opener only.
    should(types(roundTrip('a **'))).deepEqual(['text']);
  });

  test('should give inline code precedence when it opens first', () => {
    // Act
    const tokens = roundTrip('`**code**`');

    // Assert
    should(ofType(tokens, 'inlineCode')).deepEqual(['`**code**`']);
  });

  test('should keep inline code precedence inside emphasis', () => {
    // Act
    const tokens = roundTrip('**bold `code` tail**');

    // Assert
    should(ofType(tokens, 'inlineCode')).deepEqual(['`code`']);
    should(ofType(tokens, 'bold')).deepEqual(['bold ', ' tail']);
  });

  test('should keep a link inside emphasis as a link', () => {
    // Act
    const tokens = roundTrip('**see [docs](https://x.dev)**');

    // Assert
    should(ofType(tokens, 'linkText')).deepEqual(['[docs]']);
    should(ofType(tokens, 'linkUrl')).deepEqual(['(https://x.dev)']);
  });

  test('should not let an escaped delimiter close emphasis', () => {
    // Act
    const tokens = roundTrip('*a \\* b*');

    // Assert
    should(ofType(tokens, 'italic')).deepEqual(['a \\* b']);
  });

  test('should not treat underscores inside identifiers as delimiters', () => {
    // Act & Assert
    should(types(roundTrip('foo_bar_baz'))).deepEqual(['text']);
    should(types(roundTrip('alpha__beta__gamma'))).deepEqual(['text']);
    should(types(roundTrip('α_β_γ'))).deepEqual(['text']);
  });

  test('should still delimit emphasis at punctuation boundaries', () => {
    // Act & Assert
    should(types(roundTrip('(_ok_)'))).deepEqual(['text', 'mark', 'italic', 'mark', 'text']);
  });

  test('should skip an intraword underscore run while looking for a closer', () => {
    // Act — the first candidate closer is intraword, so the later one must win.
    const tokens = roundTrip('_open a_b done_');

    // Assert
    should(ofType(tokens, 'italic')).deepEqual(['open a_b done']);
  });
});

describe('tokenizeMarkdown block-level colouring', () => {
  test('should colour a whole heading line, hashes included', () => {
    // Act
    const tokens = roundTrip('# One\n###### Six\n####### seven is not a heading');

    // Assert
    should(ofType(tokens, 'heading')).deepEqual(['# One', '###### Six']);
  });

  test('should not read a hash without a following space as a heading', () => {
    // Act & Assert
    should(ofType(roundTrip('#hashtag'), 'heading')).deepEqual([]);
  });

  test('should colour bullet, ordered and indented list markers', () => {
    // Act
    const tokens = roundTrip('- a\n* b\n+ c\n12. d\n  - indented');

    // Assert
    should(ofType(tokens, 'listMarker')).deepEqual(['- ', '* ', '+ ', '12. ', '  - ']);
  });

  test('should not read a bare dash as a list marker yet', () => {
    // Act & Assert
    should(ofType(roundTrip('-'), 'listMarker')).deepEqual([]);
  });

  test('should colour nested blockquote markers and the markdown after them', () => {
    // Act
    const tokens = roundTrip('> > quoted **bold**');

    // Assert
    should(ofType(tokens, 'quoteMarker')).deepEqual(['> > ']);
    should(ofType(tokens, 'bold')).deepEqual(['bold']);
  });

  test('should colour both the marker and the heading of a quoted heading', () => {
    // Act
    const tokens = roundTrip('> # title');

    // Assert
    should(types(tokens)).deepEqual(['quoteMarker', 'heading']);
  });
});

describe('tokenizeMarkdown links', () => {
  test('should split an inline link into text and url, punctuation included', () => {
    // Act
    const tokens = roundTrip('see [docs](https://x.dev/a) ok');

    // Assert
    should(ofType(tokens, 'linkText')).deepEqual(['[docs]']);
    should(ofType(tokens, 'linkUrl')).deepEqual(['(https://x.dev/a)']);
  });

  test('should leave half-typed links as plain text', () => {
    // Act & Assert
    should(types(roundTrip('[label](unclosed'))).deepEqual(['text']);
    should(types(roundTrip('[label only]'))).deepEqual(['text']);
  });
});
