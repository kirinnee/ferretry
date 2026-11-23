/**
 * Voice settings for this device: which engine dictates, Parakeet's install, and clean-up.
 *
 * NO AUTOFOCUS anywhere, per this app's touch rules: opening a settings section
 * must not raise the keyboard on a phone. Every interactive target is at least
 * 44 px.
 *
 * WHAT CHANGED FROM kteam (`ui/src/components/DictationSettings.tsx`), and WHY.
 *
 *   1. ENGINES CHOSEN PER DEVICE (`engine-section.tsx`, the O15 cards). Every on-device
 *      model in the catalog (`lib/stt/model-catalog.ts`) runs in this browser
 *      after a one-time, explicit download, pinned and hashed; phone/browser
 *      voice is the browser's own recognition. None is a fallback for another,
 *      and each can be tried before it is chosen.
 *   2. PRIVACY COPY FOLLOWS THE ACTIVE ENGINE. Ferretry never uploads microphone
 *      audio to its daemon. "Audio never leaves this device" is said only while
 *      an on-device engine is active; while browser voice is, the screen says
 *      the browser sends the audio to its vendor.
 *   3. ENHANCEMENT IS SEPARATE. Local word correction stays in this browser;
 *      optional Groq or Cerebras clean-up legitimately sends recognised TEXT
 *      through the paired daemon that owns the live session, which spends the
 *      provider key from its own secret store (Settings › This machine ›
 *      Speed-ups). Audio is never part of that: recognition stays here. Either
 *      provider first READS that session's recent messages for vocabulary, so
 *      the local copy discloses that request rather than promising silence.
 *
 * Everything else — the master switch, the push-to-talk picker, the enhancement
 * toggle and provider, the dictionary, the free-text context and its live
 * vocabulary echo — is kteam's, wording included where the wording was about the
 * enhancer rather than about where audio goes.
 */

import { type ReactNode, useMemo, useState } from 'react';
import { useMachineIsOlder } from '../../shell-voice.ts';
import { useOnDeviceVoices, useOptionalAppStore, useParakeetVoice } from '../../lib/voice-store.tsx';
import {
  type BrowserRecognitionProvider,
  type BrowserRecognitionSupport,
  browserRecognitionProvider,
} from '../../lib/stt/browser-recognition.ts';
import {
  type DeviceClass,
  type DeviceClassGlobalLike,
  deviceClassOf,
  effectiveEngine,
} from '../../lib/stt/engine-defaults.ts';
import { userContextVocabulary } from '../../lib/stt/enhancement.ts';
import { onDeviceModel } from '../../lib/stt/model-catalog.ts';
import type { OnDeviceVoices } from '../../lib/stt/on-device-voices.ts';
import type { ParakeetVoice } from '../../lib/stt/parakeet-voice.ts';
import type { SpeedPlanner } from '../../lib/stt/speed-planner.ts';
import {
  AFTER_DICTATION_OPTIONS,
  DEFAULT_ENHANCEMENT_MODELS,
  DEFAULT_GROQ_ENHANCEMENT_MODEL,
  ENHANCEMENT_PROVIDERS,
  type EnhancementProviderId,
  GROQ_FASTER_ENHANCEMENT_MODEL,
  isRemoteEnhancementProvider,
  MAX_ENHANCEMENT_MODEL_CHARS,
  MAX_USER_CONTEXT_CHARS,
  type SttSettings,
  type SttSettingsPatch,
  sttDictionary,
} from '../../lib/stt/stt-settings.ts';
import { useMachineVoiceEngine } from '../fleet/setup/voice-default.ts';
import {
  ChoiceCards,
  type DaemonConnection,
  SelectBox,
  SettingGroup,
  SettingRow,
  SettingSwitch,
  Textarea,
} from '../../shell-voice.ts';
import { AutoReadSettings } from './auto-read-settings.tsx';
import { DictationShortcutPicker } from './dictation-shortcut-picker.tsx';
import { EngineSection, type TrialClock } from './engine-section.tsx';
import { SpeedLine } from './speed-line.tsx';
import './voice-settings.css';

export const DICTATION_SAFETY_NOTE =
  'Ferretry never sends microphone audio to your daemon. Stop settles the browser transcript, corrects it once, and inserts it at your current caret. Nothing is ever sent for you.';

/** Under "After dictating": the choice is this browser's, and either way nothing is sent for the person. */
export const AFTER_DICTATION_EXPLANATION =
  'Push-to-talk follows this too. With “Insert straight away” the text lands at your caret as soon as it is ready and an Undo note appears; if clean-up fails or nothing was heard, the panel stays open with the reason instead.';

export const DICTATION_DISABLED_EXPLANATION =
  'Off means off: the microphone cannot open for dictation. Your engine, dictionary and shortcut are kept, so turning dictation back on needs no reload.';

/** Under Parakeet's "Live words (experimental)" switch: what it shows, what it costs, and when. */
export const LIVE_WORDS_EXPLANATION =
  'Off by default; the words are added in one pass after you press Stop. Experimental, and can be buggy. When on, Parakeet shows your words while you speak: it re-reads the last few seconds about once a second, greyed until two reads agree. It uses this device’s processor and battery only while the microphone is open. Stop still transcribes the rest in one final pass, and a device too slow to keep up pauses live words rather than lagging behind.';

/**
 * Said plainly next to the enhancement toggle. The capitalised phrase is the
 * promise: a separate verifier compares the before and after and throws the
 * whole result away if anything but a whole word changed.
 */
export const ENHANCEMENT_EXPLANATION =
  'WORDS ONLY. It can swap a whole word for one you actually use — “ferretry”, “tmux”, “Parakeet” — and nothing else. It cannot add, remove or reorder words, change punctuation or spacing, or rewrite a sentence. A separate check compares the result against the raw transcript and discards the whole thing if anything else moved.';

export const ENHANCEMENT_TOGGLE_EXPLANATION =
  'Optional correction runs once after transcription. Choose instant on-device word correction, or hosted Groq or Cerebras clean-up below. They cannot send a message for you.';

/**
 * Where enhancement's vocabulary comes from, in the order it is trusted.
 * Rendered under the toggle so the section explains itself.
 */
export const ENHANCEMENT_SOURCES_EXPLANATION =
  'It knows a word three ways, tried in this order: your words below (which always win), your context, and words used in the recent conversation. On-device correction runs instantly in this browser — no AI model, and your transcript, your words and your context are never uploaded. When it is not sure, it changes nothing.';

/**
 * The third vocabulary source is not in this browser, and the earlier copy
 * claimed "nothing sent anywhere" as if it were. Every enabled correction —
 * on-device included — first asks the paired daemon that holds this session for
 * its recent messages, so this says so where the claim used to be. Reading
 * history is what the whole app already does; what is worth stating is the part
 * that stays here, and that dictation is not in that request.
 */
export const LOCAL_ENHANCEMENT_HISTORY_DISCLOSURE =
  'One request does leave this browser first: to know the words of your recent conversation, Ferretry asks the paired daemon holding this session for its latest messages. It waits only a moment and corrects without them if the daemon is slow. Nothing you dictated is part of that request.';

export const GROQ_ENHANCEMENT_EXPLANATION =
  'Groq runs only after dictation stops. It is instructed to preserve your wording while correcting recognition errors, spelling, capitalization and punctuation. The daemon holds the Groq API key and sends Groq the raw transcript, your dictionary and bounded context; the key is never stored in this browser. A timeout or provider error keeps your raw words and shows the real reason instead of silently falling back.';

export const CEREBRAS_ENHANCEMENT_EXPLANATION =
  'Cerebras runs only after dictation stops, with the same instructions as Groq: keep your wording, fix recognition errors, spelling, capitalization and punctuation. The daemon holds the Cerebras API key and sends Cerebras the raw transcript, your dictionary and bounded context; the key is never stored in this browser. A timeout or provider error keeps your raw words.';

/** Where the hosted providers' keys are set, said next to the choice that needs one. */
/** Where the hosted clean-up's PROMPTS are edited: they are the machine's, not this browser's (r10 S5 tab split). */
export const CLEANUP_PROMPTS_POINTER =
  'What hosted clean-up is told to do (its prompt and conversation context) is kept on the machine, for every device: Settings › Voice clean-up.';

export const SPEEDUP_KEY_HINT =
  'The key lives on the machine, not in this browser: paste it under Settings › This machine › Speed-ups, where Test checks it works. Only the recognised text is sent for clean-up, never audio.';

/**
 * Using one of the machine's own logins for clean-up needs a login that can answer a plain chat
 * request, which arrives with environment-based logins. Shown, disabled, so the choice is not a
 * surprise when it lands — and so nobody picks an option that would fail every time.
 */
export const LOGIN_CLEANUP_UNAVAILABLE = 'One of your logins (not available yet)';

const REMOTE_EXPLANATIONS: Readonly<Record<'groq' | 'cerebras', string>> = {
  groq: GROQ_ENHANCEMENT_EXPLANATION,
  cerebras: CEREBRAS_ENHANCEMENT_EXPLANATION,
};

/** Shown before Apply: picking a hosted provider is never also the act of sending text to it. */
const HOSTED_PROVIDER_APPLY_EXPLANATION =
  'Not saved yet. Applying this sends the recognised text of every dictation to the provider you chose (once its key is on the machine). Text that has been sent cannot be unsent.';

/**
 * The patch a provider choice makes. Switching to a hosted provider resets the model to THAT
 * provider's default: a Groq model name sent to Cerebras is a refusal on every dictation.
 */
export function providerChoicePatch(current: SttSettings, chosen: string): SttSettingsPatch {
  const provider: EnhancementProviderId = ENHANCEMENT_PROVIDERS.find(entry => entry.id === chosen)?.id ?? 'local';
  if (!isRemoteEnhancementProvider(provider) || provider === current.enhancementProvider)
    return { enhancementProvider: provider };
  return { enhancementProvider: provider, enhancementModel: DEFAULT_ENHANCEMENT_MODELS[provider] };
}

/**
 * Above the free-text context field. It has to establish two things fast: paste
 * anything (it is prose, not a format), and only single words can ever be
 * swapped in — the same contract the dictionary states line by line.
 */
export const USER_CONTEXT_EXPLANATION =
  'Paste anything: project names, people, a glossary, a paragraph about what you work on. Dictation picks out the distinctive words and fixes mishearings of them. Plain English words are ignored, and if a term is also in “Your words” above, that entry wins.';

export interface DictationSettingsProps {
  readonly settings: SttSettings;
  update(patch: SttSettingsPatch): void;
  /** False once storage has refused a write, so the screen can say so. */
  readonly persisted: boolean;
  /** Injected by tests and visual fixtures; production detects this page. */
  readonly recognitionSupport?: BrowserRecognitionSupport;
  /** The browser engine, for its Try it. Injected by tests; production detects this page. */
  readonly recognitionProvider?: BrowserRecognitionProvider;
  /** Parakeet on this device. Read from the app store when omitted. */
  readonly voice?: ParakeetVoice | null;
  /** Every on-device model's voice. Read from the app store when omitted. */
  readonly voices?: OnDeviceVoices | null;
  /** The clock Try it runs on. Injected by tests; the page's otherwise. */
  readonly trialClock?: TrialClock;
  /** Phone or computer, for the default engine. Read from the page when omitted. */
  readonly deviceClass?: DeviceClass;
  /** The paired machine, whose `voice.yaml` default engine an unset device dictates with. Absent: no machine default. */
  readonly daemon?: DaemonConnection;
  /** True only when the connected machine is known to run an older Ferretry (the auto-read note). */
  readonly olderMachine?: boolean;
  /** Test and harness seam: the speed planner, instead of the page's own. */
  readonly speedPlanner?: SpeedPlanner;
}

/** A free-text field in a setting's body: its name is the row's, so a screen reader reads the same word the eye does. */
function TextBody({ children }: { readonly children: ReactNode }) {
  return <div className="fy-vs-body">{children}</div>;
}

export function DictationSettings({
  settings,
  update,
  persisted,
  recognitionSupport,
  recognitionProvider,
  voice,
  voices,
  trialClock,
  deviceClass,
  daemon,
  olderMachine: olderMachineOverride,
  speedPlanner,
}: DictationSettingsProps) {
  const machineIsOlder = useMachineIsOlder(useOptionalAppStore(), undefined);
  const olderMachine = olderMachineOverride ?? machineIsOlder;
  const detectedProvider = useMemo(() => browserRecognitionProvider(), []);
  const pageDeviceClass = useMemo(() => deviceClassOf(globalThis as DeviceClassGlobalLike), []);
  const provider = recognitionProvider ?? detectedProvider;
  const support = recognitionSupport ?? provider.support;
  const contextVoice = useParakeetVoice();
  // An explicit `voice` wins over the registry's Parakeet; with no registry the store's own is used.
  const contextVoices = useOnDeviceVoices();
  const allVoices = voices === undefined ? contextVoices : voices;
  const parakeet = voice !== undefined ? voice : allVoices === null ? contextVoice : undefined;
  const device = deviceClass ?? pageDeviceClass;
  // Until it picks one, this device dictates with the machine's default (the same read the microphone makes).
  const machineEngine = useMachineVoiceEngine(settings.engine === null ? daemon : undefined);
  const dictionary = useMemo(() => sttDictionary(settings), [settings]);
  /**
   * A live echo of what the context field actually yields, so a reader can see
   * their glossary "take" — or see that plain prose yields nothing — without
   * dictating a test sentence.
   */
  const userVocabulary = useMemo(() => userContextVocabulary(settings.userContext), [settings.userContext]);
  const remote = isRemoteEnhancementProvider(settings.enhancementProvider);
  // A hosted provider is STAGED until Apply: a select changes on an arrow key alone, and a write per change would
  // start sending text to a provider from a stray key press. Going back to on-device only ever reduces exposure.
  const [stagedProvider, setStagedProvider] = useState<string | null>(null);
  const stagedPatch = stagedProvider === null ? null : providerChoicePatch(settings, stagedProvider);
  const staged =
    stagedPatch !== null &&
    isRemoteEnhancementProvider(stagedPatch.enhancementProvider ?? 'local') &&
    stagedPatch.enhancementProvider !== settings.enhancementProvider
      ? stagedPatch
      : null;
  const chooseProvider = (chosen: string): void => {
    const patch = providerChoicePatch(settings, chosen);
    if (
      isRemoteEnhancementProvider(patch.enhancementProvider ?? 'local') &&
      patch.enhancementProvider !== settings.enhancementProvider
    ) {
      setStagedProvider(chosen);
      return;
    }
    setStagedProvider(null);
    update(patch);
  };

  return (
    <div data-voice-settings="">
      <SettingGroup label="Dictation" saves="now">
        <SettingRow
          settingId="dictation"
          name="Dictation"
          hint="Talk instead of type on this device"
          explanation={`${DICTATION_SAFETY_NOTE} ${DICTATION_DISABLED_EXPLANATION}`}
          control={labelId => (
            <SettingSwitch checked={settings.enabled} labelledBy={labelId} onChange={enabled => update({ enabled })} />
          )}
        />
        {settings.enabled ? (
          <>
            {onDeviceModel(settings.engine)?.nearLive === true && (
              <SettingRow
                name="Live words (experimental)"
                hint="Show words while you speak"
                explanation={LIVE_WORDS_EXPLANATION}
                control={labelId => (
                  <SettingSwitch
                    checked={settings.liveWordsOptIn}
                    labelledBy={labelId}
                    onChange={liveWordsOptIn => update({ liveWordsOptIn })}
                  />
                )}
              />
            )}
            <SettingRow
              name="After dictating"
              hint="What happens when the text is ready"
              explanation={AFTER_DICTATION_EXPLANATION}
            >
              <div className="fy-vs-body" data-after-dictating="">
                <ChoiceCards
                  label="After dictating"
                  value={settings.afterDictation}
                  onChange={id => update({ afterDictation: id as SttSettings['afterDictation'] })}
                  options={AFTER_DICTATION_OPTIONS.map(option => ({
                    id: option.id,
                    title: option.label,
                    line: option.description,
                  }))}
                />
              </div>
            </SettingRow>
            <DictationShortcutPicker binding={settings.shortcut} onChange={shortcut => update({ shortcut })} />
          </>
        ) : (
          <li className="fy-vs-body">
            <p className="fy-vs-note">
              Dictation is disabled. Turn it on above whenever you want the microphone available again.
            </p>
          </li>
        )}
      </SettingGroup>

      {settings.enabled ? (
        <>
          <EngineSection
            value={settings.engine}
            onChange={engine => update({ engine })}
            voices={allVoices}
            {...(parakeet === undefined ? {} : { parakeet })}
            browserSupport={support}
            browserProvider={provider}
            {...(trialClock === undefined ? {} : { clock: trialClock })}
            deviceClass={device}
            machineDefault={machineEngine}
          />
          {/* ---- which execution path the engine runs on, chosen by the device ---- */}
          <div className="fy-vs-body -mt-6 mb-8">
            <SpeedLine
              engine={effectiveEngine(settings.engine, machineEngine, device)}
              {...(speedPlanner === undefined ? {} : { planner: speedPlanner })}
            />
          </div>

          <SettingGroup label="Names and jargon">
            <SettingRow
              name="Fix names and jargon"
              hint="Swap a misheard word for one you use"
              explanation={ENHANCEMENT_TOGGLE_EXPLANATION}
              control={labelId => (
                <SettingSwitch
                  checked={settings.enhancement}
                  labelledBy={labelId}
                  onChange={enhancement => update({ enhancement })}
                />
              )}
            />
            {settings.enhancement && (
              <>
                <SettingRow
                  name="Correction provider"
                  hint={remote ? 'Hosted: the text goes to its provider' : 'On this device, instantly'}
                  wide
                  explanation={
                    <div className="flex flex-col gap-2">
                      {remote ? (
                        <>
                          <p className="m-0">
                            {REMOTE_EXPLANATIONS[settings.enhancementProvider as 'groq' | 'cerebras']}
                          </p>
                          <p className="m-0 text-faint">{SPEEDUP_KEY_HINT}</p>
                        </>
                      ) : (
                        <>
                          <p className="m-0">{ENHANCEMENT_EXPLANATION}</p>
                          <p className="m-0">{ENHANCEMENT_SOURCES_EXPLANATION}</p>
                          <p className="m-0 text-faint">{LOCAL_ENHANCEMENT_HISTORY_DISCLOSURE}</p>
                        </>
                      )}
                    </div>
                  }
                  control={() => (
                    <SelectBox
                      className="fy-vs-wide min-h-[44px]"
                      id="stt-enhancement-provider"
                      label="Correction provider"
                      onChange={chooseProvider}
                      options={[
                        ...ENHANCEMENT_PROVIDERS.map(entry => ({ value: entry.id, label: entry.label })),
                        { value: 'login', label: LOGIN_CLEANUP_UNAVAILABLE, disabled: true },
                      ]}
                      value={staged?.enhancementProvider ?? settings.enhancementProvider}
                    />
                  )}
                />
                {staged !== null && (
                  <li className="fy-vs-body" data-provider-staged="">
                    <p className="fy-vs-note" role="status">
                      {HOSTED_PROVIDER_APPLY_EXPLANATION}
                    </p>
                    <div className="fy-vs-field">
                      <button
                        type="button"
                        onClick={() => {
                          setStagedProvider(null);
                          update(staged);
                        }}
                        className="min-h-[44px] rounded-control border border-accent bg-accent-soft px-control-x text-ui font-semibold text-accent"
                      >
                        Apply
                      </button>
                      <button
                        type="button"
                        onClick={() => setStagedProvider(null)}
                        className="min-h-[44px] rounded-control border border-border-strong bg-surface-2 px-control-x text-ui text-fg"
                      >
                        Cancel
                      </button>
                    </div>
                  </li>
                )}
                {remote && (
                  <SettingRow
                    name={`${settings.enhancementProvider === 'groq' ? 'Groq' : 'Cerebras'} model`}
                    hint="Leave as it is unless you know a better one"
                    wide
                    control={labelId => (
                      <>
                        <input
                          id="stt-enhancement-model"
                          aria-labelledby={labelId}
                          className="kt-input fy-vs-wide min-h-[44px]"
                          type="text"
                          spellCheck={false}
                          list={settings.enhancementProvider === 'groq' ? 'stt-groq-models' : undefined}
                          maxLength={MAX_ENHANCEMENT_MODEL_CHARS}
                          value={settings.enhancementModel}
                          placeholder={DEFAULT_ENHANCEMENT_MODELS[settings.enhancementProvider as 'groq' | 'cerebras']}
                          onChange={event => update({ enhancementModel: event.target.value })}
                        />
                        {settings.enhancementProvider === 'groq' && (
                          <datalist id="stt-groq-models">
                            <option value={DEFAULT_GROQ_ENHANCEMENT_MODEL}>Default</option>
                            <option value={GROQ_FASTER_ENHANCEMENT_MODEL}>Faster</option>
                          </datalist>
                        )}
                      </>
                    )}
                  />
                )}
                {remote && (
                  <li className="fy-vs-body">
                    <p className="fy-vs-note">{CLEANUP_PROMPTS_POINTER}</p>
                  </li>
                )}
              </>
            )}
          </SettingGroup>

          <SettingGroup label="Your vocabulary">
            <SettingRow
              name="Your words"
              hint="One per line; add alternatives after “=”"
              explanation="One per line. Add alternatives after an “=”, separated by commas — ferretry = ferretree. Single words only: dictation never joins or splits what you said."
            >
              <TextBody>
                <Textarea
                  id="stt-dictionary"
                  aria-label="Your words"
                  className="min-h-[44px] w-full max-w-[44rem]"
                  rows={5}
                  spellCheck={false}
                  value={settings.dictionary.join('\n')}
                  onChange={event => update({ dictionary: event.target.value.split('\n') })}
                  placeholder={'ferretry = ferretree\ntmux\nParakeet = paraquet'}
                />
                <p className="fy-vs-note">
                  {dictionary.entries.length} term{dictionary.entries.length === 1 ? '' : 's'}.
                </p>
                {dictionary.problems.length > 0 && (
                  <ul className="flex list-disc flex-col gap-1 pl-5 text-meta leading-base text-warn">
                    {dictionary.problems.map(problem => (
                      <li key={problem}>{problem}</li>
                    ))}
                  </ul>
                )}
              </TextBody>
            </SettingRow>
            <SettingRow name="Your context" hint="Names, projects, a glossary" explanation={USER_CONTEXT_EXPLANATION}>
              <TextBody>
                <Textarea
                  id="stt-user-context"
                  aria-label="Your context"
                  className="min-h-[44px] w-full max-w-[44rem]"
                  rows={4}
                  spellCheck={false}
                  maxLength={MAX_USER_CONTEXT_CHARS}
                  value={settings.userContext}
                  onChange={event => update({ userContext: event.target.value })}
                  placeholder={'I work on ferretry and the daemon fleet.\nOur services: nitroso, diene, alcohol.'}
                />
                <p className="fy-vs-note">
                  {userVocabulary.length} word{userVocabulary.length === 1 ? '' : 's'} picked out
                  {userVocabulary.length > 0
                    ? ` — ${userVocabulary.slice(0, 8).join(', ')}${userVocabulary.length > 8 ? ', …' : ''}`
                    : ''}
                  .
                </p>
              </TextBody>
            </SettingRow>
          </SettingGroup>
        </>
      ) : null}

      {/* ---- hearing a reply: independent of dictation, so it stays whether dictation is on or off ---- */}
      <AutoReadSettings olderMachine={olderMachine} />

      {!persisted && (
        <p className="text-meta leading-base text-warn" role="status">
          These choices could not be saved — this browser is refusing storage — so they will reset when you reload.
        </p>
      )}
    </div>
  );
}
