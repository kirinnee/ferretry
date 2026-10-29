import { describe, it } from 'bun:test';
import should from 'should';
import { parseSessionId, type SerialExecutor, type SessionId } from '../../../../src/lib/index.ts';
import {
  defaultSessionResumeSettings,
  type PaneObservation,
  type ResumeTarget,
  type ResumeTransition,
  SessionResumeService,
} from '../../../../src/lib/session/resume/index.ts';

const ID = parseSessionId('session-1');
const DEAD_PANE: PaneObservation = { alive: true, dead: true, promptReady: false };

const stopped: ResumeTarget = { id: ID, status: 'stopped', mode: 'auto', cwd: '/workspace/project', turn: 3 };

const inlineSerial: SerialExecutor = {
  run: async (_key, work) => await work(),
  runExclusive: async work => await work(),
};

describe('session resume of a leftover pane whose process is already gone', () => {
  it('should clean the dead pane up quietly before relaunching, without snapshotting or journalling a discard', async () => {
    // Arrange
    const calls: string[] = [];
    const events: string[] = [];
    let current = stopped;
    const service = new SessionResumeService(
      {
        repository: {
          read: async () => current,
          list: async () => [],
          transition: async (_id: SessionId, change: ResumeTransition) => {
            events.push(change.event);
            current = { ...current, ...(change.status === undefined ? {} : { status: change.status }) };
            return current;
          },
        },
        launcher: {
          observe: async () => DEAD_PANE,
          snapshot: async () => {
            calls.push('snapshot');
          },
          kill: async (_id: SessionId, reason: string) => {
            calls.push(`kill:${reason}`);
          },
          relaunch: async () => {
            calls.push('relaunch');
            return undefined;
          },
          deliver: async () => {
            calls.push('deliver');
          },
          confirmExit: async () => ({ confirmed: true, pane: DEAD_PANE }),
        },
        turns: { writeTurn: async () => '/state/session-1/turns/turn-4.md', clearMarkers: async () => undefined },
        monitors: { stop: async () => undefined, start: async () => undefined },
        gate: {
          launching: () => false,
          awaitSettled: async () => true,
          register: () => ({ release: () => undefined }),
        },
        serial: inlineSerial,
        answerAttention: { acknowledge: async () => undefined },
      },
      defaultSessionResumeSettings,
    );

    // Act
    const actual = await service.resume({ id: ID, message: 'carry on', actor: 'admin-cli' });

    // Assert
    should(actual.disposition).equal('revived');
    should(calls).deepEqual(['kill:cleanup before resume', 'relaunch', 'deliver']);
    should(events).not.containEql('session.composer_discarded');
  });
});
