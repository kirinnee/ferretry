import { afterEach, describe, expect, test } from 'bun:test';
import type { AgendaItem } from '@ferretry/protocol';
import { ChatProse } from '../../../src/components/chat-prose.tsx';
import { AgendaBriefSections, PointForm } from '../../../src/features/agenda/agenda-brief.tsx';
import { AgendaQuickReplies } from '../../../src/features/agenda/agenda-quick-replies.tsx';
import { cardModel } from '../../../src/lib/agenda-card-model.ts';
import { itemOptions } from '../../../src/lib/agenda-options.ts';
import { swipeMap } from '../../../src/lib/agenda-inbox.ts';
import { agendaItem, choices } from '../../support/agenda-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const root = (): HTMLElement => must(view?.container, 'the view');

const markdown = (text: string) => <ChatProse text={text} />;

const jaeda = agendaItem('A57', {
  title: 'Which fix for the login race?',
  subject: 'Which fix should land for the login race?',
  ask: choices('Lock the session row', 'Retry with backoff', 'Do nothing at all'),
  recommendation: { decision: 'Lock the session row', why: 'It fixes the **cause**, not the symptom.' },
  optionDetails: [
    {
      label: 'Lock the session row',
      detail: 'Take a `SELECT … FOR UPDATE` lock. See [the design](https://example.test/d).',
    },
    { label: 'Retry with backoff', detail: 'Cheap, but **hides** the race.' },
  ],
} as Partial<AgendaItem>);

describe('the lettered Options section', () => {
  test('lists each option as "A — label" with its Markdown detail and marks the recommended one with its reason', async () => {
    // Arrange / Act
    view = await mount(
      <AgendaBriefSections
        collapsible={false}
        item={jaeda}
        recommendation={jaeda.recommendation}
        renderProse={text => text}
      />,
    );
    // Assert
    const section = must(root().querySelector('[data-agenda-section="options"]'), 'the options section');
    const rows = [...section.querySelectorAll('[data-agenda-option-detail]')];
    expect(rows.map(row => row.querySelector('strong')?.textContent)).toEqual([
      'A — Lock the session row',
      'B — Retry with backoff',
      'C — Do nothing at all',
    ]);
    expect(rows[0]?.querySelector('[data-agenda-recommended]')).not.toBeNull();
    expect(rows[1]?.querySelector('[data-agenda-recommended]')).toBeNull();
    expect(rows[2]?.querySelector('.fy-attn-options__what')).toBeNull();
    expect(section.querySelector('[data-agenda-recommendation]')?.textContent).toBe(
      '**Why A:** It fixes the **cause**, not the symptom.',
    );
  });

  test('draws Markdown with the chat’s renderer: code, bold and a link', async () => {
    view = await mount(<AgendaBriefSections collapsible={false} item={jaeda} part="detail" renderProse={markdown} />);
    const first = must(root().querySelector('[data-agenda-option-detail="Lock the session row"]'), 'option A');
    expect(first.querySelector('code')?.textContent).toBe('SELECT … FOR UPDATE');
    expect(first.querySelector('a')?.getAttribute('href')).toBe('https://example.test/d');
    expect(
      root().querySelector('[data-agenda-option-detail="Retry with backoff"] .fy-attn-options__what strong')
        ?.textContent,
    ).toBe('hides');
  });

  test('is left out when the options are plain words with nothing to add', async () => {
    const plain = agendaItem('A58', { ask: choices('Yes', 'No') } as Partial<AgendaItem>);
    view = await mount(
      <AgendaBriefSections collapsible={false} item={plain} part="detail" renderProse={text => text} />,
    );
    expect(root().querySelector('[data-agenda-section="options"]')).toBeNull();
  });
});

describe('Markdown in the card’s fields', () => {
  test('a paragraph and every bullet are drawn by the chat’s renderer', async () => {
    view = await mount(
      <>
        <PointForm text="Run `fy agenda ls` — **now** [docs](https://example.test/x)" />
        <PointForm text={'- the `token` name\n- a *second* point'} />
      </>,
    );
    expect(root().querySelector('code')?.textContent).toBe('fy agenda ls');
    expect(root().querySelector('strong')?.textContent).toBe('now');
    expect(root().querySelector('a')?.getAttribute('href')).toBe('https://example.test/x');
    expect([...root().querySelectorAll('li')].map(li => li.textContent)).toEqual(['the token name', 'a second point']);
    expect(root().querySelectorAll('li code')).toHaveLength(1);
  });

  test('premise, terms and the ask go through it too', async () => {
    const rich = agendaItem('A59', {
      ask: { kind: 'permission' },
      subject: 'May I run `bun test`?',
      premise: 'The **build** is red.',
      terms: [{ term: 'CI', meaning: 'the `main` pipeline' }],
    } as Partial<AgendaItem>);
    view = await mount(
      <AgendaBriefSections ask="May I run `bun test`?" collapsible={false} item={rich} renderProse={markdown} />,
    );
    expect(must(root().querySelector('[data-agenda-ask] code'), 'the ask code').textContent).toBe('bun test');
    expect(root().querySelector('[data-agenda-section="premise"] strong')?.textContent).toBe('build');
    expect(root().querySelector('[data-agenda-terms] td code')?.textContent).toBe('main');
  });
});

describe('the quick replies, lettered', () => {
  const draw = async (item: AgendaItem): Promise<void> => {
    view = await mount(
      <AgendaQuickReplies
        busy={false}
        error={null}
        map={swipeMap(item)}
        model={cardModel(item)}
        onAct={() => {}}
        onClose={() => {}}
        options={itemOptions(item)}
        swipeable
      />,
    );
  };
  const buttons = (): HTMLButtonElement[] => [...root().querySelectorAll<HTMLButtonElement>('[data-agenda-option]')];

  test('one row of letters in order, each named by its full label, the recommended one marked', async () => {
    await draw(jaeda);
    expect(root().querySelectorAll('fieldset')).toHaveLength(1);
    expect(buttons().map(button => button.textContent)).toEqual(['A', 'B', 'C']);
    expect(buttons().map(button => button.dataset.agendaOption)).toEqual([
      'Lock the session row',
      'Retry with backoff',
      'Do nothing at all',
    ]);
    expect(buttons().map(button => button.title)).toEqual([
      'Lock the session row',
      'Retry with backoff',
      'Do nothing at all',
    ]);
    expect(buttons()[0]?.getAttribute('aria-label')).toBe('Lock the session row, recommended, or swipe right');
    expect(buttons()[0]?.hasAttribute('data-recommended')).toBe(true);
    expect(buttons()[1]?.hasAttribute('data-recommended')).toBe(false);
  });

  test('a label of one or two words is its own button text, even beside a letter', async () => {
    await draw(agendaItem('A60', { ask: choices('Looks good', 'Needs a different approach') } as Partial<AgendaItem>));
    expect(buttons().map(button => button.textContent)).toEqual(['Looks good', 'B']);
  });

  test('an old choice past the third option keeps its letter on the plain button, in order', async () => {
    const many = agendaItem('A61', {
      ask: choices('Now and here', 'Later on today', 'Never ever again', 'Maybe some day'),
    });
    await draw(many);
    expect(buttons().map(button => button.textContent)).toEqual(['A', 'B', 'C', 'D']);
    await interact(() => buttons()[3]?.click());
  });

  test('answers that are not options of the ask stay in swipe order, whole labels', async () => {
    await draw(agendaItem('A62', { ask: { kind: 'permission' } } as Partial<AgendaItem>));
    expect(buttons().length).toBeGreaterThan(0);
    expect(buttons().every(button => button.textContent === button.dataset.agendaOption)).toBe(true);
  });
});
