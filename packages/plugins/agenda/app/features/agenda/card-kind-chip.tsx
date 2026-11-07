import { CheckSquare, MessageCircleQuestion } from 'lucide-react';
import type { ReactElement } from 'react';
import type { CardKind } from '../../lib/card-kind.ts';

/**
 * The chip that says what a card IS before a thumb moves it: a TASK (the check box) or an AGENDA item (the speech
 * bubble). One chip, drawn the same on the Inbox card, Answer quickly and the side panel.
 */
export function CardKindChip({ kind }: { readonly kind: CardKind }): ReactElement {
  const Icon = kind.family === 'task' ? CheckSquare : MessageCircleQuestion;
  return (
    <span className="fy-kind-chip" data-card-kind={kind.family}>
      <Icon aria-hidden="true" size={12} />
      {kind.word}
    </span>
  );
}
