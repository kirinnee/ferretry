import { describe, expect, it } from 'bun:test';
import {
  DictationSheet,
  type DictationSheetProps,
  type DictationStage,
  dictationFailureCopy,
  dictationStage,
  dictationStripStatus,
  formatElapsed,
} from '../../src/components/dictation-sheet.tsx';
import type { CaptureMonitor } from '../../src/components/input-waveform.tsx';
import { interact, mount, must, pressKey } from '../support/dom.ts';

const noop = (): void => undefined;

const sheetProps = (overrides: Partial<DictationSheetProps> = {}): DictationSheetProps => ({
  open: true,
  stage: 'recording',
  elapsedMs: 0,
  onDismiss: noop,
  onStop: noop,
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
  it('says the raw words were kept for any enhancement failure', () => {
    const copy = dictationFailureCopy('enhancement-rate-limit');
    expect(copy.title).toBe('Raw dictation kept');
    expect(copy.hint).toContain('already added to your draft');
  });

  it('names each microphone refusal', () => {
    expect(dictationFailureCopy('permission-denied').title).toBe('Microphone blocked');
    expect(dictationFailureCopy('no-microphone').title).toBe('No microphone found');
    expect(dictationFailureCopy('audio-unavailable').title).toBe('Microphone busy');
    expect(dictationFailureCopy('no-media-devices').hint).toContain('secure (https)');
    expect(dictationFailureCopy('capture-failed').title).toBe('Recording could not start');
  });

  it('names each browser refusal without inventing a daemon to blame', () => {
    expect(dictationFailureCopy('recognition-unavailable').title).toBe('Dictation unavailable here');
    expect(dictationFailureCopy('recognition-network').title).toContain('Browser speech service');
    expect(dictationFailureCopy('recognition-failed').title).toBe('Browser recognition failed');
    expect(dictationFailureCopy('too-long').title).toBe('Recording too long');
    expect(dictationFailureCopy('bad-audio').title).toBe("Didn't catch that");
    // The retired daemon vocabulary must not survive as unreachable copy.
    for (const retired of ['unauthorized', 'unavailable', 'busy', 'network']) {
      expect(dictationFailureCopy(retired).title).toBe('Dictation failed');
    }
  });

  it('falls back to a plain headline for an unknown or absent code', () => {
    expect(dictationFailureCopy(undefined).title).toBe('Dictation failed');
    expect(dictationFailureCopy('something-new').title).toBe('Dictation failed');
  });
});

describe('dictationStripStatus', () => {
  const failure = { title: 'Dictation failed', hint: 'Try again.' };

  it('offers the standing hint while recording with nothing heard yet', () => {
    const status = dictationStripStatus('recording', '', undefined, failure);
    expect(status).toContain('press Stop');
    expect(status).toContain('only updates your draft');
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
      'Stop recording and add text to your draft',
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
    await interact(() => buttonLabelled(view.container, 'Stop recording and add text to your draft').click());
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

  it('offers no retry after an enhancement failure, because the words already landed', async () => {
    const view = await mount(
      <DictationSheet
        {...sheetProps({ stage: 'error', errorCode: 'enhancement-timeout', errorMessage: 'Groq timed out.' })}
      />,
    );
    expect(labels(view.container)).toEqual(['Close dictation', 'Hide dictation panel; recording continues']);
    expect(view.container.textContent).toContain('Groq timed out.');
    expect(view.container.textContent).toContain('raw dictation was added');
    await view.unmount();
  });

  it('announces the stage without repeating every caption rewrite', async () => {
    const live = (container: HTMLElement): string =>
      must(container.querySelector('[aria-live="polite"]'), 'the live region').textContent ?? '';
    const view = await mount(<DictationSheet {...sheetProps()} />);
    expect(live(view.container)).toBe('Recording');

    for (const [stage, expected] of [
      ['transcribing', 'Finishing transcription in your browser'],
      ['empty', 'No speech was captured'],
      ['starting', 'Starting'],
    ] as const) {
      await view.render(<DictationSheet {...sheetProps({ stage })} />);
      expect(live(view.container)).toContain(expected);
    }

    await view.render(<DictationSheet {...sheetProps({ stage: 'error', errorMessage: 'Mic blocked.' })} />);
    expect(live(view.container)).toBe('Dictation failed: Mic blocked.');

    await view.render(<DictationSheet {...sheetProps({ stage: 'error', errorCode: 'enhancement-provider' })} />);
    expect(live(view.container)).toContain('Enhancement failed; raw dictation was added');
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
    expect(description.textContent).toContain('own online speech service');
    expect(description.textContent).toContain('never sent automatically');
    await view.unmount();
  });
});

/** The stage union is exhaustive: every member must render without throwing. */
describe('every stage renders', () => {
  const stages: readonly DictationStage[] = ['starting', 'recording', 'transcribing', 'empty', 'error'];
  it('covers the whole union', async () => {
    for (const stage of stages) {
      const view = await mount(<DictationSheet {...sheetProps({ stage })} />);
      expect(view.container.querySelector('[data-dictation-panel]')).not.toBeNull();
      await view.unmount();
    }
  });
});
