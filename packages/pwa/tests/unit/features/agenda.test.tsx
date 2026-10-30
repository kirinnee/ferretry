import { afterEach, describe, expect, test } from 'bun:test';
import {
  LANE_PROPOSAL_ANSWERS,
  laneProposalReference,
  type AgendaId,
  type AgendaItem,
  type AgendaSnapshot,
} from '@ferretry/protocol';
import type { ReactElement } from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import {
  type AgendaActionClient,
  type Agenda,
  type AgendaFocus,
  agendaLedgerIds,
  useAgenda,
} from '../../../src/features/agenda/agenda.tsx';
import { AgendaDrawer, AgendaLine, AgendaPanel } from '../../../src/features/agenda/agenda-line.tsx';
import { AgendaRow } from '../../../src/features/agenda/agenda-row.tsx';
import { useAgendaDock } from '../../../src/features/agenda/agenda-collapse.ts';
import { AgendaItemView } from '../../../src/features/agenda/agenda-item-view.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import { RouterProvider } from '../../../src/lib/router.tsx';
import { registerComposerQuoteTarget } from '../../../src/lib/quote.ts';
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
  progress: async (_c, _s, id, step, done) => {
    calls.push(`progress:${id}:${step}:${done}`);
  },
});

interface HostProps {
  readonly snapshot: AgendaSnapshot | null;
  readonly agendaMode?: boolean;
  readonly desktop?: boolean;
  readonly focus?: AgendaFocus | null;
  readonly scope?: typeof scope;
  readonly onOpenResolved?: (id: AgendaId) => void;
  readonly clientOverride?: AgendaActionClient;
  readonly repliesSlot?: ReactElement;
  readonly status?: 'loading' | 'ready' | 'error';
  readonly live?: ReactElement;
  readonly entries?: readonly TranscriptEntry[];
  readonly onAnswered?: () => void;
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
    desktop,
    ferret: 'Johnnie',
    focus,
    scope: rest.scope ?? scope,
    snapshot,
    status: rest.status ?? (snapshot === null ? 'loading' : 'ready'),
    swipeable: !desktop,
    ...(rest.onOpenResolved === undefined ? {} : { onOpenResolved: rest.onOpenResolved }),
    ...(rest.repliesSlot === undefined ? {} : { repliesSlot: rest.repliesSlot }),
    ...(rest.live === undefined ? {} : { live: rest.live }),
    ...(rest.entries === undefined ? {} : { entries: rest.entries }),
    ...(rest.onAnswered === undefined ? {} : { onAnswered: rest.onAnswered }),
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
      {agenda.side}
      {agenda.dockButton}
    </div>
  );
}

const mounted: ReturnType<typeof render>[] = [];
afterEach(() => {
  for (const view of mounted.splice(0)) run(() => view.unmount());
  calls.length = 0;
  current = undefined;
  try {
    localStorage.clear();
  } catch {
    // no storage here
  }
});
const mount = (props: HostProps) => {
  const view = render(<Host {...props} />);
  mounted.push(view);
  return view;
};
const lines = (root: ReactTestInstance) =>
  root.findAll(node => node.type === 'div' && node.props['data-agenda-line'] !== undefined);
const toggle = (root: ReactTestInstance) =>
  root.findAll(node => node.type === 'button' && node.props['data-agenda-line-toggle'] !== undefined);
const lastIsComposer = (root: ReactTestInstance): boolean => {
  const column = root.find(node => node.type === 'div' && node.props.className === 'fy-chat-input__column');
  const last = column.children.at(-1);
  return typeof last !== 'string' && last?.props['data-composer'] !== undefined;
};

const textOf = (node: ReactTestInstance | undefined): string =>
  (node?.children ?? []).map(child => (typeof child === 'string' ? child : textOf(child))).join('');

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

  test('is absent without agenda mode, and the board never opens a card or chips', () => {
    const view = mount({ snapshot: board(MIXED), agendaMode: false });
    expect(lines(view.root)).toHaveLength(0);
    expect(view.root.findAllByType(AgendaRow)).toHaveLength(0);
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
    const rows = view.root.findAllByType(AgendaRow).map(row => row.props.item.id);
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

  test('is not offered while the agenda is docked', () => {
    const view = mount({ snapshot: board(MIXED), desktop: true });
    run(() => view.root.find(node => node.props['data-agenda-dock'] !== undefined).props.onClick());
    expect(toggle(view.root)).toHaveLength(0);
    expect(view.root.findAllByType(AgendaPanel)).toHaveLength(1);
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

  test('a resolved item named on ENTRY (a link, a notification) never opens the resolved list; it says it is no longer open', () => {
    const opened: string[] = [];
    const view = mount({
      snapshot: board(MIXED, {}, [item('A9', { resolvedAt: '2026-07-31T12:00:00.000Z' })]),
      focus: { ...target('A9'), onEntry: true },
      onOpenResolved: id => opened.push(id),
    });
    expect(opened).toEqual([]);
    expect(view.root.findAllByType(AgendaItemView)).toHaveLength(0);
    const note = view.root.find(node => node.props?.['data-agenda-missing'] !== undefined);
    expect(note.props['data-agenda-missing']).toBe('A9');
  });

  test('an open item named on entry still opens its card', () => {
    const view = mount({ snapshot: board(MIXED), focus: { ...target('A2'), onEntry: true } });
    expect(view.root.findByType(AgendaItemView).props.item.id).toBe('A2');
  });

  test('hands a resolved item to the resolved list and opens no card', () => {
    const opened: string[] = [];
    const view = mount({
      snapshot: board(MIXED, {}, [item('A9', { resolvedAt: '2026-07-31T12:00:00.000Z' })]),
      focus: target('A9'),
      onOpenResolved: id => opened.push(id),
    });
    expect(opened).toEqual(['A9']);
    expect(view.root.findAllByType(AgendaItemView)).toHaveLength(0);
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

  test('with agenda mode off nothing opens and nothing is said', () => {
    const view = mount({ snapshot: board(MIXED), agendaMode: false, focus: target('A2') });
    expect(view.root.findAllByType(AgendaItemView)).toHaveLength(0);
    expect(view.root.findAll(node => node.props?.['data-agenda-missing'] !== undefined)).toHaveLength(0);
  });
});

describe('the open item and the composer', () => {
  test('the next message is about the open item, said in the placeholder, and follows the card to the next one', () => {
    // Arrange
    const host = mount({ snapshot: board(MIXED), focus: { target: 'A3' as AgendaId, seq: 1 } });

    // Assert
    expect(live().references()).toEqual(['A3']);
    expect(live().placeholder).toBe('Reply about !A3…');
    run(() => host.root.findByType(AgendaItemView).props.onNext());
    expect(live().references()).toEqual(['A2']);
    expect(live().placeholder).toBe('Reply about !A2…');
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
    expect(events.map((event: { kind: string }) => event.kind)).toEqual(['ferret']);
  });
});

describe('the docked panel', () => {
  test('is a wide screen’s choice: no dock button on a phone, and the header button toggles it', () => {
    const phone = mount({ snapshot: board(MIXED) });
    expect(phone.root.findAll(node => node.props?.['data-agenda-dock'] !== undefined)).toHaveLength(0);
    expect(live().side).toBeNull();

    const wide = mount({ snapshot: board(MIXED), desktop: true });
    const dock = () => wide.root.find(node => node.type === 'button' && node.props['data-agenda-dock'] !== undefined);
    expect(dock().props['aria-pressed']).toBe(false);
    run(() => dock().props.onClick());
    expect(dock().props['aria-pressed']).toBe(true);
    expect(wide.root.findByType(AgendaPanel).props.items.map((row: AgendaItem) => row.id)).toEqual(['A3', 'A2', 'A1']);
    run(() => dock().props.onClick());
    expect(wide.root.findAllByType(AgendaPanel)).toHaveLength(0);
  });

  test('keeps the composer last whether docked or not', () => {
    const view = mount({ snapshot: board(MIXED), desktop: true });
    expect(lastIsComposer(view.root)).toBe(true);
    run(() => view.root.find(node => node.props['data-agenda-dock'] !== undefined).props.onClick());
    expect(lastIsComposer(view.root)).toBe(true);
  });

  test('is never offered when the ferret is not in agenda mode', () => {
    const view = mount({ snapshot: board(MIXED), desktop: true, agendaMode: false });
    expect(view.root.findAll(node => node.props?.['data-agenda-dock'] !== undefined)).toHaveLength(0);
  });
});

describe('the layout choices', () => {
  function DockProbe({ storage }: { readonly storage: Parameters<typeof useAgendaDock>[0] }) {
    const [docked, toggleDock] = useAgendaDock(storage);
    return <button data-docked={docked} onClick={toggleDock} type="button" />;
  }

  test('remember the dock in storage, and still hold for the tab when storage refuses', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (k: string, v: string) => void values.set(k, v),
    };
    const view = render(<DockProbe storage={storage} />);
    mounted.push(view);
    run(() => view.root.findByType('button').props.onClick());
    expect(values.get('fy-agenda-dock-v1')).toBe('1');
    expect(view.root.findByType('button').props['data-docked']).toBe(true);

    const refusing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const other = render(<DockProbe storage={refusing} />);
    mounted.push(other);
    expect(other.root.findByType('button').props['data-docked']).toBe(false);
    run(() => other.root.findByType('button').props.onClick());
    expect(other.root.findByType('button').props['data-docked']).toBe(true);
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

describe('the layout choice when the browser hides its storage', () => {
  function Probe() {
    const [docked] = useAgendaDock();
    return <i data-docked={docked} />;
  }

  test('reads as not docked when asking for storage throws', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('storage is blocked');
      },
    });
    try {
      const view = render(<Probe />);
      mounted.push(view);
      expect(view.root.findByType('i').props['data-docked']).toBe(false);
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
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
