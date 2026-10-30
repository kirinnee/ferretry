import { afterEach, describe, expect, test } from 'bun:test';
import { AgendaCard } from '../../../src/features/agenda/agenda-card.tsx';
import { agendaItem } from '../../support/agenda-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const names = (root: ParentNode): string[] =>
  [...root.querySelectorAll('[data-agenda-section]')].map(node => node.getAttribute('data-agenda-section') ?? '');

const full = agendaItem('A1', {
  subject: 'Pick the CI name',
  why: 'Pick the CI name',
  premise: '- 55 repos call the job `ci`\n- 3 call it `build`',
  decided: '- Keep GitHub Actions',
  context: 'The release is cut on Friday.',
  terms: [
    { term: 'CI', meaning: 'continuous integration' },
    { term: 'PR', meaning: 'pull request' },
  ],
  recommendation: { decision: 'Keep ci', why: 'Matches 55 repos.' },
  impact: '- 3 repos need an edit',
  steps: ['Rename the job', 'Re-run CI'],
  body: 'A short body.',
  links: [{ label: 'Spec', target: 'https://example.test/spec' }],
  ask: {
    kind: 'multiple-choice',
    options: [
      { label: 'Rename to build', description: '3 repos fine, 55 need an edit' },
      { label: 'Keep ci', description: 'matches 55 repos' },
    ],
  },
});

const longContext = agendaItem('A5', {
  ...full,
  context: 'The release is cut on Friday.\n\nAfter that the names are frozen.',
});

describe('AgendaCard content', () => {
  test('draws none of the detail sections: they live in Details', async () => {
    view = await mount(<AgendaCard item={longContext} onAct={() => {}} />);
    expect(names(view.container)).toEqual([]);
    expect(view.container.querySelector('table[data-agenda-terms]')).toBeNull();
    expect(view.container.querySelector('[data-agenda-steps-count]')).toBeNull();
    expect(view.container.querySelector('[data-agenda-body]')).toBeNull();
  });

  test('the recommendation is a tag and a reason line in the answer bar, never a section', async () => {
    view = await mount(<AgendaCard item={full} onAct={() => {}} />);
    expect(names(view.container)).not.toContain('recommendation');
    const tagged = must(view.container.querySelector('[data-agenda-answer] [data-agenda-recommended]'), 'tag');
    expect(tagged.closest('[data-agenda-option]')?.getAttribute('data-agenda-option')).toBe('Keep ci');
    expect(tagged.textContent).toContain('Recommended');
    const reason = must(view.container.querySelector('[data-agenda-actions] [data-agenda-recommendation]'), 'reason');
    expect(reason.textContent).toBe('Matches 55 repos.');
  });

  test('the first point of the context is the one plain "why it matters" line', async () => {
    view = await mount(<AgendaCard item={longContext} onAct={() => {}} />);
    expect(view.container.querySelector('[data-agenda-why]')?.textContent).toBe('The release is cut on Friday.');
    await view.unmount();
    view = await mount(<AgendaCard item={full} onAct={() => {}} />);
    expect(view.container.querySelector('[data-agenda-why]')?.textContent).toBe('The release is cut on Friday.');
  });

  test('an item without a why draws no empty line', async () => {
    view = await mount(<AgendaCard item={agendaItem('A3', { subject: 'Same', why: 'Same' })} onAct={() => {}} />);
    expect(names(view.container)).toEqual([]);
    expect(view.container.querySelector('[data-agenda-why]')).toBeNull();
  });

  test('the heading is the question; a long one gives the heading to the title and leads the body', async () => {
    view = await mount(<AgendaCard item={full} onAct={() => {}} />);
    expect(view.container.querySelector('[data-agenda-title]')?.textContent).toBe('Pick the CI name');
    await view.unmount();
    const ask = `${'Should the release train keep going while the checks are red, '.repeat(3)}or stop?`;
    const long = agendaItem('A6', { ...full, title: 'Release train', subject: ask, why: ask });
    view = await mount(<AgendaCard item={long} onAct={() => {}} />);
    expect(view.container.querySelector('[data-agenda-title]')?.textContent).toBe('Release train');
    const first = must(view.container.querySelector('[data-agenda-scroll] [data-agenda-ask]'), 'ask line');
    expect(first.textContent).toBe(ask);
    expect(view.container.querySelector('[data-agenda-scroll] [data-agenda-section="questions"]')).toBeNull();
  });

  test('the pinned card has no Details fold either', async () => {
    view = await mount(<AgendaCard item={full} onAct={() => {}} pinned />);
    expect(view.container.querySelector('details')).toBeNull();
  });
});

describe('AgendaCard Skip', () => {
  test('is drawn first in the secondary row, before Details and ⋯, only when the host can skip, and skips', async () => {
    const skipped: string[] = [];
    const item = agendaItem('A4', { raisedBy: 'agent', context: 'More to read' });
    view = await mount(
      <AgendaCard item={item} onAct={() => {}} onOpenDetail={() => {}} onSkip={() => skipped.push('A4')} />,
    );
    const skip = must(view.container.querySelector<HTMLButtonElement>('[data-agenda-skip]'), 'skip');
    expect(skip.textContent).toContain('Skip');
    const row = skip.closest('.fy-attn-actions__row');
    const kids = [...(row?.children ?? [])];
    expect(kids.indexOf(skip)).toBe(0);
    expect(kids.indexOf(must(row?.querySelector('[data-agenda-details]'), 'details'))).toBe(1);
    expect(kids.at(-1)?.querySelector('[data-agenda-more]')).not.toBeNull();
    await interact(() => skip.click());
    expect(skipped).toEqual(['A4']);
    await view.unmount();
    view = await mount(<AgendaCard item={item} onAct={() => {}} />);
    expect(view.container.querySelector('[data-agenda-skip]')).toBeNull();
  });
});
