import { afterEach, describe, expect, test } from 'bun:test';
import { AttentionCard } from '../../../src/features/attention/attention-card.tsx';
import { attentionItem } from '../../support/attention-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const names = (root: ParentNode): string[] =>
  [...root.querySelectorAll('[data-attention-section]')].map(node => node.getAttribute('data-attention-section') ?? '');

const full = attentionItem('A1', {
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

const longContext = attentionItem('A5', {
  ...full,
  context: 'The release is cut on Friday.\n\nAfter that the names are frozen.',
});

describe('AttentionCard content', () => {
  test('draws none of the detail sections: they live in Details', async () => {
    view = await mount(<AttentionCard item={longContext} onAct={() => {}} />);
    expect(names(view.container)).toEqual([]);
    expect(view.container.querySelector('table[data-attention-terms]')).toBeNull();
    expect(view.container.querySelector('[data-attention-steps-count]')).toBeNull();
    expect(view.container.querySelector('[data-attention-body]')).toBeNull();
  });

  test('the recommendation is a tag and a reason line in the answer bar, never a section', async () => {
    view = await mount(<AttentionCard item={full} onAct={() => {}} />);
    expect(names(view.container)).not.toContain('recommendation');
    const tagged = must(view.container.querySelector('[data-attention-answer] [data-attention-recommended]'), 'tag');
    expect(tagged.closest('[data-attention-option]')?.getAttribute('data-attention-option')).toBe('Keep ci');
    expect(tagged.textContent).toContain('Recommended');
    const reason = must(
      view.container.querySelector('[data-attention-actions] [data-attention-recommendation]'),
      'reason',
    );
    expect(reason.textContent).toBe('Matches 55 repos.');
  });

  test('the first point of the context is the one plain "why it matters" line', async () => {
    view = await mount(<AttentionCard item={longContext} onAct={() => {}} />);
    expect(view.container.querySelector('[data-attention-why]')?.textContent).toBe('The release is cut on Friday.');
    await view.unmount();
    view = await mount(<AttentionCard item={full} onAct={() => {}} />);
    expect(view.container.querySelector('[data-attention-why]')?.textContent).toBe('The release is cut on Friday.');
  });

  test('an item without a why draws no empty line', async () => {
    view = await mount(<AttentionCard item={attentionItem('A3', { subject: 'Same', why: 'Same' })} onAct={() => {}} />);
    expect(names(view.container)).toEqual([]);
    expect(view.container.querySelector('[data-attention-why]')).toBeNull();
  });

  test('the heading is the question; a long one gives the heading to the title and leads the body', async () => {
    view = await mount(<AttentionCard item={full} onAct={() => {}} />);
    expect(view.container.querySelector('[data-attention-title]')?.textContent).toBe('Pick the CI name');
    await view.unmount();
    const ask = `${'Should the release train keep going while the checks are red, '.repeat(3)}or stop?`;
    const long = attentionItem('A6', { ...full, title: 'Release train', subject: ask, why: ask });
    view = await mount(<AttentionCard item={long} onAct={() => {}} />);
    expect(view.container.querySelector('[data-attention-title]')?.textContent).toBe('Release train');
    const first = must(view.container.querySelector('[data-attention-scroll] [data-attention-ask]'), 'ask line');
    expect(first.textContent).toBe(ask);
    expect(view.container.querySelector('[data-attention-scroll] [data-attention-section="questions"]')).toBeNull();
  });

  test('the pinned card has no Details fold either', async () => {
    view = await mount(<AttentionCard item={full} onAct={() => {}} pinned />);
    expect(view.container.querySelector('details')).toBeNull();
  });
});

describe('AttentionCard Skip', () => {
  test('is drawn first in the secondary row, before Details and ⋯, only when the host can skip, and skips', async () => {
    const skipped: string[] = [];
    const item = attentionItem('A4', { raisedBy: 'agent', context: 'More to read' });
    view = await mount(
      <AttentionCard item={item} onAct={() => {}} onOpenDetail={() => {}} onSkip={() => skipped.push('A4')} />,
    );
    const skip = must(view.container.querySelector<HTMLButtonElement>('[data-attention-skip]'), 'skip');
    expect(skip.textContent).toContain('Skip');
    const row = skip.closest('.fy-attn-actions__row');
    const kids = [...(row?.children ?? [])];
    expect(kids.indexOf(skip)).toBe(0);
    expect(kids.indexOf(must(row?.querySelector('[data-attention-details]'), 'details'))).toBe(1);
    expect(kids.at(-1)?.querySelector('[data-attention-more]')).not.toBeNull();
    await interact(() => skip.click());
    expect(skipped).toEqual(['A4']);
    await view.unmount();
    view = await mount(<AttentionCard item={item} onAct={() => {}} />);
    expect(view.container.querySelector('[data-attention-skip]')).toBeNull();
  });
});
