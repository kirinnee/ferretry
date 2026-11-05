/**
 * A CARD'S OWN AGENDA, open in the real Inbox page (built and screenshotted by `own-card-ask-screenshot.ts`): its ONE ask
 * is drawn inside "What I need from you" — how to try it, one tap, and the words typed under the card.
 *
 *   ?state=preview    a try-it whose card links a preview: "Try it on the preview" first, the steps, the shipped version
 *   ?state=real       a try-it with no preview: it says where to try it for real
 *   ?state=typed      the same, with what is wrong typed in the box under the card
 *   ?state=approval   a gate that is not a try-it: "OK to build?", the lane's own option, words ask for changes first
 *
 * The composer is the Inbox's own stand-in box wired to the page's typed answer (`renderComposer`'s third argument), so the
 * words go where they do for real. Everything is invented; nothing is sent.
 */

import type { AgendaGate, AgendaItem } from '@ferretry/protocol';
import { createRoot } from 'react-dom/client';
import { AgendaInboxPage } from '../src/features/agenda/agenda-inbox-page.tsx';
import { agendaItem, fakeInbox, InboxHarness, inboxCard } from '../tests/support/agenda-inbox.tsx';
import { sessionView } from '../tests/support/sessions.ts';

const STATE = new URLSearchParams(location.search).get('state') ?? 'preview';
const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const PHONE = window.innerWidth < 768;

const tryGate: AgendaGate = {
  cardId: 'F61',
  laneId: 'released',
  laneName: 'Released',
  entry: 4,
  projectId: 'p1',
  projectName: 'Ferretry',
  cardTitle: 'Pairing a second phone',
  options: [
    { id: 'done', label: 'Done', outcome: 'close' },
    { id: 'not-good', label: 'Not good', outcome: 'reopen-with-agenda' },
  ],
};
const planGate: AgendaGate = {
  ...tryGate,
  laneId: 'plan',
  laneName: 'Plan',
  options: [{ id: 'ok', label: 'OK to build', outcome: 'next' }],
};

const STEPS = [
  '1. **Where:** the Mac, in the app, Settings › Devices.',
  '2. **Do:** tap "Pair another device" and scan the code with your second phone.',
  '3. **See:** the phone lands on the Inbox and the Mac lists it under Devices.',
].join('\n');
const PREVIEW = '**Try it on the preview:** https://pairing-a-second-phone.ferretry.pages.dev/settings/devices';
const SHIPPED =
  'Shipped in Ferretry v5.4.0 (https://github.com/kirinnee/ferretry/pull/1402). Update to it to try it for real: run fy daemon update, then reload the app.';
const NO_PREVIEW = 'There is no preview for this one. Try it for real: the steps below say where.';

const asks = (): { gate: AgendaGate; subject: string; howToTest?: string; stage: 'test' | 'plan' } =>
  STATE === 'approval'
    ? {
        gate: planGate,
        subject: 'OK to build? Pairing a second phone',
        howToTest: '1. Add a pairing code screen.\n2. Keep pairing direct: a relayed session cannot pair.',
        stage: 'plan',
      }
    : {
        gate: tryGate,
        subject: 'Try it: Pairing a second phone',
        howToTest:
          STATE === 'preview' ? `${PREVIEW}\n\n${STEPS}\n\n${SHIPPED}` : `${NO_PREVIEW}\n\n${STEPS}\n\n${SHIPPED}`,
        stage: 'test',
      };

const make = (): ReturnType<typeof inboxCard> => {
  const ask = asks();
  const item = agendaItem('A404', {
    title: 'Pairing a second phone',
    kind: 'reply',
    ask: { kind: 'open-question' },
    subject: ask.subject,
    why: '&F61 reached Released on Ferretry.',
    raisedBy: 'daemon',
    source: 'task',
    sourceRef: 'card-agenda:F61',
    task: { id: 'F61' },
    stage: ask.stage,
    waitingSince: new Date(NOW - 20 * 60_000).toISOString(),
    gateAttached: ask.gate,
    cardAsks: [{ gate: ask.gate, at: new Date(NOW - 20 * 60_000).toISOString(), howToTest: ask.howToTest }],
  } as unknown as Partial<AgendaItem>);
  return inboxCard(item, sessionView('sess-1', { config: { teammate: 'zoe', name: 'Pairing' } as never }), 'Mac');
};

const cards = [make()];
const fake = fakeInbox();
const TYPED = 'It scanned, but the Mac still lists no second device after a minute.';

function Composer({
  typed,
}: {
  readonly typed: { readonly send: (send: { message: string }) => void; readonly placeholder: string } | undefined;
}) {
  return (
    <form
      className="fy-inbox-composer__fixture"
      onSubmit={event => {
        event.preventDefault();
        const field = event.currentTarget.elements.namedItem('words');
        if (field instanceof HTMLTextAreaElement) typed?.send({ message: field.value });
      }}
      style={{ display: 'flex', gap: 8, alignItems: 'flex-end', padding: '8px 0' }}
    >
      <textarea
        aria-label="Message"
        className="kt-input"
        data-fixture-composer=""
        defaultValue={STATE === 'typed' ? TYPED : ''}
        name="words"
        placeholder={typed?.placeholder ?? 'Reply to Zoe…'}
        rows={2}
        style={{ flex: 1, font: 'inherit', padding: 10, borderRadius: 12, border: '1px solid var(--border, #888)' }}
      />
      <button className="kt-btn" data-fixture-send="" type="submit">
        Send
      </button>
    </form>
  );
}

function Page() {
  return (
    <div className="kt-shell flex h-dvh min-h-0 flex-col overflow-hidden px-1 sm:px-3" data-fixture="">
      <InboxHarness
        cards={cards}
        fake={fake}
        reading={false}
        render={inbox => (
          <AgendaInboxPage
            clock={fake.clock.now}
            {...(cards[0] === undefined ? {} : { initialOpen: cards[0].key })}
            inbox={inbox}
            now={NOW}
            onNavigate={() => undefined}
            phone={PHONE}
            reducedMotion
            renderComposer={(_card, _form, typed) => <Composer typed={typed} />}
          />
        )}
      />
    </div>
  );
}

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(<Page />);
