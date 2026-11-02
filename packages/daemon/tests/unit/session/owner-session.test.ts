import { describe, it } from 'bun:test';
import should from 'should';
import { mostRecentLiveSession } from '../../../src/adapters/session/owner-session.ts';

const ENDED = new Set(['completed', 'failed', 'stopped']);

const storage = (states: Readonly<Record<string, unknown>>) =>
  ({
    listSessions: () => Object.keys(states).map(id => ({ id })),
    readState: async (id: string) => {
      const state = states[id];
      if (state instanceof Error) throw state;
      return state;
    },
  }) as never;

describe('mostRecentLiveSession', () => {
  it('should pick the live session with the latest activity, falling back to its start', async () => {
    // Arrange
    const sessions = storage({
      old: { status: 'running', lastActivityAt: '2026-11-01T10:00:00.000Z' },
      newest: { status: 'idle', lastActivityAt: '2026-11-02T09:00:00.000Z' },
      started: { status: 'running', startedAt: '2026-11-02T08:00:00.000Z' },
    });

    // Act / Assert
    should(await mostRecentLiveSession(sessions, ENDED)).equal('newest');
  });

  it('should never pick an ended session, nor one whose state cannot be read', async () => {
    // Arrange
    const sessions = storage({
      done: { status: 'completed', lastActivityAt: '2026-11-02T10:00:00.000Z' },
      broken: new Error('unreadable'),
      alive: { status: 'running', lastActivityAt: '2026-11-01T10:00:00.000Z' },
    });

    // Act / Assert
    should(await mostRecentLiveSession(sessions, ENDED)).equal('alive');
  });

  it('should say nothing when no session is running', async () => {
    should(await mostRecentLiveSession(storage({ done: { status: 'stopped' } }), ENDED)).be.undefined();
    should(await mostRecentLiveSession(storage({}), ENDED)).be.undefined();
  });
});
