/**
 * THE ALL QUEUES SCREEN (`screens.queues`, `/queues`): every ferret's queue on this machine in one place, as v4's
 * "All queues" page was. It is the single-ferret queue page's own view (`QueuePageView`) over every ferret that has
 * something waiting, with the same Edit and Cancel on each message; a ferret's name opens that ferret's chat, whose
 * `ferret.side` panel is its queue.
 *
 * Reads: ONE list read of the ferrets (`GET /v1/ferrets`, again on `FerretsChanged`) and ONE queue read per listed
 * ferret (`GET /v1/ferrets/:ferretId/queue`, the newest window: everything that waits is in it, so no older pages).
 * The queues are read again on the queue page's own cadence (`POLL_MS`) and at once when a queue event is heard. A ferret
 * whose queue cannot be read keeps what was last read and says it could not be read (it is never counted as empty); a
 * list that cannot be read says why instead of "Nothing is waiting"; a message saved on this device for a ferret the
 * list does not name still shows. The empty state is only for when every read answered and every queue is empty.
 */

import { DaemonCallError, useOptionalRouter, useScreenHref } from '@ferretry/app';
import { type FerretSummary, FerretSummarySchema, FerretsChanged } from '@ferretry/core-ferrets/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { z } from 'zod';
import { QueueChanged, type QueuedMessage } from '@ferretry/core-mailbox/contract';
import { MessageSent } from '../../contract/index.ts';
import { useConversationClient, useConversationDaemon } from '../client.ts';
import { useSendOutbox } from '../composer/send-outbox-wiring.ts';
import { NO_OUTBOX, POLL_MS, QueuePageView, type QueueRowHandlers } from './queue-page.tsx';
import { type QueueGroup, ferretRows, queueGroups } from './queue-view.ts';
import { queueActions, readFerretQueuePage } from './send-queue.ts';

/** Ferrets' `GET /v1/ferrets`: every ferret's summary. */
const readFerrets = async (client: Pick<PluginClient, 'call'>): Promise<readonly FerretSummary[]> =>
  z.array(FerretSummarySchema).parse(await client.call('GET /v1/ferrets'));

/** The sentence a failed read says: the daemon's own for a refusal, plain words for anything else. */
const readFailure = (cause: unknown): string =>
  cause instanceof DaemonCallError && cause.message !== '' ? cause.message : 'The daemon’s answer could not be read.';

export function AllQueuesScreen() {
  const client = useConversationClient();
  const daemon = useConversationDaemon();
  if (daemon === undefined) return null;
  return <AllQueues client={client} daemon={daemon} />;
}

/** The screen's body, for a daemon it is told (the screen reads it from the client; a scene names it). */
export function AllQueues({ client, daemon }: { readonly client: PluginClient; readonly daemon: string }) {
  const router = useOptionalRouter();
  const href = useScreenHref();
  const outboxStore = useSendOutbox();
  const store = outboxStore ?? NO_OUTBOX;
  const outbox = useSyncExternalStore(store.subscribe, store.snapshot);
  const [ferrets, setFerrets] = useState<readonly FerretSummary[] | undefined>(undefined);
  const [queues, setQueues] = useState<ReadonlyMap<string, readonly QueuedMessage[]>>(new Map());
  const held = useRef<ReadonlyMap<string, readonly QueuedMessage[]>>(new Map());
  // The number of the newest queue poll started: only it may commit (a slower, older answer must not undo a newer one).
  const generation = useRef(0);
  // Why a read failed, in the daemon's words: the list (undefined while it reads), and each ferret's queue by id.
  const [listError, setListError] = useState<string | undefined>(undefined);
  const [unread, setUnread] = useState<ReadonlyMap<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [listTick, setListTick] = useState(0);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick(value => value + 1), []);

  useEffect(() => {
    const cancels = [
      client.subscribe(FerretsChanged, () => {
        setListTick(value => value + 1);
        setTick(value => value + 1);
      }),
      client.subscribe(QueueChanged, refresh),
      client.subscribe(MessageSent, refresh),
    ];
    return () => {
      for (const cancel of cancels) cancel();
    };
  }, [client, refresh]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `listTick` re-reads the list when the ferrets change.
  useEffect(() => {
    let live = true;
    readFerrets(client).then(
      list => {
        if (!live) return;
        setListError(undefined);
        setFerrets(list);
      },
      // A list that cannot be read shows what this device still holds AND says why it is short; the next change
      // reads it again.
      cause => {
        if (!live) return;
        setListError(readFailure(cause));
        setFerrets(previous => previous ?? []);
      },
    );
    return () => {
      live = false;
    };
  }, [client, listTick]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` re-reads after an edit, a cancel or a queue event.
  useEffect(() => {
    if (ferrets === undefined) return;
    let live = true;
    const read = async (): Promise<void> => {
      generation.current += 1;
      const mine = generation.current;
      const answers = new Map<string, readonly QueuedMessage[]>();
      const refused = new Map<string, string>();
      await Promise.all(
        ferrets.map(async ferret => {
          try {
            answers.set(ferret.id, (await readFerretQueuePage(client, ferret.id)).messages);
          } catch (cause) {
            // An unreadable queue keeps what was last read for that ferret, and is said, never counted as empty.
            refused.set(ferret.id, readFailure(cause));
          }
        }),
      );
      if (!live || mine !== generation.current) return;
      const next = new Map<string, readonly QueuedMessage[]>();
      for (const ferret of ferrets) {
        const messages = answers.get(ferret.id) ?? held.current.get(ferret.id);
        if (messages !== undefined) next.set(ferret.id, messages);
      }
      held.current = next;
      setQueues(next);
      setUnread(refused);
      setLoading(false);
    };
    void read();
    const timer = setInterval(() => void read(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [client, ferrets, tick]);

  const groups = useMemo<readonly QueueGroup[]>(() => {
    const listed = ferrets ?? [];
    const out: QueueGroup[] = listed.map(ferret => ({
      key: `${daemon}/${ferret.id}`,
      daemonId: daemon,
      machine: daemon,
      ferretId: ferret.id,
      ferret: ferret.name,
      rows: ferretRows(daemon, ferret.id, ferret.name, queues.get(ferret.id) ?? [], outbox),
      ...(unread.has(ferret.id) ? { unread: unread.get(ferret.id) } : {}),
    }));
    // A message saved on this device for a ferret the list does not name still shows, under its id.
    const seen = new Set<string>(listed.map(ferret => ferret.id));
    for (const entry of outbox) {
      if (entry.daemonId !== daemon || seen.has(entry.ferretId)) continue;
      seen.add(entry.ferretId);
      out.push({
        key: `${daemon}/${entry.ferretId}`,
        daemonId: daemon,
        machine: daemon,
        ferretId: entry.ferretId,
        ferret: entry.ferretId,
        rows: ferretRows(daemon, entry.ferretId, entry.ferretId, [], outbox),
      });
    }
    return queueGroups(out);
  }, [daemon, ferrets, outbox, queues, unread]);

  const handlers = useMemo<QueueRowHandlers>(
    () => ({
      edit: async (row, text) => {
        await queueActions(client, row.ferretId, refresh, outboxStore ?? undefined).edit({ sendId: row.id }, text);
      },
      cancel: async row => {
        await queueActions(client, row.ferretId, refresh, outboxStore ?? undefined).cancel({ sendId: row.id });
      },
    }),
    [client, outboxStore, refresh],
  );

  return (
    <QueuePageView
      error={listError}
      groups={groups}
      handlers={handlers}
      loading={loading}
      onOpenFerret={group => {
        const to = href(daemon, 'conversation', 'chat', { ferret: group.ferretId });
        if (to !== undefined) router?.navigate(to);
      }}
      showMachine={false}
      title="All queues"
      waitingOnly
    />
  );
}
