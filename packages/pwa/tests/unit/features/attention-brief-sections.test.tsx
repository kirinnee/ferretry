import { afterEach, describe, expect, test } from 'bun:test';
import { AttentionBriefSections } from '../../../src/features/attention/attention-brief.tsx';
import { attentionItem, choices } from '../../support/attention-inbox.tsx';
import { type Mounted, mount, must } from '../../support/dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const item = attentionItem('A1', {
  title: 'Database for the board',
  subject: 'Which database should keep the board’s finished items?',
  ask: choices('SQLite', 'Postgres'),
  recommendation: { decision: 'SQLite', why: 'No server to run.' },
});

const recommendationOf = (root: ParentNode): Element | null =>
  root.querySelector('[data-attention-section="recommendation"]');

describe('the brief sections', () => {
  test('draw the recommendation and its reason where nothing above them already does (the board)', async () => {
    view = await mount(<AttentionBriefSections item={item} renderProse={text => text} />);
    const section = must(recommendationOf(must(view.container, 'view')), 'the recommendation section');
    expect(section.textContent).toContain('SQLite — No server to run.');
  });

  test('leave a lone question out where the card already draws the ask, and keep several', async () => {
    const lone = { ...item, questions: [{ question: 'Which database should hold the board?' }] };
    view = await mount(<AttentionBriefSections askShown item={lone} renderProse={text => text} />);
    expect(must(view.container, 'view').querySelector('[data-attention-section="questions"]')).toBeNull();
    await view.unmount();
    const several = { ...item, questions: [{ question: 'Which day?' }, { question: 'Who announces it?' }] };
    view = await mount(<AttentionBriefSections askShown item={several} renderProse={text => text} />);
    expect(must(view.container, 'view').querySelector('[data-attention-section="questions"]')).not.toBeNull();
  });

  test('draw a recommendation handed in, in the same section', async () => {
    view = await mount(
      <AttentionBriefSections
        collapsible={false}
        item={{ ...item, recommendation: undefined }}
        recommendation={{ decision: 'Postgres' }}
        renderProse={text => text}
      />,
    );
    expect(recommendationOf(must(view.container, 'view'))?.textContent).toContain('Postgres');
  });
});

describe('the brief sections, by card', () => {
  const terms = [
    { term: 'CI', meaning: 'the automatic tests on every change' },
    { term: 'PR', meaning: 'a proposed change' },
  ];
  const heading = (root: ParentNode): string | null | undefined =>
    root.querySelector('[data-attention-section="questions"] .fy-attn-sec__heading')?.textContent;

  test('the board folds Terms into a list of each term and its meaning', async () => {
    view = await mount(<AttentionBriefSections item={{ ...item, terms }} renderProse={text => text} />);
    const section = must(
      must(view.container, 'view').querySelector('[data-attention-section="terms"]'),
      'the terms section',
    );
    expect(section.textContent).toContain('Terms (2)');
    expect([...section.querySelectorAll('dt')].map(term => term.textContent)).toEqual(['CI', 'PR']);
  });

  test('names the ask by what the card is: what happened, a to-do, or a question', async () => {
    const asked = (patch: Record<string, unknown>) =>
      attentionItem('A2', { title: 'Heading', subject: 'The ask in full', ...patch });
    for (const [patch, expected] of [
      [{ kind: 'info' }, 'What happened'],
      [{ ask: { kind: 'task' } }, 'To do'],
      [{ ask: choices('Yes', 'No') }, 'The question'],
      [{ ask: { kind: 'permission' } }, 'The question'],
      [{ questions: [{ question: 'Which day?' }, { question: 'Who?' }] }, 'The questions'],
    ] as const) {
      view = await mount(
        <AttentionBriefSections
          ask="The ask in full"
          collapsible={false}
          item={asked(patch)}
          renderProse={text => text}
        />,
      );
      expect(heading(must(view.container, 'view'))).toContain(expected);
      await view.unmount();
      view = null;
    }
  });
});
