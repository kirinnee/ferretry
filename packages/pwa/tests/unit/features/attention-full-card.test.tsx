import { describe, expect, it } from 'bun:test';
import { AttentionFullCard } from '../../../src/features/attention/attention-full-card.tsx';
import type { InboxAction } from '../../../src/lib/attention-answers.ts';
import { attentionItem, choices } from '../../support/attention-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';

const NOW = Date.parse('2026-10-29T10:00:00.000Z');

const pick = <T extends HTMLElement>(view: Mounted, selector: string, what: string): T =>
  must(view.container.querySelector<T>(selector), what);

interface Calls {
  acts: InboxAction[];
  log: string[];
}

const card = (
  extra: Record<string, unknown> = {},
  props: { swipeable?: boolean; previous?: boolean; next?: boolean } = {},
  calls: Calls = { acts: [], log: [] },
) =>
  mount(
    <AttentionFullCard
      ferret="Johnnie"
      item={attentionItem('A5', {
        subject: 'Which database?',
        title: 'Pick the database',
        ask: choices('SQLite', 'Postgres', 'Neither'),
        body: 'The long story.',
        context: 'Why it matters.',
        ...extra,
      })}
      now={NOW}
      onAct={action => calls.acts.push(action)}
      onAddReply={() => calls.log.push('reply')}
      onClose={() => calls.log.push('close')}
      position={{ index: 1, total: 5 }}
      swipeable={props.swipeable ?? false}
      {...(props.previous === false ? {} : { onPrevious: () => calls.log.push('previous') })}
      {...(props.next === false ? {} : { onNext: () => calls.log.push('next') })}
    />,
  );

describe('the full card', () => {
  it('heads with who, the status pill and the age, then the question as its title', async () => {
    const view = await card();
    expect(pick(view, '[data-attention-author]', 'author').textContent).toBe('Johnnie');
    expect(pick(view, '[data-agenda-status]', 'pill').textContent).toBe('Needs you');
    expect(pick(view, '[data-attention-title]', 'title').textContent).toBe('Which database?');
    expect(pick(view, '[data-attention-full-card]', 'card').getAttribute('aria-labelledby')).toBe(
      pick(view, '[data-attention-title]', 'title').id,
    );
    await view.unmount();
  });

  it('says "Warden" for the daemon’s own Warden', async () => {
    const view = await card({ raisedBy: 'daemon', sourceRef: 'warden:memory-low' });
    expect(pick(view, '[data-attention-author]', 'author').textContent).toBe('Warden');
    await view.unmount();
  });

  it('has exactly ONE scroller: the body holds the detail and nothing inside it scrolls itself', async () => {
    const view = await card();
    const scrollers = view.container.querySelectorAll('[data-attention-full-scroll]');
    expect(scrollers).toHaveLength(1);
    expect(scrollers[0]?.querySelector('[data-attention-detail]')).not.toBeNull();
    expect(scrollers[0]?.querySelector('[data-attention-scroll]')).toBeNull();
    expect(view.container.querySelector('[data-attention-full-scroll] [data-attention-full-scroll]')).toBeNull();
    await view.unmount();
  });

  it('pins the answer bar OUTSIDE the scroller', async () => {
    const view = await card();
    const scroller = pick(view, '[data-attention-full-scroll]', 'scroller');
    expect(scroller.contains(pick(view, '[data-attention-actions]', 'answers'))).toBe(false);
    expect(scroller.contains(pick(view, '[data-attention-next]', 'next'))).toBe(false);
    await view.unmount();
  });

  it('draws the swipe arrows only when it can be swiped', async () => {
    const still = await card({}, { swipeable: false });
    expect(still.container.querySelectorAll('[data-attention-answer] svg')).toHaveLength(0);
    expect(still.container.querySelector('[data-swipeable]')).toBeNull();
    await still.unmount();
    const swipeable = await card({}, { swipeable: true });
    expect(swipeable.container.querySelectorAll('[data-attention-answer] svg').length).toBeGreaterThan(0);
    expect(swipeable.container.querySelector('[data-swipeable]')).not.toBeNull();
    await swipeable.unmount();
  });

  it('answers with the option pressed, the recommended one on the right', async () => {
    const calls: Calls = { acts: [], log: [] };
    const view = await card({ recommendation: { decision: 'Postgres' } }, {}, calls);
    const right = pick(view, '[data-attention-answer="right"]', 'right');
    expect(right.getAttribute('data-attention-option')).toBe('Postgres');
    await interact(() => right.click());
    expect(calls.acts).toHaveLength(1);
    await view.unmount();
  });

  it('moves ‹ › through the items and says where it is: "2 of 5"', async () => {
    const calls: Calls = { acts: [], log: [] };
    const view = await card({}, {}, calls);
    expect(pick(view, '[data-attention-position]', 'position').textContent).toBe('2 of 5');
    await interact(() => pick<HTMLButtonElement>(view, '[data-attention-previous]', 'previous').click());
    await interact(() => pick<HTMLButtonElement>(view, '[data-attention-next]', 'next').click());
    expect(calls.log).toEqual(['previous', 'next']);
    await view.unmount();
  });

  it('disables ‹ and › at the ends', async () => {
    const view = await card({}, { previous: false, next: false });
    expect(pick<HTMLButtonElement>(view, '[data-attention-previous]', 'previous').disabled).toBe(true);
    expect(pick<HTMLButtonElement>(view, '[data-attention-next]', 'next').disabled).toBe(true);
    await view.unmount();
  });

  it('adds to the reply and closes', async () => {
    const calls: Calls = { acts: [], log: [] };
    const view = await card({}, {}, calls);
    await interact(() => pick<HTMLButtonElement>(view, '[data-attention-add-reply]', 'add').click());
    await interact(() => pick<HTMLButtonElement>(view, '[data-attention-close]', 'close').click());
    expect(calls.log).toEqual(['reply', 'close']);
    await view.unmount();
  });

  it('keeps "Not needed…" in the ⋯ menu, not on the bar', async () => {
    const view = await card();
    expect(view.container.querySelector('[data-attention-dismiss]')).toBeNull();
    await interact(() => pick<HTMLButtonElement>(view, '[data-attention-more]', 'more').click());
    expect(pick(view, '[data-attention-dismiss]', 'dismiss').textContent).toContain('Not needed');
    await view.unmount();
  });

  it('on a ferret’s turn, offers no answers — only to add to the reply', async () => {
    const view = await card({ waitingOn: 'ferret' });
    expect(pick(view, '[data-agenda-status]', 'pill').textContent).toBe('With Johnnie');
    expect(view.container.querySelector('[data-attention-answer]')).toBeNull();
    expect(view.container.querySelector('[data-attention-add-reply]')).not.toBeNull();
    await view.unmount();
  });

  it('draws a notification with no options and no turn pill, and clears it', async () => {
    const calls: Calls = { acts: [], log: [] };
    const view = await card({ notice: true, ask: undefined }, {}, calls);
    expect(view.container.querySelector('[data-agenda-status]')).toBeNull();
    expect(view.container.querySelector('[data-attention-answer]')).toBeNull();
    await interact(() => pick<HTMLButtonElement>(view, '[data-attention-clear]', 'clear').click());
    expect(calls.acts).toEqual([{ kind: 'resolve', label: 'Clear' }]);
    await view.unmount();
  });

  it('shows why an answer did not land', async () => {
    const view = await mount(
      <AttentionFullCard
        error="offline"
        ferret="J"
        item={attentionItem('A5', { ask: choices('A', 'B') })}
        onAct={() => undefined}
        onAddReply={() => undefined}
        onClose={() => undefined}
        position={{ index: 0, total: 1 }}
        swipeable={false}
      />,
    );
    expect(pick(view, '[role="alert"]', 'error').textContent).toContain('offline');
    await view.unmount();
  });

  it('labels every control', async () => {
    const view = await card({}, { swipeable: true });
    for (const button of view.container.querySelectorAll('button'))
      expect(
        (button.textContent ?? '').trim().length + (button.getAttribute('aria-label') ?? '').length,
      ).toBeGreaterThan(0);
    expect(view.container.querySelector('nav')?.getAttribute('aria-label')).toBe('Agenda items');
    await view.unmount();
  });

  it('has one Updated control, in the header, that opens the earlier versions', async () => {
    const view = await card({
      revisions: [{ at: '2026-10-29T09:55:00.000Z', by: 'agent', changed: ['why'], previous: { why: 'Old.' } }],
    });
    expect(view.container.querySelectorAll('[data-attention-updated]')).toHaveLength(1);
    const button = pick(view, '[data-attention-updated]', 'Updated');
    expect(button.closest('.fy-full__top')).not.toBeNull();
    expect(view.container.querySelector('[data-attention-revisions]')).toBeNull();
    await interact(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(pick(view, '[data-attention-revisions]', 'list').textContent).toContain('Old.');
    await view.unmount();
  });

  it('keeps the reply control in the one footer row, named for assistive tech', async () => {
    const view = await card();
    const reply = pick(view, '[data-attention-add-reply]', 'reply');
    expect(reply.getAttribute('aria-label')).toContain('Add to reply');
    await view.unmount();
  });
});
