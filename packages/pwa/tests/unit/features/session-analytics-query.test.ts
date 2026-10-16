import { describe, expect, it } from 'bun:test';

import { analyticsIdQuery } from '../../../src/features/analytics/session-analytics-query.ts';

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
