/**
 * Browser-owned dictation settings.
 *
 * NO AUTOFOCUS anywhere, per this app's touch rules: opening a settings section
 * must not raise the keyboard on a phone. Every interactive target is at least
 * 44 px.
 *
 * WHAT CHANGED FROM kteam (`ui/src/components/DictationSettings.tsx`), and WHY.
 *
 *   1. SPEECH RECOGNITION IS A BROWSER CAPABILITY. There is no model catalogue,
 *      daemon readiness poll, installer, or per-device model download. The
 *      standard/prefixed constructor and the known unusable iOS Home Screen
 *      shell are read as data and rendered here.
 *   2. PRIVACY COPY HAS TWO BOUNDARIES. Ferretry never uploads microphone audio
 *      to its daemon. The Web Speech API is allowed to use a browser-vendor
 *      online service, so this screen says that plainly instead of claiming all
 *      target browsers recognise offline.
 *   3. ENHANCEMENT IS SEPARATE. Local word correction stays in this browser;
 *      optional Groq correction legitimately sends recognised TEXT through the
 *      paired daemon that owns the live session and its credential. Either
 *      provider first READS that session's recent messages for vocabulary, so
 *      the local copy discloses that request rather than promising silence.
 *
 * Everything else — the master switch, the push-to-talk picker, the enhancement
 * toggle and provider, the dictionary, the free-text context and its live
 * vocabulary echo — is kteam's, wording included where the wording was about the
 * enhancer rather than about where audio goes.
 */

import { Check, CircleSlash2 } from 'lucide-react';
import { useMemo } from 'react';
import { cn } from '../../lib/class-names.ts';
import { type BrowserRecognitionSupport, browserRecognitionProvider } from '../../lib/stt/browser-recognition.ts';
import { userContextVocabulary } from '../../lib/stt/enhancement.ts';
import {
  ENHANCEMENT_PROVIDERS,
  MAX_ENHANCEMENT_MODEL_CHARS,
  MAX_USER_CONTEXT_CHARS,
  type SttSettings,
  type SttSettingsPatch,
  sttDictionary,
} from '../../lib/stt/stt-settings.ts';
import { Textarea } from '../../shell/primitives.tsx';
import { DictationShortcutPicker } from './dictation-shortcut-picker.tsx';

export const DICTATION_SAFETY_NOTE =
  'Ferretry never sends microphone audio to your daemon. Stop settles the browser transcript, corrects it once, and inserts it at your current caret. Nothing is ever sent for you.';

export const BROWSER_MODE_SUMMARY =
  'Speech recognition is handled by this browser. Microphone audio is never uploaded to Ferretry or your paired daemon.';

export const BROWSER_SERVICE_DISCLOSURE =
  'Depending on the browser and its settings, recognition may use the browser vendor’s online speech service and may not work offline. That service’s privacy policy applies.';

export const DICTATION_DISABLED_EXPLANATION =
  'Off means off: browser speech recognition cannot start. Your dictionary and shortcut are kept, so turning dictation back on needs no reload.';

/**
 * Said plainly next to the enhancement toggle. The capitalised phrase is the
 * promise: a separate verifier compares the before and after and throws the
 * whole result away if anything but a whole word changed.
 */
export const ENHANCEMENT_EXPLANATION =
  'WORDS ONLY. It can swap a whole word for one you actually use — “ferretry”, “tmux”, “Parakeet” — and nothing else. It cannot add, remove or reorder words, change punctuation or spacing, or rewrite a sentence. A separate check compares the result against the raw transcript and discards the whole thing if anything else moved.';

export const ENHANCEMENT_TOGGLE_EXPLANATION =
  'Optional correction runs once after transcription. Choose instant on-device word correction or hosted Groq cleanup below. They cannot send a message for you.';

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
}

export function DictationSettings({ settings, update, persisted, recognitionSupport }: DictationSettingsProps) {
  const detectedSupport = useMemo(() => browserRecognitionProvider().support, []);
  const support = recognitionSupport ?? detectedSupport;
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
          {/* ---- one honest browser capability ---- */}
          <section
            aria-label="Browser dictation availability"
            className={cn(
              'flex flex-col gap-2 rounded-control border p-3',
              support.available ? 'border-accent bg-accent-soft' : 'border-warn bg-warn-soft',
            )}
          >
            <h3 className={cn('m-0 text-ui font-semibold', support.available ? 'text-accent' : 'text-warn')}>
              {support.available ? 'Available in this browser' : 'Unavailable in this browser'}
            </h3>
            <p
              className={cn(
                'm-0 flex items-start gap-1 text-meta leading-base',
                support.available ? 'text-ok' : 'text-warn',
              )}
              role="status"
            >
              {support.available ? (
                <Check size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
              ) : (
                <CircleSlash2 size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
              )}
              <span>
                {support.available
                  ? `Ready — ${support.implementation === 'webkit' ? 'WebKit' : 'standard'} speech recognition is exposed on this page.`
                  : support.reason}
              </span>
            </p>
            <p className="m-0 text-meta leading-base text-fg">{BROWSER_MODE_SUMMARY}</p>
            <p className="m-0 text-meta leading-base text-faint">{BROWSER_SERVICE_DISCLOSURE}</p>
          </section>

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
                  onChange={event => update({ enhancementProvider: event.target.value === 'groq' ? 'groq' : 'local' })}
                >
                  {ENHANCEMENT_PROVIDERS.map(provider => (
                    <option key={provider.id} value={provider.id}>
                      {provider.label}
                    </option>
                  ))}
                </select>
                {settings.enhancementProvider === 'groq' ? (
                  <>
                    <label htmlFor="stt-enhancement-model" className="text-ui font-semibold">
                      Groq model
                    </label>
                    <input
                      id="stt-enhancement-model"
                      className="kt-input min-h-[44px]"
                      type="text"
                      spellCheck={false}
                      maxLength={MAX_ENHANCEMENT_MODEL_CHARS}
                      value={settings.enhancementModel}
                      onChange={event => update({ enhancementModel: event.target.value })}
                    />
                    <p className="text-meta leading-base text-muted">{GROQ_ENHANCEMENT_EXPLANATION}</p>
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
