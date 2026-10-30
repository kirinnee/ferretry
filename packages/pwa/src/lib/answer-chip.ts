/**
 * THE "re:" CHIPS: the items the owner chose to reply about (＋ reply on an agenda row, ↓ on a full card). The
 * daemon already reads a chat message that starts with `!A4 ` as about that item, so the chips only prefix the
 * text — through `withReferences`, one id each — and no second route exists. Nothing is guessed: a message with
 * no chips goes out exactly as typed.
 */

import type { AgendaId } from '@ferretry/protocol';
import { withReferences } from './agenda-reply.ts';

/** Where a reference-carrying client keeps its chips, for a sender that must remember them past this send. */
const REFERENCES: unique symbol = Symbol('agenda-references');

/**
 * The Agenda items a client made by {@link withReferencePrefix} would prefix right now; none for any other client.
 *
 * The outbox stores them beside the words: a message it sends later, after a reload or a reconnect, goes
 * through the machine's plain client, and without them would arrive no longer about the item it answered.
 */
export const referencesOf = (client: object): readonly AgendaId[] => {
  const read = (client as { readonly [REFERENCES]?: unknown })[REFERENCES];
  return typeof read === 'function' ? (read as () => readonly AgendaId[])() : [];
};

/** A client whose `send` carries the chips' references; every other method is the target's own. */
export const withReferencePrefix = <T extends { readonly send: (...args: never[]) => unknown }>(
  client: T,
  idsOf: () => readonly AgendaId[],
): T =>
  new Proxy(client, {
    get(target, key, receiver) {
      if (key === REFERENCES) return idsOf;
      const value = Reflect.get(target, key, receiver);
      if (key !== 'send') return typeof value === 'function' ? value.bind(target) : value;
      return (sessionId: string, body: { readonly message: string }, ...rest: unknown[]) =>
        (value as (...args: unknown[]) => unknown).call(
          target,
          sessionId,
          { ...body, message: withReferences(body.message, idsOf()) },
          ...rest,
        );
    },
  });
