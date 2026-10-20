/**
 * THE ORDER THIS BROWSER LISTS ITS PAIRED MACHINES IN.
 *
 * The default is the order they were paired in (`machineDisplayOrder`). A reader who dragged a machine
 * somewhere else has a SAVED order, a list of daemon ids kept per device in the controls record. The
 * saved list is a preference, not a registry: it may name a machine that was since unpaired and may
 * not name one that was paired afterwards, so it is always RECONCILED against who is paired now —
 * saved machines first in the saved order, then everyone the list has never seen, in pairing order.
 * Nothing here reads storage; the same two functions order the bar, the switcher and Settings.
 */

import type { DaemonId } from './daemon-connection.ts';

/** `present` is the pairing order; the result is every present id exactly once. */
export const reconcileMachineOrder = (present: readonly DaemonId[], saved: readonly string[]): readonly DaemonId[] => {
  const known = new Set<string>(present);
  const kept = new Set<string>();
  const ordered: DaemonId[] = [];
  for (const id of saved) {
    if (!known.has(id) || kept.has(id)) continue;
    kept.add(id);
    ordered.push(id as DaemonId);
  }
  return [...ordered, ...present.filter(id => !kept.has(id))];
};

/** Where a dragged machine lands: on one side of another. */
export type DropEdge = 'before' | 'after';

/** `order` with `id` taken out and put just before or after `target`; the same list when that is where it is. */
export const moveMachine = (
  order: readonly DaemonId[],
  id: DaemonId,
  target: DaemonId,
  edge: DropEdge,
): readonly DaemonId[] => {
  if (id === target || !order.includes(id) || !order.includes(target)) return order;
  const rest = order.filter(candidate => candidate !== id);
  const at = rest.indexOf(target) + (edge === 'after' ? 1 : 0);
  const next = [...rest.slice(0, at), id, ...rest.slice(at)];
  return next.every((candidate, index) => candidate === order[index]) ? order : next;
};

/** One place up (-1) or down (+1) among the machines on screen; the same list at either end. */
export const stepMachine = (
  order: readonly DaemonId[],
  visible: readonly DaemonId[],
  id: DaemonId,
  delta: -1 | 1,
): readonly DaemonId[] => {
  const neighbour = visible[visible.indexOf(id) + delta];
  return neighbour === undefined ? order : moveMachine(order, id, neighbour, delta < 0 ? 'before' : 'after');
};
