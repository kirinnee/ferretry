import { describe, expect, it } from 'bun:test';

import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import {
  failoverReasonCopy,
  verdictProvenanceLine,
  WardenVerdicts,
  type WardenVerdictView,
} from '../../../src/features/warden/warden-verdicts.tsx';
import { render, run } from '../../support/react.ts';

const connection = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://daemon-a.example.test',
  deviceToken: 'device-token-a',
});
const NOW = Date.parse('2026-07-31T12:00:00.000Z');
const verdict: WardenVerdictView = {
  at: '2026-07-31T11:58:00.000Z',
  targetSession: 'session-a',
  teammate: 'ms-98',
  verdict: 'nudged',
  reason: 'Waiting for a status update',
  reportPath: 'warden/2026-07-31.md',
  spawn: {
    agent: 'claude-auto-loge',
    model: 'claude-sonnet-4-5',
    modelSource: 'harness',
    harness: 'claude',
    failedOver: true,
    configuredFirst: 'claude-auto-opus',
    skipped: { 'claude-auto-opus': 'at quota' },
  },
};

describe('WardenVerdicts', () => {
  it('stays absent when the paired daemon has no report history', () => {
    const renderer = render(<WardenVerdicts connection={connection} verdicts={[]} onOpenReport={() => {}} />);

    expect(renderer.toJSON()).toBeNull();
  });

  it('renders the verdict, its evidence, and explicit failover provenance', () => {
    const renderer = render(
      <WardenVerdicts connection={connection} verdicts={[verdict]} now={NOW} onOpenReport={() => {}} />,
    );
    const tree = JSON.stringify(renderer.toJSON());

    expect(tree).toContain('Warden verdicts');
    expect(tree).toContain('recent');
    expect(tree).toContain('nudged');
    expect(tree).toContain('Ms-98');
    expect(tree).toContain('Waiting for a status update');
    expect(tree).toContain('2m ago');
    expect(tree).toContain('claude-auto-loge · claude-sonnet-4-5 · claude');
    expect(tree).toContain('switched account');
    expect(tree).toContain('moved off claude-auto-opus: at quota');
    expect(tree).not.toContain('device-token-a');
  });

  it('hands the exact paired connection to the report host and can be collapsed', () => {
    const opened: unknown[] = [];
    const renderer = render(
      <WardenVerdicts
        connection={connection}
        verdicts={[verdict]}
        now={NOW}
        onOpenReport={request => opened.push(request)}
      />,
    );
    const buttons = renderer.root.findAllByType('button');

    run(() => buttons[1]?.props.onClick());
    expect(opened).toEqual([{ connection, verdict }]);

    run(() => buttons[0]?.props.onClick());
    expect(renderer.root.findAllByProps({ 'aria-expanded': false })).toHaveLength(1);
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Waiting for a status update');
  });

  it('does not imply provenance when an older report omitted it', () => {
    expect(verdictProvenanceLine()).toBe('Ran by: unknown (older report)');
    expect(failoverReasonCopy()).toBe('failover moved this check off the configured first choice');

    const renderer = render(
      <WardenVerdicts
        connection={connection}
        verdicts={[{ ...verdict, verdict: 'needs_human', spawn: undefined }]}
        now={NOW}
        onOpenReport={() => {}}
      />,
    );
    const tree = JSON.stringify(renderer.toJSON());

    expect(tree).toContain('needs human');
    expect(tree).toContain('Ran by: unknown (older report)');
    expect(tree).not.toContain('switched account');
  });
});
