import { describe, expect, it } from 'bun:test';
import { AgendaCard } from '../../../src/features/agenda/agenda-card.tsx';
import { agendaItem, choices } from '../../support/agenda-inbox.tsx';
import { interact, mount, must, pressKey } from '../../support/dom.ts';

describe('AgendaCard ⋯ menu', () => {
  it('opens the ⋯ menu on Not needed…, closes it on Esc with focus back, and on a press outside it', async () => {
    const view = await mount(
      <AgendaCard item={agendaItem('A2', { subject: 'Pick', ask: choices('Ship', 'Hold') })} onAct={() => undefined} />,
    );
    const more = must(view.container.querySelector<HTMLButtonElement>('[data-agenda-more]'), 'the ⋯ button');
    await interact(() => more.click());
    const menu = must(view.container.querySelector<HTMLElement>('[role="menu"]'), 'the menu');
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map(item => item.textContent?.trim())).toEqual(['Not needed…']);
    expect(document.activeElement).toBe(items[0] ?? null);
    await interact(() => pressKey(must(items[0], 'item'), 'Escape'));
    expect(view.container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(more);
    await interact(() => more.click());
    expect(view.container.querySelector('[role="menu"]')).not.toBeNull();
    await interact(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(view.container.querySelector('[role="menu"]')).toBeNull();
    await view.unmount();
  });
});
