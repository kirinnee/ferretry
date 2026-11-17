import { describe, expect, test } from 'bun:test';
import {
  formerPath,
  readBoard,
  readTask,
  readMergeGate,
  safeReadTask,
  safeReadTaskStart,
  safeReadChanged,
  taskWire,
  withFormerPaths,
} from '../../contract/index.ts';
import { boardTask, taskResponse, laneSet, response } from './cli/fixtures.ts';

const PROJECT = '0b1f6d1e-6c1b-4f0c-8f4e-2f6f2a3c9a10';

describe('the task wire keys (O18, RULING 2)', () => {
  test('the daemon says tasks and task, and nothing else of the answer moves', () => {
    const sent = taskWire.board(response()) as Record<string, unknown>;
    expect(Object.keys(sent)).toContain('tasks');
    expect(Object.keys(sent)).not.toContain('cards');
    expect(sent.counts).toEqual(response().counts);

    const one = taskWire.card(taskResponse(boardTask({ id: 'F7' }), laneSet())) as Record<string, unknown>;
    expect(Object.keys(one).sort()).toEqual(['laneSet', 'task']);
    expect((one.task as { id: string }).id).toBe('F7');

    expect(taskWire.start({ card: 'F7', ferret: 'f1', started: true })).toEqual({
      task: 'F7',
      ferret: 'f1',
      started: true,
    });
  });

  test('the merge gate says task in each wait', () => {
    const sent = taskWire.mergeGate({
      pr: 'https://github.com/o/r/pull/1',
      unit: [{ id: 'F1' }],
      waits: [{ card: { id: 'F1' }, on: { id: 'F2' }, until: 'shipped' }],
      unreadable: [],
    }) as { waits: Record<string, unknown>[] };
    expect(sent.waits).toEqual([{ task: { id: 'F1' }, on: { id: 'F2' }, until: 'shipped' }]);
  });

  test('a reader of our own JSON takes either spelling, so a daemon one build behind still answers it', () => {
    const now = taskWire.board(response({ cards: [boardTask({ id: 'F1' })], counts: response().counts })) as unknown;
    const before = response({ cards: [boardTask({ id: 'F1' })] });
    expect(readBoard(now).cards.map(each => each.id)).toEqual(['F1']);
    expect(readBoard(before).cards.map(each => each.id)).toEqual(['F1']);

    const one = taskResponse(boardTask({ id: 'F2' }), laneSet());
    expect(readTask(taskWire.card(one)).card.id).toBe('F2');
    expect(readTask(one).card.id).toBe('F2');
    expect(safeReadTask(taskWire.card(one)).success).toBe(true);
    expect(safeReadTask({ nothing: true }).success).toBe(false);

    expect(safeReadTaskStart({ task: 'F7', ferret: 'f1', started: true }).success).toBe(true);
    expect(safeReadTaskStart({ card: 'F7', ferret: 'f1', started: true }).success).toBe(true);

    const wait = { until: 'shipped', on: { id: 'F2' } };
    const gate = (key: 'task' | 'card') => ({
      pr: 'https://github.com/o/r/pull/1',
      unit: [{ id: 'F1' }],
      waits: [{ ...wait, [key]: { id: 'F1' } }],
      unreadable: [],
    });
    expect(readMergeGate(gate('task')).waits[0]?.card).toEqual({ id: 'F1' });
    expect(readMergeGate(gate('card')).waits[0]?.card).toEqual({ id: 'F1' });

    expect(safeReadChanged({ projectId: PROJECT, taskIds: ['F1'] }).success).toBe(true);
    expect(safeReadChanged({ projectId: PROJECT, cardIds: ['F1'] })).toMatchObject({
      success: true,
      data: { taskIds: ['F1'] },
    });
    expect(safeReadChanged({ projectId: PROJECT, cardIds: 'F1' }).success).toBe(false);
  });

  test('an answer that names both spellings is not guessed at: the schema refuses it', () => {
    const both = { task: 'F7', card: 'F8', ferret: 'f1', started: true };
    expect(safeReadTaskStart(both).success).toBe(false);
  });
});

describe('the former path of a task route', () => {
  test('is the old key to the letter, `:cardId` included, and any other key is left alone', () => {
    expect(formerPath('GET /v1/board/tasks')).toBe('GET /v1/board/cards');
    expect(formerPath('POST /v1/board/tasks/:taskId')).toBe('POST /v1/board/cards/:cardId');
    expect(formerPath('POST /v1/board/tasks/:taskId/start')).toBe('POST /v1/board/cards/:cardId/start');
    expect(formerPath('GET /v1/board/ids')).toBe('GET /v1/board/ids');
  });

  test('swaps every `:taskId` in a key, not only the first', () => {
    expect(formerPath('POST /v1/board/tasks/:taskId/link/:taskId')).toBe('POST /v1/board/cards/:cardId/link/:cardId');
  });

  test('puts one handler under both keys', () => {
    const handler = () => 'same';
    const both = withFormerPaths({ 'GET /v1/board/tasks/:taskId': handler });
    expect(Object.keys(both).sort()).toEqual(['GET /v1/board/cards/:cardId', 'GET /v1/board/tasks/:taskId']);
    expect(both['GET /v1/board/cards/:cardId']).toBe(both['GET /v1/board/tasks/:taskId']);
  });
});
