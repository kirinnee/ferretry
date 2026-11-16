import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';
import type { FerretId } from '../ids.ts';

/** The one key `turn.question-open` is provided under: whether a ferret has a question open has exactly one owner. */
export const QUESTION_OPEN_KEY = 'question';

/**
 * Whether a ferret has a question open right now, as its owner stores it. The turn watch asks once per look at a live
 * ferret: an open question is a ferret blocked on a person, so its turn reads `needs-input` (the registry goes idle, the
 * chips say "waiting — your turn") whatever the transcript says. Only an ANSWER is read, never the question: Ferrets
 * learns whether one is open and nothing of what it asks. An answer that throws reads as "none" for that look.
 */
export interface QuestionOpenSource {
  isOpen(ferret: FerretId): Promise<boolean>;
}

/**
 * Conversation owns the stored question (`question.json`: the hook file, the pane and the transcript all end there), so it
 * is the ONE provider; Ferrets offers the slot and imports no plugin. With no provider the turn watch decides as it did
 * before: from the status, the transcript and the pane alone.
 */
export const QuestionOpen = defineHook('turn.question-open', {
  mode: 'provide',
  key: z.literal(QUESTION_OPEN_KEY),
  value: z.custom<QuestionOpenSource>(),
  takers: ['conversation'],
});
