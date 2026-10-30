/**
 * Info › Signals: the same agenda board as the Folder rail (unchanged), plus the Warden's verdicts
 * narrowed to this one ferret, newest first.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type { WardenVerdict } from '@ferretry/protocol';
import {
  InfoSignals,
  type InfoVerdictsRead,
  sessionVerdicts,
  VERDICT_WORDS,
} from '../../../../src/features/session-info/info-signals.tsx';
import { type Mounted, mount, must } from '../../../support/dom.ts';
import { fakeSignals, snapshot } from '../context-rail/context-rail-fixtures.ts';

const NOW = Date.parse('2026-10-16T10:00:00.000Z');

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const verdict = (overrides: Partial<WardenVerdict> = {}): WardenVerdict =>
  ({
    at: '2026-10-16T09:00:00.000Z',
    targetSession: 'session-a',
    verdict: 'nudged',
    reportPath: '/warden/report-1.json',
    ...overrides,
  }) as WardenVerdict;

const show = async (verdicts: InfoVerdictsRead, signals = fakeSignals(snapshot())) => {
  mounted = await mount(
    <InfoSignals agentName="Hadi" now={() => NOW} port={signals} sessionId="session-a" verdicts={verdicts} />,
  );
  return mounted.container;
};

describe('sessionVerdicts', () => {
  it('narrows to this session and sorts newest first', () => {
    const mine = verdict({ reportPath: 'r1', at: '2026-10-16T09:00:00.000Z' });
    const mineLater = verdict({ reportPath: 'r2', at: '2026-10-16T09:30:00.000Z' });
    const other = verdict({ reportPath: 'r3', targetSession: 'session-b' });
    expect(sessionVerdicts([mine, other, mineLater], 'session-a')).toEqual([mineLater, mine]);
  });
});

describe('VERDICT_WORDS', () => {
  it('says every verdict kind in words', () => {
    expect(VERDICT_WORDS.killed).toBe('Stopped it');
    expect(VERDICT_WORDS.revived).toBe('Revived it');
    expect(VERDICT_WORDS.nudged).toBe('Nudged it');
    expect(VERDICT_WORDS.cleared).toBe('Left it alone — healthy');
    expect(VERDICT_WORDS.needs_human).toBe('Asked for you');
    expect(VERDICT_WORDS.unknown).toBe('No clear verdict');
  });
});

describe('InfoSignals — attention', () => {
  it('shares the same board the Folder rail reads, with the open count', async () => {
    const root = await show({ kind: 'loading' });
    expect(root.textContent).toContain('Use the seeded test account?');
  });
});

describe('InfoSignals — Warden', () => {
  it('says it is reading, and reports a failed read', async () => {
    const reading = await show({ kind: 'loading' });
    expect(reading.textContent).toContain('Reading the Warden’s verdicts…');

    await mounted?.unmount();
    mounted = undefined;
    const failed = await show({ kind: 'failed', reason: 'the daemon is offline' });
    expect(failed.textContent).toContain('Couldn’t read the Warden’s verdicts: the daemon is offline');
  });

  it('says the Warden has nothing to say when there are no verdicts for this ferret', async () => {
    const root = await show({ kind: 'ready', verdicts: [verdict({ targetSession: 'session-b' })] });
    expect(root.textContent).toContain('The Warden has nothing to say about Hadi.');
  });

  it('lists this ferret’s verdicts, with the anomaly kind, the reason and the recommendation', async () => {
    const full = verdict({
      verdict: 'killed',
      anomalyKind: 'sus_subprocess',
      reason: 'it kept repeating the same tool call',
      recommendation: { action: 'restart', reason: 'a fresh context should break the loop' },
    });
    const root = await show({ kind: 'ready', verdicts: [full] });
    const item = must(root.querySelector(`[data-info-verdict="killed"]`), 'the verdict');
    expect(item.textContent).toContain('Stopped it');
    expect(item.textContent).toContain('sus subprocess');
    expect(item.textContent).toContain('it kept repeating the same tool call');
    expect(item.textContent).toContain('Recommended: restart — a fresh context should break the loop');
  });

  it('draws a verdict with neither an anomaly kind, a reason nor a recommendation', async () => {
    const bare = verdict({ verdict: 'cleared', anomalyKind: undefined, reason: undefined, recommendation: undefined });
    const root = await show({ kind: 'ready', verdicts: [bare] });
    const item = must(root.querySelector('[data-info-verdict="cleared"]'), 'the verdict');
    expect(item.textContent).toContain('Left it alone — healthy');
    expect(item.textContent).not.toContain('Recommended');
  });
});
