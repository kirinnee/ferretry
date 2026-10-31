import { afterEach, describe, expect, test } from 'bun:test';
import { type AgendaItem, boardErr, boardOk, DAEMON_FEATURES, type TaskRef } from '@ferretry/protocol';
import { AgendaItemView } from '../../../src/features/agenda/agenda-item-view.tsx';
import { AgendaQuickReplies } from '../../../src/features/agenda/agenda-quick-replies.tsx';
import { useDoneCloseFlow } from '../../../src/features/agenda/use-done-close-flow.ts';
import { useDoneClose } from '../../../src/hooks/use-done-close.ts';
import { AgendaWireDirectory } from '../../../src/lib/agenda-wire.ts';
import { itemOptions } from '../../../src/lib/agenda-options.ts';
import { cardModel } from '../../../src/lib/agenda-card-model.ts';
import { type InboxAction, swipeMap } from '../../../src/lib/agenda-inbox.ts';
import type { DoneCloseResult, DoneCloseSource } from '../../../src/lib/agenda-done-close.ts';
import { DaemonBoardStore } from '../../../src/lib/board-store.ts';
import { type AppStore, StoreProvider } from '../../../src/lib/store.tsx';
import { agendaItem, choices } from '../../support/agenda-inbox.tsx';
import { healthOf } from '../../support/health.ts';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
import { card, deferred, fakeEnvironment, fakePort, flush, laneSetFor, laptop } from '../board-support.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const lanes = laneSetFor();
const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const WITH_FEATURE = [DAEMON_FEATURES.agendaWire, DAEMON_FEATURES.agendaOfferClose];

const closing = (extra: Partial<AgendaItem> = {}): AgendaItem =>
  agendaItem('A9', { task: { id: 'F1' }, offerClose: true, ...extra } as Partial<AgendaItem>);

interface World {
  readonly store: AppStore;
  readonly board: DaemonBoardStore;
  readonly moves: string[];
  readonly respond: (result: unknown) => void;
}

/** An app store with the pieces the button reads: the wire directory, the pairing, and a board on a fake port. */
const world = (
  options: {
    readonly features?: string[];
    readonly task?: () => Promise<{ task: ReturnType<typeof card>; laneSet: typeof lanes } | null>;
    readonly act?: () => ReturnType<DaemonBoardStore['act']>;
  } = {},
): World => {
  const moves: string[] = [];
  const port = fakePort({
    task: options.task ?? (async () => ({ task: card('F1', { laneId: 'tested' }), laneSet: lanes })),
    act: async (_daemon, id, request) => {
      moves.push(`${id}:${request.action}:${'to' in request ? request.to : ''}`);
      if (options.act !== undefined) return (await options.act()) as never;
      return boardOk({ task: card(id, { laneId: 'closed' }), laneSet: lanes });
    },
  });
  const board = new DaemonBoardStore(port, fakeEnvironment());
  const wires = new AgendaWireDirectory();
  wires.note(laptop.daemonId, { kind: 'read', health: healthOf('4.120.0', options.features ?? WITH_FEATURE) });
  const store = {
    agendaWire: wires,
    connections: { list: () => [laptop] },
    board,
    attention: { respond: async () => undefined },
  } as unknown as AppStore;
  return { store, board, moves, respond: () => undefined };
};

const drawItem = async (
  item: AgendaItem,
  app: World | null,
  onAct: (action: InboxAction) => void = () => undefined,
  extra: { readonly daemon?: boolean } = {},
): Promise<void> => {
  const element = (
    <AgendaItemView
      busy={false}
      error={null}
      ferret="Zoe"
      history={[]}
      item={item}
      {...(extra.daemon === false ? {} : { daemonId: laptop.daemonId })}
      now={NOW}
      onAct={onAct}
      onClose={() => undefined}
      position={{ index: 0, total: 1 }}
      renderProse={text => text}
      swipeable
    />
  );
  view = await mount(app === null ? element : <StoreProvider store={app.store}>{element}</StoreProvider>);
  await interact(() => flush());
};

const root = (): HTMLElement => must(view?.container, 'the view');
const chip = (): HTMLButtonElement | null => root().querySelector<HTMLButtonElement>('[data-agenda-done-close]');
const theChip = (): HTMLButtonElement => must(chip(), 'the Done · closes button');
const errorLine = (): string | undefined =>
  root().querySelector('[data-agenda-done-close-error]')?.textContent ?? undefined;

describe('Done · closes on an agenda item: when it is offered', () => {
  test('draws the button in the one row, saying which card it closes', async () => {
    await drawItem(closing(), world());
    // Its name is the full words; it carries them and the short ones a narrow row shows instead ("Close &F1").
    expect(theChip().getAttribute('aria-label')).toBe('Done · closes &F1');
    expect(theChip().querySelector('.fy-qr__close-long')?.textContent).toBe('Done · closes &F1');
    expect(theChip().querySelector('.fy-qr__close-short')?.textContent).toBe('Close &F1');
    expect(theChip().closest('[data-more-row], [data-agenda-more-row]')).toBeNull();
    expect(theChip().closest('fieldset')?.getAttribute('aria-label')).toBe('Quick replies');
    expect(theChip().hasAttribute('data-agenda-answer')).toBe(false);
  });

  test('draws nothing for an item with no linked card', async () => {
    await drawItem(closing({ task: undefined } as Partial<AgendaItem>), world());
    expect(chip()).toBeNull();
  });

  test('draws nothing where the machine does not report agenda.offer-close.1', async () => {
    await drawItem(closing(), world({ features: [DAEMON_FEATURES.agendaWire] }));
    expect(chip()).toBeNull();
  });

  test('draws nothing for an item that did not ask to close its card', async () => {
    await drawItem(closing({ offerClose: undefined } as Partial<AgendaItem>), world());
    expect(chip()).toBeNull();
  });

  test('draws nothing without an app store or a machine to read the board from', async () => {
    await drawItem(closing(), null);
    expect(chip()).toBeNull();
    await view?.unmount();
    await drawItem(closing(), world(), undefined, { daemon: false });
    expect(chip()).toBeNull();
  });

  test('draws nothing for a card that is already closed or gone', async () => {
    await drawItem(
      closing(),
      world({ task: async () => ({ task: card('F1', { laneId: 'closed' }), laneSet: lanes }) }),
    );
    expect(chip()).toBeNull();
    await view?.unmount();
    await drawItem(closing(), world({ task: async () => null }));
    expect(chip()).toBeNull();
  });
});

describe('Done · closes: one tap', () => {
  test('closes the card through the board’s Done, and only then resolves the item', async () => {
    const acted: InboxAction[] = [];
    const app = world();
    await drawItem(closing(), app, action => {
      acted.push(action);
      expect(app.moves).toEqual(['F1:move:closed']);
    });
    await interact(() => theChip().click());
    await interact(() => flush());
    expect(app.moves).toEqual(['F1:move:closed']);
    expect(acted).toEqual([{ kind: 'resolve', label: 'Done · closes &F1' }]);
    expect(errorLine()).toBeUndefined();
  });

  test('is off while the card closes, so a second tap closes nothing twice', async () => {
    const gate = deferred<ReturnType<typeof boardOk>>();
    const acted: InboxAction[] = [];
    const app = world({ act: () => gate.promise as never });
    await drawItem(closing(), app, action => acted.push(action));
    await interact(() => theChip().click());
    expect(theChip().disabled).toBe(true);
    await interact(() => theChip().click());
    await interact(() => flush());
    expect(app.moves).toEqual(['F1:move:closed']);
    expect(acted).toEqual([]);
    gate.resolve(boardOk({ task: card('F1', { laneId: 'closed' }), laneSet: lanes }));
    await interact(() => flush());
    expect(acted).toHaveLength(1);
  });

  test('leaves the item open with the reason when the card will not close', async () => {
    const acted: InboxAction[] = [];
    const app = world({
      act: async () => boardErr({ status: 409, message: 'owner only', boardCode: null }) as never,
    });
    await drawItem(closing(), app, action => acted.push(action));
    await interact(() => theChip().click());
    await interact(() => flush());
    expect(acted).toEqual([]);
    expect(errorLine()).toBe('Not closed: &F1: owner only');
    expect(theChip().disabled).toBe(false);
  });

  test('says so when the card could not be read, and when the board has no Done for it', async () => {
    const acted: InboxAction[] = [];
    const never = deferred<null>();
    await drawItem(closing(), world({ task: () => never.promise as never }), action => acted.push(action));
    await interact(() => theChip().click());
    await interact(() => flush());
    expect(errorLine()).toBe('Not closed: &F1: the card could not be read');
    await view?.unmount();
    const dropped = card('F1', { laneId: 'tested', dropped: { at: '2026-08-01T10:00:00.000Z', reason: 'no' } });
    await drawItem(closing(), world({ task: async () => ({ task: dropped, laneSet: lanes }) }), action =>
      acted.push(action),
    );
    await interact(() => theChip().click());
    await interact(() => flush());
    expect(errorLine()).toBe('Not closed: &F1: the board has no Done for this card');
    expect(acted).toEqual([]);
  });
});

describe('the hook that reads the card to close', () => {
  test('counts a card that closed meanwhile as closed, and answers per card', async () => {
    const seen: { source?: DoneCloseSource | undefined } = {};
    const app = world();
    function Probe() {
      seen.source = useDoneClose(laptop.daemonId, closing());
      return null;
    }
    view = await mount(
      <StoreProvider store={app.store}>
        <Probe />
      </StoreProvider>,
    );
    await interact(() => flush());
    const source = must(seen.source, 'a source');
    expect(source.cards).toEqual([{ ref: { id: 'F1' }, title: 'Card F1' }]);
    await interact(() => app.board.act(laptop, 'F1', { action: 'move', to: 'closed' }));
    expect(await source.close([{ id: 'F1' }])).toEqual({ ok: true });
    expect(app.moves).toEqual(['F1:move:closed']);
    await interact(() => flush());
    expect(seen.source).toBeUndefined();
  });
});

const hostFlow = (
  cards: readonly TaskRef[],
  close: (refs: readonly TaskRef[]) => Promise<DoneCloseResult>,
  resolved: string[],
) => {
  const source: DoneCloseSource = { cards: cards.map(ref => ({ ref, title: `Card ${ref.id}` })), close };
  function Host({ alive }: { readonly alive: boolean }) {
    const flow = useDoneCloseFlow(alive ? source : undefined, label => resolved.push(label));
    const item = closing();
    return (
      <AgendaQuickReplies
        busy={false}
        error={null}
        map={swipeMap(item)}
        model={cardModel(item)}
        onAct={() => undefined}
        onSkip={() => undefined}
        options={itemOptions(item)}
        swipeable
        {...(flow === undefined ? {} : { doneClose: flow })}
      />
    );
  }
  return Host;
};

const tick = (id: string): HTMLInputElement =>
  must(root().querySelector<HTMLInputElement>(`[data-agenda-done-close-card="${id}"]`), `the ${id} checkbox`);
const go = (): HTMLButtonElement =>
  must(root().querySelector<HTMLButtonElement>('[data-agenda-done-close-confirm-go]'), 'the confirm button');

describe('Done · closes: several linked cards', () => {
  test('lists them all ticked, closes only the ticked ones, then resolves', async () => {
    const closed: string[][] = [];
    const resolved: string[] = [];
    const Host = hostFlow(
      [{ id: 'F1' }, { id: 'F2' }],
      async refs => {
        closed.push(refs.map(ref => ref.id));
        return { ok: true };
      },
      resolved,
    );
    view = await mount(<Host alive />);
    await interact(() => theChip().click());
    expect(closed).toEqual([]);
    expect([tick('F1').checked, tick('F2').checked]).toEqual([true, true]);
    expect(root().textContent).toContain('&F2 Card F2');
    expect(go().textContent).toBe('Close 2 and resolve');
    await interact(() => tick('F2').click());
    expect(tick('F2').checked).toBe(false);
    expect(go().textContent).toBe('Close 1 and resolve');
    await interact(() => tick('F2').click());
    await interact(() => tick('F2').click());
    await interact(() => go().click());
    await interact(() => flush());
    expect(closed).toEqual([['F1']]);
    expect(resolved).toEqual(['Done · closes &F1, &F2']);
    expect(root().querySelector('[data-agenda-done-close-confirm]')).toBeNull();
  });

  test('cannot confirm with nothing ticked, and cancel closes nothing', async () => {
    const closed: string[][] = [];
    const Host = hostFlow(
      [{ id: 'F1' }, { id: 'F2' }],
      async refs => {
        closed.push(refs.map(ref => ref.id));
        return { ok: true };
      },
      [],
    );
    view = await mount(<Host alive />);
    await interact(() => theChip().click());
    await interact(() => tick('F1').click());
    await interact(() => tick('F2').click());
    expect(go().disabled).toBe(true);
    await interact(() =>
      must(root().querySelector<HTMLButtonElement>('[data-agenda-done-close-cancel]'), 'cancel').click(),
    );
    expect(root().querySelector('[data-agenda-done-close-confirm]')).toBeNull();
    expect(closed).toEqual([]);
  });

  test('shows the failure inside the checklist’s item, leaving it open, and disables the checklist while closing', async () => {
    const gate = deferred<DoneCloseResult>();
    const resolved: string[] = [];
    const Host = hostFlow([{ id: 'F1' }, { id: 'F2' }], () => gate.promise, resolved);
    view = await mount(<Host alive />);
    await interact(() => theChip().click());
    await interact(() => go().click());
    expect(go().disabled).toBe(true);
    expect(tick('F1').disabled).toBe(true);
    gate.resolve({ ok: false, message: '&F2: gone (&F1 closed)' });
    await interact(() => flush());
    expect(resolved).toEqual([]);
    expect(errorLine()).toBe('Not closed: &F2: gone (&F1 closed)');
  });

  test('does nothing for an answer that arrives after the view is gone', async () => {
    const gate = deferred<DoneCloseResult>();
    const resolved: string[] = [];
    const Host = hostFlow([{ id: 'F1' }], () => gate.promise, resolved);
    view = await mount(<Host alive />);
    await interact(() => theChip().click());
    await view.unmount();
    gate.resolve({ ok: true });
    await interact(() => flush());
    expect(resolved).toEqual([]);
    view = await mount(<Host alive={false} />);
    expect(chip()).toBeNull();
  });
});

describe('where Done · closes sits among the answers', () => {
  const place = async (item: AgendaItem, extra: Record<string, unknown> = {}) => {
    const Host = hostFlow([{ id: 'F1' }], async () => ({ ok: true }), []);
    void Host;
    const source: DoneCloseSource = { cards: [{ ref: { id: 'F1' } }], close: async () => ({ ok: true }) };
    function Slot() {
      const flow = useDoneCloseFlow(source, () => undefined);
      return (
        <AgendaQuickReplies
          busy={false}
          error={null}
          map={swipeMap(item)}
          model={cardModel(item)}
          onAct={() => undefined}
          onSkip={() => undefined}
          options={itemOptions(item)}
          swipeable
          {...(flow === undefined ? {} : { doneClose: flow })}
          {...extra}
        />
      );
    }
    view = await mount(<Slot />);
  };

  test('takes the → slot beside two lettered answers, or beside one answer', async () => {
    await place(
      agendaItem('A1', { ask: choices('Use the seeded test account', 'Make a new one') } as Partial<AgendaItem>),
    );
    expect(theChip().closest('fieldset')?.getAttribute('aria-label')).toBe('Quick replies');
    expect(root().querySelectorAll('[data-agenda-answer]').length).toBe(2);
    expect(theChip().hasAttribute('data-agenda-answer')).toBe(false);
    await view?.unmount();
    await place(agendaItem('A3', { ask: choices('Ship it') } as Partial<AgendaItem>));
    expect(theChip().closest('fieldset')?.getAttribute('aria-label')).toBe('Quick replies');
  });

  test('goes under two answers in words: the row keeps one line with "Not needed" on a phone', async () => {
    await place(agendaItem('A4', { ask: choices('Yes', 'No') } as Partial<AgendaItem>));
    expect(root().querySelectorAll('[data-agenda-answer]').length).toBe(2);
    expect(theChip().closest('fieldset')?.getAttribute('aria-label')).not.toBe('Quick replies');
  });

  test('goes in the extra row when all three swipe slots are taken', async () => {
    await place(agendaItem('A2', { ask: choices('One', 'Two', 'Three') } as Partial<AgendaItem>));
    expect(theChip().closest('fieldset')?.getAttribute('aria-label')).toBe('More choices');
    expect(theChip().hasAttribute('data-agenda-answer')).toBe(false);
  });

  test('goes in the extra row beside the extra answers', async () => {
    await place(agendaItem('A3', { ask: choices('One', 'Two', 'Three', 'Four') } as Partial<AgendaItem>));
    const more = must(root().querySelector('[data-agenda-more-row]'), 'the more row');
    expect(more.querySelector('[data-agenda-done-close]')).not.toBeNull();
    expect(more.querySelectorAll('button').length).toBe(2);
  });
});
