/**
 * FIRST RUN › VOICE › "Test your audio" — the one place the first-run flow asks for the microphone, and lets the person
 * hear that both directions work before moving on:
 *
 *   1. ALLOW   the microphone's permission, asked by a button (never on arrival): `mic-permission.ts` says what the browser
 *              holds and, when it will not help (denied, no microphone, no https), the sentence that says what to do.
 *   2. RECORD  a line with the engine picked above (`startEngineTrial`, the same port Settings › Voice › Try it drives) and
 *              show the words it heard. It changes nothing: not the draft, not the saved engine, no log.
 *   3. HEAR    a sample read aloud with the voice Read aloud would use (`useReadAloud`), so the person knows replies can be heard.
 *
 * Every control here is a real button in the page body (the demo column is decorative and aria-hidden). A test that cannot
 * run says why in one sentence and offers no dead button.
 */

import { Mic, Play, Square, Volume2 } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '../../shell-voice.ts';
import { useReadAloud } from '../../hooks/use-read-aloud.ts';
import type { BrowserRecognitionError } from '../../lib/stt/browser-recognition.ts';
import { type EngineTrial, type EngineTrialUpdate, startEngineTrial } from '../../lib/stt/engine-trial.ts';
import { ON_DEVICE_MODELS } from '../../lib/stt/model-catalog.ts';
import type {
  OnDeviceInstallSnapshot,
  OnDeviceSession,
  OnDeviceSessionOptions,
} from '../../lib/stt/on-device-voice.ts';
import type { OnDeviceVoice } from '../../lib/stt/on-device-voice.ts';
import type { OnDeviceVoices } from '../../lib/stt/on-device-voices.ts';
import type { EngineChoice } from '../engine-card/engine-card-grid.tsx';
import { pageClock, type TrialClock } from '../settings/engine-trial-control.tsx';
import { browserMic, type MicPort, type MicState } from './mic-permission.ts';

/** The line "Hear a sample" reads. */
export const SAMPLE_LINE = 'This is how Ferretry reads a reply out loud.';
const SAMPLE_KEY = 'voice-step-sample';

const BROWSER_VOICE_BLOCKED =
  'Browser voice may send your audio to your browser’s maker, so it is not recorded here: pick an on-device voice to test the mic here.';

const NOTHING_HEARD = 'Nothing was heard. Say a sentence a little closer to the microphone, then try again.';

/** What the picked engine can do for a test: open a session, or the one sentence that says why not. */
export type TestEngine =
  | { readonly open: (options: OnDeviceSessionOptions) => OnDeviceSession; readonly name: string }
  | { readonly blocked: string };

const noSubscribe = (): (() => void) => () => undefined;
const noSnapshot = (): null => null;

/** The picked voice's install, live; `null` when the pick has none. */
function useInstall(voice: OnDeviceVoice | null): OnDeviceInstallSnapshot | null {
  return useSyncExternalStore(
    voice === null ? noSubscribe : voice.subscribe,
    voice === null ? noSnapshot : voice.getSnapshot,
    noSnapshot,
  );
}

/** What testing the pick means right now. */
export function testEngineOf(
  pick: EngineChoice | null,
  voice: OnDeviceVoice | null,
  install: OnDeviceInstallSnapshot | null,
): TestEngine {
  if (pick === null) return { blocked: 'Pick an engine above to test it.' };
  if (pick === 'off') return { blocked: 'Dictation is off, so there is nothing to record. Pick an engine to test it.' };
  // PRIVACY: the browser's own voice is native speech recognition, which most browsers stream to their maker. A test here
  // would send the person's first words off the device before they chose to, so only verified on-device engines record.
  if (pick === 'browser') return { blocked: BROWSER_VOICE_BLOCKED };
  const model = ON_DEVICE_MODELS.find(entry => entry.id === pick);
  const name = model?.shortName ?? 'This engine';
  if (voice === null || !voice.support.available)
    return { blocked: voice?.support.reason ?? `${name} cannot run in this browser.` };
  if (install?.phase !== 'installed') return { blocked: `Install ${name} above to test it with your voice.` };
  return { open: options => voice.createSession(options), name };
}

type Take =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly update: EngineTrialUpdate }
  | { readonly kind: 'done'; readonly text: string }
  | { readonly kind: 'failed'; readonly message: string };

const PHASE_COPY: Readonly<Record<EngineTrialUpdate['phase'], string>> = {
  opening: 'Opening the microphone…',
  recording: 'Listening. Say a sentence.',
  transcribing: 'Writing it down…',
};

const MIC_LINE: Readonly<Record<MicState['kind'] | 'checking', string>> = {
  checking: 'Checking the microphone…',
  prompt: 'The microphone is not allowed yet. Press Allow, then say yes in your browser.',
  granted: 'Microphone allowed.',
  denied: '',
  unavailable: '',
};

export interface VoiceTestProps {
  readonly pick: EngineChoice | null;
  readonly voices: OnDeviceVoices | null;
  /** Tests and shots hand their own; the page uses its own microphone. */
  readonly mic?: MicPort | undefined;
  readonly clock?: TrialClock | undefined;
}

export function VoiceTest({ pick, voices, mic, clock = pageClock }: VoiceTestProps) {
  const port = useRef<MicPort>(mic ?? browserMic());
  port.current = mic ?? port.current;
  const [micState, setMicState] = useState<MicState | null>(null);
  const [take, setTake] = useState<Take>({ kind: 'idle' });
  const trialRef = useRef<EngineTrial | null>(null);
  const voice = pick === null || pick === 'off' || pick === 'browser' ? null : (voices?.get(pick) ?? null);
  const install = useInstall(voice);
  const engine = testEngineOf(pick, voice, install);
  const sample = useReadAloud(SAMPLE_KEY);

  useEffect(() => {
    let alive = true;
    void port.current.state().then(state => {
      if (alive) setMicState(state);
    });
    return () => {
      alive = false;
      trialRef.current?.cancel();
    };
  }, []);
  const allow = (): void => {
    setMicState(null);
    void port.current.request().then(setMicState);
  };

  const record = (): void => {
    if ('blocked' in engine) return;
    trialRef.current?.cancel();
    const owner = { trial: null as EngineTrial | null };
    const trial = startEngineTrial({ ...clock, open: engine.open }, update => {
      if (owner.trial === null || trialRef.current === owner.trial) setTake({ kind: 'running', update });
    });
    owner.trial = trial;
    trialRef.current = trial;
    trial.result.then(
      result => {
        if (trialRef.current !== trial) return;
        trialRef.current = null;
        setMicState({ kind: 'granted' });
        setTake(result.text === '' ? { kind: 'failed', message: NOTHING_HEARD } : { kind: 'done', text: result.text });
      },
      (error: unknown) => {
        if (trialRef.current !== trial) return;
        trialRef.current = null;
        const failure = error as BrowserRecognitionError;
        if (failure.code === 'aborted') return setTake({ kind: 'idle' });
        // A refusal at the microphone is the permission's state, said where permission is said.
        if (failure.code === 'permission-denied') void port.current.state().then(setMicState);
        setTake({ kind: 'failed', message: failure.message || 'The test failed. Try again.' });
      },
    );
  };

  const granted = micState?.kind === 'granted';
  const blocked = 'blocked' in engine ? engine.blocked : null;
  const micNote =
    micState === null
      ? MIC_LINE.checking
      : micState.kind === 'denied' || micState.kind === 'unavailable'
        ? micState.message
        : MIC_LINE[micState.kind];
  const running = take.kind === 'running';

  return (
    <section className="fy-vt" aria-label="Test your audio" data-voice-test="">
      <h3 className="fy-vt__title">Test your audio</h3>

      <div className="fy-vt__block" data-test-part="microphone">
        <p className="fy-vt__status" data-mic={micState?.kind ?? 'checking'} role="status">
          <span className="fy-vt__dot" aria-hidden="true" />
          <span>{micNote}</span>
        </p>
        {micState?.kind === 'prompt' || micState?.kind === 'denied' ? (
          <div className="fy-vt__row">
            <Button type="button" variant="primary" size="sm" onClick={allow} data-test-action="allow">
              <Mic size={14} aria-hidden="true" />
              <span className="ml-1">{micState.kind === 'denied' ? 'Try again' : 'Allow microphone'}</span>
            </Button>
          </div>
        ) : null}
        {micState?.kind === 'unavailable' && micState.retry ? (
          <div className="fy-vt__row">
            <Button type="button" variant="outline" size="sm" onClick={allow} data-test-action="allow">
              <span>Try again</span>
            </Button>
          </div>
        ) : null}
      </div>

      <div className="fy-vt__block" data-test-part="record">
        {blocked !== null ? (
          <p className="fy-vt__note">{blocked}</p>
        ) : (
          <>
            {take.kind === 'idle' ? (
              <p className="fy-vt__note" data-test-hint="">
                {granted ? 'Press Record, then say a sentence.' : 'Record unlocks once the microphone is allowed.'}
              </p>
            ) : null}
            {running ? (
              <p
                className="fy-vt__live"
                role="status"
                data-listening={take.update.phase === 'recording' ? '' : undefined}
              >
                <Mic size={16} aria-hidden="true" />
                <span>{PHASE_COPY[take.update.phase]}</span>
              </p>
            ) : null}
            {running && take.update.live !== '' ? <p className="fy-vt__words">{take.update.live}</p> : null}
            {take.kind === 'done' ? (
              <blockquote className="fy-vt__said" data-test-said="">
                <span className="fy-vt__said-label">You said</span>
                <span>{`“${take.text}”`}</span>
              </blockquote>
            ) : null}
            {take.kind === 'failed' ? (
              <p className="fy-vt__note" data-tone="warn" role="alert">
                {take.message}
              </p>
            ) : null}
          </>
        )}
        <div className="fy-vt__row">
          {running ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => trialRef.current?.cancel()}
              data-test-action="stop"
            >
              <Square size={14} aria-hidden="true" />
              <span className="ml-1">Stop</span>
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={blocked !== null || !granted}
              onClick={record}
              data-test-action="record"
            >
              <Mic size={14} aria-hidden="true" />
              <span className="ml-1">{take.kind === 'idle' ? 'Record a line' : 'Record again'}</span>
            </Button>
          )}
        </div>
      </div>

      <div className="fy-vt__block" data-test-part="playback">
        {sample.supported ? null : <p className="fy-vt__note">This browser has no voice to read aloud.</p>}
        {sample.state.status === 'reading' ? (
          <p className="fy-vt__live" role="status" data-listening="">
            <Volume2 size={16} aria-hidden="true" />
            <span>{`Reading: “${SAMPLE_LINE}”`}</span>
          </p>
        ) : null}
        {sample.state.status === 'failed' ? (
          <p className="fy-vt__note" data-tone="warn" role="alert">
            This device could not speak. Check its volume, then try again.
          </p>
        ) : null}
        {sample.state.status === 'unavailable' ? (
          <p className="fy-vt__note" data-tone="warn" role="alert">
            This device has no voice that keeps your text on it. Choose one in Settings › Voice.
          </p>
        ) : null}
        <div className="fy-vt__row">
          {sample.reading ? (
            <Button type="button" variant="outline" size="sm" onClick={sample.stop} data-test-action="stop-sample">
              <Square size={14} aria-hidden="true" />
              <span className="ml-1">Stop</span>
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!sample.supported}
              onClick={() => sample.read(SAMPLE_LINE)}
              data-test-action="play"
            >
              <Play size={14} aria-hidden="true" />
              <span className="ml-1">Hear a sample</span>
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
