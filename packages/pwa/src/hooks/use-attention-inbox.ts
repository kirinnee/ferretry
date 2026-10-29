/**
 * THE ATTENTION INBOX, wired: every paired machine's session list read for `state.attention`, the
 * boards of exactly the conversations it names, and the answers held for their undo window.
 *
 * Mounted ONCE, by the shell, and handed down through `AttentionInboxContext` — so the phone's
 * Attention tab, the sidebar's entry, the Sessions page's Needs-you deck and the inbox page all count
 * and deal the same cards, and an answer still inside its undo window survives a navigation.
 *
 * A BOARD IS READ WHEN ITS SUMMARY MOVES, and only then. The daemon rewrites `state.attention` on every
 * board change and the fleet feed re-reads the list, so a changed summary is the signal; an unchanged
 * one reads nothing. A conversation that stops being unread is not read again.
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
import type { DaemonAttentionClient } from '../lib/attention-client.ts';
import {
  attentionSummaryKey,
  DeferredAttentionActions,
  type DeferredAttentionState,
  type DeferredTimers,
  type InboxAction,
  type InboxCard,
  type InboxResolved,
  inboxCards,
  inboxResolved,
  sessionsToReadForResolved,
  type UnreadSession,
  unreadSessions,
  unreadTotal,
} from '../lib/attention-inbox.ts';
import type { DaemonConnection, DaemonId } from '../lib/daemon-connection.ts';
import { daemonSessionKey, daemonSessionScope } from '../lib/daemon-scope.ts';
import type { DaemonFleetStore } from '../lib/fleet-store.ts';

/** One paired machine, as the inbox reads it: its pairing, its name, its last session list. */
export interface AttentionInboxMachine {
  readonly connection: DaemonConnection;
  readonly name: string;
  readonly sessions: readonly SessionView[] | null;
}

export interface AttentionInbox {
  /** Conversations with open Attention, newest needing you first. */
  readonly unread: readonly UnreadSession[];
  /** Open items across them: the number every Attention badge shows. */
  readonly total: number;
  /** The deck: every read open item, newest first, minus the answers still undoable or in flight. */
  readonly cards: readonly InboxCard[];
  /** True while an unread conversation's board has not been read yet. */
  readonly reading: boolean;
  /** Resolved items of every conversation whose board is held, newest first: the Resolved filter's list. */
  readonly resolved: readonly InboxResolved[];
  /** True while `loadResolved` is reading boards. */
  readonly resolvedReading: boolean;
  /** Reads the recent conversations' boards that are not held yet, once per call that finds any. */
  readonly loadResolved: () => void;
  readonly deferred: DeferredAttentionActions;
  readonly deferredState: DeferredAttentionState;
  readonly connectionFor: (daemonId: DaemonId) => DaemonConnection | undefined;
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
): readonly AttentionInboxMachine[] => {
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

/** Sends one inbox answer through the ONE attention client, to the machine the card came from. */
const runInboxAction = async (
  client: Pick<DaemonAttentionClient, 'respond' | 'resolve' | 'dismiss' | 'needsInfo'>,
  connection: DaemonConnection,
  card: InboxCard,
  action: InboxAction,
): Promise<void> => {
  const scope = daemonSessionScope(connection, card.view.config.id);
  if (action.kind === 'respond') await client.respond(connection, scope, card.item.id, action.response);
  else if (action.kind === 'dismiss') await client.dismiss(connection, scope, card.item.id, action.note);
  else if (action.kind === 'needs-info') await client.needsInfo(connection, scope, card.item.id, action.note);
  else await client.resolve(connection, scope, card.item.id, action.note);
};

/**
 * The previous value while `key` holds still. The fleet is re-read every few seconds and every read is
 * a new array of new views; the inbox's consumers (every badge, the sidebar entry, the decks) must not
 * re-render for a read that changed nothing about Attention.
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
        attentionSummaryKey(entry.attention),
      ].join('\u0000'),
    )
    .join('\u0001');

const cardsKey = (cards: readonly InboxCard[]): string =>
  cards.map(card => `${card.key}\u0000${JSON.stringify(card.item)}`).join('\u0001');

export function useAttentionInboxModel(
  client: DaemonAttentionClient,
  machines: readonly AttentionInboxMachine[],
  timers?: DeferredTimers,
): AttentionInbox {
  const latest = useRef(machines);
  latest.current = machines;
  const connectionFor = useMemo(
    () =>
      (daemonId: DaemonId): DaemonConnection | undefined =>
        latest.current.find(machine => machine.connection.daemonId === daemonId)?.connection,
    [],
  );
  const deferred = useMemo(
    () =>
      new DeferredAttentionActions(async (card, action) => {
        const connection = connectionFor(card.daemonId);
        if (connection === undefined) throw new Error('That machine is no longer paired with this browser.');
        await runInboxAction(client, connection, card, action);
      }, timers),
    [client, connectionFor, timers],
  );
  // An answer the reader gave is sent, not dropped, when the page goes away.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const flush = (): void => deferred.flush();
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
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

  // Read each unread conversation's board when its summary moved since the last read.
  const readKeys = useRef(new Map<string, string>());
  useEffect(() => {
    const seen = new Set<string>();
    for (const entry of unread) {
      const connection = connectionFor(entry.daemonId);
      if (connection === undefined) continue;
      const scope = daemonSessionScope(connection, entry.view.config.id);
      const id = daemonSessionKey(scope);
      const key = attentionSummaryKey(entry.attention);
      seen.add(id);
      if (readKeys.current.get(id) === key) continue;
      readKeys.current.set(id, key);
      void client.revalidate(connection, scope).catch(() => undefined);
    }
    for (const id of [...readKeys.current.keys()]) if (!seen.has(id)) readKeys.current.delete(id);
  }, [client, connectionFor, unread]);

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
  const reading = unread.some(
    entry => !boards.snapshots.has(daemonSessionKey({ daemonId: entry.daemonId, sessionId: entry.view.config.id })),
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
      total: unreadTotal(unread),
      cards,
      reading,
      resolved,
      resolvedReading,
      loadResolved,
      deferred,
      deferredState,
      connectionFor,
    }),
    [unread, cards, reading, resolved, resolvedReading, loadResolved, deferred, deferredState, connectionFor],
  );
}

export const AttentionInboxContext = createContext<AttentionInbox | null>(null);

/** The shell's inbox, or `null` outside a shell (a harness, a render test that mounts no provider). */
export const useAttentionInbox = (): AttentionInbox | null => useContext(AttentionInboxContext);
