import '../../support/dom.ts';
import { afterEach, describe, expect, it } from 'bun:test';
import { AgendaInboxComposer } from '../../../src/features/agenda/agenda-inbox-composer.tsx';
import { AgendaInboxPage } from '../../../src/features/agenda/agenda-inbox-page.tsx';
import { type AgendaItem, ownAskDigest } from '@ferretry/protocol';
import type { AgendaInbox } from '../../../src/hooks/use-agenda-inbox.ts';
import type { InboxCard } from '../../../src/lib/agenda-inbox.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { documentDraftStore } from '../../../src/lib/drafts.ts';
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
const daemon = daemonConnection({ daemonId: 'workshop', baseUrl: 'https://workshop.example.test', deviceId: 'device' });

const shipIt = inboxCard(
  agendaItem('A2', { subject: 'Ship it?', ask: choices('Ship', 'Hold'), waitingSince: '2026-08-01T10:00:00.000Z' }),
  sessionView('sess-2', { config: { teammate: 'zoe', name: 'Release train' } as never }),
);
const rebase = inboxCard(
  agendaItem('A3', {
    subject: 'Rebase onto main?',
    ask: choices('Rebase now', 'Wait'),
    waitingSince: '2026-08-01T11:00:00.000Z',
  }),
  sessionView('sess-1', { config: { teammate: 'kai', name: 'Fix the build' } as never }),
);

const draftScope = (card: InboxCard) => ({ daemonId: daemon.daemonId, sessionId: card.view.config.id });

interface Sent {
  readonly sessionId: string;
  readonly message: string;
}

interface Rig {
  readonly fake: FakeInbox;
  readonly sent: Sent[];
  /** The inbox as the page last drew it. */
  readonly latest: () => AgendaInbox;
  readonly mounted: Mounted;
}

/** The page, a REAL Inbox composer under the open card, and the toast, over the fake inbox. */
const rig = async (
  cards: readonly InboxCard[],
  send: (sessionId: string, message: string) => Promise<unknown>,
  fake: FakeInbox = fakeInbox(),
): Promise<Rig> => {
  const sent: Sent[] = [];
  let latest: AgendaInbox | undefined;
  const api = {
    send: async (sessionId: string, request: { message: string }) => {
      sent.push({ sessionId, message: request.message });
      return send(sessionId, request.message) as never;
    },
  };
  const mounted = await mount(
    <InboxHarness
      cards={cards}
      fake={fake}
      render={inbox => {
        latest = inbox;
        return (
          <AgendaInboxPage
            clock={fake.clock.now}
            inbox={inbox}
            initialOpen={cards[0]?.key}
            now={NOW}
            onNavigate={() => undefined}
            phone
            reducedMotion
            renderComposer={(card, answerForm, typed) => (
              <AgendaInboxComposer
                answerForm={answerForm}
                {...(typed === undefined ? {} : { answerTyped: typed, typedPlaceholder: typed.placeholder })}
                clientFor={async () => api}
                compact
                connection={daemon}
                formKey={card.key}
                itemId={card.item.id}
                onReplied={message => inbox.replied.mark(card, message)}
                onRestored={() => inbox.replied.takeRestore(card.key)}
                restore={inbox.repliedState.restores.find(each => each.key === card.key)?.text}
                view={card.view}
              />
            )}
          />
        );
      }}
    />,
  );
  await settle();
  return { fake, sent, mounted, latest: () => must(latest, 'the inbox') };
};

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
  });
};

const editor = (mounted: Mounted): HTMLElement =>
  must(mounted.container.querySelector<HTMLElement>('.fy-composer [data-live-editor]'), 'the composer box');
/** Types into the box the way the platform does: a focus, then an insertion at the caret. */
const type = async (mounted: Mounted, text: string): Promise<void> => {
  const box = editor(mounted);
  await interact(() => box.focus());
  const event = new Event('beforeinput', { bubbles: true, cancelable: true });
  Object.assign(event, { inputType: 'insertText', data: text, dataTransfer: null });
  await interact(() => box.dispatchEvent(event));
};
const words = (mounted: Mounted): string => editor(mounted).textContent ?? '';
const deckAbout = (mounted: Mounted): string =>
  must(mounted.container.querySelector<HTMLElement>('.fy-attn-deck__top [data-agenda-view]'), 'the open card')
    .textContent ?? '';
const toast = (mounted: Mounted): HTMLElement | null =>
  mounted.container.querySelector<HTMLElement>('[data-agenda-replied-toast]');
const notice = (mounted: Mounted): HTMLElement | null =>
  mounted.container.querySelector<HTMLElement>('[data-agenda-replied-notice]');
const send = async (mounted: Mounted): Promise<void> => {
  await interact(() =>
    must(mounted.container.querySelector<HTMLFormElement>('form.fy-composer'), 'the composer form').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    ),
  );
  await settle();
};
const undo = async (mounted: Mounted): Promise<void> => {
  await interact(() =>
    must(mounted.container.querySelector<HTMLButtonElement>('[data-agenda-replied-toast] button'), 'Undo').click(),
  );
  await settle();
};

const keys = (cards: readonly InboxCard[]): string[] => cards.map(card => card.key);

afterEach(() => {
  documentDraftStore.clear(draftScope(shipIt));
  documentDraftStore.clear(draftScope(rebase));
});

describe('a reply from an Inbox card moves the Inbox on', () => {
  it('takes the card off every list at once, opens the next one and says so in a toast', async () => {
    const run = await rig([shipIt, rebase], async () => ({ disposition: 'queued', sendId: 'm1' }));
    await type(run.mounted, 'only after lunch');
    expect(deckAbout(run.mounted)).toContain('Ship it?');
    expect(words(run.mounted)).toBe('only after lunch');
    expect(run.latest().total).toBe(2);

    await send(run.mounted);

    expect(run.sent).toEqual([{ sessionId: 'sess-2', message: '!A2 only after lunch' }]);
    const inbox = run.latest();
    expect(keys(inbox.cards)).toEqual([rebase.key]);
    expect(inbox.total).toBe(1);
    // It is already under Replied, parked as the daemon will have it.
    expect(inbox.parked.map(card => card.key)).toEqual([shipIt.key]);
    expect(inbox.parked[0]?.item.parked?.reason).toBe('replied');
    // The deck moved on to the next card, with that card's own composer (empty).
    expect(deckAbout(run.mounted)).toContain('Rebase onto main?');
    expect(deckAbout(run.mounted)).not.toContain('Ship it?');
    expect(words(run.mounted)).toBe('');
    const shown = must(toast(run.mounted), 'the replied toast');
    expect(shown.textContent).toContain('Moved to Replied');
    expect(shown.querySelector('[role="status"]')).not.toBeNull();
    expect(shown.querySelector('[data-agenda-undo-button]')).not.toBeNull();
    await run.mounted.unmount();
  });

  it('puts the toast in its own row BEFORE the composer, so it never covers the box or Send', async () => {
    const run = await rig([shipIt, rebase], async () => ({ disposition: 'queued', sendId: 'm1' }));
    await type(run.mounted, 'only after lunch');
    await send(run.mounted);

    const shown = must(toast(run.mounted), 'the replied toast');
    const foot = must(shown.parentElement, 'the toast\x27s parent');
    expect(foot.matches('[data-inbox-deck-foot]')).toBe(true);
    const composer = must(foot.querySelector<HTMLElement>('[data-inbox-composer]'), 'the composer row');
    expect(shown.classList.contains('fy-attn-undo--inline')).toBe(true);
    expect(shown.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(composer.contains(shown)).toBe(false);
    expect(shown.contains(composer)).toBe(false);
    expect(run.mounted.container.querySelectorAll('[data-agenda-undo]').length).toBe(1);
    await run.mounted.unmount();
  });

  it('leaves the card, and the words, where they are when the send fails', async () => {
    const run = await rig([shipIt, rebase], async () => {
      throw new Error('The daemon is asleep.');
    });
    await type(run.mounted, 'only after lunch');

    await send(run.mounted);

    expect(run.latest().cards.map(card => card.key)).toEqual([shipIt.key, rebase.key]);
    expect(run.latest().total).toBe(2);
    expect(run.latest().parked).toEqual([]);
    expect(deckAbout(run.mounted)).toContain('Ship it?');
    expect(words(run.mounted)).toBe('only after lunch');
    expect(toast(run.mounted)).toBeNull();
    expect(run.mounted.container.querySelector('.fy-composer-error')?.textContent).toContain('The daemon is asleep.');
    await run.mounted.unmount();
  });

  it('Undo while the message still waits takes it back, puts the words in that card’s box and the card on the list', async () => {
    const run = await rig([shipIt, rebase], async () => ({ disposition: 'queued', sendId: 'm1' }));
    await type(run.mounted, 'only after lunch');
    await send(run.mounted);
    expect(deckAbout(run.mounted)).toContain('Rebase onto main?');

    await undo(run.mounted);

    expect(run.fake.withdrawn.map(each => each.sendId)).toEqual(['m1']);
    expect(run.fake.unsnoozed.map(card => card.key)).toEqual([shipIt.key]);
    expect(keys(run.latest().cards)).toEqual([shipIt.key, rebase.key]);
    expect(run.latest().parked).toEqual([]);
    expect(run.latest().total).toBe(2);
    // The card is open again, and its words are back in its own box — once.
    expect(deckAbout(run.mounted)).toContain('Ship it?');
    expect(words(run.mounted)).toBe('only after lunch');
    expect(run.latest().repliedState.restores).toEqual([]);
    expect(must(notice(run.mounted), 'the notice').textContent).toContain('back in the box');
    await run.mounted.unmount();
  });

  it('Undo after the ferret read the message only brings the card back, says why, and does not duplicate the words', async () => {
    const fake = fakeInbox();
    fake.withdrawal = 'taken';
    const run = await rig([shipIt, rebase], async () => ({ disposition: 'queued', sendId: 'm1' }), fake);
    await type(run.mounted, 'only after lunch');
    await send(run.mounted);

    await undo(run.mounted);

    expect(fake.withdrawn).toHaveLength(1);
    expect(keys(run.latest().cards)).toEqual([shipIt.key, rebase.key]);
    expect(deckAbout(run.mounted)).toContain('Ship it?');
    expect(words(run.mounted)).toBe('');
    expect(must(notice(run.mounted), 'the notice').textContent).toContain(
      'Back on your list — Zoe already read your reply',
    );
    await run.mounted.unmount();
  });

  it('does not even ask the queue when the transport delivered the message at once', async () => {
    const run = await rig([shipIt, rebase], async () => ({ disposition: 'delivered', sendId: 'm1' }));
    await type(run.mounted, 'only after lunch');
    await send(run.mounted);

    await undo(run.mounted);

    expect(run.fake.withdrawn).toEqual([]);
    expect(keys(run.latest().cards)).toEqual([shipIt.key, rebase.key]);
    expect(words(run.mounted)).toBe('');
    expect(must(notice(run.mounted), 'the notice').textContent).toContain('already read your reply');
    await run.mounted.unmount();
  });

  it('lets a board read that shows the ferret asking again override the reply', async () => {
    const run = await rig([shipIt, rebase], async () => ({ disposition: 'queued', sendId: 'm1' }));
    await type(run.mounted, 'only after lunch');
    await send(run.mounted);
    expect(keys(run.latest().cards)).toEqual([rebase.key]);

    // The next board read: the ferret came back with a NEW ask on the same item.
    const asked = { ...shipIt, item: { ...shipIt.item, waitingSince: '2026-08-01T11:30:00.000Z' } };
    await run.mounted.render(
      <InboxHarness
        cards={[asked, rebase]}
        fake={run.fake}
        render={inbox => <div data-total={inbox.total} data-keys={keys(inbox.cards).join(',')} />}
      />,
    );
    await settle();

    const seen = must(run.mounted.container.querySelector<HTMLElement>('[data-keys]'), 'the list');
    expect(seen.getAttribute('data-keys')).toBe(`${asked.key},${rebase.key}`);
    expect(seen.getAttribute('data-total')).toBe('2');
    expect(run.fake.replied.getSnapshot().entries).toEqual([]);
    await run.mounted.unmount();
  });

  it('keeps a try-it and its one Good in the Inbox when the owner types “works now” under the card’s own ask', async () => {
    const gate = {
      cardId: 'F907',
      laneId: 'released',
      laneName: 'Released',
      entry: 2,
      projectId: 'p1',
      options: [
        { id: 'done', label: 'Done', outcome: 'close' },
        { id: 'not-good', label: 'Not good', outcome: 'reopen-with-agenda' },
      ],
    } as const;
    const tryIt = inboxCard(
      agendaItem('A404', {
        subject: 'Try it: Released',
        kind: 'reply',
        ask: { kind: 'open-question' },
        raisedBy: 'daemon',
        source: 'task',
        sourceRef: 'card-agenda:F907',
        // What the daemon records for the subject it wrote (`generatedSubject`).
        generatedSubject: 'Try it: Released',
        gateAttached: gate,
        cardAsks: [{ gate, at: '2026-08-01T11:00:00.000Z' }],
      } as never),
      sessionView('sess-5', { config: { teammate: 'zoe', name: 'Badge' } as never }),
    );
    const run = await rig([tryIt], async () => ({ disposition: 'delivered', sendId: 'm1' }));
    await type(run.mounted, 'works now');

    await send(run.mounted);

    // It went as an ordinary reply about the item, not as Not good...
    expect(run.sent).toEqual([{ sessionId: 'sess-5', message: '!A404 works now' }]);
    // ...and it did NOT hide the item or park it: the ask is still open and its Good still waits.
    expect(keys(run.latest().cards)).toEqual([tryIt.key]);
    expect(run.latest().parked).toEqual([]);
    expect(run.fake.replied.getSnapshot().entries).toEqual([]);
    expect(toast(run.mounted)).toBeNull();
    expect(run.mounted.container.querySelectorAll('[data-agenda-answer-option]').length).toBe(1);
    expect(run.mounted.container.querySelector('[data-agenda-answer-option="Done"]')).not.toBeNull();
    await run.mounted.unmount();
  });
});

describe('an answer to the item’s own question, with a try-it waiting on the same item (&B165 round 2)', () => {
  const gate = {
    cardId: 'F12',
    laneId: 'released',
    laneName: 'Released',
    entry: 4,
    projectId: 'p1',
    cardTitle: 'Badge colour',
    options: [
      { id: 'done', label: 'Done', outcome: 'close' },
      { id: 'not-good', label: 'Not good', outcome: 'reopen-with-agenda' },
    ],
  } as const;
  const thread = {
    kind: 'reply',
    subject: 'Should a capacity request wait for the owner?',
    ask: { kind: 'open-question' },
    gateAttached: gate,
    cardAsks: [{ gate, at: '2026-08-01T11:00:00.000Z', howToTest: '1. Open the badge.\n2. See it is blue.' }],
  } as unknown as Partial<AgendaItem>;
  const open = inboxCard(
    agendaItem('A7', thread),
    sessionView('sess-7', { config: { teammate: 'zoe', name: 'Capacity' } as never }),
  );

  it('keeps the item in Needs you after the answer is sent: no Replied overlay, no toast', async () => {
    const run = await rig([open], async () => ({ disposition: 'queued', sendId: 'm1' }));
    // Before: the question is the one ask, the try-it only waits as a line.
    expect(run.mounted.container.querySelector('[data-agenda-card-ask-later]')).not.toBeNull();
    await type(run.mounted, 'No, it should not wait');

    await send(run.mounted);

    expect(run.sent).toEqual([{ sessionId: 'sess-7', message: '!A7 No, it should not wait' }]);
    // The daemon keeps the item in Needs you (a try-it still waits), so the app must not hide it for 30 s.
    expect(keys(run.latest().cards)).toEqual([open.key]);
    expect(run.latest().parked).toEqual([]);
    expect(run.fake.replied.getSnapshot().entries).toEqual([]);
    expect(toast(run.mounted)).toBeNull();
    await run.mounted.unmount();
  });

  it('then shows the try-it at once: Good, one line for Not good, and no old question', async () => {
    const answered = inboxCard({ ...open.item, ownAskRepliedTo: ownAskDigest(open.item) } as AgendaItem, open.view);
    const run = await rig([answered], async () => ({ disposition: 'queued', sendId: 'm1' }));
    const root = run.mounted.container;
    expect(root.querySelector('[data-agenda-card-ask-later]')).toBeNull();
    expect(root.querySelectorAll('[data-agenda-answer-option]')).toHaveLength(1);
    expect(root.querySelector('[data-agenda-answer-option="Done"]')?.textContent).toContain('Good');
    expect(root.querySelector('[data-agenda-typed-lead]')?.textContent).toBe(
      'Not good? Type what is wrong below and send.',
    );
    // The title still names the thread; what the owner is asked (the block) is only the try-it.
    expect(root.querySelector('[data-agenda-part="needs"]')?.textContent).not.toContain(
      'Should a capacity request wait',
    );
    await run.mounted.unmount();
  });
});
