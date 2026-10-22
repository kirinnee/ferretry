/**
 * Voice settings for this device: which engine dictates, Parakeet's install, and clean-up.
 *
 * NO AUTOFOCUS anywhere, per this app's touch rules: opening a settings section
 * must not raise the keyboard on a phone. Every interactive target is at least
 * 44 px.
 *
 * WHAT CHANGED FROM kteam (`ui/src/components/DictationSettings.tsx`), and WHY.
 *
 *   1. ENGINES CHOSEN PER DEVICE (`engine-catalog-list.tsx`). Every on-device
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

import { useMemo } from 'react';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { useOnDeviceVoices, useParakeetVoice } from '../../lib/store.tsx';
import {
  type BrowserRecognitionProvider,
  type BrowserRecognitionSupport,
  browserRecognitionProvider,
} from '../../lib/stt/browser-recognition.ts';
import { userContextVocabulary } from '../../lib/stt/enhancement.ts';
import { onDeviceModel } from '../../lib/stt/model-catalog.ts';
import type { OnDeviceVoices } from '../../lib/stt/on-device-voices.ts';
import type { ParakeetVoice } from '../../lib/stt/parakeet-voice.ts';
import {
  DEFAULT_ENHANCEMENT_MODELS,
  DEFAULT_GROQ_ENHANCEMENT_MODEL,
  type DictationEngineId,
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
import { Textarea } from '../../shell/primitives.tsx';
import { DictationShortcutPicker } from './dictation-shortcut-picker.tsx';
import { type DeviceClass, type DeviceClassGlobalLike, deviceClassOf } from '../../lib/stt/engine-defaults.ts';
import { EngineCatalogList, type TrialClock } from './engine-catalog-list.tsx';
import type { MachineVoiceCleanup } from './use-machine-voice-cleanup.ts';
import { VoiceCleanupSettings } from './voice-cleanup-settings.tsx';

export const DICTATION_SAFETY_NOTE =
  'Ferretry never sends microphone audio to your daemon. Stop settles the browser transcript, corrects it once, and inserts it at your current caret. Nothing is ever sent for you.';

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
  /** The machine whose `voice.yaml` holds the cleanup prompts; the section is absent without one. */
  readonly daemon?: DaemonConnection;
  /** Test and harness seam: the machine's cleanup settings, instead of reading them through the app. */
  readonly voiceCleanup?: MachineVoiceCleanup;
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
  voiceCleanup,
}: DictationSettingsProps) {
  const detectedProvider = useMemo(() => browserRecognitionProvider(), []);
  const pageDeviceClass = useMemo(() => deviceClassOf(globalThis as DeviceClassGlobalLike), []);
  const provider = recognitionProvider ?? detectedProvider;
  const support = recognitionSupport ?? provider.support;
  const contextVoice = useParakeetVoice();
  // An explicit `voice` wins over the registry's Parakeet; with no registry the store's own is used.
  const contextVoices = useOnDeviceVoices();
  const allVoices = voices === undefined ? contextVoices : voices;
  const parakeet = voice !== undefined ? voice : allVoices === null ? contextVoice : undefined;
  const choose = (engine: DictationEngineId): void => update({ engine });
  const dictionary = useMemo(() => sttDictionary(settings), [settings]);
  /**
   * A live echo of what the context field actually yields, so a reader can see
   * their glossary "take" — or see that plain prose yields nothing — without
   * dictating a test sentence.
   */
  const userVocabulary = useMemo(() => userContextVocabulary(settings.userContext), [settings.userContext]);

  return (
    <div className="flex flex-col gap-5">
      <p className="text-meta leading-base text-muted">{DICTATION_SAFETY_NOTE}</p>

      <section aria-label="Dictation availability" className="flex flex-col gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={settings.enabled}
          onClick={() => update({ enabled: !settings.enabled })}
          className={cn(
            'flex min-h-[44px] items-center justify-between gap-3 rounded-control border px-control-x py-2 text-left transition-colors',
            settings.enabled ? 'border-accent bg-accent-soft text-accent' : 'border-border bg-surface-2 text-fg',
          )}
        >
          <span className="text-ui font-semibold">Dictation</span>
          <span className="text-meta">{settings.enabled ? 'On' : 'Off'}</span>
        </button>
        <p className="text-meta leading-base text-muted">{DICTATION_DISABLED_EXPLANATION}</p>
      </section>

      {settings.enabled ? (
        <>
          {/* ---- which engine, and Parakeet's install ---- */}
          <section aria-label="Voice engine" className="flex flex-col gap-2">
            <EngineCatalogList
              value={settings.engine}
              onChange={choose}
              voices={allVoices}
              {...(parakeet === undefined ? {} : { parakeet })}
              browserSupport={support}
              browserProvider={provider}
              {...(trialClock === undefined ? {} : { clock: trialClock })}
              deviceClass={deviceClass ?? pageDeviceClass}
            />
          </section>

          {/* ---- near-live words, for a model that re-reads a window (Parakeet) ---- */}
          {onDeviceModel(settings.engine)?.nearLive === true && (
            <section aria-label="Live words (experimental)" className="flex flex-col gap-2">
              <button
                type="button"
                role="switch"
                aria-checked={settings.liveWordsOptIn}
                onClick={() => update({ liveWordsOptIn: !settings.liveWordsOptIn })}
                className={cn(
                  'flex min-h-[44px] items-center justify-between gap-3 rounded-control border px-control-x py-2 text-left transition-colors',
                  settings.liveWordsOptIn
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-border bg-surface-2 text-fg',
                )}
              >
                <span className="text-ui font-semibold">Live words (experimental)</span>
                <span className="text-meta">{settings.liveWordsOptIn ? 'On' : 'Off'}</span>
              </button>
              <p className="text-meta leading-base text-muted">{LIVE_WORDS_EXPLANATION}</p>
            </section>
          )}

          {/* ---- push-to-talk shortcut ---- */}
          <DictationShortcutPicker binding={settings.shortcut} onChange={shortcut => update({ shortcut })} />

          {/* ---- enhancement ---- */}
          <div className="flex flex-col gap-2">
            <button
              type="button"
              role="switch"
              aria-checked={settings.enhancement}
              onClick={() => update({ enhancement: !settings.enhancement })}
              className={cn(
                'flex min-h-[44px] items-center justify-between gap-3 rounded-control border px-control-x py-2 text-left transition-colors',
                settings.enhancement
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-border bg-surface-2 text-fg',
              )}
            >
              <span className="text-ui font-semibold">Fix names and jargon</span>
              <span className="text-meta">{settings.enhancement ? 'On' : 'Off'}</span>
            </button>
            <p className="text-meta leading-base text-muted">{ENHANCEMENT_TOGGLE_EXPLANATION}</p>
            {settings.enhancement && (
              <div className="flex flex-col gap-2 rounded-control border border-border bg-surface-2 p-3">
                <label htmlFor="stt-enhancement-provider" className="text-ui font-semibold">
                  Correction provider
                </label>
                <select
                  id="stt-enhancement-provider"
                  className="kt-input min-h-[44px]"
                  value={settings.enhancementProvider}
                  onChange={event => update(providerChoicePatch(settings, event.target.value))}
                >
                  {ENHANCEMENT_PROVIDERS.map(provider => (
                    <option key={provider.id} value={provider.id}>
                      {provider.label}
                    </option>
                  ))}
                  <option value="login" disabled>
                    {LOGIN_CLEANUP_UNAVAILABLE}
                  </option>
                </select>
                {isRemoteEnhancementProvider(settings.enhancementProvider) ? (
                  <>
                    <label htmlFor="stt-enhancement-model" className="text-ui font-semibold">
                      {settings.enhancementProvider === 'groq' ? 'Groq' : 'Cerebras'} model
                    </label>
                    <input
                      id="stt-enhancement-model"
                      className="kt-input min-h-[44px]"
                      type="text"
                      spellCheck={false}
                      list={settings.enhancementProvider === 'groq' ? 'stt-groq-models' : undefined}
                      maxLength={MAX_ENHANCEMENT_MODEL_CHARS}
                      value={settings.enhancementModel}
                      placeholder={DEFAULT_ENHANCEMENT_MODELS[settings.enhancementProvider]}
                      onChange={event => update({ enhancementModel: event.target.value })}
                    />
                    {settings.enhancementProvider === 'groq' && (
                      <datalist id="stt-groq-models">
                        <option value={DEFAULT_GROQ_ENHANCEMENT_MODEL}>Default</option>
                        <option value={GROQ_FASTER_ENHANCEMENT_MODEL}>Faster</option>
                      </datalist>
                    )}
                    <p className="text-meta leading-base text-muted">
                      {REMOTE_EXPLANATIONS[settings.enhancementProvider]}
                    </p>
                    <p className="text-meta leading-base text-faint">{SPEEDUP_KEY_HINT}</p>
                    <VoiceCleanupSettings daemon={daemon} state={voiceCleanup} />
                  </>
                ) : (
                  <>
                    <p className="text-meta leading-base text-muted">{ENHANCEMENT_EXPLANATION}</p>
                    <p className="text-meta leading-base text-muted">{ENHANCEMENT_SOURCES_EXPLANATION}</p>
                    <p className="text-meta leading-base text-faint">{LOCAL_ENHANCEMENT_HISTORY_DISCLOSURE}</p>
                  </>
                )}
              </div>
            )}
          </div>

          {/* ---- dictionary ---- */}
          <div className="flex flex-col gap-2">
            <label htmlFor="stt-dictionary" className="text-ui font-semibold">
              Your words
            </label>
            <p className="text-meta leading-base text-muted">
              One per line. Add alternatives after an “=”, separated by commas — <code>ferretry = ferretree</code>.
              Single words only: dictation never joins or splits what you said.
            </p>
            <Textarea
              id="stt-dictionary"
              className="min-h-[44px]"
              rows={5}
              spellCheck={false}
              value={settings.dictionary.join('\n')}
              onChange={event => update({ dictionary: event.target.value.split('\n') })}
              placeholder={'ferretry = ferretree\ntmux\nParakeet = paraquet'}
            />
            <p className="text-meta text-faint">
              {dictionary.entries.length} term{dictionary.entries.length === 1 ? '' : 's'}.
            </p>
            {dictionary.problems.length > 0 && (
              <ul className="flex list-disc flex-col gap-1 pl-5 text-meta leading-base text-warn">
                {dictionary.problems.map(problem => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
          </div>

          {/* ---- free-text context ---- */}
          <div className="flex flex-col gap-2">
            <label htmlFor="stt-user-context" className="text-ui font-semibold">
              Your context
            </label>
            <p className="text-meta leading-base text-muted">{USER_CONTEXT_EXPLANATION}</p>
            <Textarea
              id="stt-user-context"
              className="min-h-[44px]"
              rows={4}
              spellCheck={false}
              maxLength={MAX_USER_CONTEXT_CHARS}
              value={settings.userContext}
              onChange={event => update({ userContext: event.target.value })}
              placeholder={'I work on ferretry and the daemon fleet.\nOur services: nitroso, diene, alcohol.'}
            />
            <p className="text-meta text-faint">
              {userVocabulary.length} word{userVocabulary.length === 1 ? '' : 's'} picked out
              {userVocabulary.length > 0
                ? ` — ${userVocabulary.slice(0, 8).join(', ')}${userVocabulary.length > 8 ? ', …' : ''}`
                : ''}
              .
            </p>
          </div>
        </>
      ) : (
        <p className="rounded-control border border-border bg-surface-2 p-3 text-meta leading-base text-faint">
          Dictation is disabled. Turn it on above whenever you want the microphone available again.
        </p>
      )}

      {!persisted && (
        <p className="text-meta leading-base text-warn" role="status">
          These choices could not be saved — this browser is refusing storage — so they will reset when you reload.
        </p>
      )}
    </div>
  );
}
