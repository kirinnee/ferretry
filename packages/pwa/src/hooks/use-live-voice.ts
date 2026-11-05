/**
 * LIVE VOICE: the ONE place in this app where speech sends a message.
 *
 * `use-dictation.ts` keeps its rule — nothing it recognises can ever reach a send — and this hook is
 * the deliberate exception: the person presses Live, and from then on a turn they speak is put in the
 * composer where they can see it, counted down on screen (Hold and Send now both one press away), and
 * sent through the composer's OWN send: the same route, grants, send ledger and audit as a typed
 * message. What is sent is exactly what the composer shows; the loop (`lib/voice-chat/live-machine.ts`)
 * cannot send from any state but the countdown, and a device that may not send gets no Live button.
 *
 * This file is only composition: it gathers what the page holds (the engine the person chose, the
 * conversation, the composer, the session), hands it to `assembleLivePorts`, runs one `LiveRunner` per
 * Live session, and mirrors the runner into React. It decides nothing and owns no timer but the
 * repaint ticker. Mic permission belongs to the tap, so `start()` calls the runner synchronously.
 *
 * The microphone is open only while Live is listening or about to send; it is closed while the ferret
 * works, in a hold, and when the tab is hidden. Audio never leaves the device except through the engine
 * the person chose (Browser voice sends it to the browser's maker, as it already says).
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { useDaemonFetch, useOnDeviceVoices, useParakeetVoice, useSpeedupKeys } from '../lib/store.tsx';
import { type BrowserRecognitionProvider, browserRecognitionProvider } from '../lib/stt/browser-recognition.ts';
import { browserMicMeter, type MicMeterGlobalLike, type MicMeterPort } from '../lib/stt/level-monitor.ts';
import type { OnDeviceVoice } from '../lib/stt/on-device-voice.ts';
import type { RemoteEnhancementFetch } from '../lib/stt/remote-enhancement.ts';
import type { DeviceSpeedupKeys } from '../lib/stt/speedup-keys.ts';
import { isOnDeviceEngine, type SttSettings } from '../lib/stt/stt-settings.ts';
import { DEFAULT_VOICE_CLEANUP, type VoiceCleanup } from '../lib/stt/voice-cleanup.ts';
import { browserClock, type ClockGlobalLike } from '../lib/voice-chat/clock.ts';
import { type AudioContextConstructor, navigatorHaptics, webAudioEarcons } from '../lib/voice-chat/earcons.ts';
import { assembleFromPage, type LiveComposerBridge, type LivePageInputs } from '../lib/voice-chat/live-assembly.ts';
import { INITIAL_LIVE_STATE } from '../lib/voice-chat/live-machine.ts';
import { createLiveReader, type LiveReadingSource } from '../lib/voice-chat/live-reader.ts';
import { LiveRunner, type LiveRunnerPorts } from '../lib/voice-chat/live-runner.ts';
import { DEFAULT_LIVE_VOICE_SETTINGS } from '../lib/voice-chat/live-settings.ts';
import { LiveTurnLog } from '../lib/voice-chat/live-turn-log.ts';
import { type LiveView, liveView } from '../lib/voice-chat/live-view.ts';
import { webMicLock } from '../lib/voice-chat/mic-lock.ts';
import { needsTapToListen } from '../lib/voice-chat/platform.ts';
import type { ReplySource } from '../lib/voice-chat/reply-feed.ts';
import { documentVisibility } from '../lib/voice-chat/visibility.ts';
import { gatedWakeLock, screenWakeLock } from '../lib/voice-chat/wake-lock.ts';
import { useDeviceVoiceSettingsStore } from './use-live-voice-settings.ts';
import { useReadAloudController } from './use-read-aloud.ts';

export interface UseLiveVoiceOptions {
  /** Live can be offered here: the composer may send, there is a session to watch, dictation is on. */
  readonly enabled: boolean;
  readonly daemon: DaemonConnection;
  /** The device's dictation settings with the engine resolved (a device that picked none uses its default). */
  readonly settings: SttSettings;
  /** The machine's clean-up settings; Live runs a configured Polish as Fix. */
  readonly voiceCleanup?: VoiceCleanup;
  readonly composer: LiveComposerBridge;
  /** The composer's draft now: a change nobody at the microphone made is the person typing. */
  readonly draft: string;
  readonly reply: ReplySource;
  /** The conversation on screen, oldest first, for clean-up's names. */
  readonly readConversation?: () => readonly string[];
  /** The hooks `readContext` rule of dictation: `(needsEvidence) → messages`. Supplied by the host bundle. */
  readonly readContext: (needsEvidence: boolean) => readonly string[];
  /**
   * The conversation on screen, for reading the reply aloud. Absent: Live shows the reply and listens again
   * (nothing is read). The voice, speed, length and the tones come from this device's voice settings.
   */
  readonly reading?: LiveReadingSource;
  /** Overrides the countdown from this device's Live voice settings (tests, the harness). */
  readonly graceMs?: unknown;
  /** Overrides the pause from this device's Live voice settings (tests, the harness). */
  readonly pauseMs?: unknown;
  // Seams for tests and the visual harness.
  readonly recognition?: BrowserRecognitionProvider;
  readonly meter?: MicMeterPort | null;
  readonly enhancementFetch?: RemoteEnhancementFetch;
  readonly voice?: OnDeviceVoice | null;
  readonly speedupKeys?: DeviceSpeedupKeys | null;
  /** Replaces the ports it names (tests): the machine and runner, and every port left out, are the real ones. */
  readonly ports?: Partial<LiveRunnerPorts>;
}

export interface LiveVoiceHandle {
  /** Live can be started here. */
  readonly available: boolean;
  /** Live is on (any phase but off). */
  readonly active: boolean;
  readonly view: LiveView;
  /** Level bars, 0..1, newest last. */
  readonly levels: readonly number[];
  /** The wake lock was refused: say "Screen may turn off". */
  readonly screenMayTurnOff: boolean;
  start(): void;
  hold(): void;
  sendNow(): void;
  resume(): void;
  end(): void;
  skip(): void;
  repeat(): void;
  /** A message was sent by hand (not by Live): a reading in progress belongs to an older turn. */
  outsideSend(): void;
}

const NO_LEVELS: readonly number[] = [];
const OFF_VIEW: LiveView = liveView(INITIAL_LIVE_STATE, 0);
const REPAINT_MS = 100;
/** A refusal (blocked microphone, another tab…) stays on the bar this long, then the bar goes away. */
export const NOTICE_MS = 10_000;

export function useLiveVoice(options: UseLiveVoiceOptions): LiveVoiceHandle {
  const contextVoice = useParakeetVoice();
  const contextVoices = useOnDeviceVoices();
  const contextKeys = useSpeedupKeys();
  const routedFetch = useDaemonFetch();
  const reader = useReadAloudController();
  const voiceSettings = useDeviceVoiceSettingsStore();
  const ambientRecognition = useMemo(() => browserRecognitionProvider(), []);
  const ambientMeter = useMemo(() => browserMicMeter(globalThis as unknown as MicMeterGlobalLike), []);
  const [, repaint] = useReducer((tick: number) => tick + 1, 0);
  const turns = useRef(new LiveTurnLog());
  const runnerRef = useRef<LiveRunner | null>(null);

  // Everything an adapter reads is read through this ref at the moment it needs it, so a setting changed
  // mid-Live applies to the next take and the runner never has to be rebuilt.
  const latest = useRef(options);
  latest.current = options;
  const engineVoice = (): OnDeviceVoice | null => {
    const current = latest.current;
    const engine = current.settings.engine;
    if (!isOnDeviceEngine(engine)) return null;
    if (current.voice !== undefined) return current.voice;
    return engine === 'parakeet'
      ? (contextVoices?.get('parakeet') ?? contextVoice)
      : (contextVoices?.get(engine) ?? null);
  };
  const voiceRef = useRef(engineVoice);
  voiceRef.current = engineVoice;
  const ambient = useRef({
    recognition: ambientRecognition,
    meter: ambientMeter,
    keys: contextKeys,
    fetch: routedFetch,
  });
  ambient.current = { recognition: ambientRecognition, meter: ambientMeter, keys: contextKeys, fetch: routedFetch };

  // The page's one voice and this device's choices, read when Live starts and again at each reading.
  const spoken = useRef({ reader, voiceSettings });
  spoken.current = { reader, voiceSettings };

  /** This device's Live voice choices as they are NOW (the store is read at the moment each one matters). */
  const deviceChoices = useCallback(
    () => (spoken.current.voiceSettings ?? { get: () => DEFAULT_LIVE_VOICE_SETTINGS }).get(),
    [],
  );

  const buildPorts = useCallback((): LiveRunnerPorts => {
    const current = latest.current;
    const clock = browserClock(globalThis as unknown as ClockGlobalLike);
    const visibility = documentVisibility(document);
    const nav = navigator as Navigator & {
      locks?: Parameters<typeof webMicLock>[0];
      wakeLock?: Parameters<typeof screenWakeLock>[0];
    };
    const read = (): LivePageInputs => {
      const page = latest.current;
      return {
        settings: page.settings,
        recognition: page.recognition ?? ambient.current.recognition,
        voice: voiceRef.current(),
        cleanup: page.voiceCleanup ?? DEFAULT_VOICE_CLEANUP,
        keys: page.speedupKeys === undefined ? ambient.current.keys : page.speedupKeys,
        daemon: page.daemon,
        fetchImpl: page.enhancementFetch ?? ambient.current.fetch,
        readContext: needsEvidence => page.readContext(needsEvidence),
        meter: page.meter === undefined ? ambient.current.meter : page.meter,
      };
    };
    const assembled = assembleFromPage(read, {
      composer: current.composer,
      reply: current.reply,
      reader:
        current.reading === undefined
          ? null
          : createLiveReader({
              controller: spoken.current.reader,
              source: current.reading,
              settings: deviceChoices,
              clock,
            }),
      earcons: webAudioEarcons(
        (globalThis as { AudioContext?: AudioContextConstructor; webkitAudioContext?: AudioContextConstructor })
          .AudioContext ?? (globalThis as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext,
      ),
      haptics: navigatorHaptics(nav as { vibrate?: (pattern: readonly number[]) => boolean }),
      clock,
      visibility,
      micLock: webMicLock(nav.locks),
      wakeLock: gatedWakeLock(screenWakeLock(nav.wakeLock, visibility), () => deviceChoices().keepAwake),
    });
    return current.ports === undefined ? assembled : { ...assembled, ...current.ports };
  }, [deviceChoices]);

  const stop = useCallback((): void => {
    runnerRef.current?.dispose();
    runnerRef.current = null;
  }, []);

  /** Called synchronously from the person's tap: the microphone prompt belongs to the gesture. */
  const start = useCallback((): void => {
    if (!latest.current.enabled) return;
    const live = runnerRef.current;
    if (live !== null && live.state.phase !== 'off') return;
    stop();
    const runner = new LiveRunner(buildPorts(), {
      canSend: latest.current.enabled,
      // The countdown, the pause and whether to read are taken as Live starts; a change applies from the next start.
      graceMs: latest.current.graceMs ?? deviceChoices().countdownMs,
      pauseMs: latest.current.pauseMs ?? deviceChoices().pause,
      tapToListen: needsTapToListen(typeof navigator === 'undefined' ? undefined : navigator),
      // Tones and buzzes follow this device's switch at the moment each one would sound.
      cues: () => deviceChoices().earcons,
      buzz: () => deviceChoices().haptics,
      readAloud: () => deviceChoices().liveRead,
      onTurn: numbers => turns.current.add(numbers),
    });
    runnerRef.current = runner;
    runner.subscribe(repaint);
    runner.start();
  }, [buildPorts, deviceChoices, stop]);

  const runner = runnerRef.current;
  const phase = runner?.state.phase ?? 'off';

  // A change to the composer's text that Live did not make is the person typing: auto-send pauses.
  const { draft, composer, enabled } = options;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a changed draft is a keystroke
  useEffect(() => {
    const live = runnerRef.current;
    if (live === null || live.state.phase === 'off') return;
    if (draft !== composer.lastShown()) live.typing();
  }, [draft]);

  // Live ends when it can no longer be offered (the composer was disabled, the session went), and with the page.
  useEffect(() => {
    if (enabled) return;
    stop();
    repaint();
  }, [enabled, stop]);
  useEffect(() => stop, [stop]);

  // A refusal says its words for a while and then leaves; the next press of Live starts clean anyway.
  const refused = phase === 'off' && runner?.state.notice != null;
  useEffect(() => {
    if (!refused) return;
    const timer = setTimeout(() => {
      stop();
      repaint();
    }, NOTICE_MS);
    return () => clearTimeout(timer);
  }, [refused, stop]);

  // The ring and the level bars repaint on a short ticker, only while there is something moving.
  const moving = phase === 'listening' || phase === 'hearing' || phase === 'sending' || phase === 'working';
  useEffect(() => {
    if (!moving) return;
    const timer = setInterval(repaint, phase === 'working' ? 1_000 : REPAINT_MS);
    return () => clearInterval(timer);
  }, [moving, phase]);

  const view =
    runner === null ? OFF_VIEW : liveView(runner.state, runner.now(), draft.trim() !== '', turns.current.last);

  return {
    available: enabled,
    active: phase !== 'off',
    view,
    levels: runner?.levels() ?? NO_LEVELS,
    screenMayTurnOff: runner?.screenMayTurnOff ?? false,
    start,
    hold: () => runnerRef.current?.hold(),
    sendNow: () => runnerRef.current?.sendNow(),
    resume: () => runnerRef.current?.resume(),
    end: () => runnerRef.current?.end(),
    skip: () => runnerRef.current?.skip(),
    repeat: () => runnerRef.current?.repeat(),
    outsideSend: () => runnerRef.current?.outsideSend(),
  };
}
