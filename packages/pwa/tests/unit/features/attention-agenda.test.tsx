import { afterEach, describe, expect, test } from 'bun:test';
import type { AttentionId, AttentionItem, AttentionSnapshot } from '@ferretry/protocol';
import type { ReactElement } from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import {
  AttentionAgendaDrawer,
  AttentionAgendaLine,
  AttentionAgendaPanel,
  AttentionReferenceChips,
} from '../../../src/features/attention/attention-agenda-line.tsx';
import { AttentionAgendaRow } from '../../../src/features/attention/attention-agenda-row.tsx';
import {
  type AttentionActionClient,
  type AttentionAgenda,
  type AttentionFocus,
  useAttentionAgenda,
} from '../../../src/features/attention/attention-agenda.tsx';
import { AttentionFullCard } from '../../../src/features/attention/attention-full-card.tsx';
import { useAgendaDock } from '../../../src/features/attention/attention-collapse.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import '../../support/dom.ts';
import { render, run, runAsync } from '../../support/react.ts';

const connection = daemonConnection({ daemonId: 'agenda', baseUrl: 'https://agenda.example.test', deviceId: 'device' });
const scope = daemonSessionScope(connection, 'chat');
const otherScope = daemonSessionScope(connection, 'other');

const item = (id: string, extra: Record<string, unknown> = {}): AttentionItem =>
  ({
    id: id as AttentionId,
    source: 'agent-raised',
    subject: `Ask ${id}`,
    waitingSince: '2026-07-31T11:30:00.000Z',
    ask: { kind: 'permission' },
    ...extra,
  }) as unknown as AttentionItem;

const board = (
  items: readonly AttentionItem[],
  extra: Record<string, unknown> = {},
  resolved: readonly unknown[] = [],
): AttentionSnapshot =>
  ({
    v: 1,
    sessionId: 'chat',
    items,
    resolved,
    count: items.length,
    parseErrors: 0,
    updatedAt: '2026-07-31T12:00:00.000Z',
    ...extra,
  }) as unknown as AttentionSnapshot;

const calls: string[] = [];
const client = (fail = false): AttentionActionClient => ({
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
  progress: async () => undefined,
});

interface HostProps {
  readonly snapshot: AttentionSnapshot | null;
  readonly agendaMode?: boolean;
  readonly desktop?: boolean;
  readonly focus?: AttentionFocus | null;
  readonly scope?: typeof scope;
  readonly onOpenResolved?: (id: AttentionId) => void;
  readonly clientOverride?: AttentionActionClient;
  readonly repliesSlot?: ReactElement;
}

let current: AttentionAgenda | undefined;
const live = (): AttentionAgenda => {
  if (current === undefined) throw new Error('the host did not render');
  return current;
};

function Host({ snapshot, agendaMode = true, desktop = false, focus = null, ...rest }: HostProps) {
  const agenda = useAttentionAgenda({
    agendaMode,
    client: rest.clientOverride ?? client(),
    connection,
    desktop,
    ferret: 'Johnnie',
    focus,
    scope: rest.scope ?? scope,
    snapshot,
    status: snapshot === null ? 'loading' : 'ready',
    swipeable: !desktop,
    ...(rest.onOpenResolved === undefined ? {} : { onOpenResolved: rest.onOpenResolved }),
    ...(rest.repliesSlot === undefined ? {} : { repliesSlot: rest.repliesSlot }),
  });
  current = agenda;
  return (
    <div data-host="">
      <div className="fy-chat-log">{agenda.card}</div>
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

const MIXED = [
  item('A1', { waitingOn: 'ferret' }),
  item('A2'),
  item('A3', { blockingNow: true }),
  item('A4', { notice: true }),
];

describe('the agenda line', () => {
  test('counts blocking first and names the ferret, from the board’s turns', () => {
    const view = mount({ snapshot: board(MIXED) });
    const line = view.root.findByType(AttentionAgendaLine);
    expect(line.props.counts).toEqual({ blocking: 1, needYou: 2, withFerret: 1 });
    expect(line.props.ferret).toBe('Johnnie');
    expect(lines(view.root)).toHaveLength(1);
  });

  test('is absent when the agenda is empty and nothing is sending', () => {
    const view = mount({ snapshot: board([item('A4', { notice: true })]) });
    expect(lines(view.root)).toHaveLength(0);
    expect(view.root.findAllByType(AttentionAgendaLine)[0]?.props.counts).toBeUndefined();
  });

  test('is absent without agenda mode, and the board never opens a card or chips', () => {
    const view = mount({ snapshot: board(MIXED), agendaMode: false });
    expect(lines(view.root)).toHaveLength(0);
    expect(view.root.findAllByType(AttentionAgendaRow)).toHaveLength(0);
  });

  test('says what is sending on its own row even without agenda mode', () => {
    const view = mount({
      snapshot: board(MIXED, { delivery: { sending: ['A2', 'A3'] } }),
      agendaMode: false,
    });
    const status = view.root.find(node => node.props?.['data-attention-sending-line'] !== undefined);
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
    expect(view.root.findAllByType(AttentionAgendaLine)).toHaveLength(0);
  });
});

describe('the drawer', () => {
  test('opens from the line with every agenda row sorted blocking, then needs you, then the ferret’s turn', () => {
    const view = mount({ snapshot: board(MIXED) });
    expect(view.root.findAllByType(AttentionAgendaDrawer)).toHaveLength(0);
    run(() => toggle(view.root)[0]?.props.onClick());
    const rows = view.root.findAllByType(AttentionAgendaRow).map(row => row.props.item.id);
    expect(rows).toEqual(['A3', 'A2', 'A1']);
    expect(view.root.findByType(AttentionAgendaLine).props.open).toBe(true);
    run(() => toggle(view.root)[0]?.props.onClick());
    expect(view.root.findAllByType(AttentionAgendaDrawer)).toHaveLength(0);
  });

  test('closes when a row opens its card, and the card leaves the composer where it was', () => {
    const view = mount({ snapshot: board(MIXED) });
    run(() => toggle(view.root)[0]?.props.onClick());
    expect(lastIsComposer(view.root)).toBe(true);
    run(() => view.root.findAllByType(AttentionAgendaRow)[1]?.props.onOpen());
    expect(view.root.findAllByType(AttentionAgendaDrawer)).toHaveLength(0);
    const card = view.root.find(node => node.type === 'div' && node.props['data-agenda-card'] !== undefined);
    expect(card.props['data-agenda-card']).toBe('A2');
    expect(lastIsComposer(view.root)).toBe(true);
  });

  test('is not offered while the agenda is docked', () => {
    const view = mount({ snapshot: board(MIXED), desktop: true });
    run(() => view.root.find(node => node.props['data-agenda-dock'] !== undefined).props.onClick());
    expect(toggle(view.root)).toHaveLength(0);
    expect(view.root.findAllByType(AttentionAgendaPanel)).toHaveLength(1);
    expect(view.root.findAllByType(AttentionAgendaDrawer)).toHaveLength(0);
  });
});

describe('the full card', () => {
  const open = (view: ReturnType<typeof render>, id: string) =>
    run(() => {
      const row = view.root.findAllByType(AttentionAgendaRow).find(entry => entry.props.item.id === id);
      row?.props.onOpen();
    });
  const cardId = (view: ReturnType<typeof render>): string | undefined =>
    view.root.findAllByType(AttentionFullCard)[0]?.props.item.id;
  const withDrawer = (view: ReturnType<typeof render>) => run(() => toggle(view.root)[0]?.props.onClick());

  test('pages through the agenda with ‹ ›, and stops at its ends', () => {
    const view = mount({ snapshot: board(MIXED) });
    withDrawer(view);
    open(view, 'A3');
    expect(view.root.findByType(AttentionFullCard).props.onPrevious).toBeUndefined();
    expect(view.root.findByType(AttentionFullCard).props.position).toEqual({ index: 0, total: 3 });
    run(() => view.root.findByType(AttentionFullCard).props.onNext());
    expect(cardId(view)).toBe('A2');
    run(() => view.root.findByType(AttentionFullCard).props.onNext());
    expect(cardId(view)).toBe('A1');
    expect(view.root.findByType(AttentionFullCard).props.onNext).toBeUndefined();
    run(() => view.root.findByType(AttentionFullCard).props.onPrevious());
    expect(cardId(view)).toBe('A2');
  });

  test('draws swipe arrows on a touch screen and none on a wide screen with a mouse', () => {
    const touch = mount({ snapshot: board(MIXED), focus: { target: 'A2' as AttentionId, seq: 1 } });
    expect(touch.root.findByType(AttentionFullCard).props.swipeable).toBe(true);
    const wide = mount({ snapshot: board(MIXED), desktop: true, focus: { target: 'A2' as AttentionId, seq: 1 } });
    expect(wide.root.findByType(AttentionFullCard).props.swipeable).toBe(false);
  });

  test('after an answer, goes to the next item that needs the owner, else closes', async () => {
    const view = mount({ snapshot: board([item('A1'), item('A2'), item('A3', { waitingOn: 'ferret' })]) });
    withDrawer(view);
    open(view, 'A1');
    await runAsync(async () => {
      view.root.findByType(AttentionFullCard).props.onAct({ kind: 'resolve' });
    });
    expect(calls).toEqual(['resolve:A1']);
    expect(cardId(view)).toBe('A2');
    run(() => view.update(<Host snapshot={board([item('A2'), item('A3', { waitingOn: 'ferret' })])} />));
    await runAsync(async () => {
      view.root.findByType(AttentionFullCard).props.onAct({ kind: 'resolve' });
    });
    expect(calls).toEqual(['resolve:A1', 'resolve:A2']);
    expect(cardId(view)).toBeUndefined();
  });

  test('stays on the card and says why when the machine refuses', async () => {
    const view = mount({ snapshot: board([item('A1')]), clientOverride: client(true) });
    withDrawer(view);
    open(view, 'A1');
    await runAsync(async () => {
      view.root.findByType(AttentionFullCard).props.onAct({
        kind: 'respond',
        response: { kind: 'permission', decision: 'approve' },
      });
    });
    expect(cardId(view)).toBe('A1');
    expect(view.root.findByType(AttentionFullCard).props.error).toBe('The machine said no.');
  });

  test('does not carry an open card into another session', () => {
    const view = mount({ snapshot: board(MIXED), focus: { target: 'A2' as AttentionId, seq: 1 } });
    expect(cardId(view)).toBe('A2');
    run(() => view.update(<Host scope={otherScope} snapshot={board(MIXED)} />));
    expect(cardId(view)).toBeUndefined();
  });
});

describe('a request to show an item (`?attention=A5`)', () => {
  const target = (id: string, seq = 1): AttentionFocus => ({ target: id as AttentionId, seq });

  test('opens an open item’s full card once the board is read', () => {
    const view = mount({ snapshot: null, focus: target('A2') });
    expect(view.root.findAllByType(AttentionFullCard)).toHaveLength(0);
    run(() => view.update(<Host focus={target('A2')} snapshot={board(MIXED)} />));
    expect(view.root.findByType(AttentionFullCard).props.item.id).toBe('A2');
  });

  test('hands a resolved item to the resolved list and opens no card', () => {
    const opened: string[] = [];
    const view = mount({
      snapshot: board(MIXED, {}, [item('A9', { resolvedAt: '2026-07-31T12:00:00.000Z' })]),
      focus: target('A9'),
      onOpenResolved: id => opened.push(id),
    });
    expect(opened).toEqual(['A9']);
    expect(view.root.findAllByType(AttentionFullCard)).toHaveLength(0);
  });

  test('says out loud that an unknown id is no longer open', () => {
    const view = mount({ snapshot: board(MIXED), focus: target('A77') });
    const note = view.root.find(node => node.props?.['data-agenda-missing'] !== undefined);
    expect(note.props['data-agenda-missing']).toBe('A77');
  });

  test('is honoured once per request, so closing the card is not undone, but a new request re-opens it', () => {
    const view = mount({ snapshot: board(MIXED), focus: target('A2') });
    run(() => view.root.findByType(AttentionFullCard).props.onClose());
    run(() => view.update(<Host focus={target('A2')} snapshot={board([...MIXED, item('A5')])} />));
    expect(view.root.findAllByType(AttentionFullCard)).toHaveLength(0);
    run(() => view.update(<Host focus={target('A2', 2)} snapshot={board(MIXED)} />));
    expect(view.root.findByType(AttentionFullCard).props.item.id).toBe('A2');
  });

  test('with agenda mode off nothing opens and nothing is said', () => {
    const view = mount({ snapshot: board(MIXED), agendaMode: false, focus: target('A2') });
    expect(view.root.findAllByType(AttentionFullCard)).toHaveLength(0);
    expect(view.root.findAll(node => node.props?.['data-agenda-missing'] !== undefined)).toHaveLength(0);
  });
});

describe('the "re:" chips', () => {
  const chips = (view: ReturnType<typeof render>): readonly string[] =>
    view.root
      .findAllByType(AttentionReferenceChips)
      .flatMap(entry => entry.props.items.map((it: { id: string }) => it.id));

  test('collect several items, add each once, and can be removed one by one', () => {
    const view = mount({ snapshot: board(MIXED) });
    run(() => toggle(view.root)[0]?.props.onClick());
    const add = (id: string) =>
      run(() =>
        view.root
          .findAllByType(AttentionAgendaRow)
          .find(row => row.props.item.id === id)
          ?.props.onAddReply(),
      );
    add('A2');
    add('A3');
    add('A2');
    expect(live().references()).toEqual(['A2', 'A3']);
    expect(chips(view)).toEqual(['A2', 'A3']);
    run(() => view.root.findByType(AttentionReferenceChips).props.onRemove('A2'));
    expect(chips(view)).toEqual(['A3']);
    expect(view.root.findAllByType(AttentionAgendaRow).find(row => row.props.item.id === 'A3')?.props.referenced).toBe(
      true,
    );
  });

  test('can also be added from the full card, and are spent when a message goes', () => {
    const view = mount({ snapshot: board(MIXED), focus: { target: 'A2' as AttentionId, seq: 1 } });
    run(() => view.root.findByType(AttentionFullCard).props.onAddReply());
    expect(live().references()).toEqual(['A2']);
    run(() => live().composer.onSent());
    expect(live().references()).toEqual([]);
    expect(chips(view)).toEqual([]);
  });

  test('are dropped when their item leaves the agenda', () => {
    const view = mount({ snapshot: board(MIXED), focus: { target: 'A2' as AttentionId, seq: 1 } });
    run(() => view.root.findByType(AttentionFullCard).props.onAddReply());
    run(() => view.update(<Host snapshot={board([item('A3')])} />));
    expect(live().references()).toEqual([]);
  });
});

describe('an option picked while the composer holds text', () => {
  test('carries the text as the note and empties the composer when it was used', async () => {
    const view = mount({ snapshot: board([item('A1')]) });
    const before = live().composer.clearSignal;
    run(() => live().composer.onDraftChange('on the staging box only'));
    run(() => toggle(view.root)[0]?.props.onClick());
    await runAsync(async () => {
      view.root.findByType(AttentionAgendaRow).props.onAct({ kind: 'dismiss' });
    });
    expect(calls).toEqual(['dismiss:A1:on the staging box only']);
    expect(live().composer.clearSignal).toBe(before + 1);
  });

  test('leaves an empty composer alone', async () => {
    const view = mount({ snapshot: board([item('A1')]) });
    const before = live().composer.clearSignal;
    run(() => toggle(view.root)[0]?.props.onClick());
    await runAsync(async () => {
      view.root.findByType(AttentionAgendaRow).props.onAct({ kind: 'dismiss' });
    });
    expect(calls).toEqual(['dismiss:A1:']);
    expect(live().composer.clearSignal).toBe(before);
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
    expect(wide.root.findByType(AttentionAgendaPanel).props.items.map((row: AttentionItem) => row.id)).toEqual([
      'A3',
      'A2',
      'A1',
    ]);
    run(() => dock().props.onClick());
    expect(wide.root.findAllByType(AttentionAgendaPanel)).toHaveLength(0);
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
