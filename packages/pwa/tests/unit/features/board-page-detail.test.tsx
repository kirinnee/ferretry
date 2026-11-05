import { afterEach, describe, expect, it } from 'bun:test';
import { BoardPage, type BoardPageProps } from '../../../src/features/board/board-page.tsx';
import { DaemonAgendaStore } from '../../../src/lib/agenda-store.ts';
import { DaemonBoardStore } from '../../../src/lib/board-store.ts';
import { daemonBoardPath, daemonSessionPath } from '../../../src/lib/pages/routes.ts';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
import {
  boardAnswer,
  COUNTS,
  card,
  fakeEnvironment,
  fakePort,
  flush,
  laneSetFor,
  laptop,
  PROJECT,
} from '../board-support.ts';
import { clickNamed, HELPER, NOW } from './board-detail-support.tsx';

let view: Mounted | null = null;
const unmount = async (): Promise<void> => {
  await (view as Mounted | null)?.unmount();
  view = null;
};
afterEach(unmount);

interface Options {
  readonly withAgenda?: boolean;
  readonly agenda?: BoardPageProps['agenda'];
  readonly openCard?: BoardPageProps['openCard'];
  readonly machines?: BoardPageProps['machines'];
  readonly phone?: boolean;
}

const open = async (options: Options = {}) => {
  const navigated: string[] = [];
  const port = fakePort({
    board: async () =>
      boardAnswer([card('F1', { title: 'Build it', laneId: 'implement' })], {
        projectId: PROJECT,
        laneSet: laneSetFor(),
        counts: COUNTS,
      }),
    projects: async () => [{ id: PROJECT, name: 'ferretry', path: null, laneSet: laneSetFor() }],
    task: async () => ({ task: card('F1', { title: 'Build it', laneId: 'implement' }), laneSet: laneSetFor() }),
  });
  const store = new DaemonBoardStore(port, fakeEnvironment());
  const agenda: BoardPageProps['agenda'] =
    options.agenda !== undefined
      ? options.agenda
      : options.withAgenda === false
        ? {}
        : { hydrate: async () => undefined, store: new DaemonAgendaStore() };
  const props: BoardPageProps = {
    store,
    agenda,
    machines: options.machines ?? [{ connection: laptop, name: 'laptop' }],
    callsigns: new Map([[HELPER, 'helper']]),
    search: '',
    onSearch: () => undefined,
    onNavigate: to => void navigated.push(to),
    now: NOW,
    phone: options.phone ?? false,
    ...(options.openCard === undefined ? {} : { openCard: options.openCard }),
  };
  view = await mount(<BoardPage {...props} />);
  await interact(() => flush());
  return { root: view.container, navigated };
};

const CARD = { daemonId: laptop.daemonId, taskId: 'F1' };

/**
 * An agenda shaped like the app's real one: a CLASS whose methods read its own private fields, so a method
 * copied off it and called bare throws "Receiver must be an instance of class" — exactly what took every card
 * down on 2026-10-30. A plain object, which every other case here passes, cannot catch that.
 */
class PrivateFieldAgenda {
  readonly #sessions: string[] = [];
  readonly store = new DaemonAgendaStore();

  hydrate(_daemon: unknown, scope: { readonly sessionId: string }): Promise<void> {
    this.#sessions.push(scope.sessionId);
    return Promise.resolve();
  }

  hydrated(): readonly string[] {
    return [...this.#sessions];
  }
}

describe('BoardPage — the card detail', () => {
  it('draws no detail without an open card', async () => {
    const { root } = await open();
    expect(root.querySelector('.fy-board-detail__scrim')).toBeNull();
  });

  it('draws the open card beside the board, read from the machine it belongs to', async () => {
    const { root } = await open({ openCard: CARD });
    expect(root.querySelector('aside .fy-board-detail__title')?.textContent).toBe('&F1 Build it');
    expect(root.querySelector('aside')?.getAttribute('data-mode')).toBe('drawer');
    expect(root.querySelector('.fy-board-detail__meta')?.textContent).toContain('ferretry');
  });

  it('opens a card over an agenda client that is a class with private fields, calling it on itself', async () => {
    const agenda = new PrivateFieldAgenda();
    const { root } = await open({ openCard: CARD, agenda: agenda as unknown as BoardPageProps['agenda'] });
    expect(root.querySelector('aside .fy-board-detail__title')?.textContent).toBe('&F1 Build it');
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(agenda.hydrated()).toEqual(['mvuc7tsf-0c3d50df']);
  });

  it('is a page on a phone', async () => {
    const { root } = await open({ openCard: CARD, phone: true });
    expect(root.querySelector('aside')?.getAttribute('data-mode')).toBe('page');
  });

  it('draws no detail without the ferret agenda, or for a machine that is not paired', async () => {
    expect((await open({ openCard: CARD, withAgenda: false })).root.querySelector('aside')).toBeNull();
    await unmount();
    const stranger = { daemonId: 'someone-else', taskId: 'F1' } as never;
    expect((await open({ openCard: stranger })).root.querySelector('aside')).toBeNull();
  });

  it('closes by going back to the machine board', async () => {
    const { root, navigated } = await open({ openCard: CARD });
    await interact(() => must(root.querySelector<HTMLElement>('.fy-board-detail__backdrop'), 'the backdrop').click());
    expect(navigated).toEqual([daemonBoardPath(laptop.daemonId)]);
  });

  it('hands the detail the navigator, so Open chat goes to the owner session', async () => {
    const { root, navigated } = await open({ openCard: CARD });
    await clickNamed(root, 'Open chat');
    expect(navigated).toEqual([daemonSessionPath(laptop.daemonId, 'mvuc7tsf-0c3d50df')]);
  });
});

describe('BoardPage — no Add card', () => {
  it('offers no Add card button and no new-card form, on a desktop or a phone', async () => {
    for (const phone of [false, true]) {
      const { root } = await open({ phone });
      expect(root.querySelector('[data-board-add], .fy-board__fab, .fy-board__add, form[role="dialog"]')).toBeNull();
      expect(root.textContent).not.toContain('Add card');
      await unmount();
    }
  });
});
