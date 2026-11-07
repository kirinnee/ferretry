/**
 * PEER: today's `packages/daemon/src/lib/core/{inventory,session-planner}.ts` (owner: kernel) and the
 * `FleetManifestAccount` row it extends from `packages/fleet/src/lib/manifest.ts` (`@ferretry/fleet`, owner: runtimes).
 *
 * Ferrets is core and cannot import a plugin's code (§2.1); this is the part the session code reads, injected by the
 * host.
 */
import type { CompactAt } from '../../protocol/compact-at.ts';
import type { HarnessKind } from './fleet.ts';

export type { HarnessKind } from './fleet.ts';

// --- packages/fleet/src/lib/manifest.ts (the published row, as a type) ------------------------------------------

/** The lane an account runs in. Declared, never derived from a name. */
export type AccountMode = 'interactive' | 'auto';

/** What a model catalog says about a model, carried so a picker reads one record. */
interface CatalogModelFacts {
  readonly tier?: 'best' | 'balanced' | 'fast';
  readonly context?: number;
  readonly reasoning?: boolean;
  readonly efforts?: readonly string[];
  readonly defaultEffort?: string;
}

/**
 * One model an account may be asked to serve. `available` is mandatory and explicit — there is no
 * "probably fine" default — and an unavailable entry must say why.
 */
export type FleetManifestModel =
  | (CatalogModelFacts & { readonly id: string; readonly displayName?: string; readonly available: true })
  | (CatalogModelFacts & {
      readonly id: string;
      readonly displayName?: string;
      readonly available: false;
      readonly unavailableReason: string;
    });

/** The catalog a runtime's models came from (docs/model-catalog.md). */
export interface FleetManifestModelCatalog {
  readonly id: string;
  readonly label: string;
  /** Whether the provider serves ids beyond the list, so a picker offers "Custom id…". */
  readonly customIds: boolean;
}

/** One published account row, as the fleet's manifest declares it. */
export interface FleetManifestAccount {
  readonly id: string;
  readonly kind: HarnessKind;
  readonly mode: AccountMode;
  /** ABSOLUTE PATH of the executable provisioning generated for this account, not a bare name. */
  readonly wrapper: string;
  /** Absolute path of the harness config directory this account owns. */
  readonly home: string;
  readonly displayName: string;
  /** Model this account serves when a caller names none. `null` when it names none. */
  readonly defaultModel: string | null;
  readonly models: readonly FleetManifestModel[];
  readonly modelCatalog?: FleetManifestModelCatalog;
  readonly codexCatalog?: number;
  /** Where ferrets launched on this account compact their conversation, unless one sets its own. Absent is `auto`. */
  readonly compactAt?: CompactAt;
  readonly available: boolean;
  /** Required when `available` is false, `null` otherwise. */
  readonly unavailableReason: string | null;
  /** The environment variables a profile binds to Ferretry's secret store, as `${secret:NAME}` templates. */
  readonly secretEnv: Readonly<Record<string, string>>;
}

// --- lib/core/inventory.ts --------------------------------------------------------------------------------------

/** One model an account may be asked to serve. An unavailable model must say why. */
export type CoreAccountModel = FleetManifestModel;

/**
 * One published account, as the daemon reads it: the manifest row itself, plus the executable NAME
 * derived from the path it publishes.
 */
export interface CoreAccount extends FleetManifestAccount {
  readonly agent: string;
}

/**
 * INJECTED: supplied by an adapter over the published fleet manifest.
 *
 * Answers an empty fleet for a manifest that is not there, and THROWS for one that is there and unreadable.
 * Every caller therefore fails closed by default.
 */
export interface AccountInventoryPort {
  accounts(): Promise<readonly CoreAccount[]>;
}

/**
 * Look an account up by the executable name a usage row or a running session carries. Ambiguity is
 * refused rather than resolved: two accounts sharing an executable name is a manifest defect, and
 * silently picking the first was how the source attached one account's quota to another's session.
 */
export function findAccountByAgent(accounts: readonly CoreAccount[], agent: string): CoreAccount | undefined {
  const matches = accounts.filter(account => account.agent === agent);
  return matches.length === 1 ? matches[0] : undefined;
}

/** The models an account may actually be asked for right now. */
export function servableModels(account: CoreAccount): readonly CoreAccountModel[] {
  return account.available ? account.models.filter(model => model.available) : [];
}

/** A `[1m]`-style selector, which the harness is handed with a model but the catalog never lists. */
const SELECTOR = /\[[^\]]*\]$/u;

/**
 * The catalog entry a model id names, with or without the selector a session records it with. A
 * session on `claude-opus-5-5[1m]` is ON `claude-opus-5-5`.
 */
export function declaredModel(account: CoreAccount, model: string): CoreAccountModel | undefined {
  const bare = model.replace(SELECTOR, '');
  return account.models.find(entry => entry.id === model) ?? account.models.find(entry => entry.id === bare);
}

/** Whether this account can serve the named model. An unavailable model is not servable. */
export function canServeModel(account: CoreAccount, model: string): boolean {
  const entry = declaredModel(account, model);
  return account.available && entry !== undefined && entry.available;
}

// --- lib/core/session-planner.ts --------------------------------------------------------------------------------

/** Where a session's displayed model came from. */
export type DisplayModelSource = 'harness' | 'requested' | 'account-default' | 'unknown';

export interface SessionPlanRequest {
  /** Stable session identity; the name is derived from it, never the other way round. */
  readonly id: string;
  readonly account: CoreAccount;
  readonly mode: 'auto' | 'interactive';
  /** The teammate callsign this session belongs to. */
  readonly teammate?: string;
  /** The human-facing task title. */
  readonly name?: string;
  /** The model the caller asked for. An account that cannot serve it refuses the plan. */
  readonly requestedModel?: string;
  /** An explicit parent session, which always wins over an inherited one. */
  readonly parent?: string;
  /** The session id in the launching process's environment, for inherited parentage. */
  readonly environmentSessionId?: string;
  /** A window the harness reports about itself. Ground truth when present. */
  readonly reportedWindow?: number;
}

export interface SessionPlan {
  /** The tmux-safe session name. */
  readonly tmuxName: string;
  /** The title handed to the harness, so its own surfaces agree with the session list. */
  readonly title: string | undefined;
  readonly parent: string | undefined;
  readonly model: string;
  readonly modelSource: DisplayModelSource;
  readonly contextWindow: number;
  /** How long the launch is held open for a first prompt before it is answered as backgrounded. */
  readonly startWaitMs: number;
  /** Extra harness arguments that add the remote-control surface. */
  readonly extraArgs: readonly string[];
}

/** What planning one session came to. A refusal is a planning outcome, not an exception. */
export type SessionPlanOutcome =
  | { readonly kind: 'planned'; readonly plan: SessionPlan }
  | {
      readonly kind: 'unservable-model';
      /** What the caller asked for, quoted back rather than paraphrased. */
      readonly requested: string;
      /** Why this account cannot serve it, what it does serve, and what to do about it. */
      readonly reason: string;
    };

/**
 * INJECTED: today's `SessionPlanner` class (kernel's core). The session launch service reads `plan`; the host hands
 * the planner in.
 */
export interface SessionPlanner {
  plan(request: SessionPlanRequest): SessionPlanOutcome;
  contextUsedPercent(plan: Pick<SessionPlan, 'contextWindow'>, usedTokens: number): number;
}
