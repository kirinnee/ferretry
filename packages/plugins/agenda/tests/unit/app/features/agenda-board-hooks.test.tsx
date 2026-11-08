/**
 * BOARD'S HOOKS, AS AGENDA'S ASK SURFACES USE THEM: the values the shell hands for `agenda.card-answer`,
 * `agenda.lane-proposal` and `agenda.card-reference` (`contract/app-hooks.ts`), narrowed and handed down by
 * `AgendaBoardProviders` exactly as the Agenda screens and the ferret panel bind them, then read by the real callers:
 * an item's Done · closes, a notice's Start and Close, and `&F12` in an ask's words. Each fails without the binding:
 * no provider (or a value of the wrong shape) draws the ask as it is drawn without Board.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { AgendaCardRow, AgendaItem } from '@ferretry/core-asks/contract';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import type { ReactNode } from 'react';
import type { AgendaCardAnswer, AgendaCardReference, AgendaCardView } from '../../../../contract/app-hooks.ts';
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

/** A stand-in for Board's `agenda.card-answer` hook: one card on the board, every call recorded. */
const fakeAnswer = (laneId = 'tested') => {
  const calls: string[] = [];
  const view: AgendaCardView = {
    status: 'ready',
    missing: false,
    title: 'Pair a second phone',
    closed: laneId === 'closed',
  };
  const answer: AgendaCardAnswer = {
    subscribe: () => () => undefined,
    watch: card => {
      calls.push(`watch:${card}`);
      return () => undefined;
    },
    card: () => view,
    done: async card => {
      calls.push(`done:${card}`);
      return { ok: true };
    },
    start: async (card, key) => {
      calls.push(`start:${card}:${key === '' ? 'no key' : 'key'}`);
      return { ok: true, value: { started: true, ferret: 'mvuc7tsf-0c3d50df' } };
    },
    drop: async (card, reason) => {
      calls.push(`drop:${card}:${reason}`);
      return { ok: false, status: 403, message: 'only the owner closes cards' };
    },
  };
  return { answer, calls };
};

/** A stand-in for Board's `agenda.card-reference` hook: `F12` is this machine's card, nothing else is. */
const fakeReference = (): AgendaCardReference & { readonly watched: string[] } => {
  const watched: string[] = [];
  const proves = (id: string) => id.toUpperCase() === 'F12';
  return {
    watched,
    subscribe: () => () => undefined,
    watch: () => {
      watched.push('ids');
      return () => undefined;
    },
    proves: () => proves,
    href: id => `/board-card/${id}`,
  };
};

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
