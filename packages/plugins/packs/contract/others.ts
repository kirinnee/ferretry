/**
 * STAND-INS for the contracts Packs reads but does not own (§2.3: Packs `uses` Usage and Runtimes, both optional).
 *
 * `@ferretry/plugin-usage/contract` is empty on this base (the skeleton slice has not filled it), so the usage facts
 * Packs reads are declared here, structurally, exactly as today's `FleetCredentialView` carried them. The generator
 * matches ports by name: when Usage's contract lands, replace this file's `UsagePort` with an import of it in the
 * manifest and keep these shapes as the narrow view Packs wants.
 *
 * Runtimes' real port is imported (`RuntimesPort`, `RuntimeId`); what it does not yet offer — the runtime CATALOG
 * (with each runtime's model list and wrapper) and the machine's tools — is read through {@link RuntimeFactsApi}, an
 * additive pair of methods the daemon half asks of the provider when it has them (see the port-packs report).
 */
import { definePort } from '@ferretry/kernel/contract';
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

export interface UsageQuotaApi {
  /** Every login with its quota windows and budget, as the app shows them. */
  logins(): Promise<readonly PackCredentialFacts[]>;
  /** Logins the panes say are out of quota, by login id. */
  paneLimits(): Promise<ReadonlyMap<string, PaneLimit>>;
}
export const UsagePort = definePort<UsageQuotaApi>('usage');

// ─── runtime facts ───────────────────────────────────────────────────────────────────────────────────────────────

/** What Packs asks of the Runtimes provider beyond `RuntimesApi`: the catalog and the tools. */
export interface RuntimeFactsApi {
  /** Every runtime with its models, wrapper and login, as `GET /v1/runtimes` answers. */
  catalog(): Promise<readonly RuntimeView[]>;
  /** The harness CLIs on this machine and whether each is installed. */
  tools(): Promise<readonly MachineTool[]>;
}
