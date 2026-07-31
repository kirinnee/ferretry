import { describe, expect, test } from 'bun:test';

import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import {
  buildStartSessionRequest,
  canSubmitNewSession,
  emptyNewSessionDraft,
  submitNewSession,
  type DaemonConnection,
  type DaemonBoundSessionStarter,
  type NewSessionDraft,
} from '../../../src/lib/pages/new-session.ts';

const connectionA = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'http://daemon-a.test',
  deviceToken: 'token-a',
}) as DaemonConnection;
const connectionB = daemonConnection({
  daemonId: 'daemon-b',
  baseUrl: 'http://daemon-b.test',
  deviceToken: 'token-b',
}) as DaemonConnection;

function draft(overrides: Partial<NewSessionDraft> = {}): NewSessionDraft {
  return {
    ...emptyNewSessionDraft,
    agent: '  claude  ',
    prompt: '  Start the work  ',
    ...overrides,
  };
}

describe('new session decisions', () => {
  test('should provide an empty auto-mode draft', () => {
    expect(emptyNewSessionDraft).toEqual({
      agent: '',
      cwd: '',
      model: '',
      mode: 'auto',
      label: '',
      prompt: '',
    });
  });

  test('should submit only with a daemon, agent, prompt for auto mode, and no active submission', () => {
    expect(canSubmitNewSession(draft(), undefined, false)).toBeFalse();
    expect(canSubmitNewSession(draft({ agent: '   ' }), connectionA, false)).toBeFalse();
    expect(canSubmitNewSession(draft({ prompt: '   ' }), connectionA, false)).toBeFalse();
    expect(canSubmitNewSession(draft(), connectionA, true)).toBeFalse();
    expect(canSubmitNewSession(draft(), connectionA, false)).toBeTrue();
  });

  test('should permit an interactive session without a prompt', () => {
    expect(
      canSubmitNewSession(draft({ mode: 'interactive', prompt: '   ' }), connectionA, false),
    ).toBeTrue();
  });

  test('should trim required text and omit blank optional fields', () => {
    expect(
      buildStartSessionRequest(
        draft({
          cwd: '   ',
          model: '  ',
          label: '\t',
          prompt: '  Explain the diff  ',
        }),
      ),
    ).toMatchObject({ agent: 'claude', mode: 'auto', prompt: 'Explain the diff' });
    expect(buildStartSessionRequest(draft({ cwd: ' ', model: ' ', label: ' ' }))).not.toHaveProperty('cwd');
    expect(buildStartSessionRequest(draft({ cwd: ' ', model: ' ', label: ' ' }))).not.toHaveProperty('model');
    expect(buildStartSessionRequest(draft({ cwd: ' ', model: ' ', label: ' ' }))).not.toHaveProperty('label');
  });

  test('should keep nonblank optional fields and omit an interactive blank prompt', () => {
    expect(
      buildStartSessionRequest(
        draft({
          cwd: ' /repo ',
          model: ' opus ',
          label: ' Morning ',
          mode: 'interactive',
          prompt: '  ',
        }),
      ),
    ).toMatchObject({
      agent: 'claude',
      cwd: '/repo',
      model: 'opus',
      mode: 'interactive',
      label: 'Morning',
    });
    expect(buildStartSessionRequest(draft({ mode: 'interactive', prompt: ' ' }))).not.toHaveProperty('prompt');
  });

  test('should use schema validation for an invalid request', () => {
    expect(() => buildStartSessionRequest(draft({ agent: '   ' }))).toThrow();
  });

  test('should scope started sessions by the starter daemon connection', async () => {
    const start = async () => ({ config: { id: 'same-session-id' } });
    const starterA: DaemonBoundSessionStarter = { connection: connectionA, start };
    const starterB: DaemonBoundSessionStarter = { connection: connectionB, start };

    const scopeA = await submitNewSession(draft(), starterA);
    const scopeB = await submitNewSession(draft(), starterB);

    expect(scopeA).not.toEqual(scopeB);
    expect(scopeA.sessionId).toBe('same-session-id');
    expect(scopeB.sessionId).toBe('same-session-id');
  });
});
