import { afterEach, describe, expect, it } from 'bun:test';
import type { AgendaRef, ResolvedAgendaItem } from '@ferretry/protocol';
import { AsksList } from '../../../src/features/board/detail/board-detail-sections.tsx';
import type { CardAsks, OpenAskRow } from '../../../src/lib/board-detail.ts';
import { agendaItem, choices } from '../../support/agenda-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
import { LEAD, names } from './board-detail-support.tsx';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const row = (id: string, blocking: boolean, item: OpenAskRow['item'] = agendaItem(id, { title: `Ask ${id}` })) => ({
  ref: { sessionId: LEAD, id } as AgendaRef,
  item,
  blocking,
});
const resolved = (id: string): ResolvedAgendaItem =>
  ({
    ...agendaItem(id, { title: `Ask ${id}` }),
    resolvedAt: '2026-07-31T12:00:00.000Z',
    resolvedBy: 'human',
    resolvedBySession: null,
    resolvedByName: null,
    resolutionNote: null,
    disposition: 'done',
  }) as unknown as ResolvedAgendaItem;

const show = async (asks: CardAsks) => {
  const opened: string[] = [];
  view = await mount(
    <AsksList asks={asks} names={names} onOpen={(sessionId, id) => opened.push(`${sessionId}/${id}`)} />,
  );
  return { root: view.container, opened };
};

describe('the card’s Agenda asks (#B76: a list is only a list)', () => {
  it('lists blocking first, then open, then answered — and answers nothing inline', async () => {
    const { root } = await show({
      open: [row('A2', false, agendaItem('A2', { title: 'Ask A2', ask: choices('Yes', 'No') })), row('A1', true)],
      resolved: [{ sessionId: LEAD, item: resolved('A9') }],
      reading: false,
    });
    expect([...root.querySelectorAll('[data-ask-open]')].map(button => button.getAttribute('data-ask-open'))).toEqual([
      'A1',
      'A2',
      'A9',
    ]);
    expect(root.querySelector('[data-agenda-quick-replies]')).toBeNull();
    expect(root.textContent).toContain('Blocking · Ask A1');
    expect(root.textContent).toContain('Answered · Ask A9');
  });

  it('opens an open ask and an answered one by the ferret whose agenda holds it', async () => {
    const { root, opened } = await show({
      open: [row('A1', true)],
      resolved: [{ sessionId: 'other-ferret', item: resolved('A9') }],
      reading: false,
    });
    await interact(() => must(root.querySelector<HTMLButtonElement>('[data-ask-open="A1"]'), 'A1').click());
    await interact(() => must(root.querySelector<HTMLButtonElement>('[data-ask-open="A9"]'), 'A9').click());
    expect(opened).toEqual([`${LEAD}/A1`, 'other-ferret/A9']);
  });

  it('an ask whose item is not read yet still opens by its ref', async () => {
    const { root, opened } = await show({ open: [row('A3', true, null)], resolved: [], reading: true });
    await interact(() => must(root.querySelector<HTMLButtonElement>('[data-ask-open="A3"]'), 'A3').click());
    expect(opened).toEqual([`${LEAD}/A3`]);
  });
});
