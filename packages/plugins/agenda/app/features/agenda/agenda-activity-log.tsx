/**
 * THE ACTIVITY LOG OF AN OPEN AGENDA ITEM — the small grey "updated / moved / snoozed" lines (`activityLog`): every
 * stage it entered, every edit with what it changed, and where it rests or sleeps now. FOLDED by default, and kept
 * apart from the conversation, so the words the owner and the ferret said are never buried under bookkeeping.
 */

import { type HistoryEvent, revisionEvents } from '../../lib/agenda-history.ts';
import { activityLog, activityStamp, type RevisionLine } from '../../lib/agenda-item-sections.ts';
import type { AgendaItem } from '@ferretry/core-asks/contract';
import { AgendaFold } from './agenda-fold.tsx';

/** The item's edits, as the log's lines. */
const revisionLines = (events: readonly HistoryEvent[]): readonly RevisionLine[] =>
  events.flatMap(event =>
    event.kind === 'revision' ? [{ key: event.key, at: event.at, version: event.version, summary: event.summary }] : [],
  );

export function AgendaActivityLog({
  item,
  ferret,
  now,
  itemKey,
}: {
  readonly item: AgendaItem;
  readonly ferret: string;
  readonly now: number;
  readonly itemKey: string;
}) {
  const lines = activityLog(item, ferret, revisionLines(revisionEvents(item)), now);
  if (lines.length === 0) return null;
  return (
    <AgendaFold
      itemKey={itemKey}
      meta={`${String(lines.length)} ${lines.length === 1 ? 'entry' : 'entries'}`}
      part="activity"
      title="Activity"
    >
      <ol className="fy-activity" data-agenda-activity="">
        {lines.map(line => {
          const stamp = activityStamp(line.at, now);
          return (
            <li className="fy-activity__line" data-activity={line.key} key={line.key}>
              <p className="fy-activity__text m-0">
                <span>{line.text}</span>
                {stamp === '' ? null : (
                  <time className="fy-activity__time" dateTime={new Date(line.at).toISOString()}>
                    {stamp}
                  </time>
                )}
              </p>
              {line.details.length === 0 ? null : (
                <ul className="fy-activity__details">
                  {line.details.map((detail, index) => (
                    <li key={`${String(index)}:${detail}`}>{detail}</li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </AgendaFold>
  );
}
