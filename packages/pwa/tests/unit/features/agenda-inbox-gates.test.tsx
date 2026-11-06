import { describe, expect, it } from 'bun:test';
import { type AgendaGate, type AgendaItem, gateAskOptions, gateReference } from '@ferretry/protocol';
import { useState } from 'react';
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
import { laptop } from '../board-support.ts';
import {
  mouseIsLastPointer,
  plainSendBackEditor,
  sendBackBox,
  sendBackSubmit,
  writeSendBack,
} from './send-back-support.ts';

plainSendBackEditor();

const NOW = Date.parse('2026-08-01T12:00:00.000Z');

const GATE_OPTIONS: Pick<AgendaGate, 'options'> = {
  options: [
    { id: 'o0', label: 'Done', outcome: 'close' },
    { id: 'o1', label: 'Not good', outcome: 'reopen-with-agenda' },
  ],
};

const gateItem = (id: string, cardId: string, extra: Partial<AgendaItem> = {}): AgendaItem =>
  agendaItem(id, {
    subject: 'Try it: open the pairing page',
    why: 'Pairing QR is in Tested.',
    premise: 'Pairing QR is in Tested.',
    body: '1. Open the pairing page\n2. Scan the code',
    kind: 'choice',
    raisedBy: 'daemon',
    raisedBySession: null,
    ask: { kind: 'multiple-choice', options: gateAskOptions(GATE_OPTIONS) } as AgendaItem['ask'],
    gate: {
      cardId,
      laneId: 'tested',
      laneName: 'Tested',
      entry: 1,
      projectId: 'p1',
      projectName: 'Ferretry',
      options: [...GATE_OPTIONS.options],
    },
    ...extra,
  } as Partial<AgendaItem>);

const owner = sessionView('sess-g', { config: { teammate: 'judson', name: 'Pairing QR' } as never });
const gate = inboxCard(gateItem('G1', 'F1'), owner);
const question = inboxCard(
  agendaItem('A2', { subject: 'Rebase?', ask: choices('Rebase now', 'Wait') }),
  sessionView('sess-q', { config: { teammate: 'zoe', name: 'Fix the build' } as never }),
);

const page = (fake: FakeInbox, cards: readonly InboxCard[], props: Partial<AgendaInboxPageProps> = {}) => (
  <InboxHarness
    cards={cards}
    fake={fake}
    reading={false}
    render={inbox => (
      <AgendaInboxPage
        clock={fake.clock.now}
        inbox={{ ...inbox, connectionFor: () => laptop }}
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
  press(must(mounted.container.querySelector('.fy-attn-deck__top [data-agenda-menu-toggle]'), 'the ⋯'));
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
    expect(line.querySelector('[data-card-kind="task"]')?.textContent).toBe('Test');
    expect(line.querySelector('[data-inbox-gate-project]')?.textContent).toBe('Ferretry');
    expect(line.querySelector('[data-inbox-open-chat]')?.textContent).toContain('Open chat');
    expect(mounted.container.querySelectorAll('[data-inbox-who]').length).toBe(1);
    expect(mounted.container.textContent).toContain('Scan the code');
    await mounted.unmount();
  });

  it('draws no dot where the project has no words: the line opens on the ferret', async () => {
    const noProject = inboxCard(
      gateItem('G8', 'F8', { gate: { ...gateItem('G8', 'F8').gate, projectName: '' } } as never),
      owner,
    );
    const mounted = await mount(page(fakeInbox(), [noProject], { initialOpen: noProject.key }));
    const facts = must(mounted.container.querySelector('[data-inbox-gate] .fy-meta-line__facts'), 'the facts');
    expect(facts.querySelector('[data-inbox-gate-project]')).toBeNull();
    expect(facts.querySelector('[data-inbox-who-ferret]')?.textContent).toBe('Judson');
    expect(facts.querySelector('.fy-meta-line__dot')).toBeNull();
    await mounted.unmount();
  });

  it('says "OK to build?" for the approval gate', async () => {
    const approve = inboxCard(
      gateItem('G2', 'F2', { subject: 'OK to build? Pairing QR' }),
      sessionView('sess-h', { config: { teammate: 'judson', name: 'Plan' } as never }),
    );
    const mounted = await mount(page(fakeInbox(), [approve], { initialOpen: approve.key }));
    expect(mounted.container.querySelector('[data-card-kind="task"]')?.textContent).toBe('Approve');
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
    expect(mounted.container.querySelector('.fy-attn-deck__top [data-card-kind="task"]')?.textContent).toBe('Test');
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

  it('keeps the title on one line, as every open item does: never wrapped, never drawn twice', async () => {
    const mounted = await mount(page(fakeInbox(), [gate], { initialOpen: gate.key }));
    expect(mounted.container.querySelector('.fy-attn-deck__top [data-agenda-title]')?.hasAttribute('data-wrap')).toBe(
      false,
    );
    expect(mounted.container.querySelector('[data-agenda-full-title]')).toBeNull();
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
    const why = sendBackBox(mounted.container);
    const send = sendBackSubmit(why);
    expect(send.disabled).toBe(true);
    await writeSendBack(why, 'The code is blank');
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
    const send = sendBackSubmit(sendBackBox(mounted.container));
    expect(send.disabled).toBe(false);
    await press(send);
    expect(pending(fake)).toEqual(['Not yet']);
    await mounted.unmount();
  });

  describe('with files', () => {
    const attachId = `att_${'b'.repeat(64)}`;
    const ports = (takes: boolean) => {
      const uploaded: Array<[string, string]> = [];
      return {
        uploaded,
        ports: {
          sendBackFiles: async () => false,
          answerFiles: async () => takes,
          uploadAttachment: async (_daemon: unknown, sessionId: string, file: File) => {
            uploaded.push([sessionId, file.name]);
            return {
              id: attachId,
              filename: file.name,
              mime: file.type,
              size: file.size,
              sha256: '0'.repeat(64),
              createdAt: '2026-10-30T10:00:00.000Z',
            };
          },
        },
      };
    };
    const host = (given: ReturnType<typeof ports>['ports'] | undefined) => ({
      actions: {} as never,
      ports: given,
      connectionOf: () => laptop,
    });
    const attach = (mounted: Mounted) =>
      mounted.container.querySelector<HTMLButtonElement>('[data-inbox-gate-why] button[data-composer-attach]');
    const pick = async (mounted: Mounted) => {
      const picker = must(
        mounted.container.querySelector<HTMLInputElement>('[data-inbox-gate-why] input[type="file"]:not([capture])'),
        'the file picker',
      );
      Object.defineProperty(picker, 'files', {
        configurable: true,
        value: [new File(['png'], 'blank.png', { type: 'image/png' })],
      });
      await interact(() => picker.dispatchEvent(new Event('change', { bubbles: true })));
      await flush();
    };

    it('offers "+" on a Not good once the machine takes them, and sends the ids from the item’s session', async () => {
      await mouseIsLastPointer();
      const fake = fakeInbox();
      const given = ports(true);
      const mounted = await mount(page(fake, [gate], { initialOpen: gate.key, toTestHost: host(given.ports) }));
      await press(buttonNamed(mounted, 'Not good'));
      await flush();
      expect(attach(mounted)).not.toBeNull();
      await pick(mounted);
      expect(given.uploaded).toEqual([['sess-g', 'blank.png']]);
      const why = sendBackBox(mounted.container);
      await writeSendBack(why, 'The code is blank');
      await press(sendBackSubmit(why));
      expect(fake.deferred.getSnapshot().pending[0]?.action).toMatchObject({
        note: 'The code is blank',
        attachments: { from: 'sess-g', ids: [attachId] },
      });
      await mounted.unmount();
    });

    it('sends no files when none were attached', async () => {
      await mouseIsLastPointer();
      const fake = fakeInbox();
      const mounted = await mount(page(fake, [gate], { initialOpen: gate.key, toTestHost: host(ports(true).ports) }));
      await press(buttonNamed(mounted, 'Not good'));
      await flush();
      const why = sendBackBox(mounted.container);
      await writeSendBack(why, 'The code is blank');
      await press(sendBackSubmit(why));
      expect(fake.deferred.getSnapshot().pending[0]?.action).not.toHaveProperty('attachments');
      await mounted.unmount();
    });

    it('draws no "+" on a machine that has not got them, or on a page with no way to upload', async () => {
      for (const given of [
        host(ports(false).ports),
        host(undefined),
        host({ sendBackFiles: async () => true } as never),
      ]) {
        const mounted = await mount(page(fakeInbox(), [gate], { initialOpen: gate.key, toTestHost: given }));
        await press(buttonNamed(mounted, 'Not good'));
        await flush();
        expect(attach(mounted)).toBeNull();
        await mounted.unmount();
      }
    });

    it('draws no "+" on "Not yet": it leaves the card where it is', async () => {
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
      const mounted = await mount(
        page(fakeInbox(), [plan], { initialOpen: plan.key, toTestHost: host(ports(true).ports) }),
      );
      await press(buttonNamed(mounted, 'Not yet'));
      await flush();
      expect(attach(mounted)).toBeNull();
      await mounted.unmount();
    });
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

  it('Snooze is in the head’s ⋯: its first choice snoozes for an hour from now, and no separate Snooze buttons are drawn', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [question], { initialOpen: question.key }));
    expect(mounted.container.querySelector('[data-inbox-snooze]')).toBeNull();
    await openInfo(mounted);
    await press(must(mounted.container.querySelector('[data-agenda-menu-snooze]'), 'the first snooze choice'));
    const action = fake.deferred.getSnapshot().pending[0]?.action;
    expect(action?.kind).toBe('snooze');
    expect(Date.parse((action as { until: string }).until)).toBe(NOW + 3_600_000);
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

describe('Not good on a card ask drawn on a thread', () => {
  const askOf = (cardId: string): AgendaGate => ({
    cardId,
    laneId: 'tested',
    laneName: 'Tested',
    entry: 1,
    projectId: 'p1',
    options: [...GATE_OPTIONS.options],
  });
  const thread = (cardId: string): InboxCard =>
    inboxCard(
      agendaItem('T1', {
        subject: 'Which colour for the badge?',
        ask: choices('Blue', 'Green'),
        gateAttached: askOf(cardId),
      } as Partial<AgendaItem>),
      owner,
    );

  it('answers the ask the owner tapped, even when the shown one changed while they typed', async () => {
    await mouseIsLastPointer();
    const fake = fakeInbox();
    let swap: (cards: readonly InboxCard[]) => void = () => undefined;
    function Swappable() {
      const [cards, setCards] = useState<readonly InboxCard[]>([thread('F2')]);
      swap = setCards;
      return page(fake, cards, { initialOpen: thread('F2').key });
    }
    const mounted = await mount(<Swappable />);
    await press(
      must(
        mounted.container.querySelector<HTMLButtonElement>(
          '.fy-attn-deck__top [data-agenda-attached-gate] [data-agenda-option="Not good"]',
        ),
        'the attached Not good',
      ),
    );
    await flush();
    const why = sendBackBox(mounted.container);
    // The ask drawn changes to the next card's while the owner types.
    await interact(() => swap([thread('F3')]));
    await writeSendBack(why, 'The code is blank');
    await press(sendBackSubmit(why));
    expect(fake.deferred.getSnapshot().pending[0]?.action).toMatchObject({
      gate: true,
      cardAsk: gateReference(askOf('F2')),
      note: 'The code is blank',
    });
    await mounted.unmount();
  });
});
