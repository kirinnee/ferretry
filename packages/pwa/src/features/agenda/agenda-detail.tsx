/**
 * WHAT AN AGENDA ITEM KNOWS BEYOND ITS QUESTION — what's going on, why it matters, what is already
 * decided, terms (a table), steps, the body with its diagrams and mock-ups, and links. The card itself is
 * minimal (question, options, Skip); this is where the rest is read: beside the card on a wide screen
 * (`layout: 'panel'`, a narrow side column), or as part of ONE full scrollable view on a phone
 * (`layout: 'full'`).
 *
 * IT NEVER SCROLLS BY ITSELF. The column or the page around it scrolls, so there is never a scroll bar
 * inside another; only an fy-render mock-up that is bigger than the width scrolls, inside its own box.
 */

import type { AgendaItem } from '@ferretry/protocol';
import type { ReactNode } from 'react';
import { ChatProse } from '../../components/chat-prose.tsx';
import { revisionHighlight } from '../../lib/agenda-revisions.ts';
import { type AgendaBriefProps, AgendaBriefSections } from './agenda-brief.tsx';
import { AgendaBody, AgendaSteps } from './agenda-steps.tsx';
import { AgendaUpdated } from './agenda-updated.tsx';

export interface AgendaDetailProps {
  readonly item: AgendaItem;
  /** Beside the card (wide screens), or the phone's one full scrollable view. */
  readonly layout: 'panel' | 'full';
  /** How prose is drawn — the conversation renders references; elsewhere, Markdown. */
  readonly renderProse?: (text: string) => ReactNode;
  /** Ticks or unticks one step on the machine. Absent: the steps are read-only. */
  readonly onProgress?: (step: number, done: boolean) => Promise<void>;
  readonly busy?: boolean;
  /**
   * The full view draws the item's questions and its recommendation in the same ordered sections; what it needs
   * from the host is only what the host owns: the picks, the ask when it is longer than the heading's preview.
   */
  readonly brief?: Pick<AgendaBriefProps, 'ask' | 'askLabel' | 'askShown' | 'picker' | 'recommendation'>;
}

const markdownProse = (text: string): ReactNode => <ChatProse text={text} />;

/** Whether the item has anything to read beyond its question and options. */
export const agendaHasDetail = (item: AgendaItem): boolean =>
  [item.premise, item.context, item.decided, item.body].some(text => (text ?? '').trim() !== '') ||
  (item.terms?.length ?? 0) > 0 ||
  (item.steps?.length ?? 0) > 0 ||
  (item.links?.length ?? 0) > 0;

export function AgendaDetail({
  item,
  layout,
  renderProse = markdownProse,
  onProgress,
  busy = false,
  brief,
}: AgendaDetailProps) {
  const body = item.body?.trim() ? item.body : null;
  const highlight = revisionHighlight(item);
  return (
    <section aria-label="Details" className="fy-attn-detail" data-agenda-detail={item.id} data-layout={layout}>
      {item.revisions === undefined || layout === 'full' ? null : (
        <div className="fy-attn-detail__updated">
          <AgendaUpdated item={item} />
        </div>
      )}
      <AgendaBriefSections
        collapsible={false}
        highlight={highlight}
        detail={body === null ? undefined : <AgendaBody folded={false} renderProse={renderProse} text={body} />}
        item={item}
        part={layout === 'full' ? 'all' : 'detail'}
        {...brief}
        renderProse={renderProse}
        steps={
          item.steps === undefined ? undefined : (
            <AgendaSteps
              disabled={busy}
              done={item.stepsDone ?? []}
              renderProse={renderProse}
              steps={item.steps}
              {...(onProgress === undefined ? {} : { onProgress })}
            />
          )
        }
      />
    </section>
  );
}
