import { describe, expect, it } from 'bun:test';
import { holdsPicker } from '../../../../app/lib/slot-picker.ts';
import { initialAgentOf } from '../../../../app/views/new-ferret.tsx';
import { mount, must } from '../support/dom.ts';

const SLOT = 'ferrets.new-ferret-account';

/** The markup the shell's `PanelSlot` draws: a `.fy-slot` with one `.fy-panel` per contributed panel. */
const slotMarkup = (panels: string): string => `<div class="fy-slot" data-slot="${SLOT}">${panels}</div>`;

const holds = async (html: string): Promise<boolean> => {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed test fixture of the shell slot's markup, never daemon data
  const screen = await mount(<div dangerouslySetInnerHTML={{ __html: html }} />);
  const answer = holdsPicker(must(screen.container.firstElementChild as HTMLElement, 'the root'), SLOT);
  await screen.unmount();
  return answer;
};

describe('the runtime slot as the page reads it', () => {
  it('holds a picker when a panel was contributed and drew', async () => {
    expect(await holds(slotMarkup('<div class="fy-panel"><button>Claude</button></div>'))).toBe(true);
  });

  it('holds none when nothing was contributed to the slot, so the page types the runtime itself', async () => {
    expect(await holds('<div></div>')).toBe(false);
  });

  it('holds none when the contributing plugin is blocked or could not draw, which the shell says in one line', async () => {
    expect(
      await holds(
        slotMarkup('<div class="fy-panel"><p class="fy-shell-line" role="status">Runtimes is off.</p></div>'),
      ),
    ).toBe(false);
  });

  it('holds none for an empty slot element', async () => {
    expect(await holds(slotMarkup(''))).toBe(false);
  });
});

describe('the runtime a Launch button named', () => {
  it('is read from ?agent= on the page address, and absent or blank is no hint', () => {
    expect(initialAgentOf('?agent=codex-b')).toBe('codex-b');
    expect(initialAgentOf('?agent=%20codex-b%20')).toBe('codex-b');
    expect(initialAgentOf('?agent=')).toBeUndefined();
    expect(initialAgentOf('')).toBeUndefined();
  });
});
