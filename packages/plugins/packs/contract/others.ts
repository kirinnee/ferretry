/**
 * What Packs reads about logins, quota and runtimes, as the narrow shapes it judges readiness from.
 *
 * The ports themselves are the providers' own: Packs `uses` Runtimes (`RuntimesApi`: the catalog and tools), Logins
 * (`LoginsApi`: each login's status, windows and budget, and the model catalogs) and Usage (`UsageApi`: the feed, which
 * carries the limits a ferret's pane proved). `daemon/adapters/fleet-facts.ts` reads them; nothing here is a port.
 */
// ─── usage facts ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface UsageWindowFacts {
  readonly usedPercent?: number | undefined;
  readonly resetsAt?: string | undefined;
}

/** One budget period of a login on this machine (docs/budgets.md). */
export interface BudgetPeriodFacts {
  readonly level: 'ok' | 'over_trigger' | 'over_hard';
  readonly spentUsd: number;
  readonly trigger?: number | undefined;
  readonly hard?: number | undefined;
  readonly resetsAt: string;
}

/** What Packs reads about one login: its sign-in word, secrets it names, quota windows and budget. */
export interface PackCredentialFacts {
  readonly id: string;
  readonly status: { readonly word: 'ready' | 'refresh_due' | 'needs_sign_in' | 'checking' };
  readonly environment?: { readonly missingSecrets?: readonly string[] | undefined } | undefined;
  readonly usage: {
    readonly at?: string | undefined;
    readonly fiveHour: UsageWindowFacts;
    readonly weekly: UsageWindowFacts;
    readonly provider?:
      | {
          readonly at?: string | undefined;
          readonly exhausted?: boolean | undefined;
          readonly windows: readonly (UsageWindowFacts & {
            readonly label: '5h' | 'week' | 'month' | 'key' | 'tools';
          })[];
        }
      | undefined;
  };
  readonly budget?:
    | {
        readonly level: 'ok' | 'over_trigger' | 'over_hard';
        readonly daily?: BudgetPeriodFacts | undefined;
        readonly weekly?: BudgetPeriodFacts | undefined;
      }
    | undefined;
}

/** A login a pane proved out of quota (the harness announced a spend or usage limit). */
export interface PaneLimit {
  readonly notice: string;
  readonly spend: boolean;
  /** When the login is usable again, epoch milliseconds; absent when the harness gave no time. */
  readonly retryAt?: number | undefined;
}
