/**
 * The browser entry for "an agenda item is drawn as Durian hypermedia": the REAL Inbox page (`AgendaInboxPage`) opened on an
 * item, so the item is the REAL `AgendaItemView` inside the REAL swipe deck (with a second card peeking out behind it),
 * drawn by the REAL `agendaProse` through the shell's `ProseView`, over the app's registry of REAL halves, so `shell.prose`
 * is what Conversation really provides.
 *
 * References are proved the way the Inbox proves them: by the REAL `AgendaBoardProviders` (the Board proof scope, the page's
 * own daemon) over a fake Board that proves `F12` and nothing else, and every card is drawn inside the REAL
 * `TaskReferenceScope`. So `&F12` is a link that opens `/board-card/F12`, and `&F99` (Board has no such task) stays text.
 *
 *   ?theme=<family>-<mode>
 *   ?plain=1     no one provides `shell.prose`: the shell's own Markdown draws every segment (the height baseline)
 *   ?text=1      a body with text only (a heading, a list, bold, a quote): what the baseline and the real draw must agree on
 *   ?text=short  a short text-only item (no premise or context): the open card is as tall as its text, so the deck's height follows it
 *   ?notice=1    the open item is an FYI (no ask; its one button is Got it)
 *   ?off=1       Conversation is registered but this machine's daemon has it OFF: the shell's own Markdown draws
 *
 * Where a reference link goes is written to `document.documentElement.dataset.navigated`.
 */

import { WithRegisteredSurfaces } from '@ferretry/app/testing/settings-shell';
import { createRoot } from 'react-dom/client';
import { AgendaBoardProviders, agendaBoardHooks } from '../../../../app/features/agenda/agenda-board-hooks.tsx';
import { AgendaInboxPage } from '../../../../app/features/agenda/agenda-inbox-page.tsx';
import { daemonId, ProseView } from '../../../../app/shell.ts';
import { agendaItem, choices, fakeInbox, InboxHarness, inboxCard } from '../../../support/app/agenda-inbox.tsx';
import { fakeReference } from '../../../support/app/board-hooks.ts';
import { sessionView } from '../../../support/app/sessions.ts';

const params = new URLSearchParams(window.location.search);
const theme = params.get('theme') ?? 'studio-light';
document.documentElement.dataset.theme = theme;
document.documentElement.dataset.mode = theme.endsWith('dark') ? 'dark' : 'light';
const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const phone = window.innerWidth < 768;
const MACHINE = daemonId('laptop');

const TERMINAL = ['```terminal', '$ bun test', 'ok 3 tests', '```'].join('\n');
const TEXT = [
  '## Plan',
  '',
  'First, the **short** version of what the ferret found.',
  '',
  '- one thing',
  '- another thing, with `code` in it',
  '',
  '1. then this',
  '2. then that',
  '',
  '> a quoted line',
].join('\n');

/** Short enough that the open card is as tall as its text makes it, not as tall as the screen allows. */
const SHORT = ['## Plan', '', 'A **short** note.', '', '- one thing', '- another, with `code`'].join('\n');

const text = params.get('text');
const body =
  text === '1' ? TEXT : text === 'short' ? SHORT : `Here is the run:\n\n${TERMINAL}\n\nTracked as &F12, not &F99.`;

const item = agendaItem('A61', {
  title: 'Does the build pass?',
  subject: 'Does the build pass?',
  ...(text === 'short' ? {} : { premise: 'Decide whether the build passes.', context: 'See &F12 for the card.' }),
  body,
  why: 'The release waits for it.',
  waitingSince: '2026-08-01T10:00:00.000Z',
  // ?notice=1: an open FYI, which has no ask: its one button is Got it.
  ...(params.get('notice') === '1' ? { notice: true } : { ask: choices('Yes', 'No') }),
} as never);
// Waiting less long, so it is dealt AFTER the open one: the card that peeks out behind the top of the deck.
const next = agendaItem('A62', {
  title: 'Ship it?',
  subject: 'Ship it?',
  body,
  waitingSince: '2026-08-01T11:30:00.000Z',
  ask: choices('Yes', 'No'),
});
const view = sessionView('sess-1', { config: { teammate: 'durian', name: 'Fix the build' } });
const card = inboxCard(item, view, 'Laptop', MACHINE);
const behind = inboxCard(next, view, 'Laptop', MACHINE);
const fake = fakeInbox();
const board = fakeReference();

function Scene() {
  return (
    <>
      {params.get('off') === '1' ? (
        // The clock for "it never swapped": the same view, on a machine where Conversation is ON. Once Durian has drawn
        // this, its lazy view has loaded, and a card that still holds Markdown is held there by the standing, not by timing.
        <div data-sentinel="" style={{ position: 'fixed', right: 0, top: 0, width: 1, height: 1, overflow: 'hidden' }}>
          <WithRegisteredSurfaces daemon={MACHINE}>
            <ProseView text="sentinel" />
          </WithRegisteredSurfaces>
        </div>
      ) : null}
      <Inbox />
    </>
  );
}

function Inbox() {
  return (
    <WithRegisteredSurfaces
      blocked={params.get('off') === '1' ? ['conversation'] : []}
      daemon={MACHINE}
      none={params.get('plain') === '1'}
    >
      <AgendaBoardProviders
        hooks={agendaBoardHooks(MACHINE, { cardAnswer: undefined, laneProposal: undefined, cardReference: board })}
        onNavigate={to => {
          document.documentElement.dataset.navigated = to;
        }}
      >
        <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
          <InboxHarness
            cards={[card, behind]}
            fake={fake}
            render={inbox => (
              <AgendaInboxPage
                clock={fake.clock.now}
                initialOpen={card.key}
                inbox={inbox}
                now={NOW}
                onNavigate={to => {
                  document.documentElement.dataset.navigated = to;
                }}
                phone={phone}
                reducedMotion
              />
            )}
          />
        </div>
      </AgendaBoardProviders>
    </WithRegisteredSurfaces>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
