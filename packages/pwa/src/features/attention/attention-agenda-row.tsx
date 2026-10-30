/**
 * ONE ROW OF A FERRET'S AGENDA, in the drawer above the composer (and the docked panel on a wide screen): the
 * item's title, a status pill (whose turn, what it blocks), its quick option chips and "＋ reply", which adds a
 * removable "re: <title>" chip to the composer. Tapping the title opens the item's full card. A ferret's-turn row
 * is dimmed and offers no answers. A plain notification has no pill and no options — its one chip is "Clear".
 *
 * One focal point: the title. The chips and "＋ reply" are quieter, every target at least 44px.
 */

import type { AttentionAskOption, AttentionCardAnswer, AttentionItem } from '@ferretry/protocol';
import { Check, Plus } from 'lucide-react';
import { agendaAuthor, agendaStatus } from '../../lib/agenda-status.ts';
import { answerAction, CLEAR_ACTION, type InboxAction, optionAction } from '../../lib/attention-answers.ts';
import { cardModel } from '../../lib/attention-card-model.ts';
import { AgendaStatusPill } from './agenda-status-pill.tsx';
import { attentionHeading } from './attention-delivery.tsx';

export interface AttentionAgendaRowProps {
  readonly item: AttentionItem;
  /** The ferret's name, for "with Johnnie" on a ferret's-turn row. */
  readonly ferret: string;
  readonly now?: number;
  /** An answer for it is on its way. */
  readonly busy?: boolean;
  /** Already referenced by the composer (its "re:" chip is there). */
  readonly referenced: boolean;
  /** A quick option chip: the host attaches the composer's text (`withComposerNote`) and sends it. */
  readonly onAct: (action: InboxAction) => void;
  /** "＋ reply": add this item's "re:" chip to the composer. */
  readonly onAddReply: () => void;
  /** The title: open the item's full card (the drawer closes). */
  readonly onOpen: () => void;
}

/** The most chips a row carries: more would crowd the title, and the full card has them all. */
const MAX_CHIPS = 3;

const ORDER: Readonly<Record<AttentionCardAnswer['direction'], number>> = { right: 0, up: 1, left: 2 };

interface Chip {
  readonly key: string;
  readonly label: string;
  readonly description: string | undefined;
  readonly recommended: boolean;
  readonly action: InboxAction;
}

const sameLabel = (a: string, b: string | undefined): boolean =>
  b !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase();

const chipsOf = (item: AttentionItem, owner: boolean): readonly Chip[] => {
  const model = cardModel(item);
  if (model.notice)
    return [{ key: 'clear', label: 'Clear', description: undefined, recommended: false, action: CLEAR_ACTION }];
  // An item answered one answer per question, or in words, is answered from its full card or the message box.
  if (!owner || model.perQuestion || model.textOnly) return [];
  const fromAnswers = [...model.answers]
    .sort((a, b) => ORDER[a.direction] - ORDER[b.direction])
    .flatMap(answer => {
      const action = answerAction(answer, '');
      if (action === null) return [];
      return [
        {
          key: answer.direction,
          label: answer.label,
          description: answer.description,
          recommended: sameLabel(answer.label, model.recommended),
          action,
        },
      ];
    });
  const fromExtras = model.extras.map((option: AttentionAskOption) => ({
    key: `option:${option.label}`,
    label: option.label,
    description: option.description,
    recommended: sameLabel(option.label, model.recommended),
    action: optionAction(option, ''),
  }));
  return [...fromAnswers, ...fromExtras].slice(0, MAX_CHIPS);
};

export function AttentionAgendaRow({
  item,
  ferret,
  now = Date.now(),
  busy = false,
  referenced,
  onAct,
  onAddReply,
  onOpen,
}: AttentionAgendaRowProps) {
  const status = agendaStatus(item, agendaAuthor(item, ferret), now);
  const chips = chipsOf(item, status === null || status.turn === 'owner');
  const title = attentionHeading(item);
  return (
    <div
      className="fy-agenda-row"
      data-agenda-dimmed={status?.dimmed || undefined}
      data-attention-agenda-row={item.id}
      data-notice={item.notice === true || undefined}
      data-tone={status?.tone}
    >
      <div className="fy-agenda-row__head">
        <button
          className="fy-agenda-row__title"
          data-attention-row-open=""
          onClick={onOpen}
          title="Open this item"
          type="button"
        >
          {title}
        </button>
        {status === null ? null : <AgendaStatusPill plainNeedsYou={false} status={status} />}
      </div>
      <div className="fy-agenda-row__acts">
        {chips.length === 0 ? null : (
          <fieldset aria-label={`Answers for ${title}`} className="fy-agenda-row__chips">
            {chips.map(chip => (
              <button
                className="fy-agenda-chip"
                data-attention-chip={chip.key}
                data-recommended={chip.recommended || undefined}
                disabled={busy}
                key={chip.key}
                onClick={() => onAct(chip.action)}
                title={chip.description ?? chip.label}
                type="button"
              >
                {chip.recommended ? <Check aria-hidden="true" size={12} /> : null}
                <span className="fy-agenda-chip__label">{chip.label}</span>
                {chip.recommended ? <span className="sr-only">, recommended</span> : null}
              </button>
            ))}
          </fieldset>
        )}
        <button
          aria-pressed={referenced}
          className="fy-agenda-reply"
          data-attention-add-reply=""
          data-referenced={referenced || undefined}
          onClick={onAddReply}
          type="button"
        >
          {referenced ? <Check aria-hidden="true" size={13} /> : <Plus aria-hidden="true" size={13} />}
          {referenced ? 're: added' : 'reply'}
          <span className="sr-only"> {`to ${title}`}</span>
        </button>
      </div>
    </div>
  );
}
