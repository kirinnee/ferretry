import { afterEach, describe, expect, test } from 'bun:test';
import { PointForm } from '../../../src/features/agenda/agenda-brief.tsx';
import { AgendaCard } from '../../../src/features/agenda/agenda-card.tsx';
import { AgendaDetail } from '../../../src/features/agenda/agenda-detail.tsx';
import type { InboxAction } from '../../../src/lib/agenda-inbox.ts';
import { agendaItem, choices } from '../../support/agenda-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';

const rich = agendaItem('A1', {
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
  [...root.querySelectorAll('[data-agenda-section]')].map(node => node.getAttribute('data-agenda-section') ?? '');

describe('AgendaCard sections', () => {
  test('a rich item draws only what it needs to be answered: the per-question pickers and a recommendation', async () => {
    view = await mount(<AgendaCard item={rich} onAct={() => {}} />);
    expect(sections(view.container)).toEqual(['questions', 'recommendation']);
    expect(view.container.querySelectorAll('details[data-agenda-section]')).toHaveLength(0);
    expect(view.container.textContent).not.toContain('Urgency:');
  });

  test('the summary is drawn once, and a why that repeats it gives way to the first point of the context', async () => {
    view = await mount(<AgendaCard item={rich} onAct={() => {}} />);
    expect(view.container.textContent?.split('Pick the storage').length).toBe(2);
    expect(view.container.querySelector('[data-agenda-why]')?.textContent).toBe('We need somewhere to keep the board.');
    expect(view.container.querySelector('[data-agenda-section="context"]')).toBeNull();
  });

  test('a different why is kept', async () => {
    view = await mount(<AgendaCard item={{ ...rich, why: 'It blocks the release.' }} onAct={() => {}} />);
    expect(view.container.querySelector('[data-agenda-why]')?.textContent).toContain('It blocks the release.');
  });

  test('an external link in the detail opens safely in a new tab', async () => {
    view = await mount(<AgendaDetail item={rich} layout="panel" />);
    const link = must(view.container.querySelector<HTMLAnchorElement>('a[href="https://example.test/spec"]'), 'link');
    expect(link.getAttribute('rel')).toBe('noreferrer noopener');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  test('an old item stays minimal: the question and its options', async () => {
    const old = agendaItem('A2', { subject: 'Approve?', context: 'Halfway there.', ask: choices('Yes', 'No') });
    view = await mount(<AgendaCard item={old} onAct={() => {}} />);
    expect(sections(view.container)).toEqual([]);
    expect(view.container.querySelector('[data-agenda-why]')?.textContent).toBe('Why A2 needs you.');
    expect(view.container.querySelectorAll('[data-agenda-option]')).toHaveLength(2);
    expect(view.container.querySelector('[data-agenda-recommended]')).toBeNull();
  });

  test('the header names the ferret and machine, the title stands above the scroll, the per-question recommendation is a section', async () => {
    view = await mount(
      <AgendaCard
        item={rich}
        onAct={() => {}}
        origin={{ ferret: 'Kai', task: 'Release train', machine: 'Laptop', href: '/x', onNavigate: () => {} }}
      />,
    );
    expect(view.container.querySelector('.fy-attn-card__origin-title')?.textContent).toBe('Kai');
    expect(view.container.querySelector('.fy-attn-card__origin-sub')?.textContent).toBe('Laptop');
    expect(view.container.querySelector('[data-agenda-title]')?.textContent).toBeTruthy();
    expect(view.container.querySelector('[data-agenda-recommendation]')?.textContent).toContain('Use SQLite');
    expect(view.container.querySelector('[data-agenda-scroll] [data-agenda-title]')).toBeNull();
    expect(
      view.container.querySelector(
        '[data-agenda-scroll] [data-agenda-section="recommendation"] [data-agenda-recommendation]',
      ),
    ).not.toBeNull();
  });
});

describe('AgendaCard recommended option', () => {
  test('a choice puts the recommended option in the middle (up), the other on the left', async () => {
    const single = agendaItem('A3', {
      subject: 'Pick',
      questions: [{ question: 'Which?', options: [{ label: 'SQLite' }, { label: 'Postgres' }], recommended: 'SQLite' }],
      ask: choices('SQLite', 'Postgres'),
    });
    view = await mount(<AgendaCard item={single} onAct={() => {}} />);
    const middle = must(view.container.querySelector('[data-agenda-answer="up"]'), 'middle answer');
    expect(middle.getAttribute('data-agenda-option')).toBe('SQLite');
    expect(view.container.querySelector('[data-agenda-answer="left"]')?.getAttribute('data-agenda-option')).toBe(
      'Postgres',
    );
    expect(view.container.querySelector('[data-agenda-answer="right"]')).toBeNull();
  });
});

describe('AgendaCard per-question answers', () => {
  test('collects one picked answer per question and sends them as one open-question reply', async () => {
    const sent: InboxAction[] = [];
    view = await mount(<AgendaCard item={rich} onAct={action => sent.push(action)} />);
    const send = (): HTMLButtonElement =>
      must(view?.container.querySelector<HTMLButtonElement>('[data-agenda-send-answers]'), 'Send answers');
    expect(send().disabled).toBe(true);
    // The default view offers a single "Send answers", not the per-item options.
    expect(view.container.querySelector('[data-agenda-option]')).toBeNull();

    await interact(() =>
      must(view?.container.querySelector<HTMLButtonElement>('[data-agenda-pick="SQLite"]'), 'SQLite').click(),
    );
    expect(view.container.querySelector('[data-agenda-pick="SQLite"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(send().disabled).toBe(false);

    await interact(() =>
      must(view?.container.querySelector<HTMLButtonElement>('[data-agenda-pick="Now"]'), 'Now').click(),
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
    view = await mount(<AgendaCard item={odd} onAct={() => {}} />);
    expect(view.container.querySelector('[data-agenda-send-answers]')).toBeNull();
    expect(view.container.querySelectorAll('[data-agenda-option]')).toHaveLength(2);
  });
});

describe('AgendaDetail point form', () => {
  test('context and impact written as bullets draw as lists, one point each', async () => {
    const bulleted = {
      ...rich,
      context: '- the login expires\n- two plans fit',
      impact: '- blocks the release\n- costs a day',
    };
    view = await mount(<AgendaDetail item={bulleted} layout="panel" />);
    const points = (section: string): string[] =>
      [...(view?.container.querySelectorAll(`[data-agenda-section="${section}"] li`) ?? [])].map(
        node => node.textContent ?? '',
      );
    expect(points('context')).toEqual(['the login expires', 'two plans fit']);
    expect(points('impact')).toEqual(['blocks the release', 'costs a day']);
  });

  test('prose or a mix of prose and bullets is drawn as Markdown, not split into points', async () => {
    view = await mount(
      <AgendaDetail
        item={{ ...rich, context: 'Lead.\n\nIntro line.\n- then a point', impact: 'Plain words.' }}
        layout="panel"
        renderProse={text => <PointForm text={text} />}
      />,
    );
    const context = view.container.querySelector('[data-agenda-section="context"]');
    expect(context?.textContent).toContain('Intro line.');
    expect(context?.querySelectorAll('.fy-attn-points').length).toBe(0);
    expect(view.container.querySelectorAll('[data-agenda-section="impact"] li').length).toBe(0);
  });
});

describe('AgendaCard error', () => {
  test('says what was not sent', async () => {
    view = await mount(<AgendaCard error="offline" item={agendaItem('A2')} onAct={() => {}} />);
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('Not sent: offline');
  });
});

describe('AgendaCard snooze control', () => {
  test('draws no clock without a way to snooze', async () => {
    view = await mount(<AgendaCard item={rich} onAct={() => {}} />);
    expect(view.container.querySelector('[data-agenda-snooze]')).toBeNull();
  });

  test('draws a clock in the header that snoozes until the chosen time', async () => {
    const snoozed: string[] = [];
    view = await mount(<AgendaCard item={rich} onAct={() => {}} onSnooze={until => snoozed.push(until)} />);
    const clock = must(view.container.querySelector<HTMLButtonElement>('[data-agenda-snooze]'), 'the clock');
    expect(clock.className).toBe('fy-attn-card__snooze');
    await interact(() => clock.click());
    await interact(() => must(view?.container.querySelector<HTMLElement>('[role="menuitem"]'), '1 hour').click());
    expect(snoozed).toHaveLength(1);
    expect(Date.parse(snoozed[0] ?? '')).toBeGreaterThan(Date.now());
  });
});
