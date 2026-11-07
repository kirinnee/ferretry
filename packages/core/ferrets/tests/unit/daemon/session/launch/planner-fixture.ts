/**
 * TEST FIXTURE: today's `packages/daemon/src/lib/core/{display-model,context-window,session-shape,session-planner}.ts`
 * (owner: kernel), copied verbatim so the launch tests drive the planner the host injects in production
 * (`SessionLaunchPorts.planner`). Ferrets is core and cannot import the kernel's internals; only the tests hold this
 * copy.
 */
import {
  type CoreAccount,
  type DisplayModelSource,
  canServeModel,
  declaredModel,
  type HarnessKind,
  type SessionPlan,
  type SessionPlanOutcome,
  type SessionPlanRequest,
  type SessionPlanner as SessionPlannerPort,
  servableModels,
} from '../../../../../daemon/lib/session/peers/core.ts';

/**
 * What resolving one request for a model came to: a model, or the reason the account cannot serve
 * the one that was asked for.
 *
 * A UNION RATHER THAN A FALLBACK, and that is the entire point of the type. This resolution used to
 * be total by DROPPING an unservable request and answering with the account's default, which meant
 * every caller got a model back and none of them could tell that it was not the one asked for. The
 * model then went onto the launch argv, onto the session document and into every surface reading it,
 * so somebody who named a model got a session running a different one at a different price, in a
 * different context window, and was told nothing. Making the refusal a VALUE the compiler forces
 * every caller to answer is what stops a future call site quietly reintroducing the substitution.
 */
export type ResolvedModel =
  | { readonly kind: 'resolved'; readonly model: string; readonly source: DisplayModelSource }
  | {
      readonly kind: 'unservable';
      /** Exactly what the caller asked for, so a refusal quotes the request rather than paraphrasing it. */
      readonly requested: string;
      /** Why this account cannot serve it, what it does serve, and what to do about it. */
      readonly reason: string;
    };

const trimmed = (value: string | undefined): string | undefined => {
  const text = value?.trim();
  return text === undefined || text.length === 0 ? undefined : text;
};

/**
 * Why this account cannot serve the model somebody named — three different sentences, because they
 * send a reader to three different places.
 *
 * A model the account DECLARES unavailable already carries the operator's own reason, and that reason
 * is the most useful sentence this daemon will ever have about it: "this subscription tier does not
 * include Haiku" answers the question, where "not served" starts an investigation. A model the
 * account never mentions is a different situation with a different remedy — declare it, or name one
 * of the ones that are there — so the list of what IS served travels with both.
 */
const unservableReason = (account: CoreAccount, requested: string): string => {
  const servable = servableModels(account).map(model => model.id);
  const named = JSON.stringify(requested);
  if (servable.length === 0) return `account ${account.agent} serves no model at all, so it cannot serve ${named}`;
  const alternatives = `It serves ${servable.join(', ')} — name one of those`;
  // Not `available === false`: after the manifest's own checks, "carries a reason" and "is declared
  // unavailable" are the same fact, and reading the reason is what makes this total without a branch
  // that could print an empty why.
  const declared = declaredModel(account, requested);
  if (declared !== undefined && !declared.available)
    return `account ${account.agent} cannot serve model ${named}: ${declared.unavailableReason}. ${alternatives}, or take ${named} back into service in the fleet configuration`;
  return `account ${account.agent} does not serve model ${named}. ${alternatives}, or declare ${named} on the account in the fleet configuration`;
};

/**
 * The model a session will actually run, or the refusal that says why the request cannot be met.
 *
 * Precedence: what the harness reported about itself, then the requested model, then the account's
 * declared default. The source instead kept a table of wrapper-name regexes to undo aliases the
 * provider silently remapped, which is why a pane running one model could be listed as another. An
 * account that declares what it serves makes the table unnecessary.
 *
 * AN OBSERVED MODEL IS NOT A REQUEST, so it is answered before the servability check and never
 * refused: it is what the harness says it is running, and a report about a live session is ground
 * truth rather than something this daemon is entitled to argue with.
 */
export function resolveDisplayModel(
  account: CoreAccount,
  requestedModel?: string,
  observedModel?: string,
): ResolvedModel {
  const observed = trimmed(observedModel);
  if (observed !== undefined) return { kind: 'resolved', model: observed, source: 'harness' };
  const requested = trimmed(requestedModel);
  if (requested !== undefined)
    return canServeModel(account, requested)
      ? { kind: 'resolved', model: requested, source: 'requested' }
      : { kind: 'unservable', requested, reason: unservableReason(account, requested) };
  const fallback = account.available ? trimmed(account.defaultModel ?? undefined) : undefined;
  if (fallback !== undefined) return { kind: 'resolved', model: fallback, source: 'account-default' };
  return { kind: 'resolved', model: 'unknown', source: 'unknown' };
}

/**
 * How long a launch request is held open for the harness to paint its first prompt before the
 * launch is answered as backgrounded.
 *
 * Never failed, only backgrounded and resolved later — a slow provider is not a broken one. The
 * source recognised the slow accounts by matching their wrapper names against a regex, so renaming
 * an account silently halved its launch window; the slow set is declared here and keyed by the
 * stable account id.
 */
export interface StartWaitPolicy {
  readonly baseMs: number;
  readonly slowMs: number;
  readonly ceilingMs: number;
  /** Accounts known to need the longer window, by stable id. */
  readonly slowAccountIds: readonly string[];
}

export const defaultStartWaitPolicy: StartWaitPolicy = {
  baseMs: 45_000,
  slowMs: 90_000,
  ceilingMs: 90_000,
  slowAccountIds: [],
};

export function startWaitMs(policy: StartWaitPolicy, accountId: string): number {
  const slow = policy.slowAccountIds.includes(accountId);
  const wanted = slow ? Math.max(policy.baseMs, policy.slowMs) : policy.baseMs;
  return Math.max(0, Math.min(policy.ceilingMs, wanted));
}
/** Context accounting for a session, from whatever evidence about its model exists. */

export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const EXTENDED_CONTEXT_WINDOW = 1_000_000;

/** The marker an extended-context model carries in a configured id but never in a reported one. */
const EXTENDED_MARKER = '[1m]';

const positive = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;

/**
 * The longest matching override, so a specific model id beats a family name. An override with a
 * value that is not a positive window is ignored rather than believed.
 */
function overrideFor(model: string | undefined, overrides: Readonly<Record<string, number>>): number | undefined {
  if (model === undefined || model.length === 0) return undefined;
  const patterns = Object.keys(overrides)
    .filter(pattern => pattern.length > 0 && model.includes(pattern))
    .sort((a, b) => b.length - a.length);
  for (const pattern of patterns) {
    const window = positive(overrides[pattern]);
    if (window !== undefined) return window;
  }
  return undefined;
}

export interface ContextWindowEvidence {
  /** The model the session was configured with — the only string carrying the extended marker. */
  readonly configuredModel?: string;
  /** The model the harness reports it is actually serving; the marker is always stripped from it. */
  readonly servedModel?: string;
  /** A window the harness reports about itself. Ground truth when present. */
  readonly reportedWindow?: number;
  /** Real windows for models whose id says nothing about their size, matched by substring. */
  readonly overrides?: Readonly<Record<string, number>>;
  /** The window the account's model catalog declares for this model. Below the selector, above the default. */
  readonly declaredWindow?: number;
}

/**
 * The context evidence recorded by one live session.
 *
 * The configured model and the harness observation must stay separate.  In
 * particular, a wrapper's configured alias can say `opus` while the harness
 * reports the served `glm-5.2`; model-window overrides apply to the latter.
 * Conversely, the `[1m]` selector is retained only in configuration, not in
 * the harness report.  Keeping this projection here prevents callers that
 * compare live and target windows (notably move) from dropping either
 * half of that evidence.
 */
export interface SessionContextWindowEvidence {
  /** The model selected in the session's configuration. */
  readonly configuredModel?: string;
  /** The configured fallback when the selected model was not recorded. */
  readonly modelHint?: string;
  /** The model the harness says it is actually serving. */
  readonly observedModel?: string;
  /** A context window the harness reports about the running session. */
  readonly reportedWindow?: number;
  readonly overrides?: Readonly<Record<string, number>>;
  readonly declaredWindow?: number;
}

/**
 * The context window for a session.
 *
 * Precedence: a harness that reports its own window is believed verbatim; then configured
 * overrides, matched against the served model with the configured one as fallback; then the
 * extended-context marker; then the default.
 *
 * The marker check is the subtle one. It is a configuration convention that appears only in the
 * configured model id — a live session of such a model reports the bare id back — so deciding from
 * the served model alone gives every extended session the default window and inflates its context
 * percentage roughly fivefold. Both strings are checked.
 */
export function contextWindowFor(evidence: ContextWindowEvidence): number {
  return knownContextWindow(evidence) ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * The window the evidence STATES, or `undefined` when nothing does.
 *
 * {@link contextWindowFor} answers a planning question and so must fall back to the default; a display
 * must not. A session whose model states no size is not a 200k session — it is one whose size is
 * unknown, and a percentage computed against the default would be a guess presented as a measurement.
 */
export function knownContextWindow(evidence: ContextWindowEvidence): number | undefined {
  const reported = positive(evidence.reportedWindow);
  if (reported !== undefined) return reported;

  const served = evidence.servedModel?.trim();
  const configured = evidence.configuredModel?.trim();
  const overrides = evidence.overrides;
  if (overrides !== undefined) {
    const window = overrideFor(served !== undefined && served.length > 0 ? served : configured, overrides);
    if (window !== undefined) return window;
  }

  const extended = configured?.includes(EXTENDED_MARKER) === true || served?.includes(EXTENDED_MARKER) === true;
  if (extended) return EXTENDED_CONTEXT_WINDOW;
  return positive(evidence.declaredWindow);
}

/**
 * Resolves the context window of an existing session from its persisted
 * configuration and live harness evidence.
 *
 * This is intentionally a small semantic wrapper over {@link contextWindowFor}
 * rather than making every consumer remember which model string is configured
 * and which one is observed.  A move is destructive, so getting this
 * distinction wrong can incorrectly permit a smaller target window.
 */
export function contextWindowForSession(evidence: SessionContextWindowEvidence): number {
  return contextWindowFor(sessionWindowEvidence(evidence));
}

function sessionWindowEvidence(evidence: SessionContextWindowEvidence): ContextWindowEvidence {
  return {
    configuredModel: evidence.configuredModel ?? evidence.modelHint,
    servedModel: evidence.observedModel,
    ...(evidence.reportedWindow === undefined ? {} : { reportedWindow: evidence.reportedWindow }),
    ...(evidence.overrides === undefined ? {} : { overrides: evidence.overrides }),
    ...(evidence.declaredWindow === undefined ? {} : { declaredWindow: evidence.declaredWindow }),
  };
}

/** {@link contextWindowForSession} without the default: the window this session's evidence states, or `undefined`. */
export function knownContextWindowForSession(evidence: SessionContextWindowEvidence): number | undefined {
  return knownContextWindow(sessionWindowEvidence(evidence));
}

/** How much of the window a transcript has consumed, as a percentage that never exceeds 100. */
export function contextPercent(usedTokens: number, window: number): number {
  if (!Number.isFinite(usedTokens) || usedTokens <= 0 || window <= 0) return 0;
  return Math.min(100, Math.round((usedTokens / window) * 1000) / 10);
}

/**
 * Title-case a teammate callsign for display: `hayden` → `Hayden`, `mary-jane` → `Mary-Jane`.
 * Callsigns are lowercase letters, digits and hyphens, so capitalising each hyphen segment is the
 * whole job.
 */
function titleCaseCallsign(callsign: string): string {
  return callsign
    .split('-')
    .map(part => (part.length === 0 ? part : part[0]?.toUpperCase() + part.slice(1)))
    .join('-');
}

/**
 * The display title handed to the harness, so its own surfaces show the same `[Teammate] Task`
 * title the session list does.
 *
 * A title that already opens with a bracket is used verbatim, which keeps the prefixing idempotent:
 * a caller that hands over an already-composed title is passed through rather than doubled into
 * `[Team] [Team] …`. With no task title the bracketed callsign alone is the name, and with neither
 * the answer is nothing — passing an empty `--name` is worse than passing none.
 */
export function harnessDisplayName(config: { readonly teammate?: string; readonly name?: string }): string | undefined {
  const task = config.name?.trim();
  const teammate = config.teammate?.trim();
  const prefix = teammate === undefined || teammate.length === 0 ? undefined : `[${titleCaseCallsign(teammate)}]`;
  if (task !== undefined && task.startsWith('[')) return task;
  if (task !== undefined && task.length > 0 && prefix !== undefined) return `${prefix} ${task}`;
  return task === undefined || task.length === 0 ? prefix : task;
}

/**
 * The parent of a session being started.
 *
 * An explicit parent always wins. An unattended session started from inside another session's pane
 * inherits it, so delegated trees draw correctly in the session list and the warden's lineage. An
 * interactive session does not inherit: it is the human's own terminal, and an agent merely typed
 * the command — parenting the human under whichever agent invoked it renders the tree backwards.
 */
export function resolveParent(request: {
  readonly explicit?: string;
  readonly environmentSessionId?: string;
  readonly mode: 'auto' | 'interactive';
}): string | undefined {
  const explicit = request.explicit?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;
  if (request.mode === 'interactive') return undefined;
  const inherited = request.environmentSessionId?.trim();
  return inherited === undefined || inherited.length === 0 ? undefined : inherited;
}

const MAX_TMUX_NAME_LENGTH = 80;

/**
 * A tmux-safe session name.
 *
 * The suffix is what distinguishes one window of a session from another, so the identity is
 * truncated to make room for it rather than the whole name being cut at the end — the source cut
 * last, which could remove the suffix entirely and collide two different windows of one session.
 */
export function shellSafeSessionName(prefix: string, id: string, suffix: string): string {
  const safe = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, '-');
  const tail = `-${safe(suffix)}`;
  const head = `${safe(prefix)}-`;
  const room = Math.max(0, MAX_TMUX_NAME_LENGTH - head.length - tail.length);
  return `${head}${safe(id).slice(0, room)}${tail}`.slice(0, MAX_TMUX_NAME_LENGTH);
}

/**
 * Extra arguments that add a remote-control surface to a launch.
 *
 * The generated session name is left to the harness and only its prefix is pinned, so the remote
 * surface labels the session with the teammate it belongs to while the harness still guarantees
 * uniqueness — a fixed name would collide across relaunches of one session.
 */
export function remoteControlArgs(
  config: { readonly harness: HarnessKind; readonly teammate?: string; readonly id: string },
  prefix: string,
): readonly string[] {
  if (config.harness !== 'claude') return [];
  const teammate = config.teammate?.trim();
  const label = teammate === undefined || teammate.length === 0 ? config.id : teammate;
  return ['--chrome', '--rc', '--remote-control-session-name-prefix', `${prefix}-${label}`];
}
export interface SessionPlannerPolicy {
  readonly startWait: StartWaitPolicy;
  /** Real windows for models whose id says nothing about their size, matched by substring. */
  readonly contextWindowOverrides: Readonly<Record<string, number>>;
  /** Prefix for generated tmux session names. */
  readonly namePrefix: string;
  /** Prefix for the harness's own remote-control session names. */
  readonly remoteControlPrefix: string;
}

export class SessionPlanner implements SessionPlannerPort {
  constructor(private readonly policy: SessionPlannerPolicy) {}

  plan(request: SessionPlanRequest): SessionPlanOutcome {
    const display = resolveDisplayModel(request.account, request.requestedModel);
    // FIRST, and before anything is derived from a model. Everything below — the context window, the
    // `--model` argument, the document every surface reads — describes the model this session runs,
    // so a request the account cannot meet has to stop here rather than be answered with a plan for
    // a session nobody asked for.
    if (display.kind === 'unservable')
      return { kind: 'unservable-model', requested: display.requested, reason: display.reason };
    // What the account's catalog says the model holds, so a model whose id carries no selector still plans
    // the window it really has rather than the default.
    const declared = declaredModel(request.account, display.model)?.context;
    const evidence: ContextWindowEvidence = {
      configuredModel: display.model,
      overrides: this.policy.contextWindowOverrides,
      ...(declared === undefined ? {} : { declaredWindow: declared }),
      ...(request.reportedWindow === undefined ? {} : { reportedWindow: request.reportedWindow }),
    };
    return {
      kind: 'planned',
      plan: {
        tmuxName: shellSafeSessionName(this.policy.namePrefix, request.id, request.account.agent),
        title: harnessDisplayName(request),
        parent: resolveParent(request),
        model: display.model,
        modelSource: display.source,
        contextWindow: contextWindowFor(evidence),
        startWaitMs: startWaitMs(this.policy.startWait, request.account.id),
        extraArgs: remoteControlArgs(
          {
            harness: request.account.kind,
            id: request.id,
            ...(request.teammate === undefined ? {} : { teammate: request.teammate }),
          },
          this.policy.remoteControlPrefix,
        ),
      },
    };
  }

  /**
   * How full a running session's context is, against the window this planner assigned it. It lives
   * here because the window and the percentage must come from one decision: the source computed
   * them in two places and disagreed with itself whenever an override applied.
   */
  contextUsedPercent(plan: Pick<SessionPlan, 'contextWindow'>, usedTokens: number): number {
    return contextPercent(usedTokens, plan.contextWindow);
  }
}
