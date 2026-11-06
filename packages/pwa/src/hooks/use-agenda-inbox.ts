/**
 * THE AGENDA INBOX, wired: every paired machine's session list read for `state.agenda`, the
 * boards of exactly the conversations it names, and the answers held for their undo window.
 *
 * Mounted ONCE, by the shell, and handed down through `AgendaInboxContext` — so the phone's
 * Inbox tab, the sidebar's entry, the Sessions page's Needs-you deck and the inbox page all count
 * and deal the same cards, and an answer still inside its undo window survives a navigation.
 *
 * A BOARD IS READ WHEN ITS SUMMARY MOVES, and only then. The daemon rewrites `state.agenda` on every
 * board change and the fleet feed re-reads the list, so a changed summary is the signal; an unchanged
 * one reads nothing. A conversation that stops being unread is not read again. A read that settles without
 * the board is the exception: it is asked again on a backoff (`inbox-board-reads.ts`), and until one lands
 * the board is said to be unavailable on its machine — never "Updating", which is only a first read in flight.
 */

import {
  type AgendaListRecord,
  type AgendaItem,
  MACHINE_AGENDA_ID,
  isMachineAgendaId,
  type SessionView,
} from '@ferretry/protocol';
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
  type BoardItems,
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
  gateHolders,
  inboxCount,
  inboxParked,
  inboxResolved,
  inboxUnavailable,
  sessionsToReadForResolved,
  type UnreadSession,
  UNSNOOZE_ACTION,
  unreadSessions,
  withFerretCards,
  withFerretSessions,
} from '../lib/agenda-inbox.ts';
import {
  type BoardItemRead,
  RepliedAgenda,
  type RepliedPorts,
  type RepliedState,
  withRepliedCards,
  withRepliedParked,
} from '../lib/agenda-replied.ts';
import { type AgendaSender, sendAgendaAction } from '../lib/agenda-send.ts';
import { answeredSuggestions } from '../lib/answered-suggestions.ts';
import type { DaemonConnection, DaemonId } from '../lib/daemon-connection.ts';
import { withMachineAgendas } from '../lib/machine-agenda.ts';
import { daemonSessionKey, daemonSessionScope } from '../lib/daemon-scope.ts';
import type { DaemonFleetStore } from '../lib/fleet-store.ts';
import { toTestBesideGates } from '../lib/gate-items.ts';
import { type BoardReadFailure, InboxBoardReads } from '../lib/inbox-board-reads.ts';
import {
  nextWake,
  rootSessionIds,
  rootTaskNames,
  splitSnoozed,
  type ToTestCard,
  withTaskName,
} from '../lib/to-test-inbox.ts';

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
  /**
   * Snoozed and replied items, newest parked first: of EVERY conversation on a machine once its roll-up is read, until
   * then of the conversations whose board is held.
   */
  readonly parked: readonly InboxCard[];
  /** True once every machine has been read to the end, so `parked` is all of it and not the recent conversations'. */
  readonly parkedWhole: boolean;
  /** Resolved items of every conversation whose board is held, newest first: the Resolved filter's list. */
  readonly resolved: readonly InboxResolved[];
  /** True while `loadResolved` is reading boards. */
  readonly resolvedReading: boolean;
  /** Reads every machine's roll-up and the recent conversations' boards that are not held yet, once per call that finds any. */
  readonly loadResolved: () => void;
  readonly deferred: DeferredAgendaActions;
  readonly deferredState: DeferredAgendaState;
  /**
   * Replies the owner just sent from an Inbox card: the item is already out of `cards` and in `parked` while the boards
   * catch up, and Undo takes the reply back (`lib/agenda-replied.ts`).
   */
  readonly replied: RepliedAgenda;
  readonly repliedState: RepliedState;
  readonly connectionFor: (daemonId: DaemonId) => DaemonConnection | undefined;
  /**
   * A card's How to test, from the board this device already reads (any lane the card is in a verify lane for the
   * owner's try, snoozed or not): what a card ask inside an agenda item shows. `null` when the board holds no steps.
   */
  readonly howToTestFor?: (daemonId: DaemonId, cardId: string) => string | null;
  /** The agenda client: what an open card's merge is sent through. Absent: no merge from the Inbox. */
  readonly agendaClient?: DaemonAgendaClient;
  /** The items one conversation's board holds (or its roll-up): what a merge can join. */
  readonly boardOf?: (daemonId: DaemonId, sessionId: string) => readonly AgendaItem[];
  /** The resolved records one conversation's board holds: where the title of an agenda merged away is read. */
  readonly recordsOf?: (daemonId: DaemonId, sessionId: string) => readonly AgendaListRecord[];
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
const NO_RECORDS: readonly AgendaListRecord[] = [];

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
  withdraw?: RepliedPorts['withdraw'],
): AgendaInbox {
  // A card to test is named for its owner's thread (the lineage root), never the sub-ferret that built it.
  const allSessions = useMemo(() => machines.flatMap(machine => machine.sessions ?? []), [machines]);
  const taskNames = useMemo(() => rootTaskNames(allSessions), [allSessions]);
  const rootIds = useMemo(() => rootSessionIds(allSessions), [allSessions]);
  const named = useMemo(
    () => toTestRead.map(row => withTaskName(row, taskNames, rootIds)),
    [toTestRead, taskNames, rootIds],
  );
  const now = useWakeClock(named, timers ?? browserDeferredTimers);
  const split = useMemo(() => splitSnoozed(named, now), [named, now]);
  const latest = useRef(machines);
  latest.current = machines;
  // Which machines raise gate items: read from the health the app already holds, and re-read when one moves.
  const readGateFlags = () =>
    latest.current
      .map(
        ({ connection }) =>
          `${connection.daemonId}=${client.wires.gateItemsOf(connection.daemonId)}/${client.wires.cardAsksOf(connection.daemonId)}`,
      )
      .join(',');
  const gateFlags = useSyncExternalStore(client.wires.subscribe, readGateFlags, readGateFlags);
  // The machines on screen, as a key: a roll-up is read again when the set changes.
  const readMachineKey = () => latest.current.map(({ connection }) => connection.daemonId).join(',');
  const machineKey = useSyncExternalStore(client.wires.subscribe, readMachineKey, readMachineKey);
  const rollup = useSyncExternalStore(client.rollup.subscribe, client.rollup.getSnapshot, client.rollup.getSnapshot);
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
  const withdrawRef = useRef(withdraw);
  withdrawRef.current = withdraw;
  const replied = useMemo(
    () =>
      new RepliedAgenda(
        {
          withdraw: async (card, sendId) => {
            const take = withdrawRef.current;
            if (take === undefined) throw new Error('This browser cannot take a message back from that machine.');
            return await take(card, sendId);
          },
          unsnooze: async card => {
            const connection = connectionFor(card.daemonId);
            if (connection === undefined) throw new Error('That machine is no longer paired with this browser.');
            await runInboxAction(client, connection, card, UNSNOOZE_ACTION);
          },
        },
        timers,
      ),
    [client, connectionFor, timers],
  );
  const repliedState = useSyncExternalStore(replied.subscribe, replied.getSnapshot, replied.getSnapshot);

  const subscribeBoards = useCallback((listener: () => void) => client.store.subscribe(listener), [client]);
  const readBoards = useCallback(() => client.store.getSnapshot(), [client]);
  const boards = useSyncExternalStore(subscribeBoards, readBoards, readBoards);
  // The machine's own agenda is read like a conversation's board and listed first among the machine's conversations.
  useEffect(() => {
    for (const { connection } of machines) {
      client.hydrate(connection, daemonSessionScope(connection, MACHINE_AGENDA_ID)).catch(() => undefined);
    }
  }, [client, machines]);
  const withMachine = useMemo(
    () =>
      withMachineAgendas(machines, (daemonId, sessionId) =>
        boards.snapshots.get(daemonSessionKey({ daemonId, sessionId })),
      ),
    [machines, boards],
  );

  const freshUnread = useMemo(
    () =>
      unreadSessions(
        withMachine.map(machine => ({
          daemonId: machine.connection.daemonId,
          name: machine.name,
          sessions: machine.sessions,
        })),
      ),
    [withMachine],
  );
  const unread = useStable(freshUnread, unreadKey(freshUnread));
  const freshWithFerret = useMemo(
    () =>
      withFerretSessions(
        withMachine.map(machine => ({
          daemonId: machine.connection.daemonId,
          name: machine.name,
          sessions: machine.sessions,
        })),
      ),
    [withMachine],
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
            // The fleet stream owns machine-board freshness; rendering its held board needs no refresh.
            read: () =>
              isMachineAgendaId(scope.sessionId)
                ? client.hydrate(connection, scope)
                : client.revalidate(connection, scope),
            held: () => client.store.agenda(scope) !== undefined,
          },
        ];
      }),
    );
  }, [boardReads, client, connectionFor, unread, withFerretEntries]);
  const failedBoards = useSyncExternalStore(boardReads.subscribe, boardReads.getSnapshot, boardReads.getSnapshot);

  // A ferret's rule suggestion the owner already answered stays open on the ferret's agenda until it expires (C2): it
  // leaves the owner's Inbox through the owner's own "answered" set, never by closing the card.
  const answered = useSyncExternalStore(
    answeredSuggestions.subscribe,
    answeredSuggestions.getSnapshot,
    answeredSuggestions.getSnapshot,
  );
  const boardCards = useMemo(
    () =>
      inboxCards(
        unread,
        (daemonId, sessionId) => boards.snapshots.get(daemonSessionKey({ daemonId, sessionId })),
        new Set([...deferredState.pending.map(entry => entry.key), ...deferredState.sending]),
      ).filter(card => {
        const suggestion = card.item.signInRuleSuggestion?.suggestion;
        return suggestion === undefined || !answeredSuggestions.has(answered, card.daemonId, suggestion);
      }),
    [unread, boards, deferredState, answered],
  );
  // A reply just sent leaves the deck at once, and an Undo's card is back at once, before any board says so.
  const freshCards = useMemo(() => withRepliedCards(boardCards, repliedState), [boardCards, repliedState]);
  const cards = useStable(freshCards, cardsKey(freshCards));
  // The overlay goes the moment the boards agree with it: parked or gone (or asked again), or listed open once Undo landed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `repliedState` is the trigger -- a new entry (or Undo settling) must be checked against the boards at once
  useEffect(() => {
    const listed = new Set(boardCards.map(card => card.key));
    replied.reconcile((card): BoardItemRead => {
      const board = boards.snapshots.get(daemonSessionKey({ daemonId: card.daemonId, sessionId: card.view.config.id }));
      return board === undefined ? undefined : (board.items.find(item => item.id === card.item.id) ?? null);
    }, listed);
  }, [replied, repliedState, boards, boardCards]);
  // A gate item stands in for its card's to-test row on a machine that raises them, open or parked (`gateHolders`).
  const sources = useMemo(
    () =>
      withMachine.map(machine => ({
        daemonId: machine.connection.daemonId,
        name: machine.name,
        sessions: machine.sessions,
      })),
    [withMachine],
  );
  // A conversation's items: its board when this device holds one (it is the newer), else the machine's roll-up.
  const itemsOf = useCallback(
    (daemonId: DaemonId, sessionId: string): BoardItems | undefined =>
      boards.snapshots.get(daemonSessionKey({ daemonId, sessionId })) ?? {
        items: rollup.boards.get(daemonId)?.get(sessionId) ?? [],
      },
    [boards, rollup],
  );
  const boardOf = useCallback(
    (daemonId: DaemonId, sessionId: string): readonly AgendaItem[] => itemsOf(daemonId, sessionId)?.items ?? [],
    [itemsOf],
  );
  const recordsOf = useCallback(
    (daemonId: DaemonId, sessionId: string): readonly AgendaListRecord[] =>
      boards.snapshots.get(daemonSessionKey({ daemonId, sessionId }))?.resolved ?? NO_RECORDS,
    [boards],
  );
  const holders = useMemo(() => gateHolders(unread, sources, itemsOf), [unread, sources, itemsOf]);
  const offersGates = useCallback(
    (daemonId: DaemonId): boolean => gateFlags.includes(`${daemonId}=true/`),
    [gateFlags],
  );
  // A machine with card asks (`agenda.card-asks.1`) carries a card's ask inside its agenda: it keeps no To-test list.
  const hasCardAsks = useCallback(
    (daemonId: DaemonId): boolean =>
      gateFlags
        .split(',')
        .some(entry => entry.startsWith(`${daemonId}=`) && entry.slice(daemonId.length + 1).split('/')[1] === 'true'),
    [gateFlags],
  );
  const awakeRows = useMemo(
    () => toTestBesideGates(split.awake, holders, offersGates).filter(row => !hasCardAsks(row.card.daemonId)),
    [split.awake, holders, offersGates, hasCardAsks],
  );
  const snoozedRows = useMemo(
    () => toTestBesideGates(split.snoozed, holders, offersGates).filter(row => !hasCardAsks(row.card.daemonId)),
    [split.snoozed, holders, offersGates, hasCardAsks],
  );
  // Every card read for a try, replaced by a gate item or not: a card ask carries the card's id, the board its steps.
  const howToTestFor = useCallback(
    (daemonId: DaemonId, cardId: string): string | null =>
      named.find(row => row.card.daemonId === daemonId && row.card.task.id === cardId)?.howToTest ?? null,
    [named],
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
  const failed = (entry: UnreadSession): BoardReadFailure | undefined =>
    held(entry) ? undefined : failedBoards.get(boardKey(entry));
  const reading = unread.some(entry => !held(entry) && failed(entry) === undefined);
  const total = inboxCount(unread, held, cards, toTest.length);
  const freshUnavailable = inboxUnavailable(unread, failed);
  const unavailable = useStable(
    freshUnavailable,
    freshUnavailable
      .map(entry => `${entry.daemonId}\u0000${entry.machineName}\u0000${entry.items}\u0000${entry.why ?? ''}`)
      .join('\u0001'),
  );
  const resolved = useMemo(
    () =>
      inboxResolved(sources, (daemonId, sessionId) => boards.snapshots.get(daemonSessionKey({ daemonId, sessionId }))),
    [sources, boards],
  );
  const freshParked = useMemo(
    () =>
      withRepliedParked(
        inboxParked(
          sources,
          itemsOf,
          new Set([...deferredState.pending.map(entry => entry.key), ...deferredState.sending]),
        ),
        repliedState,
      ),
    [sources, itemsOf, deferredState, repliedState],
  );
  const parked = useStable(freshParked, cardsKey(freshParked));
  // Every machine's roll-up of its conversations' items is read to the end on mount and whenever the owner opens
  // a filter beyond Open.
  const readRollups = useCallback(
    (): readonly Promise<void>[] => latest.current.map(({ connection }) => client.rollup.read(connection)),
    [client],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: the set of machines is the signal to read again
  useEffect(() => {
    void machineKey;
    void readRollups();
  }, [machineKey, readRollups]);
  const parkedWhole = useMemo(
    () => machines.length > 0 && machines.every(({ connection }) => rollup.complete.has(connection.daemonId)),
    [machines, rollup],
  );
  // A card that says "Merged in from !A5" names it from the resolved records of its conversation, which only a held
  // board carries (a roll-up has the open items alone): read that one board, once, instead of showing the bare id.
  const mergedRead = useRef(new Set<string>());
  useEffect(() => {
    for (const card of [...cards, ...parked, ...withFerret]) {
      if (card.item.mergedFrom === undefined) continue;
      const key = daemonSessionKey({ daemonId: card.daemonId, sessionId: card.view.config.id });
      const connection = connectionFor(card.daemonId);
      if (connection === undefined || boards.snapshots.has(key) || mergedRead.current.has(key)) continue;
      mergedRead.current.add(key);
      client.revalidate(connection, daemonSessionScope(connection, card.view.config.id)).catch(() => {
        mergedRead.current.delete(key);
      });
    }
  }, [cards, parked, withFerret, boards, client, connectionFor]);
  const [resolvedReading, setResolvedReading] = useState(false);
  const resolvedBusy = useRef(false);
  const loadResolved = useCallback((): void => {
    if (resolvedBusy.current) return;
    const wanted = sessionsToReadForResolved(sources, (daemonId, sessionId) =>
      boards.snapshots.has(daemonSessionKey({ daemonId, sessionId })),
    );
    const reads = [
      ...readRollups(),
      ...wanted.flatMap(({ daemonId, sessionId }) => {
        const connection = connectionFor(daemonId);
        return connection === undefined
          ? []
          : [client.revalidate(connection, daemonSessionScope(connection, sessionId)).catch(() => undefined)];
      }),
    ];
    if (reads.length === 0) return;
    resolvedBusy.current = true;
    setResolvedReading(true);
    void Promise.all(reads).finally(() => {
      resolvedBusy.current = false;
      setResolvedReading(false);
    });
  }, [client, connectionFor, sources, boards, readRollups]);

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
      parkedWhole,
      resolved,
      resolvedReading,
      loadResolved,
      deferred,
      deferredState,
      replied,
      repliedState,
      connectionFor,
      howToTestFor,
      agendaClient: client,
      boardOf,
      recordsOf,
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
      parkedWhole,
      resolved,
      resolvedReading,
      loadResolved,
      deferred,
      deferredState,
      replied,
      repliedState,
      connectionFor,
      howToTestFor,
      client,
      boardOf,
      recordsOf,
    ],
  );
}

export const AgendaInboxContext = createContext<AgendaInbox | null>(null);

/** The shell's inbox, or `null` outside a shell (a harness, a render test that mounts no provider). */
export const useAgendaInbox = (): AgendaInbox | null => useContext(AgendaInboxContext);
