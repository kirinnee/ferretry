import { daemonTitle, type PairedDaemon } from './daemon-list.ts';

/**
 * HOW A PAIRED DAEMON IS NAMED AND ORDERED WHERE SEVERAL ARE LISTED TOGETHER (copied from today's `distinctDaemonName`,
 * `machineDisplayOrder` and `reconcileMachineOrder`). Every page that lists the daemons goes through here, so a
 * page cannot name one daemon two ways or order the list differently from the bar.
 */

/**
 * Whether a NEWER pairing with the same name at the same address has replaced this one.
 *
 * One address answers for one machine at a time, so two pairings that agree on both are one machine paired twice —
 * almost always because it was reset (`fy daemon reset` gives it a new identity, and the browser keeps the old
 * pairing). The newer is the one that answers; the older has nothing left to talk to. It is only ever labelled and
 * offered for removal — never removed behind the owner's back.
 */
export const replacedPairing = (daemon: PairedDaemon, paired: readonly PairedDaemon[]): boolean =>
  paired.some(
    other =>
      other.daemon !== daemon.daemon &&
      other.address === daemon.address &&
      daemonTitle(other) === daemonTitle(daemon) &&
      other.pairedAt > daemon.pairedAt,
  );

/** "3 Oct": the day a pairing was made, which is how a person remembers it. */
const pairedDay = (pairedAt: number): string =>
  new Date(pairedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/**
 * {@link daemonTitle}, told apart from every other paired daemon that would read the same — in words a person can
 * use, never the daemon's fingerprint. Two daemons on one host both call themselves by its name, so a line naming
 * "dev-box" could not say WHICH one. A twin is followed by its address. A pairing a newer one replaced
 * ({@link replacedPairing}) is called the old pairing, and the live one then needs no suffix at all. Two that still
 * share an address are told apart by the day each was paired.
 */
export const distinctDaemonName = (daemon: PairedDaemon, paired: readonly PairedDaemon[]): string => {
  const name = daemonTitle(daemon);
  if (replacedPairing(daemon, paired)) return `${name} (old pairing)`;
  const twins = paired.filter(
    other => other.daemon !== daemon.daemon && daemonTitle(other) === name && !replacedPairing(other, paired),
  );
  if (twins.length === 0) return name;
  const sharedAddress = name === daemon.address || twins.some(other => other.address === daemon.address);
  if (!sharedAddress) return `${name} (${daemon.address.replace(/^[a-z]+:\/\//u, '')})`;
  return `${name} (paired ${pairedDay(daemon.pairedAt)})`;
};

/** `present` is the pairing order; the result is every present id exactly once, the `saved` order first. */
export const reconcileMachineOrder = (present: readonly string[], saved: readonly string[]): readonly string[] => {
  const known = new Set<string>(present);
  const kept = new Set<string>();
  const ordered: string[] = [];
  for (const id of saved) {
    if (!known.has(id) || kept.has(id)) continue;
    kept.add(id);
    ordered.push(id);
  }
  return [...ordered, ...present.filter(id => !kept.has(id))];
};

/**
 * The daemons in the order every list shows them: the order they were paired in, oldest first.
 *
 * NEVER "THE ONE ON SCREEN FIRST". Opening a row on the second daemon makes it the one on screen; a list that then
 * hoisted it would move every row under the reader's pointer. `saved` is the order the reader dragged them into on
 * this device: those first, in that order, then any daemon it has never seen, in pairing order.
 */
export const machineDisplayOrder = (
  daemons: readonly PairedDaemon[],
  saved: readonly string[] = [],
): readonly PairedDaemon[] => {
  const paired = [...daemons].sort(
    (left, right) => left.pairedAt - right.pairedAt || left.daemon.localeCompare(right.daemon),
  );
  const byId = new Map(paired.map(daemon => [daemon.daemon, daemon] as const));
  return reconcileMachineOrder(
    paired.map(daemon => daemon.daemon),
    saved,
  ).flatMap(id => {
    const daemon = byId.get(id);
    return daemon === undefined ? [] : [daemon];
  });
};
