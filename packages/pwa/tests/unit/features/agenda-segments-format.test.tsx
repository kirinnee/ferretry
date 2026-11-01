import { afterEach, describe, expect, test } from 'bun:test';
import type { AgendaItem } from '@ferretry/protocol';
import { AgendaItemCard } from '../../../src/features/agenda/agenda-item-card.tsx';
import { agendaProse } from '../../../src/features/agenda/agenda-prose.tsx';
import { agendaItem } from '../../support/agenda-inbox.tsx';
import { type Mounted, mount, must } from '../../support/dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const WALL =
  'Yes, by design: one plan (one design doc), one data model (accounts → sign-ins → 2FA keys), one shared matcher that decides does this request match an approved sign-in for both task plans and standing rules, one passkey path for every approval, and one owner-only wall.';

const item = (extra: Partial<AgendaItem> = {}): AgendaItem =>
  agendaItem('A1', {
    subject: 'Ship the release?',
    premise: '**The release is ready.**\n- tests pass\n- notes are written',
    context: 'Cut on Friday.\nAfter that the names are frozen.\n• freeze at noon',
    decided: '**Keep CI.**\n1. use Actions\n2. keep `ci`',
    stillOpen: 'Who signs off?\nWhen?',
    questionAnswer: '**Yes, by design.**\n- one plan\n- one data model\n- one passkey path',
    body: '**Steps in short**\n- open the page\n- press the button',
    terms: [{ term: 'CI', meaning: '**continuous** integration\n- builds\n- tests' }],
    ask: {
      kind: 'multiple-choice',
      options: [
        { label: 'Ship', description: 'Goes out today' },
        { label: 'Wait', description: 'Hold until Monday' },
      ],
    },
    optionDetails: [{ label: 'Ship', detail: '**Fast.**\n- out today\n- needs sign-off' }],
    ...extra,
  } as never);

const draw = async (extra: Partial<AgendaItem> = {}): Promise<HTMLElement> => {
  view = await mount(
    <AgendaItemCard
      busy={false}
      error={null}
      ferret="kai"
      item={item(extra)}
      now={Date.parse('2026-08-01T12:00:00.000Z')}
      onAct={() => undefined}
      renderProse={agendaProse()}
      swipeable={false}
    />,
  );
  return view.container;
};

const segment = (root: HTMLElement, selector: string): HTMLElement =>
  must(root.querySelector<HTMLElement>(selector), selector);

describe('every agenda segment draws the same inline Markdown, lists and line breaks', () => {
  test('the answer to a question is a bold lead over a bullet list, not a paragraph', async () => {
    const answer = segment(await draw(), '[data-agenda-question-answer]');
    expect(answer.querySelector('strong')?.textContent).toBe('Yes, by design.');
    expect([...answer.querySelectorAll('li')].map(li => li.textContent)).toEqual([
      'one plan',
      'one data model',
      'one passkey path',
    ]);
  });

  test('the premise keeps its bold lead and its bullets', async () => {
    const premise = segment(await draw(), '[data-agenda-section="premise"]');
    expect(premise.querySelector('strong')?.textContent).toBe('The release is ready.');
    expect(premise.querySelectorAll('li')).toHaveLength(2);
  });

  test('the context keeps its line breaks and reads • as a bullet', async () => {
    const context = segment(await draw(), '[data-agenda-section="context"]');
    expect(context.querySelectorAll('br').length).toBeGreaterThanOrEqual(1);
    expect(context.textContent).not.toContain('•');
    expect([...context.querySelectorAll('li')].map(li => li.textContent)).toEqual(['freeze at noon']);
  });

  test('decided so far draws a numbered list with `code`', async () => {
    const decided = segment(await draw(), '[data-agenda-section="decided"]');
    expect([...decided.querySelectorAll('ol > li')].map(li => li.textContent)).toEqual(['use Actions', 'keep ci']);
    expect(decided.querySelector('code')?.textContent).toBe('ci');
  });

  test('still open keeps its two lines as two lines', async () => {
    const open = segment(await draw(), '[data-agenda-section="still-open"]');
    expect(open.querySelectorAll('br')).toHaveLength(1);
  });

  test('the body and a term keep their lists', async () => {
    const root = await draw();
    expect(segment(root, '[data-agenda-section="more"]').querySelectorAll('li')).toHaveLength(2);
    expect(segment(root, '[data-agenda-terms] dd').querySelectorAll('li')).toHaveLength(2);
  });

  test('an option detail with a list draws its bullets; a plain one reads on after its name', async () => {
    const root = await draw();
    const ship = segment(root, '[data-agenda-option-detail="Ship"] .fy-card__option-meaning');
    const wait = segment(root, '[data-agenda-option-detail="Wait"] .fy-card__option-meaning');
    expect([...ship.querySelectorAll('li')].map(li => li.textContent)).toEqual(['out today', 'needs sign-off']);
    expect(wait.querySelector('ul, ol')).toBeNull();
    expect(wait.textContent).toContain('Hold until Monday');
  });

  test('every segment is drawn by the one renderer: each carries the shared segment class', async () => {
    const root = await draw();
    for (const selector of [
      '[data-agenda-question-answer]',
      '[data-agenda-section="premise"]',
      '[data-agenda-section="context"]',
      '[data-agenda-section="decided"]',
      '[data-agenda-section="still-open"]',
      '[data-agenda-section="more"]',
      '[data-agenda-terms] dd',
    ]) {
      expect(segment(root, selector).querySelector('.fy-seg'), selector).not.toBeNull();
    }
  });

  test('a long single paragraph is still drawn whole (the writing lint is what warns about it)', async () => {
    const answer = segment(await draw({ questionAnswer: WALL }), '[data-agenda-question-answer]');
    expect(answer.textContent).toContain('one owner-only wall.');
  });
});
