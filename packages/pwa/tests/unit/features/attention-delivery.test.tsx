import { describe, expect, it } from 'bun:test';
import {
  AttentionDelivery,
  AttentionDeliveryContext,
  deliveringIds,
} from '../../../src/features/attention/attention-delivery.tsx';
import type { InboxAction } from '../../../src/lib/attention-answers.ts';
import { attentionItem } from '../../support/attention-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';

const undelivered = attentionItem('A5', {
  undelivered: {
    at: '2026-10-29T09:00:00.000Z',
    reason: 'The session was closed.',
    reply: { action: 'dismiss' },
  },
});

const pick = <T extends HTMLElement>(view: Mounted, selector: string, what: string): T =>
  must(view.container.querySelector<T>(selector), what);

describe('deliveringIds', () => {
  it('is every id held for the settle window or handed over and not yet proven', () => {
    expect(deliveringIds(null).size).toBe(0);
    const snapshot = { replies: { pending: ['A1'] }, delivery: { sending: ['A2'] } } as never;
    expect([...deliveringIds(snapshot)].sort()).toEqual(['A1', 'A2']);
  });
});

describe('AttentionDelivery', () => {
  it('says nothing for an item with no answer on its way and none lost', async () => {
    const view = await mount(<AttentionDelivery item={attentionItem('A5')} onAct={() => undefined} />);
    expect(view.container.querySelector('[data-attention-delivery]')).toBeNull();
    await view.unmount();
  });

  it('says "Sending…" while the daemon holds the answer', async () => {
    const view = await mount(
      <AttentionDeliveryContext value={{ sending: new Set(['A5']) }}>
        <AttentionDelivery item={undelivered} onAct={() => undefined} />
      </AttentionDeliveryContext>,
    );
    expect(pick(view, '[data-attention-delivery="sending"]', 'sending').textContent).toContain('Sending…');
    expect(view.container.querySelector('[data-attention-retry]')).toBeNull();
    await view.unmount();
  });

  it('names the ferret when the answer did not arrive, and Retry sends it again', async () => {
    const acts: InboxAction[] = [];
    const view = await mount(
      <AttentionDeliveryContext value={{ sending: new Set(), ferret: 'Johnnie' }}>
        <AttentionDelivery item={undelivered} onAct={action => acts.push(action)} />
      </AttentionDeliveryContext>,
    );
    const lost = pick(view, '[data-attention-delivery="undelivered"]', 'lost');
    expect(lost.textContent).toContain("Your answer didn't reach Johnnie");
    expect(lost.textContent).toContain('The session was closed.');
    await interact(() => pick(view, '[data-attention-retry]', 'Retry').click());
    expect(acts).toHaveLength(1);
    await view.unmount();
  });

  it('names the ferret from the card first, else "the ferret", and holds Retry while busy', async () => {
    const view = await mount(<AttentionDelivery busy ferret="Zoe" item={undelivered} onAct={() => undefined} />);
    expect(pick(view, '[data-attention-delivery]', 'lost').textContent).toContain('reach Zoe');
    expect(pick<HTMLButtonElement>(view, '[data-attention-retry]', 'Retry').disabled).toBe(true);
    await view.unmount();
    const bare = await mount(<AttentionDelivery item={undelivered} onAct={() => undefined} />);
    expect(pick(bare, '[data-attention-delivery]', 'lost').textContent).toContain('reach the ferret');
    await bare.unmount();
  });
});
