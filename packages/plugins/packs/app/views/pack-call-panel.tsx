import type { PanelProps } from '@ferretry/kernel/manifest';
import type { ConversationRowProps } from '@ferretry/plugin-conversation/contract';
import { type ReactNode, useMemo, useSyncExternalStore } from 'react';
import { PackCallRow, PackRowsProvider } from '../components/pack-call.tsx';
import type { PacksClient } from '../lib/client.ts';
import { packCardsOf } from '../lib/pack-row-cards.ts';
import { createPackTableFeed, type PackTableFeed } from '../lib/pack-table-feed.ts';
import { shellClock } from '../ui.ts';

/** A Pack card is a message-density row, as the transcript's own rows are (`data-transcript-density`). */
const MESSAGE_RHYTHM = { 'data-transcript-density': 'message' } as const;

/** What the chat hands a `conversation.row` panel: the ferret as `subject`, and the row. */
type RowPanelProps = PanelProps & Partial<ConversationRowProps>;

function Cards({
  feed,
  entry,
  ferretId,
}: {
  readonly feed: PackTableFeed;
  readonly entry: NonNullable<RowPanelProps['entry']>;
  readonly ferretId: string;
}) {
  const cards = useMemo(() => packCardsOf(entry), [entry]);
  const rows = useSyncExternalStore(
    onChange => feed.watch(ferretId, onChange),
    () => feed.rows(ferretId),
    () => undefined,
  );
  if (cards.length === 0) return null;
  return (
    <PackRowsProvider rows={rows}>
      {cards.map(card =>
        card.pack === undefined ? null : (
          <PackCallRow entry={card} key={card.id} pack={card.pack} rhythm={MESSAGE_RHYTHM} />
        ),
      )}
    </PackRowsProvider>
  );
}

/**
 * The Pack card (`conversation.row` › `pack-call`): beside a transcript row that holds a Pack command the ferret ran
 * (`fy new`, `fy wait`, `fy recommend`), what it started, was refused, collected or was told. It reads the row Conversation
 * offers (the `fy` commands of a tool row, masked as the daemon masked the transcript) and the lead's pack table, so a
 * started helper's state stays live. A row with no Pack command draws nothing and reads nothing.
 */
export const createPanel = (client: PacksClient): ((props: RowPanelProps) => ReactNode) => {
  const feed = createPackTableFeed(client, (ms, run) => shellClock.every(ms, run));
  return function PackCallPanel({ subject, entry }: RowPanelProps) {
    if (subject === undefined || entry === undefined || packCardsOf(entry).length === 0) return null;
    return <Cards entry={entry} feed={feed} ferretId={subject} />;
  };
};
