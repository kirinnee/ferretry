import { describe, expect, it } from 'bun:test';
import { AgendaCard } from '../../../src/features/agenda/agenda-card.tsx';
import type { InboxAction } from '../../../src/lib/agenda-answers.ts';
import { cardModel } from '../../../src/lib/agenda-card-model.ts';
import { agendaItem, choices } from '../../support/agenda-inbox.tsx';
import { interact, mount, must } from '../../support/dom.ts';

const notice = agendaItem('N1', {
  notice: true,
  subject: 'The deploy finished.',
  title: 'Deploy finished',
  body: 'All 4 services are up.',
});

describe('a plain notification on the card', () => {
  it('has no options, no arrows and no turn text — a summary, its body and "Clear"', async () => {
    const acts: InboxAction[] = [];
    const view = await mount(<AgendaCard item={notice} onAct={a => acts.push(a)} />);
    expect(view.container.querySelector('[data-agenda-answer]')).toBeNull();
    expect(view.container.querySelector('[data-agenda-waiting]')).toBeNull();
    expect(view.container.querySelector('[data-agenda-dismiss]')).toBeNull();
    expect(must(view.container.querySelector('[data-agenda-kind]'), 'kind').textContent).toBe('Notification');
    expect(must(view.container.querySelector('[data-agenda-body]'), 'body').textContent).toContain('4 services');
    await interact(() => must(view.container.querySelector<HTMLButtonElement>('[data-agenda-clear]'), 'clear').click());
    expect(acts).toEqual([{ kind: 'resolve', label: 'Clear' }]);
    await view.unmount();
  });

  it('never says "Attention" to the reader', async () => {
    const view = await mount(<AgendaCard item={notice} onAct={() => undefined} />);
    expect(view.container.textContent ?? '').not.toMatch(/attention/iu);
    await view.unmount();
  });
});

describe('cardModel', () => {
  it('gives a notice nothing to answer', () => {
    const model = cardModel(notice);
    expect(model).toMatchObject({ notice: true, answers: [], extras: [], perQuestion: false, textOnly: false });
    expect(model.recommended).toBeUndefined();
  });

  it('heads a short question with the question, and a long one with the title', () => {
    const short = cardModel(agendaItem('A1', { subject: 'Which database?', title: 'DB', ask: choices('A', 'B') }));
    expect(short.heading).toBe('Which database?');
    const long = cardModel(agendaItem('A1', { subject: 'x'.repeat(200), title: 'DB', ask: choices('A', 'B') }));
    expect(long.heading).toBe('DB');
    expect(long.showAsk).toBe(true);
  });

  it('says the recommendation on its own line when it is not one of the buttons', () => {
    const model = cardModel(
      agendaItem('A1', { ask: choices('A', 'B'), recommendation: { decision: 'C', why: 'cheaper' } }),
    );
    expect(model.recommendationLine).toBe('Recommended: C — cheaper');
  });
});
