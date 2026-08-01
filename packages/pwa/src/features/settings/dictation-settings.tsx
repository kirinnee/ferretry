/**
 * The dictation settings surface for ONE paired daemon.
 *
 * NO AUTOFOCUS anywhere, per this app's touch rules: opening a settings section
 * must not raise the keyboard on a phone. Every interactive target is at least
 * 44 px.
 *
 * WHAT CHANGED FROM kteam (`ui/src/components/DictationSettings.tsx`), and WHY.
 *
 *   1. IT IS ABOUT THE DAEMON, BECAUSE THAT IS WHERE SPEECH IS TRANSCRIBED.
 *      kteam's surface existed to make the BROWSER-LOCAL engine's costs visible
 *      before anyone committed to them: a ~700 MB per-device download, CPU WASM
 *      inference, WebKit's seven-day eviction, battery. None of that applies to
 *      a build with no browser-local engine (`local-engine.ts` and `ort-assets`
 *      are NOT PORTED — they need `onnxruntime-web`, a ~25 MB WASM asset and a
 *      bundler). Keeping those five disclosures would have been five statements
 *      about a mechanism that does not exist. What replaces them is the honest
 *      one: the recording goes to the daemon named at the top of this screen.
 *   2. THE MODEL READINESS SHOWN IS THE DAEMON'S OWN. kteam had two stages —
 *      the box fetching the browser weights, then each device copying them. Only
 *      the first half has meaning here, and it is the half that decides whether
 *      dictation works at all, so `daemonSttStatus` is read and
 *      `requestDaemonModelInstall` is offered when the daemon has no model. The
 *      "Prepare this device" half is gone with the engine it prepared.
 *   3. THE COST SUMMARY IS THE DAEMON'S OWN SENTENCE, rendered verbatim. The box
 *      knows the real numbers for the model it pinned; paraphrasing them here
 *      would be inventing them.
 *
 * Everything else — the master switch, the push-to-talk picker, the enhancement
 * toggle and provider, the dictionary, the free-text context and its live
 * vocabulary echo — is kteam's, wording included where the wording was about the
 * enhancer rather than about where audio goes.
 */

import { Check, Download, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import {
  daemonSttStatus,
  type DaemonModelStatus,
  type DaemonSttStatus,
  type FetchLike,
  requestDaemonModelInstall,
} from '../../lib/stt/daemon-engine.ts';
import { userContextVocabulary } from '../../lib/stt/enhancement.ts';
import {
  ENHANCEMENT_PROVIDERS,
  MAX_ENHANCEMENT_MODEL_CHARS,
  MAX_USER_CONTEXT_CHARS,
  sttDictionary,
  type SttSettings,
  type SttSettingsPatch,
} from '../../lib/stt/stt-settings.ts';
import { Button, Textarea } from '../../shell/primitives.tsx';
import { DictationShortcutPicker } from './dictation-shortcut-picker.tsx';

/** Human bytes, one decimal, MB/GB only — the two units these numbers live in. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / 1_000_000;
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

export const DICTATION_SAFETY_NOTE =
  'Your recording goes to this daemon and nowhere else. Stop transcribes it once, corrects it once, and inserts the result at your current caret. Nothing is ever sent for you.';

export const DAEMON_MODE_SUMMARY =
  'Speech is transcribed by the daemon you are paired with — your own machine, not a third-party service. The recording is posted when you press Stop, transcribed, and discarded; nothing about it is stored in this browser.';

export const DICTATION_DISABLED_EXPLANATION =
  'Off means off: the microphone cannot start, no recording is captured, and nothing is posted to the daemon. Your dictionary and shortcut are kept, so turning dictation back on needs no reload.';

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
  'It knows a word three ways, tried in this order: your words below (which always win), your context, and words used in the recent conversation. On-device correction runs instantly in this browser — no AI model, nothing sent anywhere. When it is not sure, it changes nothing.';

export const GROQ_ENHANCEMENT_EXPLANATION =
  'Groq runs only after dictation stops. It is instructed to preserve your wording while correcting recognition errors, spelling, capitalization and punctuation. The daemon holds the Groq API key and sends Groq the raw transcript, your dictionary and bounded context; the key is never stored in this browser. A timeout or provider error keeps your raw words and shows the real reason instead of silently falling back.';

/**
 * Above the free-text context field. It has to establish two things fast: paste
 * anything (it is prose, not a format), and only single words can ever be
 * swapped in — the same contract the dictionary states line by line.
 */
export const USER_CONTEXT_EXPLANATION =
  'Paste anything: project names, people, a glossary, a paragraph about what you work on. Dictation picks out the distinctive words and fixes mishearings of them. Plain English words are ignored, and if a term is also in “Your words” above, that entry wins.';

/**
 * TRUE when this daemon cannot transcribe anything yet, so the reader is told
 * before they press a microphone that produces nothing.
 *
 * An UNKNOWN status is deliberately NOT a refusal: a daemon built before this
 * feature answers 404 and tells us nothing about a model, and the microphone is
 * still worth offering — the transcribe call reports honestly if the route turns
 * out to be missing. Refusing on ignorance would break a working setup to
 * protect against a broken one.
 */
export function needsDaemonModel(model: DaemonModelStatus | undefined): boolean {
  return model !== undefined && model.state !== 'ready';
}

type StatusState = 'unknown' | 'checking' | 'ready' | 'missing';

export interface DictationSettingsProps {
  /** The paired daemon whose speech model this screen reports on. */
  readonly daemon: DaemonConnection;
  readonly settings: SttSettings;
  update(patch: SttSettingsPatch): void;
  /** False once storage has refused a write, so the screen can say so. */
  readonly persisted: boolean;
  /** Injected by tests and the visual harness; the browser's `fetch` otherwise. */
  readonly fetchImpl?: FetchLike;
}

export function DictationSettings({ daemon, settings, update, persisted, fetchImpl }: DictationSettingsProps) {
  const [status, setStatus] = useState<DaemonSttStatus | null>(null);
  const [statusState, setStatusState] = useState<StatusState>('unknown');
  const [installMessage, setInstallMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setStatusState('checking');
    const next = await daemonSttStatus(daemon, fetchImpl ? { fetchImpl } : {});
    setStatus(next);
    setStatusState(next.available ? 'ready' : 'missing');
  }, [daemon, fetchImpl]);

  // Re-runs whenever the paired daemon changes: one daemon's readiness must
  // never be shown beside another daemon's name.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const model = status?.daemonModel;
  const modelMissing = needsDaemonModel(model);

  const install = useCallback(
    (modelId: string) => {
      setInstallMessage(null);
      void requestDaemonModelInstall(daemon, modelId, fetchImpl ? { fetchImpl } : {}).then(outcome => {
        if (outcome.message !== undefined) setInstallMessage(outcome.message);
        if (outcome.started) void refresh();
      });
    },
    [daemon, fetchImpl, refresh],
  );

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
          {/* ---- one honest engine ---- */}
          <section
            aria-label="Where speech is transcribed"
            className="flex flex-col gap-2 rounded-control border border-accent bg-accent-soft p-3"
          >
            <h3 className="m-0 text-ui font-semibold text-accent">Transcribed by this daemon</h3>
            <p className="m-0 text-meta leading-base text-fg">{DAEMON_MODE_SUMMARY}</p>
            <p className="m-0 text-meta leading-base text-faint">
              Browser-local transcription is not available in this build, so there is no per-device model download and
              nothing to prepare.
            </p>
          </section>

          {/* ---- this daemon's readiness ---- */}
          <section
            aria-label="This daemon"
            className="flex flex-col gap-2 rounded-control border border-border bg-surface-2 p-3"
          >
            <h3 className="m-0 text-ui font-semibold">This daemon</h3>
            {statusState === 'checking' && (
              <p className="m-0 flex items-center gap-1 text-meta text-faint" role="status">
                <Loader2 size={14} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
                Asking the daemon what it can transcribe…
              </p>
            )}
            {statusState === 'ready' && (
              <p className="m-0 flex items-center gap-1 text-meta text-ok" role="status">
                <Check size={14} aria-hidden="true" /> Ready — {status?.languages.join(', ') || 'English'}.
              </p>
            )}
            {statusState === 'missing' && (
              <p className="m-0 text-meta leading-base text-warn" role="status">
                {status?.unavailableReason ?? 'This daemon cannot transcribe speech yet.'}
              </p>
            )}
            {status?.streaming === false && (
              <p className="m-0 text-meta leading-base text-faint">
                This daemon does not claim live text: words appear once the recording is finished, not while you speak.
              </p>
            )}
            {model !== undefined && (
              <>
                <p className="m-0 text-meta leading-base text-muted">{model.costs.summary}</p>
                {modelMissing && (
                  <div className="flex flex-col gap-2">
                    <p className="m-0 text-meta leading-base text-warn">
                      This daemon has no speech model yet. That is a one-time {formatBytes(model.costs.downloadBytes)}{' '}
                      download onto the daemon, shared by every device you pair with it.
                    </p>
                    {model.install.phase === 'downloading' && (
                      <p className="m-0 text-meta text-faint" role="status">
                        Downloading on the daemon — {formatBytes(model.install.receivedBytes)} of{' '}
                        {formatBytes(model.install.totalBytes)}.
                      </p>
                    )}
                    {installMessage !== null && (
                      <p className="m-0 text-meta leading-base text-warn">{installMessage}</p>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="primary"
                      className="min-h-[44px] min-w-[44px] self-start"
                      disabled={model.install.phase === 'downloading'}
                      onClick={() => install(model.id)}
                    >
                      <Download size={14} aria-hidden="true" />
                      <span className="ml-1">
                        Download {model.label} on the daemon ({formatBytes(model.costs.downloadBytes)})
                      </span>
                    </Button>
                  </div>
                )}
              </>
            )}
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
