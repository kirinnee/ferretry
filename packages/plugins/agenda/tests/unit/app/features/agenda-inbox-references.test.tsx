/**
 * THE MACHINE-WIDE INBOX DEALS EVERY MACHINE'S ASKS OVER ONE PAGE'S REFERENCE FACTS. Those facts (the fleet `:kim` is proved
 * against, the board's `&F12`, the ledger's `^A3`, the listed `@file`) belong to the PAGE'S daemon, so a card of another
 * machine proves nothing from them: its references stay prose, never a live link to this machine's kim or card
 * (docs/reference-standard.md: a reference in one daemon's transcript can never open a same-named session on another).
 * A card of the page's own machine still links.
 *
 * The page binds Board per OPEN CARD's machine too (`AgendaCardBoard`, as the Agenda screen does), and that nested
 * provider names the CARD's machine: it must strip what the page's providers proved for the other one, or the card's
 * own scope would pass the page's proofs through (a fail-open). So the checks run at all three places a card is drawn.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { MACHINE_AGENDA_ID } from '@ferretry/core-asks/contract';
import type { ResolvedAgendaItem } from '@ferretry/core-asks/contract';
import { ReferenceSurfaceProvider } from '@ferretry/app';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import type { ReactNode } from 'react';
import {
  AgendaBoardProviders,
  agendaBoardHooks,
  TaskReferenceScope,
  useTaskBoards,
} from '../../../../app/features/agenda/agenda-board-hooks.tsx';
import { agendaProse } from '../../../../app/features/agenda/agenda-prose.tsx';
import { AgendaInboxPage, AgendaNeedsYou } from '../../../../app/features/agenda/agenda-inbox-page.tsx';
import { inboxCardKey, type InboxResolved } from '../../../../app/lib/agenda-inbox.ts';
import type { AgendaReferenceFacts } from '../../../../app/lib/agenda-references.ts';
import { daemonConnection, daemonId } from '../../../../app/shell.ts';
import { agendaItem, fakeInbox, InboxHarness, inboxCard } from '../../../support/app/agenda-inbox.tsx';
import { sessionView } from '../../../support/app/sessions.ts';
import { fakeReference } from '../../../support/app/board-hooks.ts';

const LAPTOP = daemonId('laptop');
const DESK = daemonId('desk');
const NOW = Date.parse('2026-08-01T12:00:00.000Z');

const WORDS = 'Ask :kim to rebase, see ^A3, read @src/a.ts and &F12.';
const words = agendaItem('A5', { subject: 'Rebase?', why: WORDS });
const cardOn = (daemon: typeof LAPTOP, machine: string) =>
  inboxCard(
    words,
    sessionView('sess-1', { config: { teammate: 'zoe', name: 'Fix the build' } as never }),
    machine,
    daemon,
  );

/** The page's facts: this laptop has a ferret named kim, `^A3` on the ferret's ledger, `src/a.ts`, and its board has `F12`. */
const facts: AgendaReferenceFacts = {
  daemonId: LAPTOP,
  fleet: [{ config: { id: 'kim-on-laptop', teammate: 'kim', cwd: '/repo' }, state: { status: 'working' } }] as never,
  client: {
    call: async (_route: string, request?: { query?: Record<string, string> }) =>
      request?.query?.path === 'src' ? { entries: [{ name: 'a.ts', type: 'file' }] } : { entries: [] },
  } as never,
  fileOpen: { open: () => true },
  ferret: { id: 'f1', ledger: ['A3'], openAsk: () => undefined, showFiles: () => undefined },
  onNavigate: () => undefined,
};

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

/** The page's providers for the LAPTOP (Board's card-reference hook and the facts), as the Agenda screen binds them. */
const onPage = (children: ReactNode) => (
  <AgendaBoardProviders
    hooks={agendaBoardHooks(LAPTOP, {
      cardAnswer: undefined,
      laneProposal: undefined,
      cardReference: fakeReference(),
    })}
    onNavigate={() => undefined}
    references={facts}
  >
    {children}
  </AgendaBoardProviders>
);

const settleAll = () =>
  interact(async () => {
    for (let spin = 0; spin < 5; spin += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });

/** The reference links drawn under `root`, as [text, href] (plain data, so a failure prints readably). */
const linksIn = (root: ParentNode): ReadonlyArray<readonly [string, string | null]> =>
  [...root.querySelectorAll<HTMLAnchorElement>('a')]
    .filter(link => /^[:&^@]/u.test(link.textContent ?? ''))
    .map(link => [link.textContent ?? '', link.getAttribute('href')] as const);

/** The page the screen draws: per-card Board, the way `createAgendaScreen` binds it. */
function TaskBoardPage({ inbox, open }: { inbox: Parameters<typeof AgendaInboxPage>[0]['inbox']; open?: string }) {
  const { cardBoard: taskBoard } = useTaskBoards(() => undefined);
  return (
    <AgendaInboxPage
      cardBoard={taskBoard}
      inbox={inbox}
      {...(open === undefined ? {} : { initialOpen: open })}
      now={NOW}
      onNavigate={() => undefined}
      phone
      reducedMotion
    />
  );
}

/** Site 2, `OpenItem`: the open card. */
const openCard = async (card: ReturnType<typeof cardOn>) => {
  const fake = fakeInbox();
  view = await mount(
    onPage(
      <InboxHarness
        cards={[card]}
        fake={fake}
        reading={false}
        render={inbox => <TaskBoardPage inbox={inbox} open={card.key} />}
      />,
    ),
  );
  await settleAll();
  const root = must(view.container.querySelector<HTMLElement>('[data-inbox-open]'), 'the open card');
  expect(root.textContent).toContain('Ask :kim');
  return linksIn(root);
};

/** Site 1, `renderInboxCard`: the compact card in the Needs-you deck. */
const listCard = async (card: ReturnType<typeof cardOn>) => {
  const fake = fakeInbox();
  view = await mount(
    onPage(
      <InboxHarness
        cards={[card]}
        fake={fake}
        reading={false}
        render={inbox => <AgendaNeedsYou daemonId={LAPTOP} inbox={inbox} now={NOW} onNavigate={() => undefined} />}
      />,
    ),
  );
  await settleAll();
  const root = must(view.container.querySelector<HTMLElement>('[data-agenda-needs-you]'), 'the Needs-you deck');
  expect(root.textContent).toContain('Ask :kim');
  return linksIn(root);
};

/** Site 3, the resolved machine view: a machine record opened from the Resolved filter (or a tapped push). */
const resolvedView = async (daemon: typeof LAPTOP) => {
  const fake = fakeInbox();
  const record = {
    ...agendaItem('A5', { subject: 'Rebase?', why: WORDS }),
    resolvedAt: '2026-08-01T09:00:00.000Z',
    resolvedBy: 'human',
    resolvedBySession: null,
    resolvedByName: null,
    resolutionNote: null,
    disposition: 'done',
  } as unknown as ResolvedAgendaItem;
  const machine = sessionView(MACHINE_AGENDA_ID, { config: { name: 'Machine' } as never });
  const row: InboxResolved = {
    key: inboxCardKey(daemon, MACHINE_AGENDA_ID, 'A5'),
    daemonId: daemon,
    machineName: 'Machine',
    view: machine,
    record,
  };
  view = await mount(
    onPage(
      <InboxHarness
        cards={[]}
        fake={fake}
        resolved={[row]}
        render={inbox => (
          <AgendaInboxPage
            inbox={{ ...inbox, connectionFor: () => daemonConnection({ daemonId: daemon }) }}
            now={NOW}
            onNavigate={() => undefined}
            open={{ daemonId: daemon, sessionId: MACHINE_AGENDA_ID, id: 'A5' as never, settled: true }}
            phone
            reducedMotion
          />
        )}
      />,
    ),
  );
  await settleAll();
  const root = must(view.container.querySelector<HTMLElement>('[data-inbox-open-resolved]'), 'the resolved view');
  expect(root.textContent).toContain('Ask :kim');
  return linksIn(root);
};

const OWN = [':kim', '^A3', '@src/a.ts', '&F12'];

describe('a card of ANOTHER machine, on this machine’s Inbox: nothing proved for this machine is live', () => {
  it('the Needs-you deck card keeps :kim, ^A3, @file and &F12 as prose', async () => {
    expect(await listCard(cardOn(DESK, 'Desk'))).toEqual([]);
  });

  it('the open card (under that machine’s own Board) keeps :kim, ^A3, @file and &F12 as prose', async () => {
    expect(await openCard(cardOn(DESK, 'Desk'))).toEqual([]);
  });

  it('the resolved machine view keeps :kim, ^A3, @file and &F12 as prose', async () => {
    expect(await resolvedView(DESK)).toEqual([]);
  });
});

describe('a card of the page’s own machine', () => {
  it('links :kim, ^A3, @file and &F12 in the Needs-you deck', async () => {
    const links = await listCard(cardOn(LAPTOP, 'Laptop'));

    expect(links.map(([text]) => text)).toEqual(OWN);
    expect(links[0]?.[1]).toBe('/d/laptop/session/kim-on-laptop');
  });

  it('links :kim, ^A3, @file and &F12 in the open card, though it sits under its own machine’s Board', async () => {
    const links = await openCard(cardOn(LAPTOP, 'Laptop'));

    expect(links.map(([text]) => text)).toEqual(OWN);
    expect(links[0]?.[1]).toBe('/d/laptop/session/kim-on-laptop');
  });

  it('links them in the resolved machine view', async () => {
    expect((await resolvedView(LAPTOP)).map(([text]) => text)).toEqual(OWN);
  });
});

describe('a nested provider for another machine', () => {
  it('removes the proofs above it before it adds its own: a second machine’s Board never inherits the first’s', async () => {
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
        <AgendaBoardProviders
          hooks={agendaBoardHooks(DESK, { cardAnswer: undefined, laneProposal: undefined, cardReference: undefined })}
          onNavigate={() => undefined}
        >
          <TaskReferenceScope daemonId={DESK}>{agendaProse()(WORDS)}</TaskReferenceScope>
        </AgendaBoardProviders>
      </AgendaBoardProviders>,
    );
    await settleAll();

    expect(linksIn(must(view.container, 'the view'))).toEqual([]);
  });
});

describe('a card scope outside the providers', () => {
  it('fails closed: nothing says whose proofs the surface carries, so it removes them', async () => {
    view = await mount(
      <ReferenceSurfaceProvider surface={{ taskReferenceResolver: () => true, onTaskOpen: () => undefined }}>
        <TaskReferenceScope daemonId={DESK}>{agendaProse()('see &F12')}</TaskReferenceScope>
      </ReferenceSurfaceProvider>,
    );

    expect([...(view?.container.querySelectorAll('a') ?? [])].map(link => link.textContent)).toEqual([]);
  });
});
