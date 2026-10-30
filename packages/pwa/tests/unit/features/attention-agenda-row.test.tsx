import { describe, expect, it } from 'bun:test';
import { AttentionAgendaRow, agendaAsk } from '../../../src/features/attention/attention-agenda-row.tsx';
import { attentionItem, choices } from '../../support/attention-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';

const NOW = Date.parse('2026-10-29T10:00:00.000Z');

const pick = <T extends HTMLElement>(view: Mounted, selector: string, what: string): T =>
  must(view.container.querySelector<T>(selector), what);

const row = (extra: Record<string, unknown> = {}, onOpen: () => void = () => undefined) =>
  mount(
    <AttentionAgendaRow
      ferret="Johnnie"
      item={attentionItem('A5', {
        subject: 'Which database?',
        title: 'Pick the database',
        ask: choices('SQLite', 'Postgres', 'Neither'),
        ...extra,
      })}
      now={NOW}
      onOpen={onOpen}
    />,
  );

describe('the agenda row', () => {
  it('is ONE button: a bold title, the ask under it, and no chips, no reply and no pill for a plain needs-you', async () => {
    const view = await row();
    const buttons = view.container.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.hasAttribute('data-attention-agenda-row')).toBe(true);
    expect(pick(view, '[data-attention-row-title]', 'title').textContent).toBe('Pick the database');
    expect(pick(view, '[data-attention-row-ask]', 'ask').textContent).toBe('Which database?');
    expect(view.container.querySelector('[data-attention-chip], [data-attention-add-reply]')).toBeNull();
    expect(view.container.querySelector('[data-agenda-status]')).toBeNull();
    await view.unmount();
  });

  it('opens the card when pressed', async () => {
    const calls: string[] = [];
    const view = await row({}, () => calls.push('open'));
    await interact(() => pick<HTMLButtonElement>(view, '[data-attention-agenda-row]', 'row').click());
    expect(calls).toEqual(['open']);
    await view.unmount();
  });

  it('dims a ferret’s-turn row and says who it is with', async () => {
    const view = await row({ waitingOn: 'ferret' });
    expect(pick(view, '[data-attention-agenda-row]', 'row').hasAttribute('data-agenda-dimmed')).toBe(true);
    expect(pick(view, '[data-agenda-status]', 'pill').textContent).toBe('With Johnnie');
    await view.unmount();
  });

  it('carries what it blocks in the pill and the row’s tone', async () => {
    const view = await row({ blockingNow: true });
    expect(pick(view, '[data-agenda-status]', 'pill').textContent).toBe('Blocking now');
    expect(pick(view, '[data-attention-agenda-row]', 'row').getAttribute('data-tone')).toBe('blocking');
    await view.unmount();
  });

  it('draws a notification with no pill', async () => {
    const view = await row({ notice: true, ask: undefined });
    expect(view.container.querySelector('[data-agenda-status]')).toBeNull();
    expect(pick(view, '[data-attention-agenda-row]', 'row').hasAttribute('data-notice')).toBe(true);
    await view.unmount();
  });

  it('draws no ask line when the item has nothing to say under its title', async () => {
    const view = await row({ subject: '', title: undefined, premise: undefined, context: undefined });
    expect(view.container.querySelector('[data-attention-row-ask]')).toBeNull();
    await view.unmount();
  });
});

describe('what a row says under the title', () => {
  const item = (extra: Record<string, unknown>) => attentionItem('A1', extra);

  it('is the subject when the title is its own', () => {
    expect(agendaAsk(item({ title: 'Pick one', subject: 'Which database?' }))).toBe('Which database?');
  });

  it('is the first premise point when the title IS the subject', () => {
    expect(agendaAsk(item({ subject: 'Which database?', premise: '- Writes are slow\n- Reads are fine' }))).toBe(
      'Writes are slow',
    );
  });

  it('is the first paragraph of a premise written as prose', () => {
    expect(agendaAsk(item({ subject: 'Which?', premise: 'Writes are slow.\n\nReads are fine.' }))).toBe(
      'Writes are slow.',
    );
  });

  it('falls back to the context, and to nothing', () => {
    expect(agendaAsk(item({ subject: 'Which?', context: '- We have SQLite today' }))).toBe('We have SQLite today');
    expect(agendaAsk(item({ subject: 'Which?' }))).toBeNull();
    expect(agendaAsk(item({ subject: 'Which?', premise: '   ' }))).toBeNull();
  });
});
