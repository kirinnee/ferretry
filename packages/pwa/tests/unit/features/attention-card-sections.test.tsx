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

describe('AttentionCard open sections', () => {
  test('draws every section it has, open, in the one fixed order', async () => {
    view = await mount(<AttentionCard item={full} onAct={() => {}} />);
    expect(names(view.container)).toEqual([
      'premise',
      'context',
      'decided',
      'options',
      'recommendation',
      'impact',
      'steps',
      'terms',
      'more',
      'links',
    ]);
    expect(view.container.querySelectorAll('details[data-attention-section]')).toHaveLength(0);
  });

  test('premise and context are two blocks with their own headings', async () => {
    view = await mount(<AttentionCard item={full} onAct={() => {}} />);
    const premise = must(view.container.querySelector('[data-attention-section="premise"]'), 'premise');
    const context = must(view.container.querySelector('[data-attention-section="context"]'), 'context');
    expect(premise).not.toBe(context);
    expect(premise.contains(context) || context.contains(premise)).toBe(false);
    expect(premise.querySelector('.fy-attn-sec__heading')?.textContent).toBe('Premise');
    expect(context.querySelector('.fy-attn-sec__heading')?.textContent).toBe('Context');
    expect(premise.querySelectorAll('li')).toHaveLength(2);
    expect(context.textContent).toContain('The release is cut on Friday.');
    expect(context.textContent).not.toContain('55 repos');
  });

  test('an item without a section draws no empty one', async () => {
    view = await mount(<AttentionCard item={attentionItem('A2', { context: 'Only this.' })} onAct={() => {}} />);
    expect(names(view.container)).toEqual(['context']);
    await view.unmount();
    view = await mount(<AttentionCard item={attentionItem('A3', { subject: 'Same', why: 'Same' })} onAct={() => {}} />);
    expect(names(view.container)).toEqual([]);
  });

  test('options say which way each swipes and what happens, and terms are one muted line', async () => {
    view = await mount(<AttentionCard item={full} onAct={() => {}} />);
    const rows = [...view.container.querySelectorAll('[data-attention-option-detail]')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector('.fy-attn-options__arrow')).not.toBeNull();
    expect(rows[0]?.textContent).toContain('55 need an edit');
    const terms = must(view.container.querySelector('[data-attention-terms-line]'), 'terms line');
    expect(terms.textContent).toBe('CI = continuous integration · PR = pull request');
  });

  test('a long body starts as a preview behind Show more, a short one is whole', async () => {
    view = await mount(<AttentionCard item={full} onAct={() => {}} />);
    expect(view.container.querySelector('[data-attention-body-toggle]')).toBeNull();
    await view.unmount();
    view = await mount(<AttentionCard item={{ ...full, body: 'line of detail\n'.repeat(40) }} onAct={() => {}} />);
    const more = must(view.container.querySelector<HTMLButtonElement>('[data-attention-body-toggle]'), 'toggle');
    expect(more.textContent).toBe('Show more');
    expect(view.container.querySelector('[data-attention-body][data-folded]')).not.toBeNull();
    await interact(() => more.click());
    expect(more.textContent).toBe('Show less');
    expect(view.container.querySelector('[data-attention-body][data-folded]')).toBeNull();
  });

  test('the pinned card has no Details fold either', async () => {
    view = await mount(<AttentionCard item={full} onAct={() => {}} pinned />);
    expect(view.container.querySelector('[data-attention-details]')).toBeNull();
    expect(names(view.container)).toContain('context');
  });
});

describe('AttentionCard Skip', () => {
  test('is drawn in the second row, after Discuss, only when the host can skip, and skips', async () => {
    const skipped: string[] = [];
    const item = attentionItem('A4', { raisedBy: 'agent' });
    view = await mount(<AttentionCard item={item} onAct={() => {}} onSkip={() => skipped.push('A4')} />);
    const skip = must(view.container.querySelector<HTMLButtonElement>('[data-attention-skip]'), 'skip');
    expect(skip.textContent).toContain('Skip');
    const row = skip.closest('.fy-attn-actions__row');
    expect(row?.querySelector('[data-attention-reply-toggle]')).not.toBeNull();
    const kids = [...(row?.children ?? [])];
    expect(kids.indexOf(skip)).toBeGreaterThan(
      kids.indexOf(must(row?.querySelector('[data-attention-reply-toggle]'), 'r')),
    );
    await interact(() => skip.click());
    expect(skipped).toEqual(['A4']);
    await view.unmount();
    view = await mount(<AttentionCard item={item} onAct={() => {}} />);
    expect(view.container.querySelector('[data-attention-skip]')).toBeNull();
  });
});
