/**
 * Conversation's side of the shared "Add to chat" action (S15, `conversation.add-to-chat`): any surface that shows a
 * reference — Board's cards, a terminal, a file — can put it in the right ferret's message box without owning a copy of
 * the delivery. The shell hands the daemon; the caller names the ferret; the composer registry keys the target by
 * BOTH, so a reference can only ever reach the composer of the daemon and ferret it was read under.
 */

import { daemonFerretScope, findReferences } from '@ferretry/app';
import type { AddToChatResult, ConversationAddToChat } from '../../contract/app-hooks.ts';
import { addReferenceMessage, addReferenceToComposer } from './composer-references.ts';

/** The reference a token is, when the whole string is exactly one reference token; else `undefined`. */
const wholeReference = (token: string) => {
  const [only, ...rest] = findReferences(token);
  return only !== undefined && rest.length === 0 && only.start === 0 && only.end === token.length
    ? only.reference
    : undefined;
};

/** The action for one daemon. */
export function addToChatFor(daemon: string): ConversationAddToChat {
  return Object.freeze({
    add: (ferret: string, token: string): AddToChatResult => {
      const reference = wholeReference(token);
      if (reference === undefined || ferret.trim() === '')
        return { outcome: 'rejected', message: addReferenceMessage('rejected', token) };
      const outcome = addReferenceToComposer(reference, daemonFerretScope({ daemonId: daemon }, ferret));
      return { outcome, message: addReferenceMessage(outcome, token) };
    },
  });
}
