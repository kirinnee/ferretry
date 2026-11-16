/**
 * Compatibility re-export: the analytics query grammar now lives in `@ferretry/protocol` so the PWA
 * (which cannot import `@ferretry/daemon`) shares one parser with the daemon. This shim preserves the
 * historical `packages/daemon/src/lib/analytics/query.ts` import path and the daemon barrel's public
 * surface without duplicating the grammar. See `protocol/src/lib/analytics-query.ts` for the source of
 * truth.
 */
export {
  AnalyticsQueryError,
  parseAnalyticsQuery,
  scopeAnalyticsQuery,
} from '../../../contract/index.ts';
