import { type MoveRefusal, MoveRefusedBodySchema } from '../../contract/index.ts';
import { FyHttpError } from '@ferretry/app';
import { downgradeOf, downgradeSentence } from '../features/session-actions/context-downgrade.ts';

export const SMALL_CONTEXT_WINDOW = 200_000;
export const LARGE_CONTEXT_WINDOW = 1_000_000;

export interface MoveTarget {
  readonly agent: string;
  readonly model?: string;
  readonly allowContextDowngrade: boolean;
}

export interface MoveContextInput {
  readonly currentModel: string;
  readonly currentWindow?: number;
  readonly contextTokens?: number;
  readonly targetModel: string;
}

export interface MoveContextDecision {
  readonly currentWindow?: number;
  readonly targetWindow?: number;
  readonly isDowngrade: boolean;
  readonly conversationTooLarge: boolean;
}

type MoveFailureKind =
  | 'context-downgrade'
  | 'preflight-refused'
  | 'conversation-unresumable'
  | 'unknown-agent'
  | 'unavailable'
  | 'unusable'
  | 'not-found'
  | 'invalid'
  | 'failed'
  | 'other';

export interface MoveFailure {
  readonly kind: MoveFailureKind;
  readonly message: string;
  readonly title: string;
  readonly guidance: string;
  readonly code?: string;
  readonly suggestedModel?: string;
  /** What the preflight saw, on a refusal from a daemon that attaches it. */
  readonly inflight?: MoveRefusal;
}

/**
 * Whether the ONLY things in the way are jobs the agent started from its own shell — the one refusal the
 * agent can clear by itself, so the one where the sheet offers to ask it. Anything else that blocks (an
 * open tool call, a program Ferretry can't place, a blind spot) keeps the offer away: asking the agent
 * would not be the remedy there.
 */
export const onlyAgentJobsBlock = (refusal: MoveRefusal | undefined): boolean => {
  const blockers = refusal?.items.filter(item => item.blocks) ?? [];
  return blockers.length > 0 && blockers.every(item => item.backgroundJob === true);
};

/** The daemon's current convention: `[1m]` selects a million-token variant. */
export const contextWindowForModel = (model: string): number | undefined => {
  const normalized = model.trim().toLowerCase();
  if (normalized === '') return undefined;
  return normalized.includes('[1m]') ? LARGE_CONTEXT_WINDOW : SMALL_CONTEXT_WINDOW;
};

export const oneMillionVariant = (model: string): string => {
  const value = model.trim();
  if (value === '' || value.toLowerCase().includes('[1m]')) return value;
  return `${value}[1m]`;
};

export const withoutOneMillionVariant = (model: string): string => model.replace(/\[1m\]/giu, '').trim();

/** The no-catalog fallback preserved from kteam: current, larger and smaller variants. */
export const moveModelSuggestions = (currentModel: string): readonly string[] =>
  [...new Set([currentModel.trim(), oneMillionVariant(currentModel), withoutOneMillionVariant(currentModel)])].filter(
    value => value !== '',
  );

export const moveTarget = (
  agent: string,
  model: string,
  allowContextDowngrade = false,
): MoveTarget | null => {
  const normalizedAgent = agent.trim();
  if (normalizedAgent === '') return null;
  const normalizedModel = model.trim();
  return {
    agent: normalizedAgent,
    ...(normalizedModel === '' ? {} : { model: normalizedModel }),
    allowContextDowngrade,
  };
};

export const moveContextDecision = ({
  currentModel,
  currentWindow,
  contextTokens,
  targetModel,
}: MoveContextInput): MoveContextDecision => {
  const resolvedCurrentWindow = currentWindow ?? contextWindowForModel(currentModel);
  const targetWindow = contextWindowForModel(targetModel);
  return {
    ...(resolvedCurrentWindow === undefined ? {} : { currentWindow: resolvedCurrentWindow }),
    ...(targetWindow === undefined ? {} : { targetWindow }),
    isDowngrade:
      targetWindow !== undefined && resolvedCurrentWindow !== undefined && targetWindow < resolvedCurrentWindow,
    conversationTooLarge: targetWindow !== undefined && contextTokens !== undefined && contextTokens > targetWindow,
  };
};

/**
 * A non-empty source hint records a model selection, whereas an omitted target
 * asks the account planner for its default. That can be a real runtime change
 * even when the account name is unchanged, so it must reach the daemon gate.
 */
export const moveHasRuntimeChange = (
  currentAgent: string,
  currentModel: string,
  currentModelHint: string,
  target: MoveTarget | null,
): boolean =>
  target !== null &&
  (target.agent !== currentAgent ||
    (target.model === undefined ? currentModelHint.trim() !== '' : target.model.trim() !== currentModel.trim()));

/** Accepts the old CLI hint and the mounted daemon's current refusal prose. */
export const modelFromDowngradeError = (message: string): string | null => {
  const explicit = message.match(/use --model\s+([^\s]+\[1m\])/iu)?.[1];
  if (explicit !== undefined) return explicit;
  const served = message.match(/\bserves\s+([^\s]+)\s+with a\s+[\d,]+-token window/iu)?.[1];
  return served === undefined ? null : oneMillionVariant(served);
};

const FAILURE_COPY: Readonly<Record<MoveFailureKind, readonly [title: string, guidance: string]>> = {
  'context-downgrade': [
    'The daemon refused a smaller context window',
    'Use a larger model, or explicitly accept that this conversation may outgrow the target window.',
  ],
  'preflight-refused': [
    'The daemon refused this move',
    'Nothing changed. Let the work finish or stop the session deliberately, then run the safety check again.',
  ],
  'conversation-unresumable': [
    'The conversation can’t go with it',
    'Nothing changed. Choose a login that keeps its conversations where Ferretry can find them, or restart this ferret and choose Start fresh.',
  ],
  'unknown-agent': ['Unknown target account', 'Check the account name against this daemon’s fleet configuration.'],
  unavailable: [
    'Target account unavailable',
    'Choose an account with headroom and an executable wrapper on this host.',
  ],
  unusable: ['Session cannot be moved safely', 'Repair or recover the session documents before trying again.'],
  'not-found': ['Session not found', 'Refresh this daemon’s fleet; the session may have been removed.'],
  invalid: ['Invalid session identity', 'Return to this daemon’s session list and reopen the session.'],
  failed: ['Move did not complete', 'Inspect the session and its move report before retrying.'],
  other: ['Move failed', 'Review the daemon response, then retry when its cause is resolved.'],
};

const kindForCode = (code: string | undefined): MoveFailureKind => {
  switch (code) {
    case 'context_downgrade_refused':
      return 'context-downgrade';
    case 'move_refused':
      return 'preflight-refused';
    case 'conversation_unresumable':
      return 'conversation-unresumable';
    case 'unknown_agent':
      return 'unknown-agent';
    case 'agent_unavailable':
      return 'unavailable';
    case 'session_unusable':
      return 'unusable';
    case 'not-found':
      return 'not-found';
    case 'invalid_session_id':
      return 'invalid';
    case 'session_move_failed':
      return 'failed';
    default:
      return 'other';
  }
};

/** Classifies only typed daemon codes; transport and unexpected errors remain generic. */
export const moveFailure = (error: unknown): MoveFailure => {
  const http = error instanceof FyHttpError ? error : null;
  const message = error instanceof Error ? error.message : String(error);
  const kind = kindForCode(http?.code);
  const [title, guidance] = FAILURE_COPY[kind];
  const suggestedModel = kind === 'context-downgrade' ? modelFromDowngradeError(message) : null;
  const refused = kind === 'preflight-refused' ? MoveRefusedBodySchema.safeParse(http?.body) : undefined;
  const inflight = refused?.success === true ? refused.data.inflight : undefined;
  // The daemon's sentence names an API field and a CLI flag, neither of which a person can use here, so a
  // downgrade is said from its numbers in plain words.
  const shown =
    kind === 'context-downgrade' && http !== null ? downgradeSentence(downgradeOf(http), 'Moving') : message;
  return {
    kind,
    message: shown,
    title,
    guidance,
    ...(http?.code === undefined ? {} : { code: http.code }),
    ...(suggestedModel === null ? {} : { suggestedModel }),
    ...(inflight === undefined ? {} : { inflight }),
  };
};
