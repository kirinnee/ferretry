import { afterEach, describe, expect, test } from 'bun:test';
import { Transcript } from '../../src/components/transcript.tsx';
import {
  LOAD_OLDER_WITHIN_PX,
  type TranscriptHistoryControl,
  TranscriptHistoryRow,
  wantsOlder,
} from '../../src/components/transcript-history-row.tsx';
import type { TranscriptEntry } from '../../src/lib/session-screens.ts';
import type { TranscriptHistoryStatus } from '../../src/lib/transcript-history.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';

/**
 * The top of the chat: older messages load by themselves as the reader nears it, the row says what is
 * happening there, and its button is the same load for a keyboard or a screen reader.
 */

const T0 = Date.parse('2026-01-02T03:04:00.000Z');
const entries: readonly TranscriptEntry[] = [
  { id: 'u1', kind: 'user', text: 'first', at: T0 },
  { id: 'a1', kind: 'assistant', text: 'second', at: T0 + 60_000 },
];

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const control = (status: TranscriptHistoryStatus, loads: string[] = []): TranscriptHistoryControl => ({
  status,
  loadOlder: () => loads.push(status),
});

describe('wantsOlder', () => {
  test('wants a page only when there is one and the reader is near the top', () => {
    expect(wantsOlder('more', 0)).toBe(true);
    expect(wantsOlder('more', LOAD_OLDER_WITHIN_PX)).toBe(true);
    expect(wantsOlder('more', LOAD_OLDER_WITHIN_PX + 1)).toBe(false);
    for (const status of ['loading', 'start', 'error', 'unavailable'] as const)
      expect(wantsOlder(status, 0)).toBe(false);
  });
});

describe('TranscriptHistoryRow', () => {
  test('says nothing where the daemon cannot page', async () => {
    mounted = await mount(<TranscriptHistoryRow control={control('unavailable')} />);
    expect(mounted.container.querySelector('.fy-transcript-history')).toBeNull();
  });

  test('says older messages are loading, as a status', async () => {
    mounted = await mount(<TranscriptHistoryRow control={control('loading')} />);
    const note = must(mounted.container.querySelector('[role="status"]'), 'the loading note');
    expect(note.textContent).toContain('Loading older messages');
  });

  test('marks the beginning of the conversation', async () => {
    mounted = await mount(<TranscriptHistoryRow control={control('start')} />);
    expect(mounted.container.textContent).toBe('Beginning of the conversation');
    expect(mounted.container.querySelector('button')).toBeNull();
  });

  test('offers the load as a button, and again after a failure', async () => {
    const loads: string[] = [];
    mounted = await mount(<TranscriptHistoryRow control={control('more', loads)} />);
    const more = must(mounted.container.querySelector('button'), 'the load button');
    expect(more.textContent).toBe('Load older messages');
    await interact(() => more.click());
    await mounted.unmount();

    mounted = await mount(<TranscriptHistoryRow control={control('error', loads)} />);
    const retry = must(mounted.container.querySelector('button'), 'the retry button');
    expect(retry.textContent).toContain('try again');
    await interact(() => retry.click());
    expect(loads).toEqual(['more', 'error']);
  });
});

describe('Transcript with older history', () => {
  test('puts the row above the first message', async () => {
    mounted = await mount(<Transcript daemonId="d" entries={entries} history={control('start')} sessionId="s" />);
    const first = mounted.container.querySelector('.fy-transcript-content')?.firstElementChild;
    expect(first?.getAttribute('data-history')).toBe('start');
  });

  test('loads older messages by itself when the reader is at the top', async () => {
    const loads: string[] = [];
    mounted = await mount(<Transcript daemonId="d" entries={entries} history={control('more', loads)} sessionId="s" />);
    expect(loads.length).toBeGreaterThan(0);
  });

  test('asks again as the reader scrolls, and never when there is nothing more', async () => {
    const loads: string[] = [];
    mounted = await mount(<Transcript daemonId="d" entries={entries} history={control('more', loads)} sessionId="s" />);
    const before = loads.length;
    const viewport = must(mounted.container.querySelector<HTMLElement>('.fy-transcript'), 'the transcript viewport');
    await interact(() => viewport.dispatchEvent(new Event('scroll')));
    expect(loads.length).toBe(before + 1);
    await mounted.unmount();

    const none: string[] = [];
    mounted = await mount(<Transcript daemonId="d" entries={entries} history={control('start', none)} sessionId="s" />);
    const quiet = must(mounted.container.querySelector<HTMLElement>('.fy-transcript'), 'the transcript viewport');
    await interact(() => quiet.dispatchEvent(new Event('scroll')));
    expect(none).toEqual([]);
  });

  test('scrolls as before with no history control at all', async () => {
    mounted = await mount(<Transcript daemonId="d" entries={entries} sessionId="s" />);
    const viewport = must(mounted.container.querySelector<HTMLElement>('.fy-transcript'), 'the transcript viewport');
    await interact(() => viewport.dispatchEvent(new Event('scroll')));
    expect(mounted.container.querySelector('.fy-transcript-history')).toBeNull();
  });
});
