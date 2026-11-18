import { afterEach, describe, expect, it } from 'bun:test';
import { BottomSheet, Floating, useDialogFocus, useDismissSurface } from '@ferretry/app/ui';
import { FERRET_MENU_SLOT } from '@ferretry/core-ferrets/contract';
import { useRef, useState } from 'react';
import { interact, type Mounted, mount, must, pressKey, WithSlotPanels } from '@ferretry/app/testing';
import { contributedSlots, panelsInSlot } from '@ferretry/app/testing';
import { ModesMenu } from '../../../../app/toolbar/modes-menu.tsx';
import { CONVERSATION_MODES_SLOT } from '../../../../contract/index.ts';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const mode = (id: string, text: string) => ({
  plugin: 'probe',
  id,
  view: (props: Record<string, unknown>) => (
    <span data-mode={id} data-subject={String(props['subject'])}>
      {text}
    </span>
  ),
});

const draw = async (panels: ReturnType<typeof mode>[], ferretRows: ReturnType<typeof mode>[] = []) => {
  mounted = await mount(
    <WithSlotPanels slots={{ [CONVERSATION_MODES_SLOT]: panels, [FERRET_MENU_SLOT]: ferretRows }}>
      <ModesMenu daemon="d1" ferret="muriel" />
    </WithSlotPanels>,
  );
  return mounted.container;
};

const trigger = (root: HTMLElement) => root.querySelector<HTMLButtonElement>('[data-modes-trigger]');

describe('the ferret header’s Modes menu', () => {
  it('is one button on the main line, with no mode drawn until it is opened', async () => {
    const root = await draw([mode('agenda', 'Agenda mode On'), mode('hypermedia', 'Hypermedia On')]);

    expect(trigger(root)?.textContent).toContain('Modes');
    expect(trigger(root)?.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('[data-mode]')).toBeNull();
    expect(root.textContent).not.toContain('Agenda mode');
  });

  it('opens on a click with every mode, for this ferret, and Escape puts them away again', async () => {
    const root = await draw([mode('agenda', 'Agenda mode On'), mode('hypermedia', 'Hypermedia On')]);

    await interact(() => must(trigger(root), 'the Modes button').click());

    expect(trigger(root)?.getAttribute('aria-expanded')).toBe('true');
    const dialog = must(root.querySelector('[data-modes-body]'), 'the open menu');
    expect(dialog.getAttribute('aria-label')).toBe('Modes');
    expect([...dialog.querySelectorAll('[data-mode]')].map(node => node.getAttribute('data-mode'))).toEqual([
      'agenda',
      'hypermedia',
    ]);
    expect(dialog.querySelector('[data-mode="agenda"]')?.getAttribute('data-subject')).toBe('muriel');

    await interact(() => pressKey(dialog, 'Escape'));

    // Put away, not gone: the panels stay mounted, hidden, so a note that arrives later is still said.
    expect(root.querySelector<HTMLElement>('[data-modes-body]')?.hidden).toBe(true);
    expect(trigger(root)?.getAttribute('aria-expanded')).toBe('false');
  });

  it('holds this ferret’s own rows (Info, Actions) beside the modes, in the one menu', async () => {
    const root = await draw([mode('agenda', 'Agenda mode On')], [mode('info', 'Info'), mode('actions', 'Stop')]);

    await interact(() => must(trigger(root), 'the Modes button').click());

    const ferretRows = must(root.querySelector('[data-modes-section="ferret"]'), 'the ferret rows');
    expect([...ferretRows.querySelectorAll('[data-mode]')].map(node => node.getAttribute('data-mode'))).toEqual([
      'info',
      'actions',
    ]);
    expect(root.querySelector('[data-modes-section="modes"] [data-mode="agenda"]')).not.toBeNull();
    expect(root.querySelectorAll('[data-modes-trigger]').length).toBe(1);
  });

  it('draws the button where only the ferret’s own rows are contributed', async () => {
    const root = await draw([], [mode('info', 'Info')]);

    expect(trigger(root)).not.toBeNull();
  });

  it('draws no button at all where no mode is contributed', async () => {
    const root = await draw([]);

    expect(trigger(root)).toBeNull();
  });
});

/** A mode whose save is refused after the person already shut the menu (what a slow daemon does). */
const refusing = (settle: { reject: () => void }) => ({
  plugin: 'probe',
  id: 'slow',
  view: () => {
    const [note, setNote] = useState<string | null>(null);
    settle.reject = () => setNote('Hypermedia could not be switched: refused');
    return (
      <span data-mode="slow">
        slow
        {note === null ? null : (
          <Floating>
            <div data-probe-note="" role="status">
              {note}
            </div>
          </Floating>
        )}
      </span>
    );
  },
});

describe('a note that arrives after the menu was put away', () => {
  it('is still shown: the panel stays mounted and draws it on the page, not in the shut menu', async () => {
    const settle = { reject: () => undefined };
    const root = await draw([refusing(settle)]);

    await interact(() => must(trigger(root), 'the Modes button').click());
    await interact(() => pressKey(must(root.querySelector('[data-modes-body]'), 'the open menu'), 'Escape'));
    expect(root.querySelector<HTMLElement>('[data-modes-body]')?.hidden).toBe(true);

    await interact(() => settle.reject());

    const note = document.body.querySelector('[data-probe-note]');
    expect(note?.textContent).toContain('refused');
    // On the page's body, so neither the shut popover nor the phone sheet's transform can hide or box it in.
    expect(root.querySelector('[data-modes-body]')?.contains(note ?? null)).toBe(false);
  });
});

describe('where the modes are contributed', () => {
  it('Agenda mode, Hypermedia, Passive lessons and Compact memory at are Modes panels, not header chips', () => {
    expect(contributedSlots('conversation.')).toContain(CONVERSATION_MODES_SLOT);
    expect([...panelsInSlot(CONVERSATION_MODES_SLOT)].sort()).toEqual([
      'agenda.ferret-agenda-mode',
      'conversation.compact-at',
      'conversation.hypermedia',
      'lessons.ferret-lessons',
    ]);
    // The main line is the name and the status (and whose turn it is): no mode, no Info, no Actions.
    expect([...panelsInSlot('ferret.toolbar')].sort()).toEqual(['conversation.turn', 'ferrets.name', 'ferrets.status']);
    // Info and every Action are one click behind the same one menu.
    expect([...panelsInSlot(FERRET_MENU_SLOT)].sort()).toEqual(['ferrets.actions', 'ferrets.info']);
  });
});

/** The popover form a "…" row opens on a desktop: it takes focus on open, like the Rename form does. */
function ProbeForm({ onClose }: { readonly onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDialogFocus(true, ref, onClose);
  return (
    <div aria-label="Rename" data-probe-form="" ref={ref} role="dialog" tabIndex={-1}>
      <input aria-label="New name" />
    </div>
  );
}

/** A row that puts the menu away and opens a dialog of its own in the same commit (Rename…, Info on a phone). */
const dialogRow = (sheet: boolean) => ({
  plugin: 'probe',
  id: 'dialog-row',
  view: () => {
    const [shown, setShown] = useState(false);
    const dismiss = useDismissSurface();
    return (
      <>
        <button
          data-probe-open=""
          onClick={() => {
            dismiss();
            setShown(true);
          }}
          type="button"
        >
          Open dialog
        </button>
        <Floating>
          {!shown ? null : sheet ? (
            <BottomSheet ariaLabel="Info" closeLabel="Close Info" id="probe-sheet" onClose={() => setShown(false)} open>
              <input aria-label="Sheet field" />
            </BottomSheet>
          ) : (
            <ProbeForm onClose={() => setShown(false)} />
          )}
        </Floating>
      </>
    );
  },
});

const widthDescriptor: { saved?: PropertyDescriptor | undefined } = {};
const setWidth = (width: number): void => {
  widthDescriptor.saved = Object.getOwnPropertyDescriptor(window, 'innerWidth');
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
};
const restoreWidth = (): void => {
  if (widthDescriptor.saved) Object.defineProperty(window, 'innerWidth', widthDescriptor.saved);
};

describe('a row that opens a dialog as it puts the menu away', () => {
  it('leaves focus in the dialog on a desktop, not on the Modes button behind it', async () => {
    const root = await draw([], [dialogRow(false)]);
    await interact(() => must(trigger(root), 'the Modes button').click());

    await interact(() => must(document.body.querySelector<HTMLElement>('[data-probe-open]'), 'the row').click());

    const form = must(document.body.querySelector('[data-probe-form]'), 'the form');
    expect(form.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(trigger(root));
  });

  it('leaves focus in the sheet on a phone, not on the Modes button behind it', async () => {
    setWidth(390);
    try {
      const root = await draw([], [dialogRow(true)]);
      await interact(() => must(trigger(root), 'the Modes button').click());

      await interact(() => must(document.body.querySelector<HTMLElement>('[data-probe-open]'), 'the row').click());

      const sheet = must(document.body.querySelector('[role="dialog"][aria-label="Info"]'), 'the Info sheet');
      expect(sheet.contains(document.activeElement)).toBe(true);
      expect(document.activeElement).not.toBe(trigger(root));
    } finally {
      restoreWidth();
    }
  });

  it('still hands focus back to the Modes button when the menu is put away on its own', async () => {
    const root = await draw([mode('agenda', 'Agenda mode On')]);
    must(trigger(root), 'the Modes button').focus();
    await interact(() => must(trigger(root), 'the Modes button').click());
    expect(document.activeElement).not.toBe(trigger(root));

    await interact(() => pressKey(must(root.querySelector('[data-modes-body]'), 'the open menu'), 'Escape'));

    expect(document.activeElement).toBe(trigger(root));
  });
});
