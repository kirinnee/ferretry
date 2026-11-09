/**
 * W2-a `TmuxRunner.gone`: today's `TmuxSessionExitObserver.exitOf` `gone` proof. A ferret is proven gone only when tmux
 * says its OWN session cannot be found or the private server is not running; anything else proves nothing, so the
 * auto-resume settles (and spends) nothing on it.
 */
import { describe, expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import { TmuxRunner } from '../../../../daemon/adapters/tmux/tmux-runner.ts';

const FERRET = 'mw7bp88g-50e00159' as FerretId;

function runner(answer: () => Promise<{ code: number; stdout: string; stderr: string }>) {
  const calls: (readonly string[])[] = [];
  const subject = new TmuxRunner({
    tmux: {
      execute: async args => {
        calls.push(args);
        return await answer();
      },
    },
    spawn: {
      run: async () => {
        throw new Error('gone must not spawn');
      },
      runBytes: () => Promise.reject(new Error('gone must not spawn')),
      start: () => {
        throw new Error('gone must not spawn');
      },
    },
    socketPath: '/fixture/tmux.sock',
    instantOf: () => '2026-11-08T10:00:00.000Z' as never,
    now: () => '2026-11-08T10:00:00.000Z' as never,
  });
  return { subject, calls };
}

const answered =
  (code: number, stderr = '') =>
  async () => ({ code, stdout: '', stderr });

describe('W2-a TmuxRunner.gone', () => {
  test("W2-a asks only has-session, by the ferret's own session name, never a pane id", async () => {
    const { subject, calls } = runner(answered(1, `can't find session: fy-${FERRET}`));
    expect(await subject.gone(FERRET)).toBe(true);
    expect(calls).toEqual([['has-session', '-t', `fy-${FERRET}`]]);
  });

  test('W2-a proven gone: the session cannot be found, or the private server is not running', async () => {
    for (const stderr of [
      `can't find session: fy-${FERRET}`,
      'no server running on /fixture/tmux.sock',
      'error connecting to /fixture/tmux.sock (No such file or directory)',
      'failed to connect to server',
    ])
      expect(await runner(answered(1, stderr)).subject.gone(FERRET)).toBe(true);
  });

  test('W2-a not gone: a live session (one tmux kept with a dead pane included)', async () => {
    expect(await runner(answered(0)).subject.gone(FERRET)).toBe(false);
    // Whatever tmux printed beside it, a session it answered for is there.
    expect(await runner(answered(0, "can't find session: fy-other")).subject.gone(FERRET)).toBe(false);
  });

  test('W2-a nothing proven: a refused socket, a server that went away mid-request, an unknown failure, a throw', async () => {
    for (const stderr of [
      'error connecting to /fixture/tmux.sock (Permission denied)',
      'server exited unexpectedly',
      'lost server',
      '',
    ])
      expect(await runner(answered(1, stderr)).subject.gone(FERRET)).toBe(false);
    expect(await runner(() => Promise.reject(new Error('spawn failed'))).subject.gone(FERRET)).toBe(false);
  });

  test('W2-a a ferret id that is no tmux name is never asked about and never gone', async () => {
    const { subject, calls } = runner(answered(1, "can't find session"));
    expect(await subject.gone('Not A Name!' as FerretId)).toBe(false);
    expect(calls).toEqual([]);
  });
});
