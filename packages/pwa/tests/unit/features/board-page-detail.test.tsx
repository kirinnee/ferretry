import { afterEach, describe, expect, it } from 'bun:test';
import { boardOk } from '@ferretry/protocol';
import { BoardPage, type BoardPageProps } from '../../../src/features/board/board-page.tsx';
import { DaemonAgendaStore } from '../../../src/lib/agenda-store.ts';
import { DaemonBoardStore } from '../../../src/lib/board-store.ts';
import { daemonBoardCardPath, daemonBoardPath, daemonSessionPath } from '../../../src/lib/pages/routes.ts';
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
import { clickNamed, fill, HELPER, NOW, submit } from './board-detail-support.tsx';

let view: Mounted | null = null;
const unmount = async (): Promise<void> => {
  await (view as Mounted | null)?.unmount();
  view = null;
};
afterEach(unmount);

interface Options {
  readonly withPorts?: boolean;
  readonly withAgenda?: boolean;
  readonly agenda?: BoardPageProps['agenda'];
  readonly openCard?: BoardPageProps['openCard'];
  readonly machines?: BoardPageProps['machines'];
  readonly phone?: boolean;
}

const open = async (options: Options = {}) => {
  const navigated: string[] = [];
  const started: string[] = [];
  const sent: { sessionId: string; message: string }[] = [];
  const created: unknown[] = [];
  const port = fakePort({
    board: async () =>
      boardAnswer([card('F1', { title: 'Build it', laneId: 'implement' })], {
        projectId: PROJECT,
        laneSet: laneSetFor(),
        counts: COUNTS,
      }),
    projects: async () => [{ id: PROJECT, name: 'ferretry', path: null, laneSet: laneSetFor() }],
    task: async () => ({ task: card('F1', { title: 'Build it', laneId: 'implement' }), laneSet: laneSetFor() }),
    create: async (_daemon, request) => {
      created.push(request);
      return boardOk({ task: card('F7', { title: 'Fresh card' }), laneSet: laneSetFor() }) as never;
    },
  });
  const store = new DaemonBoardStore(port, fakeEnvironment());
  const agenda: BoardPageProps['agenda'] =
    options.agenda !== undefined
      ? options.agenda
      : options.withAgenda === false
        ? { respond: async () => undefined }
        : { respond: async () => undefined, hydrate: async () => undefined, store: new DaemonAgendaStore() };
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
    ...(options.withPorts === false
      ? {}
      : {
          ports: {
            startFerret: async (_daemon, prompt) => {
              started.push(prompt);
              return HELPER;
            },
            sendMessage: async (_daemon, sessionId, message) => {
              sent.push({ sessionId, message });
            },
          },
        }),
  };
  view = await mount(<BoardPage {...props} />);
  await interact(() => flush());
  return { root: view.container, navigated, started, sent, created };
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

  respond(): Promise<void> {
    this.#sessions.push('respond');
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

  it('draws no detail without ports, without the ferret agenda, or for a machine that is not paired', async () => {
    expect((await open({ openCard: CARD, withPorts: false })).root.querySelector('aside')).toBeNull();
    await unmount();
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

const adds = (root: ParentNode): HTMLButtonElement[] => [
  ...root.querySelectorAll<HTMLButtonElement>('button[data-board-add]'),
];
const add = (root: ParentNode, where: 'header' | 'fab'): HTMLButtonElement =>
  must(root.querySelector<HTMLButtonElement>(`button[data-board-add="${where}"]`), `the ${where} add button`);

describe('BoardPage — Add card', () => {
  it('offers Add card only with ports to start and speak to ferrets, and only with a machine', async () => {
    expect(adds((await open()).root)).toHaveLength(1);
    await unmount();
    expect(adds((await open({ withPorts: false })).root)).toHaveLength(0);
    await unmount();
    expect(adds((await open({ machines: [] })).root)).toHaveLength(0);
  });

  it('puts the button in the header beside Lanes on a desktop, never in a chip row', async () => {
    const { root } = await open();
    const button = add(root, 'header');
    expect(button.closest('.fy-board__tools')).not.toBeNull();
    expect(button.closest('.fy-board__phone-bar')).toBeNull();
    expect(root.querySelector('.fy-board__fab')).toBeNull();
    expect(button.textContent).toBe('Add card');
  });

  it('floats one labelled button on a phone, outside the chip row', async () => {
    const { root } = await open({ phone: true });
    const button = add(root, 'fab');
    expect(adds(root)).toHaveLength(1);
    expect(button.getAttribute('aria-label')).toBe('Add card');
    expect(button.closest('.fy-board__phone-bar')).toBeNull();
    expect(root.querySelector('.fy-board__phone-bar')?.querySelector('[data-board-add]')).toBeNull();
    expect(button.closest('.fy-board__fab')?.parentElement?.classList.contains('fy-board')).toBe(true);
  });

  it('opens the form from the phone button and writes a card end to end', async () => {
    const { root, navigated, created, started } = await open({ phone: true });
    await interact(() => add(root, 'fab').click());
    const form = must(root.querySelector('form[role="dialog"]'), 'the form');
    const labelled = (label: string) =>
      must(
        [...form.querySelectorAll('label')].find(entry => entry.textContent?.trim().startsWith(label)),
        label,
      );
    await fill(must(labelled('Title').querySelector('input'), 'title'), 'Fresh card');
    await fill(must(labelled('What you want done').querySelector('textarea'), 'ask'), 'make it');
    await interact(() => must(labelled('Start a ferret').querySelector('input'), 'start').click());
    await submit(form);
    await interact(() => flush());
    expect(started).toHaveLength(1);
    expect(created).toHaveLength(1);
    expect(navigated).toEqual([daemonBoardCardPath(laptop.daemonId, 'F7')]);
    expect(root.querySelector('form[role="dialog"]')).toBeNull();
    expect(adds(root)).toHaveLength(1);
  });

  it('opens the form on the first machine and closes it on Cancel', async () => {
    const { root } = await open();
    await interact(() => add(root, 'header').click());
    expect(root.querySelector('.fy-board-reason__heading')?.textContent).toBe('New card on laptop');
    await clickNamed(root, 'Cancel');
    expect(root.querySelector('form[role="dialog"]')).toBeNull();
  });

  it('writes the card, closes the form and opens the new card', async () => {
    const { root, navigated, created, started, sent } = await open();
    await interact(() => add(root, 'header').click());
    const form = must(root.querySelector('form[role="dialog"]'), 'the form');
    const labelled = (label: string) =>
      must(
        [...form.querySelectorAll('label')].find(entry => entry.textContent?.trim().startsWith(label)),
        label,
      );
    await fill(must(labelled('Title').querySelector('input'), 'title'), 'Fresh card');
    await fill(must(labelled('What you want done').querySelector('textarea'), 'ask'), 'make it');
    await interact(() => must(labelled('Start a ferret').querySelector('input'), 'start').click());
    await submit(form);
    await interact(() => flush());
    expect(started).toHaveLength(1);
    expect(created).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(navigated).toEqual([daemonBoardCardPath(laptop.daemonId, 'F7')]);
    expect(root.querySelector('form[role="dialog"]')).toBeNull();
    expect(adds(root)).toHaveLength(1);
  });
});
