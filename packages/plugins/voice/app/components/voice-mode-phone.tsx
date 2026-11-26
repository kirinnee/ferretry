/**
 * VOICE MODE ON THE PHONE'S OWN ENGINE: the fallback for when the machine cannot serve it.
 *
 * It is the same panel as the machine's (same words, same two buttons, same composer hiding) but the loop is this device's:
 * the dictation engine the person already chose listens, a pause ends the take, the words are sent to the ferret through
 * the ordinary send route as `(voice) <words>`, and the replies are read by the device's voice (Voice mode turns Auto-read
 * on). It never starts by itself: the machine is always tried first, and a banner in the panel says why this one is running
 * for as long as it is (the machine could not be reached, was lost mid-chat, or the person asked for audio to stay here).
 *
 * WHAT IS REUSED. `useDictation` is the dictation engine's own state machine, so every engine the person can choose (Parakeet
 * on this device, the browser's voice, the others) works here with its own installs and limits, and it is driven exactly as
 * a person would: start, stop on a pause, take the words (`afterDictation: 'insert'`, into an empty draft that is never
 * shown). Nothing is logged to the transcription log: voice mode is not a dictation the person asked to keep.
 *
 * THE MICROPHONE IS OFF WHILE A REPLY IS READ ALOUD (until barge-in, a later unit), by stopping the take, so the engine
 * cannot hear the reply and send it back as the person's own words.
 */
import { Mic, MicOff, Square } from 'lucide-react';
import './voice-mode.css';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ConversationComposerProps } from '@ferretry/plugin-conversation/contract';
import { type UseDictationOptions, useDictation } from '../hooks/use-dictation.ts';
import { useReadAloudController } from '../hooks/use-read-aloud.ts';
import type { SttSettings } from '../lib/stt/stt-settings.ts';
import { PauseWatcher } from '../lib/voice-mode/phone-loop.ts';
import { ENTRY_RENEW_MS } from '../../contract/index.ts';
import { enterVoice, newSessionKey, sendIdOf, sendSpoken } from '../lib/voice-mode/phone-send.ts';
import type { VoiceModeStore } from '../lib/voice-mode/voice-mode-store.ts';
import { Button, type DaemonConnection, type VoicePluginClient } from '../shell-voice.ts';
import { inputRms, waveformAnalyser } from './input-waveform.tsx';

type Turn = ConversationComposerProps['turn'];

/** How often the microphone's level is read to find the pause. */
const LEVEL_POLL_MS = 100;
/** The least gap between two takes, so an engine that ends at once cannot spin. */
const RESTART_MS = 250;
const NOTE_OF_SENT = 'Sent.';

export interface PhoneSessionProps {
  readonly ferretId: string;
  readonly machine: string;
  /** Why the loop is on the phone, said in the panel for as long as it is. */
  readonly banner: string;
  readonly store: VoiceModeStore;
  readonly client: Pick<VoicePluginClient, 'call'>;
  readonly turn: Turn | undefined;
  /** This device's dictation settings: which engine listens. */
  readonly settings: SttSettings;
  readonly daemon: DaemonConnection;
  /** A suite supplies the recognition engine, the meter and the clocks; the page uses the browser's. */
  readonly dictation?: Partial<UseDictationOptions>;
  readonly now?: () => number;
}

export function PhoneSession({
  ferretId,
  machine,
  banner,
  store,
  client,
  turn,
  settings,
  daemon,
  dictation: overrides,
  now = () => globalThis.performance.now(),
}: PhoneSessionProps) {
  const [userMuted, setUserMuted] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const sessionKey = useRef<string | null>(null);
  sessionKey.current ??= newSessionKey();
  const turnNumber = useRef(0);
  /** Sends go out one at a time, in the order they were spoken. */
  const sending = useRef<Promise<void>>(Promise.resolve());
  const alive = useRef(true);

  const reader = useReadAloudController();
  const isReading = (): boolean => reader.getState().status === 'reading';
  const reading = useSyncExternalStore(reader.subscribe, isReading, isReading);
  const muted = userMuted || reading;

  const deliver = useCallback(
    (spoken: string): void => {
      const text = spoken.trim();
      if (text === '') return;
      turnNumber.current += 1;
      const sendId = sendIdOf(sessionKey.current as string, turnNumber.current);
      sending.current = sending.current.then(async () => {
        const result = await sendSpoken(client, ferretId, text, sendId);
        if (!alive.current) return;
        setNote(result.ok ? NOTE_OF_SENT : `Not sent: ${result.sentence}`);
      });
    },
    [client, ferretId],
  );

  const handle = useDictation({
    daemon,
    draft: '',
    // The words go straight on: a review box would wait for a hand the person does not have free.
    settings: { ...settings, afterDictation: 'insert' },
    onDraft: result => deliver(result.text),
    transcriptionLog: null,
    dictationDebug: null,
    ...overrides,
  });
  const live = useRef(handle);
  live.current = handle;

  // A take that could not go in unseen (a clean-up that failed) is parked for review; here it is sent as it stands.
  useEffect(() => {
    if (handle.review === null) return;
    deliver(handle.review.cleaned === '' ? handle.review.raw : handle.review.cleaned);
    handle.discard();
  }, [deliver, handle.discard, handle.review]);

  // Voice mode is on here (entered, or handed over from the machine inside the same session): the machine tells the ferret once
  // for the whole chat, and the claim is renewed while this phone stays in it.
  useEffect(() => {
    const session = store.get(ferretId).session;
    if (session === '') return undefined;
    void enterVoice(client, ferretId, session);
    const renew = setInterval(() => void enterVoice(client, ferretId, session), ENTRY_RENEW_MS);
    return () => clearInterval(renew);
  }, [client, ferretId, store]);

  // An engine that cannot listen ends voice mode and says why: nothing else would ever send.
  useEffect(() => {
    if (handle.error === null) return;
    store.end(ferretId, handle.error.message);
  }, [ferretId, handle.error, store]);

  useEffect(
    () => () => {
      alive.current = false;
      live.current.cancel();
    },
    [],
  );

  // The loop: listen whenever nothing stops it, and a moment after each take ends listen again.
  const phase = handle.phase;
  useEffect(() => {
    if (muted) {
      if (phase === 'recording' || phase === 'requesting') live.current.cancel();
      return undefined;
    }
    if (phase !== 'idle') return undefined;
    const timer = setTimeout(() => live.current.start(), RESTART_MS);
    return () => clearTimeout(timer);
  }, [muted, phase]);

  // The pause: speech was heard, then PAUSE_MS of quiet. Read from the microphone's own level when the engine lends one, and
  // from the words standing still when it does not (the browser's voice owns its microphone).
  const monitor = handle.inputMonitor;
  const heardText = useRef('');
  heardText.current = handle.liveText;
  useEffect(() => {
    if (phase !== 'recording') return undefined;
    const watcher = new PauseWatcher();
    const tap = monitor?.createAnalyser() ?? null;
    const analyser = tap === null ? null : waveformAnalyser(tap.analyser);
    const buffer = new Float32Array(analyser?.fftSize ?? 0);
    let previous = heardText.current;
    const timer = setInterval(() => {
      let level: number;
      if (analyser !== null) {
        analyser.getFloatTimeDomainData(buffer);
        level = inputRms(buffer);
      } else {
        level = heardText.current !== previous ? 1 : 0;
        previous = heardText.current;
      }
      if (watcher.feed(level, now())) live.current.stop();
    }, LEVEL_POLL_MS);
    return () => {
      clearInterval(timer);
      tap?.disconnect();
    };
  }, [monitor, now, phase]);

  const end = useCallback(() => store.end(ferretId), [store, ferretId]);
  const working = turn?.live === true && turn.state === 'working' && !muted;
  const state = muted
    ? 'muted'
    : working
      ? 'working'
      : phase === 'recording'
        ? handle.liveText === ''
          ? 'listening'
          : 'hearing'
        : 'loading';
  const status = reading
    ? 'Reading the reply. Your microphone is off until it is done.'
    : muted
      ? 'Muted. Nothing you say is heard.'
      : working
        ? 'Working… you can keep talking.'
        : phase === 'transcribing'
          ? 'Turning that into words on this phone…'
          : phase === 'recording'
            ? handle.liveText === ''
              ? 'Listening on this phone. Just talk.'
              : 'Hearing you…'
            : 'Opening the microphone on this phone…';

  return (
    <section
      aria-label="Voice mode"
      className="fy-voice-mode"
      data-engine="phone"
      data-machine={machine}
      data-state={state}
      data-voice-mode="on"
    >
      <p className="fy-voice-mode__banner" data-voice-mode-banner="" role="status">
        {banner}
      </p>
      <p aria-live="polite" className="fy-voice-mode__status" data-voice-mode-status="" role="status">
        <span aria-hidden="true" className="fy-voice-mode__dot" />
        {status}
      </p>
      <p
        aria-live="polite"
        className="fy-voice-mode__words"
        data-final={handle.liveInterim === '' ? 'true' : 'false'}
        data-voice-mode-words=""
      >
        {handle.liveText}
      </p>
      {note === null ? null : (
        <p className="fy-voice-mode__note" data-voice-mode-outcome="">
          {note}
        </p>
      )}
      <div className="fy-voice-mode__actions">
        <Button
          aria-pressed={userMuted}
          data-voice-mode-mute=""
          onClick={() => setUserMuted(value => !value)}
          type="button"
        >
          {userMuted ? <MicOff aria-hidden="true" size={16} /> : <Mic aria-hidden="true" size={16} />}
          {userMuted ? 'Unmute' : 'Mute'}
        </Button>
        <Button data-voice-mode-end="" onClick={end} type="button" variant="primary">
          <Square aria-hidden="true" size={16} /> End voice mode
        </Button>
      </div>
    </section>
  );
}
