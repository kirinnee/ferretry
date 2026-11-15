/**
 * BOARD'S HOOKS, AS AGENDA'S ASK SURFACES USE THEM: the values the shell hands for `agenda.card-answer`,
 * `agenda.lane-proposal` and `agenda.card-reference` (`contract/app-hooks.ts`), narrowed and handed down by
 * `AgendaBoardProviders` exactly as the Agenda screens and the ferret panel bind them, then read by the real callers:
 * an item's Done · closes, a notice's Start and Close, and `&F12` in an ask's words. Each fails without the binding:
 * no provider (or a value of the wrong shape) draws the ask as it is drawn without Board.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { AgendaCardRow, AgendaItem } from '@ferretry/core-asks/contract';
import { ScreenHrefProvider } from '@ferretry/app';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import type { ReactNode } from 'react';
import { fakeAnswer, fakeReference } from '../../../support/app/board-hooks.ts';
import {
  AgendaBoardProviders,
  agendaBoardHooks,
  laneEditorOf,
  useAgendaBoardHooks,
} from '../../../../app/features/agenda/agenda-board-hooks.tsx';
import { AgendaCardsHost } from '../../../../app/features/agenda/agenda-cards-host.tsx';
import type { BoardTaskId } from '../../../../app/features/agenda/agenda-cards-list.tsx';
import { AgendaItemView } from '../../../../app/features/agenda/agenda-item-view.tsx';
import { agendaProse } from '../../../../app/features/agenda/agenda-prose.tsx';
import type { AgendaFerretReferences, AgendaReferenceFacts } from '../../../../app/lib/agenda-references.ts';
import type { InboxAction } from '../../../../app/lib/agenda-inbox.ts';
import { daemonConnection, ReferenceSurfaceProvider } from '../../../../app/shell.ts';
import { agendaItem, testLaneEditor } from '../../../support/app/agenda-inbox.tsx';
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
  references?: AgendaReferenceFacts,
) => (
  <AgendaBoardProviders
    hooks={agendaBoardHooks(laptop.daemonId, {
      cardAnswer: provided.cardAnswer,
      laneProposal: provided.laneProposal,
      cardReference: provided.cardReference,
    })}
    onNavigate={onNavigate}
    {...(references === undefined ? {} : { references })}
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

describe('Agenda’s own references: `!A3`, `:agent` and `@file` in an ask’s words', () => {
  const prose = agendaProse()('See !A3 and !A8, ask :aniya or :nobody, read @src/a.ts and @missing.ts.');
  const links = (): readonly HTMLAnchorElement[] => [...root().querySelectorAll<HTMLAnchorElement>('a')];
  const texts = () => links().map(link => link.textContent);
  const opened: Array<[string, string]> = [];
  const page = (over: Partial<AgendaFerretReferences> = {}): AgendaFerretReferences => ({
    id: 'f1',
    ledger: ['A3'],
    openAsk: () => undefined,
    showFiles: () => undefined,
    ...over,
  });
  const facts = (over: Partial<AgendaReferenceFacts> = {}): AgendaReferenceFacts => ({
    daemonId: laptop.daemonId,
    fleet: [{ config: { id: 'f2', teammate: 'aniya', cwd: '/repo' }, state: { status: 'working' } }],
    client: {
      call: async (_route: string, request?: { query?: Record<string, string> }) =>
        request?.query?.path === 'src' ? { entries: [{ name: 'a.ts', type: 'file' }] } : { entries: [] },
    } as never,
    fileOpen: { open: (ferret, path) => (opened.push([ferret, path]), true) },
    onNavigate: () => undefined,
    ...over,
  });
  const draw = async (
    references: AgendaReferenceFacts | undefined,
    navigate: (to: string) => void = () => undefined,
  ) => {
    view = await mount(
      <ScreenHrefProvider href={(daemon, _plugin, _screen, params) => `/${daemon}/chat/${params?.ferret ?? ''}`}>
        {bound({}, prose, navigate, references === undefined ? undefined : { ...references, onNavigate: navigate })}
      </ScreenHrefProvider>,
    );
    await interact(() => flush());
    await interact(() => flush());
  };

  afterEach(() => {
    opened.length = 0;
  });

  test('proves an item on the ferret’s ledger, an agent of the fleet and a listed file — and only those', async () => {
    const asks: string[] = [];
    const navigated: string[] = [];
    await draw(facts({ ferret: page({ openAsk: id => asks.push(id) }) }), to => navigated.push(to));

    expect(texts()).toEqual(['!A3', ':aniya', '@src/a.ts']);
    await interact(() => must(links()[0], 'the !A3 link').click());
    await interact(() => must(links()[1], 'the :aniya link').click());
    await interact(() => must(links()[2], 'the @src/a.ts link').click());
    expect(asks).toEqual(['A3']);
    expect(navigated).toEqual([`/${laptop.daemonId}/chat/f2`]);
    expect(opened).toEqual([['f1', 'src/a.ts']]);
  });

  test('proves only :agent where no ferret has a page of its own (the machine-wide Inbox)', async () => {
    await draw(facts());

    expect(texts()).toEqual([':aniya']);
  });

  test('proves no file without Ferrets’ opener, and no agent before the fleet is read', async () => {
    await draw(facts({ ferret: page(), fileOpen: undefined, fleet: null }));

    expect(texts()).toEqual(['!A3']);
  });

  test('stays prose with no facts at all', async () => {
    await draw(undefined);

    expect(links()).toEqual([]);
    expect(root().textContent).toContain('See !A3 and !A8');
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
