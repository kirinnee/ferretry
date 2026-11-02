import { afterEach, describe, expect, test } from 'bun:test';
import type { SessionLiveActivity } from '@ferretry/protocol';
import { Transcript } from '../../src/components/transcript.tsx';
import type { TranscriptEntry } from '../../src/lib/session-screens.ts';
import { type Mounted, mount } from '../support/dom.ts';

const T0 = Date.parse('2026-01-02T03:04:00.000Z');
const entries: readonly TranscriptEntry[] = [
  { id: 'u1', kind: 'user', text: 'before', at: T0 },
  { id: 'a1', kind: 'assistant', text: 'after', at: T0 + 120_000 },
];
const frame = (compaction: NonNullable<SessionLiveActivity['compaction']>): SessionLiveActivity => ({
  sessionId: 's',
  at: new Date(T0).toISOString(),
  compaction,
});

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

describe('Transcript compaction', () => {
  test('shows the progress card even when the session is not busy, in place of the working line', async () => {
    const live = frame({
      phase: 'running',
      startedAt: new Date().toISOString(),
      expectedMs: 60_000,
      basis: 'typical',
    });
    mounted = await mount(<Transcript busy daemonId="d" entries={entries} live={live} sessionId="s" />);
    expect(mounted.container.querySelector('[data-compaction="running"]')).not.toBeNull();
    expect(mounted.container.querySelector('.fy-live-activity')).toBeNull();
  });

  test('keeps the same bar, and its clock from the daemon’s start, across samples and a stream gap', async () => {
    const startedAt = new Date(Date.now() - 125_000).toISOString();
    const running = (percent?: number): SessionLiveActivity =>
      frame({
        phase: 'running',
        startedAt,
        expectedMs: 60_000,
        basis: 'typical',
        ...(percent === undefined ? {} : { percent }),
      });
    mounted = await mount(<Transcript busy daemonId="d" entries={entries} live={running(34)} sessionId="s" />);
    const card = mounted.container.querySelector('[data-compaction="running"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toMatch(/2m \d+s/);

    // A sample with no bar, a quiet gap (no sample at all), then the stream's next sample.
    await mounted.render(<Transcript busy daemonId="d" entries={entries} live={running()} sessionId="s" />);
    await mounted.render(<Transcript busy daemonId="d" entries={entries} live={running()} sessionId="s" />);
    await mounted.render(<Transcript busy daemonId="d" entries={entries} live={running(40)} sessionId="s" />);

    const after = mounted.container.querySelector('[data-compaction="running"]');
    expect(after).toBe(card);
    expect(after?.isConnected).toBe(true);
    expect(after?.textContent).toMatch(/2m \d+s/);
    expect(after?.textContent).toContain('40%');
  });

  test('puts the finished divider where the compaction happened', async () => {
    const live = frame({
      phase: 'done',
      endedAt: new Date(T0 + 60_000).toISOString(),
      tokensBefore: 412_000,
      tokensAfter: 38_000,
    });
    mounted = await mount(<Transcript daemonId="d" entries={entries} live={live} sessionId="s" />);
    const rows = [...mounted.container.querySelector('.fy-transcript-content')!.children].map(
      node => node.getAttribute('data-compaction') ?? node.textContent,
    );
    expect(rows.indexOf('done')).toBe(1);
    expect(mounted.container.textContent).toContain('412k → 38k');
  });

  test('puts a divider newer than every row after them', async () => {
    const live = frame({ phase: 'done', endedAt: new Date(T0 + 300_000).toISOString() });
    mounted = await mount(<Transcript daemonId="d" entries={entries} live={live} sessionId="s" />);
    const children = [...mounted.container.querySelector('.fy-transcript-content')!.children];
    expect(children.at(-1)?.getAttribute('data-compaction')).toBe('done');
  });

  test('leaves out a compaction older than the loaded rows', async () => {
    const live = frame({ phase: 'done', endedAt: new Date(T0 - 60_000).toISOString() });
    mounted = await mount(<Transcript daemonId="d" entries={entries} live={live} sessionId="s" />);
    expect(mounted.container.querySelector('[data-compaction="done"]')).toBeNull();
  });
});
