/**
 * The browser entry for the Queue page over a LONG history: the REAL `QueuePageView` over the real
 * `ferretRows`, `refreshQueueHistory` and `extendQueueHistory`, fed by a fake machine that answers the
 * daemon's window (the newest page and every message still waiting) and then older pages by cursor.
 *
 * Fixture data only: 54 invented messages to a ferret called Casen, two of them still waiting from long ago.
 * The page size here is 12 so a screenshot holds the boundary; the daemon's is 100.
 *
 * `?theme=<family>-<mode>` picks the theme. `window.__queuePage.reads` lists the cursors asked for.
 */

import type { QueuedMessage } from '@ferretry/protocol';
import { useCallback, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueuePageView } from '../../../src/components/queue-page.tsx';
import { ferretRows, type QueueGroup } from '../../../src/lib/queue-view.ts';
import { extendQueueHistory, type QueueHistory, refreshQueueHistory } from '../../../src/lib/send-queue.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const PAGE = 12;
const TOTAL = 54;
const WAITING = new Set([2, 9]);

const TOPICS = [
  'Can you rebase the retry branch and tell me when CI is green?',
  'The nightly sweep skipped two sessions; please check the archive rule.',
  'Thanks — merged. Start on the paging change next.',
  'Please summarise what the Warden flagged this morning.',
  'Hold the release until the pairing screenshots are in.',
];

const fixture: readonly QueuedMessage[] = Array.from({ length: TOTAL }, (_, n): QueuedMessage => {
  const at = new Date(NOW - (TOTAL - n) * 37 * 60_000).toISOString();
  return {
    v: 1,
    id: `m${String(n).padStart(3, '0')}`,
    sender: 'human',
    text: `${TOPICS[n % TOPICS.length]} (${String(n + 1)})`,
    attachmentIds: [],
    enqueuedAt: at,
    state: WAITING.has(n) ? 'queued' : 'read',
    stateAt: at,
    revision: 1,
    ...(WAITING.has(n) ? { waitReason: 'busy' as const } : {}),
  };
});

/** What the fake machine answers: oldest first, as the daemon does. */
const answer = (
  before?: string,
): { readonly messages: readonly QueuedMessage[]; readonly nextCursor: string | null } => {
  const newestFirst = [...fixture].reverse();
  const start = before === undefined ? 0 : newestFirst.findIndex(message => message.id === before) + 1;
  const page = newestFirst.slice(start, start + PAGE);
  const open = (message: QueuedMessage): boolean => message.state === 'queued';
  const extras = before === undefined ? newestFirst.slice(start + PAGE).filter(open) : [];
  const shown = before === undefined ? [...page, ...extras] : page.filter(message => !open(message));
  const last = page.at(-1);
  return {
    messages: shown.reverse(),
    nextCursor: last !== undefined && start + page.length < newestFirst.length ? last.id : null,
  };
};

const probe = { reads: [] as string[] };
(window as unknown as { __queuePage: typeof probe }).__queuePage = probe;

const KEY = 'daemon-queue/s1';

function Scene() {
  const [history, setHistory] = useState<QueueHistory>(() => refreshQueueHistory(undefined, answer()));
  const [loading, setLoading] = useState(false);
  const loadOlder = useCallback(() => {
    if (history.cursor === null) return;
    setLoading(true);
    probe.reads.push(history.cursor);
    const page = answer(history.cursor);
    setHistory(extendQueueHistory(history, page));
    setLoading(false);
  }, [history]);
  const groups = useMemo<readonly QueueGroup[]>(
    () => [
      {
        key: KEY,
        daemonId: 'daemon-queue',
        machine: 'Studio',
        sessionId: 's1',
        ferret: 'Casen',
        rows: ferretRows('daemon-queue', 's1', 'Casen', history.messages, [], NOW),
      },
    ],
    [history],
  );
  return (
    <QueuePageView
      groups={groups}
      handlers={{ edit: async () => undefined, cancel: async () => undefined }}
      loading={false}
      loadingOlder={loading ? KEY : null}
      now={NOW}
      olderKeys={history.cursor === null ? new Set() : new Set([KEY])}
      onLoadOlder={loadOlder}
      onOpenFerret={() => undefined}
      onShowAll={() => undefined}
      showMachine={false}
      title="Queue — Casen"
    />
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<Scene />);
