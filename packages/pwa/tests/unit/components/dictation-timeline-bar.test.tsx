import { afterEach, describe, expect, it } from 'bun:test';
import {
  DictationTimelineBar,
  DictationTimelineDetails,
  TimingSummary,
  timelineRows,
  timelineText,
  timingDuration,
} from '../../../src/components/dictation-timeline-bar.tsx';
import type { DictationTimeline } from '../../../src/lib/stt/dictation-timeline.ts';
import { type Mounted, mount, must } from '../../support/dom.ts';

const timeline = (overrides: Partial<DictationTimeline> = {}): DictationTimeline => ({
  totalMs: 1_000,
  speech: { engine: 'parakeet', totalMs: 600 },
  cleanup: { provider: 'groq', model: 'llama-x', via: 'device', outcome: 'cleaned', attempts: 1, totalMs: 300 },
  ...overrides,
});

const mounted: Mounted[] = [];
const show = async (element: Parameters<typeof mount>[0]): Promise<HTMLElement> => {
  const view = await mount(element);
  mounted.push(view);
  return view.container;
};
afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount();
});

describe('timingDuration', () => {
  it('says milliseconds under a second and seconds from there', () => {
    expect(timingDuration(0)).toBe('0 ms');
    expect(timingDuration(412.4)).toBe('412 ms');
    expect(timingDuration(1_000)).toBe('1.0 s');
    expect(timingDuration(2_449)).toBe('2.4 s');
  });
});

describe('<DictationTimelineBar>', () => {
  it('stacks speech, cleanup and other, sized by their time, and outlines the slowest', async () => {
    const view = await show(<DictationTimelineBar timeline={timeline()} />);
    const segments = [...view.querySelectorAll<HTMLElement>('[data-stage]')];
    expect(segments.map(segment => segment.dataset.stage)).toEqual(['speech', 'cleanup', 'other']);
    expect(segments.map(segment => segment.style.width)).toEqual(['60%', '30%', '10%']);
    expect(segments.filter(segment => segment.hasAttribute('data-slowest')).map(s => s.dataset.stage)).toEqual([
      'speech',
    ]);
  });

  it('says the same thing in words: a legend with the numbers, the slowest named, and an accessible label', async () => {
    const view = await show(<DictationTimelineBar timeline={timeline()} />);
    const legend = [...view.querySelectorAll('[data-legend]')].map(item => item.textContent);
    expect(legend).toEqual(['Speech to text 600 ms · slowest', 'Cleanup 300 ms', 'Other 100 ms']);
    expect(must(view.querySelector('[role="img"]'), 'the bar').getAttribute('aria-label')).toBe(
      'Speech to text 600 ms, Cleanup 300 ms, Other 100 ms. Slowest: Speech to text.',
    );
  });

  it('highlights cleanup when the hosted call is the slow part', async () => {
    const slowCleanup = timeline({
      totalMs: 2_000,
      cleanup: { provider: 'groq', via: 'device', outcome: 'cleaned', attempts: 1, totalMs: 1_400 },
    });
    const view = await show(<DictationTimelineBar timeline={slowCleanup} />);
    expect(must(view.querySelector('[data-slowest]'), 'the slowest').getAttribute('data-stage')).toBe('cleanup');
    expect(must(view.querySelector('[data-legend="cleanup"]'), 'cleanup legend').textContent).toContain('slowest');
  });

  it('draws a short line instead of a legend when compact, and leaves out an empty other', async () => {
    const exact = timeline({ totalMs: 900 });
    const view = await show(<DictationTimelineBar timeline={exact} compact />);
    expect(view.querySelector('[data-legend]')).toBeNull();
    expect(must(view.querySelector('[data-timeline-line]'), 'the line').textContent).toBe(
      'Speech to text 600 ms · Cleanup 300 ms · slowest: speech to text',
    );
    expect(view.querySelector('[data-stage="other"]')).toBeNull();
  });

  it('draws a bar and no slowest stage for a dictation that took no time', async () => {
    const view = await show(
      <DictationTimelineBar timeline={{ totalMs: 0, speech: { engine: 'web-speech', totalMs: 0 } }} compact />,
    );
    expect(view.querySelector('[data-slowest]')).toBeNull();
    expect(view.textContent).not.toContain('slowest');
  });
});

describe('timelineRows and <DictationTimelineDetails>', () => {
  const full: DictationTimeline = {
    totalMs: 4_000,
    audio: { ms: 6_000, bytes: 384_000 },
    prepareMs: 45,
    speech: { engine: 'parakeet', provider: 'on-device', model: 'v3', totalMs: 2_000, loadMs: 1_500 },
    contextMs: 12,
    cleanup: {
      provider: 'groq',
      model: 'llama-x',
      via: 'daemon',
      outcome: 'kept_raw',
      attempts: 2,
      retried: 'without-context',
      firstByteMs: 210,
      providerMs: 380,
      promptTokens: 40,
      completionTokens: 8,
      totalMs: 900,
    },
    insertMs: 6,
    reviewMs: 7_300,
  };

  it('lists every number it holds, in the order a dictation runs', () => {
    expect(timelineRows(full)).toEqual([
      ['Recording', '6.0 s · 375 KB'],
      ['Prepare audio', '45 ms'],
      ['Speech engine', 'Parakeet (on this device) · v3'],
      ['Speech to text', '2.0 s'],
      ['Model load (first use)', '1.5 s'],
      ['Conversation read', '12 ms'],
      ['Cleanup provider', 'Groq, via your machine · llama-x'],
      ['Cleanup', '900 ms · kept raw'],
      ['Cleanup first byte', '210 ms'],
      ['Provider time (daemon)', '380 ms'],
      ['Cleanup attempts', '2 (retried without the conversation)'],
      ['Cleanup tokens', 'prompt 40 · completion 8'],
      ['Stop to review', '4.0 s'],
      ['Insert into composer', '6 ms'],
      ['Stop to composer', '4.0 s'],
      ['Time in review box', '7.3 s'],
    ]);
  });

  it('leaves out what it does not know instead of printing a blank', () => {
    const labels = timelineRows({ totalMs: 50, speech: { engine: 'web-speech', totalMs: 40 } }).map(([label]) => label);
    expect(labels).toEqual(['Speech engine', 'Speech to text', 'Stop to review']);
  });

  it('says a single missing token count with a question mark', () => {
    const [, tokens] = timelineRows(
      timeline({
        cleanup: { provider: 'groq', via: 'device', outcome: 'cleaned', attempts: 1, totalMs: 5, promptTokens: 9 },
      }),
    ).find(([label]) => label === 'Cleanup tokens') ?? ['', ''];
    expect(tokens).toBe('prompt 9 · completion ?');
  });

  it('copies as plain label: value lines', () => {
    expect(timelineText(timeline())).toContain('Stop to review: 1.0 s');
    expect(timelineText(timeline()).split('\n').length).toBe(timelineRows(timeline()).length);
  });

  it('shows the bar and the rows together', async () => {
    const view = await show(<DictationTimelineDetails timeline={full} />);
    expect(view.querySelector('[data-timeline-bar]')).not.toBeNull();
    expect(view.querySelector('dl')?.textContent).toContain('Cleanup tokens');
  });
});

describe('<TimingSummary>', () => {
  const entry = (engine: 'parakeet' | 'web-speech', speechMs: number, cleanupMs?: number) => ({
    timeline: timeline({
      speech: { engine, totalMs: speechMs },
      ...(cleanupMs === undefined
        ? { cleanup: undefined }
        : {
            cleanup: {
              provider: 'groq',
              via: 'device' as const,
              outcome: 'cleaned' as const,
              attempts: 1,
              totalMs: cleanupMs,
            },
          }),
    }),
  });

  it('shows median and p90 for speech and for cleanup, per engine and provider', async () => {
    const entries = [entry('parakeet', 100, 200), entry('parakeet', 300, 400), entry('web-speech', 50)];
    const view = await show(<TimingSummary entries={entries} />);
    const rows = (table: string): string[] =>
      [...must(view.querySelector(`[data-timing-table="${table}"]`), table).querySelectorAll('[data-timing-row]')].map(
        row => [...row.children].map(cell => cell.textContent).join('|'),
      );
    expect(rows('Speech to text')).toEqual([
      'Parakeet (on this device)|2|100 ms|300 ms',
      'Browser speech|1|50 ms|50 ms',
    ]);
    expect(rows('Cleanup')).toEqual(['Groq, this browser|2|200 ms|400 ms']);
    expect(view.textContent).toContain('Last 3 timed dictations');
  });

  it('says how many dictations it read, in the singular for one', async () => {
    const view = await show(<TimingSummary entries={[entry('parakeet', 100, 200)]} />);
    expect(view.textContent).toContain('Last 1 timed dictation:');
  });

  it('reads at most the newest twenty', async () => {
    const view = await show(<TimingSummary entries={Array.from({ length: 30 }, () => entry('parakeet', 100, 200))} />);
    expect(view.textContent).toContain('Last 20 timed dictations');
    expect(view.querySelector('[data-timing-row="parakeet"] td')?.textContent).toBe('20');
  });

  it('draws nothing when no dictation has a timeline, and no cleanup table without cleanup', async () => {
    const none = await show(<TimingSummary entries={[{}, { timeline: undefined }]} />);
    expect(none.querySelector('[data-timing-summary]')).toBeNull();
    const speechOnly = await show(<TimingSummary entries={[entry('web-speech', 80)]} />);
    expect(speechOnly.querySelector('[data-timing-table="Cleanup"]')).toBeNull();
  });
});
