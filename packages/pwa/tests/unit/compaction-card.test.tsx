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
  test('with the harness’s percent, draws that bar and figure, tokens written and the real clock', () => {
    const scheduler = manualScheduler(START_MS + 434_000);
    const view = render(
      <CompactionCard compaction={{ ...running, percent: 49, tokensWritten: 37_400 }} scheduler={scheduler} />,
    );
    const bar = view.root.findByProps({ role: 'progressbar' });
    expect(bar.props['aria-valuenow']).toBe(49);
    expect(bar.props['aria-valuetext']).toBe('49 percent');
    const text = textOf(view.toJSON());
    expect(text).toContain('49%');
    expect(text).not.toContain('~');
    expect(text).not.toContain('about');
    expect(text).not.toContain('Usually');
    expect(text).toContain('7m 14s · 37k tokens written · from 412k tokens');
    expect(view.root.findAllByProps({ 'data-spinner': '' }).length).toBe(0);
    run(() => scheduler.advance(10_000));
    expect(textOf(view.toJSON())).toContain('7m 24s');
    run(() => view.unmount());
  });

  test('with no percent, shows a spinner, the clock and the usual duration — and no percentage at all', () => {
    const scheduler = manualScheduler(START_MS + 12_000);
    const view = render(<CompactionCard compaction={running} scheduler={scheduler} />);
    const text = textOf(view.toJSON());
    expect(view.root.findAllByProps({ role: 'progressbar' }).length).toBe(0);
    expect(view.root.findAllByProps({ 'data-spinner': '' }).length).toBeGreaterThan(0);
    expect(text).not.toContain('%');
    expect(text).toContain('12s · from 412k tokens');
    expect(text).toContain('Usually ~60s here');
    run(() => scheduler.advance(18_000));
    expect(textOf(view.toJSON())).toContain('30s');
    expect(view.root.findAllByProps({ role: 'progressbar' }).length).toBe(0);
    run(() => view.unmount());
  });

  test('flags itself overdue past the usual time only when there is no real percent', () => {
    const late = manualScheduler(START_MS + 300_000);
    const bare = render(<CompactionCard compaction={running} scheduler={late} />);
    expect(bare.root.findByProps({ 'data-compaction': 'running' }).props['data-overdue']).toBe('');
    expect(textOf(bare.toJSON())).toContain('Taking longer than usual');
    run(() => bare.unmount());

    const real = render(<CompactionCard compaction={{ ...running, percent: 12 }} scheduler={late} />);
    expect(real.root.findByProps({ 'data-compaction': 'running' }).props['data-overdue']).toBeUndefined();
    run(() => real.unmount());
  });

  test('keeps counting from the daemon’s start through a re-render, a sample without the bar and a fresh sample', () => {
    const scheduler = manualScheduler(START_MS + 34_000);
    const view = render(<CompactionCard compaction={{ ...running, percent: 34 }} scheduler={scheduler} />);
    expect(textOf(view.toJSON())).toContain('34s');
    run(() => scheduler.advance(2_000));

    // A sample that painted no bar, then the next one: new objects, the same compaction.
    run(() => view.update(<CompactionCard compaction={{ ...running }} scheduler={scheduler} />));
    expect(textOf(view.toJSON())).toContain('36s');
    expect(textOf(view.toJSON())).not.toMatch(/(^|[^\d])[0-5]s ·/);
    run(() => scheduler.advance(1_000));
    run(() => view.update(<CompactionCard compaction={{ ...running, percent: 38 }} scheduler={scheduler} />));
    expect(textOf(view.toJSON())).toContain('37s');
    expect(view.root.findByProps({ role: 'progressbar' }).props['aria-valuenow']).toBe(38);
    run(() => view.unmount());
  });

  test('runs on the browser’s clock when none is injected', () => {
    const view = render(
      <CompactionCard compaction={{ ...running, startedAt: new Date().toISOString(), percent: 3 }} />,
    );
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
  test('is the header’s small state, with the harness’s own figure when it gave one', () => {
    const view = render(
      <CompactionChip compaction={{ ...running, percent: 49 }} scheduler={manualScheduler(START_MS + 30_000)} />,
    );
    expect(textOf(view.toJSON())).toBe('Compacting 49%');
    run(() => view.unmount());
  });

  test('says no percentage when the harness gave none', () => {
    const view = render(<CompactionChip compaction={running} scheduler={manualScheduler(START_MS + 30_000)} />);
    expect(textOf(view.toJSON())).toBe('Compacting…');
    run(() => view.unmount());
  });

  test('runs on the browser’s clock when none is injected', () => {
    const view = render(<CompactionChip compaction={{ ...running, startedAt: new Date().toISOString() }} />);
    expect(textOf(view.toJSON())).toBe('Compacting…');
    run(() => view.unmount());
  });
});
