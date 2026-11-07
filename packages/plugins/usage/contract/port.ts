import { definePort } from '@ferretry/kernel/contract';
import type { ProviderQuotaReading } from '@ferretry/plugin-logins/contract';
import type { AnalyticsResponse } from './analytics.ts';
import type {
  AnalyticsPricingPatch,
  AnalyticsPricingSyncApply,
  AnalyticsPricingSyncPreview,
  AnalyticsPricingSyncPreviewRequest,
  AnalyticsPricingView,
} from './analytics-pricing-api.ts';
import type { LoginId } from './ids.ts';
import type { LoginPause } from './pause.ts';
import type { UsageFeedView } from './feed.ts';
import type { PerformanceProfileView } from './performance.ts';
import type { BudgetsView } from './wire.ts';

/** What the daemon-side reader of the feed knows about how the feed is being read (a watcher may cause a provider read). */
export interface FeedRead {
  /** Somebody is looking (the app polling while a quota is on screen): environment logins' provider quotas may be read. */
  readonly watched: boolean;
}

/**
 * What Packs, Warden, Logins' views and the app read from Usage (§2.3). Reads only, apart from the owner's rate
 * catalog. Nothing returns a token: a provider is asked inside Usage and only the reading comes out.
 */
export interface UsageApi {
  /** Percent of the 5-hour/weekly quota left for a login (the tighter of the two), or `undefined` when unknown. */
  headroomPercent(login: string): Promise<number | undefined>;
  /** The account-health feed: one cached reading per daemon, shared by every reader. */
  feed(read: FeedRead): Promise<UsageFeedView>;
  /** The pauses in force now (synchronous, memory-only: `start.decide` and Packs call it on every start/recommend). */
  pauses(): readonly LoginPause[];
  pauseOf(login: LoginId): LoginPause | undefined;
  /** Every budgeted login's standing. */
  budgets(): Promise<BudgetsView>;
  /** The last provider quota reading for a login, when it has one. */
  quota(login: LoginId): Promise<ProviderQuotaReading | undefined>;
  /** One insight query over the index; `session` scopes it to a ferret; `timeZone` is the zone days are read in. */
  insights(request: {
    readonly query?: string;
    readonly session?: string;
    readonly timeZone?: string;
  }): Promise<AnalyticsResponse>;
  pricing(): Promise<AnalyticsPricingView>;
  patchPricing(patch: AnalyticsPricingPatch): Promise<AnalyticsPricingView>;
  previewPricing(request: AnalyticsPricingSyncPreviewRequest): Promise<AnalyticsPricingSyncPreview>;
  applyPricing(request: AnalyticsPricingSyncApply): Promise<AnalyticsPricingView>;
  startProfile(seconds: number): PerformanceProfileView;
  profile(id: string): PerformanceProfileView | undefined;
}
export const UsagePort = definePort<UsageApi>('usage');

/** The read models others and the app may call (`manifest.data.readModels`). */
export const USAGE_READ_MODELS = ['feed', 'pauses', 'budgets', 'quota', 'insights', 'pricing'] as const;
