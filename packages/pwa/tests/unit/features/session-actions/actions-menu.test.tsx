import { afterEach, describe, expect, it } from 'bun:test';
import { Copy, Plug, RotateCw, Server, Square } from 'lucide-react';
import { useState } from 'react';
import { ActionsMenu } from '../../../../src/features/session-actions/actions-menu.tsx';
import type { SessionActionFormHost, SessionActionSection } from '../../../../src/features/session-actions/registry.ts';
import { interact, mount, must, pressKey, type Mounted } from '../../../support/dom.ts';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

interface State {
  readonly ran: string[];
  readonly failures: string[];
  readonly notices: string[];
  readonly toggles: boolean[];
  resolveToggle?: () => void;
}

const formA = (host: SessionActionFormHost) => (
  <div data-form="A">
    <p data-compact>{`Compact: ${host.compact}`}</p>
    <button data-switch-to-b="" onClick={() => host.open('formB')} type="button">
      Switch
    </button>
  </div>
);

const formB = (host: SessionActionFormHost) => (
  <div data-form="B">
    <p>B content</p>
    <button data-close-b="" onClick={host.close} type="button">
      Close
    </button>
    <button data-notify-b="" onClick={() => host.notify('B settled')} type="button">
      Notify
    </button>
  </div>
);

const buildSections = (state: State, toggled: boolean, onToggle: (next: boolean) => void): SessionActionSection[] => [
  {
    group: 'session',
    label: 'Session',
    entries: [
      {
        kind: 'run',
        id: 'copy',
        label: 'Copy',
        icon: Copy,
        run: () => {
          state.ran.push('copy');
        },
      },
      {
        kind: 'run',
        id: 'boom',
        label: 'Boom',
        icon: Copy,
        run: () => {
          throw new Error('kaboom');
        },
      },
      { kind: 'form', id: 'formA', label: 'Form A…', title: 'Form A', icon: Plug, render: formA },
      { kind: 'form', id: 'formB', label: 'Form B…', title: 'Form B', icon: Plug, render: formB },
    ],
  },
  {
    group: 'move',
    label: 'Move',
    entries: [
      {
        kind: 'run',
        id: 'detailed',
        label: 'Detailed',
        icon: Server,
        detail: 'nero',
        run: () => {
          state.ran.push('detailed');
        },
      },
      {
        kind: 'run',
        id: 'later',
        label: 'Later',
        icon: Server,
        unavailable: 'later',
        run: () => {
          state.ran.push('later');
        },
      },
    ],
  },
  {
    group: 'tools',
    label: 'Tools',
    entries: [
      {
        kind: 'toggle',
        id: 'toggle',
        label: 'Passive learning',
        icon: Plug,
        checked: toggled,
        onToggle: next =>
          new Promise<void>(resolve => {
            state.toggles.push(next);
            state.resolveToggle = () => {
              onToggle(next);
              resolve();
            };
          }),
      },
    ],
  },
  {
    group: 'danger',
    label: 'Danger',
    entries: [
      {
        kind: 'confirm',
        id: 'restart',
        label: 'Restart CLI',
        icon: RotateCw,
        question: 'Restart Hadi’s CLI?',
        consequence: 'It relaunches.',
        confirmLabel: 'Restart',
        run: () => {
          state.ran.push('restart');
        },
      },
      {
        kind: 'confirm',
        id: 'stop',
        label: 'Stop ferret…',
        icon: Square,
        danger: true,
        question: 'Stop Hadi?',
        consequence: 'The CLI exits.',
        confirmLabel: 'Stop ferret',
        run: () => {
          throw new Error('refused');
        },
      },
    ],
  },
];

interface Harness {
  readonly container: HTMLElement;
  readonly unmount: () => Promise<void>;
  readonly state: State;
}

const openMenu = async (options: { compact?: boolean } = {}): Promise<Harness> => {
  const state: State = { ran: [], failures: [], notices: [], toggles: [] };

  function Host() {
    const [form, setForm] = useState<string | null>(null);
    const [toggled, setToggled] = useState(false);
    return (
      <ActionsMenu
        compact={options.compact ?? false}
        form={form}
        name="Hadi"
        onFailure={message => state.failures.push(message)}
        onFormChange={setForm}
        onNotice={message => state.notices.push(message)}
        sections={buildSections(state, toggled, setToggled)}
      />
    );
  }

  const result = await mount(<Host />);
  mounted = result;
  return { container: result.container, unmount: result.unmount, state };
};

const trigger = (root: HTMLElement): HTMLElement =>
  must(root.querySelector('[data-session-actions-trigger]'), 'trigger');
const menu = (root: HTMLElement): HTMLElement | null => root.querySelector('[role="menu"]');
const row = (root: HTMLElement, id: string): HTMLElement =>
  must(root.querySelector(`[data-session-action-item="${id}"]`), `row ${id}`);
const openTrigger = async (root: HTMLElement): Promise<void> => interact(() => trigger(root).click());

describe('ActionsMenu — the trigger', () => {
  it('shows a labelled button on a desktop and an icon-only one when compact', async () => {
    const wide = await openMenu();
    expect(trigger(wide.container).textContent).toContain('Actions');
    expect(trigger(wide.container).getAttribute('aria-label')).toBeNull();
    expect(trigger(wide.container).getAttribute('aria-haspopup')).toBe('menu');

    const compact = await openMenu({ compact: true });
    expect(trigger(compact.container).textContent).toBe('');
    expect(trigger(compact.container).getAttribute('aria-label')).toBe('Actions');
  });

  it('opens on click and toggles closed on a second click', async () => {
    const h = await openMenu();
    expect(menu(h.container)).toBeNull();
    expect(trigger(h.container).getAttribute('aria-expanded')).toBe('false');
    await openTrigger(h.container);
    expect(menu(h.container)).not.toBeNull();
    expect(trigger(h.container).getAttribute('aria-expanded')).toBe('true');
    await openTrigger(h.container);
    expect(menu(h.container)).toBeNull();
  });
});

describe('ActionsMenu — sections and rows', () => {
  it('names the menu after the session, and groups rows under a labelled role=group per section', async () => {
    const h = await openMenu();
    await openTrigger(h.container);
    expect(menu(h.container)?.getAttribute('aria-label')).toBe('Hadi actions');
    const groups = [...h.container.querySelectorAll('[role="group"]')];
    expect(groups.map(group => group.getAttribute('aria-label'))).toEqual(['Session', 'Move', 'Tools', 'Danger']);
  });

  it('draws a basic run row with no detail and no title', async () => {
    const h = await openMenu();
    await openTrigger(h.container);
    const copy = row(h.container, 'copy');
    expect(copy.getAttribute('role')).toBe('menuitem');
    expect(copy.getAttribute('title')).toBeNull();
    expect(copy.querySelector('.fy-actions-menu__detail')).toBeNull();
  });

  it('shows a plain detail fact at the end of its row', async () => {
    const h = await openMenu();
    await openTrigger(h.container);
    expect(row(h.container, 'detailed').textContent).toContain('nero');
  });

  it('dims an unavailable row with its reason, disables it, and never runs it', async () => {
    const h = await openMenu();
    await openTrigger(h.container);
    const later = row(h.container, 'later');
    expect(later.getAttribute('aria-disabled')).toBe('true');
    expect(later.getAttribute('title')).toBe('later');
    expect(later.textContent).toContain('later');
    await interact(() => later.click());
    expect(h.state.ran).not.toContain('later');
    expect(menu(h.container)).not.toBeNull();
  });

  it('draws a toggle as a menuitemcheckbox with its On/Off fact', async () => {
    const h = await openMenu();
    await openTrigger(h.container);
    const toggle = row(h.container, 'toggle');
    expect(toggle.getAttribute('role')).toBe('menuitemcheckbox');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.textContent).toContain('Off');
  });
});

describe('ActionsMenu — running an action', () => {
  it('closes the menu, returns focus to the trigger, and runs the action', async () => {
    const h = await openMenu();
    await openTrigger(h.container);
    await interact(() => row(h.container, 'copy').click());
    expect(menu(h.container)).toBeNull();
    expect(document.activeElement).toBe(trigger(h.container));
    expect(h.state.ran).toEqual(['copy']);
  });

  it('surfaces a failed run through onFailure, with the daemon’s own sentence', async () => {
    const h = await openMenu();
    await openTrigger(h.container);
    await interact(() => row(h.container, 'boom').click());
    expect(h.state.failures).toEqual(['Boom failed: kaboom']);
  });

  it('blocks every other action while one is still pending, then releases once it settles', async () => {
    const h = await openMenu();
    await openTrigger(h.container);
    await interact(() => row(h.container, 'toggle').click());
    expect(h.state.toggles).toEqual([true]);

    // The toggle is mid-flight: the menu stays open (toggles do not close it), and a second
    // action anywhere in the menu must be ignored while `pending` is set.
    expect(menu(h.container)).not.toBeNull();
    await interact(() => row(h.container, 'copy').click());
    expect(h.state.ran).toEqual([]);

    await interact(() => h.state.resolveToggle?.());
    expect(row(h.container, 'toggle').getAttribute('aria-checked')).toBe('true');

    await interact(() => row(h.container, 'copy').click());
    expect(h.state.ran).toEqual(['copy']);
  });

  it('shows a spinner in place of the icon while a run is pending', async () => {
    const h = await openMenu();
    await openTrigger(h.container);
    await interact(() => row(h.container, 'toggle').click());
    expect(row(h.container, 'toggle').querySelector('.animate-spin')).not.toBeNull();
    await interact(() => h.state.resolveToggle?.());
  });
});

describe('ActionsMenu — inline confirm', () => {
  it('turns a confirm row into its question in place, and focuses the confirm button', async () => {
    const h = await openMenu();
    await openTrigger(h.container);
    await interact(() => row(h.container, 'restart').click());
    const confirm = must(h.container.querySelector('[data-menu-confirm="restart"]'), 'confirm');
    expect(confirm.textContent).toContain('Restart Hadi’s CLI?');
    expect(confirm.textContent).toContain('It relaunches.');
    const yes = must(confirm.querySelector<HTMLElement>('[data-menu-confirm-yes]'), 'yes button');
    expect(document.activeElement).toBe(yes);
    expect(yes.getAttribute('data-variant')).toBe('primary');
  });

  it('marks a danger confirm with the danger variant', async () => {
    const h = await openMenu();
    await openTrigger(h.container);
    await interact(() => row(h.container, 'stop').click());
    const yes = must(h.container.querySelector<HTMLElement>('[data-menu-confirm-yes]'), 'yes button');
    expect(yes.getAttribute('data-variant')).toBe('danger');
  });

  it('cancels back to the plain row without running anything, and keeps the menu open', async () => {
    const h = await openMenu();
    await openTrigger(h.container);
    await interact(() => row(h.container, 'restart').click());
    const cancel = must(
      [...h.container.querySelectorAll<HTMLElement>('[data-menu-confirm="restart"] button')].find(
        button => button.textContent === 'Cancel',
      ),
      'cancel button',
    );
    await interact(() => cancel.click());
    expect(h.container.querySelector('[data-menu-confirm="restart"]')).toBeNull();
    expect(row(h.container, 'restart')).not.toBeNull();
    expect(menu(h.container)).not.toBeNull();
    expect(h.state.ran).toEqual([]);
  });

  it('runs the action, closes and refocuses the trigger once the question is answered yes', async () => {
    const h = await openMenu();
    await openTrigger(h.container);
    await interact(() => row(h.container, 'restart').click());
    await interact(() => must(h.container.querySelector<HTMLElement>('[data-menu-confirm-yes]'), 'yes').click());
    expect(menu(h.container)).toBeNull();
    expect(document.activeElement).toBe(trigger(h.container));
    expect(h.state.ran).toEqual(['restart']);
  });

  it('strips the row’s trailing ellipsis from a confirm failure’s sentence', async () => {
    const h = await openMenu();
    await openTrigger(h.container);
    await interact(() => row(h.container, 'stop').click());
    await interact(() => must(h.container.querySelector<HTMLElement>('[data-menu-confirm-yes]'), 'yes').click());
    expect(h.state.failures).toEqual(['Stop ferret failed: refused']);
  });
});

describe('ActionsMenu — the escape stack', () => {
  it('the first Escape cancels an open confirm, and the second closes the menu', async () => {
    const h = await openMenu();
    await openTrigger(h.container);
    await interact(() => row(h.container, 'restart').click());
    expect(h.container.querySelector('[data-menu-confirm="restart"]')).not.toBeNull();

    await interact(() => pressKey(document, 'Escape'));
    expect(h.container.querySelector('[data-menu-confirm="restart"]')).toBeNull();
    expect(menu(h.container)).not.toBeNull();

    await interact(() => pressKey(document, 'Escape'));
    expect(menu(h.container)).toBeNull();
    expect(document.activeElement).toBe(trigger(h.container));
  });
});

describe('ActionsMenu — dismissal', () => {
  it('closes on an outside pointer, without returning focus to the trigger', async () => {
    const h = await openMenu();
    await openTrigger(h.container);
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    await interact(() => outside.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(menu(h.container)).toBeNull();
    expect(document.activeElement).not.toBe(trigger(h.container));
    outside.remove();
  });

  it('closes on a window resize', async () => {
    const h = await openMenu();
    await openTrigger(h.container);
    await interact(() => window.dispatchEvent(new Event('resize')));
    expect(menu(h.container)).toBeNull();
  });

  it('closes on Tab without trapping it', async () => {
    const h = await openMenu();
    await openTrigger(h.container);
    await interact(() => pressKey(must(menu(h.container), 'menu'), 'Tab'));
    expect(menu(h.container)).toBeNull();
  });
});

describe('ActionsMenu — keyboard roving focus', () => {
  it('lands on the first enabled row, skips the unavailable one, and wraps with Home/End/Up/Down', async () => {
    const h = await openMenu();
    await openTrigger(h.container);
    const theMenu = must(menu(h.container), 'menu');
    expect(document.activeElement).toBe(row(h.container, 'copy'));

    await interact(() => pressKey(theMenu, 'ArrowDown'));
    expect(document.activeElement).toBe(row(h.container, 'boom'));

    await interact(() => pressKey(theMenu, 'End'));
    expect(document.activeElement).toBe(row(h.container, 'stop'));

    await interact(() => pressKey(theMenu, 'ArrowDown'));
    expect(document.activeElement).toBe(row(h.container, 'copy'));

    await interact(() => pressKey(theMenu, 'ArrowUp'));
    expect(document.activeElement).toBe(row(h.container, 'stop'));

    await interact(() => pressKey(theMenu, 'Home'));
    expect(document.activeElement).toBe(row(h.container, 'copy'));
  });

  it('ignores a key it does not own', async () => {
    const h = await openMenu();
    await openTrigger(h.container);
    const theMenu = must(menu(h.container), 'menu');
    await interact(() => pressKey(theMenu, 'a'));
    expect(document.activeElement).toBe(row(h.container, 'copy'));
  });
});

describe('ActionsMenu — forms', () => {
  it('opens a form in a desktop popover, closing the menu first', async () => {
    const h = await openMenu();
    await openTrigger(h.container);
    await interact(() => row(h.container, 'formA').click());
    expect(menu(h.container)).toBeNull();
    const popover = must(h.container.querySelector('[data-session-action-popover]'), 'popover');
    expect(popover.getAttribute('role')).toBe('dialog');
    expect(popover.getAttribute('aria-label')).toBe('Form A');
    expect(popover.textContent).toContain('Compact: false');
  });

  it('lets a form re-open another one through the host, in place', async () => {
    const h = await openMenu();
    await openTrigger(h.container);
    await interact(() => row(h.container, 'formA').click());
    await interact(() => must(h.container.querySelector<HTMLElement>('[data-switch-to-b]'), 'switch').click());
    expect(h.container.querySelector('[data-form="A"]')).toBeNull();
    expect(h.container.querySelector('[data-form="B"]')).not.toBeNull();
  });

  it('closes the form through the host’s close', async () => {
    const h = await openMenu();
    await openTrigger(h.container);
    await interact(() => row(h.container, 'formA').click());
    await interact(() => must(h.container.querySelector<HTMLElement>('[data-switch-to-b]'), 'switch').click());
    await interact(() => must(h.container.querySelector<HTMLElement>('[data-close-b]'), 'close').click());
    expect(h.container.querySelector('[data-session-action-popover]')).toBeNull();
  });

  it('hands what a form settled to the page’s notice', async () => {
    const h = await openMenu();
    await openTrigger(h.container);
    await interact(() => row(h.container, 'formB').click());
    await interact(() => must(h.container.querySelector<HTMLElement>('[data-notify-b]'), 'notify').click());
    expect(h.state.notices).toEqual(['B settled']);
  });

  it('closes the popover on Escape', async () => {
    const h = await openMenu();
    await openTrigger(h.container);
    await interact(() => row(h.container, 'formA').click());
    await interact(() => pressKey(document, 'Escape'));
    expect(h.container.querySelector('[data-session-action-popover]')).toBeNull();
  });

  it('opens the same form in a bottom sheet when compact, with the host told it is compact', async () => {
    const h = await openMenu({ compact: true });
    await openTrigger(h.container);
    await interact(() => row(h.container, 'formA').click());
    expect(h.container.querySelector('[data-session-action-popover]')).toBeNull();
    const sheet = must(h.container.querySelector('[data-session-action-sheet]'), 'sheet');
    expect(sheet.textContent).toContain('Compact: true');
    const dialog = must(h.container.querySelector('[role="dialog"]'), 'dialog');
    expect(dialog.getAttribute('aria-label')).toBe('Form A');
    expect(h.container.querySelector('button[aria-label="Close Form A"]')).not.toBeNull();
  });
});
