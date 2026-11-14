/**
 * The narrow views of what Packs reads but does not own (§2.3: Packs `uses` Logins and Runtimes, both optional).
 *
 * The login facts Packs reads are declared here, structurally, exactly as today's `FleetCredentialView` carried them;
 * Logins' own `LoginView` is assignable to them. They are views, never ports: the generator matches ports by name.
 *
 * Runtimes' real port is imported (`RuntimesPort`, `RuntimeId`); what it does not yet offer — the runtime CATALOG
 * (with each runtime's model list and wrapper) and the machine's tools — is read through {@link RuntimeFactsApi}, an
 * additive pair of methods the daemon half asks of the provider when it has them (see the port-packs report).
 */
import type { MachineTool, RuntimeView } from '@ferretry/plugin-runtimes/contract';

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

/**
 * What Packs reads of each login's sign-in, quota and budget. It is NOT a port: a port is matched by name, and a
 * second shape under the name `usage` is handed the real Usage plugin's object, which has none of these methods. The
 * facts come from the Logins port (`daemon/adapters/login-quota.ts`).
 */
export interface PackQuotaSource {
  /** Every login with its quota windows and budget, as the app shows them. */
  credentials(): Promise<readonly PackCredentialFacts[]>;
  /** Logins the panes say are out of quota, by login id. */
  paneLimits(): Promise<ReadonlyMap<string, PaneLimit>>;
}

// ─── runtime facts ───────────────────────────────────────────────────────────────────────────────────────────────

/** What Packs asks of the Runtimes provider beyond `RuntimesApi`: the catalog and the tools. */
export interface RuntimeFactsApi {
  /** Every runtime with its models, wrapper and login, as `GET /v1/runtimes` answers. */
  catalog(): Promise<readonly RuntimeView[]>;
  /** The harness CLIs on this machine and whether each is installed. */
  tools(): Promise<readonly MachineTool[]>;
}
