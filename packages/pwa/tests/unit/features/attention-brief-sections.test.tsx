import { afterEach, describe, expect, test } from 'bun:test';
import { AttentionBriefSections } from '../../../src/features/attention/attention-brief.tsx';
import { attentionItem, choices } from '../../support/attention-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';

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

  test('leave the recommendation out where the card draws it under its ask', async () => {
    view = await mount(<AttentionBriefSections item={item} renderProse={text => text} showRecommendation={false} />);
    expect(recommendationOf(must(view.container, 'view'))).toBeNull();
  });
});

describe('the question picker', () => {
  test('writes an option’s description under its label and toggles the pick', async () => {
    const picks: Array<[number, string]> = [];
    const asked = {
      ...item,
      questions: [
        {
          question: 'Which database should hold the board?',
          options: [{ label: 'SQLite', description: 'No server to run.' }, { label: 'Postgres' }],
          recommended: 'SQLite',
        },
      ],
    };
    const picker = {
      answers: ['Postgres'],
      disabled: false,
      onAnswer: (index: number, answer: string) => picks.push([index, answer]),
    };
    view = await mount(<AttentionBriefSections item={asked} picker={picker} renderProse={text => text} />);
    const container = must(view.container, 'view');
    const options = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-attention-pick]'));
    expect(options.map(option => option.getAttribute('data-attention-pick'))).toEqual(['SQLite', 'Postgres']);
    expect(options[0]?.querySelector('.kt-attn-option__hint')?.textContent).toBe('No server to run.');
    expect(options[1]?.querySelector('.kt-attn-option__hint')).toBeNull();
    expect(options[0]?.textContent).toContain('Recommended');
    expect(options[1]?.getAttribute('aria-pressed')).toBe('true');
    await interact(() => {
      options[0]?.click();
      options[1]?.click();
    });
    expect(picks).toEqual([
      [0, 'SQLite'],
      [0, ''],
    ]);
  });
});
