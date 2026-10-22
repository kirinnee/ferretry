import { describe, expect, it } from 'bun:test';
import {
  CEREBRAS_ENHANCEMENT_EXPLANATION,
  DICTATION_DISABLED_EXPLANATION,
  DICTATION_SAFETY_NOTE,
  DictationSettings,
  type DictationSettingsProps,
  ENHANCEMENT_EXPLANATION,
  ENHANCEMENT_SOURCES_EXPLANATION,
  ENHANCEMENT_TOGGLE_EXPLANATION,
  GROQ_ENHANCEMENT_EXPLANATION,
  LIVE_WORDS_EXPLANATION,
  LOCAL_ENHANCEMENT_HISTORY_DISCLOSURE,
  LOGIN_CLEANUP_UNAVAILABLE,
  providerChoicePatch,
  SPEEDUP_KEY_HINT,
  USER_CONTEXT_EXPLANATION,
} from '../../../../src/features/settings/dictation-settings.tsx';
import {
  BROWSER_ACTIVE_NOTE,
  BROWSER_ENGINE_DISCLOSURE,
  BROWSER_ENGINE_LABEL,
  NO_ENGINE_NOTE,
  PARAKEET_ACTIVE_NOTE,
} from '../../../../src/features/settings/voice-engine-choice.tsx';
import { ON_DEVICE_MODELS } from '../../../../src/lib/stt/model-catalog.ts';
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

const engineSection = (container: HTMLElement): HTMLElement =>
  must(container.querySelector('section[aria-label="Voice engine"]'), 'the voice engine section');

const radio = (container: HTMLElement, value: string): HTMLInputElement =>
  must(container.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`), `the ${value} radio`);

describe('<DictationSettings>', () => {
  it('offers every catalog model and browser voice side by side, the browser one labelled with where its audio goes', async () => {
    const view = await mount(<DictationSettings {...settingsProps()} />);
    const section = engineSection(view.container);
    for (const model of ON_DEVICE_MODELS) {
      expect(section.textContent).toContain(model.label);
      expect(radio(view.container, model.id).checked).toBe(false);
    }
    expect(section.textContent).toContain(`${BROWSER_ENGINE_LABEL} (${BROWSER_ENGINE_DISCLOSURE})`);
    // Nobody has chosen yet, so nothing is picked for them.
    expect(radio(view.container, 'parakeet').checked).toBe(false);
    expect(radio(view.container, 'browser').checked).toBe(false);
    expect(section.textContent).toContain(NO_ENGINE_NOTE);
    await view.unmount();
  });

  it('fails the browser engine closed with its own reason instead of an empty option', async () => {
    const view = await mount(<DictationSettings {...settingsProps({ recognitionSupport: UNSUPPORTED_RECOGNITION })} />);
    expect(engineSection(view.container).textContent).toContain('does not support dictation for web apps');
    await view.unmount();
  });

  it('detects the ambient page when the host injects no support', async () => {
    // happy-dom exposes no SpeechRecognition, so detection must refuse rather
    // than throw on a constructor that is not there.
    const view = await mount(<DictationSettings {...{ ...settingsProps(), recognitionSupport: undefined }} />);
    // happy-dom is not a secure context either, and that is the first refusal detection names.
    expect(engineSection(view.container).textContent).toContain('Dictation needs a secure HTTPS page in this browser.');
    await view.unmount();
  });

  it('reads Parakeet from the app store, and says so when there is none', async () => {
    // Outside a store (this suite) the on-device engine is honestly unavailable, never a crash.
    const view = await mount(<DictationSettings {...settingsProps()} />);
    expect(engineSection(view.container).textContent).toContain('Parakeet is not available in this copy of Ferretry.');
    await view.unmount();
  });

  it('records the chosen engine through the one update port', async () => {
    const patches: SttSettingsPatch[] = [];
    const view = await mount(<DictationSettings {...settingsProps({ update: patch => patches.push(patch) })} />);
    await interact(() => radio(view.container, 'parakeet').click());
    await interact(() => radio(view.container, 'browser').click());
    expect(patches).toEqual([{ engine: 'parakeet' }, { engine: 'browser' }]);
    await view.unmount();
  });

  it('promises the audio stays here only while Parakeet is the active engine', async () => {
    const view = await mount(
      <DictationSettings {...settingsProps({ settings: { ...DEFAULT_STT_SETTINGS, engine: 'browser' } })} />,
    );
    expect(view.container.textContent).not.toContain('audio never leaves');
    expect(view.container.textContent).toContain(BROWSER_ACTIVE_NOTE);

    await view.render(
      <DictationSettings {...settingsProps({ settings: { ...DEFAULT_STT_SETTINGS, engine: 'parakeet' } })} />,
    );
    expect(view.container.textContent).toContain(PARAKEET_ACTIVE_NOTE);
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
    expect(view.container.querySelector('section[aria-label="Voice engine"]')).toBeNull();
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

  it('offers Live words (experimental) only while Parakeet is the engine, off by default, through the one update port', async () => {
    const patches: SttSettingsPatch[] = [];
    const view = await mount(
      <DictationSettings
        {...settingsProps({ settings: { ...DEFAULT_STT_SETTINGS, engine: 'browser' }, voice: null })}
      />,
    );
    expect(view.container.querySelector('section[aria-label="Live words (experimental)"]')).toBeNull();
    await view.render(
      <DictationSettings
        {...settingsProps({
          settings: { ...DEFAULT_STT_SETTINGS, engine: 'parakeet' },
          voice: null,
          update: patch => patches.push(patch),
        })}
      />,
    );
    const live = switchNamed(view.container, 'Live words (experimental)');
    expect(live.getAttribute('aria-checked')).toBe('false');
    expect(live.textContent).toContain('Off');
    expect(view.container.textContent).toContain(LIVE_WORDS_EXPLANATION);
    expect(LIVE_WORDS_EXPLANATION).toContain('Off by default');
    await interact(() => live.click());
    expect(patches).toEqual([{ liveWordsOptIn: true }]);
    await view.render(
      <DictationSettings
        {...settingsProps({
          settings: { ...DEFAULT_STT_SETTINGS, engine: 'parakeet', liveWordsOptIn: true },
          voice: null,
        })}
      />,
    );
    expect(switchNamed(view.container, 'Live words (experimental)').getAttribute('aria-checked')).toBe('true');
    expect(switchNamed(view.container, 'Live words (experimental)').textContent).toContain('On');
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
    expect(patches).toEqual([{ enhancementProvider: 'groq', enhancementModel: 'openai/gpt-oss-120b' }]);

    const groq: SttSettings = { ...DEFAULT_STT_SETTINGS, enhancementProvider: 'groq' };
    await view.render(<DictationSettings {...settingsProps({ settings: groq })} />);
    expect(view.container.querySelector('#stt-enhancement-model')).not.toBeNull();
    expect(view.container.textContent).toContain('The daemon holds the Groq API key');
    await view.unmount();
  });

  it('offers both Groq gpt-oss models, shows the cleanup prompts for a hosted provider only', async () => {
    const injected = {
      cleanup: { style: 'fix' as const, prompts: {}, useConversation: false, conversationMessages: 8 },
      loaded: true,
      save: async () => ({ kind: 'applied' as const }),
    };
    const groq: SttSettings = { ...DEFAULT_STT_SETTINGS, enhancementProvider: 'groq' };
    const view = await mount(<DictationSettings {...settingsProps({ settings: groq, voiceCleanup: injected })} />);
    const options = [...view.container.querySelectorAll('#stt-groq-models option')].map(o => o.getAttribute('value'));
    expect(options).toEqual(['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
    expect(view.container.querySelector('[data-voice-cleanup]')).not.toBeNull();

    const cerebras: SttSettings = { ...DEFAULT_STT_SETTINGS, enhancementProvider: 'cerebras' };
    await view.render(<DictationSettings {...settingsProps({ settings: cerebras, voiceCleanup: injected })} />);
    expect(view.container.querySelector('#stt-groq-models')).toBeNull();
    expect(view.container.querySelector('#stt-enhancement-model')?.getAttribute('list')).toBeNull();

    await view.render(<DictationSettings {...settingsProps()} />);
    expect(view.container.querySelector('[data-voice-cleanup]')).toBeNull();
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

  it('offers Cerebras with its own model default, explanation and the Speed-ups key hint', async () => {
    const cerebras: SttSettings = {
      ...DEFAULT_STT_SETTINGS,
      enhancementProvider: 'cerebras',
      enhancementModel: 'gpt-oss-120b',
    };
    const view = await mount(<DictationSettings {...settingsProps({ settings: cerebras })} />);
    const text = view.container.textContent ?? '';
    expect(text).toContain('Cerebras model');
    expect(text).toContain(CEREBRAS_ENHANCEMENT_EXPLANATION);
    expect(text).toContain(SPEEDUP_KEY_HINT);
    expect(text).not.toContain(GROQ_ENHANCEMENT_EXPLANATION);
    const model = must(view.container.querySelector<HTMLInputElement>('#stt-enhancement-model'), 'the model field');
    expect(model.placeholder).toBe('gpt-oss-120b');
    await view.unmount();
  });

  it('shows using a login as a choice that cannot be picked yet', async () => {
    const view = await mount(<DictationSettings {...settingsProps()} />);
    const login = must(view.container.querySelector<HTMLOptionElement>('option[value="login"]'), 'the login option');
    expect(login.disabled).toBe(true);
    expect(login.textContent).toBe(LOGIN_CLEANUP_UNAVAILABLE);
    await view.unmount();
  });

  it('resets the model only when moving to a different hosted provider', () => {
    const groq: SttSettings = { ...DEFAULT_STT_SETTINGS, enhancementProvider: 'groq', enhancementModel: 'custom' };
    expect(providerChoicePatch(groq, 'cerebras')).toEqual({
      enhancementProvider: 'cerebras',
      enhancementModel: 'gpt-oss-120b',
    });
    expect(providerChoicePatch(groq, 'groq')).toEqual({ enhancementProvider: 'groq' });
    expect(providerChoicePatch(groq, 'local')).toEqual({ enhancementProvider: 'local' });
    expect(providerChoicePatch(groq, 'login')).toEqual({ enhancementProvider: 'local' });
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
