import { describe, expect, it } from 'bun:test';
import { AttentionCard } from '../../../src/features/attention/attention-card.tsx';
import type { InboxAction } from '../../../src/lib/attention-inbox.ts';
import { attentionItem, choices } from '../../support/attention-inbox.tsx';
import { interact, mount, must, pressKey } from '../../support/dom.ts';

const typeInto = async (root: HTMLElement, text: string): Promise<HTMLTextAreaElement> => {
  const box = must(root.querySelector('textarea'), 'the reply box');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(box, text);
  await interact(() => box.dispatchEvent(new Event('input', { bubbles: true })));
  return box;
};

describe('AttentionCard reply and menu', () => {
  it('sends the typed reply on Ctrl+Enter and on the send button, then clears the box', async () => {
    const acts: InboxAction[] = [];
    const view = await mount(
      <AttentionCard item={attentionItem('A1', { subject: 'Have a look' })} onAct={a => acts.push(a)} />,
    );
    const box = await typeInto(view.container, 'looks fine');
    await interact(() => pressKey(box, 'Enter', { ctrlKey: true }));
    expect(acts).toHaveLength(1);
    expect(box.value).toBe('');
    await typeInto(view.container, 'again');
    const send = must(view.container.querySelector<HTMLButtonElement>('.fy-attn-reply__send'), 'send');
    await interact(() => send.click());
    expect(acts).toHaveLength(2);
    await interact(() => pressKey(box, 'Enter'));
    expect(acts).toHaveLength(2);
    await view.unmount();
  });

  it('walks the ⋯ menu with the arrows and closes it on a press outside it', async () => {
    const view = await mount(
      <AttentionCard
        item={attentionItem('A2', { subject: 'Pick', ask: choices('Ship', 'Hold') })}
        onAct={() => undefined}
      />,
    );
    const more = must(view.container.querySelector<HTMLButtonElement>('[data-attention-more]'), 'the ⋯ button');
    await interact(() => more.click());
    const menu = must(view.container.querySelector<HTMLElement>('[role="menu"]'), 'the menu');
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')] as [HTMLElement, HTMLElement];
    expect(document.activeElement).toBe(items[0]);
    await interact(() => pressKey(items[0], 'ArrowDown'));
    expect(document.activeElement).toBe(items[1]);
    await interact(() => pressKey(items[1], 'ArrowUp'));
    expect(document.activeElement).toBe(items[0]);
    await interact(() => pressKey(items[0], 'Tab'));
    await interact(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(view.container.querySelector('[role="menu"]')).toBeNull();
    await view.unmount();
  });
});
