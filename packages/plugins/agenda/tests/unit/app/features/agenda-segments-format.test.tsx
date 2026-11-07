import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgendaItem } from '@ferretry/core-asks/contract';
import { AgendaItemCard } from '../../../../app/features/agenda/agenda-item-card.tsx';
import { agendaProse } from '../../../../app/features/agenda/agenda-prose.tsx';
import { agendaItem } from '../../../support/app/agenda-inbox.tsx';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  // The open tab is remembered per item on this device: each test starts on the main tab.
  window.localStorage.clear();
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
  // The terms and references table is folded: open it, as the owner does, to read its cells.
  const terms = view.container.querySelector<HTMLButtonElement>('[data-agenda-fold="references"]');
  if (terms !== null && terms.getAttribute('aria-expanded') !== 'true') await interact(() => terms.click());
  return view.container;
};

const segment = (root: HTMLElement, selector: string): HTMLElement =>
  must(root.querySelector<HTMLElement>(selector), selector);

/** Opens "The full picture": the main tab is open first, and only the open tab is in the page (&F923). */
const openBody = async (root: HTMLElement): Promise<void> => {
  await interact(() => segment(root, '[data-agenda-tab-button="body"]').click());
};

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
    await openBody(root);
    expect(segment(root, '[data-agenda-section="more"]').querySelectorAll('li')).toHaveLength(2);
    expect(segment(root, '[data-agenda-references] td').querySelectorAll('li')).toHaveLength(2);
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
      '[data-agenda-references] td',
    ]) {
      expect(segment(root, selector).querySelector('.fy-seg'), selector).not.toBeNull();
    }
    await openBody(root);
    expect(segment(root, '[data-agenda-section="more"]').querySelector('.fy-seg')).not.toBeNull();
  });

  test('a long single paragraph is still drawn whole (the writing lint is what warns about it)', async () => {
    const answer = segment(await draw({ questionAnswer: WALL }), '[data-agenda-question-answer]');
    expect(answer.textContent).toContain('one owner-only wall.');
  });
});

const HEADINGS = '# Big\n## Plan\n### Steps\n#### Four\n##### Five\n###### Six\nthen the rest';
const ASK =
  'What should change in &B131? You said: its working now, but I want more features I do not want the catalog to be a back sheet or something, and it does not tell me which catalog the skills are from';

describe('a heading in a segment is drawn as bold body text, never an h1–h6', () => {
  test('every segment demotes # … ###### to a bold line and keeps the text', async () => {
    const root = await draw({
      premise: HEADINGS,
      context: HEADINGS,
      decided: HEADINGS,
      stillOpen: HEADINGS,
      questionAnswer: HEADINGS,
      body: HEADINGS,
    });
    const selectors = [
      '[data-agenda-question-answer]',
      '[data-agenda-section="premise"]',
      '[data-agenda-section="context"]',
      '[data-agenda-section="decided"]',
      '[data-agenda-section="still-open"]',
      // "The full picture" last: opening its tab closes the main one (&F923).
      '[data-agenda-section="more"]',
    ];
    for (const selector of selectors) {
      if (selector.includes('more')) await openBody(root);
      const each = segment(root, selector);
      expect(
        each.querySelector('.fy-seg h1, .fy-seg h2, .fy-seg h3, .fy-seg h4, .fy-seg h5, .fy-seg h6'),
        selector,
      ).toBeNull();
      const demoted = [...each.querySelectorAll('[data-demoted-heading]')];
      expect(
        demoted.map(line => line.textContent),
        selector,
      ).toEqual(['Big', 'Plan', 'Steps', 'Four', 'Five', 'Six']);
      for (const line of demoted) expect(line.querySelector('strong')?.textContent).toBe(line.textContent);
      expect(each.textContent, selector).toContain('then the rest');
    }
  });

  test('a heading inside the ask is demoted too, and the card keeps only its own labels as headings', async () => {
    const root = await draw({ subject: `## ${ASK}` });
    const ask = segment(root, '[data-agenda-question-line]');
    expect(ask.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull();
    expect(ask.querySelector('[data-demoted-heading] strong')?.textContent).toBe(ASK);
  });
});

describe('the ask is a short bold line at body size', () => {
  const css = readFileSync(join(import.meta.dir, '../../../../app/features/agenda/agenda-item-card.css'), 'utf8');
  const rule = /(?:^|\n)\.fy-card__question \{([^}]*)\}/u.exec(css)?.[1] ?? '';

  test('its rule sets body size and strong weight, and no heading size', () => {
    expect(rule).toContain('font-size: var(--text-base)');
    expect(rule).toContain('font-weight: var(--weight-strong)');
    expect(rule).not.toContain('--text-lg');
    expect(rule).toContain('overflow-wrap: anywhere');
  });

  test('a long ask is one block of text in the need segment, not a heading element', async () => {
    const root = await draw({ subject: ASK });
    const need = segment(root, '[data-agenda-need]');
    const ask = segment(need, '[data-agenda-question-line]');
    expect(ask.className).toBe('fy-card__question');
    expect(ask.tagName).toBe('DIV');
    expect(ask.textContent).toContain('which catalog the skills are from');
    expect(ask.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull();
    expect(need.querySelectorAll('h1, h2, h3')).toHaveLength(0);
  });
});
