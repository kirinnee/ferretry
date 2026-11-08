import { createHash } from 'node:crypto';
import { type AgendaAdded, type AgendaReplyQueue, isAgendaSessionId, tellReplyKey } from '../../lib/agenda/index.ts';

/** The longest text a tell carries. */
export const MAX_TELL_CHARS = 4_096;
/** The longest send id a tell is keyed by. */
const MAX_TELL_SEND_ID_CHARS = 256;

/** The batch key of one tell: a digest of its send id, so the key is a fixed shape whatever the caller's id holds. */
export const tellKeyOf = (sendId: string) =>
  tellReplyKey(createHash('sha256').update(sendId).digest('hex').slice(0, 14));

/**
 * `AsksApi.tell`: what the daemon owes a ferret goes into that ferret's reply batch, the one an owner's answer joins
 * (today's `AgendaReplyBatcher.add`). It is joined with whatever else the ferret is owed into ONE message, goes after
 * the same settle window, waits for the ferret's turn to end and for an empty composer, gives up past
 * `AGENDA_REPLY_COMPOSER_WAIT_MS` and is counted delivered only on the transcript's proof. Asking again with the same
 * send id is one tell. A tell is information, so one that never arrives is dropped, never turned into a card.
 *
 * The result is what the batch reports now: `'queued'` (it joined the ferret's batch; whether it was typed, held or
 * dropped is the batch's, later) or `'known'` (that send id was already queued, being sent or sent).
 */
export function tellFerret(
  replies: Pick<AgendaReplyQueue, 'add'>,
): (ferret: string, text: string, sendId: string) => Promise<AgendaAdded> {
  return async (ferret, text, sendId) => {
    if (!isAgendaSessionId(ferret)) throw new TypeError('tell: not a ferret id');
    if (text.length === 0 || text.length > MAX_TELL_CHARS) throw new RangeError('tell: the text is empty or too long');
    if (sendId.length === 0 || sendId.length > MAX_TELL_SEND_ID_CHARS) throw new RangeError('tell: bad send id');
    const added = await replies.add(ferret, tellKeyOf(`${ferret}\n${sendId}`), text);
    return added ?? 'queued';
  };
}
