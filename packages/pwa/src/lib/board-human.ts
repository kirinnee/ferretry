/**
 * HUMAN CARDS AND INTERNAL CARDS: who a card was asked for.
 *
 * The Board shows what the owner asked for. A card a ferret made for other ferrets (a sub-ferret's card, a
 * Warden remedy) is an INTERNAL card: hidden unless the "Internal" filter is on, and then drawn under the human
 * card it serves. Internal cards never reach an overview count while it is off.
 *
 * THE DAEMON OWNS THE FACT: it sends `askedBy` (person | agent), `origin` (human | agent) and `humanParent`
 * on a card, all optional on the wire. {@link taskAsker} is the ONE place the first two are read: `askedBy`
 * is the answer, and `origin` is what an older daemon that sends no `askedBy` still says. A daemon that
 * sends neither is older still, and the app does not guess: it shows every card and hides the filter
 * ({@link splitAvailable}). {@link askedByPerson} is the stricter "a person asked" the cards to test are
 * limited to; there, silence reads as no.
 */

import type { TaskRef } from '@ferretry/protocol';

type TaskAsker = 'person' | 'agent';

/** A field a newer daemon sends on a card; an older one sends nothing. */
const declared = (task: object, name: string): unknown => (name in task ? Reflect.get(task, name) : undefined);

/** Who asked for this card, as the daemon said (`askedBy`, else its older `origin`); `null` when it said nothing. */
export const taskAsker = (task: object): TaskAsker | null => {
  const asked = declared(task, 'askedBy');
  if (asked === 'person' || asked === 'agent') return asked;
  const origin = declared(task, 'origin');
  if (origin === 'human') return 'person';
  return origin === 'agent' ? 'agent' : null;
};

/** An INTERNAL card: one a ferret asked for, not a person. */
export const isAgentTask = (task: object): boolean => taskAsker(task) === 'agent';

/** Whether the daemon says a person asked for this card; a daemon that says nothing reads as "no". */
export const askedByPerson = (task: object): boolean => declared(task, 'askedBy') === 'person';

/** Whether the daemons behind these cards say who asked for a card: without it there is nothing to split. */
export const splitAvailable = (tasks: readonly object[]): boolean => tasks.some(task => taskAsker(task) !== null);

/** The card an agent card serves, as the daemon declared it: `undefined` when the daemon said nothing, `null` for none. */
const declaredHumanParent = (task: object): TaskRef | null | undefined => {
  const value = declared(task, 'humanParent');
  if (value === null) return null;
  if (typeof value === 'object' && value !== null && typeof Reflect.get(value, 'id') === 'string') {
    return value as TaskRef;
  }
  return undefined;
};

interface ParentFacts {
  readonly id: string;
  readonly parent: TaskRef | null;
}

/** A card on the board: the machine it lives on and its task (a task id is unique on its machine only). */
export interface HumanCard {
  readonly daemonId: string;
  readonly task: ParentFacts;
}

const keyOf = (daemonId: string, taskId: string): string => `${daemonId}\u0000${taskId}`;

/** The cards of the board by machine and task id: what {@link humanParentKey} looks a lead up in. */
export const humanScope = (cards: readonly HumanCard[]): ReadonlyMap<string, HumanCard> =>
  new Map(cards.map(card => [keyOf(card.daemonId, card.task.id), card] as const));

/**
 * The key of the human card an agent card serves, or `null` (a human card has none). The daemon's
 * `humanParent` is believed; without it the nearest human ancestor along `parent` is used, and an ancestor
 * that is not in `scope` means there is nothing to group under.
 */
export const humanParentKey = (card: HumanCard, scope: ReadonlyMap<string, HumanCard>): string | null => {
  const { daemonId, task } = card;
  if (!isAgentTask(task)) return null;
  const told = declaredHumanParent(task);
  if (told === null) return null;
  if (told !== undefined) return scope.has(keyOf(daemonId, told.id)) ? keyOf(daemonId, told.id) : null;
  const seen = new Set<string>([task.id]);
  let cursor = task.parent;
  while (cursor !== null && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    const above = scope.get(keyOf(daemonId, cursor.id));
    if (above === undefined) return null;
    if (!isAgentTask(above.task)) return keyOf(daemonId, above.task.id);
    cursor = above.task.parent;
  }
  return null;
};

export const humanCardKey = (card: HumanCard): string => keyOf(card.daemonId, card.task.id);

/**
 * `items` with every agent item moved to sit right after the human item it serves (their order kept), and
 * the key of that human item. An agent item whose human parent is not among `items` keeps its own place, so
 * a section or a window never loses a card.
 */
export const groupUnderHuman = <T extends HumanCard>(
  items: readonly T[],
  scope: ReadonlyMap<string, HumanCard>,
): readonly { readonly item: T; readonly under: string | null }[] => {
  const present = new Set(items.map(humanCardKey));
  const parentOf = (item: T): string | null => {
    const found = humanParentKey(item, scope);
    return found !== null && present.has(found) ? found : null;
  };
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const item of items) {
    const parent = parentOf(item);
    if (parent === null) roots.push(item);
    else children.set(parent, [...(children.get(parent) ?? []), item]);
  }
  return roots.flatMap(root => [
    { item: root, under: null },
    ...(children.get(humanCardKey(root)) ?? []).map(child => ({ item: child, under: humanCardKey(root) })),
  ]);
};
