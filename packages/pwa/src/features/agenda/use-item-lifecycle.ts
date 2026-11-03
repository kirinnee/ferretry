/**
 * WHAT AN OPEN ITEM KNOWS ABOUT ITS OWN LIFE, read from the machine when it speaks `agenda.conversation.1`: the
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
} from '@ferretry/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type DaemonAgendaClient,
  fetchAgendaConversation,
  fetchAgendaVersion,
  fetchAgendaVersions,
  markAgendaVersionSeen,
} from '../../lib/agenda-client.ts';
import { hasStoredConversation, tailIsWhole } from '../../lib/agenda-conversation.ts';
import { mergeCandidates, mergeOffered } from '../../lib/agenda-merge.ts';
import { useAgendaConversationOffered } from '../../lib/agenda-wire-react.tsx';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';

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
  /** The item's whole stored thread; `null` until read, or when the item keeps none (the rebuilt thread is drawn). */
  readonly conversation: readonly AgendaConversationEntry[] | null;
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
}

const NONE: ItemLifecycle = { conversation: null };

export const useItemLifecycle = ({ connection, scope, client, item, board }: UseItemLifecycleInput): ItemLifecycle => {
  const machineKeeps = useAgendaConversationOffered(connection?.daemonId) === true;
  const offered = machineKeeps && connection !== undefined && !isMachineAgendaId(scope.sessionId);
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
        const list = await fetchAgendaVersions(connection, scope, id);
        if (!live) return;
        // The baseline is the mark BEFORE this opening wrote its own; later reads of the same opening keep it.
        setRead(current => ({
          key,
          list,
          baseline: current.key === key && current.baseline !== undefined ? current.baseline : (list.seen ?? null),
        }));
        if (list.latest >= 1 && list.latest > (marked.current.get(key) ?? 0)) {
          marked.current.set(key, list.latest);
          await markAgendaVersionSeen(connection, scope, id, list.latest);
        }
      } catch {
        if (live) setRead(current => (current.key === key ? current : { key, list: null, baseline: undefined }));
      }
    })();
    return () => {
      live = false;
    };
  }, [open, key, versionCount]);

  const cache = useRef(new Map<string, Promise<AgendaItem>>());
  const load = useCallback(
    (version: number): Promise<AgendaItem> => {
      if (connection === undefined) return Promise.reject(new Error('not paired'));
      const at = `${key}:${String(version)}`;
      const kept = cache.current.get(at);
      if (kept !== undefined) return kept;
      const next = fetchAgendaVersion(connection, scope, id as AgendaId, version).then(
        found => found.item as AgendaItem,
      );
      next.catch(() => cache.current.delete(at));
      cache.current.set(at, next);
      return next;
    },
    [connection, scope, id, key],
  );

  const mine = read.key === key ? read : null;
  const baseline = mine?.baseline;
  const versions = useMemo<AgendaVersionsView | undefined>(() => {
    if (mine?.list == null || mine.list.latest < 2) return undefined;
    const { seen: _seen, ...rest } = mine.list;
    const list: AgendaVersionList = baseline === null || baseline === undefined ? rest : { ...rest, seen: baseline };
    return { list, load };
  }, [mine?.list, baseline, load]);

  // THE STORED THREAD: the item's own tail when it is whole, else every entry read through the conversation route.
  const stored = item !== undefined && open && hasStoredConversation(item);
  const whole = item !== undefined && tailIsWhole(item);
  const [thread, setThread] = useState<{
    readonly key: string;
    readonly entries: readonly AgendaConversationEntry[];
  } | null>(null);
  const count = item?.conversationCount ?? item?.conversation?.length ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new entry (the count) is the trigger
  useEffect(() => {
    if (!stored || whole || connection === undefined || id === undefined) return undefined;
    let live = true;
    fetchAgendaConversation(connection, scope, id)
      .then(entries => {
        if (live) setThread({ key, entries });
      })
      .catch(() => {
        if (live) setThread(null);
      });
    return () => {
      live = false;
    };
  }, [stored, whole, key, count]);
  const conversation = !stored
    ? null
    : whole
      ? (item?.conversation ?? [])
      : thread?.key === key
        ? thread.entries
        : null;

  const merge = useMemo<AgendaMergeView | undefined>(() => {
    const merger = client?.merge;
    if (item === undefined || client === undefined || merger === undefined || connection === undefined)
      return undefined;
    if (!mergeOffered({ machineMerges: offered, hostMerges: true, item })) return undefined;
    return {
      candidates: mergeCandidates(item, board),
      merge: (survivor, absorbed) => merger.call(client, connection, scope, survivor, absorbed),
    };
  }, [item, client, offered, board, connection, scope]);

  if (!open) return NONE;
  return {
    conversation,
    ...(versions === undefined ? {} : { versions }),
    ...(merge === undefined ? {} : { merge }),
  };
};
