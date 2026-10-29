/**
 * THE "SEND AS ANSWER" CHIP: while an Attention item is shown above the composer, the next message can
 * go as its answer. The daemon already reads a chat message that starts with `!A4 ` as the answer to
 * that item, so the chip only prefixes the text — no second route.
 */

import type { AttentionId } from '@ferretry/protocol';

/** The text as sent: prefixed with the item's reference when the chip is on, never twice. */
export const answerPrefixed = (text: string, id: AttentionId | null, on: boolean): string => {
  if (!on || id === null) return text;
  const prefix = `!${id} `;
  return text.trimStart().startsWith(prefix) ? text : `${prefix}${text}`;
};

/** A client whose `send` carries the chip's prefix; every other method is the target's own. */
export const withAnswerPrefix = <T extends { readonly send: (...args: never[]) => unknown }>(
  client: T,
  prefixOf: () => { readonly id: AttentionId | null; readonly on: boolean },
): T =>
  new Proxy(client, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key !== 'send') return typeof value === 'function' ? value.bind(target) : value;
      return (sessionId: string, body: { readonly message: string }, ...rest: unknown[]) => {
        const { id, on } = prefixOf();
        return (value as (...args: unknown[]) => unknown).call(
          target,
          sessionId,
          { ...body, message: answerPrefixed(body.message, id, on) },
          ...rest,
        );
      };
    },
  });
