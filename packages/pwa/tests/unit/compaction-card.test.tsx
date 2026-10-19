import { describe, expect, test } from 'bun:test';
import type { SessionCompactionRunning } from '@ferretry/protocol';
import { CompactionCard, CompactionChip, CompactionStrip } from '../../src/components/compaction-card.tsx';
import '../support/dom.ts';
import { manualScheduler } from '../support/live-scheduler.ts';
import { render, run } from '../support/react.ts';

const START_MS = Date.parse('2026-01-02T03:04:05.000Z');
const running: SessionCompactionRunning = {
  phase: 'running',
  startedAt: new Date(START_MS).toISOString(),
  tokensBefore: 412_000,
  expectedMs: 60_000,
  basis: 'history',
};

const textOf = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('');
  if (value !== null && typeof value === 'object' && 'children' in value)
    return textOf((value as { readonly children: unknown }).children);
  return '';
};

describe('CompactionCard', () => {
  test('draws an estimated bar that advances with the compaction’s own clock', () => {
    const scheduler = manualScheduler(START_MS + 12_000);
    const view = render(<CompactionCard compaction={running} scheduler={scheduler} />);
    const bar = view.root.findByProps({ role: 'progressbar' });
    expect(bar.props['aria-valuenow']).toBe(20);
    expect(bar.props['aria-valuetext']).toBe('About 20 percent, estimated');
    expect(textOf(view.toJSON())).toContain('~20%');
    expect(textOf(view.toJSON())).toContain('12s · from 412k tokens');
    scheduler.advance(18_000);
    expect(view.root.findByProps({ role: 'progressbar' }).props['aria-valuenow']).toBe(50);
    run(() => view.unmount());
  });

  test('holds at 95 and flags itself overdue past the expected time', () => {
    const view = render(<CompactionCard compaction={running} scheduler={manualScheduler(START_MS + 300_000)} />);
    expect(view.root.findByProps({ role: 'progressbar' }).props['aria-valuenow']).toBe(95);
    expect(view.root.findByProps({ 'data-compaction': 'running' }).props['data-overdue']).toBe('');
    expect(textOf(view.toJSON())).toContain('Taking longer than usual');
    run(() => view.unmount());
  });

  test('runs on the browser’s clock when none is injected', () => {
    const view = render(<CompactionCard compaction={{ ...running, startedAt: new Date().toISOString() }} />);
    expect(view.root.findByProps({ role: 'progressbar' }).props['aria-valuemax']).toBe(100);
    run(() => view.unmount());
  });
});

describe('CompactionStrip', () => {
  test('is a separator naming what was freed', () => {
    const view = render(
      <CompactionStrip
        compaction={{ phase: 'done', endedAt: '2026-01-02T03:04:46.000Z', tokensBefore: 412_000, tokensAfter: 38_000 }}
      />,
    );
    expect(view.root.findByProps({ 'data-compaction': 'done' })).toBeDefined();
    expect(textOf(view.toJSON())).toBe('Context compacted · 412k → 38k · freed 374k');
    run(() => view.unmount());
  });
});

describe('CompactionChip', () => {
  test('is the header’s small state', () => {
    const view = render(<CompactionChip compaction={running} scheduler={manualScheduler(START_MS + 30_000)} />);
    expect(textOf(view.toJSON())).toBe('Compacting ~50%');
    run(() => view.unmount());
  });

  test('runs on the browser’s clock when none is injected', () => {
    const view = render(<CompactionChip compaction={{ ...running, startedAt: new Date().toISOString() }} />);
    expect(textOf(view.toJSON())).toBe('Compacting ~0%');
    run(() => view.unmount());
  });
});
