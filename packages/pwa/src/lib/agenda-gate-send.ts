/**
 * THE WORDS UNDER A CARD'S OWN AGENDA ARE ITS OTHER ANSWER (docs/agenda.md § One ask). On the agenda the daemon opened
 * for a card, Good is one tap and everything else is typed: Send answers the card ask with the lane's fail ("Not good":
 * the card goes back, the owner's words are the reopen ask) or, at an approval, "Not yet" (the card stays, the ferret
 * reads the words). It is never a chat message about the item.
 */

import { type AgendaCardAsk, type BoardReopenAttachments, gateReopenOption, gateTypedLabel } from '@ferretry/protocol';
import type { InboxAction } from './agenda-inbox.ts';
import { gateAnswerAction } from './gate-items.ts';

/** What the composer sends: the words, and the files uploaded with them. */
export interface TypedSend {
  readonly message: string;
  readonly attachmentIds?: readonly string[] | undefined;
}

/**
 * The answer typed words are to a card's own ask, or the sentence to show when they are not one yet. Only a Not good
 * takes files; "Not yet" is words alone.
 */
export const typedGateAnswer = (
  ask: Pick<AgendaCardAsk, 'gate'>,
  send: TypedSend,
  session: string,
):
  | { readonly kind: 'answer'; readonly action: InboxAction }
  | { readonly kind: 'refused'; readonly message: string } => {
  const label = gateTypedLabel(ask.gate);
  const words = send.message.trim();
  if (label === undefined || words === '') return { kind: 'refused', message: 'Type what you want to say first.' };
  const files = send.attachmentIds ?? [];
  const attachments: BoardReopenAttachments | undefined =
    files.length === 0 || gateReopenOption(ask.gate) === undefined ? undefined : { from: session, ids: [...files] };
  return { kind: 'answer', action: gateAnswerAction(label, words, ask.gate, attachments) };
};

/**
 * A composer client whose Send hands the typed words to `answer` instead of chatting: the message is not sent, `answer`
 * may throw the composer's one error line, and every other method is the target's.
 */
export const withTypedSend = <T extends { readonly send: (...args: never[]) => unknown }>(
  client: T,
  answer: (send: TypedSend) => void,
): T =>
  new Proxy(client, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key !== 'send') return typeof value === 'function' ? value.bind(target) : value;
      return (_session: string, input: TypedSend) => {
        answer(input);
        return Promise.resolve({});
      };
    },
  });
