/**
 * WHAT AN OPEN ITEM KNOWS ABOUT ITS OWN LIFE, read from the machine: the
 * versions it was kept as (for the diff), the whole stored conversation (for part 6), and a merge with another agenda.
 * One hook both hosts (the chat and the Inbox) use, so neither learns the routes. Every read is best effort: a machine
 * that does not answer, or answers 404, leaves the item drawn the older way (no diff control, the rebuilt thread).
 *
 * THE SEEN MARK: opening an item writes this device's mark for its newest version (`PUT …/seen`). The BASELINE the diff
 * compares from is read BEFORE that write and kept for as long as the item stays open, so "since you last looked" is
 * what changed since the previous visit, not nothing at all.
 */

import {
  type AgendaConversationEntry,
  type AgendaId,
  type AgendaItem,
  type AgendaVersionList,
  isMachineAgendaId,
} from '../../wire/index.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type DaemonAgendaClient,
  fetchAgendaConversation,
  fetchAgendaVersion,
  fetchAgendaVersions,
  markAgendaVersionSeen,
} from '../../lib/agenda-client.ts';
import {
  type ConversationGap,
  hasStoredConversation,
  storedCount,
  tailIsWhole,
} from '../../lib/agenda-conversation.ts';
import { type LineageTitles, lineageTitles, mergeCandidates, mergeOffered } from '../../lib/agenda-merge.ts';
import type { DaemonConnection } from '../../shell.ts';
import type { DaemonSessionScope } from '../../shell.ts';
import { useDaemonFetch } from '../../shell.ts';

/** The versions of the open item, as the diff control reads them. */
export interface AgendaVersionsView {
  /** Every version kept, newest last; `seen` is what this device had seen when the item was opened. */
  readonly list: AgendaVersionList;
  /** One whole version of the item; resolved at most once per number (versions never change). */
  readonly load: (version: number) => Promise<AgendaItem>;
}

/** What "Merge with…" needs: the agendas it can join, and the call that joins them. */
export interface AgendaMergeView {
  readonly candidates: readonly AgendaItem[];
  /** Merges `absorbed` into `survivor`; rejects with the machine's own words when it refuses. */
  readonly merge: (survivor: AgendaId, absorbed: AgendaId) => Promise<void>;
}

export interface ItemLifecycle {
  /**
   * The stored entries in hand, oldest first: the whole thread, or (while the earlier part is read, or when it cannot be)
   * the entries read so far and the item's own recent tail, with `gap` saying where the rest belongs. `null` when the
   * item keeps none (the rebuilt thread is drawn).
   */
  readonly conversation: readonly AgendaConversationEntry[] | null;
  /** Entries of the stored thread not in hand; absent when `conversation` is the whole thread. */
  readonly conversationGap?: ConversationGap;
  /** The titles of the agendas this item was merged into or split from, where the board holds them. */
  readonly lineageTitles?: LineageTitles;
  /** The diff control's data; absent where the machine keeps no versions or the item has fewer than two. */
  readonly versions?: AgendaVersionsView;
  /** The merge control's data; absent where a merge is not offered. */
  readonly merge?: AgendaMergeView;
}

export interface UseItemLifecycleInput {
  /** The machine the item is on; `undefined` (not paired right now): nothing is read. */
  readonly connection: DaemonConnection | undefined;
  readonly scope: DaemonSessionScope;
  /** What sends a merge; absent: the item can be read here but not merged. */
  readonly client: Partial<Pick<DaemonAgendaClient, 'merge'>> | undefined;
  /** The item shown; `undefined`: nothing is open and nothing is read. */
  readonly item: AgendaItem | undefined;
  /** The open items on the same board: what a merge can join. */
  readonly board: readonly AgendaItem[];
  /** The resolved records on the same board: an item merged into another is closed, so its title is read from here. */
  readonly records?: readonly Pick<AgendaItem, 'id' | 'title' | 'subject'>[];
}

const NONE = { conversation: null } as const;
const NO_TITLES: LineageTitles = {};
const NO_RECORDS: readonly Pick<AgendaItem, 'id' | 'title' | 'subject'>[] = [];
const NO_ENTRIES: readonly AgendaConversationEntry[] = [];

export const useItemLifecycle = ({
  connection,
  scope,
  client,
  item,
  board,
  records = NO_RECORDS,
}: UseItemLifecycleInput): ItemLifecycle => {
  const fetcher = useDaemonFetch();
  const offered = connection !== undefined && !isMachineAgendaId(scope.sessionId);
  const id = item?.id;
  const open = offered && connection !== undefined && id !== undefined;
  const marked = useRef(new Map<string, number>());

  // ONE OPENING: what was read belongs to the item it was read for, and a new item starts afresh.
  const [read, setRead] = useState<{
    readonly key: string;
    readonly list: AgendaVersionList | null;
    readonly baseline: number | null | undefined;
  }>({ key: '', list: null, baseline: undefined });
  const key = `${connection?.daemonId ?? ''}:${scope.sessionId}:${id ?? ''}`;
  const versionCount = item?.revisions === undefined ? 1 : item.revisions.length + 1;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the item's key and its version count are the triggers
  useEffect(() => {
    if (!open || connection === undefined || id === undefined) return undefined;
    let live = true;
    void (async () => {
      try {
        const list = await fetchAgendaVersions(connection, scope, id, fetcher);
        if (!live) return;
        // The baseline is the mark BEFORE this opening wrote its own; later reads of the same opening keep it.
        setRead(current => ({
          key,
          list,
          baseline: current.key === key && current.baseline !== undefined ? current.baseline : (list.seen ?? null),
        }));
        if (list.latest >= 1 && list.latest > (marked.current.get(key) ?? 0)) {
          marked.current.set(key, list.latest);
          await markAgendaVersionSeen(connection, scope, id, list.latest, fetcher);
        }
      } catch {
        if (live) setRead(current => (current.key === key ? current : { key, list: null, baseline: undefined }));
      }
    })();
    return () => {
      live = false;
    };
  }, [open, key, versionCount, fetcher]);

  const cache = useRef(new Map<string, Promise<AgendaItem>>());
  const load = useCallback(
    (version: number): Promise<AgendaItem> => {
      if (connection === undefined) return Promise.reject(new Error('not paired'));
      const at = `${key}:${String(version)}`;
      const kept = cache.current.get(at);
      if (kept !== undefined) return kept;
      const next = fetchAgendaVersion(connection, scope, id as AgendaId, version, fetcher).then(
        found => found.item as AgendaItem,
      );
      next.catch(() => cache.current.delete(at));
      cache.current.set(at, next);
      return next;
    },
    [connection, scope, id, key, fetcher],
  );

  const mine = read.key === key ? read : null;
  const baseline = mine?.baseline;
  const versions = useMemo<AgendaVersionsView | undefined>(() => {
    if (mine?.list == null || mine.list.latest < 2) return undefined;
    const { seen: _seen, ...rest } = mine.list;
    const list: AgendaVersionList = baseline === null || baseline === undefined ? rest : { ...rest, seen: baseline };
    return { list, load };
  }, [mine?.list, baseline, load]);

  // THE STORED THREAD: the item's own tail when it is whole. Else the tail is drawn AT ONCE, and the entries before it are
  // read through the conversation route: only the ones not already in hand, and only those the tail does not hold.
  const stored = item !== undefined && open && hasStoredConversation(item);
  const whole = item !== undefined && tailIsWhole(item);
  const tail = item?.conversation ?? NO_ENTRIES;
  const count = item === undefined ? 0 : storedCount(item);
  const earlierCount = Math.max(0, count - tail.length);
  // A merge interleaves the absorbed thread into this one by time, so what was read before it is no longer a prefix.
  const thread = `${key}|${item?.mergedFrom?.join(',') ?? ''}`;
  const earlier = useRef(new Map<string, AgendaConversationEntry[]>());
  const [reading, setReading] = useState<{
    readonly key: string;
    readonly count: number;
    readonly state: 'loading' | 'failed' | 'capped' | 'done';
  } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the thread, its stored count and the entries before the tail are the triggers
  useEffect(() => {
    if (!stored || whole || connection === undefined || id === undefined) return undefined;
    const have = earlier.current.get(thread) ?? [];
    if (have.length >= earlierCount) {
      setReading({ key: thread, count: earlierCount, state: 'done' });
      return undefined;
    }
    let live = true;
    setReading({ key: thread, count: earlierCount, state: 'loading' });
    fetchAgendaConversation(connection, scope, id, { from: have.length, until: earlierCount }, fetcher)
      .then(read => {
        if (!live) return;
        earlier.current.set(thread, [...have, ...read.entries]);
        setReading({ key: thread, count: earlierCount, state: read.capped ? 'capped' : 'done' });
      })
      .catch(() => {
        if (live) setReading({ key: thread, count: earlierCount, state: 'failed' });
      });
    return () => {
      live = false;
    };
  }, [stored, whole, thread, count, earlierCount, fetcher]);
  const inHand = whole ? [] : (earlier.current.get(thread) ?? []).slice(0, earlierCount);
  const missing = earlierCount - inHand.length;
  const state = reading?.key === thread ? reading.state : 'loading';
  const conversation = !stored ? null : [...inHand, ...tail];
  const conversationGap: ConversationGap | undefined =
    !stored || whole || missing <= 0
      ? undefined
      : { at: inHand.length, count: missing, state: state === 'done' ? 'failed' : state };

  const merge = useMemo<AgendaMergeView | undefined>(() => {
    const merger = client?.merge;
    if (item === undefined || client === undefined || merger === undefined || connection === undefined)
      return undefined;
    if (!mergeOffered({ hostMerges: true, item })) return undefined;
    return {
      candidates: mergeCandidates(item, board),
      merge: (survivor, absorbed) => merger.call(client, connection, scope, survivor, absorbed),
    };
  }, [item, client, board, connection, scope]);

  const titles = useMemo(
    () => (item === undefined ? NO_TITLES : lineageTitles(item, [...board, ...records])),
    [item, board, records],
  );
  const named = Object.keys(titles).length === 0 ? {} : { lineageTitles: titles };
  if (!open) {
    // A one-item read already supplied these words. Reading the stored tail needs no health feature or extra route
    // (the machine agenda has no conversation endpoint); an incomplete tail says exactly what could not be read.
    if (item === undefined || !hasStoredConversation(item)) return { ...NONE, ...named };
    return {
      conversation: tail,
      ...named,
      ...(earlierCount > 0 ? { conversationGap: { at: 0, count: earlierCount, state: 'failed' as const } } : {}),
    };
  }
  return {
    conversation,
    ...named,
    ...(conversationGap === undefined ? {} : { conversationGap }),
    ...(versions === undefined ? {} : { versions }),
    ...(merge === undefined ? {} : { merge }),
  };
};
