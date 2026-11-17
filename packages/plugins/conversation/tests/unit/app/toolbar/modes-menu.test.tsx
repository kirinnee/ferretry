import { afterEach, describe, expect, it } from 'bun:test';
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

const draw = async (panels: ReturnType<typeof mode>[]) => {
  mounted = await mount(
    <WithSlotPanels slots={{ [CONVERSATION_MODES_SLOT]: panels }}>
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

    expect(root.querySelector('[data-modes-body]')).toBeNull();
    expect(trigger(root)?.getAttribute('aria-expanded')).toBe('false');
  });

  it('draws no button at all where no mode is contributed', async () => {
    const root = await draw([]);

    expect(trigger(root)).toBeNull();
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
    // What stays on the main line: the name, the status, whose turn it is, Info and Actions — and no mode.
    expect([...panelsInSlot('ferret.toolbar')].sort()).toEqual([
      'conversation.turn',
      'ferrets.actions',
      'ferrets.info',
      'ferrets.name',
      'ferrets.status',
    ]);
  });
});
