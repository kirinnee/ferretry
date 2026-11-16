import { describe, expect, test } from 'bun:test';
import { defineState } from '../../contract/index.ts';
import { WORKER_STATE_KEY, workerState } from '../../worker.ts';

const Archive = defineState({ name: 'archive', path: 'archive.sqlite', store: 'sqlite', format: 1 });
const Other = defineState({ name: 'other', path: 'other.sqlite', store: 'sqlite', format: 1 });

describe('@ferretry/kernel/worker: only what the half granted', () => {
  test('an ungranted file, or a granted name under another shape, is refused without touching the disk', () => {
    const state = workerState({
      [WORKER_STATE_KEY]: [
        { file: { name: 'archive', path: 'archive.sqlite', store: 'sqlite', format: 1 }, path: '/x', label: 'l' },
      ],
    });
    expect(() => state.sqlite(Other)).toThrow('state other: not granted to this worker');
    expect(() => state.sqlite({ ...Archive, format: 2 })).toThrow(TypeError);
    expect(() => state.sqlite(Archive, 'a-name')).toThrow(TypeError);
    expect(() => workerState(undefined).sqlite(Archive)).toThrow(TypeError);
  });
});
