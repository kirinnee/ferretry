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

  it('says the investigation cap is reached from the state alone, never an amount', () => {
    const capped = ferretView({
      config: wardenConfig(layers),
      triage: {
        jev: { configured: true, active: true, reason: 'configured' },
        llm: { configured: true, active: false, reason: 'investigation_cap' },
      },
    });
    expect(askWardenBlocker(capped)).toBe('Today’s investigation cap is reached.');
    expect(askWardenBlocker(ferretView({ config: wardenConfig(layers) }))).toBeNull();
    expect(askWardenCostLine(capped)).not.toContain('$');
  });
});
