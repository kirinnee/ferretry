import { afterEach, describe, expect, it } from 'bun:test';
import { BoardNotice } from '../../../src/features/board/board-notice.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const press = (root: HTMLElement, selector: string) =>
  interact(() => must(root.querySelector<HTMLElement>(selector), selector).click());

describe('BoardNotice', () => {
  it('is a plain line on a wide screen, with no dismiss button unless one is asked for', async () => {
    view = await mount(
      <BoardNotice compact={false} machine="daemon/studio">
        studio did not answer
      </BoardNotice>,
    );
    const note = must(view.container.querySelector('.fy-board__notice'), 'the notice');
    expect(note.textContent).toBe('studio did not answer');
    expect(note.getAttribute('data-machine')).toBe('daemon/studio');
    expect(note.hasAttribute('data-compact')).toBe(false);
    expect(view.container.querySelector('.fy-board__notice-x')).toBeNull();
    expect(view.container.querySelector('.fy-board__notice-text')).toBeNull();
  });

  it('dismisses a wide notice through its X', async () => {
    let dismissed = 0;
    view = await mount(
      <BoardNotice
        compact={false}
        onDismiss={() => {
          dismissed += 1;
        }}
      >
        The move did not go through.
      </BoardNotice>,
    );
    await press(view.container, '.fy-board__notice-x');
    expect(dismissed).toBe(1);
  });

  it('is one tappable line on a phone that opens to its full length and folds back', async () => {
    view = await mount(<BoardNotice compact>studio did not answer: it is on fire</BoardNotice>);
    const note = must(view.container.querySelector('.fy-board__notice'), 'the notice');
    const text = must(view.container.querySelector('.fy-board__notice-text'), 'the text');
    expect(note.hasAttribute('data-compact')).toBe(true);
    expect(note.hasAttribute('data-open')).toBe(false);
    expect(text.getAttribute('aria-expanded')).toBe('false');
    expect(view.container.querySelector('.fy-board__notice-x')).toBeNull();

    await press(view.container, '.fy-board__notice-text');
    expect(note.hasAttribute('data-open')).toBe(true);
    expect(text.getAttribute('aria-expanded')).toBe('true');

    await press(view.container, '.fy-board__notice-text');
    expect(note.hasAttribute('data-open')).toBe(false);
    expect(text.getAttribute('aria-expanded')).toBe('false');
  });

  it('dismisses a phone notice through its X, which is not the expand button', async () => {
    let dismissed = 0;
    view = await mount(
      <BoardNotice
        compact
        machine="daemon/studio"
        onDismiss={() => {
          dismissed += 1;
        }}
      >
        studio did not answer
      </BoardNotice>,
    );
    const x = must(view.container.querySelector('.fy-board__notice-x'), 'the dismiss button');
    expect(x.getAttribute('aria-label')).toBe('Dismiss');
    await press(view.container, '.fy-board__notice-x');
    expect(dismissed).toBe(1);
    expect(view.container.querySelector('.fy-board__notice')?.hasAttribute('data-open')).toBe(false);
  });
});
