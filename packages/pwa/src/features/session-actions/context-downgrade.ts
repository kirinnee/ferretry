/**
 * A smaller context window, in words a person reads.
 *
 * The daemon refuses a move that would give a conversation a smaller window than it is running in, and
 * attaches the two numbers (`downgrade`). An older daemon sends only a sentence that names an API field,
 * so the numbers are recovered from it when they can be and the field name never reaches the screen.
 */

import { ContextDowngradeRefusedBodySchema, type ContextDowngrade } from '@ferretry/protocol';
import type { FyHttpError } from '@ferretry/protocol/client';

const numberText = (tokens: number): string => tokens.toLocaleString('en-US');

/** "200,000 tokens instead of 1,000,000" — or the plain sentence when the numbers are unknown. */
export const downgradeSentence = (downgrade: ContextDowngrade | null, doing = 'Restarting'): string =>
  downgrade === null
    ? `${doing} would give this conversation a smaller window, so part of it would be cut off.`
    : `${doing} would give this conversation a smaller window — ${numberText(downgrade.targetWindow)} tokens instead of ${numberText(downgrade.currentWindow)} — so part of it would be cut off.`;

/** The mounted daemon's own prose: `<agent> serves <model> with a N-token window and this session is running in M`. */
const MESSAGE_NUMBERS = /\bserves\s+(\S+)\s+with a\s+(\d+)-token window and this session is running in\s+(\d+)/iu;

/** The numbers a refusal carries, from its body when the daemon sent them, else from its sentence. */
export const downgradeOf = (reason: FyHttpError): ContextDowngrade | null => {
  const body = ContextDowngradeRefusedBodySchema.safeParse(reason.body);
  if (body.success && body.data.downgrade !== undefined) return body.data.downgrade;
  const found = reason.message.match(MESSAGE_NUMBERS);
  if (found === null) return null;
  return { model: found[1]!, targetWindow: Number(found[2]), currentWindow: Number(found[3]) };
};
