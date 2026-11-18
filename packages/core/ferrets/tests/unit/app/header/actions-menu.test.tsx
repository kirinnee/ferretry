import { afterEach, describe, expect, it } from 'bun:test';
import { FloatingHost } from '@ferretry/app/ui';
import { Copy, Plug, RotateCw, Server, Square } from 'lucide-react';
import { useState } from 'react';
import { ActionsMenu } from '../../../../app/features/header/actions-menu.tsx';
import type { FerretActionFormHost, FerretActionSection } from '../../../../app/features/header/registry.ts';
import { interact, mount, must, pressKey, type Mounted } from '../support/dom.ts';

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
  /** How many times the surface the rows sit in (the ferret's menu) was asked to put itself away. */
  dismissed: number;
  resolveToggle?: () => void;
  /** Shuts or reopens the surface the rows sit in (the ferret's menu), which keeps the rows mounted. */
  setSurfaceOpen?: (open: boolean) => void;
}

const formA = (host: FerretActionFormHost) => (
  <div data-form="A">
    <p data-compact>{`Compact: ${host.compact}`}</p>
    <button data-switch-to-b="" onClick={() => host.open('formB')} type="button">
      Switch
    </button>
  </div>
);

const formB = (host: FerretActionFormHost) => (
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

const buildSections = (state: State, toggled: boolean, onToggle: (next: boolean) => void): FerretActionSection[] => [
  {
    group: 'ferret',
    label: 'Ferret',
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
    group: 'tools' as FerretActionSection['group'],
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
  const state: State = { ran: [], failures: [], notices: [], toggles: [], dismissed: 0 };

  function Host() {
    const [form, setForm] = useState<string | null>(null);
    const [toggled, setToggled] = useState(false);
    const [surfaceOpen, setSurfaceOpen] = useState(true);
    state.setSurfaceOpen = setSurfaceOpen;
    return (
      <FloatingHost
        dismiss={() => {
          state.dismissed += 1;
        }}
        element={document.body}
        open={surfaceOpen}
      >
        <ActionsMenu
          compact={options.compact ?? false}
          form={form}
          name="Hadi"
          onFailure={message => state.failures.push(message)}
          onFormChange={setForm}
          onNotice={message => state.notices.push(message)}
          sections={buildSections(state, toggled, setToggled)}
        />
      </FloatingHost>
    );
  }

  const result = await mount(<Host />);
  mounted = result;
  return { container: result.container, unmount: result.unmount, state };
};

const list = (root: HTMLElement): HTMLElement =>
  must(root.querySelector('[data-ferret-actions-menu]'), 'the actions list');
const row = (root: HTMLElement, id: string): HTMLElement =>
  must(root.querySelector(`[data-ferret-action-item="${id}"]`), `row ${id}`);
/** What a form drew: on the page's body (through Floating), never in the menu it was opened from. */
const onPage = (selector: string): HTMLElement | null => document.body.querySelector(selector);

describe('ActionsMenu — the list', () => {
  it('draws every action as a row in the menu itself, with no button of its own to open', async () => {
    const h = await openMenu();
    expect(h.container.querySelector('[data-ferret-actions-trigger]')).toBeNull();
    expect(h.container.querySelector('[role="menu"]')).toBeNull();
    expect(row(h.container, 'copy')).not.toBeNull();
    expect(row(h.container, 'stop')).not.toBeNull();
  });

  it('names the list after the ferret, and groups rows under a labelled role=group per section', async () => {
    const h = await openMenu();
    expect(list(h.container).getAttribute('aria-label')).toBe('Hadi actions');
    const groups = [...list(h.container).querySelectorAll('[role="group"]')];
    expect(groups.map(group => group.getAttribute('aria-label'))).toEqual(['Ferret', 'Move', 'Tools', 'Danger']);
  });

  it('puts every row in the tab order as a plain button, so the keyboard reaches all of them', async () => {
    const h = await openMenu();
    const copy = row(h.container, 'copy');
    expect(copy.getAttribute('role')).toBeNull();
    expect(copy.getAttribute('tabindex')).toBe('0');
    expect(copy.getAttribute('title')).toBeNull();
    expect(copy.querySelector('.fy-actions-menu__detail')).toBeNull();
  });

  it('shows a plain detail fact at the end of its row', async () => {
    const h = await openMenu();
    expect(row(h.container, 'detailed').textContent).toContain('nero');
  });

  it('dims an unavailable row with its reason, disables it, and never runs it', async () => {
    const h = await openMenu();
    const later = row(h.container, 'later');
    expect(later.getAttribute('aria-disabled')).toBe('true');
    expect(later.getAttribute('title')).toBe('later');
    expect(later.textContent).toContain('later');
    await interact(() => later.click());
    expect(h.state.ran).not.toContain('later');
    expect(h.state.dismissed).toBe(0);
  });

  it('draws a toggle as a switch with its On/Off fact', async () => {
    const h = await openMenu();
    const toggle = row(h.container, 'toggle');
    expect(toggle.getAttribute('role')).toBe('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.textContent).toContain('Off');
  });
});

describe('ActionsMenu — running an action', () => {
  it('runs the action and puts the menu away', async () => {
    const h = await openMenu();
    await interact(() => row(h.container, 'copy').click());
    expect(h.state.ran).toEqual(['copy']);
    expect(h.state.dismissed).toBe(1);
  });

  it('surfaces a failed run through onFailure, with the daemon’s own sentence', async () => {
    const h = await openMenu();
    await interact(() => row(h.container, 'boom').click());
    expect(h.state.failures).toEqual(['Boom failed: kaboom']);
  });

  it('blocks every other action while one is still pending, then releases once it settles', async () => {
    const h = await openMenu();
    await interact(() => row(h.container, 'toggle').click());
    expect(h.state.toggles).toEqual([true]);

    // The toggle is mid-flight: it does not put the menu away, and a second action anywhere in the list must be
    // ignored while `pending` is set.
    expect(h.state.dismissed).toBe(0);
    await interact(() => row(h.container, 'copy').click());
    expect(h.state.ran).toEqual([]);

    await interact(() => h.state.resolveToggle?.());
    expect(row(h.container, 'toggle').getAttribute('aria-checked')).toBe('true');

    await interact(() => row(h.container, 'copy').click());
    expect(h.state.ran).toEqual(['copy']);
  });

  it('shows a spinner in place of the icon while a run is pending', async () => {
    const h = await openMenu();
    await interact(() => row(h.container, 'toggle').click());
    expect(row(h.container, 'toggle').querySelector('.animate-spin')).not.toBeNull();
    await interact(() => h.state.resolveToggle?.());
  });
});

describe('ActionsMenu — inline confirm', () => {
  it('turns a confirm row into its question in place', async () => {
    const h = await openMenu();
    await interact(() => row(h.container, 'restart').click());
    const confirm = must(h.container.querySelector('[data-menu-confirm="restart"]'), 'confirm');
    expect(confirm.textContent).toContain('Restart Hadi’s CLI?');
    expect(confirm.textContent).toContain('It relaunches.');
    const yes = must(confirm.querySelector<HTMLElement>('[data-menu-confirm-yes]'), 'yes button');
    expect(yes.getAttribute('data-variant')).toBe('primary');
    expect(yes.getAttribute('tabindex')).toBe('0');
    expect(h.state.dismissed).toBe(0);
  });

  it('marks a danger confirm with the danger variant', async () => {
    const h = await openMenu();
    await interact(() => row(h.container, 'stop').click());
    const yes = must(h.container.querySelector<HTMLElement>('[data-menu-confirm-yes]'), 'yes button');
    expect(yes.getAttribute('data-variant')).toBe('danger');
  });

  it('cancels back to the plain row without running anything, and keeps the menu', async () => {
    const h = await openMenu();
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
    expect(h.state.ran).toEqual([]);
    expect(h.state.dismissed).toBe(0);
  });

  it('runs the action and puts the menu away once the question is answered yes', async () => {
    const h = await openMenu();
    await interact(() => row(h.container, 'restart').click());
    await interact(() => must(h.container.querySelector<HTMLElement>('[data-menu-confirm-yes]'), 'yes').click());
    expect(h.state.ran).toEqual(['restart']);
    expect(h.state.dismissed).toBe(1);
  });

  it('strips the row’s trailing ellipsis from a confirm failure’s sentence', async () => {
    const h = await openMenu();
    await interact(() => row(h.container, 'stop').click());
    await interact(() => must(h.container.querySelector<HTMLElement>('[data-menu-confirm-yes]'), 'yes').click());
    expect(h.state.failures).toEqual(['Stop ferret failed: refused']);
  });
});

describe('ActionsMenu — a menu put away with a confirm armed', () => {
  it('reopens with the rows, not the armed question (the panel stays mounted while the menu is shut)', async () => {
    const h = await openMenu();
    await interact(() => row(h.container, 'restart').click());
    expect(h.container.querySelector('[data-menu-confirm="restart"]')).not.toBeNull();

    await interact(() => h.state.setSurfaceOpen?.(false));
    await interact(() => h.state.setSurfaceOpen?.(true));

    expect(h.container.querySelector('[data-menu-confirm]')).toBeNull();
    expect(h.container.querySelector('[data-ferret-action-item="restart"]')).not.toBeNull();
  });

  it('keeps the confirm armed while the menu stays open', async () => {
    const h = await openMenu();
    await interact(() => row(h.container, 'restart').click());

    await interact(() => h.state.setSurfaceOpen?.(true));

    expect(h.container.querySelector('[data-menu-confirm="restart"]')).not.toBeNull();
  });
});

describe('ActionsMenu — forms', () => {
  it('opens a form in a desktop popover on the page, putting the menu away first', async () => {
    const h = await openMenu();
    await interact(() => row(h.container, 'formA').click());
    expect(h.state.dismissed).toBe(1);
    const popover = must(onPage('[data-ferret-action-popover]'), 'popover');
    expect(popover.getAttribute('role')).toBe('dialog');
    expect(popover.getAttribute('aria-label')).toBe('Form A');
    expect(popover.textContent).toContain('Compact: false');
    // On the page, not boxed in the menu or hidden with it.
    expect(h.container.contains(popover)).toBe(false);
  });

  it('lets a form re-open another one through the host, in place', async () => {
    const h = await openMenu();
    await interact(() => row(h.container, 'formA').click());
    await interact(() => must(onPage('[data-switch-to-b]'), 'switch').click());
    expect(onPage('[data-form="A"]')).toBeNull();
    expect(onPage('[data-form="B"]')).not.toBeNull();
  });

  it('closes the form through the host’s close', async () => {
    const h = await openMenu();
    await interact(() => row(h.container, 'formA').click());
    await interact(() => must(onPage('[data-switch-to-b]'), 'switch').click());
    await interact(() => must(onPage('[data-close-b]'), 'close').click());
    expect(onPage('[data-ferret-action-popover]')).toBeNull();
  });

  it('hands what a form settled to the page’s notice', async () => {
    const h = await openMenu();
    await interact(() => row(h.container, 'formB').click());
    await interact(() => must(onPage('[data-notify-b]'), 'notify').click());
    expect(h.state.notices).toEqual(['B settled']);
  });

  it('closes the popover on Escape', async () => {
    const h = await openMenu();
    await interact(() => row(h.container, 'formA').click());
    await interact(() => pressKey(document, 'Escape'));
    expect(onPage('[data-ferret-action-popover]')).toBeNull();
  });

  it('opens the same form in a bottom sheet when compact, with the host told it is compact', async () => {
    const h = await openMenu({ compact: true });
    await interact(() => row(h.container, 'formA').click());
    expect(onPage('[data-ferret-action-popover]')).toBeNull();
    const sheet = must(onPage('[data-ferret-action-sheet]'), 'sheet');
    expect(sheet.textContent).toContain('Compact: true');
    const dialog = must(document.body.querySelector('[data-bottom-sheet] [role="dialog"]'), 'dialog');
    expect(dialog.getAttribute('aria-label')).toBe('Form A');
    expect(document.body.querySelector('button[aria-label="Close Form A"]')).not.toBeNull();
    // The sheet is drawn on the body: the menu's own sheet (a transform) must not be its containing block.
    expect(h.container.contains(sheet)).toBe(false);
  });
});
