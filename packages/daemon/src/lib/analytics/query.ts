/**
 * Compatibility re-export: the analytics query grammar now lives in `@ferretry/protocol` so the PWA
 * (which cannot import `@ferretry/daemon`) shares one parser with the daemon. This shim preserves the
 * historical `packages/daemon/src/lib/analytics/query.ts` import path and the daemon barrel's public
 * surface without duplicating the grammar. See `protocol/src/lib/analytics-query.ts` for the source of
 * truth.
 */
export {
  AnalyticsQueryError,
  DEFAULT_ANALYTICS_QUERY,
  DEFAULT_SESSION_ANALYTICS_QUERY,
  MAX_ANALYTICS_GROUP_LABELS,
  MAX_ANALYTICS_QUERY_CHARS,
  matcherLikePattern,
  parseAnalyticsQuery,
  scopeAnalyticsQuery,
} from '@ferretry/protocol';
