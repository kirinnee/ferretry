import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  type AgendaId,
  type AgendaItem,
  type AgendaSnapshot,
  type AgendaListSnapshot,
  LANE_PROPOSAL_ANSWERS,
  laneProposalReference,
  agendaListSnapshot,
} from '@ferretry/protocol';
import { projectionSnapshot } from '../../../../protocol/tests/fixtures/agenda-projection.ts';
import type { ReactElement } from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import {
  type Agenda,
  type AgendaActionClient,
  type AgendaFocus,
  agendaLedgerIds,
  useAgenda,
} from '../../../src/features/agenda/agenda.tsx';
import { AgendaInboxContext, type AgendaInbox } from '../../../src/hooks/use-agenda-inbox.ts';
import { AgendaItemView } from '../../../src/features/agenda/agenda-item-view.tsx';
import { AgendaRow } from '../../../src/features/agenda/agenda-row.tsx';
import { AgendaDrawer, AgendaLine } from '../../../src/features/agenda/agenda-line.tsx';
import { InputCardHost } from '../../../src/features/input-request/input-card-host.tsx';
import { inboxCardKey } from '../../../src/lib/agenda-inbox.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import { registerComposerQuoteTarget } from '../../../src/lib/quote.ts';
import { RouterProvider } from '../../../src/lib/router.tsx';
import { type AppStore, StoreProvider } from '../../../src/lib/store.tsx';
import { browserFetch } from '../../../src/lib/runtime-models.ts';
import type { TranscriptEntry } from '../../../src/lib/session-screens.ts';
import '../../support/dom.ts';
import { agendaItem } from '../../support/agenda-inbox.tsx';
import { render, run, runAsync } from '../../support/react.ts';

const connection = daemonConnection({ daemonId: 'agenda', baseUrl: 'https://agenda.example.test', deviceId: 'device' });
const scope = daemonSessionScope(connection, 'chat');
const otherScope = daemonSessionScope(connection, 'other');

const item = (id: string, extra: Record<string, unknown> = {}): AgendaItem =>
  agendaItem(id, {
    ask: { kind: 'permission' },
    waitingSince: '2026-07-31T11:30:00.000Z',
    ...extra,
  } as Partial<AgendaItem>);

const board = (
  items: readonly AgendaItem[],
  extra: Record<string, unknown> = {},
  resolved: readonly unknown[] = [],
): AgendaSnapshot =>
  ({
    v: 1,
    sessionId: 'chat',
    items,
    resolved,
    count: items.length,
    parseErrors: 0,
    updatedAt: '2026-07-31T12:00:00.000Z',
    ...extra,
  }) as unknown as AgendaSnapshot;

const calls: string[] = [];
const client = (fail = false): AgendaActionClient => ({
  respond: async (_c, _s, id) => {
    calls.push(`respond:${id}`);
    if (fail) throw new Error('The machine said no.');
  },
  resolve: async (_c, _s, id) => {
    calls.push(`resolve:${id}`);
  },
  dismiss: async (_c, _s, id, note) => {
    calls.push(`dismiss:${id}:${note ?? ''}`);
  },
  needsInfo: async () => undefined,
  discuss: async () => undefined,
  snooze: async (_c, _s, id, until) => {
    calls.push(`snooze:${id}:${until}`);
  },
  unsnooze: async (_c, _s, id) => {
    calls.push(`unsnooze:${id}`);
  },
  progress: async (_c, _s, id, step, done) => {
    calls.push(`progress:${id}:${step}:${done}`);
  },
});

interface HostProps {
  readonly snapshot: AgendaListSnapshot | null;
  readonly agendaMode?: boolean;
  readonly desktop?: boolean;
  readonly afterOpen?: () => void;
  readonly focus?: AgendaFocus | null;
  readonly scope?: typeof scope;
  readonly clientOverride?: AgendaActionClient;
  readonly repliesSlot?: ReactElement;
  readonly status?: 'loading' | 'ready' | 'error';
  readonly live?: ReactElement;
  readonly entries?: readonly TranscriptEntry[];
  readonly onAnswered?: () => void;
  readonly onItemOpened?: (daemon: unknown, sessionId: string, agendaId: string) => unknown;
  readonly projectId?: string;
  /** The board's How to test for a card, as the shell's Inbox model gives it. */
  readonly boardSteps?: (daemonId: string, cardId: string) => string | null;
  /** A store that says what the machine speaks, for the item view's lifecycle reads. */
  readonly store?: AppStore;
}

let current: Agenda | undefined;
const live = (): Agenda => {
  if (current === undefined) throw new Error('the host did not render');
  return current;
};

function Host({ snapshot, agendaMode = true, desktop = false, focus = null, ...rest }: HostProps) {
  const agenda = useAgenda({
    agendaMode,
    client: rest.clientOverride ?? client(),
    connection,
    ferret: 'Johnnie',
    focus,
    scope: rest.scope ?? scope,
    snapshot,
    status: rest.status ?? (snapshot === null ? 'loading' : 'ready'),
    swipeable: !desktop,
    ...(rest.repliesSlot === undefined ? {} : { repliesSlot: rest.repliesSlot }),
    ...(rest.live === undefined ? {} : { live: rest.live }),
    ...(rest.entries === undefined ? {} : { entries: rest.entries }),
    ...(rest.onAnswered === undefined ? {} : { onAnswered: rest.onAnswered }),
    ...(rest.onItemOpened === undefined ? {} : { onItemOpened: rest.onItemOpened }),
    ...(rest.projectId === undefined ? {} : { projectId: rest.projectId }),
  });
  current = agenda;
  return (
    <div data-host="">
      <div className="fy-chat-log" data-covered={agenda.covered || undefined}>
        {agenda.scrim}
      </div>
      {agenda.view}
      <div className="fy-chat-input__column">
        {agenda.above}
        <div data-composer="" />
      </div>
      <div data-section="">{agenda.tab(rest.afterOpen)}</div>
    </div>
  );
}

const mounted: ReturnType<typeof render>[] = [];
const itemFetches: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const view of mounted.splice(0)) run(() => view.unmount());
  calls.length = 0;
  current = undefined;
  for (const fetcher of itemFetches.splice(0)) fetcher.mockRestore();
  try {
    localStorage.clear();
  } catch {
    // no storage here
  }
});

describe('opening resolved list headers', () => {
  test('keeps a failed item read visible and lets the owner retry it', async () => {
    // Arrange
    const full = { ...projectionSnapshot(0, 1), sessionId: 'chat' };
    const read = spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValue(Response.json(full.resolved[0]));
    itemFetches.push(read);
    let view: ReturnType<typeof mount> | undefined;
    // Act
    await runAsync(async () => {
      view = mount({ snapshot: agendaListSnapshot(full), focus: { target: 'A1' as AgendaId, seq: 1 } });
    });
    // Assert
    expect(live().covered).toBe(true);
    expect(view?.root.findByProps({ role: 'alert' }).children).toEqual(['Offline']);
    const retry = view?.root.findAllByType('button').find(button => button.children.includes('Try again'));
    await runAsync(async () => {
      retry?.props.onClick();
    });
    expect(view?.root.findByType(AgendaItemView).props.item.id).toBe('A1');
  });
  test('reads exactly one full item before showing its tabs, revisions and stored History', async () => {
    // Arrange
    const full = { ...projectionSnapshot(0, 1), sessionId: 'chat' };
    const listed = agendaListSnapshot(full);
    const document = full.resolved[0];
    const read = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(document));
    itemFetches.push(read);
    // Act
    let view: ReturnType<typeof mount> | undefined;
    await runAsync(async () => {
      view = mount({ snapshot: listed, focus: { target: 'A1' as AgendaId, seq: 1 } });
    });
    // Assert
    const itemReads = read.mock.calls
      .map(call => String(call[0]))
      .filter(url => url.endsWith('/v1/sessions/chat/agenda/A1'));
    expect(itemReads).toHaveLength(1);
    const opened = view?.root.findByType(AgendaItemView);
    expect(opened?.props.item).toEqual(document);
    expect(opened?.props.item.tabs[0].body).toContain('Fixture notes.');
    expect(opened?.props.history.length).toBeGreaterThan(0);
    expect(live().covered).toBe(true);
    run(() => opened?.props.onClose());
    expect(live().covered).toBe(false);
  });
});
const mount = (props: HostProps) => {
  const hosted = <Host {...props} />;
  const host = props.store === undefined ? hosted : <StoreProvider store={props.store}>{hosted}</StoreProvider>;
  const view = render(
    props.boardSteps === undefined ? (
      host
    ) : (
      <AgendaInboxContext.Provider value={{ howToTestFor: props.boardSteps } as unknown as AgendaInbox}>
        {host}
      </AgendaInboxContext.Provider>
    ),
  );
  mounted.push(view);
  return view;
};
const lines = (root: ReactTestInstance) =>
  root.findAll(node => node.type === 'div' && node.props['data-agenda-line'] !== undefined);
const toggle = (root: ReactTestInstance) =>
  root.findAll(node => node.type === 'button' && node.props['data-agenda-line-toggle'] !== undefined);
const section = (root: ReactTestInstance) => root.find(node => node.props['data-section'] !== undefined);
const lastIsComposer = (root: ReactTestInstance): boolean => {
  const column = root.find(node => node.type === 'div' && node.props.className === 'fy-chat-input__column');
  const last = column.children.at(-1);
  return typeof last !== 'string' && last?.props['data-composer'] !== undefined;
};

const textOf = (node: ReactTestInstance | undefined): string =>
  (node?.children ?? []).map(child => (typeof child === 'string' ? child : textOf(child))).join('');

const resolvedItem = (id: string): AgendaItem =>
  item(id, {
    resolvedAt: '2026-07-31T12:00:00.000Z',
    resolvedBy: 'human',
    resolvedBySession: null,
    resolvedByName: null,
    disposition: 'done',
  });

const MIXED = [
  item('A1', { waitingOn: 'ferret' }),
  item('A2'),
  item('A3', { blockingNow: true }),
  item('A4', { notice: true }),
];

describe('the agenda line', () => {
  test('counts blocking first and names the ferret, from the board’s turns', () => {
    const view = mount({ snapshot: board(MIXED) });
    const line = view.root.findByType(AgendaLine);
    expect(line.props.counts).toEqual({ blocking: 1, needYou: 2, withFerret: 1 });
    expect(line.props.ferret).toBe('Johnnie');
    expect(lines(view.root)).toHaveLength(1);
  });

  test('sets each count in bold, with its words after it', () => {
    const view = mount({ snapshot: board(MIXED) });
    const counts = view.root.findAll(node => node.type === 'strong' && node.props.className === 'fy-agenda-line__n');
    expect(counts.map(node => node.children.join(''))).toEqual(['1', '2', '1']);
    const line = lines(view.root)[0];
    expect(
      line?.findAll(node => node.type === 'span' && node.props.className === 'fy-agenda-line__segment'),
    ).toHaveLength(3);
  });

  test('is absent when the agenda is empty and nothing is sending', () => {
    const view = mount({ snapshot: board([item('A4', { notice: true })]) });
    expect(lines(view.root)).toHaveLength(0);
    expect(view.root.findAllByType(AgendaLine)[0]?.props.counts).toBeUndefined();
  });

  test('is absent without agenda mode, and the chat never opens a card or a drawer on its own', () => {
    const view = mount({ snapshot: board(MIXED), agendaMode: false });
    expect(lines(view.root)).toHaveLength(0);
    expect(view.root.findAll(node => node.props?.['data-agenda-drawer'] !== undefined)).toHaveLength(0);
    expect(view.root.findAllByType(AgendaItemView)).toHaveLength(0);
  });

  test('says what is sending on its own row even without agenda mode', () => {
    const view = mount({
      snapshot: board(MIXED, { delivery: { sending: ['A2', 'A3'] } }),
      agendaMode: false,
    });
    const status = view.root.find(node => node.props?.['data-agenda-sending-line'] !== undefined);
    expect(status.props.title).toBe('Ask A2, Ask A3');
    expect(lines(view.root)).toHaveLength(0);
    const row = view.root.find(node => node.type === 'div' && node.props['data-composer-status'] !== undefined);
    expect(row.props['data-composer-status']).toBe('sending');
  });

  test('puts the sending status on the same single row as the counts', () => {
    const view = mount({ snapshot: board(MIXED, { delivery: { sending: ['A2'] } }) });
    const rows = view.root.findAll(node => node.type === 'div' && node.props['data-composer-status'] !== undefined);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.props['data-composer-status']).toBe('both');
  });

  test('an unread board draws nothing and does not claim an empty agenda', () => {
    const view = mount({ snapshot: null });
    expect(view.root.findAllByType(AgendaLine)).toHaveLength(0);
  });
});

describe('the one row above the composer', () => {
  const liveNodes = (root: ReactTestInstance) =>
    root.findAll(node => node.type === 'div' && node.props['data-agenda-live'] !== undefined);

  test('shares the row with what is running: it on the left, the pill after it, and the agenda hosts it', () => {
    const view = mount({ snapshot: board(MIXED), live: <i>Pondering…</i> });
    const [row] = lines(view.root);
    expect(row?.props['data-shared']).toBe('');
    expect(row?.findAll(node => node.props['data-agenda-live'] !== undefined)).toHaveLength(1);
    expect(liveNodes(view.root)).toHaveLength(1);
    expect(live().hostsLive).toBe(true);
  });

  test('has the pill alone, and no empty box, when nothing runs', () => {
    const view = mount({ snapshot: board(MIXED) });
    expect(liveNodes(view.root)).toHaveLength(0);
    expect(lines(view.root)[0]?.props['data-shared']).toBeUndefined();
  });

  test('hosts what is running while something is sending, but not when the line is not there', () => {
    mount({ snapshot: board(MIXED, { delivery: { sending: ['A2'] } }), agendaMode: false });
    expect(live().hostsLive).toBe(true);
    mount({ snapshot: board([item('A4', { notice: true })]), live: <i>Pondering…</i> });
    expect(live().hostsLive).toBe(false);
    mount({ snapshot: null, live: <i>Pondering…</i> });
    expect(live().hostsLive).toBe(false);
  });

  test('says "Agenda · N" in the short form the row falls back to when it is narrow', () => {
    const view = mount({ snapshot: board(MIXED) });
    const short = view.root.find(node => node.props['data-agenda-line-short'] !== undefined);
    expect(textOf(short)).toBe('Agenda · 3');
  });
});

describe('the drawer', () => {
  test('opens from the line with every agenda row sorted blocking, then needs you, then the ferret’s turn', () => {
    const view = mount({ snapshot: board(MIXED) });
    expect(view.root.findAllByType(AgendaDrawer)).toHaveLength(0);
    run(() => toggle(view.root)[0]?.props.onClick());
    const rows = view.root
      .findByType(AgendaDrawer)
      .findAllByType(AgendaRow)
      .map(row => row.props.item.id);
    expect(rows).toEqual(['A3', 'A2', 'A1']);
    expect(view.root.findByType(AgendaLine).props.open).toBe(true);
    run(() => toggle(view.root)[0]?.props.onClick());
    expect(view.root.findAllByType(AgendaDrawer)).toHaveLength(0);
  });

  test('closes when a row opens its item, which covers the chat in focus mode', () => {
    const view = mount({ snapshot: board(MIXED) });
    run(() => toggle(view.root)[0]?.props.onClick());
    expect(live().covered).toBe(false);
    run(() => view.root.findAllByType(AgendaRow)[1]?.props.onOpen());
    expect(view.root.findAllByType(AgendaDrawer)).toHaveLength(0);
    const opened = view.root.find(node => node.type === 'section' && node.props['data-agenda-view'] !== undefined);
    expect(opened.props['data-agenda-view']).toBe('A2');
    expect(live().covered).toBe(true);
    expect(view.root.find(node => node.props['data-covered'] !== undefined).props['data-covered']).toBe(true);
  });

  test('is a raised sheet with its own header: the count of what needs the owner, and a close button', () => {
    const view = mount({ snapshot: board(MIXED) });
    run(() => toggle(view.root)[0]?.props.onClick());
    const drawer = view.root.findByType(AgendaDrawer);
    expect(textOf(drawer.find(node => node.type === 'h2'))).toBe('Agenda2 need you');
    run(() => drawer.find(node => node.props['data-agenda-drawer-close'] !== undefined).props.onClick());
    expect(view.root.findAllByType(AgendaDrawer)).toHaveLength(0);
  });

  test('says "Nothing needs you" in its header when it is all with the ferret', () => {
    const view = mount({ snapshot: board([item('A1', { waitingOn: 'ferret' })]) });
    run(() => toggle(view.root)[0]?.props.onClick());
    expect(textOf(view.root.find(node => node.type === 'h2'))).toBe('AgendaNothing needs you');
  });

  test('has a scrim over the chat that closes it, and Esc closes it too', () => {
    const view = mount({ snapshot: board(MIXED) });
    expect(view.root.findAll(node => node.props['data-agenda-scrim'] !== undefined)).toHaveLength(0);
    run(() => toggle(view.root)[0]?.props.onClick());
    run(() => view.root.find(node => node.props['data-agenda-scrim'] !== undefined).props.onClick());
    expect(view.root.findAllByType(AgendaDrawer)).toHaveLength(0);
    run(() => toggle(view.root)[0]?.props.onClick());
    const stopped: boolean[] = [];
    const drawer = view.root.find(node => node.type === 'section' && node.props['data-agenda-drawer'] !== undefined);
    run(() => drawer.props.onKeyDown({ key: 'Enter', stopPropagation: () => stopped.push(true) }));
    expect(view.root.findAllByType(AgendaDrawer)).toHaveLength(1);
    run(() => drawer.props.onKeyDown({ key: 'Escape', stopPropagation: () => stopped.push(true) }));
    expect(stopped).toEqual([true]);
    expect(view.root.findAllByType(AgendaDrawer)).toHaveLength(0);
  });
});

describe('the full card', () => {
  const open = (view: ReturnType<typeof render>, id: string) =>
    run(() => {
      const row = view.root.findAllByType(AgendaRow).find(entry => entry.props.item.id === id);
      row?.props.onOpen();
    });
  const cardId = (view: ReturnType<typeof render>): string | undefined =>
    view.root.findAllByType(AgendaItemView)[0]?.props.item.id;
  const withDrawer = (view: ReturnType<typeof render>) => run(() => toggle(view.root)[0]?.props.onClick());

  test('draws the item’s own stored words', () => {
    const stored = item('A3', {
      conversationCount: 1,
      conversation: [{ at: '2026-07-31T11:40:00.000Z', by: 'owner', via: 'reply', text: 'Stored words' }],
    });
    const view = mount({
      snapshot: board([stored]),
      store: {
        carrier: { fetch: browserFetch },
        connections: { list: () => [] },
      } as unknown as AppStore,
    });
    withDrawer(view);
    open(view, 'A3');
    const history = view.root.findByType(AgendaItemView).props.history as readonly { readonly text?: string }[];
    expect(history.some(event => event.text === 'Stored words')).toBe(true);
  });

  test('pages through the agenda with ‹ ›, and stops at its ends', () => {
    const view = mount({ snapshot: board(MIXED) });
    withDrawer(view);
    open(view, 'A3');
    expect(view.root.findByType(AgendaItemView).props.onPrevious).toBeUndefined();
    expect(view.root.findByType(AgendaItemView).props.position).toEqual({ index: 0, total: 3 });
    run(() => view.root.findByType(AgendaItemView).props.onNext());
    expect(cardId(view)).toBe('A2');
    run(() => view.root.findByType(AgendaItemView).props.onNext());
    expect(cardId(view)).toBe('A1');
    expect(view.root.findByType(AgendaItemView).props.onNext).toBeUndefined();
    run(() => view.root.findByType(AgendaItemView).props.onPrevious());
    expect(cardId(view)).toBe('A2');
  });

  test('says each item whose card comes up in the conversation was opened, so its alerts come down', () => {
    const opened: string[] = [];
    const view = mount({
      snapshot: board([item('A1'), item('A2')]),
      focus: { target: 'A2' as AgendaId, seq: 1 },
      onItemOpened: (daemon, sessionId, agendaId) => {
        expect(daemon).toBe(connection);
        opened.push(`${sessionId}:${agendaId}`);
      },
    });
    expect(opened).toEqual([`${scope.sessionId}:A2`]);
    run(() => view.root.findByType(AgendaItemView).props.onPrevious());
    expect(cardId(view)).toBe('A1');
    run(() => view.root.findByType(AgendaItemView).props.onClose());
    expect(opened).toEqual([`${scope.sessionId}:A2`, `${scope.sessionId}:A1`]);
  });

  test('draws swipe arrows on a touch screen and none on a wide screen with a mouse', () => {
    const touch = mount({ snapshot: board(MIXED), focus: { target: 'A2' as AgendaId, seq: 1 } });
    expect(touch.root.findByType(AgendaItemView).props.swipeable).toBe(true);
    const wide = mount({ snapshot: board(MIXED), desktop: true, focus: { target: 'A2' as AgendaId, seq: 1 } });
    expect(wide.root.findByType(AgendaItemView).props.swipeable).toBe(false);
  });

  test('after an answer, closes the view and tells the chat the answer went', async () => {
    const answered: string[] = [];
    const view = mount({
      snapshot: board([item('A1'), item('A2')]),
      onAnswered: () => answered.push('answered'),
    });
    withDrawer(view);
    open(view, 'A1');
    await runAsync(async () => {
      view.root.findByType(AgendaItemView).props.onAct({ kind: 'resolve' });
    });
    expect(calls).toEqual(['resolve:A1']);
    expect(cardId(view)).toBeUndefined();
    expect(live().covered).toBe(false);
    expect(answered).toEqual(['answered']);
  });

  test('keeps a card the owner has since moved on from, and still tells the chat', async () => {
    const answered: string[] = [];
    const view = mount({
      snapshot: board([item('A1'), item('A2')]),
      focus: { target: 'A1' as AgendaId, seq: 1 },
      onAnswered: () => answered.push('answered'),
    });
    const sendResolve = view.root.findByType(AgendaItemView).props.onAct;
    run(() => view.root.findByType(AgendaItemView).props.onNext());
    expect(cardId(view)).toBe('A2');
    await runAsync(async () => {
      sendResolve({ kind: 'resolve' });
    });
    expect(cardId(view)).toBe('A2');
    expect(answered).toEqual(['answered']);
  });

  test('stays on the card and says why when the machine refuses', async () => {
    const view = mount({ snapshot: board([item('A1')]), clientOverride: client(true) });
    withDrawer(view);
    open(view, 'A1');
    await runAsync(async () => {
      view.root
        .findByType(AgendaItemView)
        .props.onAct({ kind: 'respond', response: { kind: 'permission', decision: 'approve' } });
    });
    expect(cardId(view)).toBe('A1');
    expect(view.root.findByType(AgendaItemView).props.error).toBe('The machine said no.');
  });

  test('does not carry an open card into another session', () => {
    const view = mount({ snapshot: board(MIXED), focus: { target: 'A2' as AgendaId, seq: 1 } });
    expect(cardId(view)).toBe('A2');
    run(() => view.update(<Host scope={otherScope} snapshot={board(MIXED)} />));
    expect(cardId(view)).toBeUndefined();
  });
});

describe('a request to show an item (`?attention=A5`)', () => {
  const target = (id: string, seq = 1): AgendaFocus => ({ target: id as AgendaId, seq });

  test('opens an open item’s full card once the board is read', () => {
    const view = mount({ snapshot: null, focus: target('A2') });
    expect(view.root.findAllByType(AgendaItemView)).toHaveLength(0);
    run(() => view.update(<Host focus={target('A2')} snapshot={board(MIXED)} />));
    expect(view.root.findByType(AgendaItemView).props.item.id).toBe('A2');
  });

  test('a resolved item named on ENTRY (a link, a notification) opens its card read-only, and opens no menu', () => {
    const view = mount({ snapshot: board(MIXED, {}, [resolvedItem('A9')]), focus: { ...target('A9'), onEntry: true } });
    const card = view.root.findByType(AgendaItemView);
    expect(card.props.item.id).toBe('A9');
    expect(card.props.settled).toBeDefined();
    expect(view.root.findAll(node => node.props?.['data-agenda-missing'] !== undefined)).toHaveLength(0);
  });

  test('an open item named on entry (a link, a notification tap) opens its card AT ITS ASK', () => {
    const view = mount({ snapshot: board(MIXED), focus: { ...target('A2'), onEntry: true } });
    const card = view.root.findByType(AgendaItemView);
    expect(card.props.item.id).toBe('A2');
    expect(card.props.startAt).toBe('ask');
  });

  test('an item the owner opened by clicking a reference opens at its top', () => {
    const view = mount({ snapshot: board(MIXED), focus: target('A2') });
    expect(view.root.findByType(AgendaItemView).props.startAt).toBeUndefined();
  });

  test('each new request for the item is a new tap, so an item already at its ask is brought to it again', () => {
    const view = mount({ snapshot: board(MIXED), focus: { ...target('A2'), onEntry: true } });
    expect(view.root.findByType(AgendaItemView).props.startTap).toBe(1);
    run(() => view.update(<Host focus={{ ...target('A2', 2), onEntry: true }} snapshot={board(MIXED)} />));
    expect(view.root.findByType(AgendaItemView).props.startAt).toBe('ask');
    expect(view.root.findByType(AgendaItemView).props.startTap).toBe(2);
  });

  test('paging to another item leaves the request: the next one opens at its top', () => {
    const view = mount({ snapshot: board(MIXED), focus: { ...target('A3'), onEntry: true } });
    expect(view.root.findByType(AgendaItemView).props.startAt).toBe('ask');
    run(() => view.root.findByType(AgendaItemView).props.onNext());
    expect(view.root.findByType(AgendaItemView).props.item.id).toBe('A2');
    expect(view.root.findByType(AgendaItemView).props.startAt).toBeUndefined();
  });

  test('reads a card ask’s How to test from the board the shell holds, for this machine', () => {
    const asked: string[] = [];
    const view = mount({
      snapshot: board(MIXED),
      focus: target('A2'),
      boardSteps: (daemon, card) => {
        asked.push(`${daemon}:${card}`);
        return '1. Open it.';
      },
    });
    expect(view.root.findByType(AgendaItemView).props.howToTestFor('F12')).toBe('1. Open it.');
    expect(asked).toEqual(['agenda:F12']);
  });

  test('has no steps to give when the shell holds no board', () => {
    const view = mount({ snapshot: board(MIXED), focus: target('A2') });
    expect(view.root.findByType(AgendaItemView).props.howToTestFor('F12')).toBeUndefined();
  });

  test('opens a resolved item read-only: how it ended, no quick replies, no snooze, no reply prefix', () => {
    const view = mount({ snapshot: board(MIXED, {}, [resolvedItem('A9')]), focus: target('A9') });
    const card = view.root.findByType(AgendaItemView);
    expect(card.props.item.id).toBe('A9');
    expect(card.props.onSnooze).toBeUndefined();
    expect(card.props.position).toEqual({ index: 0, total: 1 });
    const settled = view.root.find(node => node.props?.['data-agenda-settled'] !== undefined);
    expect(settled.props['data-agenda-settled']).toBe('resolved');
    expect(textOf(settled)).toContain('Done by you');
    expect(view.root.findAll(node => node.props?.['data-agenda-quick-replies'] !== undefined)).toHaveLength(0);
    expect(live().placeholder).toBeUndefined();
    expect(live().references()).toEqual([]);
  });

  test('says out loud that an unknown id is no longer open', () => {
    const view = mount({ snapshot: board(MIXED), focus: target('A77') });
    const note = view.root.find(node => node.props?.['data-agenda-missing'] !== undefined);
    expect(note.props['data-agenda-missing']).toBe('A77');
  });

  test('is honoured once per request, so closing the card is not undone, but a new request re-opens it', () => {
    const view = mount({ snapshot: board(MIXED), focus: target('A2') });
    run(() => view.root.findByType(AgendaItemView).props.onClose());
    run(() => view.update(<Host focus={target('A2')} snapshot={board([...MIXED, item('A5')])} />));
    expect(view.root.findAllByType(AgendaItemView)).toHaveLength(0);
    run(() => view.update(<Host focus={target('A2', 2)} snapshot={board(MIXED)} />));
    expect(view.root.findByType(AgendaItemView).props.item.id).toBe('A2');
  });

  test('with agenda mode off a proved id still opens its card (#B76: a proved link is never a dead click)', () => {
    const view = mount({ snapshot: board(MIXED), agendaMode: false, focus: target('A2') });
    expect(view.root.findByType(AgendaItemView).props.item.id).toBe('A2');
    expect(lines(view.root)).toHaveLength(0);
  });

  for (const [label, extra] of [
    ['replied to', { parked: { reason: 'replied', at: '2026-07-31T11:50:00.000Z' } }],
    ['snoozed', { parked: { reason: 'snoozed', at: '2026-07-31T11:50:00.000Z', until: '2026-08-01T09:00:00.000Z' } }],
  ] as const) {
    test(`opens a parked (${label}) item with where it stands and Back to my list (#B76: !A89)`, async () => {
      const view = mount({ snapshot: board([...MIXED, item('A89', extra)]), focus: target('A89') });
      const card = view.root.findByType(AgendaItemView);
      expect(card.props.item.id).toBe('A89');
      expect(card.props.position).toEqual({ index: 0, total: 1 });
      const settled = view.root.find(node => node.props?.['data-agenda-settled'] !== undefined);
      expect(settled.props['data-agenda-settled']).toBe(extra.parked.reason);
      expect(view.root.findAll(node => node.props?.['data-agenda-missing'] !== undefined)).toHaveLength(0);
      const back = view.root.find(node => node.props?.['data-agenda-bring-back'] !== undefined);
      await runAsync(async () => back.props.onClick());
      expect(calls).toEqual(['unsnooze:A89']);
    });
  }

  test('keeps a replied question answerable: the line is a note above its live answers, not a replacement', () => {
    const replied = { parked: { reason: 'replied', at: '2026-07-31T11:50:00.000Z' } };
    const view = mount({ snapshot: board([...MIXED, item('A89', replied)]), focus: target('A89') });
    const card = view.root.findByType(AgendaItemView);
    expect(card.props.settled).toBeUndefined();
    expect(card.props.parkedNote).toBeDefined();
    expect(card.props.onSnooze).toBeDefined();
  });

  test('still settles a replied notice and a snoozed question: only a replied question stays live', () => {
    const at = '2026-07-31T11:50:00.000Z';
    const notice = mount({
      snapshot: board([...MIXED, item('A90', { notice: true, parked: { reason: 'replied', at } })]),
      focus: target('A90'),
    });
    expect(notice.root.findByType(AgendaItemView).props.parkedNote).toBeUndefined();
    const snoozed = mount({
      snapshot: board([
        ...MIXED,
        item('A91', { parked: { reason: 'snoozed', at, until: '2026-08-01T09:00:00.000Z' } }),
      ]),
      focus: target('A91'),
    });
    expect(snoozed.root.findByType(AgendaItemView).props.settled).toBeDefined();
  });

  test('opens a notice on its own, outside the pager', () => {
    const view = mount({ snapshot: board(MIXED), focus: target('A4') });
    const card = view.root.findByType(AgendaItemView);
    expect(card.props.item.id).toBe('A4');
    expect(card.props.position).toEqual({ index: 0, total: 1 });
  });
});

describe('the open item and the composer', () => {
  test('the next message is about the open item, said in the placeholder, and follows the card to the next one', () => {
    // Arrange
    const host = mount({ snapshot: board(MIXED), focus: { target: 'A3' as AgendaId, seq: 1 } });

    // Assert
    expect(live().references()).toEqual(['A3']);
    expect(live().placeholder).toBe('Reply to Johnnie…');
    run(() => host.root.findByType(AgendaItemView).props.onNext());
    expect(live().references()).toEqual(['A2']);
    expect(live().placeholder).toBe('Reply to Johnnie…');
  });

  test('says nothing while no item is open', () => {
    mount({ snapshot: board(MIXED) });
    expect(live().references()).toEqual([]);
    expect(live().placeholder).toBeUndefined();
  });

  test('hides the pill while an item is open and draws it again once the view closes', () => {
    // Arrange
    const host = mount({ snapshot: board(MIXED), focus: { target: 'A3' as AgendaId, seq: 1 } });

    // Assert
    expect(host.root.findAllByType(AgendaLine).every(line => line.props.counts === undefined)).toBe(true);
    expect(host.root.findAll(node => node.props?.['data-agenda-chip'] !== undefined)).toHaveLength(0);
    run(() => host.root.findByType(AgendaItemView).props.onClose());
    expect(host.root.findByType(AgendaLine).props.counts).toBeDefined();
    expect(live().placeholder).toBeUndefined();
  });

  test('a message from the composer closes the view and spends the reference', () => {
    const host = mount({ snapshot: board(MIXED), focus: { target: 'A2' as AgendaId, seq: 1 } });
    expect(live().covered).toBe(true);
    run(() => live().composer.onSent());
    expect(host.root.findAllByType(AgendaItemView)).toHaveLength(0);
    expect(live().covered).toBe(false);
    expect(live().references()).toEqual([]);
    expect(live().placeholder).toBeUndefined();
  });

  test('is dropped when its item leaves the agenda', () => {
    const host = mount({ snapshot: board(MIXED), focus: { target: 'A2' as AgendaId, seq: 1 } });
    run(() => host.update(<Host snapshot={board([item('A3')])} />));
    expect(live().references()).toEqual([]);
  });
});

describe('what the item view sends', () => {
  const composer = (draft: string) => {
    const state = { draft, replaced: [] as string[] };
    const dispose = registerComposerQuoteTarget({
      ...scope,
      draft: () => state.draft,
      replaceDraft: next => {
        state.draft = next;
        state.replaced.push(next);
      },
    });
    return { state, dispose };
  };
  const open = (extra: Partial<HostProps> = {}) =>
    mount({ snapshot: board([item('A1')]), focus: { target: 'A1' as AgendaId, seq: 1 }, ...extra });

  test('a quick reply carries what the composer holds as its note, and then empties the composer', async () => {
    const { state, dispose } = composer('on the staging box only');
    const view = open();
    await runAsync(async () => {
      view.root.findByType(AgendaItemView).props.onAct({ kind: 'dismiss' });
    });
    expect(calls).toEqual(['dismiss:A1:on the staging box only']);
    expect(state.replaced).toEqual(['']);
    dispose();
  });

  test('an input card takes no note, and empties a credential left in the composer so the next card cannot carry it', async () => {
    const { state, dispose } = composer('hunter2-PASSWORD');
    const view = mount({
      snapshot: board([item('A1', { kind: 'input' }), item('A2')]),
      focus: { target: 'A1' as AgendaId, seq: 1 },
    });
    await runAsync(async () => {
      view.root.findByType(AgendaItemView).props.onAct({ kind: 'dismiss' });
    });
    expect(calls).toEqual(['dismiss:A1:']);
    expect(state.draft).toBe('');
    expect(state.replaced).toEqual(['']);

    run(() => view.update(<Host snapshot={board([item('A2')])} focus={{ target: 'A2' as AgendaId, seq: 2 }} />));
    await runAsync(async () => {
      view.root.findByType(AgendaItemView).props.onAct({ kind: 'dismiss' });
    });
    expect(calls).toEqual(['dismiss:A1:', 'dismiss:A2:']);
    dispose();
  });

  test('a card with nothing typed in the composer leaves it alone, input or not', async () => {
    const { state, dispose } = composer('');
    const view = mount({
      snapshot: board([item('A1', { kind: 'input' })]),
      focus: { target: 'A1' as AgendaId, seq: 1 },
    });
    await runAsync(async () => {
      view.root.findByType(AgendaItemView).props.onAct({ kind: 'dismiss' });
    });
    expect(state.replaced).toEqual([]);
    dispose();
  });

  test('a quick reply with nothing typed carries no note and leaves the composer alone', async () => {
    const { state, dispose } = composer('   ');
    const view = open();
    await runAsync(async () => {
      view.root.findByType(AgendaItemView).props.onAct({ kind: 'dismiss' });
    });
    expect(calls).toEqual(['dismiss:A1:']);
    expect(state.replaced).toEqual([]);
    dispose();
  });

  test('a quick reply with no composer mounted carries no note', async () => {
    const view = open();
    await runAsync(async () => {
      view.root.findByType(AgendaItemView).props.onAct({ kind: 'dismiss' });
    });
    expect(calls).toEqual(['dismiss:A1:']);
  });

  test('keeps the composer’s text when the machine refuses', async () => {
    const { state, dispose } = composer('keep me');
    const view = open({ clientOverride: client(true) });
    await runAsync(async () => {
      view.root
        .findByType(AgendaItemView)
        .props.onAct({ kind: 'respond', response: { kind: 'permission', decision: 'approve' } });
    });
    expect(state.replaced).toEqual([]);
    expect(view.root.findByType(AgendaItemView).props.error).toBe('The machine said no.');
    dispose();
  });

  test('reads the item’s history from the conversation', () => {
    const view = open({
      entries: [{ id: 'm1', kind: 'assistant', text: 'Looking at !A1 now.', at: 1 } as unknown as TranscriptEntry],
    });
    const events = view.root.findByType(AgendaItemView).props.history;
    // The conversation's message about it, and nothing made up for the raise.
    expect(events.map((event: { kind: string }) => event.kind)).toEqual(['ferret']);
  });
});

describe('the agenda as the Agenda tab of Info', () => {
  const rowButtons = (view: ReturnType<typeof render>) =>
    section(view.root).findAll(node => node.type === 'button' && node.props['data-agenda-tab-row'] !== undefined);
  const rowIds = (view: ReturnType<typeof render>) => rowButtons(view).map(row => row.props['data-agenda-row']);
  const chips = (view: ReturnType<typeof render>) =>
    section(view.root).findAll(node => node.props?.['data-context-chip'] !== undefined && node.type === 'button');
  const choose = (view: ReturnType<typeof render>, key: string) =>
    run(() =>
      chips(view)
        .find(chip => chip.props['data-context-chip'] === key)
        ?.props.onClick(),
    );

  test('opens on what needs the owner, blockers first', () => {
    const view = mount({ snapshot: board(MIXED) });
    expect(rowIds(view)).toEqual(['A3', 'A2']);
  });

  test('draws the four filters, each count the length of its list', () => {
    const view = mount({ snapshot: board(MIXED, {}, [resolvedItem('A9')]) });
    expect(chips(view).map(chip => chip.props['data-context-chip'])).toEqual([
      'needs-you',
      'resting',
      'snoozed',
      'resolved',
    ]);
    const counts = chips(view).map(chip => Number(/(\d+)$/u.exec(textOf(chip))?.[1]));
    for (const [index, key] of ['needs-you', 'resting', 'snoozed', 'resolved'].entries()) {
      choose(view, key);
      expect(rowIds(view).length).toBe(counts[index] ?? -1);
    }
  });

  test('keeps a ferret’s-turn item in Resting and never in Needs you', () => {
    const view = mount({ snapshot: board(MIXED) });
    choose(view, 'resting');
    expect(rowIds(view)).toEqual(['A1']);
    expect(textOf(section(view.root).find(node => node.props['data-agenda-tab-state'] !== undefined))).toBe(
      'Resting · waiting on Johnnie',
    );
  });

  test('says so when a filter has nothing in it', () => {
    const view = mount({ snapshot: board([]) });
    expect(rowIds(view)).toEqual([]);
    expect(textOf(section(view.root).find(node => node.props['data-agenda-tab-empty'] !== undefined))).toBe(
      'Nothing needs you.',
    );
  });

  test('draws nothing when the ferret is not in agenda mode and its ledger is empty', () => {
    const view = mount({ snapshot: board([]), agendaMode: false });
    expect(section(view.root).children).toHaveLength(0);
    expect(live().counts).toBeNull();
  });

  test('still lists the ledger without agenda mode: there is one agenda list in Info, never a dead one', () => {
    const view = mount({ snapshot: board(MIXED), agendaMode: false });
    expect(rowIds(view)).toEqual(['A3', 'A2']);
  });

  test('a resolved row opens the same card, read-only', () => {
    const view = mount({ snapshot: board(MIXED, {}, [resolvedItem('A9')]) });
    choose(view, 'resolved');
    expect(rowIds(view)).toEqual(['A9']);
    run(() => rowButtons(view)[0]?.props.onClick());
    expect(view.root.findByType(AgendaItemView).props.item.id).toBe('A9');
  });

  test('opens the item’s card when a row is opened, then tells the host', () => {
    const opened: string[] = [];
    const view = mount({ snapshot: board(MIXED), afterOpen: () => opened.push('closed-info') });
    run(() =>
      rowButtons(view)
        .find(row => row.props['data-agenda-row'] === 'A2')
        ?.props.onClick(),
    );
    expect(view.root.findByType(AgendaItemView).props.item.id).toBe('A2');
    expect(live().covered).toBe(true);
    expect(opened).toEqual(['closed-info']);
  });

  test('opens the card without a host callback', () => {
    const view = mount({ snapshot: board(MIXED) });
    run(() => rowButtons(view)[0]?.props.onClick());
    expect(view.root.findByType(AgendaItemView).props.item.id).toBe('A3');
  });

  test('gives Overview the same counts the tab shows', () => {
    mount({ snapshot: board(MIXED, {}, [resolvedItem('A9')]) });
    expect(live().counts?.()).toEqual({ 'needs-you': 2, resting: 1, snoozed: 0, resolved: 1 });
  });

  test('keeps the composer last', () => {
    const view = mount({ snapshot: board(MIXED), desktop: true });
    expect(lastIsComposer(view.root)).toBe(true);
  });
});

describe('what the agenda says about a board it cannot trust', () => {
  const notes = (root: ReactTestInstance) =>
    root.findAll(node => node.type === 'p' && node.props.className === 'fy-agenda-note');

  test('says how many damaged records the machine reported', () => {
    const view = mount({ snapshot: board(MIXED, { parseErrors: 2 }) });
    const [note] = notes(view.root);
    expect(note?.props.role).toBe('alert');
    expect(textOf(note)).toContain('2 damaged agenda records');
  });

  test('says the list cannot be read instead of implying that nothing needs the owner', () => {
    const view = mount({ snapshot: null, status: 'error' });
    const [note] = notes(view.root);
    expect(textOf(note)).toContain('cannot be read right now');
    expect(lines(view.root)).toHaveLength(0);
  });

  test('keeps a resolved item’s id on the ledger, and reads no ids from an unread board', () => {
    const resolved = [{ ...item('A9'), resolvedAt: '2026-07-31T11:59:00.000Z' }];
    expect(agendaLedgerIds(board([item('A1')], {}, resolved))).toEqual(['A1', 'A9']);
    expect(agendaLedgerIds(null)).toEqual([]);
  });
});

describe('the full card’s steps', () => {
  test('are reported to the machine for the item the card shows', async () => {
    const view = mount({ snapshot: board(MIXED) });
    run(() => toggle(view.root)[0]?.props.onClick());
    run(() =>
      view.root
        .findAllByType(AgendaRow)
        .find(row => row.props.item.id === 'A3')
        ?.props.onOpen(),
    );
    await runAsync(async () => {
      await view.root.findByType(AgendaItemView).props.onProgress(2, true);
    });
    expect(calls).toEqual(['progress:A3:2:true']);
  });
});

describe('the drawer’s scroll cue', () => {
  const box = { scrollHeight: 400, scrollTop: 0, clientHeight: 200, firstElementChild: {} };
  const watched: unknown[] = [];
  let disconnected = 0;
  let notify: (() => void) | undefined;
  const original = globalThis.ResizeObserver;
  afterEach(() => {
    globalThis.ResizeObserver = original;
    watched.length = 0;
    disconnected = 0;
    notify = undefined;
    box.scrollHeight = 400;
    box.scrollTop = 0;
  });
  const open = () => {
    disconnected = 0;
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe(target: unknown) {
        watched.push(target);
      }
      disconnect() {
        disconnected += 1;
      }
    } as unknown as typeof ResizeObserver;
    const view = render(<Host snapshot={board(MIXED)} />, { createNodeMock: () => box });
    mounted.push(view);
    run(() => toggle(view.root)[0]?.props.onClick());
    return view;
  };
  const drawer = (view: ReturnType<typeof render>) =>
    view.root.find(node => node.type === 'div' && node.props.className === 'fy-agenda-drawer__list');

  test('shows when rows are hidden below, and goes when the drawer is scrolled to its end or resized to fit', () => {
    const view = open();
    expect(drawer(view).props['data-more']).toBe(true);
    expect(watched).toEqual([box, box.firstElementChild]);

    box.scrollTop = 200;
    run(() => drawer(view).props.onScroll());
    expect(drawer(view).props['data-more']).toBeUndefined();

    box.scrollTop = 0;
    box.scrollHeight = 200;
    run(() => notify?.());
    expect(drawer(view).props['data-more']).toBeUndefined();
    box.scrollHeight = 400;
    run(() => notify?.());
    expect(drawer(view).props['data-more']).toBe(true);
  });

  test('stops watching when the drawer closes', () => {
    const view = open();
    run(() => toggle(view.root)[0]?.props.onClick());
    expect(disconnected).toBe(1);
  });

  test('still measures once in a browser with no resize observer', () => {
    const view = open();
    run(() => view.unmount());
    mounted.pop();
    // @ts-expect-error the browser under test has no ResizeObserver
    delete globalThis.ResizeObserver;
    const bare = render(<Host snapshot={board(MIXED)} />, { createNodeMock: () => box });
    mounted.push(bare);
    run(() => toggle(bare.root)[0]?.props.onClick());
    expect(drawer(bare).props['data-more']).toBe(true);
  });
});

describe('Edit on a lane-proposal card in the conversation', () => {
  const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
  const proposal = item('L1', {
    ask: {
      kind: 'multiple-choice',
      options: [{ label: LANE_PROPOSAL_ANSWERS.accept }, { label: LANE_PROPOSAL_ANSWERS.edit }],
    },
    sourceRef: laneProposalReference(PROJECT_ID, 2),
  });
  const choose = (label: string) => ({ kind: 'respond', response: { kind: 'multiple-choice', choice: label } });

  const mountInRouter = () => {
    const view = render(
      <RouterProvider>
        <Host focus={{ target: 'L1' as AgendaId, seq: 1 }} snapshot={board([proposal])} />
      </RouterProvider>,
    );
    mounted.push(view);
    return view;
  };

  afterEach(() => window.history.replaceState({}, '', '/'));

  test('sends the answer, then opens the lane editor', async () => {
    const view = mountInRouter();
    await runAsync(async () => {
      view.root.findByType(AgendaItemView).props.onAct(choose(LANE_PROPOSAL_ANSWERS.edit));
    });
    expect(calls).toEqual(['respond:L1']);
    expect(window.location.pathname).toBe(`/d/agenda/projects/${PROJECT_ID}/lanes`);
  });

  test('leaves the page alone on Accept', async () => {
    const view = mountInRouter();
    await runAsync(async () => {
      view.root.findByType(AgendaItemView).props.onAct(choose(LANE_PROPOSAL_ANSWERS.accept));
    });
    expect(calls).toEqual(['respond:L1']);
    expect(window.location.pathname).toBe('/');
  });

  test('answers without a router in the tree, and does not go anywhere', async () => {
    const view = mount({ snapshot: board([proposal]), focus: { target: 'L1' as AgendaId, seq: 1 } });
    await runAsync(async () => {
      view.root.findByType(AgendaItemView).props.onAct(choose(LANE_PROPOSAL_ANSWERS.edit));
    });
    expect(calls).toEqual(['respond:L1']);
    expect(window.location.pathname).toBe('/');
  });
});

describe('a paste plan card', () => {
  test('is offered to the item view for a card that carries a plan, and to no other card', async () => {
    const daemon = mount({
      snapshot: board([
        item('A1', {
          kind: 'permission',
          raisedBy: 'daemon',
          copyPlan: { planId: 'b'.repeat(32) },
        } as Partial<AgendaItem>),
      ]),
      focus: { target: 'A1' as AgendaId, seq: 1 },
    });
    expect(daemon.root.findByType(AgendaItemView).props.planForm).toBeDefined();
    run(() => daemon.unmount());

    const agent = mount({
      snapshot: board([item('A1', { kind: 'permission', raisedBy: 'daemon' } as Partial<AgendaItem>)]),
      focus: { target: 'A1' as AgendaId, seq: 1 },
    });
    expect(agent.root.findByType(AgendaItemView).props.planForm).toBeUndefined();
    run(() => agent.unmount());
  });
});

describe('a task plan card', () => {
  const offered = (extra: Partial<AgendaItem>) => {
    const view = mount({
      snapshot: board([item('A1', { kind: 'permission', raisedBy: 'daemon', ...extra } as Partial<AgendaItem>)]),
      focus: { target: 'A1' as AgendaId, seq: 1 },
    });
    const form = view.root.findByType(AgendaItemView).props.planForm;
    run(() => view.unmount());
    return form;
  };

  test('is offered to the item view for the daemon’s own task plan reference, over a paste plan, and to no plain card', () => {
    const taskPlan = { planId: 'c'.repeat(32) };
    expect(offered({ taskPlan } as Partial<AgendaItem>)).toBeDefined();
    expect(offered({ taskPlan, copyPlan: { planId: 'b'.repeat(32) } } as Partial<AgendaItem>)).toBeDefined();
    expect(offered({})).toBeUndefined();
  });

  test('offers no Snooze on the daemon’s suggestion card: the ferret reads its own board (C2)', () => {
    const snoozeOf = (extra: Partial<AgendaItem>) => {
      const view = mount({
        snapshot: board([item('A1', { kind: 'info', ...extra } as Partial<AgendaItem>)]),
        focus: { target: 'A1' as AgendaId, seq: 1 },
      });
      const onSnooze = view.root.findByType(AgendaItemView).props.onSnooze;
      run(() => view.unmount());
      return onSnooze;
    };
    expect(
      snoozeOf({ signInRuleSuggestion: { suggestion: 'srg_aaaaaaaaaaaaaaaa' } } as Partial<AgendaItem>),
    ).toBeUndefined();
    expect(snoozeOf({})).toBeDefined();
  });
});

describe('an approve-on-phone card', () => {
  test('is offered to the item view only for the daemon’s own reference, not for words that copy its title', async () => {
    const REF = { id: `pa_${'0'.repeat(23)}1` };
    const referenced = mount({
      snapshot: board([item('A1', { kind: 'info', phoneApproval: REF } as Partial<AgendaItem>)]),
      focus: { target: 'A1' as AgendaId, seq: 1 },
    });
    expect(referenced.root.findByType(AgendaItemView).props.planForm).toBeDefined();
    run(() => referenced.unmount());

    const copied = mount({
      snapshot: board([
        item('A1', { kind: 'info', subject: 'Approve on your phone: Tap 42 on your phone' } as Partial<AgendaItem>),
      ]),
      focus: { target: 'A1' as AgendaId, seq: 1 },
    });
    expect(copied.root.findByType(AgendaItemView).props.planForm).toBeUndefined();
    run(() => copied.unmount());
  });
});

describe('a staged 2FA seed card', () => {
  test('is offered to the item view only for the daemon’s own reference, not for words that copy its title', async () => {
    const REF = { stage: `st_${'a'.repeat(24)}`, account: 'GITHUB' };
    const referenced = mount({
      snapshot: board([
        item('A1', {
          kind: 'permission',
          raisedBy: 'daemon',
          subject: 'Save automatic codes to your account on github.com?',
          twoFactorSeed: REF,
        } as Partial<AgendaItem>),
      ]),
      focus: { target: 'A1' as AgendaId, seq: 1 },
    });
    expect(referenced.root.findByType(AgendaItemView).props.planForm).toBeDefined();
    run(() => referenced.unmount());

    const copied = mount({
      snapshot: board([
        item('A1', {
          kind: 'permission',
          raisedBy: 'agent',
          subject: 'Save automatic codes to your account on github.com?',
        } as Partial<AgendaItem>),
      ]),
      focus: { target: 'A1' as AgendaId, seq: 1 },
    });
    expect(copied.root.findByType(AgendaItemView).props.planForm).toBeUndefined();
    run(() => copied.unmount());
  });
});

describe('a sign-in rule suggestion card', () => {
  const offered = (extra: Partial<AgendaItem>) => {
    const view = mount({
      snapshot: board([item('A1', { kind: 'info', ...extra } as Partial<AgendaItem>)]),
      focus: { target: 'A1' as AgendaId, seq: 1 },
    });
    const form = view.root.findByType(AgendaItemView).props.planForm;
    run(() => view.unmount());
    return form;
  };

  test('is offered to the item view only for the daemon’s own suggestion reference', () => {
    expect(
      offered({ signInRuleSuggestion: { suggestion: 'srg_aaaaaaaaaaaaaaaa' } } as Partial<AgendaItem>),
    ).toBeDefined();
    expect(offered({})).toBeUndefined();
  });

  test('is given the session’s project, so a rule can be limited to it', () => {
    const view = mount({
      snapshot: board([
        item('A1', {
          kind: 'info',
          signInRuleSuggestion: { suggestion: 'srg_aaaaaaaaaaaaaaaa' },
        } as Partial<AgendaItem>),
      ]),
      focus: { target: 'A1' as AgendaId, seq: 1 },
      projectId: '5b1f2a40-6c7d-4e8f-9a0b-1c2d3e4f5a6b',
    });
    expect(view.root.findByType(AgendaItemView).props.planForm.props.projectId).toBe(
      '5b1f2a40-6c7d-4e8f-9a0b-1c2d3e4f5a6b',
    );
    run(() => view.unmount());
  });
});

describe('a form opened in the chat (#B143)', () => {
  // The Inbox's form, filled in from the chat: the same card, the same picks, and the composer's Send is its answer.
  const formItem = (id: string, extra: Record<string, unknown> = {}): AgendaItem =>
    item(id, {
      kind: 'form',
      ask: { kind: 'open-question' },
      fields: [
        {
          id: '1',
          type: 'one',
          label: 'Which region?',
          name: 'Region',
          options: [{ label: 'EU', description: 'data stays in Europe' }, { label: 'US' }],
          recommended: ['EU'],
        },
        {
          id: '2',
          type: 'many',
          label: 'Which alerts?',
          name: 'Alerts',
          options: [{ label: 'Page' }, { label: 'Mail' }],
        },
        { id: '3', type: 'yesno', label: 'OK to restart?', name: 'Restart' },
        { id: '4', type: 'text', label: 'Anything else?', required: false },
      ],
      ...extra,
    });
  const responses: unknown[] = [];
  const recording = (landing: Promise<void> = Promise.resolve()): AgendaActionClient => ({
    ...client(),
    respond: async (_c, _s, id, response) => {
      calls.push(`respond:${id}`);
      responses.push(response);
      await landing;
    },
  });
  const typed = (draft: string) =>
    registerComposerQuoteTarget({ ...scope, draft: () => draft, replaceDraft: () => undefined });
  const inputs = (view: ReturnType<typeof render>, type: string) =>
    view.root.findAll(node => node.type === 'input' && node.props.type === type);
  const yesNo = (view: ReturnType<typeof render>) =>
    view.root.findAll(node => node.type === 'button' && node.props.className === 'fy-form__seg-btn');
  const cardId = (view: ReturnType<typeof render>): string | undefined =>
    view.root.findAllByType(AgendaItemView)[0]?.props.item.id;
  const openForm = (id: string, extra: Partial<HostProps> = {}) =>
    mount({ snapshot: board([formItem(id)]), focus: { target: id as AgendaId, seq: 1 }, ...extra });
  afterEach(() => {
    responses.length = 0;
  });

  test('draws its fields as controls, keyed as the Inbox keys the item, and the composer’s Send answers it', () => {
    const view = openForm('A60');
    expect(view.root.findByType(AgendaItemView).props.formKey).toBe(inboxCardKey(connection.daemonId, 'chat', 'A60'));
    expect(inputs(view, 'radio').map(radio => [radio.props.value, radio.props.checked])).toEqual([
      ['EU', true],
      ['US', false],
    ]);
    expect(inputs(view, 'checkbox')).toHaveLength(2);
    expect(yesNo(view)).toHaveLength(2);
    expect(textOf(view.root.findByProps({ 'data-agenda-form-text': '' }))).toBe('Type it below.');
    expect(JSON.stringify(view.toJSON())).not.toContain('Open this in the Inbox');
    expect(live().composer.answerForm).toBeDefined();
    expect(live().composer.formKey).toBe(inboxCardKey(connection.daemonId, 'chat', 'A60'));
    expect(live().placeholder).toBe('Anything else for Johnnie?');
  });

  test('Send answers with every pick and the typed words, and the view waits for the answer to land', async () => {
    let land: () => void = () => undefined;
    const landing = new Promise<void>(resolve => {
      land = resolve;
    });
    const answered: string[] = [];
    const dispose = typed('ship it Friday');
    const view = openForm('A61', { clientOverride: recording(landing), onAnswered: () => answered.push('answered') });
    run(() => inputs(view, 'radio')[1]?.props.onChange());
    run(() => inputs(view, 'checkbox')[0]?.props.onChange());
    // Yes is the second button: No ←, Yes →.
    run(() => yesNo(view)[1]?.props.onClick());

    run(() => live().composer.answerForm?.());
    // The composer reports its send at once; the form's view stays until the machine has the answer.
    run(() => live().composer.onSent());
    expect(cardId(view)).toBe('A61');
    expect(calls).toEqual(['respond:A61']);
    expect(responses).toEqual([
      {
        kind: 'form',
        answers: [
          { id: '1', picked: 'US' },
          { id: '2', picked: ['Page'] },
          { id: '3', picked: 'Yes' },
          { id: '4', picked: 'ship it Friday' },
        ],
      },
    ]);

    await runAsync(async () => {
      land();
      await landing;
    });
    expect(cardId(view)).toBeUndefined();
    expect(answered).toEqual(['answered']);
    // The view closing is not the confirmation: a line above the composer says what went, until dismissed.
    const sentLine = view.root.findByProps({ 'data-agenda-sent': 'A61' });
    expect(textOf(sentLine)).toBe('Sent to Johnnie: Region: US · Alerts: Page · Restart: Yes');
    run(() => sentLine.findByProps({ 'aria-label': 'Dismiss' }).props.onClick());
    expect(view.root.findAll(node => node.props['data-agenda-sent'] !== undefined)).toHaveLength(0);
    dispose();
  });

  test('sends a form answered in part on the first Send: every field is optional (&F922)', async () => {
    const view = openForm('A62', { clientOverride: recording() });
    await runAsync(async () => {
      live().composer.answerForm?.();
    });
    expect(responses).toEqual([{ kind: 'form', answers: [{ id: '1', picked: 'EU' }] }]);
    // No composer send followed in this test, so the landed answer closed the view.
    expect(cardId(view)).toBeUndefined();
  });

  test('a refused answer leaves the card open with the machine’s reason', async () => {
    const view = openForm('A63', { clientOverride: client(true) });
    run(() => yesNo(view)[1]?.props.onClick());
    run(() => inputs(view, 'checkbox')[1]?.props.onChange());
    await runAsync(async () => {
      live().composer.answerForm?.();
      live().composer.onSent();
    });
    expect(cardId(view)).toBe('A63');
    expect(view.root.findByType(AgendaItemView).props.error).toBe('The machine said no.');
    expect(view.root.findAll(node => node.props['data-agenda-sent'] !== undefined)).toHaveLength(0);
  });

  test('a settled form is read, not filled in: no picks key, and a reply is plain chat about it', () => {
    const view = mount({
      snapshot: board([], {}, [{ ...formItem('A64'), ...resolvedItem('A64'), kind: 'form' }]),
      focus: { target: 'A64' as AgendaId, seq: 1 },
    });
    expect(cardId(view)).toBe('A64');
    expect(view.root.findByType(AgendaItemView).props.formKey).toBeUndefined();
    expect(inputs(view, 'radio')).toHaveLength(0);
    expect(live().composer.answerForm).toBeUndefined();
  });
});

describe('an input card that ends while it is open (#B147)', () => {
  // The owner typed the value or tapped Send: the daemon closes the item, and the view must not sit on it.
  const REQUEST = { requestId: 'ab'.repeat(16) };
  const inputItem = (id: string): AgendaItem => item(id, { kind: 'input', ask: undefined, input: REQUEST });
  const closedRecord = (id: string, note: string | null, extra: Record<string, unknown> = {}) => ({
    ...inputItem(id),
    resolvedAt: '2026-07-31T12:00:05.000Z',
    resolvedBy: 'daemon',
    resolvedBySession: null,
    resolvedByName: null,
    resolutionNote: note,
    disposition: 'done',
    ...extra,
  });
  const openInput = (id = 'A7') =>
    mount({ snapshot: board([inputItem(id), item('A2')]), focus: { target: id as AgendaId, seq: 1 } });
  const inputHost = (view: ReturnType<typeof render>) => view.root.findByType(InputCardHost);
  const sentLine = (view: ReturnType<typeof render>) =>
    view.root.findAll(node => node.type === 'p' && node.props['data-agenda-sent'] !== undefined);

  test('closes its view the moment the daemon closes the item, and says how it ended above the composer', () => {
    const view = openInput();
    expect(live().covered).toBe(true);
    run(() =>
      view.update(
        <Host
          snapshot={board([item('A2')], {}, [closedRecord('A7', 'Input request expired: expired.')])}
          focus={{ target: 'A7' as AgendaId, seq: 1 }}
        />,
      ),
    );
    expect(view.root.findAllByType(AgendaItemView)).toHaveLength(0);
    expect(live().covered).toBe(false);
    const said = sentLine(view);
    expect(said).toHaveLength(1);
    expect(said[0]?.props['data-agenda-sent']).toBe('A7');
    expect(said[0]?.props['data-tone']).toBe('info');
    expect(textOf(said[0])).toContain('closed');
  });

  test('says only that it is closed when the daemon closed it without a note', () => {
    const view = openInput();
    run(() =>
      view.update(
        <Host
          snapshot={board([item('A2')], {}, [closedRecord('A7', null)])}
          focus={{ target: 'A7' as AgendaId, seq: 1 }}
        />,
      ),
    );
    expect(live().covered).toBe(false);
    expect(textOf(sentLine(view)[0])).toContain('!A7 is closed.');
  });

  test('closes its view once the card sent from here has nothing more to show, in the card’s own words', () => {
    const view = openInput();
    run(() => inputHost(view).props.onHold(true));
    expect(live().covered).toBe(true);
    run(() => inputHost(view).props.onHold(false, 'Sent to %terminal:dev.'));
    expect(live().covered).toBe(false);
    const said = sentLine(view);
    expect(said[0]?.props['data-tone']).toBe('ok');
    expect(textOf(said[0])).toContain('Sent to %terminal:dev.');
  });

  test('stays open while the card holds it (a Send in flight, or a follow-up offer), even once the item closed', () => {
    const view = openInput();
    run(() => inputHost(view).props.onHold(true));
    run(() =>
      view.update(
        <Host
          snapshot={board([item('A2')], {}, [closedRecord('A7', 'Input request delivered.')])}
          focus={{ target: 'A7' as AgendaId, seq: 1 }}
        />,
      ),
    );
    expect(live().covered).toBe(true);
    expect(view.root.findByType(AgendaItemView).props.item.id).toBe('A7');
    // The owner is done with the offer: the card lets go, and the view closes.
    run(() => inputHost(view).props.onHold(false, 'Sent to %terminal:dev.'));
    expect(live().covered).toBe(false);
  });

  test('a send that failed lets go, so a request that ended meanwhile still closes', () => {
    const view = openInput();
    run(() => inputHost(view).props.onHold(true));
    run(() =>
      view.update(
        <Host
          snapshot={board([item('A2')], {}, [closedRecord('A7', 'Input request cancelled: interrupted.')])}
          focus={{ target: 'A7' as AgendaId, seq: 1 }}
        />,
      ),
    );
    expect(live().covered).toBe(true);
    run(() => inputHost(view).props.onHold(false));
    expect(live().covered).toBe(false);
    expect(sentLine(view)[0]?.props['data-tone']).toBe('info');
  });

  test('an approve-on-phone card closes its view when the daemon closes it', () => {
    const REF = { id: `pa_${'0'.repeat(23)}1` };
    const phone = item('A8', { kind: 'info', ask: undefined, phoneApproval: REF } as Partial<AgendaItem>);
    const view = mount({ snapshot: board([phone]), focus: { target: 'A8' as AgendaId, seq: 1 } });
    expect(live().covered).toBe(true);
    run(() =>
      view.update(
        <Host
          snapshot={board([], {}, [
            {
              ...phone,
              resolvedAt: '2026-07-31T12:00:05.000Z',
              resolvedBy: 'daemon',
              resolvedBySession: null,
              resolvedByName: null,
              resolutionNote: 'Approved on your phone.',
              disposition: 'done',
            },
          ])}
          focus={{ target: 'A8' as AgendaId, seq: 1 }}
        />,
      ),
    );
    expect(live().covered).toBe(false);
  });

  test('a closed input card opened from the history stays open to be read', () => {
    const view = mount({
      snapshot: board([item('A2')], {}, [closedRecord('A7', 'Input request delivered.')]),
      focus: { target: 'A7' as AgendaId, seq: 1 },
    });
    expect(live().covered).toBe(true);
    expect(view.root.findByType(AgendaItemView).props.item.id).toBe('A7');
    run(() =>
      view.update(
        <Host
          snapshot={board([], {}, [closedRecord('A7', 'Input request delivered.')])}
          focus={{ target: 'A7' as AgendaId, seq: 1 }}
        />,
      ),
    );
    expect(live().covered).toBe(true);
  });

  const resolveA7 = (view: ReturnType<typeof render>, seq: number, note = 'Input request delivered.') =>
    run(() =>
      view.update(
        <Host
          snapshot={board([item('A2')], {}, [closedRecord('A7', note)])}
          focus={{ target: 'A7' as AgendaId, seq }}
        />,
      ),
    );

  test('a closed input card the view already closed on opens again from the history and stays to be read', () => {
    const view = openInput();
    resolveA7(view, 1);
    expect(live().covered).toBe(false);
    // The owner picks !A7 from the history, or a chat reference to it.
    resolveA7(view, 2);
    expect(live().covered).toBe(true);
    expect(view.root.findByType(AgendaItemView).props.item.id).toBe('A7');
  });

  test('an input card left before it ended stays to be read when it is opened from the history later', () => {
    const view = openInput();
    run(() => view.root.findByType(AgendaItemView).props.onClose());
    expect(live().covered).toBe(false);
    resolveA7(view, 2);
    expect(live().covered).toBe(true);
    expect(view.root.findByType(AgendaItemView).props.item.id).toBe('A7');
  });

  test('a hold left by a view that went away is not carried into the next opening of the request', () => {
    const view = openInput();
    const gone = inputHost(view).props.onHold;
    run(() => gone(true));
    run(() => view.root.findByType(AgendaItemView).props.onClose());
    // The same request, opened again while it is still waiting.
    run(() =>
      view.update(
        <Host snapshot={board([inputItem('A7'), item('A2')])} focus={{ target: 'A7' as AgendaId, seq: 2 }} />,
      ),
    );
    expect(live().covered).toBe(true);
    // The card that went away finishes late: it cannot hold, release or close the new opening.
    run(() => gone(true));
    run(() => gone(false, 'Sent to %terminal:dev.'));
    expect(live().covered).toBe(true);
    // The request ends: nothing holds the new opening, so it closes by itself.
    resolveA7(view, 2);
    expect(live().covered).toBe(false);
    expect(sentLine(view)[0]?.props['data-tone']).toBe('info');
  });

  test('any other item the ferret closes while it is open stays on screen as before', () => {
    const view = mount({ snapshot: board([item('A3')]), focus: { target: 'A3' as AgendaId, seq: 1 } });
    run(() =>
      view.update(
        <Host
          snapshot={board([], {}, [{ ...resolvedItem('A3'), resolvedBy: 'agent', resolutionNote: 'withdrawn' }])}
          focus={{ target: 'A3' as AgendaId, seq: 1 }}
        />,
      ),
    );
    expect(live().covered).toBe(true);
  });
});
