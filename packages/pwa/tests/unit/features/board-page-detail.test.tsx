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
import { buttonNamed, clickNamed, fill, HELPER, NOW, submit } from './board-detail-support.tsx';

let view: Mounted | null = null;
const unmount = async (): Promise<void> => {
  await (view as Mounted | null)?.unmount();
  view = null;
};
afterEach(unmount);

interface Options {
  readonly withPorts?: boolean;
  readonly withAgenda?: boolean;
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
    options.withAgenda === false
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

describe('BoardPage — the card detail', () => {
  it('draws no detail without an open card', async () => {
    const { root } = await open();
    expect(root.querySelector('.fy-board-detail__scrim')).toBeNull();
  });

  it('draws the open card beside the board, read from the machine it belongs to', async () => {
    const { root } = await open({ openCard: CARD });
    expect(root.querySelector('aside .fy-board-detail__title')?.textContent).toBe('Build it');
    expect(root.querySelector('aside')?.getAttribute('data-mode')).toBe('drawer');
    expect(root.querySelector('.fy-board-detail__meta')?.textContent).toContain('ferretry');
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

describe('BoardPage — + Card', () => {
  it('offers + Card only with ports to start and speak to ferrets, and only with a machine', async () => {
    expect([...(await open()).root.querySelectorAll('button')].some(b => b.textContent === '+ Card')).toBe(true);
    await unmount();
    expect(
      [...(await open({ withPorts: false })).root.querySelectorAll('button')].some(b => b.textContent === '+ Card'),
    ).toBe(false);
    await unmount();
    expect(
      [...(await open({ machines: [] })).root.querySelectorAll('button')].some(b => b.textContent === '+ Card'),
    ).toBe(false);
  });

  it('opens the form on the first machine and closes it on Cancel', async () => {
    const { root } = await open();
    await clickNamed(root, '+ Card');
    expect(root.querySelector('.fy-board-reason__heading')?.textContent).toBe('New card on laptop');
    await clickNamed(root, 'Cancel');
    expect(root.querySelector('form[role="dialog"]')).toBeNull();
  });

  it('writes the card, closes the form and opens the new card', async () => {
    const { root, navigated, created, started, sent } = await open();
    await clickNamed(root, '+ Card');
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
    expect(buttonNamed(root, '+ Card')).not.toBeNull();
  });
});
