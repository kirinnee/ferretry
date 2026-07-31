import { describe, it } from 'bun:test';
import { BROWSER_MAX_HEIGHT, BROWSER_MAX_WIDTH, BROWSER_MIN_HEIGHT, BROWSER_MIN_WIDTH } from '@ferretry/protocol';
import should from 'should';
import { optionalText, parseLoginMinutes, parseViewport, requireText } from '../../../src/lib/browser/parse';
import { BrowserCommandError } from '../../../src/lib/browser/types';

describe('login duration', () => {
  it('should accept a whole number of minutes', () => {
    // Act + Assert
    should(parseLoginMinutes('15')).equal(15);
    should(parseLoginMinutes('1')).equal(1);
  });

  it('should reject anything that is not a whole number', () => {
    // Act + Assert
    for (const raw of ['', '  ', 'ten', '1.5', 'NaN', 'Infinity']) {
      should(() => parseLoginMinutes(raw)).throw(BrowserCommandError);
    }
  });

  it('should reject a duration below one minute', () => {
    // Act + Assert
    should(() => parseLoginMinutes('0')).throw(/at least 1/u);
    should(() => parseLoginMinutes('-5')).throw(/at least 1/u);
  });

  it('should leave the maximum to the daemon, which re-validates every request', () => {
    // Act + Assert — kteam mirrored the bound into the CLI, where it could drift out of date.
    should(parseLoginMinutes('100000')).equal(100_000);
  });
});

describe('viewport parsing', () => {
  it('should accept a size inside the protocol bounds', () => {
    // Act
    const actual = parseViewport('1280', '800');

    // Assert
    should(actual).deepEqual({ width: 1_280, height: 800 });
  });

  it('should accept the exact bounds', () => {
    // Act + Assert
    should(parseViewport(String(BROWSER_MIN_WIDTH), String(BROWSER_MIN_HEIGHT))).deepEqual({
      width: BROWSER_MIN_WIDTH,
      height: BROWSER_MIN_HEIGHT,
    });
    should(parseViewport(String(BROWSER_MAX_WIDTH), String(BROWSER_MAX_HEIGHT))).deepEqual({
      width: BROWSER_MAX_WIDTH,
      height: BROWSER_MAX_HEIGHT,
    });
  });

  it('should reject a fractional size the daemon would refuse anyway', () => {
    // Act + Assert — kteam accepted any finite number and let the round trip fail.
    should(() => parseViewport('800.5', '600')).throw(/whole number/u);
    should(() => parseViewport('800', '600.5')).throw(/whole number/u);
    should(() => parseViewport('wide', '600')).throw(/whole number/u);
  });

  it('should reject a width outside the supported range', () => {
    // Act + Assert
    should(() => parseViewport(String(BROWSER_MIN_WIDTH - 1), '600')).throw(/width must be between/u);
    should(() => parseViewport(String(BROWSER_MAX_WIDTH + 1), '600')).throw(/width must be between/u);
  });

  it('should reject a height outside the supported range', () => {
    // Act + Assert
    should(() => parseViewport('800', String(BROWSER_MIN_HEIGHT - 1))).throw(/height must be between/u);
    should(() => parseViewport('800', String(BROWSER_MAX_HEIGHT + 1))).throw(/height must be between/u);
  });
});

describe('positional text', () => {
  it('should return trimmed text and reject a blank required argument', () => {
    // Act + Assert
    should(requireText('  #go  ', 'selector')).equal('#go');
    should(() => requireText('   ', 'selector')).throw(/selector is required/u);
  });

  it('should treat blank optional text as absent', () => {
    // Act + Assert
    should(optionalText('  main ')).equal('main');
    should(optionalText('   ')).be.undefined();
    should(optionalText(undefined)).be.undefined();
  });
});
