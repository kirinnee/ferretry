import { afterEach, describe, expect, test } from 'bun:test';
import { AttentionBriefSections, cardLede } from '../../../src/features/attention/attention-brief.tsx';
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

describe('the described options', () => {
  const described = attentionItem('A2', {
    subject: 'Which database should keep the board’s finished items?',
    ask: {
      kind: 'multiple-choice',
      options: [
        { label: 'SQLite', description: 'No server to run.' },
        { label: 'Postgres', description: 'Shared.' },
      ],
    },
  });
  const rowOf = (root: ParentNode, label: string): Element | null =>
    root.querySelector(`[data-attention-option-detail="${label}"]`);

  test('badge the recommended option on the board, where the recommendation section is not the only mark', async () => {
    view = await mount(
      <AttentionBriefSections
        item={{ ...described, recommendation: { decision: 'SQLite', why: 'No server to run.' } }}
        renderProse={text => text}
      />,
    );
    const container = must(view.container, 'view');
    expect(rowOf(container, 'SQLite')?.querySelector('[data-attention-recommended]')).not.toBeNull();
    expect(rowOf(container, 'Postgres')?.querySelector('[data-attention-recommended]')).toBeNull();
  });

  test('badge the recommended option when no recommendation section is drawn to carry the mark', async () => {
    view = await mount(
      <AttentionBriefSections
        collapsible={false}
        item={{ ...described, questions: [{ question: 'Which database?', recommended: 'SQLite' }] }}
        renderProse={text => text}
      />,
    );
    const container = must(view.container, 'view');
    expect(recommendationOf(container)).toBeNull();
    expect(rowOf(container, 'SQLite')?.querySelector('[data-attention-recommended]')).not.toBeNull();
    expect(rowOf(container, 'Postgres')?.querySelector('[data-attention-recommended]')).toBeNull();
  });

  test('the open layout draws no recommendation section, so the option carries the mark', async () => {
    view = await mount(
      <AttentionBriefSections
        collapsible={false}
        item={{ ...described, recommendation: { decision: 'SQLite' } }}
        renderProse={text => text}
      />,
    );
    const container = must(view.container, 'view');
    expect(recommendationOf(container)).toBeNull();
    expect(rowOf(container, 'SQLite')?.querySelector('[data-attention-recommended]')).not.toBeNull();
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

describe('cardLede', () => {
  test('a stated why leads and the context stays whole', () => {
    expect(cardLede({ context: '- one\n- two' }, 'Because.')).toEqual({ line: 'Because.', context: '- one\n- two' });
  });

  test('without a why, the first bullet leads and the rest remain', () => {
    expect(cardLede({ context: '- one\n- two\n- three' }, null)).toEqual({ line: 'one', context: '- two\n- three' });
    expect(cardLede({ context: '- only' }, null)).toEqual({ line: 'only', context: null });
  });

  test('without a why, the first paragraph leads and the rest remain', () => {
    expect(cardLede({ context: 'First.\n\nSecond.' }, null)).toEqual({ line: 'First.', context: 'Second.' });
  });

  test('nothing to say gives no line', () => {
    expect(cardLede({}, null)).toEqual({ line: null, context: null });
  });
});
