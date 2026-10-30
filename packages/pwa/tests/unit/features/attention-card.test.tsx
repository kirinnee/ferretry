import { afterEach, describe, expect, test } from 'bun:test';
import { PointForm } from '../../../src/features/attention/attention-brief.tsx';
import { AttentionCard } from '../../../src/features/attention/attention-card.tsx';
import { AttentionDetail } from '../../../src/features/attention/attention-detail.tsx';
import type { InboxAction } from '../../../src/lib/attention-inbox.ts';
import { attentionItem, choices } from '../../support/attention-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';

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
  test('a rich item draws only what it needs to be answered: the per-question pickers and a recommendation', async () => {
    view = await mount(<AttentionCard item={rich} onAct={() => {}} />);
    expect(sections(view.container)).toEqual(['questions', 'recommendation']);
    expect(view.container.querySelectorAll('details[data-attention-section]')).toHaveLength(0);
    expect(view.container.textContent).not.toContain('Urgency:');
  });

  test('the summary is drawn once, and a why that repeats it gives way to the first point of the context', async () => {
    view = await mount(<AttentionCard item={rich} onAct={() => {}} />);
    expect(view.container.textContent?.split('Pick the storage').length).toBe(2);
    expect(view.container.querySelector('[data-attention-why]')?.textContent).toBe(
      'We need somewhere to keep the board.',
    );
    expect(view.container.querySelector('[data-attention-section="context"]')).toBeNull();
  });

  test('a different why is kept', async () => {
    view = await mount(<AttentionCard item={{ ...rich, why: 'It blocks the release.' }} onAct={() => {}} />);
    expect(view.container.querySelector('[data-attention-why]')?.textContent).toContain('It blocks the release.');
  });

  test('an external link in the detail opens safely in a new tab', async () => {
    view = await mount(<AttentionDetail item={rich} layout="panel" />);
    const link = must(view.container.querySelector<HTMLAnchorElement>('a[href="https://example.test/spec"]'), 'link');
    expect(link.getAttribute('rel')).toBe('noreferrer noopener');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  test('an old item stays minimal: the question and its options', async () => {
    const old = attentionItem('A2', { subject: 'Approve?', context: 'Halfway there.', ask: choices('Yes', 'No') });
    view = await mount(<AttentionCard item={old} onAct={() => {}} />);
    expect(sections(view.container)).toEqual([]);
    expect(view.container.querySelector('[data-attention-why]')?.textContent).toBe('Why A2 needs you.');
    expect(view.container.querySelectorAll('[data-attention-option]')).toHaveLength(2);
    expect(view.container.querySelector('[data-attention-recommended]')).toBeNull();
  });

  test('the header names the ferret and machine, the title stands above the scroll, the per-question recommendation is a section', async () => {
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
    expect(view.container.querySelector('[data-attention-scroll] [data-attention-title]')).toBeNull();
    expect(
      view.container.querySelector(
        '[data-attention-scroll] [data-attention-section="recommendation"] [data-attention-recommendation]',
      ),
    ).not.toBeNull();
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
  test('collects one picked answer per question and sends them as one open-question reply', async () => {
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

    await interact(() =>
      must(view?.container.querySelector<HTMLButtonElement>('[data-attention-pick="Now"]'), 'Now').click(),
    );
    expect(view.container.querySelector('input[type="text"], textarea')).toBeNull();
    await interact(() => send().click());
    expect(sent).toEqual([
      {
        kind: 'respond',
        label: 'Reply',
        response: {
          kind: 'open-question',
          answer: '1. Which engine?\n→ SQLite\n\n2. Migrate when?\n→ Now',
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

describe('AttentionDetail point form', () => {
  test('context and impact written as bullets draw as lists, one point each', async () => {
    const bulleted = {
      ...rich,
      context: '- the login expires\n- two plans fit',
      impact: '- blocks the release\n- costs a day',
    };
    view = await mount(<AttentionDetail item={bulleted} layout="panel" />);
    const points = (section: string): string[] =>
      [...(view?.container.querySelectorAll(`[data-attention-section="${section}"] li`) ?? [])].map(
        node => node.textContent ?? '',
      );
    expect(points('context')).toEqual(['the login expires', 'two plans fit']);
    expect(points('impact')).toEqual(['blocks the release', 'costs a day']);
  });

  test('with the plain renderer, prose or a mix of prose and bullets stays a paragraph', async () => {
    view = await mount(
      <AttentionDetail
        item={{ ...rich, context: 'Lead.\n\nIntro line.\n- then a point', impact: 'Plain words.' }}
        layout="panel"
        renderProse={text => <PointForm text={text} />}
      />,
    );
    expect(view.container.querySelectorAll('[data-attention-section="context"] li').length).toBe(0);
    expect(view.container.querySelector('[data-attention-section="context"]')?.textContent).toContain('Intro line.');
    expect(view.container.querySelectorAll('[data-attention-section="impact"] li').length).toBe(0);
  });
});

describe('AttentionCard error', () => {
  test('says what was not sent', async () => {
    view = await mount(<AttentionCard error="offline" item={attentionItem('A2')} onAct={() => {}} />);
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('Not sent: offline');
  });
});
