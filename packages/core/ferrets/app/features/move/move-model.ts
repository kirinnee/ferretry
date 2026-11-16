import { type MoveRefusal, MoveRefusedBodySchema } from '../../../contract/index.ts';
import type { MoveCallFailure } from './call-failure.ts';
import { downgradeOf, downgradeSentence } from '../../lib/context-downgrade.ts';

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
  | 'wrong-harness'
  | 'unservable-model'
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
  /** What the preflight saw, on a refusal whose body the client carries. */
  readonly inflight?: MoveRefusal;
}

/**
 * Whether the ONLY things in the way are jobs the agent started from its own shell — the one refusal the agent can
 * clear by itself, so the one where the page offers to ask it. Anything else that blocks (an open tool call, a
 * program Ferretry can't place, a blind spot) keeps the offer away: asking the agent would not be the remedy there.
 */
export const onlyAgentJobsBlock = (refusal: MoveRefusal | undefined): boolean => {
  const blockers = refusal?.items.filter(item => item.blocks) ?? [];
  return blockers.length > 0 && blockers.every(item => item.backgroundJob === true);
};

/** The daemon's convention: `[1m]` selects a million-token variant. */
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

/** The no-catalog fallback: current, larger and smaller variants. */
export const moveModelSuggestions = (currentModel: string): readonly string[] =>
  [...new Set([currentModel.trim(), oneMillionVariant(currentModel), withoutOneMillionVariant(currentModel)])].filter(
    value => value !== '',
  );

export const moveTarget = (agent: string, model: string, allowContextDowngrade = false): MoveTarget | null => {
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
 * A non-empty model records a model selection, whereas an omitted target asks the account planner for its default.
 * That can be a real runtime change even when the account name is unchanged, so it must reach the daemon gate.
 */
export const moveHasRuntimeChange = (currentAgent: string, currentModel: string, target: MoveTarget | null): boolean =>
  target !== null &&
  (target.agent !== currentAgent ||
    (target.model === undefined ? currentModel.trim() !== '' : target.model.trim() !== currentModel.trim()));

/** Accepts the daemon's refusal prose: a `use --model` hint or `serves <model> with a N-token window`. */
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
    'Nothing changed. Let the work finish or stop the ferret deliberately, then run the safety check again.',
  ],
  'conversation-unresumable': [
    'The conversation can’t go with it',
    'Nothing changed. Choose a login that keeps its conversations where Ferretry can find them, or restart this ferret and choose Start fresh.',
  ],
  'unknown-agent': ['Unknown target account', 'Check the account name against this daemon’s runtimes.'],
  unavailable: [
    'Target account unavailable',
    'Choose an account with headroom and an executable wrapper on this host.',
  ],
  'wrong-harness': [
    'That account runs a different CLI',
    'A move stays on the same CLI. Pick an account of this ferret’s own CLI, or use Move to the other CLI.',
  ],
  'unservable-model': [
    'That account can’t serve this model',
    'Nothing changed. Pick a model the account offers, or leave the model empty for its default.',
  ],
  unusable: ['This ferret cannot be moved safely', 'Repair or recover the ferret’s documents before trying again.'],
  'not-found': ['Ferret not found', 'Refresh this daemon’s ferrets; the ferret may have been removed.'],
  invalid: ['Invalid ferret identity', 'Return to this daemon’s ferret list and reopen the ferret.'],
  failed: ['The move did not complete', 'Inspect the ferret and its move report before retrying.'],
  other: ['The move failed', 'Review the daemon response, then retry when its cause is resolved.'],
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
    case 'harness_mismatch':
      return 'wrong-harness';
    case 'unservable_model':
      return 'unservable-model';
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
export const moveFailure = (error: MoveCallFailure): MoveFailure => {
  const kind = kindForCode(error.code);
  const [title, guidance] = FAILURE_COPY[kind];
  const suggestedModel = kind === 'context-downgrade' ? modelFromDowngradeError(error.message) : null;
  const refused = kind === 'preflight-refused' ? MoveRefusedBodySchema.safeParse(error.body) : undefined;
  const inflight = refused?.success === true ? refused.data.inflight : undefined;
  // The daemon's sentence names an API field and a CLI flag, neither of which a person can use here, so a downgrade
  // is said from its numbers in plain words.
  const shown = kind === 'context-downgrade' ? downgradeSentence(downgradeOf(error), 'Moving') : error.message;
  return {
    kind,
    message: shown,
    title,
    guidance,
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(suggestedModel === null ? {} : { suggestedModel }),
    ...(inflight === undefined ? {} : { inflight }),
  };
};
