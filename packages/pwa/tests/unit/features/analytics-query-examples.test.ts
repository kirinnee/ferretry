import { describe, expect, it } from 'bun:test';
import { parseAnalyticsQuery } from '@ferretry/protocol';

import { ANALYTICS_QUERY_EXAMPLES } from '../../../src/features/analytics/analytics-query-examples.ts';

describe('analytics query examples', () => {
  it('parse with the protocol grammar and are already canonical', () => {
    for (const example of ANALYTICS_QUERY_EXAMPLES)
      expect(parseAnalyticsQuery(example.query).canonical).toBe(example.query);
  });

  it('have unique ids and say something', () => {
    expect(new Set(ANALYTICS_QUERY_EXAMPLES.map(example => example.id)).size).toBe(ANALYTICS_QUERY_EXAMPLES.length);
    for (const example of ANALYTICS_QUERY_EXAMPLES) expect(example.hint.length).toBeGreaterThan(10);
  });
});
