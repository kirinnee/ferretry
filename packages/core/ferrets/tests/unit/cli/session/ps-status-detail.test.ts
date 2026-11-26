import { describe, expect, test } from 'bun:test';
import { renderFerret, renderSessionTable } from '../../../../cli/lib/session/display.ts';
import { SessionStatusController } from '../../../../cli/lib/session/status-controller.ts';
import { capturedPresenter } from './controller-doubles.ts';
import { sessionView } from './session-fixtures.ts';

const PLAIN = { amber: (cell: string) => cell };
const LIVE = { turns: 12, contextPercent: 42.4, contextWindow: 200_000, contextTokens: 84_800 };
const COMPLETED = '2026-11-06T09:00:00.000Z' as never;
const WAITING = { since: '2026-11-06T09:00:00.000Z', condition: 'CI', peerName: 'oak' } as never;

describe('fy ps shows the detail columns (C-16)', () => {
  test('model, mode, task and label sit beside the lineage columns; a ferret without one shows a dash', () => {
    const rows = renderSessionTable(
      [
        sessionView({ id: 'a', name: 'wren', model: 'opus', mode: 'auto', task: 'F12', label: 'batch' }),
        sessionView({ id: 'b', name: 'fern', observedModel: 'sonnet-5-5', model: 'sonnet', mode: 'interactive' }),
        sessionView({ id: 'c', name: 'ash' }),
      ],
      PLAIN,
    );
    expect(rows[0]).toMatch(
      /^TEAMMATE\s+ID\s+STATE\s+HARNESS\s+RUNTIME\s+MODEL\s+MODE\s+ROLE\s+PACK\s+PARENT\s+TASK\s+LABEL$/u,
    );
    expect(rows[1]).toMatch(
      /^wren\s+a\s+working\s+claude-code\s+claude-alpha\s+opus\s+auto\s+lead\s+-\s+-\s+F12\s+batch$/u,
    );
    // What the harness last reported running beats what it was started with.
    expect(rows[2]).toContain('sonnet-5-5');
    expect(rows[2]).not.toMatch(/\ssonnet\s/u);
    expect(rows[3]).toMatch(/\s-\s+-\s+lead\s+-\s+-\s+-\s+-$/u);
  });
});

describe('fy ps tells a finished, a failed, a waiting and a stopped ferret apart (C-17)', () => {
  const state = (over: Parameters<typeof sessionView>[0]): string =>
    renderSessionTable([sessionView(over)], PLAIN)[1]?.split(/\s{2,}/u)[2] ?? '';

  test('only a done signal is completed, a launch that never ran is failed, an ordinary stop stays stopped', () => {
    expect(state({ state: 'stopped', finishedAt: COMPLETED, cause: { kind: 'completed' } })).toBe(
      'stopped (completed)',
    );
    // The daemon stamps cause=completed on an auto ferret that failed by `signal help`; with no done signal it is not completed.
    expect(state({ state: 'stopped', cause: { kind: 'completed' } })).toBe('stopped');
    expect(state({ state: 'stopped', cause: { kind: 'start_failed' } })).toBe('stopped (failed)');
    expect(state({ state: 'stopped', cause: { kind: 'stopped' } })).toBe('stopped');
    expect(state({ state: 'stopped' })).toBe('stopped');
    expect(state({ state: 'stopped', cause: { kind: 'signal', signal: 9 } })).toBe('stopped (signal 9)');
  });

  test('an idle ferret that declared a wait is waiting; an idle one without is just idle', () => {
    expect(state({ state: 'idle', waiting: WAITING })).toBe('idle (waiting)');
    expect(state({ state: 'idle' })).toBe('idle');
    expect(state({ state: 'working' })).toBe('working');
  });
});

describe('fy status shows model, turn, context and what it waits on (C-18, D-50)', () => {
  test('the detail block carries the model with its effort, the turn count and context fill, and the task', () => {
    const lines = renderFerret(
      sessionView({ model: 'opus', effort: 'high', fast: true, task: 'F12', title: 'Fix the thing' }),
      undefined,
      LIVE,
    );
    expect(lines).toContain('  model opus (effort high, fast)');
    expect(lines).toContain('  turn 12; context 42% (85K of 200K)');
    expect(lines).toContain('  task F12: Fix the thing');
    // The folder (the session directory) is still said.
    expect(lines).toContain('  /work/repo');
  });

  test('token counts read as 800, 85K and 1.2M, and a context the harness has not reported says nothing', () => {
    const lines = (live: Parameters<typeof renderFerret>[2]) => renderFerret(sessionView(), undefined, live);
    expect(lines({ turns: 1, contextPercent: 0.4, contextWindow: 1_200_000, contextTokens: 800 })).toContain(
      '  turn 1; context 0% (800 of 1.2M)',
    );
    expect(lines({ turns: 3, contextPercent: null, contextWindow: null, contextTokens: null })).toContain('  turn 3');
    expect(lines({ turns: null, contextPercent: 50, contextWindow: null, contextTokens: null })).toContain(
      '  context 50%',
    );
  });

  test('a declared wait says what on and for whom; no live read leaves only what the record knows', () => {
    const lines = renderFerret(sessionView({ state: 'idle', waiting: WAITING, observedModel: 'sonnet-5-5' }));
    expect(lines).toContain('  waiting on CI for oak');
    expect(lines).toContain('  model sonnet-5-5');
    expect(lines.some(line => line.includes('context'))).toBe(false);
  });

  test('a bare record adds nothing: no model, no live read, no wait', () => {
    expect(renderFerret(sessionView())).toHaveLength(3);
  });

  test('the controller asks the live route for the ferret it showed and tolerates a reader that finds none', async () => {
    const asked: string[] = [];
    const run = async (live: ((id: string) => Promise<typeof LIVE | undefined>) | undefined, json = false) => {
      const { io, presenter } = capturedPresenter();
      const api = { get: async () => sessionView({ id: 'mid' }), ...(live === undefined ? {} : { live }) } as never;
      await new SessionStatusController(api, presenter).execute('mid', { json });
      return io.out.join('\n');
    };
    const seen = await run(async id => (asked.push(id), LIVE));
    expect(seen).toContain('turn 12; context 42%');
    expect(asked).toEqual(['mid']);
    expect(await run(async () => undefined)).not.toContain('context');
    expect(await run(undefined)).not.toContain('context');
  });
});
