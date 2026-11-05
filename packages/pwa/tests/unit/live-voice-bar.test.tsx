import { afterEach, describe, expect, it } from 'bun:test';
import {
  barLevels,
  LiveVoiceBar,
  type LiveVoiceBarProps,
  liveAnnouncement,
  MAX_BARS,
} from '../../src/components/live-voice-bar.tsx';
import {
  INITIAL_LIVE_STATE,
  type LiveEvent,
  type LiveState,
  liveReduce,
} from '../../src/lib/voice-chat/live-machine.ts';
import { type LiveView, liveView } from '../../src/lib/voice-chat/live-view.ts';
import { interact, mount, must, pressKey } from '../support/dom.ts';

const run = (events: readonly LiveEvent[], from: LiveState = INITIAL_LIVE_STATE): LiveState =>
  events.reduce((state, event) => liveReduce(state, event).state, from);

const LISTENING: readonly LiveEvent[] = [
  { type: 'start', atMs: 0, canSend: true, visible: true },
  { type: 'locks', granted: true },
  { type: 'listening' },
];
const HEARING: readonly LiveEvent[] = [
  ...LISTENING,
  { type: 'speech-start' },
  { type: 'live-words', text: 'fix the login redirect and run the tests' },
];
const SENDING: readonly LiveEvent[] = [
  ...HEARING,
  { type: 'turn-end', atMs: 5_000, speechEndedAtMs: 3_500, reason: 'pause' },
];
const WORDS: readonly LiveEvent[] = [
  ...SENDING,
  { type: 'turn-words', attempt: 1, atMs: 5_300, text: 'Fix the login redirect and run the tests.' },
];
const SENT: readonly LiveEvent[] = [...WORDS, { type: 'countdown-done', atMs: 6_500 }, { type: 'sent', atMs: 6_600 }];

const view = (events: readonly LiveEvent[], nowMs = 0, composerHasWords = false): LiveView =>
  liveView(run(events), nowMs, composerHasWords);

interface Calls {
  hold: number;
  sendNow: number;
  resume: number;
  end: number;
  skip: number;
  repeat: number;
}
const harness = (
  shown: LiveView,
  overrides: Partial<LiveVoiceBarProps> = {},
): { readonly calls: Calls; readonly element: React.ReactElement } => {
  const calls: Calls = { hold: 0, sendNow: 0, resume: 0, end: 0, skip: 0, repeat: 0 };
  return {
    calls,
    element: (
      <LiveVoiceBar
        view={shown}
        layout="phone"
        levels={[0.2, 0.8]}
        reducedMotion={false}
        onHold={() => calls.hold++}
        onSendNow={() => calls.sendNow++}
        onResume={() => calls.resume++}
        onEnd={() => calls.end++}
        onSkip={() => calls.skip++}
        onRepeat={() => calls.repeat++}
        {...overrides}
      />
    ),
  };
};

const named = (container: HTMLElement, name: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find(button => button.textContent?.replace(/\s+/g, ' ').trim() === name);
const names = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('button')].map(button => button.textContent?.replace(/\s+/g, ' ').trim() ?? '');
const region = (container: HTMLElement): string =>
  must(container.querySelector('[data-live-region]'), 'the live region').textContent ?? '';

const everyPhase = (): readonly (readonly [string, LiveView])[] => [
  ['starting', view(LISTENING.slice(0, 1))],
  ['listening', view(LISTENING)],
  ['hearing', view(HEARING)],
  ['sending ring', view(WORDS, 5_000)],
  ['sending words', view(SENDING, 6_600)],
  ['sending in flight', view([...WORDS, { type: 'countdown-done', atMs: 6_500 }], 6_500)],
  ['working', view(SENT, 18_700)],
  ['hold', view([...WORDS, { type: 'hold' }])],
  ['hold failed', view([...WORDS, { type: 'countdown-done', atMs: 6_500 }, { type: 'send-failed' }])],
  ['paused', view([...LISTENING, { type: 'visibility', visible: false }])],
];

afterEach(() => {
  document.body.innerHTML = '';
});

describe('barLevels', () => {
  it('keeps the newest levels, clamps garbage into 0..1, and is one bar when motion is reduced', () => {
    const many = Array.from({ length: MAX_BARS + 8 }, (_, index) => index / 100);
    expect(barLevels(many, false)).toHaveLength(MAX_BARS);
    expect(barLevels(many, false).at(-1)).toBe((MAX_BARS + 7) / 100);
    expect(barLevels([-2, 3, Number.NaN, Number.POSITIVE_INFINITY], false)).toEqual([0, 1, 0, 0]);
    expect(barLevels([0.1, 0.9], true)).toEqual([0.9]);
    expect(barLevels([], true)).toEqual([0]);
    expect(barLevels([], false)).toEqual([]);
  });
});

describe('liveAnnouncement', () => {
  it('says nothing while Live is off, and says the phase otherwise', () => {
    expect(liveAnnouncement(liveView(INITIAL_LIVE_STATE, 0))).toBeNull();
    const said = (shown: LiveView): string | undefined => liveAnnouncement(shown)?.text;
    expect(said(view(LISTENING.slice(0, 1)))).toBe('Starting. Allow the microphone if your browser asks.');
    expect(said(view(LISTENING))).toBe('Listening');
    expect(said(view(HEARING))).toBe('Hearing you');
    expect(said(view(SENT, 18_700))).toBe('Ferret is working');
    expect(said(view([...WORDS, { type: 'hold' }]))).toBe(
      'On hold. Your words are in the message box. Resume, or send them.',
    );
    expect(said(view([...LISTENING, { type: 'visibility', visible: false }]))).toBe(
      'Paused. Live paused while away. Resume?',
    );
    const working = run(SENT);
    const reading = run([{ type: 'reply', signal: 'done' }], { ...working, canRead: true });
    expect(said(liveView(reading, 0))).toBe('Reading reply');
  });

  it('says the ring ONCE, in whole seconds, and not on every tick', () => {
    const sending = run(WORDS);
    const first = liveAnnouncement(liveView(sending, 5_000));
    const later = liveAnnouncement(liveView(sending, 5_800));
    expect(first?.text).toBe('Sending in 2 seconds');
    expect(later?.text).toBe('Sending in 1 second');
    expect(later?.key).toBe(first?.key);
    expect(liveAnnouncement(liveView(sending, 6_600))?.text).toBe('Sending…');
  });
});

describe('<LiveVoiceBar> — what it draws', () => {
  it('draws nothing while Live is off', async () => {
    const { element } = harness(liveView(INITIAL_LIVE_STATE, 0));
    const mounted = await mount(element);
    expect(mounted.container.innerHTML).toBe('');
    await mounted.unmount();
  });

  it('says every phase in words, on the phone and on the computer', async () => {
    for (const layout of ['phone', 'desktop'] as const) {
      for (const [label, shown] of everyPhase()) {
        const { element } = harness(shown, { layout });
        const mounted = await mount(element);
        const state = must(mounted.container.querySelector('[data-live-state]'), `${label} state`);
        expect(state.textContent).toBe(shown.stateWord);
        const detail = must(mounted.container.querySelector('[data-live-detail]'), `${label} detail`);
        expect(detail.textContent).toBe(shown.detail ?? '');
        expect(mounted.container.querySelector('section')?.getAttribute('data-live-phase')).toBe(shown.phase);
        expect(mounted.container.querySelector('section')?.getAttribute('data-tone')).toBe(shown.tone);
        await mounted.unmount();
      }
    }
  });

  it('shows the live words while hearing, and keeps room for them when there are none', async () => {
    const hearing = await mount(harness(view(HEARING)).element);
    expect(hearing.container.querySelector('[data-live-words]')?.textContent).toBe(
      'fix the login redirect and run the tests',
    );
    expect(hearing.container.querySelector('[data-live-words]')?.getAttribute('data-live-words')).toBe('heard');
    await hearing.unmount();
    const listening = await mount(harness(view(LISTENING)).element);
    expect(listening.container.querySelector('[data-live-words]')?.getAttribute('data-live-words')).toBe('empty');
    await listening.unmount();
  });

  it('draws the level bars, hidden from screen readers, flat when the mic is closed or the ring runs', async () => {
    const live = await mount(harness(view(HEARING), { levels: [0, 0.5, 1] }).element);
    const bars = must(live.container.querySelector('.fy-live-bars'), 'bars');
    expect(bars.getAttribute('aria-hidden')).toBe('true');
    expect([...bars.children].map(bar => (bar as HTMLElement).style.height)).toEqual(['6%', '50%', '100%']);
    await live.unmount();
    // No meter where the mic is not listening or a countdown has the stage: a meter of a closed mic would lie,
    // and flat bars read as a dashed line.
    for (const quiet of [view(WORDS, 5_000), view(SENT, 18_700), view([...WORDS, { type: 'hold' }])]) {
      for (const reducedMotion of [false, true]) {
        const mounted = await mount(harness(quiet, { levels: [0.9, 0.9], reducedMotion }).element);
        expect(mounted.container.querySelector('.fy-live-bars')).toBeNull();
        expect(mounted.container.querySelector('.fy-live-level')).toBeNull();
        await mounted.unmount();
      }
    }
  });
});

describe('<LiveVoiceBar> — the phone', () => {
  it('offers the controls the view offers, and the big button is the view’s action', async () => {
    const listening = await mount(harness(view(LISTENING)).element);
    expect(names(listening.container)).toEqual(['LIVE', 'Listening', 'End']);
    expect(named(listening.container, 'LIVE')?.getAttribute('aria-label')).toBe('End Live voice');
    await listening.unmount();
    const hearing = await mount(harness(view(HEARING)).element);
    // ONE Hold: the big button is it, so the row beneath does not repeat it.
    expect(names(hearing.container)).toEqual(['LIVE', 'Hearing you', 'Send now', 'End']);
    await hearing.unmount();
    const hold = await mount(harness(view([...WORDS, { type: 'hold' }])).element);
    expect(names(hold.container)).toEqual(['LIVE', 'Resume', 'Send now', 'End']);
    await hold.unmount();
  });

  it('runs hold, send now, resume, skip and end from the right buttons', async () => {
    const sending = harness(view(WORDS, 5_000));
    const mounted = await mount(sending.element);
    expect(names(mounted.container).filter(name => name === 'Hold')).toHaveLength(1);
    await interact(() =>
      must(mounted.container.querySelector<HTMLButtonElement>('[data-live-big="hold"]'), 'big').click(),
    );
    await interact(() => must(named(mounted.container, 'Send now'), 'Send now').click());
    await interact(() => must(named(mounted.container, 'End'), 'End').click());
    await interact(() => must(named(mounted.container, 'LIVE'), 'pill').click());
    expect(sending.calls).toEqual({ hold: 1, sendNow: 1, resume: 0, end: 2, skip: 0, repeat: 0 });
    await mounted.unmount();

    const held = harness(view([...WORDS, { type: 'hold' }]));
    const resumed = await mount(held.element);
    await interact(() =>
      must(resumed.container.querySelector<HTMLButtonElement>('[data-live-big="resume"]'), 'big').click(),
    );
    expect(held.calls.resume).toBe(1);
    await resumed.unmount();

    const working = run(SENT);
    const reading = liveView(run([{ type: 'reply', signal: 'done' }], { ...working, canRead: true }), 0);
    const skipping = harness(reading);
    const stopped = await mount(skipping.element);
    await interact(() =>
      must(stopped.container.querySelector<HTMLButtonElement>('[data-live-big="skip"]'), 'big').click(),
    );
    expect(skipping.calls.skip).toBe(1);
    await stopped.unmount();
  });

  it('disables the big button when it has nothing to do', async () => {
    for (const shown of [view(LISTENING.slice(0, 1)), view(SENT, 18_700)]) {
      const { element, calls } = harness(shown);
      const mounted = await mount(element);
      const big = must(mounted.container.querySelector<HTMLButtonElement>('[data-live-big="none"]'), 'big');
      expect(big.disabled).toBe(true);
      await interact(() => big.click());
      expect(calls).toEqual({ hold: 0, sendNow: 0, resume: 0, end: 0, skip: 0, repeat: 0 });
      await mounted.unmount();
    }
  });

  it('is 96 px for the big button’s label and says Working with the time', async () => {
    const mounted = await mount(harness(view(SENT, 18_700)).element);
    expect(must(mounted.container.querySelector('[data-live-big]'), 'big').textContent).toBe('Working 0:12');
    await mounted.unmount();
  });
});

describe('<LiveVoiceBar> — a view that does not offer End', () => {
  it('draws no End button on either layout', async () => {
    const noEnd: LiveView = { ...view(HEARING), canEnd: false };
    const phone = await mount(harness(noEnd).element);
    expect(names(phone.container)).toEqual(['LIVE', 'Hearing you', 'Send now']);
    await phone.unmount();
    const desktop = await mount(harness(noEnd, { layout: 'desktop' }).element);
    expect(names(desktop.container)).toEqual(['Hold H', 'Send now ↵']);
    await desktop.unmount();
  });
});

describe('<LiveVoiceBar> — the ring and reduced motion', () => {
  it('draws the ring filled by the progress while the countdown runs', async () => {
    const mounted = await mount(harness(view(WORDS, 5_750)).element);
    const fill = must(mounted.container.querySelector('.fy-live-ring-fill'), 'ring fill');
    const length = 2 * Math.PI * 54;
    expect(Number(fill.getAttribute('stroke-dashoffset'))).toBeCloseTo(length * 0.5, 5);
    expect(mounted.container.querySelector('.fy-live-state--count')).toBeNull();
    await mounted.unmount();
  });

  it('draws the countdown as a bar along the desktop strip, filled by the same progress', async () => {
    const mounted = await mount(harness(view(WORDS, 5_750), { layout: 'desktop' }).element);
    const progress = must(mounted.container.querySelector('.fy-live-progress'), 'progress bar');
    expect(progress.getAttribute('aria-hidden')).toBe('true');
    expect(progress.getAttribute('data-progress')).toBe('50');
    expect((progress.firstElementChild as HTMLElement).style.width).toBe('50%');
    expect(mounted.container.querySelector('.fy-live-ring')).toBeNull();
    await mounted.unmount();
    // At the start of the pause it is empty, and with reduced motion (or no countdown) it is not drawn.
    const start = await mount(harness(view(WORDS, 5_000), { layout: 'desktop' }).element);
    expect(start.container.querySelector('.fy-live-progress')?.getAttribute('data-progress')).toBe('0');
    await start.unmount();
    const still = await mount(harness(view(WORDS, 5_750), { layout: 'desktop', reducedMotion: true }).element);
    expect(still.container.querySelector('.fy-live-progress')).toBeNull();
    await still.unmount();
    const none = await mount(harness(view(HEARING), { layout: 'desktop' }).element);
    expect(none.container.querySelector('.fy-live-progress')).toBeNull();
    await none.unmount();
  });

  it('draws no ring without a countdown', async () => {
    const mounted = await mount(harness(view(HEARING)).element);
    expect(mounted.container.querySelector('.fy-live-ring')).toBeNull();
    await mounted.unmount();
  });

  it('with reduced motion: no ring, the countdown set large as words, and ONE level bar', async () => {
    for (const layout of ['phone', 'desktop'] as const) {
      const mounted = await mount(
        harness(view(WORDS, 5_000), { reducedMotion: true, layout, levels: [0.1, 0.4, 0.7] }).element,
      );
      expect(mounted.container.querySelector('.fy-live-ring')).toBeNull();
      expect(must(mounted.container.querySelector('.fy-live-state--count'), 'big count').textContent).toBe(
        'Sending in 2 s',
      );
      // The mic is open but the ring has the stage: no meter now.
      expect(mounted.container.querySelector('.fy-live-level')).toBeNull();
      await mounted.unmount();
    }
  });

  it('with reduced motion the level is ONE still, labelled meter: no bars, no square that looks like Stop', async () => {
    for (const layout of ['phone', 'desktop'] as const) {
      const mounted = await mount(
        harness(view(HEARING), { reducedMotion: true, layout, levels: [0.1, 0.4, 0.7] }).element,
      );
      expect(mounted.container.querySelector('.fy-live-bar')).toBeNull();
      const level = must(mounted.container.querySelector('.fy-live-level'), 'level meter');
      expect(level.getAttribute('aria-hidden')).toBe('true');
      expect(level.getAttribute('data-level')).toBe('70');
      expect(level.textContent).toContain('Mic level');
      expect((level.querySelector('.fy-live-level-fill') as HTMLElement).style.width).toBe('70%');
      await mounted.unmount();
    }
    const silent = await mount(harness(view(LISTENING), { reducedMotion: true, levels: [] }).element);
    expect(silent.container.querySelector('.fy-live-level')?.getAttribute('data-level')).toBe('0');
    await silent.unmount();
  });

  it('says One moment, not Hold, on the big button while a stop waits for the words', async () => {
    const parked = view([...SENDING, { type: 'hold' }], 6_600);
    const mounted = await mount(harness(parked).element);
    expect(mounted.container.querySelector('[data-live-big="none"]')?.textContent).toBe('One moment');
    expect(mounted.container.querySelector<HTMLButtonElement>('[data-live-big]')?.disabled).toBe(true);
    await mounted.unmount();
  });

  it('does not set "Getting your words…" large once the countdown has run out', async () => {
    const mounted = await mount(harness(view(SENDING, 6_600), { reducedMotion: true }).element);
    expect(mounted.container.querySelector('.fy-live-state--count')).toBeNull();
    expect(mounted.container.querySelector('[data-live-state]')?.textContent).toBe('Getting your words…');
    await mounted.unmount();
  });

  it('only sets the count large when there is a countdown to read', async () => {
    const mounted = await mount(harness(view(HEARING), { reducedMotion: true }).element);
    expect(mounted.container.querySelector('.fy-live-state--count')).toBeNull();
    await mounted.unmount();
  });

  it('follows the page’s own reduced-motion setting when the prop is omitted', async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) =>
      ({
        matches: query.includes('reduce'),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
    try {
      const { element } = harness(view(WORDS, 5_000), { reducedMotion: undefined });
      const mounted = await mount(element);
      expect(mounted.container.querySelector('.fy-live-ring')).toBeNull();
      expect(mounted.container.querySelector('.fy-live-state--count')).not.toBeNull();
      await mounted.unmount();
    } finally {
      window.matchMedia = original;
    }
  });
});

describe('<LiveVoiceBar> — the desktop strip', () => {
  it('writes the key on each button it offers', async () => {
    const hearing = await mount(harness(view(HEARING), { layout: 'desktop' }).element);
    expect(names(hearing.container)).toEqual(['Hold H', 'Send now ↵', 'End Esc']);
    expect(hearing.container.textContent).toContain('LIVE');
    await hearing.unmount();
    const hold = await mount(harness(view([...WORDS, { type: 'hold' }]), { layout: 'desktop' }).element);
    expect(names(hold.container)).toEqual(['Send now ↵', 'Resume Space', 'End Esc']);
    await hold.unmount();
    const working = run(SENT);
    const reading = liveView(run([{ type: 'reply', signal: 'done' }], { ...working, canRead: true }), 0);
    const speaking = await mount(harness(reading, { layout: 'desktop' }).element);
    expect(names(speaking.container)).toEqual(['Stop reading Space', 'Repeat R', 'End']);
    await speaking.unmount();
  });

  it('runs every button', async () => {
    const hearing = harness(view(HEARING), { layout: 'desktop' });
    const mounted = await mount(hearing.element);
    await interact(() => must(named(mounted.container, 'Hold H'), 'Hold').click());
    await interact(() => must(named(mounted.container, 'Send now ↵'), 'Send now').click());
    await interact(() => must(named(mounted.container, 'End Esc'), 'End').click());
    expect(hearing.calls).toEqual({ hold: 1, sendNow: 1, resume: 0, end: 1, skip: 0, repeat: 0 });
    await mounted.unmount();
    const held = harness(view([...WORDS, { type: 'hold' }]), { layout: 'desktop' });
    const resumed = await mount(held.element);
    await interact(() => must(named(resumed.container, 'Resume Space'), 'Resume').click());
    expect(held.calls.resume).toBe(1);
    await resumed.unmount();
    const working = run(SENT);
    const reading = liveView(run([{ type: 'reply', signal: 'done' }], { ...working, canRead: true }), 0);
    const speaking = harness(reading, { layout: 'desktop' });
    const stopped = await mount(speaking.element);
    await interact(() => must(named(stopped.container, 'Stop reading Space'), 'Stop reading').click());
    expect(speaking.calls.skip).toBe(1);
    await stopped.unmount();
  });
});

describe('<LiveVoiceBar> — the refusal notice', () => {
  const refused = (block: 'other-tab' | 'mic-blocked'): LiveView =>
    view(
      block === 'other-tab'
        ? [
            { type: 'start', atMs: 0, canSend: true, visible: true },
            { type: 'locks', granted: false },
          ]
        : [
            { type: 'start', atMs: 0, canSend: true, visible: true },
            { type: 'locks', granted: true },
            { type: 'blocked', block: 'mic-blocked' },
          ],
    );

  it('is a slim status row with the words and no controls, on both layouts', async () => {
    for (const layout of ['phone', 'desktop'] as const) {
      for (const block of ['other-tab', 'mic-blocked'] as const) {
        const shown = refused(block);
        expect(shown.visible).toBe(true);
        expect(shown.phase).toBe('off');
        const mounted = await mount(harness(shown, { layout }).element);
        const row = must(mounted.container.querySelector('[data-live-notice]'), 'notice');
        expect(row.getAttribute('role')).toBe('status');
        expect(row.textContent).toBe(shown.detail ?? '');
        expect(mounted.container.querySelectorAll('button')).toHaveLength(0);
        await mounted.unmount();
      }
    }
  });
});

describe('<LiveVoiceBar> — the live region', () => {
  it('is polite and starts empty, then says the phase after mount', async () => {
    const mounted = await mount(harness(view(LISTENING)).element);
    const live = must(mounted.container.querySelector('[data-live-region]'), 'region');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(region(mounted.container)).toBe('Listening');
    await mounted.unmount();
  });

  it('announces a phase change, the ring ONCE, and a notice, but never the live words', async () => {
    const mounted = await mount(harness(view(HEARING)).element);
    expect(region(mounted.container)).toBe('Hearing you');
    expect(region(mounted.container)).not.toContain('login');
    const sending = run(WORDS);
    await mounted.render(harness(liveView(sending, 5_000)).element);
    expect(region(mounted.container)).toBe('Sending in 2 seconds');
    await mounted.render(harness(liveView(sending, 5_800)).element);
    expect(region(mounted.container)).toBe('Sending in 2 seconds');
    await mounted.render(harness(liveView(sending, 6_600)).element);
    expect(region(mounted.container)).toBe('Sending…');
    await mounted.render(harness(view(SENT, 18_700)).element);
    expect(region(mounted.container)).toBe('Ferret is working');
    await mounted.render(harness(view(SENT, 19_700)).element);
    expect(region(mounted.container)).toBe('Ferret is working');
    const failedTake = view([...SENDING, { type: 'turn-failed', attempt: 1, block: 'engine-failed' }]);
    await mounted.render(harness(failedTake).element);
    expect(region(mounted.container)).toBe(`Listening. ${failedTake.detail}`);
    await mounted.unmount();
  });

  it('goes quiet when Live goes off', async () => {
    const mounted = await mount(harness(view(LISTENING)).element);
    await mounted.render(harness(liveView(INITIAL_LIVE_STATE, 0)).element);
    expect(mounted.container.innerHTML).toBe('');
    await mounted.unmount();
  });
});

describe('<LiveVoiceBar> — keys', () => {
  it('runs hold, send now, resume, skip and end from the document', async () => {
    const hearing = harness(view(HEARING));
    const mounted = await mount(hearing.element);
    await interact(() => pressKey(document.body, 'h'));
    await interact(() => pressKey(document.body, 'H'));
    await interact(() => pressKey(document.body, 'Enter'));
    await interact(() => pressKey(document.body, 'Escape'));
    expect(hearing.calls).toEqual({ hold: 2, sendNow: 1, resume: 0, end: 1, skip: 0, repeat: 0 });
    await mounted.unmount();

    const held = harness(view([...WORDS, { type: 'hold' }]));
    const resumed = await mount(held.element);
    await interact(() => pressKey(document.body, ' '));
    expect(held.calls.resume).toBe(1);
    await resumed.unmount();

    const working = run(SENT);
    const reading = harness(liveView(run([{ type: 'reply', signal: 'done' }], { ...working, canRead: true }), 0));
    const speaking = await mount(reading.element);
    await interact(() => pressKey(document.body, ' '));
    expect(reading.calls.skip).toBe(1);
    await speaking.unmount();
  });

  it('prevents the default of a key it handled, and leaves every other key alone', async () => {
    const hearing = harness(view(HEARING));
    const mounted = await mount(hearing.element);
    const handled = new KeyboardEvent('keydown', { key: 'h', bubbles: true, cancelable: true });
    await interact(() => document.body.dispatchEvent(handled));
    expect(handled.defaultPrevented).toBe(true);
    const other = new KeyboardEvent('keydown', { key: 'q', bubbles: true, cancelable: true });
    await interact(() => document.body.dispatchEvent(other));
    expect(other.defaultPrevented).toBe(false);
    const notOffered = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    await interact(() => document.body.dispatchEvent(notOffered));
    expect(notOffered.defaultPrevented).toBe(false);
    expect(hearing.calls).toEqual({ hold: 1, sendNow: 0, resume: 0, end: 0, skip: 0, repeat: 0 });
    await mounted.unmount();
  });

  it('ignores keys typed in a text field, a select or an editable element', async () => {
    const hearing = harness(view(HEARING));
    const mounted = await mount(hearing.element);
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const inside = document.createElement('span');
    editable.append(inside);
    const fields: EventTarget[] = [
      document.createElement('textarea'),
      document.createElement('input'),
      document.createElement('select'),
      inside,
    ];
    for (const field of fields.slice(0, 3)) document.body.append(field as Node);
    document.body.append(editable);
    for (const field of fields) {
      await interact(() => pressKey(field, 'h'));
      await interact(() => pressKey(field, 'Escape'));
      await interact(() => pressKey(field, 'Enter'));
    }
    expect(hearing.calls).toEqual({ hold: 0, sendNow: 0, resume: 0, end: 0, skip: 0, repeat: 0 });
    await mounted.unmount();
  });

  it('treats contenteditable="false" as not a text field', async () => {
    const hearing = harness(view(HEARING));
    const mounted = await mount(hearing.element);
    const block = document.createElement('div');
    block.setAttribute('contenteditable', 'false');
    document.body.append(block);
    await interact(() => pressKey(block, 'h'));
    expect(hearing.calls.hold).toBe(1);
    await mounted.unmount();
  });

  it('ignores a press with ctrl, meta or alt held, and a held-down key repeating', async () => {
    const hearing = harness(view(HEARING));
    const mounted = await mount(hearing.element);
    await interact(() => pressKey(document.body, 'h', { ctrlKey: true }));
    await interact(() => pressKey(document.body, 'h', { metaKey: true }));
    await interact(() => pressKey(document.body, 'h', { altKey: true }));
    await interact(() => pressKey(document.body, 'h', { repeat: true }));
    expect(hearing.calls.hold).toBe(0);
    await mounted.unmount();
  });

  it('leaves Enter and Space to a focused button, which answers them itself, but still takes H and Esc', async () => {
    const hearing = harness(view(HEARING), { layout: 'desktop' });
    const mounted = await mount(hearing.element);
    const hold = must(named(mounted.container, 'Hold H'), 'Hold');
    await interact(() => pressKey(hold, 'Enter'));
    await interact(() => pressKey(hold, ' '));
    expect(hearing.calls.sendNow).toBe(0);
    await interact(() => pressKey(hold, 'Escape'));
    expect(hearing.calls.end).toBe(1);
    await mounted.unmount();
  });

  it('removes its listener when unmounted, and has none while Live is off or only refusing', async () => {
    const hearing = harness(view(HEARING));
    const mounted = await mount(hearing.element);
    await mounted.unmount();
    pressKey(document.body, 'h');
    expect(hearing.calls.hold).toBe(0);

    const off = harness(liveView(INITIAL_LIVE_STATE, 0));
    const idle = await mount(off.element);
    pressKey(document.body, 'Escape');
    expect(off.calls.end).toBe(0);
    await idle.unmount();

    const refused = harness(
      view([
        { type: 'start', atMs: 0, canSend: true, visible: true },
        { type: 'locks', granted: false },
      ]),
    );
    const notice = await mount(refused.element);
    pressKey(document.body, 'Escape');
    expect(refused.calls.end).toBe(0);
    await notice.unmount();
  });

  it('stops listening when the view goes away, and follows the newest view', async () => {
    const calls: string[] = [];
    const bar = (shown: LiveView): React.ReactElement => (
      <LiveVoiceBar
        view={shown}
        layout="desktop"
        levels={[]}
        reducedMotion={false}
        onHold={() => calls.push('hold')}
        onSendNow={() => calls.push('send')}
        onResume={() => calls.push('resume')}
        onEnd={() => calls.push('end')}
        onSkip={() => calls.push('skip')}
        onRepeat={() => calls.push('repeat')}
      />
    );
    const mounted = await mount(bar(view(LISTENING)));
    await interact(() => pressKey(document.body, 'Enter'));
    expect(calls).toEqual([]);
    await mounted.render(bar(view(HEARING)));
    await interact(() => pressKey(document.body, 'Enter'));
    expect(calls).toEqual(['send']);
    await mounted.render(bar(liveView(INITIAL_LIVE_STATE, 0)));
    await interact(() => pressKey(document.body, 'Enter'));
    expect(calls).toEqual(['send']);
    await mounted.unmount();
  });
});
