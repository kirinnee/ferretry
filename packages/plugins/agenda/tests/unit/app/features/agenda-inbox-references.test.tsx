/**
 * THE MACHINE-WIDE INBOX DEALS EVERY MACHINE'S ASKS OVER ONE PAGE'S REFERENCE FACTS. Those facts (the fleet `:kim` is proved
 * against, the board's `&F12`) belong to the PAGE'S daemon, so a card of another machine proves nothing from them: its
 * `:kim` and `&F12` stay prose, never a live link to this machine's kim or card (docs/reference-standard.md: a reference in
 * one daemon's transcript can never open a same-named session on another). A card of the page's own machine still links.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { ReferenceSurfaceProvider } from '@ferretry/app';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import {
  AgendaBoardProviders,
  agendaBoardHooks,
  CardReferenceScope,
} from '../../../../app/features/agenda/agenda-board-hooks.tsx';
import { agendaProse } from '../../../../app/features/agenda/agenda-prose.tsx';
import { AgendaInboxPage } from '../../../../app/features/agenda/agenda-inbox-page.tsx';
import type { AgendaReferenceFacts } from '../../../../app/lib/agenda-references.ts';
import { daemonId } from '../../../../app/shell.ts';
import { agendaItem, fakeInbox, InboxHarness, inboxCard } from '../../../support/app/agenda-inbox.tsx';
import { sessionView } from '../../../support/app/sessions.ts';
import { fakeReference } from '../../../support/app/board-hooks.ts';

const LAPTOP = daemonId('laptop');
const DESK = daemonId('desk');
const NOW = Date.parse('2026-08-01T12:00:00.000Z');

const words = agendaItem('A5', { subject: 'Rebase?', why: 'Ask :kim to rebase, then see &F12.' });
const cardOn = (daemon: typeof LAPTOP, machine: string) =>
  inboxCard(
    words,
    sessionView('sess-1', { config: { teammate: 'zoe', name: 'Fix the build' } as never }),
    machine,
    daemon,
  );

/** The page's facts: this laptop has a ferret named kim, and its board has `F12`. */
const facts: AgendaReferenceFacts = {
  daemonId: LAPTOP,
  fleet: [{ config: { id: 'kim-on-laptop', teammate: 'kim', cwd: '/repo' }, state: { status: 'working' } }] as never,
  client: { call: async () => ({ entries: [] }) } as never,
  fileOpen: undefined,
  onNavigate: () => undefined,
};

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

/** The reference links drawn in the open card, as [text, href] (plain data, so a failure prints readably). */
const drawn = async (card: ReturnType<typeof cardOn>): Promise<ReadonlyArray<readonly [string, string | null]>> => {
  const fake = fakeInbox();
  view = await mount(
    <AgendaBoardProviders
      hooks={agendaBoardHooks(LAPTOP, {
        cardAnswer: undefined,
        laneProposal: undefined,
        cardReference: fakeReference(),
      })}
      onNavigate={() => undefined}
      references={facts}
    >
      <InboxHarness
        cards={[card]}
        fake={fake}
        reading={false}
        render={inbox => (
          <AgendaInboxPage
            clock={fake.clock.now}
            inbox={inbox}
            initialOpen={card.key}
            now={NOW}
            onNavigate={() => undefined}
            phone
            reducedMotion
          />
        )}
      />
    </AgendaBoardProviders>,
  );
  await interact(async () => {
    for (let spin = 0; spin < 5; spin += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
  const root = must(view.container.querySelector<HTMLElement>('[data-inbox-open]'), 'the open card');
  expect(root.textContent).toContain('Ask :kim to rebase');
  return [...root.querySelectorAll<HTMLAnchorElement>('a')]
    .filter(link => /^[:&]/u.test(link.textContent ?? ''))
    .map(link => [link.textContent ?? '', link.getAttribute('href')] as const);
};

describe('the Inbox’s references, per card machine', () => {
  it('links :kim and &F12 in a card of the page’s own machine', async () => {
    const links = await drawn(cardOn(LAPTOP, 'Laptop'));

    expect(links.map(([text]) => text)).toEqual([':kim', '&F12']);
    expect(links[0]?.[1]).toBe('/d/laptop/session/kim-on-laptop');
  });

  it('leaves :kim and &F12 as prose in a card of ANOTHER machine, never linking this machine’s kim or card', async () => {
    const links = await drawn(cardOn(DESK, 'Desk'));

    expect(links).toEqual([]);
  });
});

describe('a card scope outside the providers', () => {
  it('leaves the surface it sits in as it is: there is no page whose proofs it could be refusing', async () => {
    view = await mount(
      <ReferenceSurfaceProvider surface={{ taskReferenceResolver: () => true, onTaskOpen: () => undefined }}>
        <CardReferenceScope daemonId={DESK}>{agendaProse()('see &F12')}</CardReferenceScope>
      </ReferenceSurfaceProvider>,
    );

    expect([...(view?.container.querySelectorAll('a') ?? [])].map(link => link.textContent)).toEqual(['&F12']);
  });
});
