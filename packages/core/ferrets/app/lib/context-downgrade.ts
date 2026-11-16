/**
 * A smaller context window, in words a person reads.
 *
 * The daemon refuses a move that would give a conversation a smaller window than it is running in, and attaches the
 * two numbers (`downgrade`). When a refusal carries only its sentence, the numbers are recovered from it when they can
 * be and the field name never reaches the screen.
 */

import { type ContextDowngrade, ContextDowngradeRefusedBodySchema } from '../../contract/index.ts';

const numberText = (tokens: number): string => tokens.toLocaleString('en-US');

/** "200,000 tokens instead of 1,000,000" — or the plain sentence when the numbers are unknown. */
export const downgradeSentence = (downgrade: ContextDowngrade | null, doing = 'Restarting'): string =>
  downgrade === null
    ? `${doing} would give this conversation a smaller window, so part of it would be cut off.`
    : `${doing} would give this conversation a smaller window — ${numberText(downgrade.targetWindow)} tokens instead of ${numberText(downgrade.currentWindow)} — so part of it would be cut off.`;

/** The mounted daemon's own prose: `<agent> serves <model> with a N-token window and this session is running in M`. */
const MESSAGE_NUMBERS = /\bserves\s+(\S+)\s+with a\s+(\d+)-token window and this session is running in\s+(\d+)/iu;

/** What a refused call carries: the daemon's sentence and the JSON body it sent, when it sent one. */
export interface RefusedCall {
  readonly message: string;
  readonly body?: unknown;
}

/** The numbers a refusal carries, from its body when the daemon sent them, else from its sentence. */
export const downgradeOf = (reason: RefusedCall): ContextDowngrade | null => {
  const body = ContextDowngradeRefusedBodySchema.safeParse(reason.body);
  if (body.success && body.data.downgrade !== undefined) return body.data.downgrade;
  const found = reason.message.match(MESSAGE_NUMBERS);
  if (found === null) return null;
  return { model: found[1] as string, targetWindow: Number(found[2]), currentWindow: Number(found[3]) };
};
