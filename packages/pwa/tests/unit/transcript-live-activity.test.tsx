import { afterEach, describe, expect, test } from 'bun:test';
import type { SessionLiveActivity } from '@ferretry/protocol';
import { Transcript } from '../../src/components/transcript.tsx';
import type { PaneActivity } from '../../src/lib/pane-activity.ts';
import type { TranscriptEntry } from '../../src/lib/session-screens.ts';
import { type Mounted, mount, must } from '../support/dom.ts';

const entries: readonly TranscriptEntry[] = [{ id: 'u1', kind: 'user', text: 'hello' }];

const startedAt = (agoMs: number): string => new Date(Date.now() - agoMs).toISOString();

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const detail = (view: Mounted): HTMLElement =>
  must(view.container.querySelector<HTMLElement>('.fy-live-activity-detail'), 'the live line’s figures');

describe('Transcript live line', () => {
  test('hands the turn start and the live sample to the working line', async () => {
    const turn = startedAt(7_200);
    const live: SessionLiveActivity = {
      sessionId: 's',
      at: new Date().toISOString(),
      turnStartedAt: turn,
      outputTokens: 3_100,
      inputTokens: 48_000,
    };
    const pane: PaneActivity = { harness: 'claude', verb: 'Pontificating…' };
    mounted = await mount(
      <Transcript activity={pane} busy daemonId="d" entries={entries} live={live} sessionId="s" turnStartedAt={turn} />,
    );
    const figures = detail(mounted);
    expect(Number(figures.getAttribute('data-live-elapsed'))).toBeGreaterThanOrEqual(7);
    expect(figures.textContent).toContain('↓ 3.1k · ↑ 48k');
    expect(mounted.container.textContent).toContain('Pontificating…');
  });

  test('without a turn start it prints the pane’s own figures, as an older daemon would', async () => {
    const pane: PaneActivity = { harness: 'claude', verb: 'Pontificating…', elapsed: '42s', tokens: '↓ 3.1k tokens' };
    mounted = await mount(<Transcript activity={pane} busy daemonId="d" entries={entries} sessionId="s" />);
    expect(detail(mounted).textContent).toContain('42s · ↓ 3.1k tokens');
    expect(detail(mounted).getAttribute('data-live-elapsed')).toBeNull();
  });

  test('shows no working line when the session is not busy', async () => {
    mounted = await mount(<Transcript daemonId="d" entries={entries} sessionId="s" turnStartedAt={startedAt(1_000)} />);
    expect(mounted.container.querySelector('.fy-live-activity')).toBeNull();
  });
});
