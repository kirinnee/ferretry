import { describe, it } from 'bun:test';
import { UNFILED_PROJECT_ID } from '@ferretry/protocol';
import should from 'should';
import { StorageSessionProjectStamp } from '../../../src/adapters/board-projects/storage-session-project-stamp.ts';

const SESSION = 'mvue6o6o-9af569ad';
const PROJECT = '0b1f6d1e-6c1b-4f0c-8f4e-2f6f2a3c9a10';
const OTHER = '6c0e1f52-8d47-4d6a-9a31-0d2f1b7e4c55';

/** One stored config document, updated the way the session storage does: by a transform of the current one. */
const storage = (config: Record<string, unknown> | undefined) => {
  const state = { config, updates: 0 };
  return {
    state,
    port: {
      findSession: (id: string) => (id === SESSION && state.config !== undefined ? { id } : undefined),
      updateConfig: async (_id: string, transform: (current: never) => unknown) => {
        state.updates += 1;
        state.config = transform(state.config as never) as Record<string, unknown>;
        return state.config as never;
      },
    },
  };
};

const stamp = (config: Record<string, unknown> | undefined) => {
  const stored = storage(config);
  return { state: stored.state, stamp: new StorageSessionProjectStamp(stored.port as never) };
};

describe('stamping a session onto a board', () => {
  it('should move a session off the Unfiled board, keeping every other field', async () => {
    const { state, stamp: subject } = stamp({ cwd: '/work', label: 'x', projectId: UNFILED_PROJECT_ID });
    await subject.stamp(SESSION, PROJECT as never);
    should(state.config).eql({ cwd: '/work', label: 'x', projectId: PROJECT });
  });

  it('should stamp a session that predates the field', async () => {
    const { state, stamp: subject } = stamp({ cwd: '/work' });
    await subject.stamp(SESSION, PROJECT as never);
    should(state.config).eql({ cwd: '/work', projectId: PROJECT });
  });

  it('should keep a board a session is already on', async () => {
    const { state, stamp: subject } = stamp({ cwd: '/work', projectId: OTHER });
    await subject.stamp(SESSION, PROJECT as never);
    should(state.config).eql({ cwd: '/work', projectId: OTHER });
  });

  it('should touch nothing for an unknown session or an id that is not a session id', async () => {
    const { state, stamp: subject } = stamp({ cwd: '/work' });
    await subject.stamp('mvzzzzzz-00000000', PROJECT as never);
    await subject.stamp('../etc', PROJECT as never);
    should(state.updates).equal(0);
  });

  it('should refuse a project id that is not one', async () => {
    const { stamp: subject } = stamp({ cwd: '/work' });
    await should(subject.stamp(SESSION, 'not a project' as never)).be.rejected();
  });
});
