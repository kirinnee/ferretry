/**
 * THE "re:" CHIPS: the items the owner chose to reply about (＋ reply on an agenda row, ↓ on a full card). The
 * daemon already reads a chat message that starts with `!A4 ` as about that item, so the chips only prefix the
 * text — through `withReferences`, one id each — and no second route exists. Nothing is guessed: a message with
 * no chips goes out exactly as typed.
 */

import type { AttentionId } from '@ferretry/protocol';
import { withReferences } from './attention-reply.ts';

/** A client whose `send` carries the chips' references; every other method is the target's own. */
export const withReferencePrefix = <T extends { readonly send: (...args: never[]) => unknown }>(
  client: T,
  idsOf: () => readonly AttentionId[],
): T =>
  new Proxy(client, {
    get(target, key, receiver) {
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
