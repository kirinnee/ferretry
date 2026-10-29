import { afterEach, describe, expect, test } from 'bun:test';
import { AttentionCard } from '../../../src/features/attention/attention-card.tsx';
import type { InboxAction } from '../../../src/lib/attention-inbox.ts';
import { attentionItem, choices } from '../../support/attention-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';

const nativeInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

const rich = attentionItem('A1', {
  subject: 'Pick the storage',
  why: 'Pick the storage',
  context: 'We need somewhere to keep the board.',
  terms: [
    { term: 'WAL', meaning: 'write-ahead log' },
    { term: 'ACID', meaning: 'safe commits' },
  ],
  questions: [
    {
      question: 'Which engine?',
      options: [{ label: 'SQLite' }, { label: 'Postgres' }],
      recommended: 'SQLite',
      why: 'No server.',
    },
    { question: 'Migrate when?', options: [{ label: 'Now' }, { label: 'Later' }] },
  ],
  recommendation: { decision: 'Use SQLite', why: 'Simplest.' },
  impact: 'The board stays in memory.',
  urgency: 'Before Friday',
  links: [{ label: 'Spec', target: 'https://example.test/spec' }, { target: '@docs/storage.md' }],
  ask: { kind: 'open-question' },
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const sections = (root: ParentNode): string[] =>
  [...root.querySelectorAll('[data-attention-section]')].map(node => node.getAttribute('data-attention-section') ?? '');

describe('AttentionCard sections', () => {
  test('a rich item draws every section, in order, all open — the card shows everything to decide', async () => {
    view = await mount(<AttentionCard item={rich} onAct={() => {}} />);
    expect(sections(view.container)).toEqual(['context', 'terms', 'questions', 'impact', 'links']);
    const open = [...view.container.querySelectorAll('[data-attention-section]')]
      .filter(node => node.hasAttribute('open'))
      .map(node => node.getAttribute('data-attention-section'));
    expect(open).toEqual(['context', 'terms', 'questions', 'impact', 'links']);
    expect(view.container.textContent).toContain('Urgency:');
  });

  test('the summary is drawn once, and a why that repeats it is not drawn', async () => {
    view = await mount(<AttentionCard item={rich} onAct={() => {}} />);
    expect(view.container.textContent?.split('Pick the storage').length).toBe(2);
    expect(view.container.querySelector('.fy-attn-card__why')).toBeNull();
  });

  test('a different why is kept', async () => {
    view = await mount(<AttentionCard item={{ ...rich, why: 'It blocks the release.' }} onAct={() => {}} />);
    expect(view.container.querySelector('.fy-attn-card__why')?.textContent).toContain('It blocks the release.');
  });

  test('an external link opens safely in a new tab', async () => {
    view = await mount(<AttentionCard item={rich} onAct={() => {}} />);
    const link = must(view.container.querySelector<HTMLAnchorElement>('a[href="https://example.test/spec"]'), 'link');
    expect(link.getAttribute('rel')).toBe('noreferrer noopener');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  test('an old item stays minimal: the summary, its context and its options', async () => {
    const old = attentionItem('A2', { subject: 'Approve?', context: 'Halfway there.', ask: choices('Yes', 'No') });
    view = await mount(<AttentionCard item={old} onAct={() => {}} />);
    expect(sections(view.container)).toEqual([]);
    expect(view.container.querySelector('.fy-attn-card__context')?.textContent).toBe('Halfway there.');
    expect(view.container.querySelectorAll('[data-attention-option]')).toHaveLength(2);
    expect(view.container.querySelector('[data-attention-recommended]')).toBeNull();
  });

  test('the header names the ferret and machine, then the title, ask and recommendation stand above the detail', async () => {
    view = await mount(
      <AttentionCard
        item={rich}
        onAct={() => {}}
        origin={{ ferret: 'Kai', task: 'Release train', machine: 'Laptop', href: '/x', onNavigate: () => {} }}
      />,
    );
    expect(view.container.querySelector('.fy-attn-card__origin-title')?.textContent).toBe('Kai');
    expect(view.container.querySelector('.fy-attn-card__origin-sub')?.textContent).toBe('Laptop');
    expect(view.container.querySelector('[data-attention-title]')?.textContent).toBeTruthy();
    expect(view.container.querySelector('[data-attention-recommendation]')?.textContent).toContain('Use SQLite');
    expect(view.container.querySelector('[data-attention-scroll] [data-attention-recommendation]')).toBeNull();
  });
});

describe('AttentionCard recommended option', () => {
  test('a choice puts the recommended option on the right, as the primary answer', async () => {
    const single = attentionItem('A3', {
      subject: 'Pick',
      questions: [{ question: 'Which?', options: [{ label: 'SQLite' }, { label: 'Postgres' }], recommended: 'SQLite' }],
      ask: choices('SQLite', 'Postgres'),
    });
    view = await mount(<AttentionCard item={single} onAct={() => {}} />);
    const right = must(view.container.querySelector('[data-attention-answer="right"]'), 'right answer');
    expect(right.getAttribute('data-attention-option')).toBe('SQLite');
    expect(right.getAttribute('data-variant')).toBe('primary');
    expect(view.container.querySelector('[data-attention-answer="left"]')?.getAttribute('data-attention-option')).toBe(
      'Postgres',
    );
  });
});

describe('AttentionCard per-question answers', () => {
  test('collects one answer per question and sends them as one open-question reply', async () => {
    const sent: InboxAction[] = [];
    view = await mount(<AttentionCard item={rich} onAct={action => sent.push(action)} />);
    const send = (): HTMLButtonElement =>
      must(view?.container.querySelector<HTMLButtonElement>('[data-attention-send-answers]'), 'Send answers');
    expect(send().disabled).toBe(true);
    // The default view offers a single "Send answers", not the per-item options.
    expect(view.container.querySelector('[data-attention-option]')).toBeNull();

    await interact(() =>
      must(view?.container.querySelector<HTMLButtonElement>('[data-attention-pick="SQLite"]'), 'SQLite').click(),
    );
    expect(view.container.querySelector('[data-attention-pick="SQLite"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(send().disabled).toBe(false);

    // The second question sits behind its own fold; open it and type a free answer.
    const second = must(view.container.querySelector('[data-attention-question="1"] details'), 'second question');
    await interact(() => second.setAttribute('open', ''));
    const field = must(second.querySelector<HTMLInputElement>('input[type="text"]'), 'free text');
    await interact(() => {
      nativeInput?.call(field, 'Friday');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await interact(() => send().click());
    expect(sent).toEqual([
      {
        kind: 'respond',
        label: 'Reply',
        response: {
          kind: 'open-question',
          answer: '1. Which engine?\n→ SQLite\n\n2. Migrate when?\n→ Friday',
        },
      },
    ]);
  });

  test('several questions behind a non-open-question ask keep today’s controls', async () => {
    const odd = { ...rich, ask: choices('Go', 'Stop') };
    view = await mount(<AttentionCard item={odd} onAct={() => {}} />);
    expect(view.container.querySelector('[data-attention-send-answers]')).toBeNull();
    expect(view.container.querySelectorAll('[data-attention-option]')).toHaveLength(2);
  });
});

describe('AttentionCard point form', () => {
  test('context and impact written as bullets draw as lists, one point each', async () => {
    const bulleted = {
      ...rich,
      context: '- the login expires\n- two plans fit',
      impact: '- blocks the release\n- costs a day',
    };
    view = await mount(<AttentionCard item={bulleted} onAct={() => {}} />);
    const points = (section: string): string[] =>
      [...(view?.container.querySelectorAll(`[data-attention-section="${section}"] li`) ?? [])].map(
        node => node.textContent ?? '',
      );
    expect(points('context')).toEqual(['the login expires', 'two plans fit']);
    expect(points('impact')).toEqual(['blocks the release', 'costs a day']);
  });

  test('prose, or a mix of prose and bullets, stays a paragraph', async () => {
    view = await mount(
      <AttentionCard
        item={{ ...rich, context: 'Intro line.\n- then a point', impact: 'Plain words.' }}
        onAct={() => {}}
      />,
    );
    expect(view.container.querySelectorAll('[data-attention-section="context"] li').length).toBe(0);
    expect(view.container.querySelector('[data-attention-section="context"]')?.textContent).toContain('Intro line.');
    expect(view.container.querySelectorAll('[data-attention-section="impact"] li').length).toBe(0);
  });
});
