import {
  type BoardResponse,
  type BoardTaskView,
  BoardTaskViewSchema,
  LANE_TEMPLATES,
  type LaneSet,
} from '@ferretry/protocol';
import type { BoardPort } from '../../src/lib/board-client.ts';
import type { BoardEnvironment } from '../../src/lib/board-store.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';

export const PROJECT = '00000000-0000-4000-8000-000000000001';
export const OTHER_PROJECT = '00000000-0000-4000-8000-000000000002';
const LEAD = 'mvuc7tsf-0c3d50df';
export const CHILD = 'mvudnuly-ec442385';
const INSTANT = '2026-08-01T09:00:00.000Z';
const LATER = '2026-08-01T10:00:00.000Z';

export const laptop = daemonConnection({
  daemonId: 'daemon/laptop',
  baseUrl: 'https://laptop.example.test',
  deviceId: 'token-laptop',
});
export const phone = daemonConnection({
  daemonId: 'daemon/phone',
  baseUrl: 'https://phone.example.test',
  deviceId: 'token-phone',
});
export const workstation = daemonConnection({
  daemonId: 'daemon/workstation',
  baseUrl: 'https://workstation.example.test',
  deviceId: 'token-workstation',
});

export const laneSetFor = (projectId: string = PROJECT): LaneSet => ({
  projectId,
  version: 1,
  confirmedBy: 'owner',
  proposedBy: LEAD,
  ...LANE_TEMPLATES['pr-release-verify'],
});

export const COUNTS = { closedHidden: 0, stale: 0, orphaned: 0, active: 0, toTest: 0, waitingOnYou: 0 };

/** A valid card as a daemon serves it; `extra` overrides any field. */
export const card = (id: string, extra: Record<string, unknown> = {}): BoardTaskView =>
  BoardTaskViewSchema.parse({
    v: 1,
    id,
    machineId: 'kirin-box',
    projectId: PROJECT,
    laneId: 'implement',
    kind: 'feature',
    title: `Card ${id}`,
    summary: '',
    ask: { text: 'do it', source: `session:${LEAD}` },
    clarifications: [],
    premise: '',
    context: '',
    terms: [],
    brief: '',
    owner: LEAD,
    assignee: null,
    parent: null,
    dependsOn: [],
    blocked: null,
    dropped: null,
    workflow: 'design-first',
    links: { prs: [], branch: null, commits: [], docs: [] },
    files: [],
    order: null,
    createdAt: INSTANT,
    createdBy: { kind: 'ferret', sessionId: LEAD },
    history: [{ seq: 1, at: INSTANT, actor: { kind: 'ferret', sessionId: LEAD }, type: 'created', laneId: 'todo' }],
    lastTouchedAt: LATER,
    touchedBy: LEAD,
    activity: 'active',
    rollup: {
      children: 0,
      byCategory: { backlog: 0, active: 0, review: 0, shipped: 0, verify: 0, closed: 0 },
      active: 0,
      lastTouchedAt: null,
    },
    suggestedLane: null,
    waitingOnOwner: [],
    openAsks: [],
    blockedBy: [],
    blocks: [],
    shippedIn: null,
    ...extra,
  });

export const boardAnswer = (cards: readonly BoardTaskView[], extra: Partial<BoardResponse> = {}): BoardResponse => ({
  projectId: null,
  laneSet: null,
  cards: [...cards],
  counts: COUNTS,
  nextCursor: null,
  quarantined: [],
  ...extra,
});

/** A port that answers an empty board, no cards and no projects route; override what a test cares about. */
export const fakePort = (overrides: Partial<BoardPort> = {}): BoardPort & { readonly calls: string[] } => {
  const calls: string[] = [];
  const port: BoardPort = {
    board: async (daemon, query, cursor) => {
      calls.push(`board:${daemon.daemonId}:${query.project ?? '*'}:${cursor ?? ''}`);
      return boardAnswer([]);
    },
    task: async (daemon, id) => {
      calls.push(`task:${daemon.daemonId}:${id}`);
      return null;
    },
    projects: async daemon => {
      calls.push(`projects:${daemon.daemonId}`);
      return null;
    },
    version: async () => '4.110.0',
    act: async () => {
      throw new Error('act was not expected');
    },
    create: async () => {
      throw new Error('create was not expected');
    },
    ...overrides,
  };
  return Object.assign(port, { calls });
};

/** Timers by hand: `fire()` runs every timer that is due, `visible` is the page's visibility. */
export const fakeEnvironment = (): BoardEnvironment & {
  visible: () => boolean;
  show(visible: boolean): void;
  fire(): void;
  pending(): number;
  advance(milliseconds: number): void;
} => {
  let now = 1_000;
  let shown = true;
  let next = 1;
  const timers = new Map<number, { readonly at: number; readonly callback: () => void }>();
  return {
    now: () => now,
    setTimeout: (callback, milliseconds) => {
      const handle = next++;
      timers.set(handle, { at: now + milliseconds, callback });
      return handle;
    },
    clearTimeout: handle => void timers.delete(handle as number),
    visible: () => shown,
    show: visible => {
      shown = visible;
    },
    fire: () => {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= now);
      for (const [handle, timer] of due) {
        timers.delete(handle);
        timer.callback();
      }
    },
    pending: () => timers.size,
    advance: milliseconds => {
      now += milliseconds;
    },
  };
};

/** A promise settled from outside, to put one read after another. */
export const deferred = <T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

export const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await new Promise(done => setTimeout(done, 0));
};

/** The merged board of one machine, for tests that draw cards and need real `BoardModel` cards. */
export const boardModelOf = async (
  cards: readonly BoardTaskView[],
  filters?: import('../../src/lib/board-model.ts').BoardFilters,
) => {
  const { mergeBoard, NO_BOARD_FILTERS } = await import('../../src/lib/board-model.ts');
  return mergeBoard(
    [
      {
        daemonId: laptop.daemonId,
        machine: 'laptop',
        version: '4.110.0',
        cards,
        laneSets: new Map([
          [PROJECT, laneSetFor()],
          [OTHER_PROJECT, laneSetFor(OTHER_PROJECT)],
        ]),
        counts: COUNTS,
        quarantined: [],
      },
    ],
    filters ?? NO_BOARD_FILTERS,
  );
};
