import type { SessionState } from '@ferretry/protocol';
import { type TurnFacts, turnFactsOf } from './turn.ts';

/**
 * The question part's durable fields: what decides whether a projected question, answer or observed model
 * is already recorded. The main thread pushes them to a session worker beside the turn facts so that,
 * once the question part moves there (stage 3c), the worker never reads — or parses — the document.
 */
export type QuestionFacts = Pick<
  SessionState,
  | 'lastAnsweredQuestionToolUseId'
  | 'needsHuman'
  | 'needsHumanKind'
  | 'observedModel'
  | 'observedModelAt'
  | 'observedReasoningEffort'
  | 'observedFast'
  | 'contextTokens'
  | 'contextAt'
  | 'contextWindow'
>;

/** Everything the main thread tells an observer about a session: what each of its parts decides from. */
export type ObserverFacts = TurnFacts & QuestionFacts;

/** The observer facts of a session document: its turn facts and its question facts, nothing else. */
export function observerFactsOf(state: SessionState): ObserverFacts {
  return {
    ...turnFactsOf(state),
    ...(state.lastAnsweredQuestionToolUseId === undefined
      ? {}
      : { lastAnsweredQuestionToolUseId: state.lastAnsweredQuestionToolUseId }),
    ...(state.needsHuman === undefined ? {} : { needsHuman: state.needsHuman }),
    ...(state.needsHumanKind === undefined ? {} : { needsHumanKind: state.needsHumanKind }),
    ...(state.observedModel === undefined ? {} : { observedModel: state.observedModel }),
    ...(state.observedModelAt === undefined ? {} : { observedModelAt: state.observedModelAt }),
    ...(state.observedReasoningEffort === undefined ? {} : { observedReasoningEffort: state.observedReasoningEffort }),
    ...(state.observedFast === undefined ? {} : { observedFast: state.observedFast }),
    ...(state.contextTokens === undefined ? {} : { contextTokens: state.contextTokens }),
    ...(state.contextAt === undefined ? {} : { contextAt: state.contextAt }),
    ...(state.contextWindow === undefined ? {} : { contextWindow: state.contextWindow }),
  };
}
