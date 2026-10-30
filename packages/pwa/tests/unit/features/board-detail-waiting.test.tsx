import { afterEach, describe, expect, it } from 'bun:test';
import type { AgendaRef, AgendaResponse } from '@ferretry/protocol';
import { WaitingOnYou } from '../../../src/features/board/detail/board-detail-waiting.tsx';
import type { CardAsks, OpenAskRow } from '../../../src/lib/board-detail.ts';
import { agendaItem, choices } from '../../support/agenda-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
import { deferred, flush } from '../board-support.ts';
import { buttonNamed, LEAD, names } from './board-detail-support.tsx';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const REF: AgendaRef = { sessionId: LEAD, id: 'A1' };
const row = (item: OpenAskRow['item'], blocking = true, ref: AgendaRef = REF): OpenAskRow => ({ ref, item, blocking });
const asks = (open: readonly OpenAskRow[], reading = false): CardAsks => ({ open, resolved: [], reading });

const tap = async (button: HTMLButtonElement): Promise<void> => {
  const fire = (type: string) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerId: 1, clientX: 0, clientY: 0, button: 0 });
    button.dispatchEvent(event);
  };
  await interact(() => fire('pointerdown'));
  await interact(() => fire('pointerup'));
  await interact(() => button.click());
};

const show = async (
  state: CardAsks,
  onAnswer: (ref: AgendaRef, response: AgendaResponse) => Promise<string | null> = async () => null,
): Promise<HTMLElement> => {
  view = await mount(<WaitingOnYou asks={state} names={names} onAnswer={onAnswer} />);
  return view.container;
};

describe('WaitingOnYou', () => {
  it('draws only the asks that block the ferret, with their heading and why', async () => {
    const root = await show(
      asks([
        row(agendaItem('A1', { title: 'Approve the plan?', why: 'It changes the schema.', ask: choices('Yes', 'No') })),
        row(agendaItem('A2', { title: 'A side question' }), false, { sessionId: LEAD, id: 'A2' }),
      ]),
    );
    expect([...root.querySelectorAll('li[data-ask]')].map(item => item.getAttribute('data-ask'))).toEqual(['A1']);
    expect(root.querySelector('.fy-board-detail__asktitle')?.textContent).toBe('Approve the plan?');
    expect(root.textContent).toContain('It changes the schema.');
  });

  it('answers through the agenda path with the label that was tapped', async () => {
    const answered: { ref: AgendaRef; response: AgendaResponse }[] = [];
    const root = await show(
      asks([row(agendaItem('A1', { title: 'Approve?', ask: choices('Deploy Friday', 'Wait for Monday') }))]),
      async (ref, response) => {
        answered.push({ ref, response });
        return null;
      },
    );
    await tap(buttonNamed(root, 'Wait for Monday'));
    await interact(() => flush());
    expect(answered).toEqual([{ ref: REF, response: { kind: 'multiple-choice', choice: 'Wait for Monday' } }]);
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows the words of a refusal in place, and clears them on the next answer that goes through', async () => {
    let refuse: string | null = 'the ferret is not listening';
    const root = await show(
      asks([row(agendaItem('A1', { title: 'Approve?', ask: choices('Yes', 'No') }))]),
      async () => refuse,
    );
    await tap(buttonNamed(root, 'Yes'));
    await interact(() => flush());
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('the ferret is not listening');
    refuse = null;
    await tap(buttonNamed(root, 'No'));
    await interact(() => flush());
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });

  it('holds the controls busy while an answer is on its way', async () => {
    const pending = deferred<string | null>();
    const root = await show(
      asks([row(agendaItem('A1', { title: 'Approve?', ask: choices('Yes', 'No') }))]),
      () => pending.promise,
    );
    await tap(buttonNamed(root, 'Yes'));
    expect(buttonNamed(root, 'Yes').disabled).toBe(true);
    pending.resolve(null);
    await interact(() => flush());
    expect(buttonNamed(root, 'Yes').disabled).toBe(false);
  });

  it('sends an ask with no answer controls to the Inbox', async () => {
    const root = await show(asks([row(agendaItem('A1', { title: 'Look at this' }))]));
    expect(root.textContent).toContain('Answer this one in the Inbox.');
    expect(root.querySelector('button')).toBeNull();
  });

  it('says its ask is not listed any more when the ferret no longer lists it', async () => {
    const root = await show(asks([row(null)]));
    expect(root.textContent).toBe('Denisha is waiting, but its ask is not listed any more.');
  });

  it('says it is reading while the ferret agenda has not answered', async () => {
    const root = await show(asks([row(null)], true));
    expect(root.textContent).toBe('Reading the ask…');
  });

  it('leaves the why off an ask that gives none', async () => {
    const root = await show(asks([row(agendaItem('A1', { title: 'Approve?', why: '', ask: choices('Yes') }))]));
    expect(root.querySelector('.fy-board-detail__quiet')).toBeNull();
    expect(must(root.querySelector('.fy-board-detail__asktitle'), 'the title').textContent).toBe('Approve?');
  });
});
