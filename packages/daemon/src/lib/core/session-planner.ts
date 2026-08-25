/**
 * Everything the daemon has to decide about the *shape* of one session before it exists: what to
 * call it, whose child it is, which model it will really be running, how long to hold the launch
 * open, and how big its context is.
 *
 * These decisions were spread across the source as free functions that each re-derived their inputs
 * from an executable name. They are gathered here behind the policy they depend on — the slow-account
 * set and the context-window overrides — so the policy is injected once at the composition root
 * rather than re-read, re-guessed, or hardcoded at every call site.
 */
import { contextPercent, contextWindowFor, type ContextWindowEvidence } from './context-window.ts';
import { resolveDisplayModel, startWaitMs, type DisplayModelSource, type StartWaitPolicy } from './display-model.ts';
import type { CoreAccount } from './inventory.ts';
import { harnessDisplayName, remoteControlArgs, resolveParent, shellSafeSessionName } from './session-shape.ts';

export interface SessionPlanRequest {
  /** Stable session identity; the name is derived from it, never the other way round. */
  readonly id: string;
  readonly account: CoreAccount;
  readonly mode: 'auto' | 'interactive';
  /** The teammate callsign this session belongs to. */
  readonly teammate?: string;
  /** The human-facing task title. */
  readonly name?: string;
  /** The model the caller asked for. An account that cannot serve it refuses the plan; see {@link SessionPlanOutcome}. */
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

/**
 * What planning one session came to.
 *
 * A REFUSAL IS A PLANNING OUTCOME, not an exception, because every caller of this planner is already
 * a place that refuses things for its own reasons and in its own vocabulary — a start, a migration, a
 * fork binding and a handover resolution each answer with a different failure taxonomy. Returning the
 * refusal lets each of them say it in its own words, and the union is what makes it impossible for a
 * caller to receive a model it did not ask for without noticing: before this the planner simply
 * dropped an unservable request and answered with the account's default.
 */
export type SessionPlanOutcome =
  | { readonly kind: 'planned'; readonly plan: SessionPlan }
  | {
      readonly kind: 'unservable-model';
      /** What the caller asked for, quoted back rather than paraphrased. */
      readonly requested: string;
      /** Why this account cannot serve it, what it does serve, and what to do about it. */
      readonly reason: string;
    };

export interface SessionPlannerPolicy {
  readonly startWait: StartWaitPolicy;
  /** Real windows for models whose id says nothing about their size, matched by substring. */
  readonly contextWindowOverrides: Readonly<Record<string, number>>;
  /** Prefix for generated tmux session names. */
  readonly namePrefix: string;
  /** Prefix for the harness's own remote-control session names. */
  readonly remoteControlPrefix: string;
}

export class SessionPlanner {
  constructor(private readonly policy: SessionPlannerPolicy) {}

  plan(request: SessionPlanRequest): SessionPlanOutcome {
    const display = resolveDisplayModel(request.account, request.requestedModel);
    // FIRST, and before anything is derived from a model. Everything below — the context window, the
    // `--model` argument, the document every surface reads — describes the model this session runs,
    // so a request the account cannot meet has to stop here rather than be answered with a plan for
    // a session nobody asked for.
    if (display.kind === 'unservable')
      return { kind: 'unservable-model', requested: display.requested, reason: display.reason };
    const evidence: ContextWindowEvidence = {
      configuredModel: display.model,
      overrides: this.policy.contextWindowOverrides,
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
