import { afterEach, describe, expect, it } from 'bun:test';
import type { AskListSnapshot } from '@ferretry/core-asks/contract';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import { clientBoardPort } from '../../../app/lib/board-client.ts';
import { askHeading, askSessions, collectAsks, type SessionAgenda } from '../../../app/lib/board-asks.ts';
import { DaemonBoardStore } from '../../../app/lib/board-store.ts';
import { BoardDetail } from '../../../app/views/detail/board-detail.tsx';
import { AsksList } from '../../../app/views/detail/board-detail-sections.tsx';
import { card, CHILD, fakeEnvironment, fakePort, flush, laneSetFor, laptop } from './board-support.ts';

const LEAD = 'mvuc7tsf-0c3d50df';
const names = (ferret: string): string => (ferret === LEAD ? 'Denisha' : ferret.slice(0, 6));

const open = (id: string, extra: Record<string, unknown> = {}) => ({ id, subject: `Ask ${id}`, ...extra });
const resolved = (id: string, taskId: string, extra: Record<string, unknown> = {}) => ({
  id,
  subject: `Done ${id}`,
  task: { id: taskId },
  resolvedAt: '2026-08-01T10:00:00.000Z',
  disposition: 'done',
  resolutionNote: null,
  ...extra,
});
const snapshot = (parts: { items?: unknown[]; resolved?: unknown[] }): AskListSnapshot =>
  ({ items: parts.items ?? [], resolved: parts.resolved ?? [] }) as unknown as AskListSnapshot;

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

describe('board-app: the card’s Agenda asks (v4 parity)', () => {
  it('askHeading is the title when it has one, else the subject', () => {
    expect(askHeading({ subject: ' Plan ', title: '  ' })).toBe('Plan');
    expect(askHeading({ subject: 'Plan', title: 'OK to build?' })).toBe('OK to build?');
  });

  it('askSessions lists the ferrets that raised an open ask, the owner and the assignee, once each', () => {
    expect(askSessions({ openAsks: [{ ferret: CHILD, id: 'A1' }], owner: LEAD, assignee: CHILD } as never)).toEqual([
      CHILD,
      LEAD,
    ]);
  });

  it('collectAsks keeps the card’s own open asks, blocking first, and only this card’s answered ones, newest first', () => {
    const task = card('F3', {
      openAsks: [
        { ferret: LEAD, id: 'A1' },
        { ferret: LEAD, id: 'A2' },
      ],
    });
    const agendas: SessionAgenda[] = [
      {
        sessionId: LEAD,
        snapshot: snapshot({
          items: [open('A1'), open('A2', { blockingNow: true })],
          resolved: [
            resolved('A3', 'F3'),
            resolved('A4', 'F9'),
            resolved('A5', 'F3', { resolvedAt: '2026-08-01T11:00:00.000Z' }),
          ],
        }),
      },
    ];
    const asks = collectAsks(task, agendas);
    expect(asks.open.map(row => [row.id, row.blocking])).toEqual([
      ['A2', true],
      ['A1', false],
    ]);
    expect(asks.resolved.map(row => row.item.id)).toEqual(['A5', 'A3']);
    expect(asks.reading).toBe(false);
  });

  it('collectAsks says it is still reading while an agenda has not answered, and names the ask without its item', () => {
    const task = card('F3', { openAsks: [{ ferret: LEAD, id: 'A1' }] });
    const asks = collectAsks(task, [{ sessionId: LEAD, snapshot: null }]);
    expect(asks.reading).toBe(true);
    expect(asks.open).toEqual([{ ferret: LEAD, id: 'A1', item: null, blocking: false }]);
  });

  it('AsksList draws blocking, open and answered rows, and a row opens its ask in the Agenda', async () => {
    const task = card('F3', {
      openAsks: [
        { ferret: LEAD, id: 'A1' },
        { ferret: LEAD, id: 'A2' },
      ],
    });
    const asks = collectAsks(task, [
      {
        sessionId: LEAD,
        snapshot: snapshot({
          items: [open('A1'), open('A2', { blockingNow: true })],
          resolved: [
            resolved('A3', 'F3', { resolutionNote: 'ship it' }),
            resolved('A6', 'F3', { disposition: 'dismissed' }),
          ],
        }),
      },
    ]);
    const opened: string[] = [];
    view = await mount(
      <AsksList asks={asks} names={names} onOpen={(ferret, id) => void opened.push(`${ferret}/${id}`)} />,
    );
    const rows = [...view.container.querySelectorAll('li')].map(row => row.textContent);
    expect(rows).toEqual(['Blocking · Ask A2', 'Open · Ask A1', 'Answered · Done A3 · ship it', 'Dismissed · Done A6']);
    await interact(() =>
      (must(view?.container.querySelector('[data-ask-open="A2"]'), 'the A2 row') as HTMLElement).click(),
    );
    expect(opened).toEqual([`${LEAD}/A2`]);
  });

  it('AsksList says when none was raised or when it is still reading', async () => {
    view = await mount(
      <AsksList asks={{ open: [], resolved: [], reading: false }} names={names} onOpen={() => undefined} />,
    );
    expect(view.container.textContent).toBe('No asks have been raised.');
    await view.unmount();
    view = await mount(
      <AsksList asks={{ open: [], resolved: [], reading: true }} names={names} onOpen={() => undefined} />,
    );
    expect(view.container.textContent).toBe('Reading the asks…');
  });

  it('the card page draws an "Agenda asks" section read from the ferret’s agenda, and none for a card with no asks', async () => {
    const asked = card('F3', { openAsks: [{ ferret: LEAD, id: 'A1' }], owner: LEAD, assignee: null });
    const quiet = card('F4', { owner: LEAD, assignee: null });
    const reads: string[] = [];
    const port = fakePort({
      card: async (_daemon, id) => ({ card: id === 'F3' ? asked : quiet, laneSet: laneSetFor() }),
      agenda: async (_daemon, ferret) => {
        reads.push(ferret);
        return snapshot({ items: [open('A1', { blockingNow: true })], resolved: [resolved('A7', 'F3')] });
      },
    });
    const store = new DaemonBoardStore(port, fakeEnvironment());
    const props = {
      machine: { connection: laptop, name: 'Laptop' },
      names,
      now: Date.parse('2026-08-01T12:00:00.000Z'),
      onClose: () => undefined,
      onNavigate: () => undefined,
      phone: true,
      projectName: (id: string) => id,
      siblings: [],
      store,
    };
    view = await mount(<BoardDetail {...props} taskId="F3" />);
    await flush();
    const section = must(view.container.querySelector('[data-section="asks"]'), 'the Agenda asks section');
    expect(section.querySelector('h3')?.textContent).toBe('Agenda asks2');
    expect([...section.querySelectorAll('li')].map(row => row.textContent)).toEqual([
      'Blocking · Ask A1',
      'Answered · Done A7',
    ]);
    expect(reads).toEqual([LEAD]);
    await view.unmount();
    view = await mount(<BoardDetail {...props} taskId="F4" />);
    await flush();
    expect(view.container.querySelector('[data-section="asks"]')).toBeNull();
  });

  it('the client reads a ferret’s agenda and answers null for what it cannot read', async () => {
    const calls: unknown[] = [];
    const client = (answer: () => unknown) => ({
      call: (async (route: string, init: unknown) => {
        calls.push([route, init]);
        return answer();
      }) as never,
    });
    expect(await clientBoardPort(client(() => 'nonsense')).agenda(laptop, LEAD)).toBeNull();
    expect(
      await clientBoardPort(
        client(() => {
          throw new Error('refused');
        }),
      ).agenda(laptop, LEAD),
    ).toBeNull();
    expect(calls[0]).toEqual(['GET /v1/ferrets/:ferretId/agenda', { params: { ferretId: LEAD } }]);
  });
});
