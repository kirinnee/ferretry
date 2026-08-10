import { describe, it } from 'bun:test';
import should from 'should';
import {
  AnalyticsQueryError,
  DEFAULT_ANALYTICS_QUERY,
  DEFAULT_SESSION_ANALYTICS_QUERY,
  MAX_ANALYTICS_GROUP_LABELS,
  MAX_ANALYTICS_QUERY_CHARS,
  matcherLikePattern,
  parseAnalyticsQuery,
  scopeAnalyticsQuery,
} from '../../src/lib/analytics-query.ts';

describe('analytics query language', () => {
  it('should default to a daily fleet aggregate', () => {
    // Act
    const actual = parseAnalyticsQuery();

    // Assert
    should(actual).deepEqual({
      source: DEFAULT_ANALYTICS_QUERY,
      canonical: DEFAULT_ANALYTICS_QUERY,
      aggregation: 'sum',
      groupBy: ['day'],
      matchers: [],
    });
  });

  it('should force an exact session scope and replace caller-supplied ids', () => {
    // Act
    const defaultScope = scopeAnalyticsQuery(undefined, 'session-1');
    const replaced = scopeAnalyticsQuery('avg by (model) {status=completed, id=some-other-session}', 'session/odd ?');
    const globId = parseAnalyticsQuery(scopeAnalyticsQuery('{id=~fleet-*}', 'one'));

    // Assert
    should(defaultScope).equal(`${DEFAULT_SESSION_ANALYTICS_QUERY} {id=session-1}`);
    should(replaced).equal('avg by (model) {status=completed, id=="session/odd ?"}');
    should(globId.matchers).deepEqual([{ label: 'id', op: '=', value: 'one', wildcard: false }]);
  });

  it('should preserve leading/trailing whitespace and escaped control chars through the scope round trip', () => {
    // Arrange — trim must gate all-whitespace ids only; the exact bytes must survive unchanged
    const spaced = '  session-1  ';
    const control = 'line\nnext\tvalue';

    // Act
    const spacedRound = parseAnalyticsQuery(scopeAnalyticsQuery(undefined, spaced));
    const controlRound = parseAnalyticsQuery(scopeAnalyticsQuery(undefined, control));
    const controlCanonical = scopeAnalyticsQuery(undefined, control);

    // Assert — exact bytes round-trip through the canonical form
    should(spacedRound.matchers[0]).deepEqual({ label: 'id', op: '=', value: spaced, wildcard: false });
    should(controlRound.matchers[0]).deepEqual({ label: 'id', op: '=', value: control, wildcard: false });
    should(controlCanonical).equal(`${DEFAULT_SESSION_ANALYTICS_QUERY} {id="line\\nnext\\tvalue"}`);
  });

  it('should reject all-whitespace session ids regardless of whitespace kind', () => {
    // Arrange
    const whitespaces = ['   ', '\t\t', '\n \t', ' \r\n '];

    // Act / Assert
    for (const ws of whitespaces) {
      let actual: unknown;
      try {
        scopeAnalyticsQuery(undefined, ws);
      } catch (error) {
        actual = error;
      }

      should(actual).be.instanceof(AnalyticsQueryError);
      should((actual as Error).message).containEql('exact session id');
    }
  });

  it('should decode full JSON escapes (CR/BS/FF/NUL and a surrogate pair) in double-quoted values', () => {
    // Act — explicit JSON escapes the old n/t-only decoder mis-read as literal letters
    const carriage = parseAnalyticsQuery('{id="a\\rb"}').matchers[0];
    const backspace = parseAnalyticsQuery('{id="a\\bb"}').matchers[0];
    const formFeed = parseAnalyticsQuery('{id="a\\fb"}').matchers[0];
    const nul = parseAnalyticsQuery('{id="a\\u0000b"}').matchers[0];
    const surrogate = parseAnalyticsQuery('{id="\\uD835\\uDD4F"}').matchers[0];

    // Assert
    should(carriage).deepEqual({ label: 'id', op: '=', value: 'a\rb', wildcard: false });
    should(backspace).deepEqual({ label: 'id', op: '=', value: 'a\bb', wildcard: false });
    should(formFeed).deepEqual({ label: 'id', op: '=', value: 'a\fb', wildcard: false });
    should(nul).deepEqual({ label: 'id', op: '=', value: 'a\x00b', wildcard: false });
    should(surrogate).deepEqual({ label: 'id', op: '=', value: '𝕏', wildcard: false });
  });

  it('should round-trip control-char session ids (CR/BS/FF/NUL) exactly through the scope', () => {
    // Arrange — canonical JSON.stringify escapes these; double-quoted decoding must reverse them
    const ids = ['a\rb', 'a\bb', 'a\fb', 'a\x00b'];

    // Act / Assert
    for (const raw of ids) {
      const round = parseAnalyticsQuery(scopeAnalyticsQuery(undefined, raw));
      should(round.matchers[0]).deepEqual({ label: 'id', op: '=', value: raw, wildcard: false });
    }
  });

  it('should parse aggregation, grouping, aliases, and quoted matcher values', () => {
    // Act
    const actual = parseAnalyticsQuery(
      `avg by (model, harness) {label="ui-r28-*", status=completed, agent=~claude-*, cwd='/tmp/a,b'}`,
    );

    // Assert
    should(actual.aggregation).equal('avg');
    should(actual.groupBy).deepEqual(['model', 'harness']);
    should(actual.matchers).deepEqual([
      { label: 'label', op: '=', value: 'ui-r28-*', wildcard: true },
      { label: 'status', op: '=', value: 'completed', wildcard: false },
      { label: 'agent', op: '=~', value: 'claude-*', wildcard: true },
      { label: 'cwd', op: '=', value: '/tmp/a,b', wildcard: false },
    ]);
    should(actual.canonical).equal(
      'avg by (model, harness) {label=ui-r28-*, status=completed, agent=~claude-*, cwd="/tmp/a,b"}',
    );
  });

  it('should accept every label the schema names, including one added after the grammar was written', () => {
    // The grammar derives its label set from `AnalyticsLabelSchema`. A respelled copy would prove no
    // wrong member and still leave a new one unqueryable, with "unknown analytics label" as the only
    // symptom — so `pricing_model` working here is the derivation being exercised, not a spelling.
    // Act
    const actual = parseAnalyticsQuery('sum by (pricing_model) {pricing_model=~claude-*}');

    // Assert
    should(actual.groupBy).deepEqual(['pricing_model']);
    should(actual.matchers).deepEqual([{ label: 'pricing_model', op: '=~', value: 'claude-*', wildcard: true }]);
  });

  it('should decode quoted escapes and omit empty matcher segments', () => {
    // Act
    const actual = parseAnalyticsQuery(
      `{label="line\\nnext\\tvalue\\"", mode='single\\nnext\\tvalue\\q',, status=completed,}`,
    );

    // Assert
    should(actual.matchers.map(matcher => matcher.value)).deepEqual([
      'line\nnext\tvalue"',
      'single\nnext\tvalueq',
      'completed',
    ]);
  });

  it('should preserve exact wildcard characters through canonical round trips', () => {
    // Arrange
    const source = '{label==literal-*?}';

    // Act
    const parsed = parseAnalyticsQuery(source);
    const reparsed = parseAnalyticsQuery(parsed.canonical);

    // Assert
    should(parsed.matchers[0]).deepEqual({ label: 'label', op: '=', value: 'literal-*?', wildcard: false });
    should(reparsed).deepEqual(parsed);
  });

  it('should convert globs into escaped SQL LIKE patterns', () => {
    // Act
    const actual = matcherLikePattern('a%_\\*?');

    // Assert
    should(actual).equal('a\\%\\_\\\\%_');
  });

  it.each([
    { source: 'sum by (planet)', message: 'unknown analytics label' },
    { source: 'avg by model', message: 'grouping must look like' },
    { source: 'sum by (model) trailing', message: 'unexpected analytics query suffix' },
    { source: 'by (model)', message: 'requires an aggregation' },
    { source: 'sum by ()', message: 'needs at least one label' },
    { source: 'sum by (model, model)', message: 'duplicate grouping label' },
    { source: 'sum by (id, model, harness, mode, status)', message: `at most ${MAX_ANALYTICS_GROUP_LABELS}` },
    { source: '{planet=earth}', message: 'unknown analytics label' },
    { source: '{status}', message: 'could not parse filter matcher' },
    { source: '{tree=session-*}', message: 'tree filters take one exact session id' },
    { source: '{label="unterminated}', message: 'unterminated quoted filter value' },
    { source: '{label="bad\\x"}', message: 'malformed double-quoted filter value' },
  ])('should reject $message failures', ({ source, message }) => {
    // Act
    let actual: unknown;
    try {
      parseAnalyticsQuery(source);
    } catch (error) {
      actual = error;
    }

    // Assert
    should(actual).be.instanceof(AnalyticsQueryError);
    should((actual as Error).message).containEql(message);
  });

  it('should reject empty scopes and overlong queries', () => {
    // Arrange
    const tooLong = 'x'.repeat(MAX_ANALYTICS_QUERY_CHARS + 1);

    // Act
    let emptyScope: unknown;
    let overlong: unknown;
    try {
      scopeAnalyticsQuery('sum', '  ');
    } catch (error) {
      emptyScope = error;
    }
    try {
      parseAnalyticsQuery(tooLong);
    } catch (error) {
      overlong = error;
    }

    // Assert
    should((emptyScope as Error).message).containEql('exact session id');
    should((overlong as Error).message).containEql(`${MAX_ANALYTICS_QUERY_CHARS} characters`);
  });
});
