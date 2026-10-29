import { describe, expect, it } from 'bun:test';
import {
  DictationSheet,
  type DictationSheetProps,
  type DictationStage,
  dictationFailureCopy,
  dictationStage,
  dictationStripStatus,
  formatElapsed,
  splitLiveCaption,
} from '../../src/components/dictation-sheet.tsx';
import type { CaptureMonitor } from '../../src/lib/stt/level-monitor.ts';
import { interact, mount, must, pressKey } from '../support/dom.ts';

const noop = (): void => undefined;

const sheetProps = (overrides: Partial<DictationSheetProps> = {}): DictationSheetProps => ({
  open: true,
  stage: 'recording',
  elapsedMs: 0,
  onDismiss: noop,
  onStop: noop,
  onInsert: noop,
  onDiscard: noop,
  onCancel: noop,
  onRetry: noop,
  ...overrides,
});

const buttonLabelled = (container: HTMLElement, label: string): HTMLElement =>
  must(container.querySelector(`button[aria-label="${label}"]`), `the ${label} button`) as HTMLElement;

const labels = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('button')].map(button => button.getAttribute('aria-label') ?? '');

describe('dictationStage', () => {
  const stageFor = (phase: DictationSheetProps['stage'] extends never ? never : Parameters<typeof dictationStage>[0]) =>
    dictationStage(phase);

  it('puts an error ahead of every other phase', () => {
    expect(stageFor({ phase: 'recording', hasError: true, wasCapturing: true })).toBe('error');
    expect(stageFor({ phase: 'error', hasError: false, wasCapturing: false })).toBe('error');
  });

  it('shows a landed take as the review stage, ahead of the capture phases', () => {
    expect(stageFor({ phase: 'review', hasError: false, wasCapturing: true })).toBe('review');
    expect(stageFor({ phase: 'review', hasError: false, wasCapturing: false })).toBe('review');
  });

  it('maps the capture phases straight through', () => {
    expect(stageFor({ phase: 'transcribing', hasError: false, wasCapturing: true })).toBe('transcribing');
    expect(stageFor({ phase: 'requesting', hasError: false, wasCapturing: false })).toBe('starting');
    expect(stageFor({ phase: 'recording', hasError: false, wasCapturing: false })).toBe('recording');
  });

  it('separates "not started yet" from "recorded nothing usable"', () => {
    expect(stageFor({ phase: 'idle', hasError: false, wasCapturing: false })).toBe('starting');
    expect(stageFor({ phase: 'idle', hasError: false, wasCapturing: true })).toBe('empty');
  });
});

describe('formatElapsed', () => {
  it('pads the seconds and clamps a negative clock to zero', () => {
    expect(formatElapsed(-5_000)).toBe('0:00');
    expect(formatElapsed(9_400)).toBe('0:09');
    expect(formatElapsed(61_000)).toBe('1:01');
    expect(formatElapsed(600_000)).toBe('10:00');
  });
});

describe('dictationFailureCopy', () => {
  it('treats a failed cleanup as no failed take: the review box says so, not this headline', () => {
    expect(dictationFailureCopy('enhancement-rate-limit').title).toBe('Dictation failed');
  });

  it("names the on-device engine's own failures", () => {
    expect(dictationFailureCopy('model-not-installed').title).toBe('Parakeet is not installed');
    expect(dictationFailureCopy('model-not-installed').hint).toContain('Settings › Voice');
    expect(dictationFailureCopy('engine-not-chosen').title).toBe('Choose a voice engine');
    expect(dictationFailureCopy('recognition-failed', 'parakeet').title).toBe('Transcription failed');
    expect(dictationFailureCopy('recognition-failed').title).toBe('Browser recognition failed');
  });

  it('names each microphone refusal', () => {
    expect(dictationFailureCopy('permission-denied').title).toBe('Microphone blocked');
    expect(dictationFailureCopy('no-microphone').title).toBe('No microphone found');
  });

  it('names each browser refusal without inventing a daemon to blame', () => {
    expect(dictationFailureCopy('recognition-unavailable').title).toBe('Dictation unavailable here');
    expect(dictationFailureCopy('recognition-network').title).toContain('Browser speech service');
    expect(dictationFailureCopy('recognition-failed').title).toBe('Browser recognition failed');
    expect(dictationFailureCopy('bad-audio').title).toBe("Didn't catch that");
    expect(dictationFailureCopy('bad-audio', 'browser').hint).toContain('Parakeet');
    expect(dictationFailureCopy('bad-audio', 'parakeet').hint).toBe('No usable audio was captured. Try again.');
    // The retired daemon vocabulary must not survive as unreachable copy.
    for (const retired of ['unauthorized', 'unavailable', 'busy', 'network']) {
      expect(dictationFailureCopy(retired).title).toBe('Dictation failed');
    }
  });

  it('writes no copy for codes this panel can never be shown', () => {
    // Capture codes that died with the daemon engine: nothing raises them, so a
    // headline for them would be copy proving only that a test can call this.
    for (const dead of ['audio-unavailable', 'no-media-devices', 'capture-failed', 'too-long']) {
      expect(dictationFailureCopy(dead).title).toBe('Dictation failed');
    }
    // `aborted` IS a live BrowserRecognitionErrorCode, but a cancelled take is
    // returned to idle by use-dictation — in `onFailure` and in the `finish()`
    // catch alike — so it never reaches this panel either.
    expect(dictationFailureCopy('aborted').title).toBe('Dictation failed');
  });

  it('falls back to a plain headline for an unknown or absent code', () => {
    expect(dictationFailureCopy(undefined).title).toBe('Dictation failed');
    expect(dictationFailureCopy('something-new').title).toBe('Dictation failed');
  });
});

describe('dictationStripStatus', () => {
  const failure = { title: 'Dictation failed', hint: 'Try again.' };

  it('says the result goes straight into the draft only when that is the setting', () => {
    const review = dictationStripStatus('transcribing', '', undefined, failure, 'parakeet');
    expect(review).toContain('You will review the result before it reaches your draft.');
    const insert = dictationStripStatus('transcribing', '', undefined, failure, 'parakeet', false, true);
    expect(insert).toContain('The result goes into your draft when it is ready.');
    expect(insert).not.toContain('You will review');
  });

  it('offers the standing hint while recording with nothing heard yet', () => {
    const status = dictationStripStatus('recording', '', undefined, failure);
    expect(status).toContain('press Stop');
    expect(status).toContain('only shows you the text');
  });

  it('discloses the browser vendor’s service where a sighted reader can read it', () => {
    // The honest sentence used to live only in sr-only text and in Settings,
    // while the visible strip said "handled by this browser" — which most
    // people read as "on this device".
    const status = dictationStripStatus('recording', '', undefined, failure);
    expect(status).toContain('sends this audio to its vendor’s servers');
    expect(status).toContain('Ferretry only shows you the text');
    expect(status).not.toContain('never leaves');
  });

  it('promises the audio stays on this device only for Parakeet', () => {
    expect(dictationStripStatus('recording', '', undefined, failure, 'parakeet')).toContain('audio never leaves it');
    expect(dictationStripStatus('starting', '', undefined, failure, 'parakeet')).toBe('Opening the microphone…');
    expect(dictationStripStatus('transcribing', '', undefined, failure, 'parakeet')).toContain(
      'Transcribing on this device',
    );
    // Unchosen reads like the browser engine: no privacy promise is made for it.
    expect(dictationStripStatus('recording', '', undefined, failure, null)).not.toContain('never leaves');
  });

  it('shows a caption verbatim when the browser produced one', () => {
    expect(dictationStripStatus('recording', '  hello there  ', undefined, failure)).toBe('hello there');
  });

  it('names the browser while finishing rather than claiming a daemon did it', () => {
    const status = dictationStripStatus('transcribing', '', undefined, failure);
    expect(status).toContain('Finishing in your browser');
    expect(status).not.toContain('daemon');
    expect(dictationStripStatus('transcribing', 'half a sentence', undefined, failure)).toContain(
      'Last heard: half a sentence',
    );
  });

  it('tells the reader the finished take is theirs to insert', () => {
    expect(dictationStripStatus('review', '', undefined, failure)).toContain('then insert it into your draft');
    expect(dictationStripStatus('transcribing', '', undefined, failure)).toContain('review the result');
  });

  it('says the recording produced nothing', () => {
    expect(dictationStripStatus('empty', '', undefined, failure)).toContain('No speech was captured');
  });

  it('joins the real reason, the hint and any caption for a failure', () => {
    expect(dictationStripStatus('error', 'partial', 'The daemon refused it.', failure)).toBe(
      'The daemon refused it. Try again. Last heard: partial',
    );
    expect(dictationStripStatus('error', '', undefined, failure)).toBe('Dictation failed Try again.');
  });

  it('says browser recognition is opening while starting', () => {
    expect(dictationStripStatus('starting', '', undefined, failure)).toContain('Opening browser speech recognition');
  });
});

describe('<DictationSheet>', () => {
  it('renders nothing at all while closed', async () => {
    const view = await mount(<DictationSheet {...sheetProps({ open: false })} />);
    expect(view.container.querySelector('[data-dictation-panel]')).toBeNull();
    await view.unmount();
  });

  it('is a non-modal region with no scrim, no focus trap and no dialog role', async () => {
    const view = await mount(<DictationSheet {...sheetProps()} />);
    const panel = must(view.container.querySelector('[data-dictation-panel]'), 'the panel');
    expect(panel.getAttribute('data-dictation-panel')).toBe('non-modal');
    expect(panel.getAttribute('role')).toBeNull();
    expect(panel.getAttribute('aria-modal')).toBeNull();
    expect(view.container.querySelector('[aria-labelledby]')).not.toBeNull();
    expect(document.activeElement).toBe(document.body);
    await view.unmount();
  });

  it('shows the elapsed clock and a stop action while recording', async () => {
    const view = await mount(<DictationSheet {...sheetProps({ elapsedMs: 65_000 })} />);
    expect(view.container.textContent).toContain('1:05');
    expect(labels(view.container)).toEqual([
      'Stop recording and review the text',
      'Cancel dictation',
      'Hide dictation panel; recording continues',
    ]);
    await view.unmount();
  });

  it('calls stop, cancel and dismiss from their own controls', async () => {
    const seen: string[] = [];
    const view = await mount(
      <DictationSheet
        {...sheetProps({
          onStop: () => seen.push('stop'),
          onCancel: () => seen.push('cancel'),
          onDismiss: () => seen.push('dismiss'),
        })}
      />,
    );
    await interact(() => buttonLabelled(view.container, 'Stop recording and review the text').click());
    await interact(() => buttonLabelled(view.container, 'Cancel dictation').click());
    await interact(() => buttonLabelled(view.container, 'Hide dictation panel; recording continues').click());
    expect(seen).toEqual(['stop', 'cancel', 'dismiss']);
    await view.unmount();
  });

  it('hides on a local Escape without installing a document-level handler', async () => {
    let dismissed = 0;
    const view = await mount(<DictationSheet {...sheetProps({ onDismiss: () => (dismissed += 1) })} />);
    const panel = must(view.container.querySelector('[data-dictation-panel]'), 'the panel');
    await interact(() => pressKey(panel, 'Escape'));
    expect(dismissed).toBe(1);

    await interact(() => pressKey(document.body, 'Escape'));
    expect(dismissed).toBe(1);

    // Any other key inside the panel is the composer's business, not ours.
    await interact(() => pressKey(panel, 'a'));
    expect(dismissed).toBe(1);
    await view.unmount();
  });

  it('offers Record again on an empty take and Try again on a failure', async () => {
    let retried = 0;
    const view = await mount(<DictationSheet {...sheetProps({ stage: 'empty', onRetry: () => (retried += 1) })} />);
    expect(labels(view.container)).toContain('Record again');
    expect(labels(view.container)).toContain('Close dictation');
    await interact(() => buttonLabelled(view.container, 'Record again').click());
    expect(retried).toBe(1);

    await view.render(<DictationSheet {...sheetProps({ stage: 'error', errorCode: 'network' })} />);
    expect(labels(view.container)).toContain('Try again');
    expect(labels(view.container)).toContain('Cancel dictation');
    await view.unmount();
  });

  it('offers the Parakeet switch only for a browser take that heard speech but returned no words', async () => {
    let switched = 0;
    const onSwitchEngine = (): void => {
      switched += 1;
    };
    const switchButton = (container: HTMLElement): HTMLElement | undefined =>
      [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Use Parakeet')) as
        | HTMLElement
        | undefined;

    const view = await mount(
      <DictationSheet {...sheetProps({ stage: 'error', errorCode: 'bad-audio', engine: 'browser', onSwitchEngine })} />,
    );
    expect(view.container.textContent).toContain('switch to Parakeet in Settings › Voice');
    await interact(() => switchButton(view.container)?.click());
    expect(switched).toBe(1);

    await view.render(
      <DictationSheet
        {...sheetProps({ stage: 'error', errorCode: 'bad-audio', engine: 'parakeet', onSwitchEngine })}
      />,
    );
    expect(switchButton(view.container)).toBeUndefined();
    await view.render(
      <DictationSheet {...sheetProps({ stage: 'error', errorCode: 'recognition-network', onSwitchEngine })} />,
    );
    expect(switchButton(view.container)).toBeUndefined();
    await view.render(<DictationSheet {...sheetProps({ stage: 'error', errorCode: 'bad-audio' })} />);
    expect(switchButton(view.container)).toBeUndefined();
    await view.unmount();
  });

  it('turns into the review box when a take lands, with no strip and no Stop', async () => {
    const seen: string[] = [];
    const review = { id: 1, raw: 'fix the bug', cleaned: 'Fix the bug.' };
    const view = await mount(
      <DictationSheet
        {...sheetProps({
          stage: 'review',
          review,
          onInsert: text => seen.push(`insert:${text}`),
          onDiscard: () => seen.push('discard'),
        })}
      />,
    );
    expect(view.container.querySelector('[data-live-transcript]')).toBeNull();
    expect(labels(view.container)).toContain('Insert at the cursor');
    expect(labels(view.container)).not.toContain('Stop recording and review the text');
    await interact(() => buttonLabelled(view.container, 'Insert at the cursor').click());
    expect(seen).toEqual(['insert:Fix the bug.']);

    // Escape anywhere in the panel is Discard on a finished take, not Hide.
    const panel = must(view.container.querySelector('[data-dictation-panel]'), 'the panel');
    await interact(() => pressKey(panel, 'Escape'));
    expect(seen).toEqual(['insert:Fix the bug.', 'discard']);
    await view.unmount();
  });

  it('announces the stage without repeating every caption rewrite', async () => {
    const live = (container: HTMLElement): string =>
      must(container.querySelector('[aria-live="polite"]'), 'the live region').textContent ?? '';
    const view = await mount(<DictationSheet {...sheetProps()} />);
    expect(live(view.container)).toBe('Recording');

    for (const [stage, expected] of [
      ['transcribing', 'Finishing transcription in your browser'],
      ['review', 'Transcript ready'],
      ['empty', 'No speech was captured'],
      ['starting', 'Starting'],
    ] as const) {
      await view.render(<DictationSheet {...sheetProps({ stage })} />);
      expect(live(view.container)).toContain(expected);
    }

    await view.render(<DictationSheet {...sheetProps({ stage: 'error', errorMessage: 'Mic blocked.' })} />);
    expect(live(view.container)).toBe('Dictation failed: Mic blocked.');
    await view.unmount();
  });

  it('marks the caption as waiting until an engine fills it', async () => {
    const view = await mount(<DictationSheet {...sheetProps()} />);
    const marker = (): string =>
      must(view.container.querySelector('[data-live-transcript]'), 'the caption').getAttribute(
        'data-live-transcript',
      ) ?? '';
    expect(marker()).toBe('waiting');
    await view.render(<DictationSheet {...sheetProps({ liveText: 'a sentence' })} />);
    expect(marker()).toBe('preview');
    await view.unmount();
  });

  it('tints the left edge per stage', async () => {
    const edge = (container: HTMLElement): string =>
      must(container.querySelector('[data-dictation-panel]'), 'the panel').className;
    const view = await mount(<DictationSheet {...sheetProps()} />);
    expect(edge(view.container)).toContain('border-l-err');
    await view.render(<DictationSheet {...sheetProps({ stage: 'transcribing' })} />);
    expect(edge(view.container)).toContain('border-l-accent');
    await view.render(
      <DictationSheet {...sheetProps({ stage: 'review', review: { id: 1, raw: 'a', cleaned: 'a' } })} />,
    );
    expect(edge(view.container)).toContain('border-l-accent');
    await view.render(<DictationSheet {...sheetProps({ stage: 'error' })} />);
    expect(edge(view.container)).toContain('border-l-warn');
    await view.unmount();
  });

  it('mounts the input meter only while the microphone is open', async () => {
    const monitor: CaptureMonitor = { createAnalyser: () => null };
    const runtime = () => null;
    const view = await mount(<DictationSheet {...sheetProps({ inputMonitor: monitor, waveformRuntime: runtime })} />);
    expect(view.container.querySelector('canvas')).not.toBeNull();

    await view.render(
      <DictationSheet {...sheetProps({ stage: 'transcribing', inputMonitor: monitor, waveformRuntime: runtime })} />,
    );
    expect(view.container.querySelector('canvas')).toBeNull();

    // Recording with no monitor yet: the strip alone, never an empty meter box.
    await view.render(<DictationSheet {...sheetProps()} />);
    expect(view.container.querySelector('canvas')).toBeNull();
    await view.unmount();
  });

  it('lets the meter fall back to the browser runtime when the host supplies none', async () => {
    const view = await mount(<DictationSheet {...sheetProps({ inputMonitor: { createAnalyser: () => null } })} />);
    expect(view.container.querySelector('canvas')).not.toBeNull();
    await view.unmount();
  });

  it('states both audio boundaries, in the panel description', async () => {
    const view = await mount(<DictationSheet {...sheetProps()} />);
    const panel = must(view.container.querySelector('[data-dictation-panel]'), 'the panel');
    const describedBy = must(panel.getAttribute('aria-describedby'), 'a description id');
    const description = must(view.container.querySelector(`#${CSS.escape(describedBy)}`), 'the description');
    // What Ferretry promises, and the browser-vendor service it cannot promise for.
    expect(description.textContent).toContain('never sends microphone audio to your daemon');
    expect(description.textContent).toContain('sends it to its vendor’s servers');
    expect(description.textContent).toContain('never sent automatically');
    expect(description.textContent).toContain('Nothing reaches your draft until you press Insert');

    await view.render(<DictationSheet {...sheetProps({ engine: 'parakeet', stage: 'transcribing' })} />);
    expect(view.container.textContent).toContain('audio never leaves it');
    expect(view.container.textContent).toContain('Transcribing on this device; you will review it');
    expect(view.container.textContent).not.toContain('vendor');
    await view.unmount();
  });

  it('says a finished take goes straight into the draft, when that is the reader’s setting', async () => {
    const view = await mount(<DictationSheet {...sheetProps({ insertsDirectly: true })} />);
    const panel = must(view.container.querySelector('[data-dictation-panel]'), 'the panel');
    const describedBy = must(panel.getAttribute('aria-describedby'), 'a description id');
    const description = must(view.container.querySelector(`#${CSS.escape(describedBy)}`), 'the description');

    expect(description.textContent).toContain('A finished take goes into your draft at the caret');
    expect(description.textContent).toContain('never sent automatically');
    expect(description.textContent).not.toContain('until you press Insert');
    await view.unmount();
  });
});

/** The stage union is exhaustive: every member must render without throwing. */
describe('every stage renders', () => {
  const stages: readonly DictationStage[] = ['starting', 'recording', 'transcribing', 'review', 'empty', 'error'];
  it('covers the whole union', async () => {
    for (const stage of stages) {
      const view = await mount(
        <DictationSheet {...sheetProps({ stage, review: { id: 1, raw: 'hello', cleaned: 'Hello.' } })} />,
      );
      expect(view.container.querySelector('[data-dictation-panel]')).not.toBeNull();
      await view.unmount();
    }
  });
});

describe('Parakeet near-live words in the strip', () => {
  const failure = { title: 'Dictation failed' };

  it('splits the caption into settled words and the greyed provisional tail', () => {
    expect(splitLiveCaption(' the quick brow ', 'brow')).toEqual({ settled: 'the quick', interim: 'brow' });
    expect(splitLiveCaption('brow', 'brow')).toEqual({ settled: '', interim: 'brow' });
    expect(splitLiveCaption('the quick', '')).toEqual({ settled: 'the quick', interim: '' });
    // A tail that is not a suffix is not trusted: the whole line reads as settled.
    expect(splitLiveCaption('the quick', 'fox')).toEqual({ settled: 'the quick', interim: '' });
  });

  it('names the pause in the strip’s full text only for Parakeet', () => {
    expect(dictationStripStatus('recording', 'the quick', undefined, failure, 'parakeet', true)).toBe(
      'the quick · live words paused — device too slow',
    );
    expect(dictationStripStatus('recording', '', undefined, failure, 'parakeet', true)).toContain(
      'audio never leaves it',
    );
    expect(dictationStripStatus('recording', 'hello', undefined, failure, 'browser', true)).toBe('hello');
  });

  it('keeps the words in view while Parakeet finishes the tail', () => {
    expect(dictationStripStatus('transcribing', 'the quick', undefined, failure, 'parakeet')).toBe(
      'Finishing on this device and correcting once… Last heard: the quick',
    );
  });

  it('renders committed words, then the greyed interim tail, and the pause on a row of its own', async () => {
    const view = await mount(
      <DictationSheet
        {...sheetProps({ engine: 'parakeet', liveText: 'the quick brow', liveInterim: 'brow', livePaused: true })}
      />,
    );
    const part = (name: string): HTMLElement =>
      must(view.container.querySelector(`[data-live-words="${name}"]`), name) as HTMLElement;
    expect(part('committed').textContent).toBe('the quick');
    expect(part('interim').textContent).toBe('brow');
    expect(part('interim').className).toContain('text-muted');
    expect(part('paused').textContent).toBe(
      'Live words paused — device too slow. Stop still transcribes everything you said.',
    );
    expect(part('paused').getAttribute('role')).toBe('status');
    const caption = must(view.container.querySelector('[data-live-transcript]'), 'the caption');
    expect(caption.textContent).toBe('the quick brow');
    expect(caption.getAttribute('title')).toBe('the quick brow · live words paused — device too slow');
    await view.unmount();
  });

  it('renders only what there is: interim alone, committed alone, and no pause notice for browser voice', async () => {
    const view = await mount(
      <DictationSheet {...sheetProps({ engine: 'parakeet', liveText: 'brow', liveInterim: 'brow' })} />,
    );
    expect(view.container.querySelector('[data-live-words="committed"]')).toBeNull();
    expect(view.container.querySelector('[data-live-words="interim"]')?.textContent).toBe('brow');
    expect(view.container.querySelector('[data-live-words="paused"]')).toBeNull();
    await view.render(<DictationSheet {...sheetProps({ liveText: 'hello there', livePaused: true })} />);
    expect(view.container.querySelector('[data-live-words="committed"]')?.textContent).toBe('hello there');
    expect(view.container.querySelector('[data-live-words="interim"]')).toBeNull();
    expect(view.container.querySelector('[data-live-words="paused"]')).toBeNull();
    // Outside recording the caption is the status line again, and the pause row goes with it.
    await view.render(
      <DictationSheet
        {...sheetProps({ stage: 'transcribing', engine: 'parakeet', liveText: 'the quick', livePaused: true })}
      />,
    );
    expect(view.container.querySelector('[data-live-words]')).toBeNull();
    await view.unmount();
  });
});
