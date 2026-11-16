import { describe, expect, it } from 'bun:test';
import { askWardenBlocker, askWardenCostLine } from '../../../app/features/warden/ask-warden-model.ts';
import { wardenActionChart, wardenActionStats } from '../../../app/features/warden/warden-action-stats-model.ts';
import { wardenStatusLine } from '../../../app/features/warden/warden-overview-model.ts';
import {
  layerLines,
  spendTotals,
  wardenDayChart,
  wardenStats,
} from '../../../app/features/warden/warden-stats-model.ts';
import { wardenPacedUntil } from '../../../app/features/warden/warden-status-model.ts';
import type { WardenStatusView } from '../../../app/wire.ts';
import { wardenSpend } from '../../../daemon/lib/triage.ts';
import { wardenConfig, wardenStatus } from '../../support/app/warden.ts';

/**
 * Audit A fix 3: a FERRET's status carries no spend, savings or history (the fleet aggregates are the owner's), only the
 * `triage` state. Every view model reads such a status without throwing and without inventing a figure.
 */
const NOW = Date.parse('2026-07-31T12:00:00.000Z');

const ferretView = (overrides: Partial<WardenStatusView> = {}): WardenStatusView => {
  const { spend: _spend, savings: _savings, history: _history, ...rest } = wardenStatus(overrides);
  return rest;
};

describe('a ferret status without the fleet aggregates', () => {
  const layers = { layers: { jev: true, llm: true } };

  it('reads as a status line with no money in it', () => {
    const line = wardenStatusLine(ferretView({ config: wardenConfig(layers) }), NOW);
    expect(line.parts.join(' ')).not.toContain('$');
  });

  it('has no spend summary, layer line, paced time or chart to show', () => {
    const status = ferretView({ config: wardenConfig(layers) });
    expect(spendTotals(status)).toBeUndefined();
    expect(layerLines(status)).toEqual([]);
    expect(wardenPacedUntil(status, 'jev')).toBeUndefined();
    expect(wardenDayChart(status, NOW)).toBeUndefined();
    expect(wardenActionChart(status, NOW, 'all')).toBeUndefined();
    expect(wardenActionStats(status, NOW).recorded).toBe(false);
    expect(wardenStats(status, 'today', NOW).tiles.every(tile => tile.value === null)).toBe(true);
  });

  it('says investigations are paused by the cap from the state alone, never an amount or a period', () => {
    const capped = ferretView({
      config: wardenConfig(layers),
      triage: {
        jev: { configured: true, active: true, reason: 'configured' },
        llm: { configured: true, active: false, reason: 'investigation_cap' },
      },
    });
    expect(askWardenBlocker(capped)).toBe('Investigations are paused by the cap.');
    expect(askWardenBlocker(ferretView({ config: wardenConfig(layers) }))).toBeNull();
    expect(askWardenCostLine(capped)).not.toContain('$');
  });
});

/**
 * Audit A fix 4: the `investigation_cap` reason also stands for this HOUR's share of the cap. A ferret's view carries no
 * amount, so it must not claim the day's cap is reached while the day's spend is still under it.
 */
describe('a ferret status while only the hour’s share is spent', () => {
  it('does not claim the daily cap was reached', () => {
    const at = '2026-07-31T12:00:00.000Z';
    const owner = wardenStatus({
      config: wardenConfig({ layers: { jev: true, llm: true } }),
      triage: {
        jev: { configured: true, active: true, reason: 'configured' },
        llm: { configured: true, active: false, reason: 'investigation_cap' },
      },
    });
    const spend = wardenSpend({
      caps: owner.config.caps,
      today: { day: at.slice(0, 10), flags: 1, jevDecisions: 0, jevSkips: 0, jevUsd: 0 },
      records: [
        {
          id: 'fixture',
          scope: 'session',
          origin: 'owner',
          targetId: 'own',
          startedAt: at,
          finishedAt: at,
          reportPath: 'reports/own.md',
          costUsd: 0.77,
        },
      ],
      nowMs: Date.parse(at),
    });
    // The owner's numbers: $0.77 is under the $2 day cap, and only the hour's allowance is exhausted.
    expect(spend.investigationUsd).toBeLessThan(spend.investigationCapUsd);
    expect(spend.capsPaced).toContain('investigation');
    const { spend: _spend, savings: _savings, history: _history, ...ferret } = owner;
    const line = askWardenBlocker(ferret);
    expect(line).not.toContain('Today’s');
    expect(line).not.toContain('$');
  });
});
