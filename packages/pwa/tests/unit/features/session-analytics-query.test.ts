import { describe, expect, it } from 'bun:test';

import {
  analyticsIdQuery,
  sessionAnalyticsDefaultQuery,
  sessionAnalyticsStarterQueries,
} from '../../../src/features/analytics/session-analytics-query.ts';

/**
 * The scope matcher is the whole security property of a session-scoped
 * analytics surface, so every escaping and operator rule is asserted against a
 * literal expected string rather than a regular expression.
 */
const idQueryCases: readonly { readonly name: string; readonly id: string; readonly expected: string }[] = [
  { name: 'an ordinary id keeps the compact `=` spelling', id: 'ms59', expected: '{id="ms59"}' },
  {
    name: 'a generated kteam-style id survives its hyphens and hex',
    id: 'ms9nnbuq-c32737d2',
    expected: '{id="ms9nnbuq-c32737d2"}',
  },
  {
    name: 'a double quote is escaped instead of terminating the matcher',
    id: 'session"a',
    expected: '{id="session\\"a"}',
  },
  { name: 'a backslash is escaped', id: 'session\\b', expected: '{id="session\\\\b"}' },
  {
    name: 'a quote and a backslash together stay unambiguous',
    id: 'session"a\\b',
    expected: '{id="session\\"a\\\\b"}',
  },
  { name: 'a newline becomes its JSON escape', id: 'a\nb', expected: '{id="a\\nb"}' },
  { name: 'a tab becomes its JSON escape', id: 'a\tb', expected: '{id="a\\tb"}' },
  { name: 'a space is preserved inside the quotes', id: 'two words', expected: '{id="two words"}' },
  { name: 'non-ASCII text is preserved', id: 'sesión-ø', expected: '{id="sesión-ø"}' },
  { name: 'an empty id still produces a well-formed empty matcher', id: '', expected: '{id=""}' },
  { name: 'a `*` switches to the literal `==` operator', id: 'session-*', expected: '{id=="session-*"}' },
  { name: 'a `?` switches to the literal `==` operator', id: 'ms?9', expected: '{id=="ms?9"}' },
  { name: 'a leading `*` is still literal', id: '*', expected: '{id=="*"}' },
  {
    name: 'glob metacharacters and quoting compose',
    id: 'a*b"c\\d',
    expected: '{id=="a*b\\"c\\\\d"}',
  },
  {
    name: 'a `?` anywhere in the id is enough to force `==`',
    id: 'trailing?',
    expected: '{id=="trailing?"}',
  },
];

describe('analyticsIdQuery', () => {
  for (const { name, id, expected } of idQueryCases) {
    it(name, () => {
      // Act
      const actual = analyticsIdQuery(id);

      // Assert
      expect(actual).toBe(expected);
    });
  }

  it('never emits a bare glob character outside the literal operator', () => {
    for (const { id, expected } of idQueryCases) {
      // Assert — a globbing `=` may never be paired with `*` or `?`
      expect(/[*?]/.test(id) ? expected.startsWith('{id==') : expected.startsWith('{id="')).toBe(true);
    }
  });
});

describe('sessionAnalyticsDefaultQuery', () => {
  it('teaches aggregation, grouping, and the exact session scope in one line', () => {
    // Act
    const actual = sessionAnalyticsDefaultQuery('ms59');

    // Assert
    expect(actual).toBe('sum by (model) {id="ms59"}');
  });

  it('carries the literal operator through for a globbing id', () => {
    // Act
    const actual = sessionAnalyticsDefaultQuery('session-*');

    // Assert
    expect(actual).toBe('sum by (model) {id=="session-*"}');
  });

  it('is built from the same matcher the scope helper produces', () => {
    for (const { id } of idQueryCases) {
      // Assert
      expect(sessionAnalyticsDefaultQuery(id)).toBe(`sum by (model) ${analyticsIdQuery(id)}`);
    }
  });
});

describe('sessionAnalyticsStarterQueries', () => {
  it('exposes every aggregation the language supports, in a stable order', () => {
    // Act
    const starters = sessionAnalyticsStarterQueries('ms59');

    // Assert
    expect(starters.map(starter => starter.label)).toEqual([
      'sum',
      'avg',
      'min',
      'max',
      'pricing coverage',
      'identity check',
      'count',
    ]);
    expect(starters.map(starter => starter.id)).toEqual([
      'sum',
      'avg',
      'min',
      'max',
      'pricing-coverage',
      'identity-check',
      'count',
    ]);
  });

  it('writes a real, runnable query for each aggregation', () => {
    // Act
    const starters = sessionAnalyticsStarterQueries('ms59');

    // Assert
    expect(starters.map(starter => starter.query)).toEqual([
      'sum by (model) {id="ms59"}',
      'avg by (model) {id="ms59"}',
      'min by (model) {id="ms59"}',
      'max by (model) {id="ms59"}',
      'sum by (token_data) {id="ms59"}',
      'count by (model, pricing_model) {id="ms59"}',
      'count by (status) {id="ms59"}',
    ]);
  });

  it('adds honest pricing-coverage and model-identity checks through the same safe session scope', () => {
    const starters = sessionAnalyticsStarterQueries('session-*');
    const pricingCoverage = starters.find(starter => starter.id === 'pricing-coverage');
    const identityCheck = starters.find(starter => starter.id === 'identity-check');

    expect(pricingCoverage?.query).toBe('sum by (token_data) {id=="session-*"}');
    expect(pricingCoverage?.hint).toContain('equivalent-cost coverage');
    expect(identityCheck?.query).toBe('count by (model, pricing_model) {id=="session-*"}');
    expect(identityCheck?.hint).toContain('different values');
  });

  it('groups count by status, because count deliberately has no measures to attribute to a model', () => {
    // Act
    const starters = sessionAnalyticsStarterQueries('ms59');
    const count = starters.at(-1);

    // Assert
    expect(count?.query).toBe('count by (status) {id="ms59"}');
    expect(count?.hint).toContain('no token or cost measures');
  });

  it('names equivalent API cost in the default aggregation hint', () => {
    // Act
    const starters = sessionAnalyticsStarterQueries('ms59');

    // Assert
    expect(starters[0]?.hint).toContain('equivalent API cost');
  });

  it('gives every starter a unique id and a non-empty hint', () => {
    // Act
    const starters = sessionAnalyticsStarterQueries('ms59');

    // Assert
    expect(new Set(starters.map(starter => starter.id)).size).toBe(starters.length);
    for (const starter of starters) expect(starter.hint.length).toBeGreaterThan(0);
  });

  it('scopes every starter to the one session, for every id shape', () => {
    for (const { id } of idQueryCases) {
      const scope = analyticsIdQuery(id);

      // Assert — no starter may escape the session it was built for
      for (const starter of sessionAnalyticsStarterQueries(id)) expect(starter.query.endsWith(` ${scope}`)).toBe(true);
    }
  });

  it('opens with exactly the default query, so the chips and the box agree', () => {
    for (const { id } of idQueryCases) {
      // Assert
      expect(sessionAnalyticsStarterQueries(id)[0]?.query).toBe(sessionAnalyticsDefaultQuery(id));
    }
  });
});
