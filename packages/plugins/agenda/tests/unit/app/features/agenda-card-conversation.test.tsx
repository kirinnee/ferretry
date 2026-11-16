/**
 * A REPLY TYPED UNDER AN ASK MARKS THE INBOX REPLIED (triage B17). The ask page draws the ferret's conversation through
 * the `agenda.conversation` slot; Agenda hands the slot a receipt callback, so a message about the card that the
 * conversation accepted parks the item at once, and the words of a reply taken back with Undo are offered to the box once.
 */

import { describe, expect, it } from 'bun:test';
import { PanelSlot } from '@ferretry/app';
import { ensureDom, render, run } from '@ferretry/app/testing';
import { AgendaCardConversation } from '../../../../app/features/agenda/agenda-conversation-slot.tsx';
import { withRepliedCards } from '../../../../app/lib/agenda-replied.ts';
import { agendaItem, choices, fakeInbox, inboxCard } from '../../../support/app/agenda-inbox.tsx';

ensureDom();

const card = inboxCard(agendaItem('A2', { ask: choices('Ship', 'Hold'), waitingSince: '2026-08-01T10:00:00.000Z' }));

const draw = (fake = fakeInbox(), answerForm?: () => void) => {
  const page = render(
    <AgendaCardConversation
      {...(answerForm === undefined ? {} : { answerForm })}
      card={card}
      inbox={{ replied: fake.replied, repliedState: fake.replied.getSnapshot() }}
    />,
  );
  const props = () => page.root.findByType(PanelSlot).props.props as Record<string, unknown>;
  return { fake, page, props };
};

describe('the conversation under an Inbox card', () => {
  it('names the ferret and the ask, and tells the Inbox when a message about it was accepted', () => {
    const { fake, props } = draw();
    expect(props()['ferret']).toBe(card.view.config.id);
    expect(props()['ask']).toBe('A2');
    expect(withRepliedCards([card], fake.replied.getSnapshot())).toEqual([card]);

    run(() => (props()['onReplied'] as (sent: unknown) => void)({ words: 'hi', sendId: 'm1', disposition: 'queued' }));

    expect(withRepliedCards([card], fake.replied.getSnapshot())).toEqual([]);
    expect(fake.replied.getSnapshot().entries.map(entry => [entry.key, entry.words, entry.sendId])).toEqual([
      [card.key, 'hi', 'm1'],
    ]);
  });

  it('hands a form card’s Send to the conversation, so its box answers the form whatever the chat is doing', () => {
    let answered = 0;
    const { props } = draw(fakeInbox(), () => (answered += 1));
    run(() => (props()['answerForm'] as () => void)());
    expect(answered).toBe(1);
    expect(typeof props()['formChanges']).toBe('number');
  });

  it('hands no form Send for a card that is not a form: its box replies to the ask', () => {
    const { props } = draw();
    expect(props()).not.toHaveProperty('answerForm');
    expect(props()).not.toHaveProperty('formChanges');
  });
});
