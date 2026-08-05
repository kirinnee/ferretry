import { describe, it } from 'bun:test';
import should from 'should';
import {
  configuredReferences,
  earnedRecipes,
  expandSecretReferences,
  recipeOrigin,
  redactJsonValue,
  redactSecretValues,
  resolveChildEnvironment,
  UnknownSecretError,
} from '../../../src/lib/secrets/index.ts';

const TOKEN = 'sk-live-0123456789';
const OTHER = 'pw-abcdefghij';

function values(entries: Record<string, string> = { TOKEN }): ReadonlyMap<string, string> {
  return new Map(Object.entries(entries));
}

describe('expanding a reference', () => {
  it('should substitute the value a reference names', () => {
    // Arrange / Act
    const expanded = expandSecretReferences('Bearer ${secret:TOKEN}', values());

    // Assert
    should(expanded).equal(`Bearer ${TOKEN}`);
  });

  it('should leave text with no reference untouched', () => {
    should(expandSecretReferences('plain text', values())).equal('plain text');
  });

  it('should refuse rather than substitute an empty string', () => {
    // Arrange / Act / Assert — the whole point: an empty substitution is a 401 twenty minutes later
    // with nothing to point at.
    should(() => expandSecretReferences('Bearer ${secret:MISSING}', values())).throw(/MISSING/u);
  });

  it('should name EVERY missing secret, once each', () => {
    // Arrange
    let raised: UnknownSecretError | undefined;

    // Act
    try {
      expandSecretReferences('${secret:A} ${secret:B} ${secret:A}', values());
    } catch (error) {
      raised = error as UnknownSecretError;
    }

    // Assert
    should(raised).be.instanceof(UnknownSecretError);
    should(raised?.names).deepEqual(['A', 'B']);
  });
});

describe('the child environment', () => {
  it('should export each named secret under its own name', () => {
    should(resolveChildEnvironment(['TOKEN'], {}, values())).deepEqual({ TOKEN });
  });

  it('should let a configured entry compose the plain export', () => {
    // Arrange / Act
    const environment = resolveChildEnvironment(['TOKEN'], { AUTH: 'Bearer ${secret:TOKEN}' }, values());

    // Assert
    should(environment).deepEqual({ TOKEN, AUTH: `Bearer ${TOKEN}` });
  });

  it('should let a configured entry override the plain export', () => {
    should(resolveChildEnvironment(['TOKEN'], { TOKEN: 'literal-override' }, values())).deepEqual({
      TOKEN: 'literal-override',
    });
  });

  it('should refuse a named secret this daemon does not hold, before anything is spawned', () => {
    should(() => resolveChildEnvironment(['ABSENT'], {}, values())).throw(/ABSENT/u);
  });

  it('should refuse a configured entry naming a secret it does not hold', () => {
    should(() => resolveChildEnvironment([], { AUTH: '${secret:ABSENT}' }, values())).throw(/ABSENT/u);
  });
});

describe('earning a recipe', () => {
  const RECIPES = {
    STAGING_AUTH: 'Bearer ${secret:STAGING_KEY}',
    PRODUCTION_AUTH: 'Bearer ${secret:PRODUCTION_KEY}',
    PLAIN: 'no reference here',
  };

  it('should give a caller only the recipes whose secrets it asked for', () => {
    should(earnedRecipes(RECIPES, ['STAGING_KEY'])).deepEqual({
      STAGING_AUTH: 'Bearer ${secret:STAGING_KEY}',
      PLAIN: 'no reference here',
    });
  });

  it('should withhold a recipe naming a secret the caller did not ask for', () => {
    // Assert — an operator's convenience must never widen a caller's request into a leak.
    should(Object.keys(earnedRecipes(RECIPES, []))).deepEqual(['PLAIN']);
  });

  it('should give both when both are asked for', () => {
    should(Object.keys(earnedRecipes(RECIPES, ['STAGING_KEY', 'PRODUCTION_KEY'])).sort()).deepEqual([
      'PLAIN',
      'PRODUCTION_AUTH',
      'STAGING_AUTH',
    ]);
  });
});

describe('configured references', () => {
  it('should name each reference with the entry it came from', () => {
    should(configuredReferences({ AUTH: 'Bearer ${secret:TOKEN}' })).deepEqual([
      { name: 'TOKEN', origin: 'config/daemon.json → secretEnvironment.AUTH' },
    ]);
  });

  it('should report nothing for an entry with no reference', () => {
    should(configuredReferences({ PLAIN: 'literal' })).deepEqual([]);
  });

  it('should spell an origin an operator can go and find', () => {
    should(recipeOrigin('AUTH')).equal('config/daemon.json → secretEnvironment.AUTH');
  });
});

describe('redaction', () => {
  it('should mask a value wherever it appears', () => {
    should(redactSecretValues(`before ${TOKEN} after ${TOKEN}`, values())).equal(
      'before [redacted:TOKEN] after [redacted:TOKEN]',
    );
  });

  it('should leave text holding no value untouched', () => {
    should(redactSecretValues('nothing to see', values())).equal('nothing to see');
  });

  it('should mask the LONGER value first when one contains the other', () => {
    // Arrange — the short value is a prefix of the long one. Masking short-first would leave the
    // remaining characters of the long secret in plain view.
    const nested = values({ SHORT: 'abcdefgh', LONG: 'abcdefgh-tail' });

    // Act
    const redacted = redactSecretValues('here is abcdefgh-tail', nested);

    // Assert
    should(redacted).equal('here is [redacted:LONG]');
  });

  it('should mask every string inside JSON without changing its shape', () => {
    // Arrange
    const data = { header: `Bearer ${TOKEN}`, list: [OTHER, 7, null, true], nested: { deep: TOKEN } };

    // Act
    const redacted = redactJsonValue(data, values({ TOKEN, OTHER }));

    // Assert
    should(redacted).deepEqual({
      header: 'Bearer [redacted:TOKEN]',
      list: ['[redacted:OTHER]', 7, null, true],
      nested: { deep: '[redacted:TOKEN]' },
    });
  });

  it('should pass a non-string scalar through unchanged', () => {
    should(redactJsonValue(42, values())).equal(42);
    should(redactJsonValue(null, values())).equal(null);
  });

  it('should NOT recognise a transformed value — the residual hole, asserted so it is not a surprise', () => {
    // Arrange — this is the documented limit of literal scrubbing, and a test that pretends
    // otherwise would be worse than no test.
    const encoded = Buffer.from(TOKEN).toString('base64');

    // Act
    const redacted = redactSecretValues(encoded, values());

    // Assert
    should(redacted).equal(encoded);
  });
});

describe('redaction refuses to destroy the text it is protecting', () => {
  it('should skip an empty value rather than mask between every character', () => {
    // Arrange — `''` is a separator that splits a string into characters. One empty entry would
    // return the whole text with a mask between every letter: unreadable, and hiding nothing.
    const withEmpty = values({ REAL: TOKEN, BROKEN: '' });

    // Act
    const redacted = redactSecretValues(`prefix ${TOKEN} suffix`, withEmpty);

    // Assert
    should(redacted).equal('prefix [redacted:REAL] suffix');
  });

  it('should skip an empty value in JSON too', () => {
    should(redactJsonValue({ note: 'plain text' }, values({ BROKEN: '' }))).deepEqual({ note: 'plain text' });
  });
});
