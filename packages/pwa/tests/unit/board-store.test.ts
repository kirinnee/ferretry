import { describe, expect, it } from 'bun:test';
import { boardErr, boardOk } from '@ferretry/protocol';
import { NO_BOARD_FILTERS, toServerQuery } from '../../src/lib/board-model.ts';
import { BOARD_DERIVE_MS, DaemonBoardStore } from '../../src/lib/board-store.ts';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import {
  boardAnswer,
  card,
  deferred,
  fakeEnvironment,
  fakePort,
  flush,
  laneSetFor,
  laptop,
  PROJECT,
  workstation,
} from './board-support.ts';

const query = toServerQuery(NO_BOARD_FILTERS);
const lanes = laneSetFor();
const event = (taskIds: string[]) => ({ type: 'board.changed', data: { projectId: PROJECT, taskIds } });

const open = (port = fakePort(), environment = fakeEnvironment()) => {
  const store = new DaemonBoardStore(port, environment);
  return { store, port, environment };
};

const cardsOf = (store: DaemonBoardStore, key: string, daemonId: DaemonId) =>
  [...(store.view(key)?.slices.get(daemonId)?.cards.values() ?? [])].map(entry => `${entry.id}:${entry.laneId}`);

describe('DaemonBoardStore reads', () => {
  it('reads every machine and keeps a same-numbered card on each, apart', async () => {
    const port = fakePort({
      board: async daemon =>
        boardAnswer([card('F12', { title: daemon.daemonId })], { projectId: PROJECT, laneSet: lanes }),
    });
    const { store } = open(port);
    const { key } = store.watch(query, [laptop, workstation]);
    await flush();
    expect(store.view(key)?.slices.get(laptop.daemonId)?.cards.get('F12')?.title).toBe(laptop.daemonId);
    expect(store.view(key)?.slices.get(workstation.daemonId)?.cards.get('F12')?.title).toBe(workstation.daemonId);
    expect(store.view(key)?.slices.get(laptop.daemonId)?.status).toBe('ready');
    expect(store.view(key)?.slices.get(laptop.daemonId)?.version).toBe('4.110.0');
    expect(store.view(key)?.slices.get(laptop.daemonId)?.laneSets.get(PROJECT)).toEqual(lanes);
  });

  it('shares one view between pages asking the same thing and drops it when the last lets go', async () => {
    const { store, port } = open();
    const first = store.watch(query, [laptop]);
    const second = store.watch(query, [laptop]);
    await flush();
    expect(first.key).toBe(second.key);
    expect(port.calls.filter(call => call.startsWith('board:'))).toHaveLength(1);
    first.release();
    expect(store.view(first.key)).not.toBeNull();
    second.release();
    second.release();
    expect(store.view(first.key)).toBeNull();
  });

  it('asks a project with no served lane set for its lanes, one tiny read each', async () => {
    const port = fakePort({
      board: async (_daemon, asked, _cursor, limit) =>
        limit === 1 ? boardAnswer([], { projectId: asked.project, laneSet: lanes }) : boardAnswer([card('F1')]),
    });
    const { store } = open(port);
    const { key } = store.watch(query, [laptop]);
    await flush();
    expect(store.view(key)?.slices.get(laptop.daemonId)?.laneSets.get(PROJECT)).toEqual(lanes);
  });

  it('uses the projects route when the daemon serves it', async () => {
    const port = fakePort({
      board: async () => boardAnswer([card('F1')]),
      projects: async () => [{ id: PROJECT, name: 'ferretry', path: '/x', laneSet: lanes }],
    });
    const { store } = open(port);
    const { key } = store.watch(query, [laptop]);
    await flush();
    expect(store.view(key)?.slices.get(laptop.daemonId)?.laneSets.get(PROJECT)).toEqual(lanes);
    expect(port.calls.some(call => call.startsWith('board:') && call.endsWith(`:${PROJECT}:`))).toBe(false);
  });

  it('says a machine failed without blanking the cards it already had', async () => {
    let fail = false;
    const port = fakePort({
      board: async () => {
        if (fail) throw new Error('daemon down');
        return boardAnswer([card('F1')], { projectId: PROJECT, laneSet: lanes });
      },
    });
    const { store, environment } = open(port);
    const { key } = store.watch(query, [laptop]);
    await flush();
    fail = true;
    environment.advance(BOARD_DERIVE_MS);
    environment.fire();
    await flush();
    const slice = store.view(key)?.slices.get(laptop.daemonId);
    expect(slice?.status).toBe('error');
    expect(slice?.error).toBe('daemon down');
    expect(slice?.cards.has('F1')).toBe(true);
  });

  it('marks a board longer than the pages read as truncated and never deletes what it did not read', async () => {
    let pages = 0;
    const port = fakePort({
      board: async () => {
        pages += 1;
        return boardAnswer([card(`F${pages}`)], { projectId: PROJECT, laneSet: lanes, nextCursor: 'more' });
      },
    });
    const { store, environment } = open(port);
    const { key } = store.watch(query, [laptop]);
    await flush();
    expect(store.view(key)?.slices.get(laptop.daemonId)?.truncated).toBe(true);
    const firstPage = [...(store.view(key)?.slices.get(laptop.daemonId)?.cards.keys() ?? [])];
    expect(firstPage).toEqual(['F1', 'F2', 'F3', 'F4']);
    pages = 100;
    environment.advance(BOARD_DERIVE_MS);
    environment.fire();
    await flush();
    expect(store.view(key)?.slices.get(laptop.daemonId)?.cards.has('F1')).toBe(true);
  });
});

describe('DaemonBoardStore live updates', () => {
  const live = async (initial = [card('F1'), card('F2')]) => {
    const served = new Map(initial.map(entry => [entry.id, entry]));
    const port = fakePort({
      board: async () => boardAnswer([...served.values()], { projectId: PROJECT, laneSet: lanes }),
      task: async (daemon, id) => {
        port.calls.push(`task:${daemon.daemonId}:${id}`);
        const found = served.get(id);
        return found === undefined ? null : { task: found, laneSet: lanes };
      },
    });
    const harness = open(port);
    const { key } = harness.store.watch(query, [laptop]);
    await flush();
    return { ...harness, served, key };
  };

  it('re-reads only the cards a board.changed names, not the board', async () => {
    const { store, port, served, key } = await live();
    const boardReads = port.calls.filter(call => call.startsWith('board:')).length;
    served.set('F2', card('F2', { laneId: 'review' }));
    store.noteEvent(laptop.daemonId, event(['F2', 'F2']));
    await flush();
    expect(cardsOf(store, key, laptop.daemonId)).toEqual(['F1:implement', 'F2:review']);
    expect(port.calls.filter(call => call.startsWith('task:'))).toEqual([`task:${laptop.daemonId}:F2`]);
    expect(port.calls.filter(call => call.startsWith('board:'))).toHaveLength(boardReads);
  });

  it('adds a new card, and takes out one the machine no longer has', async () => {
    const { store, served, key } = await live();
    served.set('F3', card('F3'));
    served.delete('F1');
    store.noteEvent(laptop.daemonId, event(['F3', 'F1']));
    await flush();
    expect(cardsOf(store, key, laptop.daemonId).sort()).toEqual(['F2:implement', 'F3:implement']);
  });

  it('takes a card out of a board it no longer belongs to (closed, on the open board)', async () => {
    const { store, served, key } = await live();
    served.set('F1', card('F1', { laneId: 'closed' }));
    store.noteEvent(laptop.daemonId, event(['F1']));
    await flush();
    expect(cardsOf(store, key, laptop.daemonId)).toEqual(['F2:implement']);
  });

  it('ignores other events, malformed ones, and machines nothing is watching', async () => {
    const { store, port } = await live();
    const before = port.calls.length;
    store.noteEvent(laptop.daemonId, { type: 'session.started', data: {} });
    store.noteEvent(laptop.daemonId, { type: 'board.changed', data: { taskIds: 'F1' } });
    store.noteEvent(workstation.daemonId, event(['F1']));
    await flush();
    expect(port.calls).toHaveLength(before);
  });

  it('leaves the board alone when a card read fails', async () => {
    const { store, port, key } = await live();
    port.task = async () => {
      throw new Error('boom');
    };
    store.noteEvent(laptop.daemonId, event(['F1']));
    await flush();
    expect(cardsOf(store, key, laptop.daemonId)).toEqual(['F1:implement', 'F2:implement']);
  });

  it('does not let a whole-board read issued before an event overwrite the newer card', async () => {
    const held = deferred<ReturnType<typeof boardAnswer>>();
    let slow = false;
    const port = fakePort({
      board: async () => {
        if (!slow) return boardAnswer([card('F1')], { projectId: PROJECT, laneSet: lanes });
        return await held.promise;
      },
      task: async () => ({ task: card('F1', { laneId: 'review' }), laneSet: lanes }),
    });
    const { store, environment } = open(port);
    const { key } = store.watch(query, [laptop]);
    await flush();
    slow = true;
    environment.advance(BOARD_DERIVE_MS);
    environment.fire();
    await flush();
    store.noteEvent(laptop.daemonId, event(['F1']));
    await flush();
    expect(cardsOf(store, key, laptop.daemonId)).toEqual(['F1:review']);
    // The older read settles last, still describing the card where it was.
    held.resolve(boardAnswer([card('F1', { laneId: 'implement' })], { projectId: PROJECT, laneSet: lanes }));
    await flush();
    expect(cardsOf(store, key, laptop.daemonId)).toEqual(['F1:review']);
  });

  it('does not let an older whole-board read bring back a card an event removed', async () => {
    const held = deferred<ReturnType<typeof boardAnswer>>();
    let slow = false;
    const port = fakePort({
      board: async () => {
        if (!slow) return boardAnswer([card('F1')], { projectId: PROJECT, laneSet: lanes });
        return await held.promise;
      },
      task: async () => null,
    });
    const { store, environment } = open(port);
    const { key } = store.watch(query, [laptop]);
    await flush();
    slow = true;
    environment.advance(BOARD_DERIVE_MS);
    environment.fire();
    await flush();
    store.noteEvent(laptop.daemonId, event(['F1']));
    await flush();
    expect(cardsOf(store, key, laptop.daemonId)).toEqual([]);
    held.resolve(boardAnswer([card('F1')], { projectId: PROJECT, laneSet: lanes }));
    await flush();
    expect(cardsOf(store, key, laptop.daemonId)).toEqual([]);
  });

  it('lets a whole-board read issued after an event win, including a removal', async () => {
    const { store, served, key, environment } = await live();
    served.delete('F2');
    environment.advance(BOARD_DERIVE_MS);
    environment.fire();
    await flush();
    expect(cardsOf(store, key, laptop.daemonId)).toEqual(['F1:implement']);
  });

  it('carries a returned lane set into the view', async () => {
    const wider = { ...lanes, version: 2 };
    const { store, port, key } = await live();
    port.task = async () => ({ task: card('F1', { laneId: 'review' }), laneSet: wider });
    store.noteEvent(laptop.daemonId, event(['F1']));
    await flush();
    expect(store.view(key)?.slices.get(laptop.daemonId)?.laneSets.get(PROJECT)?.version).toBe(2);
  });
});

describe('DaemonBoardStore cadence', () => {
  it('re-reads the whole board every thirty seconds while a page is open, and stops when it closes', async () => {
    const { store, port, environment } = open(fakePort());
    const watching = store.watch(query, [laptop]);
    await flush();
    const reads = () => port.calls.filter(call => call.startsWith('board:')).length;
    expect(reads()).toBe(1);
    environment.fire();
    await flush();
    expect(reads()).toBe(1);
    environment.advance(BOARD_DERIVE_MS);
    environment.fire();
    await flush();
    expect(reads()).toBe(2);
    environment.advance(BOARD_DERIVE_MS);
    environment.fire();
    await flush();
    expect(reads()).toBe(3);
    watching.release();
    expect(environment.pending()).toBe(0);
  });

  it('reads nothing while the page is hidden and the next beat after it is shown', async () => {
    const { store, port, environment } = open(fakePort());
    store.watch(query, [laptop]);
    await flush();
    environment.show(false);
    environment.advance(BOARD_DERIVE_MS);
    environment.fire();
    await flush();
    expect(port.calls.filter(call => call.startsWith('board:'))).toHaveLength(1);
    environment.show(true);
    environment.advance(BOARD_DERIVE_MS);
    environment.fire();
    await flush();
    expect(port.calls.filter(call => call.startsWith('board:'))).toHaveLength(2);
  });

  it('refreshes one machine on demand', async () => {
    const { store, port } = open(fakePort());
    const { key } = store.watch(query, [laptop, workstation]);
    await flush();
    await store.refresh(key, laptop.daemonId);
    await store.refresh('missing', laptop.daemonId);
    expect(port.calls.filter(call => call === `board:${laptop.daemonId}:*:`)).toHaveLength(2);
    expect(port.calls.filter(call => call === `board:${workstation.daemonId}:*:`)).toHaveLength(1);
  });
});

describe('DaemonBoardStore forgetting a machine', () => {
  it('drops its slices and ignores what it was still being asked', async () => {
    const held = deferred<ReturnType<typeof boardAnswer>>();
    const port = fakePort({
      board: async daemon =>
        daemon.daemonId === laptop.daemonId
          ? await held.promise
          : boardAnswer([card('F2')], { projectId: PROJECT, laneSet: lanes }),
    });
    const { store } = open(port);
    const { key } = store.watch(query, [laptop, workstation]);
    await flush();
    store.clearDaemon(laptop.daemonId);
    held.resolve(boardAnswer([card('F1')], { projectId: PROJECT, laneSet: lanes }));
    await flush();
    expect(store.view(key)?.slices.has(laptop.daemonId)).toBe(false);
    expect(cardsOf(store, key, workstation.daemonId)).toEqual(['F2:implement']);
    store.noteEvent(laptop.daemonId, event(['F1']));
    await flush();
    expect(store.view(key)?.slices.has(laptop.daemonId)).toBe(false);
  });
});

describe('DaemonBoardStore writes', () => {
  it('puts the card the daemon answers into every view and page showing it', async () => {
    const moved = card('F1', { laneId: 'review' });
    const port = fakePort({
      board: async () => boardAnswer([card('F1')], { projectId: PROJECT, laneSet: lanes }),
      task: async () => ({ task: card('F1'), laneSet: lanes }),
      act: async () => boardOk({ task: moved, laneSet: lanes }),
    });
    const { store } = open(port);
    const { key } = store.watch(query, [laptop]);
    const releaseTask = store.watchTask(laptop, 'F1');
    await flush();
    const answer = await store.act(laptop, 'F1', { action: 'move', to: 'review' });
    expect(answer.ok).toBe(true);
    expect(cardsOf(store, key, laptop.daemonId)).toEqual(['F1:review']);
    expect(store.taskState(laptop.daemonId, 'F1').task?.laneId).toBe('review');
    releaseTask();
  });

  it('changes nothing when the daemon refuses, and hands the refusal back', async () => {
    const refusal = { status: 409, message: 'needs a reason', boardCode: 'reason-required' as const };
    const port = fakePort({
      board: async () => boardAnswer([card('F1')], { projectId: PROJECT, laneSet: lanes }),
      act: async () => boardErr(refusal),
    });
    const { store } = open(port);
    const { key } = store.watch(query, [laptop]);
    await flush();
    const answer = await store.act(laptop, 'F1', { action: 'move', to: 'plan', reason: 'x' });
    expect(answer).toEqual(boardErr(refusal));
    expect(cardsOf(store, key, laptop.daemonId)).toEqual(['F1:implement']);
  });
});

describe('DaemonBoardStore create', () => {
  const request = { kind: 'feature', title: 'Try it', ask: { text: 'do it', source: 'owner (board)' } } as const;

  it('puts the card the daemon opened into the views showing that machine', async () => {
    const port = fakePort({
      board: async () => boardAnswer([card('F1')], { projectId: PROJECT, laneSet: lanes }),
      create: async () => boardOk({ task: card('F9'), laneSet: lanes }),
    });
    const { store } = open(port);
    const { key } = store.watch(query, [laptop]);
    await flush();
    const answer = await store.create(laptop, request);
    expect(answer.ok && answer.value.id).toBe('F9');
    expect(cardsOf(store, key, laptop.daemonId).sort()).toEqual(['F1:implement', 'F9:implement']);
  });

  it('changes nothing when the daemon refuses, and hands the refusal back', async () => {
    const refusal = { status: 403, message: 'owner only', boardCode: 'owner-gate' as const };
    const port = fakePort({
      board: async () => boardAnswer([card('F1')], { projectId: PROJECT, laneSet: lanes }),
      create: async () => boardErr(refusal),
    });
    const { store } = open(port);
    const { key } = store.watch(query, [laptop]);
    await flush();
    expect(await store.create(laptop, request)).toEqual(boardErr(refusal));
    expect(cardsOf(store, key, laptop.daemonId)).toEqual(['F1:implement']);
  });

  it('does not place a card the machine was forgotten before it was opened', async () => {
    const opened = deferred<ReturnType<typeof boardOk>>();
    const port = fakePort({
      board: async () => boardAnswer([card('F1')], { projectId: PROJECT, laneSet: lanes }),
      create: async () => (await opened.promise) as never,
    });
    const { store } = open(port);
    const { key } = store.watch(query, [laptop]);
    await flush();
    const pending = store.create(laptop, request);
    store.clearDaemon(laptop.daemonId);
    opened.resolve(boardOk({ task: card('F9'), laneSet: lanes }));
    expect((await pending).ok).toBe(true);
    expect(cardsOf(store, key, laptop.daemonId)).toEqual([]);
  });

  it('skips views that do not show the machine', async () => {
    const port = fakePort({
      board: async () => boardAnswer([card('F1')], { projectId: PROJECT, laneSet: lanes }),
      create: async () => boardOk({ task: card('F9'), laneSet: lanes }),
    });
    const { store } = open(port);
    const { key } = store.watch(query, [workstation]);
    await flush();
    await store.create(laptop, request);
    expect(cardsOf(store, key, laptop.daemonId)).toEqual([]);
  });
});

describe('DaemonBoardStore one card and projects', () => {
  it('reads one card, says when the machine has none, re-reads on its event and on the beat', async () => {
    let task: ReturnType<typeof card> | null = card('F1');
    const port = fakePort({ task: async () => (task === null ? null : { task, laneSet: lanes }) });
    const { store, environment } = open(port);
    const release = store.watchTask(laptop, 'F1');
    store.watchTask(laptop, 'F1')();
    await flush();
    expect(store.taskState(laptop.daemonId, 'F1')).toMatchObject({ status: 'ready', missing: false });
    task = card('F1', { laneId: 'review' });
    store.noteEvent(laptop.daemonId, event(['F1']));
    await flush();
    expect(store.taskState(laptop.daemonId, 'F1').task?.laneId).toBe('review');
    task = null;
    environment.advance(BOARD_DERIVE_MS);
    environment.fire();
    await flush();
    expect(store.taskState(laptop.daemonId, 'F1')).toMatchObject({ missing: true, task: null });
    release();
    expect(environment.pending()).toBe(0);
    expect(store.taskState(laptop.daemonId, 'F1').status).toBe('idle');
  });

  it('keeps the card it had when a re-read fails', async () => {
    let fail = false;
    const port = fakePort({
      task: async () => {
        if (fail) throw new Error('nope');
        return { task: card('F1'), laneSet: lanes };
      },
    });
    const { store, environment } = open(port);
    store.watchTask(laptop, 'F1');
    await flush();
    fail = true;
    environment.advance(BOARD_DERIVE_MS);
    environment.fire();
    await flush();
    expect(store.taskState(laptop.daemonId, 'F1')).toMatchObject({ status: 'error', error: 'nope' });
    expect(store.taskState(laptop.daemonId, 'F1').task?.id).toBe('F1');
  });

  it('reads each machine’s projects once and says when it does not serve them', async () => {
    const port = fakePort({
      projects: async daemon => {
        port.calls.push(`projects:${daemon.daemonId}`);
        return daemon.daemonId === laptop.daemonId
          ? [{ id: PROJECT, name: 'ferretry', path: null, laneSet: lanes }]
          : null;
      },
    });
    const { store } = open(port);
    const releaseLaptop = store.watchProjects(laptop);
    store.watchProjects(workstation);
    store.watchProjects(laptop)();
    await flush();
    expect(store.projectsState(laptop.daemonId)).toMatchObject({ status: 'ready', served: true });
    expect(store.projectsState(laptop.daemonId).projects?.[0]?.name).toBe('ferretry');
    expect(store.projectsState(workstation.daemonId)).toMatchObject({ status: 'ready', served: false, projects: null });
    expect(port.calls.filter(call => call === `projects:${laptop.daemonId}`)).toHaveLength(1);
    releaseLaptop();
    releaseLaptop();
  });

  it('keeps projects it had and reports the error when a refresh fails, and forgets them with the machine', async () => {
    let fail = false;
    const port = fakePort({
      projects: async () => {
        if (fail) throw new Error('later');
        return [];
      },
    });
    const { store } = open(port);
    store.watchProjects(laptop);
    await flush();
    fail = true;
    await store.refreshProjects(laptop);
    expect(store.projectsState(laptop.daemonId)).toMatchObject({ status: 'error', error: 'later', projects: [] });
    store.clearDaemon(laptop.daemonId);
    expect(store.projectsState(laptop.daemonId).status).toBe('idle');
  });
});

describe('DaemonBoardStore odds and ends', () => {
  it('stops telling a listener once it unsubscribes', async () => {
    const { store } = open();
    let heard = 0;
    const stop = store.subscribe(() => {
      heard += 1;
    });
    store.watch(query, [laptop]);
    await flush();
    const before = heard;
    expect(before).toBeGreaterThan(0);
    stop();
    store.clearDaemon(laptop.daemonId);
    expect(heard).toBe(before);
  });

  it('falls back to no lane set when the one-card lane read fails', async () => {
    const port = fakePort({
      board: async (_daemon, _asked, _cursor, limit) => {
        if (limit === 1) throw new Error('no');
        return boardAnswer([card('F1')]);
      },
    });
    const { store } = open(port);
    const { key } = store.watch(query, [laptop]);
    await flush();
    expect(store.view(key)?.slices.get(laptop.daemonId)?.laneSets.get(PROJECT)).toBeNull();
  });

  it('drops a card watch with its machine and ignores that card’s late answer', async () => {
    const held = deferred<{ task: ReturnType<typeof card>; laneSet: typeof lanes } | null>();
    const port = fakePort({ task: async () => await held.promise });
    const { store, environment } = open(port);
    store.watchTask(laptop, 'F1');
    await flush();
    store.clearDaemon(laptop.daemonId);
    held.resolve({ task: card('F1'), laneSet: lanes });
    await flush();
    expect(store.taskState(laptop.daemonId, 'F1').status).toBe('idle');
    expect(environment.pending()).toBe(0);
  });

  it('ignores a failing card read that comes back after its machine was forgotten', async () => {
    const held = deferred<null>();
    const port = fakePort({ task: async () => await held.promise });
    const { store } = open(port);
    store.watchTask(laptop, 'F1');
    await flush();
    store.clearDaemon(laptop.daemonId);
    held.reject(new Error('late'));
    await flush();
    expect(store.taskState(laptop.daemonId, 'F1').error).toBeNull();
  });
});
