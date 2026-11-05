import { afterEach, describe, expect, it } from 'bun:test';
import { BoardCard } from '../../../src/features/board/board-card.tsx';
import { BoardLane } from '../../../src/features/board/board-lane.tsx';
import { ferretNamer } from '../../../src/lib/board-present.ts';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
import { boardModelOf, card } from '../board-support.ts';

const NOW = Date.parse('2026-08-01T10:04:00.000Z');
const names = ferretNamer(new Map([['mvuc7tsf-0c3d50df', 'denisha']]));

let view: Mounted | null = null;
const release = async (): Promise<void> => {
  await view?.unmount();
  view = null;
};
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const cardOf = async (extra: Record<string, unknown> = {}) => {
  const model = await boardModelOf([card('F412', { title: 'Wire the board page', ...extra })]);
  return must(model.cards[0], 'a card');
};

const draw = async (props: Partial<Parameters<typeof BoardCard>[0]> = {}) => {
  const task = await cardOf();
  view = await mount(
    <ul>
      <BoardCard
        card={task}
        category="review"
        density="page"
        href="/d/laptop/board/F412"
        names={names}
        now={NOW}
        showMachine={false}
        {...props}
      />
    </ul>,
  );
  return view.container;
};

describe('BoardCard', () => {
  it('draws the title and one meta line of segments', async () => {
    const root = await draw();
    expect(root.querySelector('.fy-board-card__title')?.textContent).toBe('Wire the board page');
    const segments = [...root.querySelectorAll('.fy-board-seg')].map(node => node.getAttribute('data-seg'));
    expect(segments).toEqual(['ref', 'activity', 'people']);
    expect(root.querySelector('[data-seg="ref"]')?.textContent).toBe('&F412');
    const li = must(root.querySelector('li'), 'the card');
    expect(li.dataset.activity).toBe('active');
    expect(li.dataset.category).toBe('review');
    expect(li.dataset.density).toBe('page');
    expect(li.dataset.task).toBe('F412');
  });

  it('draws the summary as one line under the title, and How to test as a marker', async () => {
    const task = await cardOf({ summary: 'Cards say how to test them', howToTest: '1. Open it' });
    view = await mount(
      <ul>
        <BoardCard card={task} category="verify" density="page" href="/x" names={names} now={NOW} showMachine={false} />
      </ul>,
    );
    const root = view.container;
    expect(root.querySelector('.fy-board-card__title')?.nextElementSibling?.className).toBe('fy-board-card__summary');
    expect(root.querySelector('.fy-board-card__summary')?.textContent).toBe('Cards say how to test them');
    expect(root.querySelector('[data-seg="test"]')?.textContent).toBe('How to test');
  });

  it('says quietly when a card to test has no test steps, and leaves the summary out of the side density', async () => {
    const task = await cardOf({ summary: 'Cards say how to test them' });
    view = await mount(
      <ul>
        <BoardCard card={task} category="verify" density="side" href="/x" names={names} now={NOW} showMachine={false} />
      </ul>,
    );
    const root = view.container;
    expect(root.querySelector('.fy-board-card__summary')).toBeNull();
    expect(root.querySelector('[data-seg="test"]')?.textContent).toBe('no test steps');
    expect(root.querySelector('[data-seg="test"]')?.getAttribute('data-tone')).toBe('quiet');
  });

  it('keeps one short line in the side density, without the optional segments', async () => {
    const root = await draw({ density: 'side', showMachine: true });
    expect([...root.querySelectorAll('.fy-board-seg')].map(node => node.getAttribute('data-seg'))).toEqual([
      'ref',
      'activity',
    ]);
    expect(must(root.querySelector('li'), 'the card').dataset.density).toBe('side');
  });

  it('adds the machine only when several are on the board, and the lane and depth when asked', async () => {
    const root = await draw({ showMachine: true, lane: 'Review/CI', depth: 2 });
    expect([...root.querySelectorAll('.fy-board-seg')].map(node => node.getAttribute('data-seg'))).toEqual([
      'lane',
      'ref',
      'activity',
      'people',
      'machine',
    ]);
    const li = must(root.querySelector('li'), 'the card');
    expect(li.dataset.depth).toBe('2');
    expect(li.style.getPropertyValue('--fy-board-depth')).toBe('2');
  });

  it('uses the summary in the tooltip when there is one', async () => {
    const withSummary = await cardOf({ summary: 'the long story' });
    const root = await draw({ card: withSummary });
    expect(root.querySelector('a')?.getAttribute('title')).toBe('Wire the board page — the long story');
    await release();
    const plain = await draw();
    expect(plain.querySelector('a')?.getAttribute('title')).toBe('Wire the board page');
  });

  it('is a link to its detail that navigates in the app on a plain click', async () => {
    const seen: string[] = [];
    const root = await draw({ onNavigate: to => void seen.push(to) });
    const link = must(root.querySelector('a'), 'the link');
    expect(link.getAttribute('href')).toBe('/d/laptop/board/F412');
    await interact(() => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
    expect(seen).toEqual(['/d/laptop/board/F412']);
  });

  it('is read-only: not draggable, no lane menu, and no owner button on any card in any lane or density', async () => {
    for (const category of ['verify', 'shipped', 'closed', 'review'] as const) {
      for (const density of ['page', 'side'] as const) {
        const root = await draw({ category, density, touch: category === 'verify' });
        expect(must(root.querySelector('li'), 'the card').hasAttribute('draggable')).toBe(false);
        expect(root.querySelector('.fy-board-card__more')).toBeNull();
        expect(root.querySelector('[role="menu"]')).toBeNull();
        expect(root.querySelector('[data-dragging]')).toBeNull();
        expect(root.querySelector('.fy-board-card__verdict')).toBeNull();
        expect(root.querySelector('[data-verdict]')).toBeNull();
        expect(root.querySelector('.fy-board-done')).toBeNull();
        // The card is one link and nothing else: no button at all (Add to chat is only drawn where a chat asks).
        expect(root.querySelectorAll('button')).toHaveLength(0);
        expect(root.querySelectorAll('a')).toHaveLength(1);
        await release();
      }
    }
  });

  it('keeps "Add to chat" where a chat asks for it: it writes to the draft, never to the card', async () => {
    const added: string[] = [];
    const root = await draw({ onAddToChat: target => void added.push(target.task.id) });
    const buttons = [...root.querySelectorAll('button')];
    expect(buttons.map(button => button.getAttribute('data-add-to-chat'))).toEqual(['F412']);
    await interact(() => must(buttons[0], 'the button').click());
    expect(added).toEqual(['F412']);
  });

  it('marks a card whose lane is unknown as unplaced', async () => {
    const root = await draw({ category: null });
    expect(must(root.querySelector('li'), 'the card').dataset.category).toBe('unplaced');
  });
});

describe('BoardLane', () => {
  const lane = (props: Partial<Parameters<typeof BoardLane>[0]> = {}) => (
    <BoardLane category="active" count={2} density="page" name="Implement" {...props}>
      <li>one</li>
      <li>two</li>
    </BoardLane>
  );

  it('names itself with its count and folds away from its header', async () => {
    view = await mount(lane());
    const section = must(view.container.querySelector('section'), 'the lane');
    expect(section.getAttribute('aria-label')).toBe('Implement, 2 cards');
    expect(section.dataset.category).toBe('active');
    expect(view.container.querySelectorAll('li')).toHaveLength(2);
    const toggle = must(view.container.querySelector<HTMLButtonElement>('.fy-board-lane__toggle'), 'the toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await interact(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(view.container.querySelectorAll('li')).toHaveLength(0);
    await interact(() => toggle.click());
    expect(view.container.querySelectorAll('li')).toHaveLength(2);
  });

  it('says "card" for one, starts folded when asked, and is unplaced with no category', async () => {
    view = await mount(lane({ count: 1, defaultCollapsed: true, category: null }));
    const section = must(view.container.querySelector('section'), 'the lane');
    expect(section.getAttribute('aria-label')).toBe('Implement, 1 card');
    expect(section.dataset.category).toBe('unplaced');
    expect(view.container.querySelectorAll('li')).toHaveLength(0);
  });

  it('is not a drop target: a drag over it is left alone', async () => {
    view = await mount(lane());
    const section = must(view.container.querySelector('section'), 'the lane');
    const over = new Event('dragover', { bubbles: true, cancelable: true });
    await interact(() => section.dispatchEvent(over));
    expect(over.defaultPrevented).toBe(false);
    expect(section.hasAttribute('data-drop')).toBe(false);
  });
});
