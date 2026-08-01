import { describe, expect, it } from 'bun:test';

import {
  WardenAttention,
  attentionHeadline,
  attentionOutcome,
  judgementSummary,
  nextStateOnFailure,
  orderedAttentionItems,
} from '../../../src/features/warden/warden-attention.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { render, run } from '../../support/react.ts';

const connection = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://daemon-a.example.test',
  deviceToken: 'token-a',
});
const item = {
  id: 'A3',
  sessionId: 'session-a',
  teammate: 'ms-98',
  subject: 'Approve the pairing request',
  why: 'This browser needs a decision before it can continue.',
  waitingSince: '2026-07-31T11:30:00.000Z',
  judgement: { state: 'pending' as const, reportPath: 'warden/report.md' },
  recommendation: { action: 'nudge' as const, reason: 'Ask for the exact blocker.' },
};
const NOW = Date.parse('2026-07-31T12:00:00.000Z');

describe('WardenAttention', () => {
  it('keeps a failed refresh visibly stale instead of replacing or falsely clearing a useful view', () => {
    const stale = nextStateOnFailure({ status: 'ready', view: { items: [] } }, 'token expired');
    expect(stale).toEqual({ status: 'stale', view: { items: [] }, reason: 'token expired' });
    const renderer = render(<WardenAttention connection={connection} state={stale} now={NOW} />);
    const tree = JSON.stringify(renderer.toJSON());
    expect(tree).toContain('Can’t refresh who needs you');
    expect(tree).toContain('not an all-clear');
    expect(tree).not.toContain('Nothing is waiting on you right now.');
  });

  it('distinguishes a clean sweep from no sweep or a degraded empty result', () => {
    expect(attentionOutcome({ items: [], lastSweepAt: '2026-07-31T11:59:00.000Z' })).toBe('clean-sweep');
    expect(attentionOutcome({ items: [] })).toBe('no-sweep');
    expect(attentionOutcome({ items: [], boardsWithParseErrors: ['board-a'] })).toBe('degraded');
    expect(attentionHeadline({ items: [], boardsWithParseErrors: ['board-a'] })).toBe('Can’t say who needs you');
  });

  it('orders the oldest request first and gives every host callback its paired daemon', () => {
    const older = { ...item, id: 'A2', sessionId: 'session-older', waitingSince: '2026-07-31T11:00:00.000Z' };
    expect(orderedAttentionItems([item, older]).map(value => value.id)).toEqual(['A2', 'A3']);
    const opened: unknown[] = [];
    const reports: unknown[] = [];
    const actions: unknown[] = [];
    const renderer = render(
      <WardenAttention
        connection={connection}
        state={{ status: 'ready', view: { items: [item] } }}
        now={NOW}
        onOpenSession={value => opened.push(value)}
        onOpenReport={value => reports.push(value)}
        onRunAction={value => actions.push(value)}
      />,
    );
    const buttons = renderer.root.findAllByType('button');
    run(() => buttons[0]?.props.onClick());
    run(() => buttons[1]?.props.onClick());
    run(() => buttons[2]?.props.onClick());
    expect(opened).toEqual([{ connection, sessionId: 'session-a' }]);
    expect(actions).toEqual([{ connection, item, recommendation: item.recommendation }]);
    expect(reports).toEqual([
      { connection, reportPath: 'warden/report.md', sessionId: 'session-a', attentionId: 'A3' },
    ]);
    expect(JSON.stringify(renderer.toJSON())).not.toContain('token-a');
  });

  it('renders loading and denied-route states as explicit unknowns', () => {
    expect(
      JSON.stringify(render(<WardenAttention connection={connection} state={{ status: 'loading' }} />).toJSON()),
    ).toContain('Checking which agents need you');
    const tree = JSON.stringify(
      render(
        <WardenAttention
          connection={connection}
          state={{ status: 'error', reason: 'This daemon has no route yet.' }}
        />,
      ).toJSON(),
    );
    expect(tree).toContain('No judgement available');
    expect(tree).toContain('Treat this as unknown');
  });

  it('renders bounded, degraded, and not-yet-swept answers without overclaiming', () => {
    expect(judgementSummary({ state: 'judged', verdict: 'nudged', reason: 'still blocked' })).toBe(
      'Warden: nudged the agent — still blocked',
    );
    expect(judgementSummary({ state: 'judged' })).toBe('Warden: reviewed it');
    expect(judgementSummary({ state: 'queued' })).toBe('Waiting for a warden to pick this up.');
    expect(judgementSummary({ state: 'failed' })).toBe('Warden could not judge — reason unknown');

    const degraded = JSON.stringify(
      render(
        <WardenAttention
          connection={connection}
          state={{
            status: 'ready',
            view: {
              items: [],
              boardsWithParseErrors: ['board-a'],
              wardenDegraded: { reason: 'remote board rejected the read' },
              verdictCoverage: { truncated: true },
            },
          }}
          now={NOW}
        />,
      ).toJSON(),
    );
    expect(degraded).toContain('Warden degraded: ');
    expect(degraded).toContain('remote board rejected the read');
    expect(degraded).toContain('Showing ');
    expect(degraded).toContain('a recent slice of');
    expect(degraded).toContain('not an all-clear');
    expect(
      JSON.stringify(
        render(
          <WardenAttention connection={connection} state={{ status: 'ready', view: { items: [] } }} now={NOW} />,
        ).toJSON(),
      ),
    ).toContain('Nobody has been checked yet.');

    const leave = JSON.stringify(
      render(
        <WardenAttention
          connection={connection}
          state={{
            status: 'ready',
            view: {
              items: [
                { ...item, recommendation: { action: 'leave', reason: 'The session is making healthy progress.' } },
              ],
            },
          }}
          now={NOW}
        />,
      ).toJSON(),
    );
    expect(leave).toContain('No action needed — ');
    expect(leave).toContain('The session is making healthy progress.');
  });
});
