/**
 * THE FORMER SPELLING OF A TASK ROUTE (O18, owner !A539). Board's routes were `/v1/board/cards…` until the noun became
 * `task`; a caller built before that (an old script, an agent's old instructions, a transcript, the plugins that call
 * Board by its route key) still reaches them. Each former route is a second key on the SAME handler, with the same
 * guard, grant and audit as the route it spells, so the two paths answer alike and no redirect is needed. The key is
 * the old one to the letter, `:cardId` included; the handler reads either parameter name.
 */

type SwapParameter<Tail extends string> = Tail extends `${infer Before}:taskId${infer After}`
  ? `${Before}:cardId${SwapParameter<After>}`
  : Tail;

/** `POST /v1/board/tasks/:taskId` → `POST /v1/board/cards/:cardId`; a key with no task segment is left as it is. */
export type FormerPath<Key extends string> = Key extends `${infer Head}/v1/board/tasks${infer Tail}`
  ? `${Head}/v1/board/cards${SwapParameter<Tail>}`
  : Key;

export const formerPath = <const Key extends string>(key: Key): FormerPath<Key> =>
  key.replace('/v1/board/tasks', '/v1/board/cards').replace(':taskId', ':cardId') as FormerPath<Key>;

/** `handlers` keyed by the route they answer, and again by its former path: the one handler under both keys. */
export const withFormerPaths = <const Handlers extends Readonly<Record<string, unknown>>>(
  handlers: Handlers,
): Handlers & { readonly [Key in keyof Handlers as Key extends string ? FormerPath<Key> : never]: Handlers[Key] } => {
  const former = Object.fromEntries(Object.entries(handlers).map(([key, handler]) => [formerPath(key), handler]));
  return { ...handlers, ...former } as never;
};
