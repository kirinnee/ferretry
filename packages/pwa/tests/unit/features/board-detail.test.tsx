import { afterEach, describe, expect, it } from 'bun:test';
import { type AgendaId, boardOk } from '@ferretry/protocol';
import { BoardDetail } from '../../../src/features/board/detail/board-detail.tsx';
import { agendaConversationPath } from '../../../src/lib/agenda-inbox.ts';
import { daemonBoardPath, daemonSessionPath } from '../../../src/lib/pages/routes.ts';
import { agendaItem, choices } from '../../support/agenda-inbox.tsx';
import { interact, type Mounted, mount, must, pressKey } from '../../support/dom.ts';
import { card, deferred, flush, laptop } from '../board-support.ts';
import {
  buttonNamed,
  click,
  clickNamed,
  type DetailHarness,
  type DetailOptions,
  detailProps,
  fakeActions,
  fill,
  fillLabelled,
  HELPER,
  LEAD,
  refusal,
  submit,
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

const menuItem = (root: HTMLElement, name: string): HTMLButtonElement =>
  must(
    [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent?.startsWith(name)),
    `the "${name}" menu item`,
  );
const pickLane = async (root: HTMLElement, name: string): Promise<void> => {
  await click(root, '[data-pill="lane"]');
  await interact(() => menuItem(root, name).click());
};
const MORE = 'button[aria-label="More actions"]';
const moreItem = async (root: HTMLElement, name: string): Promise<void> => {
  await click(root, MORE);
  await interact(() => menuItem(root, name).click());
};
const reasonBox = (root: HTMLElement): HTMLElement => must(root.querySelector('[role="dialog"]'), 'the reason box');
const reasonSubmit = async (root: HTMLElement, reason: string): Promise<void> => {
  const box = reasonBox(root);
  await fill(must(box.querySelector<HTMLInputElement>('[aria-label="Reason"]'), 'the reason input'), reason);
  await submit(box);
  await interact(() => flush());
};
const comment = async (root: HTMLElement, name: string, words: string): Promise<void> => {
  await fillLabelled(root, `Comment to ${name}`, words);
  await submit(must(root.querySelector('[data-form="comment"]'), 'the comment form'));
  await interact(() => flush());
};
const addDependency = async (root: HTMLElement): Promise<void> => {
  if (root.querySelector('[aria-label="Card it waits for"]') === null)
    await click(root, '[data-action="add-dependency"]');
};
const dependOn = async (root: HTMLElement, target: string): Promise<void> => {
  await addDependency(root);
  await fillLabelled(root, 'Card it waits for', target);
  await submit(must(buttonNamed(root, 'Depend').closest('form'), 'the depend form'));
  await interact(() => flush());
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

  it('shows a dropped card as dropped, with no verdict, move or drop', async () => {
    const { root } = await open({ task: card('F1', { laneId: 'tested', title: 'Try it', dropped: DROPPED }) });
    expect(text(root, '[data-state="dropped"]')).toBe('Dropped: obsolete');
    expect(root.querySelector('[aria-label="Your verdict"]')).toBeNull();
    expect(root.querySelector('[data-pill="lane"]')?.hasAttribute('data-static')).toBe(true);
    await click(root, MORE);
    expect([...root.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual([
      'Reparent…',
      'Copy link',
    ]);
  });

  it('offers no move on a closed card or one on a project without lanes', async () => {
    const closed = await open({ task: card('F1', { laneId: 'closed' }) });
    expect(closed.root.querySelector('[data-pill="lane"]')?.hasAttribute('data-static')).toBe(true);
    await click(closed.root, MORE);
    expect(closed.root.textContent).not.toContain('Move to…');
    await view?.unmount();
    view = null;
    const bare = await open({ task: card('F1', IMPLEMENT), laneSet: null });
    expect(bare.root.querySelector('[data-pill="lane"]')?.hasAttribute('data-static')).toBe(true);
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

describe('BoardDetail — moving', () => {
  it('sends a forward move at once', async () => {
    const { root, actions } = await open({ task: card('F1', IMPLEMENT) });
    await click(root, '[data-pill="lane"]');
    expect([...root.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual([
      'Todo (needs a reason)',
      'Plan/Design (needs a reason)',
      'Review/CI',
      'Merged',
      'Released',
      'To test',
      'Closed',
    ]);
    expect(menuItem(root, 'Todo').hasAttribute('data-backward')).toBe(true);
    expect(menuItem(root, 'Review/CI').hasAttribute('data-backward')).toBe(false);
    await interact(() => menuItem(root, 'Review/CI').click());
    await interact(() => flush());
    expect(actions.calls).toEqual(['moveTask:["review"]']);
    expect(root.querySelector('[role="menu"]')).toBeNull();
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  it('asks why before a move back, and sends the words with it', async () => {
    const { root, actions } = await open({ task: card('F1', IMPLEMENT) });
    await pickLane(root, 'Plan/Design');
    expect(actions.calls).toEqual([]);
    expect(text(reasonBox(root), '.fy-board-reason__heading')).toBe('Move Build it back to Plan/Design');
    expect(buttonNamed(reasonBox(root), 'Move back').disabled).toBe(true);
    await reasonSubmit(root, 'wrong plan');
    expect(actions.calls).toEqual(['moveTask:["plan","wrong plan"]']);
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps the reason box open with the daemon words when the move back is refused', async () => {
    const actions = fakeActions({ moveTask: async () => refusal('the plan lane is owner only', 'owner-gate') });
    const { root } = await open({ task: card('F1', IMPLEMENT), actions });
    await pickLane(root, 'Todo');
    await reasonSubmit(root, 'start over');
    expect(text(reasonBox(root), '[role="alert"]')).toBe('the plan lane is owner only');
    expect(reasonBox(root).querySelector('[aria-label="Reason"]')?.getAttribute('aria-invalid')).toBe('true');
  });

  it('shows the refusal of a forward move beside the comment box, where the owner is looking', async () => {
    const actions = fakeActions({ moveTask: async () => refusal('blocked by &F2', null) });
    const { root } = await open({ task: card('F1', IMPLEMENT), actions });
    await pickLane(root, 'Review/CI');
    expect(text(root, '.fy-board-detail__foot [data-problem]')).toBe('blocked by &F2');
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  it('shows a notice instead of sending when the plan is refused', async () => {
    const { root, actions } = await open({ task: card('F1', { laneId: 'ghost' }) });
    await pickLane(root, 'Review/CI');
    expect(actions.calls).toEqual([]);
    expect(text(root, '.fy-board-detail__notice')).toBe("Lane ghost is not on this project's board.");
  });

  it('cancels the reason box with Cancel and with Escape, without closing the card', async () => {
    const { root, closed, actions } = await open({ task: card('F1', IMPLEMENT) });
    await pickLane(root, 'Todo');
    await clickNamed(reasonBox(root), 'Cancel');
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    await pickLane(root, 'Todo');
    await interact(() =>
      pressKey(must(reasonBox(root).querySelector('[aria-label="Reason"]'), 'the reason input'), 'Escape'),
    );
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(closed.count).toBe(0);
    expect(actions.calls).toEqual([]);
  });

  it('holds the box while the move is on its way', async () => {
    const pending = deferred<unknown>();
    const actions = fakeActions({ moveTask: () => pending.promise });
    const { root } = await open({ task: card('F1', IMPLEMENT), actions });
    await pickLane(root, 'Todo');
    await fill(must(reasonBox(root).querySelector<HTMLTextAreaElement>('[aria-label="Reason"]'), 'the input'), 'why');
    await submit(reasonBox(root));
    expect(buttonNamed(reasonBox(root), 'Moving…').disabled).toBe(true);
    pending.resolve(refusal('too late'));
    await interact(() => flush());
    expect(text(reasonBox(root), '[role="alert"]')).toBe('too late');
  });
});

describe('BoardDetail — the verdict', () => {
  const tested = { laneId: 'tested', title: 'Try it' };

  it("offers Done and Not good → the last working lane on a card to try, in the board's own words", async () => {
    const { root } = await open({ task: card('F1', tested) });
    expect(text(root, '[data-verdict="works"]')).toBe('Done');
    expect(root.querySelector('[data-verdict="works"]')?.getAttribute('title')).toBe('Mark Try it done and close it');
    expect(text(root, '[data-verdict="not-good"]')).toBe('Not good');
    expect(root.querySelector('[data-verdict="not-good"]')?.getAttribute('title')).toBe(
      'Not good → back to Implement, with a reason',
    );
    expect(root.querySelectorAll('[data-verdict] svg')).toHaveLength(2);
  });

  it('puts How to test as numbered steps right above Done and Not good', async () => {
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
    const verdict = must(root.querySelector('[aria-label="Your verdict"]'), 'the verdict');
    expect(section.nextElementSibling).toBe(verdict);
    const brief = must(root.querySelector('[data-section="brief"]'), 'the brief');
    expect(verdict.compareDocumentPosition(brief) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('lets the owner tick the steps off as they test, without moving the card', async () => {
    const { root, actions } = await open({ task: card('F1', { ...tested, howToTest: '1. Open it\n2. Look' }) });
    const box = must(root.querySelector<HTMLInputElement>('[data-test-tick="1"]'), 'the second box');
    await interact(() => box.click());
    expect(box.checked).toBe(true);
    expect(root.querySelector('[data-test-tick="1"]')?.closest('li')?.hasAttribute('data-done')).toBe(true);
    expect(actions.calls).toEqual([]);
  });

  it('closes the card with Works, with no words asked', async () => {
    const { root, actions } = await open({ task: card('F1', tested) });
    await click(root, '[data-verdict="works"]');
    await interact(() => flush());
    expect(actions.calls).toEqual(['moveTask:["closed"]']);
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  it('asks what is not good, and sends the card back with those words', async () => {
    const { root, actions } = await open({ task: card('F1', tested) });
    await click(root, '[data-verdict="not-good"]');
    expect(text(reasonBox(root), '.fy-board-reason__heading')).toBe('Not good: send Try it back to Implement');
    expect(reasonBox(root).querySelector('[aria-label="Reason"]')?.getAttribute('placeholder')).toBe(
      'What is not good? The ferret reads this.',
    );
    await reasonSubmit(root, 'it crashes on phones');
    expect(actions.calls).toEqual(['moveTask:["implement","it crashes on phones"]']);
  });

  it('leaves the card where it is when the daemon refuses Not good', async () => {
    const actions = fakeActions({ moveTask: async () => refusal('no') });
    const { root } = await open({ task: card('F1', tested), actions });
    await click(root, '[data-verdict="not-good"]');
    await reasonSubmit(root, 'it crashes');
    expect(text(reasonBox(root), '[role="alert"]')).toBe('no');
  });

  it('is not offered on a card that is not waiting to be tried', async () => {
    const { root } = await open({ task: card('F1', IMPLEMENT) });
    expect(root.querySelector('[aria-label="Your verdict"]')).toBeNull();
  });
});

describe('BoardDetail — Mark done', () => {
  it('closes an open card in one tap with a clear primary Mark done', async () => {
    const { root, actions } = await open({ task: card('F1', IMPLEMENT) });
    const button = must(root.querySelector<HTMLButtonElement>('.fy-board-detail__tools .fy-board-done'), 'Mark done');
    expect(button.textContent).toBe('Mark done');
    expect(button.getAttribute('data-size')).toBe('primary');
    await interact(() => button.click());
    await interact(() => flush());
    expect(actions.calls).toEqual(['moveTask:["closed"]']);
  });

  it('is left to the verdict Done on a card to try, and is not offered on a dropped card', async () => {
    const tested = await open({ task: card('F1', { laneId: 'tested', title: 'Try it' }) });
    expect(tested.root.querySelector('.fy-board-done')).toBeNull();
    await view?.unmount();
    view = null;
    const dropped = await open({
      task: card('F2', { ...IMPLEMENT, dropped: DROPPED }),
    });
    expect(dropped.root.querySelector('.fy-board-done')).toBeNull();
  });

  it('offers Reopen on a closed card and asks why before sending it back', async () => {
    const { root, actions } = await open({ task: card('F1', { laneId: 'closed', title: 'Done it' }) });
    const button = must(root.querySelector<HTMLButtonElement>('.fy-board-detail__tools .fy-board-done'), 'Reopen');
    expect(button.getAttribute('data-done')).toBe('reopen');
    await interact(() => button.click());
    expect(actions.calls).toEqual([]);
    await reasonSubmit(root, 'it came back');
    expect(actions.calls).toEqual(['moveTask:["implement","it came back"]']);
  });
});

describe('BoardDetail — dropping', () => {
  it('asks why and drops the card with the words', async () => {
    const { root, actions } = await open({ task: card('F1', IMPLEMENT) });
    await moreItem(root, 'Drop');
    expect(text(reasonBox(root), '.fy-board-reason__heading')).toBe('Drop Build it');
    expect(reasonBox(root).querySelector('input')?.getAttribute('placeholder')).toBe('Why is it being dropped?');
    expect(buttonNamed(reasonBox(root), 'Drop it')).not.toBeNull();
    await reasonSubmit(root, 'superseded by &F9');
    expect(actions.calls).toEqual(['drop:["superseded by &F9"]']);
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps the box with the daemon words when the drop is refused', async () => {
    const actions = fakeActions({ drop: async () => refusal('only the owner may drop', 'owner-gate') });
    const { root } = await open({ task: card('F1', IMPLEMENT), actions });
    await moreItem(root, 'Drop');
    await reasonSubmit(root, 'gone');
    expect(text(reasonBox(root), '[role="alert"]')).toBe('only the owner may drop');
  });
});

describe('BoardDetail — dependencies', () => {
  it('depends on a card until it ships, and clears the field', async () => {
    const { root, actions } = await open({ task: card('F1', IMPLEMENT) });
    expect(root.querySelector('[aria-label="Card it waits for"]')).toBeNull();
    expect(text(root, '[data-section="depends"]')).toContain('Nothing.');
    await dependOn(root, '&F2');
    expect(actions.calls).toEqual([`depend:${JSON.stringify([{ task: { id: 'F2' }, until: 'shipped' }])}`]);
    expect(root.querySelector<HTMLInputElement>('[aria-label="Card it waits for"]')?.value).toBe('');
  });

  it('can wait for a release instead', async () => {
    const { root, actions } = await open({ task: card('F1', IMPLEMENT) });
    await addDependency(root);
    await fillLabelled(root, 'Until', 'released');
    await dependOn(root, '&F2');
    expect(actions.calls[0]).toContain('"until":"released"');
    await fillLabelled(root, 'Until', 'whatever');
    expect(root.querySelector<HTMLSelectElement>('[aria-label="Until"]')?.value).toBe('shipped');
  });

  it('asks for a card when the field is empty and says what is not a card id', async () => {
    const { root, actions } = await open({ task: card('F1', IMPLEMENT) });
    await dependOn(root, '  ');
    expect(text(root, '[data-section="depends"] [role="alert"]')).toBe('Name the card it waits for, like &F412.');
    await dependOn(root, 'banana');
    expect(text(root, '[data-section="depends"] [role="alert"]')).toBe('banana is not a card id.');
    expect(actions.calls).toEqual([]);
  });

  it('keeps the words and says so when the daemon refuses the dependency', async () => {
    const actions = fakeActions({ depend: async () => refusal('that would make a cycle') });
    const { root } = await open({ task: card('F1', IMPLEMENT), actions });
    await dependOn(root, '&F2');
    expect(text(root, '[data-section="depends"] [role="alert"]')).toBe('The daemon refused that dependency.');
    expect(root.querySelector<HTMLInputElement>('[aria-label="Card it waits for"]')?.value).toBe('&F2');
  });

  it('stops waiting for a card once the owner says why', async () => {
    const task = card('F1', {
      ...IMPLEMENT,
      dependsOn: [{ task: { id: 'F2' }, until: 'shipped' }],
      blockedBy: [{ id: 'F2' }],
    });
    const { root, actions } = await open({ task });
    await click(root, '[aria-label="Stop waiting for &F2"]');
    expect(text(reasonBox(root), '.fy-board-reason__heading')).toBe('Stop Build it waiting for &F2');
    expect(buttonNamed(reasonBox(root), 'Stop waiting')).not.toBeNull();
    await reasonSubmit(root, 'it shipped');
    expect(actions.calls).toEqual([`undepend:${JSON.stringify([{ id: 'F2' }, 'it shipped'])}`]);
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps the box with the daemon words when it cannot stop waiting', async () => {
    const actions = fakeActions({ undepend: async () => refusal('not a dependency') });
    const task = card('F1', { ...IMPLEMENT, dependsOn: [{ task: { id: 'F2' }, until: 'shipped' }] });
    const { root } = await open({ task, actions });
    await click(root, '[aria-label="Stop waiting for &F2"]');
    await reasonSubmit(root, 'whim');
    expect(text(reasonBox(root), '[role="alert"]')).toBe('not a dependency');
  });

  it('opens a card it depends on or blocks', async () => {
    const task = card('F1', {
      ...IMPLEMENT,
      dependsOn: [{ task: { id: 'F2' }, until: 'shipped' }],
      blocks: [{ id: 'F9' }],
    });
    const { root, navigated } = await open({ task });
    await click(root, '[aria-label="Depends on"] .fy-board-chip__open');
    await click(root, '[aria-label="Blocks"] .fy-board-chip__open');
    expect(navigated).toEqual([`${daemonBoardPath(laptop.daemonId)}/F2`, `${daemonBoardPath(laptop.daemonId)}/F9`]);
  });
});

describe('BoardDetail — commenting', () => {
  it('sends the words tagged with the card to the owner when nobody is assigned, then notes it', async () => {
    const { root, actions, sent } = await open({ task: card('F1', IMPLEMENT) });
    expect(root.querySelector('[data-form="comment"] button')?.hasAttribute('disabled')).toBe(true);
    expect(root.querySelector('[data-form="comment"] textarea')?.getAttribute('placeholder')).toBe(
      'Comment to Denisha…',
    );
    await comment(root, 'Denisha', '  please add tests ');
    expect(sent).toEqual([{ sessionId: LEAD, message: '[re &F1] please add tests' }]);
    expect(actions.calls).toEqual(['note:["please add tests"]']);
    expect(text(root, '.fy-board-detail__foot .fy-board-detail__notice')).toBe('Sent to Denisha.');
    expect(root.querySelector<HTMLTextAreaElement>('[data-form="comment"] textarea')?.value).toBe('');
  });

  it('sends on Enter, keeps Shift+Enter for a new line, and ignores Enter on an empty box', async () => {
    const { root, sent } = await open({ task: card('F1', IMPLEMENT) });
    const box = must(root.querySelector<HTMLTextAreaElement>('[data-form="comment"] textarea'), 'the comment box');
    await interact(() => pressKey(box, 'Enter'));
    expect(sent).toEqual([]);
    await fill(box, 'ship it');
    await interact(() => pressKey(box, 'Enter', { shiftKey: true }));
    expect(sent).toEqual([]);
    await interact(() => pressKey(box, 'Enter'));
    await interact(() => flush());
    expect(sent).toEqual([{ sessionId: LEAD, message: '[re &F1] ship it' }]);
  });

  it('speaks to the assignee when there is one', async () => {
    const { root, sent } = await open({ task: card('F1', { ...IMPLEMENT, assignee: HELPER }) });
    await comment(root, 'mvudnu', 'hello');
    expect(sent).toEqual([{ sessionId: HELPER, message: '[re &F1] hello' }]);
    expect(text(root, '.fy-board-detail__notice')).toBe('Sent to mvudnu.');
  });

  it('does nothing for words that are only space', async () => {
    const { root, sent } = await open({ task: card('F1', IMPLEMENT) });
    await comment(root, 'Denisha', '   ');
    expect(sent).toEqual([]);
  });

  it('says the message did not go, and does not note it, when the ferret cannot be reached', async () => {
    const { root, actions } = await open({
      task: card('F1', IMPLEMENT),
      sendMessage: async () => {
        throw new Error('the ferret is not running');
      },
    });
    await comment(root, 'Denisha', 'hello');
    expect(text(root, '[data-form="comment"] [role="alert"]')).toBe('the ferret is not running');
    expect(actions.calls).toEqual([]);
    expect(root.querySelector<HTMLTextAreaElement>('[data-form="comment"] textarea')?.value).toBe('hello');
  });

  it('says so in words of its own when the failure carries none', async () => {
    const { root } = await open({
      task: card('F1', IMPLEMENT),
      sendMessage: () => Promise.reject('gone'),
    });
    await comment(root, 'Denisha', 'hello');
    expect(text(root, '[data-form="comment"] [role="alert"]')).toBe('The message did not go through.');
  });

  it('says the ferret was told but the note was refused', async () => {
    const actions = fakeActions({ note: async () => refusal('history is full') });
    const { root, sent } = await open({ task: card('F1', IMPLEMENT), actions });
    await comment(root, 'Denisha', 'hello');
    expect(sent).toHaveLength(1);
    expect(text(root, '.fy-board-detail__notice')).toBe('Sent to Denisha, but not noted: history is full');
  });
});

describe('BoardDetail — the more-actions menu', () => {
  it('lists Move to…, Reparent…, Drop… and Copy link, and Move to… opens the lane menu', async () => {
    const { root } = await open({ task: card('F1', IMPLEMENT) });
    await click(root, MORE);
    expect([...root.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual([
      'Move to…',
      'Reparent…',
      'Drop…',
      'Copy link',
    ]);
    await interact(() => menuItem(root, 'Move to…').click());
    expect(menuItem(root, 'Review/CI')).not.toBeNull();
  });

  it('closes when the button is pressed again', async () => {
    const { root } = await open({ task: card('F1', IMPLEMENT) });
    await click(root, MORE);
    await click(root, MORE);
    expect(root.querySelector('[role="menu"]')).toBeNull();
    await click(root, '[data-pill="lane"]');
    await click(root, '[data-pill="lane"]');
    expect(root.querySelector('[role="menu"]')).toBeNull();
  });

  it('puts the card under another card, or at the top level', async () => {
    const { root, actions } = await open({ task: card('F1', IMPLEMENT) });
    await moreItem(root, 'Reparent');
    const form = must(root.querySelector('[data-form="reparent"]'), 'the reparent form');
    await fillLabelled(root, 'Parent card', 'banana');
    await submit(form);
    expect(text(form, '[role="alert"]')).toBe('banana is not a card id.');
    await fillLabelled(root, 'Parent card', '&F9');
    await submit(form);
    await interact(() => flush());
    expect(actions.calls).toEqual([`reparent:${JSON.stringify([{ id: 'F9' }])}`]);
    expect(text(root, '.fy-board-detail__notice')).toBe('Moved under &F9.');
    expect(root.querySelector('[data-form="reparent"]')).toBeNull();
    await moreItem(root, 'Reparent');
    await submit(must(root.querySelector('[data-form="reparent"]'), 'the reparent form'));
    await interact(() => flush());
    expect(actions.calls[1]).toBe('reparent:[null]');
    expect(text(root, '.fy-board-detail__notice')).toBe('Now a top-level card.');
  });

  it('keeps the reparent form with the daemon words when it is refused, and cancels', async () => {
    const actions = fakeActions({ reparent: async () => refusal('that would make a cycle') });
    const { root } = await open({ task: card('F1', IMPLEMENT), actions });
    await moreItem(root, 'Reparent');
    await fillLabelled(root, 'Parent card', '&F9');
    await submit(must(root.querySelector('[data-form="reparent"]'), 'the reparent form'));
    await interact(() => flush());
    expect(text(root, '[data-form="reparent"] [role="alert"]')).toBe('that would make a cycle');
    await clickNamed(must(root.querySelector('[data-form="reparent"]'), 'the reparent form'), 'Cancel');
    expect(root.querySelector('[data-form="reparent"]')).toBeNull();
  });

  it('copies the link, and says when it cannot', async () => {
    const copied: string[] = [];
    const original = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard');
    const set = (value: unknown) =>
      Object.defineProperty(globalThis.navigator, 'clipboard', { value, configurable: true });
    try {
      const { root } = await open({ task: card('F1', IMPLEMENT) });
      set({ writeText: async (words: string) => void copied.push(words) });
      await moreItem(root, 'Copy link');
      await interact(() => flush());
      expect(copied).toHaveLength(1);
      expect(text(root, '.fy-board-detail__notice')).toBe('Link copied.');
      set({ writeText: () => Promise.reject(new Error('denied')) });
      await moreItem(root, 'Copy link');
      await interact(() => flush());
      expect(text(root, '.fy-board-detail__notice')).toBe('The link could not be copied.');
      set(undefined);
      await moreItem(root, 'Copy link');
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
    const { root, navigated, actions } = await open({ task: blocked(), agendaItems: [item] });
    const section = must(root.querySelector('[data-section="asks"]'), 'the Agenda asks section');
    expect(section.querySelector('.fy-board-detail__count')?.textContent).toBe('1');
    expect(text(root, '[data-kind="asks"] [data-state="blocking"]')).toBe('Blocking · Approve the plan?');
    expect(section.querySelector('[data-agenda-quick-replies]')).toBeNull();
    await interact(() => must(section.querySelector<HTMLButtonElement>('[data-ask-open="A1"]'), 'the A1 row').click());
    expect(navigated).toEqual([agendaConversationPath(laptop.daemonId, LEAD, 'A1' as AgendaId)]);
    expect(actions.calls.filter(call => call.startsWith('answer:'))).toEqual([]);
  });

  it('still opens an ask the ferret agenda does not list, by its ref', async () => {
    const { root, navigated } = await open({ task: blocked(), agendaItems: [] });
    expect(text(root, '[data-section="asks"]')).toContain('A1 from');
    await interact(() => must(root.querySelector<HTMLButtonElement>('[data-ask-open="A1"]'), 'the A1 row').click());
    expect(navigated).toEqual([agendaConversationPath(laptop.daemonId, LEAD, 'A1' as AgendaId)]);
  });
});

describe('BoardDetail — an answer in flight', () => {
  const tested = { laneId: 'tested', title: 'Try it' };

  it('spins the pressed answer and holds the other until the move settles', async () => {
    const pending = deferred<unknown>();
    const actions = fakeActions({ moveTask: () => pending.promise });
    const { root } = await open({ task: card('F1', tested), actions });
    await click(root, '[data-verdict="works"]');
    const works = must(root.querySelector<HTMLButtonElement>('[data-verdict="works"]'), 'Works');
    expect(works.hasAttribute('data-pending')).toBe(true);
    expect(works.getAttribute('aria-busy')).toBe('true');
    expect(works.querySelector('[data-spinner]')).not.toBeNull();
    expect(works.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('[data-verdict="not-good"]')?.disabled).toBe(true);
    await interact(() => works.click());
    expect(actions.calls).toEqual(['moveTask:["closed"]']);
    pending.resolve(boardOk(card('F1', { laneId: 'closed' })));
    await interact(() => flush());
    expect(root.querySelector('[data-pending]')).toBeNull();
  });

  it('spins Mark done while it closes, and says a refusal beside it', async () => {
    const pending = deferred<unknown>();
    let tries = 0;
    // The first close is refused; the second is held on its way.
    const actions = fakeActions({ moveTask: () => (tries++ === 0 ? pending.promise : new Promise(() => undefined)) });
    const { root } = await open({ task: card('F1', IMPLEMENT), actions });
    await click(root, '.fy-board-detail__tools .fy-board-done');
    expect(root.querySelector('.fy-board-detail__tools .fy-board-done [data-spinner]')).not.toBeNull();
    pending.resolve(refusal('only the owner closes', 'owner-gate'));
    await interact(() => flush());
    expect(text(root, '[data-answer-error]')).toBe('only the owner closes');
    expect(root.querySelector('.fy-board-detail__foot [data-problem]')).toBeNull();
    // The next answer starts clean.
    await click(root, '.fy-board-detail__tools .fy-board-done');
    expect(root.querySelector('[data-answer-error]')).toBeNull();
  });

  it("sends Not good's pictures from the card's ferret with the words", async () => {
    const uploads: string[] = [];
    const { root, actions } = await open({
      task: card('F1', { ...tested, assignee: 'child-1' }),
      sendBackFiles: true,
      uploads,
    });
    await click(root, '[data-verdict="not-good"]');
    await interact(() => flush());
    const picker = must(root.querySelector<HTMLInputElement>('[data-send-back-picker]'), 'the picker');
    Object.defineProperty(picker, 'files', {
      configurable: true,
      value: [new File(['png'], 'a.png', { type: 'image/png' })],
    });
    await interact(() => picker.dispatchEvent(new Event('change', { bubbles: true })));
    await interact(() => flush());
    expect(uploads).toEqual(['child-1:a.png']);
    await reasonSubmit(root, 'it crashes');
    expect(actions.calls).toEqual([
      `moveTask:["implement","it crashes",{"from":"child-1","ids":["att_${'a'.repeat(64)}"]}]`,
    ]);
  });

  it('sends a move back with no pictures as the words alone, even where the machine takes them', async () => {
    const { root, actions } = await open({ task: card('F1', IMPLEMENT), sendBackFiles: true });
    await pickLane(root, 'Plan/Design');
    await interact(() => flush());
    expect(root.querySelector('[data-send-back-picker]')).not.toBeNull();
    await reasonSubmit(root, 'wrong plan');
    expect(actions.calls).toEqual(['moveTask:["plan","wrong plan"]']);
  });
});

describe('BoardDetail — the one-line boxes', () => {
  it('cancels the drop box without dropping', async () => {
    const { root, actions } = await open({ task: card('F1', IMPLEMENT) });
    await moreItem(root, 'Drop');
    expect(root.querySelector('[data-board-send-back]')).toBeNull();
    await clickNamed(reasonBox(root), 'Cancel');
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(actions.calls).toEqual([]);
  });
});
