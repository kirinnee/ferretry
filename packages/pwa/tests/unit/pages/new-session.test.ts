import { describe, expect, test } from 'bun:test';

import {
  buildStartSessionRequest,
  canSubmit,
  emptyNewSessionDraft,
  submitNewSession,
  type DaemonConnection,
  type DaemonBoundSessionStarter,
  type NewSessionDraft,
} from '../../../src/lib/pages/new-session';

const connectionA = { daemonId: 'daemon-a' } as DaemonConnection;
const connectionB = { daemonId: 'daemon-b' } as DaemonConnection;

function draft(overrides: Partial<NewSessionDraft> = {}): NewSessionDraft {
  return {
    ...emptyNewSessionDraft,
    agent: '  claude  ',
    prompt: '  Start the work  ',
    ...overrides,
  };
}

describe('new session decisions', () => {
  test('provides an empty auto-mode draft', () => {
    expect(emptyNewSessionDraft).toEqual({
      agent: '',
      cwd: '',
      model: '',
      mode: 'auto',
      label: '',
      prompt: '',
    });
  });

  test('submits only with a daemon, agent, prompt for auto mode, and no active submission', () => {
    expect(canSubmit(draft(), undefined, false)).toBeFalse();
    expect(canSubmit(draft({ agent: '   ' }), connectionA, false)).toBeFalse();
    expect(canSubmit(draft({ prompt: '   ' }), connectionA, false)).toBeFalse();
    expect(canSubmit(draft(), connectionA, true)).toBeFalse();
    expect(canSubmit(draft(), connectionA, false)).toBeTrue();
  });

  test('permits an interactive session without a prompt', () => {
    expect(canSubmit(draft({ mode: 'interactive', prompt: '   ' }), connectionA, false)).toBeTrue();
  });

  test('trims required text and omits blank optional fields', () => {
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

  test('keeps nonblank optional fields and omits an interactive blank prompt', () => {
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

  test('uses schema validation for an invalid request', () => {
    expect(() => buildStartSessionRequest(draft({ agent: '   ' }))).toThrow();
  });

  test('scopes started sessions by the starter daemon connection', async () => {
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
