import { describe, expect, it } from 'bun:test';
import type { AgendaItem } from '@ferretry/protocol';
import { AgendaInboxPage, type AgendaInboxPageProps } from '../../../src/features/agenda/agenda-inbox-page.tsx';
import type { InboxCard } from '../../../src/lib/agenda-inbox.ts';
import {
  agendaItem,
  choices,
  type FakeInbox,
  fakeInbox,
  InboxHarness,
  inboxCard,
} from '../../support/agenda-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
import { sessionView } from '../../support/sessions.ts';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');

const gateItem = (id: string, cardId: string, extra: Partial<AgendaItem> = {}): AgendaItem =>
  agendaItem(id, {
    subject: 'Try it: open the pairing page',
    why: 'Pairing QR is in Tested.',
    premise: 'Pairing QR is in Tested.',
    body: '1. Open the pairing page\n2. Scan the code',
    kind: 'choice',
    raisedBy: 'daemon',
    raisedBySession: null,
    // The daemon lays the options out in swipe order: Done first, Not good last; the app turns them: → Done, ← Not good.
    ask: choices('Done', 'Not good'),
    gate: {
      cardId,
      laneId: 'tested',
      laneName: 'Tested',
      entry: 1,
      projectId: 'p1',
      projectName: 'Ferretry',
      options: [
        { id: 'o0', label: 'Done', outcome: 'close' },
        { id: 'o1', label: 'Not good', outcome: 'reopen-with-agenda' },
      ],
    },
    ...extra,
  } as Partial<AgendaItem>);

const owner = sessionView('sess-g', { config: { teammate: 'judson', name: 'Pairing QR' } as never });
const gate = inboxCard(gateItem('G1', 'F1'), owner);
const question = inboxCard(
  agendaItem('A2', { subject: 'Rebase?', ask: choices('Rebase now', 'Wait') }),
  sessionView('sess-q', { config: { teammate: 'zoe', name: 'Fix the build' } as never }),
);

const page = (
  fake: FakeInbox,
  cards: readonly InboxCard[],
  props: Partial<AgendaInboxPageProps> = {},
  canSnooze?: () => boolean,
) => (
  <InboxHarness
    cards={cards}
    fake={fake}
    reading={false}
    render={inbox => (
      <AgendaInboxPage
        clock={fake.clock.now}
        inbox={canSnooze === undefined ? inbox : { ...inbox, canSnooze }}
        now={NOW}
        onNavigate={() => undefined}
        phone
        reducedMotion
        {...props}
      />
    )}
  />
);

const composer = () => <div data-fake-composer="" />;

const pending = (fake: FakeInbox): string[] => fake.deferred.getSnapshot().pending.map(entry => entry.action.label);
const press = (target: Element) => interact(() => (target as HTMLElement).click());
const buttonNamed = (mounted: Mounted, name: string): HTMLButtonElement =>
  must(
    mounted.container.querySelector<HTMLButtonElement>(`.fy-attn-deck__top [data-agenda-option="${name}"]`),
    `the ${name} button`,
  );
const tool = (mounted: Mounted, name: string): HTMLButtonElement =>
  must(mounted.container.querySelector<HTMLButtonElement>(`.fy-attn-deck__top [data-inbox-tool="${name}"]`), name);
const openInfo = (mounted: Mounted) =>
  press(must(mounted.container.querySelector('.fy-attn-deck__top [data-agenda-info-toggle]'), 'the (i)'));
const flush = async (): Promise<void> => {
  await interact(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('a gate item in the Inbox', () => {
  it('says the gate and the project on ONE quiet line, and shows the card’s How to test as the body', async () => {
    const mounted = await mount(page(fakeInbox(), [gate], { initialOpen: gate.key }));
    const line = must(mounted.container.querySelector('[data-inbox-gate]'), 'the gate line');
    expect(line.querySelector('[data-inbox-gate-stage]')?.textContent).toBe('Try it');
    expect(line.querySelector('[data-inbox-gate-project]')?.textContent).toBe('Ferretry');
    expect(line.querySelector('[data-inbox-open-chat]')?.textContent).toContain('Open chat');
    expect(mounted.container.querySelectorAll('[data-inbox-who]').length).toBe(1);
    expect(mounted.container.textContent).toContain('Scan the code');
    await mounted.unmount();
  });

  it('says "OK to build?" for the approval gate', async () => {
    const approve = inboxCard(
      gateItem('G2', 'F2', { subject: 'OK to build? Pairing QR' }),
      sessionView('sess-h', { config: { teammate: 'judson', name: 'Plan' } as never }),
    );
    const mounted = await mount(page(fakeInbox(), [approve], { initialOpen: approve.key }));
    expect(mounted.container.querySelector('[data-inbox-gate-stage]')?.textContent).toBe('Approve');
    await mounted.unmount();
  });

  it('draws no gate line on a plain question', async () => {
    const mounted = await mount(page(fakeInbox(), [question], { initialOpen: question.key }));
    expect(mounted.container.querySelector('[data-inbox-gate]')).toBeNull();
    await mounted.unmount();
  });

  it('wears the lane’s verb in its meta line only — no chip, no "Pick one option." line', async () => {
    const approve = inboxCard(
      gateItem('G2', 'F2', { subject: 'OK to build? Pairing QR' }),
      sessionView('sess-h', { config: { teammate: 'judson', name: 'Plan' } as never }),
    );
    const mounted = await mount(page(fakeInbox(), [gate, approve], { initialOpen: gate.key }));
    expect(mounted.container.querySelector('.fy-attn-deck__top [data-inbox-gate-stage]')?.textContent).toBe('Try it');
    expect(mounted.container.querySelector('.fy-attn-deck__top .fy-card__type')).toBeNull();
    expect(mounted.container.querySelector('.fy-attn-deck__top')?.textContent).not.toContain('Pick one option');
    await mounted.unmount();
  });

  it('draws the How to test steps as numbered tick-steps under "How to test", and repeats neither the summary nor the ask', async () => {
    const mounted = await mount(page(fakeInbox(), [gate], { initialOpen: gate.key }));
    const top = must(mounted.container.querySelector('.fy-attn-deck__top'), 'the open card');
    expect(top.querySelectorAll('[data-test-tick]').length).toBe(2);
    expect(top.querySelector('[data-agenda-need] .fy-card__need-title')?.textContent).toBe('How to test');
    expect(top.querySelector('[data-agenda-gate-summary]')).toBeNull();
    expect(top.querySelector('[data-agenda-question-line]')).toBeNull();
    await mounted.unmount();
  });

  it('shows "Not needed" once — the button — and no composer under the card', async () => {
    const mounted = await mount(page(fakeInbox(), [gate], { initialOpen: gate.key, renderComposer: composer }));
    const top = must(mounted.container.querySelector('.fy-attn-deck__top'), 'the open card');
    const notNeeded = () => [...top.querySelectorAll('button')].filter(b => /not needed/i.test(b.textContent ?? ''));
    expect(notNeeded().length).toBe(0);
    await openInfo(mounted);
    expect(notNeeded().length).toBe(1);
    expect(mounted.container.querySelector('[data-fake-composer]')).toBeNull();
    expect(mounted.container.querySelector('[data-inbox-gate-why]')).toBeNull();
    await mounted.unmount();
  });

  it('lets the title wrap instead of truncating', async () => {
    const mounted = await mount(page(fakeInbox(), [gate], { initialOpen: gate.key }));
    expect(mounted.container.querySelector('.fy-attn-deck__top [data-agenda-title]')?.hasAttribute('data-wrap')).toBe(
      true,
    );
    await mounted.unmount();
  });

  it('keeps the composer under a question', async () => {
    const mounted = await mount(page(fakeInbox(), [question], { initialOpen: question.key, renderComposer: composer }));
    expect(mounted.container.querySelector('[data-fake-composer]')).not.toBeNull();
    await mounted.unmount();
  });

  it('lays the buttons out Not good (left) · Done (right), the order of the swipes', async () => {
    const mounted = await mount(page(fakeInbox(), [gate], { initialOpen: gate.key }));
    const names = [...mounted.container.querySelectorAll('.fy-attn-deck__top [data-agenda-option]')].map(button =>
      button.getAttribute('data-agenda-option'),
    );
    expect(names).toEqual(['Not good', 'Done']);
    await mounted.unmount();
  });

  it('answers the forward option as a plain choice, into the undo window', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [gate], { initialOpen: gate.key }));
    await press(buttonNamed(mounted, 'Done'));
    expect(pending(fake)).toEqual(['Done']);
    const held = fake.deferred.getSnapshot().pending[0]?.action;
    expect(held).toMatchObject({ kind: 'respond', response: { kind: 'multiple-choice', choice: 'Done' } });
    await mounted.unmount();
  });

  it('holds "Not good" for words: nothing is sent until a reason is written, then it rides as the note', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [gate], { initialOpen: gate.key }));
    await press(buttonNamed(mounted, 'Not good'));
    expect(pending(fake)).toEqual([]);
    const why = must(mounted.container.querySelector('[data-inbox-gate-why]'), 'the why composer');
    const box = must(why.querySelector<HTMLTextAreaElement>('textarea'), 'the reason box');
    const send = must(why.querySelector<HTMLButtonElement>('button[type="submit"]'), 'Send back');
    expect(send.disabled).toBe(true);
    await interact(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(box, 'The code is blank');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await press(send);
    expect(pending(fake)).toEqual(['Not good']);
    expect(fake.deferred.getSnapshot().pending[0]?.action).toMatchObject({
      response: { kind: 'multiple-choice', choice: 'Not good' },
      note: 'The code is blank',
    });
    await mounted.unmount();
  });

  it('"Not yet" on a one-option gate asks for words but does not need them, and sends the choice', async () => {
    const plan = inboxCard(
      gateItem('G3', 'F3', {
        subject: 'OK to build? Pairing QR',
        ask: choices('OK to build', 'Not yet'),
        gate: {
          cardId: 'F3',
          laneId: 'plan',
          laneName: 'Plan',
          entry: 1,
          projectId: 'p1',
          options: [{ id: 'o0', label: 'OK to build', outcome: 'next' }],
        },
      }),
      sessionView('sess-p', { config: { teammate: 'judson', name: 'Plan' } as never }),
    );
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [plan], { initialOpen: plan.key }));
    await press(buttonNamed(mounted, 'Not yet'));
    expect(pending(fake)).toEqual([]);
    const send = must(
      mounted.container.querySelector<HTMLButtonElement>('[data-inbox-gate-why] button[type="submit"]'),
      'the send button',
    );
    expect(send.disabled).toBe(false);
    await press(send);
    expect(pending(fake)).toEqual(['Not yet']);
    await mounted.unmount();
  });

  it('Cancel on the why composer sends nothing and keeps the card', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [gate], { initialOpen: gate.key }));
    await press(buttonNamed(mounted, 'Not good'));
    await press(
      must(
        [...mounted.container.querySelectorAll<HTMLButtonElement>('[data-inbox-gate-why] button')].find(
          button => button.textContent === 'Cancel',
        ),
        'Cancel',
      ),
    );
    expect(mounted.container.querySelector('[data-inbox-gate-why]')).toBeNull();
    expect(pending(fake)).toEqual([]);
    expect(mounted.container.querySelector('[data-inbox-gate]')).not.toBeNull();
    await mounted.unmount();
  });
});

describe('the card’s plain buttons for the compass moves', () => {
  it('Skip goes to the next card and sends nothing', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [question, gate], { initialOpen: question.key }));
    await openInfo(mounted);
    await press(tool(mounted, 'skip'));
    expect(pending(fake)).toEqual([]);
    expect(
      mounted.container.querySelector('.fy-attn-deck__top [data-agenda-view]')?.getAttribute('data-agenda-view'),
    ).toBe('G1');
    await mounted.unmount();
  });

  it('Not needed dismisses into the undo window, and Undo really brings the card back', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [question], { initialOpen: question.key }));
    await openInfo(mounted);
    await press(tool(mounted, 'not-needed'));
    expect(fake.deferred.getSnapshot().pending.map(entry => entry.action.kind)).toEqual(['dismiss']);
    await press(must(mounted.container.querySelector('[data-agenda-undo-button]'), 'Undo'));
    expect(pending(fake)).toEqual([]);
    await interact(() => fake.clock.advance(10_000));
    await flush();
    expect(fake.commits).toEqual([]);
    // The card is back: listed again, and nothing claims the Inbox is clear.
    expect(mounted.container.textContent).toContain(question.item.subject);
    expect(mounted.container.querySelector('[data-agenda-empty]')).toBeNull();
    await mounted.unmount();
  });

  it('Not needed is sent once the undo window closes', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [question], { initialOpen: question.key }));
    await openInfo(mounted);
    await press(tool(mounted, 'not-needed'));
    await interact(() => fake.clock.advance(6_000));
    await flush();
    expect(fake.commits.map(commit => commit.action.kind)).toEqual(['dismiss']);
    await mounted.unmount();
  });

  it('Snooze is the head clock: its first choice snoozes for an hour from now, and no separate Snooze buttons are drawn', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [question], { initialOpen: question.key }));
    expect(mounted.container.querySelector('[data-inbox-snooze]')).toBeNull();
    await press(must(mounted.container.querySelector('.fy-item-view__bar [data-agenda-snooze]'), 'the head clock'));
    await press(must(mounted.container.querySelector('[role="menuitem"]'), 'the first snooze choice'));
    const action = fake.deferred.getSnapshot().pending[0]?.action;
    expect(action?.kind).toBe('snooze');
    expect(Date.parse((action as { until: string }).until)).toBe(NOW + 3_600_000);
    await mounted.unmount();
  });

  it('draws no head clock where the machine cannot snooze, but keeps Skip and Not needed', async () => {
    const mounted = await mount(page(fakeInbox(), [question], { initialOpen: question.key }, () => false));
    expect(mounted.container.querySelector('[data-agenda-snooze]')).toBeNull();
    await openInfo(mounted);
    expect(tool(mounted, 'skip')).toBeDefined();
    expect(tool(mounted, 'not-needed')).toBeDefined();
    await mounted.unmount();
  });
});

describe('the arrow keys on a gate item', () => {
  const key = (target: Element, name: string) =>
    interact(() => target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })));
  const view = (mounted: Mounted): HTMLElement =>
    must(mounted.container.querySelector<HTMLElement>('.fy-attn-deck__top [data-agenda-view]'), 'the open item');

  it('→ answers the forward option and ← asks for the words first', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [gate], { initialOpen: gate.key }));
    await key(view(mounted), 'ArrowLeft');
    expect(pending(fake)).toEqual([]);
    expect(mounted.container.querySelector('[data-inbox-gate-why]')).not.toBeNull();
    await mounted.unmount();
    const forward = fakeInbox();
    const again = await mount(page(forward, [gate], { initialOpen: gate.key }));
    await key(view(again), 'ArrowRight');
    expect(pending(forward)).toEqual(['Done']);
    await again.unmount();
  });
});
