import { afterEach, describe, expect, it } from 'bun:test';
import type { AgendaId } from '@ferretry/protocol';
import { BoardDetail } from '../../../src/features/board/detail/board-detail.tsx';
import { agendaConversationPath } from '../../../src/lib/agenda-inbox.ts';
import { daemonBoardPath, daemonSessionPath } from '../../../src/lib/pages/routes.ts';
import { agendaItem, choices } from '../../support/agenda-inbox.tsx';
import { interact, type Mounted, mount, must, pressKey } from '../../support/dom.ts';
import { card, flush, laptop } from '../board-support.ts';
import {
  click,
  clickNamed,
  type DetailHarness,
  type DetailOptions,
  detailProps,
  HELPER,
  LEAD,
  text,
} from './board-detail-support.tsx';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const open = async (options: DetailOptions = {}): Promise<DetailHarness & { readonly root: HTMLElement }> => {
  const harness = detailProps(options);
  view = await mount(<BoardDetail {...harness.props} />);
  await interact(() => flush());
  return { ...harness, root: view.container };
};

const IMPLEMENT = { laneId: 'implement', title: 'Build it' };
const DROPPED = { reason: 'obsolete', at: '2026-08-01T09:30:00.000Z' };

describe('BoardDetail — reading', () => {
  it('says the machine has no such card for an address that is not a card id', async () => {
    const { root } = await open({ taskId: 'zzz' });
    expect(text(root, '.fy-board-detail__empty')).toBe('laptop has no card zzz.');
  });

  it('says the machine has no such card when it answers that it holds none', async () => {
    const { root } = await open({ task: null });
    expect(text(root, '.fy-board-detail__empty')).toBe('laptop has no card &F1.');
    expect(root.querySelector('aside')?.getAttribute('aria-label')).toBe('Card &F1');
  });

  it('says it is reading until the card arrives', async () => {
    const { root } = await open({ hold: true });
    expect(text(root, '.fy-board-detail__empty')).toBe('Reading &F1…');
    expect(root.querySelector('[role="status"]')).not.toBeNull();
  });

  it('keeps a card that throws inside its drawer, with the error on screen and Close still working', async () => {
    const harness = detailProps();
    const reports: string[] = [];
    const original = console.warn;
    console.warn = (message: unknown) => void reports.push(String(message));
    try {
      view = await mount(
        <BoardDetail
          {...harness.props}
          names={() => {
            throw new TypeError('Receiver must be an instance of class anonymous');
          }}
        />,
      );
      await interact(() => flush());
    } finally {
      console.warn = original;
    }
    const root = view.container;
    expect(text(root, '[role="alert"]')).toBe(
      '&F1 could not be drawn.TypeError: Receiver must be an instance of class anonymous',
    );
    expect(reports).toEqual(['ferretry: card &F1 failed to render']);
    await click(root, '.fy-board-detail__close');
    expect(harness.closed.count).toBe(1);
  });

  it('says why the card could not be read', async () => {
    const { root } = await open({ readFails: true });
    expect(text(root, '[role="alert"]')).toBe('The card could not be read: the machine is down.');
  });

  it('draws the card: id and title, one meta line, and each section in a flowing page', async () => {
    const { root } = await open({ task: card('F1', { ...IMPLEMENT, summary: 'It **builds**.' }) });
    expect(text(root, '.fy-board-detail__title')).toBe('&F1 Build it');
    expect(text(root, '[data-pill="lane"]')?.trim()).toBe('Implement');
    expect(text(root, '[data-meta="assignee"]')).toContain('Denisha');
    expect(text(root, '.fy-board-detail__faint')).toBe('Feature · ferretry');
    expect(root.querySelector('[data-meta="pr"]')).toBeNull();
    expect([...root.querySelectorAll('[data-section]')].map(section => section.getAttribute('data-section'))).toEqual([
      'header',
      'summary',
      'ask',
      'depends',
      'history',
    ]);
    expect(root.querySelector('details[data-section]')).toBeNull();
    expect(root.querySelector('[data-section="summary"] strong')?.textContent).toBe('builds');
    expect(root.querySelector('[data-section="asks"]')).toBeNull();
  });

  it('draws the written sections open, and none for what the card does not have', async () => {
    const { root } = await open({
      task: card('F1', {
        ...IMPLEMENT,
        premise: 'Why',
        context: 'Where',
        brief: 'How',
        terms: [{ term: 'Lane', meaning: 'A column.' }],
        links: { prs: [], branch: 'feat/x', commits: [], docs: [] },
      }),
    });
    const sections = [...root.querySelectorAll('[data-section]')].map(section => section.getAttribute('data-section'));
    expect(sections).toEqual(['header', 'ask', 'brief', 'terms', 'links', 'depends', 'history']);
    expect(text(root, '[data-agenda-section="premise"]')).toBe('PremiseWhy');
    expect(text(root, '[data-agenda-section="context"]')).toBe('ContextWhere');
    expect(root.querySelector('[data-section="summary"]')).toBeNull();
    expect(root.querySelector('[data-section="how-to-test"]')).toBeNull();
    expect(root.querySelector('[data-section="children"]')).toBeNull();
    expect(root.querySelector('[data-section="asks"]')).toBeNull();
  });

  it('reads like an agenda card: summary under the title, premise and context tinted, then the ask', async () => {
    const { root } = await open({
      task: card('F1', {
        ...IMPLEMENT,
        summary: 'Cards say how to test them',
        premise: '- Cards are hard to read\n- Done has no steps',
        context: 'Agenda v6 already reads well',
      }),
    });
    const header = must(root.querySelector('[data-section="header"]'), 'the header');
    expect(text(header, '[data-section="summary"]')).toBe('Cards say how to test them');
    const situation = must(root.querySelector('[data-agenda-situation]'), 'the premise and context');
    expect(
      [...situation.querySelectorAll('.fy-card__sit-row')].map(row => row.getAttribute('data-agenda-section')),
    ).toEqual(['premise', 'context']);
    expect([...situation.querySelectorAll('[data-agenda-section="premise"] li')].map(li => li.textContent)).toEqual([
      'Cards are hard to read',
      'Done has no steps',
    ]);
    const ask = must(root.querySelector('[data-section="ask"]'), 'the ask');
    expect(situation.compareDocumentPosition(ask) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(root.textContent).not.toContain('No summary yet');
  });

  it('draws the status first, under the summary and before the premise, as three labelled Markdown parts', async () => {
    const { root } = await open({
      task: card('F1', {
        ...IMPLEMENT,
        summary: 'Cards say what they are doing',
        status: {
          now: 'writing the **route**',
          doneSoFar: '- Protocol field\n- Design',
          next: '1. CLI\n2. PWA',
        },
        premise: 'Notes are scattered',
        context: 'Agenda v6',
      }),
    });
    const situation = must(root.querySelector('[data-agenda-situation]'), 'the situation');
    expect(
      [...situation.querySelectorAll('.fy-card__sit-row')].map(row => row.getAttribute('data-agenda-section')),
    ).toEqual(['status', 'premise', 'context']);
    const status = must(situation.querySelector('[data-agenda-section="status"]'), 'the status');
    expect(text(status, 'h4')).toBe('Status');
    expect(
      [...status.querySelectorAll('[data-status-part]')].map(part => part.getAttribute('data-status-part')),
    ).toEqual(['now', 'doneSoFar', 'next']);
    expect([...status.querySelectorAll('h5')].map(label => label.textContent)).toEqual(['Now', 'Done so far', 'Next']);
    expect(status.querySelector('[data-status-part="now"] strong')?.textContent).toBe('route');
    expect([...status.querySelectorAll('ul li')].map(li => li.textContent)).toEqual(['Protocol field', 'Design']);
    expect([...status.querySelectorAll('ol li')].map(li => li.textContent)).toEqual(['CLI', 'PWA']);
    const summary = must(root.querySelector('[data-section="summary"]'), 'the summary');
    const premise = must(situation.querySelector('[data-agenda-section="premise"]'), 'the premise');
    expect(summary.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(status.compareDocumentPosition(premise) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('skips an empty part of the status', async () => {
    const { root } = await open({
      task: card('F1', { ...IMPLEMENT, status: { now: 'waiting on review', doneSoFar: '  ', next: '' } }),
    });
    expect([...root.querySelectorAll('[data-status-part]')].map(part => part.getAttribute('data-status-part'))).toEqual(
      ['now'],
    );
  });

  it('draws nothing for a card with no status, or one with every part empty, and still draws the premise', async () => {
    const none = await open({ task: card('F1', { ...IMPLEMENT, premise: 'Why' }) });
    expect(none.root.querySelector('[data-agenda-section="status"]')).toBeNull();
    expect(none.root.querySelector('[data-agenda-section="premise"]')).not.toBeNull();
    await view?.unmount();
    view = null;
    const blank = await open({ task: card('F1', { ...IMPLEMENT, status: { now: '', doneSoFar: ' \n', next: '' } }) });
    expect(blank.root.querySelector('[data-agenda-situation]')).toBeNull();
  });

  it('marks each term where the card first uses it, and shows its meaning on a tap', async () => {
    const { root } = await open({
      task: card('F1', {
        ...IMPLEMENT,
        premise: 'The lane is wrong',
        brief: 'Move the lane',
        terms: [{ term: 'lane', meaning: 'A column of the board.' }],
      }),
    });
    const marks = [...root.querySelectorAll('a[href^="#fy-term-"]')];
    expect(marks.map(mark => mark.textContent)).toEqual(['lane']);
    expect(marks[0]?.closest('[data-agenda-section="premise"]')).not.toBeNull();
    await interact(() => (marks[0] as HTMLElement).click());
    expect(text(root, '.fy-term-tip')).toContain('A column of the board.');
  });

  it('says what a card in each activity is doing', async () => {
    for (const activity of ['active', 'idle', 'stale', 'waiting', 'orphaned'] as const) {
      const { root } = await open({ task: card('F1', { ...IMPLEMENT, activity }) });
      expect(root.querySelector('.fy-board-detail__activity')?.getAttribute('data-activity')).toBe(activity);
      expect(text(root, '.fy-board-detail__activity')?.trim()).not.toBe('');
      await view?.unmount();
      view = null;
    }
  });

  it('says a card waiting to be tried is waiting on you to try it', async () => {
    const { root } = await open({ task: card('F1', { laneId: 'tested', title: 'Try it' }) });
    expect(root.querySelector('.fy-board-detail__activity')?.textContent?.trim()).not.toBe('');
  });

  it('shows a dropped card as dropped, with the lane as plain text', async () => {
    const { root } = await open({ task: card('F1', { laneId: 'tested', title: 'Try it', dropped: DROPPED }) });
    expect(text(root, '[data-state="dropped"]')).toBe('Dropped: obsolete');
    expect(root.querySelector('[data-pill="lane"]')?.hasAttribute('data-static')).toBe(true);
  });

  it('shows the lane as plain text on any card, with or without lanes, never as a dropdown', async () => {
    for (const options of [
      { task: card('F1', { laneId: 'closed' }) },
      { task: card('F1', IMPLEMENT), laneSet: null },
      { task: card('F1', IMPLEMENT) },
    ]) {
      const { root } = await open(options);
      const pill = must(root.querySelector('[data-pill="lane"]'), 'the lane');
      expect(pill.tagName).toBe('SPAN');
      expect(pill.hasAttribute('data-static')).toBe(true);
      expect(pill.getAttribute('aria-haspopup')).toBeNull();
      await view?.unmount();
      view = null;
    }
  });

  it('draws sub-cards and the machines running its release from the cards the Board has', async () => {
    const task = card('F1', {
      ...IMPLEMENT,
      shippedIn: { version: '4.111.0', tag: 'v4.111.0', at: '2026-08-01T09:50:00.000Z' },
      links: { prs: [], branch: 'feat/x', commits: [], docs: [] },
    });
    const child = card('F2', { title: 'Sub work', parent: { id: 'F1' } });
    const { root, navigated } = await open({
      task,
      siblings: [
        {
          task,
          laneName: 'Implement',
          runningOn: [{ daemonId: laptop.daemonId, machine: 'laptop', version: '4.111.0', has: true }],
        },
        { task: child, laneName: 'Todo', runningOn: [] },
        { task: card('F3', { title: 'Elsewhere', parent: { id: 'F9' } }), laneName: 'Todo', runningOn: [] },
      ],
    });
    expect(root.querySelector('[data-section="children"] .fy-board-detail__count')?.textContent).toBe('1');
    expect(text(root, '[aria-label="Running on"]')).toBe('laptop: running 4.111.0');
    await click(root, '[data-kind="children"] button');
    expect(navigated).toEqual([`${daemonBoardPath(laptop.daemonId)}/F2`]);
  });
});

describe('BoardDetail — drawer, page and closing', () => {
  it('is a drawer on a wide screen and a page on a phone', async () => {
    const wide = await open();
    expect(wide.root.querySelector('.fy-board-detail__scrim')?.getAttribute('data-mode')).toBe('drawer');
    expect(wide.root.querySelector('aside')?.getAttribute('data-mode')).toBe('drawer');
    expect(text(wide.root, '.fy-board-detail__close')).toBe('');
    await view?.unmount();
    view = null;
    const narrow = await open({ phone: true });
    expect(narrow.root.querySelector('.fy-board-detail__scrim')?.getAttribute('data-mode')).toBe('page');
    expect(text(narrow.root, '.fy-board-detail__close')).toBe('Board');
  });

  it('closes from the close button, the backdrop and Escape', async () => {
    const { root, closed } = await open();
    await click(root, '[aria-label="Back to the Board"]');
    await click(root, '.fy-board-detail__backdrop');
    await interact(() => pressKey(must(root.querySelector('aside'), 'the card'), 'Escape'));
    expect(closed.count).toBe(3);
    await interact(() => pressKey(must(root.querySelector('aside'), 'the card'), 'a'));
    expect(closed.count).toBe(3);
  });

  it('closes when the card was not found too', async () => {
    const { root, closed } = await open({ task: null });
    await click(root, '.fy-board-detail__close');
    expect(closed.count).toBe(1);
  });
});

describe('BoardDetail — no owner buttons', () => {
  const tested = { laneId: 'tested', title: 'Try it' };

  it('draws no Done, Not good, Mark done or Reopen on a card, in any lane', async () => {
    for (const task of [
      card('F1', tested),
      card('F1', IMPLEMENT),
      card('F1', { laneId: 'closed', title: 'Done it' }),
      card('F1', { ...IMPLEMENT, dropped: DROPPED }),
    ]) {
      const { root } = await open({ task });
      expect(root.querySelector('.fy-board-done, [data-verdict], [aria-label="Your verdict"]')).toBeNull();
      expect(root.querySelector('.fy-board-detail__tools .kt-btn[data-variant="primary"]')).toBeNull();
      expect(root.querySelector('[role="menu"], [role="menuitem"]')).toBeNull();
      expect(/done|reopen|not good/iu.test(root.querySelector('.fy-board-detail__tools')?.textContent ?? '')).toBe(
        false,
      );
      await view?.unmount();
      view = null;
    }
  });

  it('keeps How to test as a plain reading aid above the brief: numbered steps, no verdict row under them', async () => {
    const { root } = await open({
      task: card('F1', {
        ...tested,
        howToTest: 'On the Mac, v4.157:\n\n1. Open the **Board**\n2. Tap &F1\n3. See the steps',
        brief: 'The plan',
      }),
    });
    const section = must(root.querySelector('[data-section="how-to-test"]'), 'How to test');
    expect(text(section, '.fy-board-detail__heading')).toBe('How to test');
    expect(text(section, '.fy-board-test__lead')).toBe('On the Mac, v4.157:');
    expect([...section.querySelectorAll('.fy-board-test__n')].map(n => n.textContent)).toEqual(['1', '2', '3']);
    expect(section.querySelector('.fy-board-test__step strong')?.textContent).toBe('Board');
    expect(section.nextElementSibling).toBe(root.querySelector('[data-section="brief"]'));
  });

  it('lets the owner tick the steps off as they read them, without moving the card', async () => {
    const { root } = await open({ task: card('F1', { ...tested, howToTest: '1. Open it\n2. Look' }) });
    const box = must(root.querySelector<HTMLInputElement>('[data-test-tick="1"]'), 'the second box');
    await interact(() => box.click());
    expect(box.checked).toBe(true);
    expect(root.querySelector('[data-test-tick="1"]')?.closest('li')?.hasAttribute('data-done')).toBe(true);
  });
});

describe('BoardDetail — copy link', () => {
  it('copies the link, and says when it cannot', async () => {
    const copied: string[] = [];
    const original = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard');
    const set = (value: unknown) =>
      Object.defineProperty(globalThis.navigator, 'clipboard', { value, configurable: true });
    try {
      const { root } = await open({ task: card('F1', IMPLEMENT) });
      set({ writeText: async (words: string) => void copied.push(words) });
      await clickNamed(root, 'Copy link');
      await interact(() => flush());
      expect(copied).toHaveLength(1);
      expect(text(root, '.fy-board-detail__notice')).toBe('Link copied.');
      set({ writeText: () => Promise.reject(new Error('denied')) });
      await clickNamed(root, 'Copy link');
      await interact(() => flush());
      expect(text(root, '.fy-board-detail__notice')).toBe('The link could not be copied.');
      set(undefined);
      await clickNamed(root, 'Copy link');
      expect(text(root, '.fy-board-detail__notice')).toBe('This browser cannot copy; the address bar has the link.');
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis.navigator, 'clipboard');
      else Object.defineProperty(globalThis.navigator, 'clipboard', original);
    }
  });
});

describe('BoardDetail — the header', () => {
  it('shows the first PR with its state, and the activity', async () => {
    const task = card('F1', {
      ...IMPLEMENT,
      links: {
        prs: [
          {
            repo: 'kirinnee/ferretry',
            number: 7,
            url: 'https://github.com/kirinnee/ferretry/pull/7',
            state: 'open',
            draft: false,
            checks: 'none',
            mergedAt: null,
            mergeSha: null,
            releasedIn: null,
            polledAt: '2026-08-01T09:30:00.000Z',
          },
        ],
        branch: null,
        commits: [],
        docs: [],
      },
    });
    const { root } = await open({ task });
    expect(text(root, '[data-meta="pr"]')).toContain('kirinnee/ferretry#7');
    expect(root.querySelector('[data-meta="pr"]')?.getAttribute('href')).toBe(
      'https://github.com/kirinnee/ferretry/pull/7',
    );
  });
});

describe('BoardDetail — chat', () => {
  it('opens the chat of the assignee, or of the owner when nobody is assigned', async () => {
    const owner = await open({ task: card('F1', IMPLEMENT) });
    await clickNamed(owner.root, 'Open chat');
    expect(owner.navigated).toEqual([daemonSessionPath(laptop.daemonId, LEAD)]);
    await view?.unmount();
    view = null;
    const assigned = await open({ task: card('F1', { ...IMPLEMENT, assignee: HELPER }) });
    await clickNamed(assigned.root, 'Open chat');
    expect(assigned.navigated).toEqual([daemonSessionPath(laptop.daemonId, HELPER)]);
  });
});

describe('BoardDetail — answering', () => {
  const waiting = { sessionId: LEAD, id: 'A1' };
  const blocked = (extra: Record<string, unknown> = {}) =>
    card('F1', { ...IMPLEMENT, waitingOnOwner: [waiting], openAsks: [waiting], ...extra });
  const item = agendaItem('A1', {
    title: 'Approve the plan?',
    raisedBySession: LEAD,
    ask: choices('Yes', 'No'),
  });

  it('lists the ask, and a row opens it AT the item in its ferret’s chat — never an answer here (#B76)', async () => {
    const { root, navigated } = await open({ task: blocked(), agendaItems: [item] });
    const section = must(root.querySelector('[data-section="asks"]'), 'the Agenda asks section');
    expect(section.querySelector('.fy-board-detail__count')?.textContent).toBe('1');
    expect(text(root, '[data-kind="asks"] [data-state="blocking"]')).toBe('Blocking · Approve the plan?');
    expect(section.querySelector('[data-agenda-quick-replies]')).toBeNull();
    await interact(() => must(section.querySelector<HTMLButtonElement>('[data-ask-open="A1"]'), 'the A1 row').click());
    expect(navigated).toEqual([agendaConversationPath(laptop.daemonId, LEAD, 'A1' as AgendaId)]);
  });

  it('still opens an ask the ferret agenda does not list, by its ref', async () => {
    const { root, navigated } = await open({ task: blocked(), agendaItems: [] });
    expect(text(root, '[data-section="asks"]')).toContain('A1 from');
    await interact(() => must(root.querySelector<HTMLButtonElement>('[data-ask-open="A1"]'), 'the A1 row').click());
    expect(navigated).toEqual([agendaConversationPath(laptop.daemonId, LEAD, 'A1' as AgendaId)]);
  });
});

describe('BoardDetail — read-only', () => {
  const REMOVED = [
    '[data-pill="lane"][aria-haspopup]',
    'button[aria-label="More actions"]',
    '[role="menu"]',
    '[role="dialog"]',
    '[data-form="comment"], .fy-board-detail__composer, textarea',
    '[data-action="add-dependency"], [aria-label="Card it waits for"]',
    '.fy-board-chip__x, [aria-label^="Stop waiting for"]',
    '[data-form="reparent"]',
    '.fy-board-detail__foot',
  ].join(', ');

  it('has no lane dropdown, no more-actions menu, no dependency control and no comment box on any card', async () => {
    const dep = { task: { id: 'F9' }, until: 'shipped' as const };
    const tasks = [
      card('F1', IMPLEMENT),
      card('F1', { laneId: 'tested', title: 'Try it' }),
      card('F1', { laneId: 'closed', title: 'Closed one' }),
      card('F1', { ...IMPLEMENT, dropped: DROPPED }),
      card('F1', { ...IMPLEMENT, dependsOn: [dep], blockedBy: [{ id: 'F9' }], blocks: [{ id: 'F3' }] }),
    ];
    for (const task of tasks) {
      const { root } = await open({ task });
      expect(root.querySelector(REMOVED)).toBeNull();
      expect(root.textContent).not.toMatch(/Add dependency|Comment to|Reparent|Move to…|Drop…/u);
      await view?.unmount();
      view = null;
    }
  });

  it('shows what a card depends on and blocks as chips that open the other card, with no remove button', async () => {
    const dep = { task: { id: 'F9' }, until: 'shipped' as const };
    const { root, navigated } = await open({
      task: card('F1', { ...IMPLEMENT, dependsOn: [dep], blockedBy: [{ id: 'F9' }], blocks: [{ id: 'F3' }] }),
    });
    const chips = [...root.querySelectorAll<HTMLButtonElement>('.fy-board-chip__open')];
    expect(chips.map(chip => chip.textContent)).toEqual(['&F9 · until shipped', '&F3']);
    expect(root.querySelector('.fy-board-chip__x')).toBeNull();
    await interact(() => must(chips[0], 'the first chip').click());
    expect(navigated).toEqual([`${daemonBoardPath(laptop.daemonId)}/F9`]);
  });

  it('says a card waits on nothing in one quiet line', async () => {
    const { root } = await open({ task: card('F1', IMPLEMENT) });
    expect(text(root, '[data-section="depends"] [data-kind="no-dependencies"]')).toBe('Nothing.');
  });

  it('keeps Open chat and Copy link, the only buttons in its header', async () => {
    const { root } = await open({ task: card('F1', IMPLEMENT) });
    expect(
      [...root.querySelectorAll('.fy-board-detail__tools button')].map(button => button.textContent?.trim()),
    ).toEqual(['Open chat', 'Copy link']);
  });
});
