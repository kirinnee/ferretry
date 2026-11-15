/**
 * BOARD'S HOOKS, AS AGENDA'S ASK SURFACES USE THEM: the values the shell hands for `agenda.card-answer`,
 * `agenda.lane-proposal` and `agenda.card-reference` (`contract/app-hooks.ts`), narrowed and handed down by
 * `AgendaBoardProviders` exactly as the Agenda screens and the ferret panel bind them, then read by the real callers:
 * an item's Done · closes, a notice's Start and Close, and `&F12` in an ask's words. Each fails without the binding:
 * no provider (or a value of the wrong shape) draws the ask as it is drawn without Board.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { AgendaCardRow, AgendaItem } from '@ferretry/core-asks/contract';
import { interact, type Mounted, mount, must, WithAppHooks } from '@ferretry/app/testing';
import type { ReactNode } from 'react';
import {
  AGENDA_CARD_ANSWER_HOOK,
  AGENDA_CARD_REFERENCE_HOOK,
  AGENDA_LANE_PROPOSAL_HOOK,
  type AgendaLaneEditor,
} from '../../../../contract/app-hooks.ts';
import { fakeAnswer, fakeReference } from '../../../support/app/board-hooks.ts';
import {
  AgendaBoardProviders,
  AgendaCardBoard,
  agendaBoardHooks,
  laneEditorBook,
  laneEditorOf,
  useAgendaBoardHooks,
  useCardBoards,
} from '../../../../app/features/agenda/agenda-board-hooks.tsx';
import { AgendaInboxPage } from '../../../../app/features/agenda/agenda-inbox-page.tsx';
import type { AgendaInbox } from '../../../../app/hooks/use-agenda-inbox.ts';
import type { InboxCard } from '../../../../app/lib/agenda-inbox.ts';
import { AgendaCardsHost } from '../../../../app/features/agenda/agenda-cards-host.tsx';
import type { BoardTaskId } from '../../../../app/features/agenda/agenda-cards-list.tsx';
import { AgendaItemView } from '../../../../app/features/agenda/agenda-item-view.tsx';
import { agendaProse } from '../../../../app/features/agenda/agenda-prose.tsx';
import type { InboxAction } from '../../../../app/lib/agenda-inbox.ts';
import { daemonConnection, daemonId, ReferenceSurfaceProvider } from '../../../../app/shell.ts';
import {
  agendaItem,
  choices,
  fakeInbox,
  InboxHarness,
  inboxCard,
  LANE_PROPOSAL_ANSWERS,
  testLaneEditor,
} from '../../../support/app/agenda-inbox.tsx';
import { click, settle, typeInto } from '../../../support/app/dom-form.ts';
import { flush, laptop } from '../board-support.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const NOW = Date.parse('2026-08-01T12:00:00.000Z');

const bound = (
  provided: { cardAnswer?: unknown; laneProposal?: unknown; cardReference?: unknown },
  children: ReactNode,
  onNavigate: (to: string) => void = () => undefined,
) => (
  <AgendaBoardProviders
    hooks={agendaBoardHooks(laptop.daemonId, {
      cardAnswer: provided.cardAnswer,
      laneProposal: provided.laneProposal,
      cardReference: provided.cardReference,
    })}
    onNavigate={onNavigate}
  >
    {children}
  </AgendaBoardProviders>
);

const closing = (): AgendaItem => agendaItem('A9', { task: { id: 'F1' }, offerClose: true } as Partial<AgendaItem>);

const itemView = (onAct: (action: InboxAction) => void = () => undefined) => (
  <AgendaItemView
    busy={false}
    daemonId={laptop.daemonId}
    error={null}
    ferret="Zoe"
    history={[]}
    item={closing()}
    now={NOW}
    onAct={onAct}
    onClose={() => undefined}
    position={{ index: 0, total: 1 }}
    renderProse={text => text}
    swipeable
  />
);

const root = (): HTMLElement => must(view?.container, 'the view');
const chip = (): HTMLButtonElement | null => root().querySelector<HTMLButtonElement>('[data-agenda-done-close]');

describe('agenda.card-answer: an item’s Done · closes', () => {
  test('is offered once Board’s hook is bound, and closes the card through it once before the item resolves', async () => {
    const { answer, calls } = fakeAnswer();
    const acted: InboxAction[] = [];
    view = await mount(
      bound(
        { cardAnswer: answer },
        itemView(action => acted.push(action)),
      ),
    );
    await interact(() => flush());

    expect(must(chip(), 'the Done · closes button').getAttribute('aria-label')).toBe('Done · closes &F1');
    await interact(() => must(chip(), 'the button').click());
    await interact(() => flush());

    expect(calls).toEqual(['watch:F1', 'done:F1']);
    expect(acted).toEqual([{ kind: 'resolve', label: 'Done · closes &F1' }]);
  });

  test('is not offered without Board’s hook, nor for a value without the shape', async () => {
    view = await mount(bound({}, itemView()));
    await interact(() => flush());
    expect(chip()).toBeNull();
    await view.unmount();

    view = await mount(bound({ cardAnswer: { done: async () => ({ ok: true }) } }, itemView()));
    await interact(() => flush());
    expect(chip()).toBeNull();
  });

  test('is not offered for a card Board says is already closed', async () => {
    view = await mount(bound({ cardAnswer: fakeAnswer('closed').answer }, itemView()));
    await interact(() => flush());
    expect(chip()).toBeNull();
  });
});

describe('agenda.card-answer: a notice’s Start and Close', () => {
  const cards: readonly AgendaCardRow[] = [
    {
      task: { id: 'B1' as BoardTaskId },
      line: '&B1 Fix the scroller is waiting in Review, but no ferret is assigned.',
    },
  ];
  const notice = <AgendaCardsHost cards={cards} connection={laptop} />;
  const button = (selector: string): HTMLElement => must(root().querySelector<HTMLElement>(selector), selector);

  test('starts a ferret through Board’s hook, with the click’s key', async () => {
    const { answer, calls } = fakeAnswer();
    view = await mount(bound({ cardAnswer: answer }, notice));

    await click(button('[data-agenda-card-start]'));
    await settle();

    expect(calls).toEqual(['start:B1:key']);
    expect(root().textContent).toContain('Started: a new ferret is working on this card.');
  });

  test('closes through Board’s hook with the reason, and shows Board’s refusal in its words', async () => {
    const { answer, calls } = fakeAnswer();
    view = await mount(bound({ cardAnswer: answer }, notice));

    await click(button('[data-agenda-card-close]'));
    await typeInto(button('[data-agenda-card-reason]') as HTMLTextAreaElement, 'not needed');
    await click(button('[data-agenda-card-confirm-close]'));
    await settle();

    expect(calls).toEqual(['drop:B1:not needed']);
    expect(root().textContent).toContain('only the owner closes cards');
  });

  test('refuses Start without Board’s hook, saying where it can be done, and sends nothing', async () => {
    view = await mount(bound({}, notice));

    await click(button('[data-agenda-card-start]'));
    await settle();

    expect(root().textContent).toContain('Board is not reachable from here');
  });

  test('refuses, without a call, a notice card on another machine than the hook was built for', async () => {
    const { answer, calls } = fakeAnswer();
    const desk = daemonConnection({ daemonId: 'daemon/desk' });
    view = await mount(bound({ cardAnswer: answer }, <AgendaCardsHost cards={cards} connection={desk} />));

    await click(button('[data-agenda-card-start]'));
    await settle();

    expect(calls).toEqual([]);
    expect(root().textContent).toContain('on another machine');
  });
});

describe('agenda.card-reference: `&F12` in an ask’s words', () => {
  const prose = agendaProse()('Try &F12, not &F13.');
  const links = (): readonly HTMLAnchorElement[] => [...root().querySelectorAll<HTMLAnchorElement>('a')];

  test('links a card Board proves, and opens it on Board’s page', async () => {
    const reference = fakeReference();
    const opened: string[] = [];
    view = await mount(bound({ cardReference: reference }, prose, to => opened.push(to)));
    await interact(() => flush());

    expect(reference.watched).toEqual(['ids']);
    expect(links().map(link => link.textContent)).toEqual(['&F12']);
    await interact(() => must(links()[0], 'the &F12 link').click());
    expect(opened).toEqual(['/board-card/F12']);
  });

  test('stays prose without Board’s hook: syntax is not proof', async () => {
    view = await mount(bound({}, prose));
    await interact(() => flush());
    expect(links()).toEqual([]);
    expect(root().textContent).toContain('Try &F12, not &F13.');
  });

  test('leaves a surface that already proves cards as it is', async () => {
    const reference = fakeReference();
    view = await mount(
      <ReferenceSurfaceProvider surface={{ taskReferenceResolver: id => id === 'F13', onTaskOpen: () => undefined }}>
        {bound({ cardReference: reference }, prose)}
      </ReferenceSurfaceProvider>,
    );
    await interact(() => flush());

    expect(reference.watched).toEqual([]);
    expect(links().map(link => link.textContent)).toEqual(['&F13']);
  });
});

describe('agenda.lane-proposal and the hooks outside a shell', () => {
  test('the Inbox’s lane editor is Board’s editorFor, and nothing without the hook', () => {
    const hooks = agendaBoardHooks(laptop.daemonId, {
      cardAnswer: undefined,
      laneProposal: { editorFor: testLaneEditor },
      cardReference: undefined,
    });
    expect(laneEditorOf(hooks)).toBe(testLaneEditor);
    expect(
      laneEditorOf(agendaBoardHooks(laptop.daemonId, { cardAnswer: 1, laneProposal: {}, cardReference: null })),
    ).toBeUndefined();
  });

  test('outside a shell no hook is provided, so every surface draws as it does without Board', async () => {
    const seen: ReturnType<typeof useAgendaBoardHooks>[] = [];
    function Probe() {
      seen.push(useAgendaBoardHooks(laptop.daemonId));
      return null;
    }
    view = await mount(<Probe />);
    expect(seen.at(-1)).toEqual({
      daemonId: laptop.daemonId,
      cardAnswer: undefined,
      laneProposal: undefined,
      cardReference: undefined,
    });
  });
});

describe('the Inbox is every machine’s: Board’s hooks are read per card’s machine', () => {
  const desk = daemonId('daemon/desk');
  const there = daemonId('daemon/laptop');

  describe('the lane editors of the machines on screen', () => {
    const upon =
      (tag: string): AgendaLaneEditor =>
      ask =>
        `/${tag}/${ask.sourceRef}`;
    const ask = { sourceRef: 'lanes:P1:3' };
    const edit = { kind: 'respond', response: { kind: 'multiple-choice', choice: 'Edit' } } as unknown as InboxAction;

    test('answers each machine from its own editor, and nothing for a machine that registered none', () => {
      const book = laneEditorBook();
      book.register(desk, upon('desk'));
      book.register(there, upon('laptop'));
      book.register(daemonId('daemon/none'), undefined);
      expect([desk, there, daemonId('daemon/none')].map(id => book.editorFor(id, ask, edit as never))).toEqual([
        '/desk/lanes:P1:3',
        '/laptop/lanes:P1:3',
        undefined,
      ]);
    });

    test('keeps a machine’s editor until its last card goes, then forgets it', () => {
      const book = laneEditorBook();
      const first = book.register(desk, upon('first'));
      const second = book.register(desk, upon('second'));
      expect(book.editorFor(desk, ask, edit as never)).toBe('/second/lanes:P1:3');
      second();
      expect(book.editorFor(desk, ask, edit as never)).toBe('/first/lanes:P1:3');
      first();
      expect(book.editorFor(desk, ask, edit as never)).toBeUndefined();
    });
  });

  /** An open card of `daemon`, with the Inbox page binding Board per card exactly as the screens do. */
  const Page = ({ cards, open, navigated }: { cards: InboxCard[]; open: string; navigated: string[] }) => (
    <InboxHarness
      cards={cards}
      fake={fakeInbox()}
      render={inbox => <BoundPage inbox={inbox} navigated={navigated} open={open} />}
    />
  );
  function BoundPage({ inbox, open, navigated }: { inbox: AgendaInbox; open: string; navigated: string[] }) {
    const { laneEditor, cardBoard } = useCardBoards(to => navigated.push(to));
    return (
      <AgendaInboxPage
        cardBoard={cardBoard}
        inbox={{ ...inbox, laneEditor }}
        initialOpen={open}
        now={NOW}
        onNavigate={to => navigated.push(to)}
        phone
      />
    );
  }
  const onDesk = inboxCard(
    agendaItem('A9', {
      why: 'Try &F12 on the desk.',
      ask: choices('Ship', 'Hold'),
      task: { id: 'F1' },
      offerClose: true,
    } as Partial<AgendaItem>),
    undefined,
    'Desk',
    desk,
  );
  const proposal = inboxCard(
    agendaItem('A7', {
      sourceRef: 'lanes:P1:3',
      ask: choices(LANE_PROPOSAL_ANSWERS.accept, LANE_PROPOSAL_ANSWERS.edit),
    } as Partial<AgendaItem>),
    undefined,
    'Desk',
    desk,
  );
  const shell = (provided: Record<string, Record<string, unknown>>, children: ReactNode) => (
    <WithAppHooks onDaemon={provided} provided={{}}>
      {children}
    </WithAppHooks>
  );

  test('Done · closes on another machine’s card goes to that machine’s Board, not the page’s', async () => {
    const mine = fakeAnswer();
    const theirs = fakeAnswer();
    view = await mount(
      shell(
        { [there]: { [AGENDA_CARD_ANSWER_HOOK]: mine.answer }, [desk]: { [AGENDA_CARD_ANSWER_HOOK]: theirs.answer } },
        <Page cards={[onDesk]} navigated={[]} open={onDesk.key} />,
      ),
    );
    await interact(() => flush());
    await interact(() => must(chip(), 'the Done · closes button').click());
    await interact(() => flush());

    expect(theirs.calls).toContain('done:F1');
    expect(mine.calls).toEqual([]);
  });

  test('`&F12` in another machine’s card proves against that machine’s Board only', async () => {
    const mine = fakeReference();
    const theirs = fakeReference();
    const unproved = { ...mine, proves: () => () => false };
    view = await mount(
      shell(
        { [there]: { [AGENDA_CARD_REFERENCE_HOOK]: unproved }, [desk]: { [AGENDA_CARD_REFERENCE_HOOK]: theirs } },
        <Page cards={[onDesk]} navigated={[]} open={onDesk.key} />,
      ),
    );
    await interact(() => flush());

    expect(theirs.watched).toEqual(['ids']);
    expect(mine.watched).toEqual([]);
    expect([...root().querySelectorAll('a')].map(link => link.textContent)).toContain('&F12');
  });

  test('Edit on another machine’s lane proposal opens that machine’s lane editor', async () => {
    const navigated: string[] = [];
    view = await mount(
      shell(
        {
          [desk]: {
            [AGENDA_LANE_PROPOSAL_HOOK]: {
              editorFor: (ask: { sourceRef?: string | null }) => `/desk-lanes/${ask.sourceRef}`,
            },
          },
        },
        <Page cards={[proposal]} navigated={navigated} open={proposal.key} />,
      ),
    );
    await interact(() => flush());
    await interact(() =>
      must(root().querySelector<HTMLButtonElement>('[data-agenda-option="Edit"]'), 'the Edit button').click(),
    );

    expect(navigated).toContain('/desk-lanes/lanes:P1:3');
  });

  test('a notice’s Start on another machine goes to that machine’s Board, not refused', async () => {
    const theirs = fakeAnswer();
    const cards: readonly AgendaCardRow[] = [{ task: { id: 'B1' as BoardTaskId }, line: '&B1 is waiting.' }];
    view = await mount(
      shell(
        { [desk]: { [AGENDA_CARD_ANSWER_HOOK]: theirs.answer } },
        <AgendaCardBoard daemonId={desk} editors={laneEditorBook()} onNavigate={() => undefined}>
          <AgendaCardsHost cards={cards} connection={daemonConnection({ daemonId: desk })} />
        </AgendaCardBoard>,
      ),
    );

    await click(must(root().querySelector<HTMLElement>('[data-agenda-card-start]'), 'Start'));
    await settle();

    expect(theirs.calls).toEqual(['start:B1:key']);
    expect(root().textContent).not.toContain('on another machine');
  });
});
