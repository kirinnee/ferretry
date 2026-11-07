/**
 * WHAT AN ITEM IS AT, AND SINCE WHEN IT NEEDS THE OWNER (docs/agenda.md § Stage, the tabs, and the detail): read
 * from the fields an item carries, so an item from before stages reads too. Pure and total.
 */
import type { AgendaAsk, AgendaKind } from './agenda.ts';
import { agendaCardKind } from './agenda-card.ts';
import type { AgendaStage } from './agenda-state.ts';

/**
 * The stage an item's KIND says it is at, for an item that names none (one raised before stages, or with no
 * `--stage`): something to read is an explainer, a permission or a review is a plan to approve, a to-do is a test,
 * and everything else asks a question.
 */
export const agendaStageOfKind = (kind: AgendaKind): AgendaStage => {
  switch (kind) {
    case 'info':
      return 'explainer';
    case 'permission':
    case 'review':
      return 'plan';
    case 'task':
      return 'test';
    case 'yesno':
    case 'choice':
    case 'reply':
    case 'form':
    case 'input':
      return 'question';
  }
};

/** An item's stage: the one it carries, `done` once it is closed, else the one its kind says. */
export const agendaStage = (item: {
  readonly stage?: AgendaStage | undefined;
  readonly resolvedAt?: string | undefined;
  readonly kind?: AgendaKind | undefined;
  readonly ask?: AgendaAsk | undefined;
}): AgendaStage => {
  if (item.resolvedAt !== undefined) return 'done';
  return item.stage ?? agendaStageOfKind(agendaCardKind(item));
};

/**
 * When an item last STARTED needing the owner: its `waitingSince`. A raise, a wake and a genuinely new ask set it;
 * a reply that rests the item and the ferret's answer that brings it back leave it alone, which is how an item
 * returns to its OLD place in the queue. One field, one fact: the queue reads no second clock.
 */
export const agendaNeedsYouSince = (item: { readonly waitingSince: string }): string => item.waitingSince;
