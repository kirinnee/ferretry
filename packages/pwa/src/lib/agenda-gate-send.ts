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
 * takes files; "Not yet" is words alone, so files sent with one are refused (the draft and its files stay in the box),
 * never dropped while the send reports success.
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
  if (files.length > 0 && gateReopenOption(ask.gate) === undefined)
    return { kind: 'refused', message: FILES_NOT_YET_COPY };
  const attachments: BoardReopenAttachments | undefined =
    files.length === 0 ? undefined : { from: session, ids: [...files] };
  return { kind: 'answer', action: gateAnswerAction(label, words, ask.gate, attachments) };
};

/** Why files cannot go with a "Not yet": it is words alone. */
export const FILES_NOT_YET_COPY =
  'Files cannot go with a Not yet. Remove them and send the words, or send the files in the ferret’s chat.';

/** The words a Send for an ask that is no longer the open one shows, in place of answering whatever ask is open now. */
export const STALE_ASK_COPY = 'That ask has changed. Read the card again, then send.';

/** What answers an ask: its name (`cardAskReference`) and what it does with the words typed under it. */
export interface TypedAnswerTarget {
  readonly key: string;
  readonly send: (send: TypedSend) => void;
  /**
   * Whether these words CLEARLY approve the ask (`typedApproval`: "works now" at a try-it). They are then an ordinary
   * reply about the item — recorded in its conversation, offered back above Good in words — and never answer the ask, so a
   * Good meant in words cannot send a finished card back as Not good.
   */
  readonly approves: (words: string) => boolean;
}

/**
 * A composer client whose Send hands the typed words to the ask it was BUILT FOR instead of chatting: the message is not
 * sent, and `send` may throw the composer's one error line. Words that clearly approve (`approves`) are the one exception:
 * they go through `chat` — the item's normal reply, with its reference — and the ask is not answered. The client belongs to the ask named `key`; `current` says
 * which ask is open when Send finally runs (the composer may await before it), and a different one — replaced, answered
 * or gone — throws {@link STALE_ASK_COPY} rather than answering another ask. Every other method is the target's.
 */
export const withTypedSend = <T extends { readonly send: (...args: never[]) => unknown }>(
  client: T,
  key: string,
  current: () => TypedAnswerTarget | undefined,
  chat: T,
): T =>
  new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'send') return typeof value === 'function' ? value.bind(target) : value;
      return (session: string, input: TypedSend) => {
        const open = current();
        if (open === undefined || open.key !== key) throw new Error(STALE_ASK_COPY);
        if (open.approves(input.message)) return Reflect.apply(chat.send, chat, [session, input]);
        open.send(input);
        return Promise.resolve({});
      };
    },
  });
