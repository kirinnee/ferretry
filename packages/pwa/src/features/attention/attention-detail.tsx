/**
 * WHAT AN ATTENTION ITEM KNOWS BEYOND ITS QUESTION — what's going on, why it matters, what is already
 * decided, terms (a table), steps, the body with its diagrams and mock-ups, and links. The card itself is
 * minimal (question, options, Skip); this is where the rest is read: beside the card on a wide screen
 * (`layout: 'panel'`, a narrow side column), or as part of ONE full scrollable view on a phone
 * (`layout: 'full'`).
 *
 * IT NEVER SCROLLS BY ITSELF. The column or the page around it scrolls, so there is never a scroll bar
 * inside another; only an fy-render mock-up that is bigger than the width scrolls, inside its own box.
 */

import type { AttentionItem } from '@ferretry/protocol';
import type { ReactNode } from 'react';
import { ChatProse } from '../../components/chat-prose.tsx';
import { revisionHighlight } from '../../lib/attention-revisions.ts';
import { AttentionBriefSections } from './attention-brief.tsx';
import { AttentionBody, AttentionSteps } from './attention-steps.tsx';
import { AttentionUpdated } from './attention-updated.tsx';

export interface AttentionDetailProps {
  readonly item: AttentionItem;
  /** Beside the card (wide screens), or the phone's one full scrollable view. */
  readonly layout: 'panel' | 'full';
  /** How prose is drawn — the conversation renders references; elsewhere, Markdown. */
  readonly renderProse?: (text: string) => ReactNode;
  /** Ticks or unticks one step on the machine. Absent: the steps are read-only. */
  readonly onProgress?: (step: number, done: boolean) => Promise<void>;
  readonly busy?: boolean;
}

const markdownProse = (text: string): ReactNode => <ChatProse text={text} />;

/** Whether the item has anything to read beyond its question and options. */
export const attentionHasDetail = (item: AttentionItem): boolean =>
  [item.premise, item.context, item.decided, item.body].some(text => (text ?? '').trim() !== '') ||
  (item.terms?.length ?? 0) > 0 ||
  (item.steps?.length ?? 0) > 0 ||
  (item.links?.length ?? 0) > 0;

export function AttentionDetail({
  item,
  layout,
  renderProse = markdownProse,
  onProgress,
  busy = false,
}: AttentionDetailProps) {
  const body = item.body?.trim() ? item.body : null;
  const highlight = revisionHighlight(item);
  return (
    <section aria-label="Details" className="fy-attn-detail" data-attention-detail={item.id} data-layout={layout}>
      {item.revisions === undefined || layout === 'full' ? null : (
        <div className="fy-attn-detail__updated">
          <AttentionUpdated item={item} />
        </div>
      )}
      <AttentionBriefSections
        collapsible={false}
        highlight={highlight}
        detail={body === null ? undefined : <AttentionBody renderProse={renderProse} text={body} />}
        item={item}
        part="detail"
        renderProse={renderProse}
        steps={
          item.steps === undefined ? undefined : (
            <AttentionSteps
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
