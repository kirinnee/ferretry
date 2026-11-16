import { describe, it } from 'bun:test';
import should from 'should';
import { MASK, PrivateText, spellings, WITHHELD } from '../../../cli/lib/private-text.ts';

/** Quotes, a backslash, a newline, a tab, a slash and a non-ASCII letter: every character an encoder rewrites. */
const AWKWARD = 'pa"ss\\w/rd\nline\té';

describe('the spellings of a typed value', () => {
  it('should list the text, its JSON, escaped-slash, unicode-escape and URL spellings, and each once more as JSON in JSON', () => {
    // Arrange / Act
    const listed = spellings(AWKWARD);

    // Assert
    should(listed).containEql(AWKWARD);
    should(listed).containEql(JSON.stringify(AWKWARD).slice(1, -1));
    should(listed).containEql(JSON.stringify(AWKWARD).slice(1, -1).replaceAll('/', '\\/'));
    should(listed).containEql('pa\\"ss\\\\w\\/rd\\nline\\t\\u00e9');
    should(listed).containEql(encodeURIComponent(AWKWARD));
    should(listed).containEql(encodeURIComponent(AWKWARD).replaceAll(/%[0-9A-F]{2}/gu, match => match.toLowerCase()));
    should(listed).containEql(JSON.stringify(JSON.stringify(AWKWARD).slice(1, -1)).slice(1, -1));
    should(listed.every(each => each !== '')).be.true();
  });

  it('should list longest first, so a long spelling is masked whole before a short one inside it', () => {
    // Arrange / Act
    const listed = spellings(AWKWARD);

    // Assert
    should(listed.map(each => each.length)).deepEqual([...listed.map(each => each.length)].sort((a, b) => b - a));
  });
});

describe('hiding typed text', () => {
  it('should mask a long value in its plain, JSON-escaped, slash-escaped, unicode-escaped and URL-encoded spellings', () => {
    // Arrange
    const hidden = new PrivateText([AWKWARD]);
    const json = JSON.stringify(AWKWARD).slice(1, -1);
    const spelled = [
      AWKWARD,
      json,
      json.replaceAll('/', '\\/'),
      json.replaceAll('/', '\\/').replace('\u00e9', '\\u00e9'),
      [...AWKWARD].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''),
      [...AWKWARD]
        .map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`.toUpperCase().replace('\\U', '\\u'))
        .join(''),
      encodeURIComponent(AWKWARD),
      encodeURIComponent(AWKWARD).replaceAll(/%[0-9A-F]{2}/gu, match => match.toLowerCase()),
      encodeURIComponent(AWKWARD).replaceAll('%20', '+'),
    ];

    // Act / Assert
    for (const spelling of spelled) {
      const out = hidden.clean(`echo ${spelling} done`);
      should([spelling, out]).deepEqual([spelling, `echo ${MASK} done`]);
    }
  });

  it('should mask every string and key inside structured data and keep its shape', () => {
    // Arrange
    const hidden = new PrivateText(['hunter2-pass']);

    // Act
    const clean = hidden.cleanData({
      text: 'typed hunter2-pass',
      surfaces: [{ id: 'p1', url: 'https://x.test/?q=hunter2-pass', title: 7 }],
      'hunter2-pass': true,
      matched: false,
    });

    // Assert
    should(clean).deepEqual({
      text: `typed ${MASK}`,
      surfaces: [{ id: 'p1', url: `https://x.test/?q=${MASK}`, title: 7 }],
      [MASK]: true,
      matched: false,
    });
  });

  it('should withhold a string that repeats a value too short to hide, and print the others untouched', () => {
    // Arrange
    const hidden = new PrivateText(['QZ']);

    // Act / Assert
    should(hidden.clean('the field showed QZ')).equal(WITHHELD);
    should(hidden.clean('Done on %browser:app.')).equal('Done on %browser:app.');
  });

  it('should hide even a one-character value, by withholding what repeats it', () => {
    // Arrange / Act / Assert
    should(new PrivateText(['x']).clean('field x')).equal(WITHHELD);
    should(new PrivateText(['/']).clean('a\\/b')).equal(WITHHELD);
  });

  it('should not treat the mask’s own words as a repeat of a typed value', () => {
    // Arrange
    const hidden = new PrivateText(['typed', 'abc-secret']);

    // Act
    const out = hidden.clean('x abc-secret y');

    // Assert
    should(out).equal(`x ${MASK} y`);
    should(hidden.sealed(out)).equal(out);
  });

  it('should withhold the whole output when a long value is still in it at the last look', () => {
    // Arrange
    const hidden = new PrivateText(['hunter2-pass']);

    // Act / Assert
    should(hidden.sealed('x hunter2-pass')).equal(WITHHELD);
    should(hidden.sealed('x [typed text]')).equal('x [typed text]');
  });

  it('should ask nothing of text when nothing was typed', () => {
    // Arrange
    const hidden = new PrivateText(['']);

    // Assert
    should(hidden.any).be.false();
    should(hidden.clean('anything')).equal('anything');
  });
});
