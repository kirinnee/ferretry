import { describe, expect, it } from 'bun:test';
import {
  BROWSER_MODE_SUMMARY,
  BROWSER_SERVICE_DISCLOSURE,
  DICTATION_DISABLED_EXPLANATION,
  DICTATION_SAFETY_NOTE,
  DictationSettings,
  type DictationSettingsProps,
  ENHANCEMENT_EXPLANATION,
  ENHANCEMENT_SOURCES_EXPLANATION,
  ENHANCEMENT_TOGGLE_EXPLANATION,
  GROQ_ENHANCEMENT_EXPLANATION,
  LOCAL_ENHANCEMENT_HISTORY_DISCLOSURE,
  USER_CONTEXT_EXPLANATION,
} from '../../../../src/features/settings/dictation-settings.tsx';
import type { BrowserRecognitionSupport } from '../../../../src/lib/stt/browser-recognition.ts';
import { DEFAULT_STT_SETTINGS, type SttSettings, type SttSettingsPatch } from '../../../../src/lib/stt/stt-settings.ts';
import { AVAILABLE_RECOGNITION, UNSUPPORTED_RECOGNITION } from '../../../support/browser-recognition.ts';
import { interact, mount, must } from '../../../support/dom.ts';

const settingsProps = (overrides: Partial<DictationSettingsProps> = {}): DictationSettingsProps => ({
  settings: DEFAULT_STT_SETTINGS,
  update: () => undefined,
  persisted: true,
  recognitionSupport: AVAILABLE_RECOGNITION,
  ...overrides,
});

/**
 * React tracks the last value it wrote on the DOM node itself, so assigning
 * `.value` directly is invisible to it. Writing through the prototype setter is
 * what a real keystroke does and is what makes `onChange` fire.
 */
const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
const areaValueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;

const type = async (element: HTMLInputElement | HTMLTextAreaElement, text: string): Promise<void> => {
  await interact(() => {
    const setter = element instanceof HTMLTextAreaElement ? areaValueSetter : inputValueSetter;
    setter?.call(element, text);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const switchNamed = (container: HTMLElement, label: string): HTMLButtonElement =>
  must(
    [...container.querySelectorAll<HTMLButtonElement>('button[role="switch"]')].find(button =>
      (button.textContent ?? '').includes(label),
    ) ?? null,
    `the ${label} switch`,
  );

const availability = (container: HTMLElement): HTMLElement =>
  must(container.querySelector('section[aria-label="Browser dictation availability"]'), 'the availability section');

describe('<DictationSettings>', () => {
  it('reports the browser capability it actually detected', async () => {
    const view = await mount(<DictationSettings {...settingsProps()} />);
    const section = availability(view.container);
    expect(section.textContent).toContain('Available in this browser');
    expect(section.textContent).toContain('standard speech recognition is exposed on this page');
    await view.unmount();
  });

  it('names the prefixed WebKit implementation rather than calling it standard', async () => {
    const webkit: BrowserRecognitionSupport = {
      available: true,
      availability: 'available',
      implementation: 'webkit',
    };
    const view = await mount(<DictationSettings {...settingsProps({ recognitionSupport: webkit })} />);
    expect(availability(view.container).textContent).toContain('WebKit speech recognition');
    await view.unmount();
  });

  it('fails closed with the browser-specific reason instead of an empty panel', async () => {
    const view = await mount(<DictationSettings {...settingsProps({ recognitionSupport: UNSUPPORTED_RECOGNITION })} />);
    const section = availability(view.container);
    expect(section.textContent).toContain('Unavailable in this browser');
    expect(section.textContent).toContain('does not support dictation for web apps');
    await view.unmount();
  });

  it('carries the installed-iOS refusal verbatim, with its way out', async () => {
    const homeScreen: BrowserRecognitionSupport = {
      available: false,
      availability: 'ios-home-screen',
      implementation: 'webkit',
      reason: 'Dictation is unavailable in an iPhone Home Screen app. Open Ferretry in Safari to dictate.',
    };
    const view = await mount(<DictationSettings {...settingsProps({ recognitionSupport: homeScreen })} />);
    expect(availability(view.container).textContent).toContain('Open Ferretry in Safari');
    await view.unmount();
  });

  it('detects the ambient page when the host injects no support', async () => {
    // happy-dom exposes no SpeechRecognition, so detection must refuse rather
    // than throw on a constructor that is not there.
    const view = await mount(<DictationSettings {...{ ...settingsProps(), recognitionSupport: undefined }} />);
    expect(availability(view.container).textContent).toContain('Unavailable in this browser');
    await view.unmount();
  });

  it('states both audio boundaries, and names no daemon transcription', async () => {
    const view = await mount(<DictationSettings {...settingsProps()} />);
    expect(view.container.textContent).toContain(BROWSER_MODE_SUMMARY);
    expect(view.container.textContent).toContain(BROWSER_SERVICE_DISCLOSURE);
    // The retired per-device download and daemon model install must be gone,
    // not merely unreachable.
    expect(view.container.textContent).not.toContain('Prepare this device');
    expect(view.container.textContent).not.toContain('speech model');
    expect(view.container.textContent).not.toContain('Download');
    await view.unmount();
  });

  /**
   * kteam's suite asserted that every mandatory disclosure was rendered, because
   * a disclosure that exists only as a constant protects nobody. The set is
   * different again now that recognition is the browser's own, but the rule is
   * the same, so each one is checked against the real render.
   */
  it('renders every disclosure it declares, with none left as an unused constant', async () => {
    const view = await mount(<DictationSettings {...settingsProps()} />);
    for (const copy of [
      DICTATION_SAFETY_NOTE,
      BROWSER_MODE_SUMMARY,
      BROWSER_SERVICE_DISCLOSURE,
      DICTATION_DISABLED_EXPLANATION,
      ENHANCEMENT_TOGGLE_EXPLANATION,
      ENHANCEMENT_EXPLANATION,
      ENHANCEMENT_SOURCES_EXPLANATION,
      LOCAL_ENHANCEMENT_HISTORY_DISCLOSURE,
      USER_CONTEXT_EXPLANATION,
    ]) {
      expect(view.container.textContent).toContain(copy);
    }
    expect(view.container.textContent).not.toContain(GROQ_ENHANCEMENT_EXPLANATION);

    await view.render(
      <DictationSettings {...settingsProps({ settings: { ...DEFAULT_STT_SETTINGS, enhancementProvider: 'groq' } })} />,
    );
    expect(view.container.textContent).toContain(GROQ_ENHANCEMENT_EXPLANATION);
    await view.unmount();
  });

  /**
   * The on-device provider used to promise "nothing sent anywhere", while every
   * enabled correction first reads the session's recent messages from the paired
   * daemon. The screen has to name what stays here AND that request, because a
   * disclosure that overstates the boundary is the same defect as none at all.
   */
  it('discloses the history read instead of promising the local provider sends nothing', async () => {
    const view = await mount(<DictationSettings {...settingsProps()} />);
    const text = view.container.textContent ?? '';

    expect(text).not.toContain('nothing sent anywhere');
    // What genuinely stays in this browser, named as the narrower claim it is.
    expect(text).toContain('no AI model, and your transcript, your words and your context are never uploaded');
    // And the one request that does leave, with its budget and its contents.
    expect(text).toContain('One request does leave this browser first');
    expect(text).toContain('asks the paired daemon holding this session for its latest messages');
    expect(text).toContain('corrects without them if the daemon is slow');
    expect(text).toContain('Nothing you dictated is part of that request');

    // Groq's own paragraph already accounts for the transcript leaving, so the
    // local-only disclosure is not repeated there.
    await view.render(
      <DictationSettings {...settingsProps({ settings: { ...DEFAULT_STT_SETTINGS, enhancementProvider: 'groq' } })} />,
    );
    expect(view.container.textContent).not.toContain(LOCAL_ENHANCEMENT_HISTORY_DISCLOSURE);
    expect(view.container.textContent).toContain('sends Groq the raw transcript');
    await view.unmount();
  });

  it('hides everything but the switch while dictation is off', async () => {
    const view = await mount(
      <DictationSettings {...settingsProps({ settings: { ...DEFAULT_STT_SETTINGS, enabled: false } })} />,
    );
    expect(view.container.textContent).toContain('Dictation is disabled.');
    expect(view.container.querySelector('section[aria-label="Browser dictation availability"]')).toBeNull();
    expect(view.container.querySelector('#stt-dictionary')).toBeNull();
    await view.unmount();
  });

  it('toggles the master switch and the enhancer through one update port', async () => {
    const patches: SttSettingsPatch[] = [];
    const view = await mount(<DictationSettings {...settingsProps({ update: patch => patches.push(patch) })} />);
    await interact(() => switchNamed(view.container, 'Dictation').click());
    await interact(() => switchNamed(view.container, 'Fix names and jargon').click());
    expect(patches).toEqual([{ enabled: false }, { enhancement: false }]);
    await view.unmount();
  });

  it('hides the provider choice entirely when correction is switched off', async () => {
    const view = await mount(
      <DictationSettings {...settingsProps({ settings: { ...DEFAULT_STT_SETTINGS, enhancement: false } })} />,
    );
    expect(switchNamed(view.container, 'Fix names and jargon').textContent).toContain('Off');
    expect(view.container.querySelector('#stt-enhancement-provider')).toBeNull();
    // The dictionary is still editable: it is what an enhancer would use later.
    expect(view.container.querySelector('#stt-dictionary')).not.toBeNull();
    await view.unmount();
  });

  it('swaps the correction explanations when the provider changes', async () => {
    const patches: SttSettingsPatch[] = [];
    const view = await mount(<DictationSettings {...settingsProps({ update: patch => patches.push(patch) })} />);
    expect(view.container.textContent).toContain('WORDS ONLY.');
    expect(view.container.querySelector('#stt-enhancement-model')).toBeNull();

    const select = must(view.container.querySelector<HTMLSelectElement>('#stt-enhancement-provider'), 'the provider');
    await interact(() => {
      select.value = 'groq';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(patches).toEqual([{ enhancementProvider: 'groq' }]);

    const groq: SttSettings = { ...DEFAULT_STT_SETTINGS, enhancementProvider: 'groq' };
    await view.render(<DictationSettings {...settingsProps({ settings: groq })} />);
    expect(view.container.querySelector('#stt-enhancement-model')).not.toBeNull();
    expect(view.container.textContent).toContain('The daemon holds the Groq API key');
    await view.unmount();
  });

  it('returns to the local enhancer from the same select', async () => {
    const patches: SttSettingsPatch[] = [];
    const groq: SttSettings = { ...DEFAULT_STT_SETTINGS, enhancementProvider: 'groq' };
    const view = await mount(
      <DictationSettings {...settingsProps({ settings: groq, update: patch => patches.push(patch) })} />,
    );
    const select = must(view.container.querySelector<HTMLSelectElement>('#stt-enhancement-provider'), 'the provider');
    await interact(() => {
      select.value = 'local';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(patches).toEqual([{ enhancementProvider: 'local' }]);
    await view.unmount();
  });

  it('edits the Groq model name', async () => {
    const patches: SttSettingsPatch[] = [];
    const groq: SttSettings = { ...DEFAULT_STT_SETTINGS, enhancementProvider: 'groq' };
    const view = await mount(
      <DictationSettings {...settingsProps({ settings: groq, update: patch => patches.push(patch) })} />,
    );
    const input = must(view.container.querySelector<HTMLInputElement>('#stt-enhancement-model'), 'the model field');
    await type(input, 'llama-3.3-70b');
    expect(patches).toEqual([{ enhancementModel: 'llama-3.3-70b' }]);
    await view.unmount();
  });

  it('counts the reader-s terms and names every problem with a line', async () => {
    const withDictionary: SttSettings = {
      ...DEFAULT_STT_SETTINGS,
      dictionary: ['ferretry = ferretree', 'two words here'],
    };
    const patches: SttSettingsPatch[] = [];
    const view = await mount(
      <DictationSettings {...settingsProps({ settings: withDictionary, update: patch => patches.push(patch) })} />,
    );
    expect(view.container.textContent).toContain('1 term.');
    expect(view.container.querySelectorAll('ul li').length).toBeGreaterThan(0);

    const area = must(view.container.querySelector<HTMLTextAreaElement>('#stt-dictionary'), 'the dictionary');
    await type(area, 'one\ntwo');
    expect(patches).toEqual([{ dictionary: ['one', 'two'] }]);
    await view.unmount();
  });

  it('echoes back the words a pasted context actually yields', async () => {
    const patches: SttSettingsPatch[] = [];
    const view = await mount(
      <DictationSettings
        {...settingsProps({
          settings: { ...DEFAULT_STT_SETTINGS, userContext: 'We ship ferretry with nitroso and diene.' },
          update: patch => patches.push(patch),
        })}
      />,
    );
    expect(view.container.textContent).toMatch(/\d+ words? picked out/);
    expect(view.container.textContent).toContain('ferretry');

    const area = must(view.container.querySelector<HTMLTextAreaElement>('#stt-user-context'), 'the context field');
    await type(area, 'plain english only');
    expect(patches).toEqual([{ userContext: 'plain english only' }]);

    await view.render(
      <DictationSettings {...settingsProps({ settings: { ...DEFAULT_STT_SETTINGS, userContext: 'the and of' } })} />,
    );
    expect(view.container.textContent).toContain('0 words picked out');
    await view.unmount();
  });

  it('saves the reader-s chosen push-to-talk chord', async () => {
    const view = await mount(<DictationSettings {...settingsProps()} />);
    expect(view.container.textContent).toContain('Push to talk');
    await view.unmount();
  });

  it('says plainly when this browser refused to store the choices', async () => {
    const view = await mount(<DictationSettings {...settingsProps({ persisted: false })} />);
    expect(view.container.textContent).toContain('could not be saved');
    await view.unmount();
  });
});
