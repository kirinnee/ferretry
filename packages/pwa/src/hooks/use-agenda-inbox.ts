/**
 * THE AGENDA INBOX, wired: every paired machine's session list read for `state.attention`, the
 * boards of exactly the conversations it names, and the answers held for their undo window.
 *
 * Mounted ONCE, by the shell, and handed down through `AgendaInboxContext` — so the phone's
 * Inbox tab, the sidebar's entry, the Sessions page's Needs-you deck and the inbox page all count
 * and deal the same cards, and an answer still inside its undo window survives a navigation.
 *
 * A BOARD IS READ WHEN ITS SUMMARY MOVES, and only then. The daemon rewrites `state.attention` on every
 * board change and the fleet feed re-reads the list, so a changed summary is the signal; an unchanged
 * one reads nothing. A conversation that stops being unread is not read again. A read that settles without
 * the board is the exception: it is asked again on a backoff (`inbox-board-reads.ts`), and until one lands
 * the board is said to be unavailable on its machine — never "Updating", which is only a first read in flight.
 */

import type { SessionView } from '@ferretry/protocol';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { DaemonAgendaClient } from '../lib/agenda-client.ts';
import {
  agendaSummaryKey,
  browserDeferredTimers,
  DeferredAgendaActions,
  type DeferredAgendaState,
  type DeferredTimers,
  type InboxAction,
  type InboxCard,
  type InboxResolved,
  type InboxUnavailable,
  inboxCards,
  inboxCount,
  inboxParked,
  inboxResolved,
  inboxUnavailable,
  sessionsToReadForResolved,
  type UnreadSession,
  unreadSessions,
  withFerretCards,
  withFerretSessions,
} from '../lib/agenda-inbox.ts';
import { type AgendaSender, sendAgendaAction } from '../lib/agenda-send.ts';
import type { DaemonConnection, DaemonId } from '../lib/daemon-connection.ts';
import { daemonSessionKey, daemonSessionScope } from '../lib/daemon-scope.ts';
import type { DaemonFleetStore } from '../lib/fleet-store.ts';
import { toTestBesideGates } from '../lib/gate-items.ts';
import { InboxBoardReads } from '../lib/inbox-board-reads.ts';
import { nextWake, sessionTaskNames, splitSnoozed, type ToTestCard, withTaskName } from '../lib/to-test-inbox.ts';

/** One paired machine, as the inbox reads it: its pairing, its name, its last session list. */
export interface AgendaInboxMachine {
  readonly connection: DaemonConnection;
  readonly name: string;
  readonly sessions: readonly SessionView[] | null;
}

export interface AgendaInbox {
  /** Conversations with something waiting on the owner, newest first. */
  readonly unread: readonly UnreadSession[];
  /** The Inbox count (`inboxCount`): the one number every Inbox badge and the Inbox page's heading show. */
  readonly total: number;
  /** Cards waiting in a verify lane for the owner's try (Done or Not good): counted in `total`, listed under Needs you. */
  readonly toTest: readonly ToTestCard[];
  /** Cards the owner put aside until later: not in `toTest` and not in `total`, back in `toTest` when their time is up. */
  readonly toTestSnoozed: readonly ToTestCard[];
  /** The deck: every read open item, newest first, minus the answers still undoable or in flight. */
  readonly cards: readonly InboxCard[];
  /** Items on the ferret's turn: not in the deck and not in `total` — the "With ferrets" section. */
  readonly withFerret: readonly InboxCard[];
  /** True while an unread conversation's board is on its first read: what "Updating" says. */
  readonly reading: boolean;
  /** Machines with an unread conversation whose board could not be read: counted in `total`, said on the page. */
  readonly unavailable: readonly InboxUnavailable[];
  /** Snoozed and replied items of every conversation whose board is held, newest parked first. */
  readonly parked: readonly InboxCard[];
  /** Resolved items of every conversation whose board is held, newest first: the Resolved filter's list. */
  readonly resolved: readonly InboxResolved[];
  /** True while `loadResolved` is reading boards. */
  readonly resolvedReading: boolean;
  /** Reads the recent conversations' boards that are not held yet, once per call that finds any. */
  readonly loadResolved: () => void;
  readonly deferred: DeferredAgendaActions;
  readonly deferredState: DeferredAgendaState;
  readonly connectionFor: (daemonId: DaemonId) => DaemonConnection | undefined;
  /** Whether a machine can snooze (`agenda.snooze.1`): false only once its health answered without it. Absent: it can. */
  readonly canSnooze?: (daemonId: DaemonId) => boolean;
}

/** One paired machine to count Attention on: its pairing and the name the reader knows it by. */
export interface InboxMachinePairing {
  readonly connection: DaemonConnection;
  readonly name: string;
}

/**
 * Every paired machine with its last session list, from the fleet cache — identity-stable while no
 * machine's list or pairing moved, so the inbox above it recomputes only when something did.
 */
export const useInboxMachines = (
  fleet: DaemonFleetStore,
  machines: readonly InboxMachinePairing[],
): readonly AgendaInboxMachine[] => {
  const snapshot = useSyncExternalStore(
    useCallback(listener => fleet.subscribe(listener), [fleet]),
    useCallback(() => fleet.getSnapshot(), [fleet]),
  );
  return useMemo(
    () =>
      machines.map(machine => ({
        connection: machine.connection,
        name: machine.name,
        sessions: snapshot.daemons.get(machine.connection.daemonId)?.sessions ?? null,
      })),
    [machines, snapshot],
  );
};

/** Sends one inbox answer through the ONE agenda client, to the machine the card came from. */
const runInboxAction = (
  client: AgendaSender,
  connection: DaemonConnection,
  card: InboxCard,
  action: InboxAction,
): Promise<void> =>
  sendAgendaAction(client, connection, daemonSessionScope(connection, card.view.config.id), card.item.id, action);

/**
 * The previous value while `key` holds still. The fleet is re-read every few seconds and every read is
 * a new array of new views; the inbox's consumers (every badge, the sidebar entry, the decks) must not
 * re-render for a read that changed nothing about the Inbox.
 */
const useStable = <T>(value: T, key: string): T => {
  const held = useRef<{ readonly key: string; readonly value: T } | null>(null);
  if (held.current === null || held.current.key !== key) held.current = { key, value };
  return held.current.value;
};

/** What a card or row of the inbox draws from a session: its identity, names and open summary. */
const unreadKey = (entries: readonly UnreadSession[]): string =>
  entries
    .map(entry =>
      [
        entry.daemonId,
        entry.machineName,
        entry.view.config.id,
        entry.view.config.teammate ?? '',
        entry.view.config.label ?? '',
        entry.view.config.name ?? '',
        agendaSummaryKey(entry.attention),
      ].join('\u0000'),
    )
    .join('\u0001');

const cardsKey = (cards: readonly InboxCard[]): string =>
  cards.map(card => `${card.key}\u0000${JSON.stringify(card.item)}`).join('\u0001');

const NO_TO_TEST: readonly ToTestCard[] = [];

const toTestKeyOf = (rows: readonly ToTestCard[]): string =>
  rows
    .map(
      row =>
        `${row.key}\u0000${row.card.task.laneId}\u0000${row.card.task.lastTouchedAt}\u0000${row.taskName ?? ''}\u0000${row.snoozedUntil ?? ''}`,
    )
    .join('\u0001');

/** The clock the snoozed cards wake by: it moves to the soonest wake, so a card comes back when its time is up. */
const useWakeClock = (rows: readonly ToTestCard[], timers: DeferredTimers): number => {
  const [now, setNow] = useState(() => timers.now());
  useEffect(() => {
    const wake = nextWake(rows, now);
    if (wake === null) return;
    // A little past the wake, and never past what a timer can hold; a longer snooze re-arms when this fires.
    const handle = timers.setTimeout(() => setNow(timers.now()), Math.min(wake - now + 50, MAX_TIMER_MS));
    return () => timers.clearTimeout(handle);
  }, [rows, now, timers]);
  return now;
};
const MAX_TIMER_MS = 2_147_483_647;

export function useAgendaInboxModel(
  client: DaemonAgendaClient,
  machines: readonly AgendaInboxMachine[],
  timers?: DeferredTimers,
  toTestRead: readonly ToTestCard[] = NO_TO_TEST,
): AgendaInbox {
  const taskNames = useMemo(() => sessionTaskNames(machines.flatMap(machine => machine.sessions ?? [])), [machines]);
  const named = useMemo(() => toTestRead.map(row => withTaskName(row, taskNames)), [toTestRead, taskNames]);
  const now = useWakeClock(named, timers ?? browserDeferredTimers);
  const split = useMemo(() => splitSnoozed(named, now), [named, now]);
  const latest = useRef(machines);
  latest.current = machines;
  // Which machines raise gate items: read from the health the app already holds, and re-read when one moves.
  const readGateFlags = () =>
    latest.current
      .map(
        ({ connection }) =>
          `${connection.daemonId}=${client.wires.gateItemsOf(connection.daemonId)}/${client.wires.snoozeOf(connection.daemonId)}`,
      )
      .join(',');
  const gateFlags = useSyncExternalStore(client.wires.subscribe, readGateFlags, readGateFlags);
  const connectionFor = useMemo(
    () =>
      (daemonId: DaemonId): DaemonConnection | undefined =>
        latest.current.find(machine => machine.connection.daemonId === daemonId)?.connection,
    [],
  );
  const deferred = useMemo(
    () =>
      new DeferredAgendaActions(async (card, action) => {
        const connection = connectionFor(card.daemonId);
        if (connection === undefined) throw new Error('That machine is no longer paired with this browser.');
        await runInboxAction(client, connection, card, action);
      }, timers),
    [client, connectionFor, timers],
  );
  // An answer the reader gave is sent, not dropped, when the page goes away. A phone does not always fire
  // `pagehide` when the reader swipes to another app — it hides the page and may kill it later — so the page
  // going hidden flushes too: otherwise an answer still inside its undo window dies with the process.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const flush = (): void => deferred.flush();
    const flushWhenHidden = (): void => {
      if (document.visibilityState === 'hidden') deferred.flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flushWhenHidden);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', flushWhenHidden);
      deferred.flush();
    };
  }, [deferred]);
  const deferredState = useSyncExternalStore(deferred.subscribe, deferred.getSnapshot, deferred.getSnapshot);

  const freshUnread = useMemo(
    () =>
      unreadSessions(
        machines.map(machine => ({
          daemonId: machine.connection.daemonId,
          name: machine.name,
          sessions: machine.sessions,
        })),
      ),
    [machines],
  );
  const unread = useStable(freshUnread, unreadKey(freshUnread));
  const freshWithFerret = useMemo(
    () =>
      withFerretSessions(
        machines.map(machine => ({
          daemonId: machine.connection.daemonId,
          name: machine.name,
          sessions: machine.sessions,
        })),
      ),
    [machines],
  );
  const withFerretEntries = useStable(freshWithFerret, unreadKey(freshWithFerret));

  // Read each conversation's board — one that needs the owner, or one with an item on the ferret's turn — when its
  // summary moved since the last read, and again on a backoff while a read settles without it.
  const boardReads = useMemo(() => new InboxBoardReads(timers ?? browserDeferredTimers), [timers]);
  useEffect(() => () => boardReads.dispose(), [boardReads]);
  useEffect(() => {
    boardReads.sync(
      [...unread, ...withFerretEntries].flatMap(entry => {
        const connection = connectionFor(entry.daemonId);
        if (connection === undefined) return [];
        const scope = daemonSessionScope(connection, entry.view.config.id);
        return [
          {
            id: daemonSessionKey(scope),
            key: agendaSummaryKey(entry.attention),
            read: () => client.revalidate(connection, scope),
            held: () => client.store.agenda(scope) !== undefined,
          },
        ];
      }),
    );
  }, [boardReads, client, connectionFor, unread, withFerretEntries]);
  const failedBoards = useSyncExternalStore(boardReads.subscribe, boardReads.getSnapshot, boardReads.getSnapshot);

  const subscribeBoards = useCallback((listener: () => void) => client.store.subscribe(listener), [client]);
  const readBoards = useCallback(() => client.store.getSnapshot(), [client]);
  const boards = useSyncExternalStore(subscribeBoards, readBoards, readBoards);
  const freshCards = useMemo(
    () =>
      inboxCards(
        unread,
        (daemonId, sessionId) => boards.snapshots.get(daemonSessionKey({ daemonId, sessionId })),
        new Set([...deferredState.pending.map(entry => entry.key), ...deferredState.sending]),
      ),
    [unread, boards, deferredState],
  );
  const cards = useStable(freshCards, cardsKey(freshCards));
  // A gate item stands in for its card's to-test row, on a machine that raises them. What is still in the undo window
  // counts too, so an answered gate item does not bring its row back for the few seconds before the card moves.
  const gateHolders = useMemo(
    () =>
      inboxCards(
        unread,
        (daemonId, sessionId) => boards.snapshots.get(daemonSessionKey({ daemonId, sessionId })),
        new Set<string>(),
      ).filter(card => card.item.gate !== undefined),
    [unread, boards],
  );
  const offersGates = useCallback(
    (daemonId: DaemonId): boolean => gateFlags.includes(`${daemonId}=true/`),
    [gateFlags],
  );
  const canSnooze = useCallback(
    (daemonId: DaemonId): boolean =>
      !gateFlags.includes(`${daemonId}=`) ||
      !gateFlags.split(',').some(entry => entry.startsWith(`${daemonId}=`) && entry.endsWith('/false')),
    [gateFlags],
  );
  const awakeRows = useMemo(
    () => toTestBesideGates(split.awake, gateHolders, offersGates),
    [split.awake, gateHolders, offersGates],
  );
  const snoozedRows = useMemo(
    () => toTestBesideGates(split.snoozed, gateHolders, offersGates),
    [split.snoozed, gateHolders, offersGates],
  );
  const toTest = useStable(awakeRows, toTestKeyOf(awakeRows));
  const toTestSnoozed = useStable(snoozedRows, toTestKeyOf(snoozedRows));
  const freshWithFerretCards = useMemo(
    () =>
      withFerretCards(withFerretEntries, (daemonId, sessionId) =>
        boards.snapshots.get(daemonSessionKey({ daemonId, sessionId })),
      ),
    [withFerretEntries, boards],
  );
  const withFerret = useStable(freshWithFerretCards, cardsKey(freshWithFerretCards));
  const boardKey = (entry: UnreadSession): string =>
    daemonSessionKey({ daemonId: entry.daemonId, sessionId: entry.view.config.id });
  const held = (entry: UnreadSession): boolean => boards.snapshots.has(boardKey(entry));
  const failed = (entry: UnreadSession): boolean => !held(entry) && failedBoards.has(boardKey(entry));
  const reading = unread.some(entry => !held(entry) && !failed(entry));
  const total = inboxCount(unread, held, cards, toTest.length);
  const freshUnavailable = inboxUnavailable(unread, failed);
  const unavailable = useStable(
    freshUnavailable,
    freshUnavailable.map(entry => `${entry.daemonId}\u0000${entry.machineName}\u0000${entry.items}`).join('\u0001'),
  );

  const sources = useMemo(
    () =>
      machines.map(machine => ({
        daemonId: machine.connection.daemonId,
        name: machine.name,
        sessions: machine.sessions,
      })),
    [machines],
  );
  const resolved = useMemo(
    () =>
      inboxResolved(sources, (daemonId, sessionId) => boards.snapshots.get(daemonSessionKey({ daemonId, sessionId }))),
    [sources, boards],
  );
  const freshParked = useMemo(
    () =>
      inboxParked(
        sources,
        (daemonId, sessionId) => boards.snapshots.get(daemonSessionKey({ daemonId, sessionId })),
        new Set([...deferredState.pending.map(entry => entry.key), ...deferredState.sending]),
      ),
    [sources, boards, deferredState],
  );
  const parked = useStable(freshParked, cardsKey(freshParked));
  const [resolvedReading, setResolvedReading] = useState(false);
  const resolvedBusy = useRef(false);
  const loadResolved = useCallback((): void => {
    if (resolvedBusy.current) return;
    const wanted = sessionsToReadForResolved(sources, (daemonId, sessionId) =>
      boards.snapshots.has(daemonSessionKey({ daemonId, sessionId })),
    );
    if (wanted.length === 0) return;
    resolvedBusy.current = true;
    setResolvedReading(true);
    const reads = wanted.flatMap(({ daemonId, sessionId }) => {
      const connection = connectionFor(daemonId);
      return connection === undefined
        ? []
        : [client.revalidate(connection, daemonSessionScope(connection, sessionId)).catch(() => undefined)];
    });
    void Promise.all(reads).finally(() => {
      resolvedBusy.current = false;
      setResolvedReading(false);
    });
  }, [client, connectionFor, sources, boards]);

  return useMemo(
    () => ({
      unread,
      total,
      toTest,
      toTestSnoozed,
      cards,
      withFerret,
      reading,
      unavailable,
      parked,
      resolved,
      resolvedReading,
      loadResolved,
      deferred,
      deferredState,
      connectionFor,
      canSnooze,
    }),
    [
      unread,
      total,
      unavailable,
      toTest,
      toTestSnoozed,
      cards,
      withFerret,
      reading,
      parked,
      resolved,
      resolvedReading,
      loadResolved,
      deferred,
      deferredState,
      connectionFor,
      canSnooze,
    ],
  );
}

export const AgendaInboxContext = createContext<AgendaInbox | null>(null);

/** The shell's inbox, or `null` outside a shell (a harness, a render test that mounts no provider). */
export const useAgendaInbox = (): AgendaInbox | null => useContext(AgendaInboxContext);
