import { z } from 'zod';
import { COMPOSER_DRAFT_MAX_CHARS } from './wire-send.ts';

/** The header one logical request travels on, so a retried POST is answered from the first (idempotent move/fork). */
export const REQUEST_ID_HEADER = 'x-fy-request-id';

/** `control.queue_changed`: the journal event a durable queue change publishes after the change is on disk. */
export const QUEUE_CHANGED_EVENT = 'control.queue_changed';

/** What a {@link QUEUE_CHANGED_EVENT} says: which message, and which kind of change. */
export interface QueueChangedEventData {
  readonly messageId: string;
  readonly change: 'enqueued' | 'edited' | 'moved' | 'waiting';
}

/**
 * The code a send answers with when the agent's composer already holds a PERSON's unsent text.
 *
 * A pointer Ferretry typed itself and never submitted is finished by the daemon rather than refused;
 * this is what is left — text only the person can decide about. The body carries that `draft` exactly
 * as the composer reads, so the app can offer "Send it" and "Clear it" for exactly that text.
 */
export const COMPOSER_OCCUPIED_CODE = 'composer_occupied';

const ComposerOccupiedBodySchema = z.object({
  code: z.literal(COMPOSER_OCCUPIED_CODE),
  draft: z.string().min(1).max(COMPOSER_DRAFT_MAX_CHARS),
});

/** The draft a `composer_occupied` refusal carries, or `undefined` for any other body. */
export function composerOccupiedDraft(body: unknown): string | undefined {
  const parsed = ComposerOccupiedBodySchema.safeParse(body);
  return parsed.success ? parsed.data.draft : undefined;
}

/**
 * The code a send answers with when its message WAS typed into the agent's composer and the agent
 * never showed it there in time.
 *
 * Not a refusal — a key reached the pane — and not a loss: the message may be sitting in the agent's
 * box, or on its way to it from a pane too slow to draw it. The send is settled `unaccounted` with
 * `landing_unconfirmed` and still watched, and the body carries its `sendId` so the app can offer
 * "Send it" (press Enter on it), "Clear it" (cancel it) and "Retry" (send it again, which the daemon
 * types only when it can prove no copy is held) for exactly this send.
 */
export const SEND_UNCONFIRMED_CODE = 'send_unconfirmed';

const SendUnconfirmedBodySchema = z.object({
  code: z.literal(SEND_UNCONFIRMED_CODE),
  sendId: z.string().min(1),
});

/** The send a `send_unconfirmed` answer names, or `undefined` for any other body. */
export function unconfirmedSendId(body: unknown): string | undefined {
  const parsed = SendUnconfirmedBodySchema.safeParse(body);
  return parsed.success ? parsed.data.sendId : undefined;
}

/**
 * Pressing Enter on, or erasing, the person's own draft in the agent's composer.
 *
 * `draft` is the text the refusal quoted back. The daemon acts ONLY while the composer still holds
 * exactly that, so a draft the person has since changed in the terminal is never sent or wiped from
 * here.
 */
