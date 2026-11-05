/**
 * PUTTING THE LIVE LOOP'S PORTS TOGETHER from what the page holds: the engine the person chose, the
 * composer, the session. This is the composition seam `hooks/use-live-voice.ts` calls with live values;
 * everything here is a function of its arguments, so it is tested with plain objects.
 *
 * NO ENGINE IS FORKED. A Live take makes the same sessions the mic button does: an on-device voice's
 * `createSession` (with live words off, so the early finish is offered), or the browser's own
 * recognition. The engine is the person's choice and Live never falls back to another: an engine that
 * is not chosen, not installed or not available is a refusal with words (`LiveBlock`).
 */

import {
  BrowserRecognitionSession,
  type BrowserRecognitionProvider,
  browserRecognitionErrorFrom,
} from '../stt/browser-recognition.ts';
import type { DaemonConnection } from '../daemon-connection.ts';
import type { MicMeterPort } from '../stt/level-monitor.ts';
import type { OnDeviceVoice } from '../stt/on-device-voice.ts';
import type { RemoteEnhancementFetch } from '../stt/remote-enhancement.ts';
import type { DeviceSpeedupKeys } from '../stt/speedup-keys.ts';
import { isOnDeviceEngine, type SttSettings } from '../stt/stt-settings.ts';
import type { VoiceCleanup } from '../stt/voice-cleanup.ts';
import { meterLevelFrames } from './level-frames.ts';
import { cleanLiveTurn, type LiveCleanupDeps } from './live-cleanup.ts';
import type { LiveRunnerPorts } from './live-runner.ts';
import { blockOf, type LiveSession, type LiveSessionCallbacks, liveTakePort } from './live-take.ts';
import type {
  ClockPort,
  LiveBlock,
  MicLockPort,
  ReplyFeedPort,
  SendPort,
  SpeakerPort,
  VisibilityPort,
  WakeLockPort,
} from './ports.ts';
import { type ReplySource, sessionReplyFeed } from './reply-feed.ts';

/** The composer, as Live drives it. `composer.tsx` implements it; nothing else sends from voice. */
export interface LiveComposerBridge {
  /** Replace this turn's words in the box (text typed before them stays in front). */
  show(words: string): void;
  /** Take this turn's words out of the box again. */
  clear(): void;
  /** What the box holds now. */
  draft(): string;
  /** What `show` last put in the box; null before the first. A draft that is not this was edited by a person. */
  lastShown(): string | null;
  /** The composer's own send, on exactly what the box holds: true once it is on its way. */
  submit(): Promise<boolean>;
}

export interface LiveEngineDeps {
  readonly settings: SttSettings;
  readonly recognition: BrowserRecognitionProvider;
  /** The voice of the chosen on-device engine; null when none is available here. */
  readonly voice: OnDeviceVoice | null;
}

/** A session over the chosen engine for a Live take, or the reason there is none. Never throws. */
export function createLiveSession(deps: LiveEngineDeps, callbacks: LiveSessionCallbacks): LiveSession | LiveBlock {
  const { engine } = deps.settings;
  if (engine === null) return 'engine-not-chosen';
  try {
    if (isOnDeviceEngine(engine)) {
      if (deps.voice === null || !deps.voice.support.available) return 'engine-missing';
      // Live words off: the early finish (`beginFinish`) is what makes the loop fast, and near-live re-reads its own window.
      return deps.voice.createSession({ ...callbacks, liveWords: false });
    }
    if (!deps.recognition.support.available)
      // An iPhone Home Screen app cannot run Browser voice at all (`support.availability` says so).
      return deps.recognition.support.availability === 'ios-home-screen' ? 'ios-browser-voice' : 'engine-failed';
    return new BrowserRecognitionSession(deps.recognition, callbacks);
  } catch (failure) {
    return blockOf(browserRecognitionErrorFrom(failure));
  }
}

export interface LiveAssemblyDeps {
  /** Read afresh at every call, so settings changed mid-Live apply to the next take. */
  readonly engine: () => LiveEngineDeps;
  readonly cleanup: () => LiveCleanupDeps;
  readonly meter: MicMeterPort | null;
  readonly composer: LiveComposerBridge;
  readonly reply: ReplySource;
  readonly speaker: SpeakerPort | null;
  readonly clock: ClockPort;
  readonly visibility: VisibilityPort;
  readonly micLock: MicLockPort;
  readonly wakeLock: WakeLockPort;
}

/** Every port the runner needs, built over the page's pieces. */
export function assembleLivePorts(deps: LiveAssemblyDeps): LiveRunnerPorts {
  const send: SendPort = {
    show: words => deps.composer.show(words),
    clear: () => deps.composer.clear(),
    shown: () => deps.composer.draft(),
    send: async () => {
      const sent = await deps.composer.submit();
      return sent ? { kind: 'sent', sentAtMs: deps.clock.now() } : { kind: 'failed', reason: 'not-sent' };
    },
  };
  const reply: ReplyFeedPort = sessionReplyFeed(deps.reply);
  return {
    take: liveTakePort({
      createSession: callbacks => createLiveSession(deps.engine(), callbacks),
      clean: (text, signal) => cleanLiveTurn(text, deps.cleanup(), signal),
    }),
    levels: meterLevelFrames(deps.meter, deps.clock),
    send,
    reply,
    speaker: deps.speaker,
    wakeLock: deps.wakeLock,
    visibility: deps.visibility,
    micLock: deps.micLock,
    clock: deps.clock,
  };
}

/** Everything the page holds that a Live take reads, gathered at the moment it is read. */
export interface LivePageInputs {
  readonly settings: SttSettings;
  readonly recognition: BrowserRecognitionProvider;
  readonly voice: OnDeviceVoice | null;
  readonly cleanup: VoiceCleanup;
  readonly keys: DeviceSpeedupKeys | null;
  readonly daemon: DaemonConnection;
  readonly fetchImpl: RemoteEnhancementFetch;
  readonly readContext: (needsEvidence: boolean) => readonly string[];
  readonly meter: MicMeterPort | null;
}

/** The environment Live runs in: the composer, the session, and the page's clock and locks. */
export interface LiveEnvironment {
  readonly composer: LiveComposerBridge;
  readonly reply: ReplySource;
  readonly speaker: SpeakerPort | null;
  readonly clock: ClockPort;
  readonly visibility: VisibilityPort;
  readonly micLock: MicLockPort;
  readonly wakeLock: WakeLockPort;
}

/**
 * The ports over what the page holds, read through `read` at the moment each is needed — so a setting
 * changed mid-Live applies to the next take, and nothing here is captured stale.
 */
export function assembleFromPage(read: () => LivePageInputs, environment: LiveEnvironment): LiveRunnerPorts {
  return assembleLivePorts({
    ...environment,
    engine: () => {
      const page = read();
      return { settings: page.settings, recognition: page.recognition, voice: page.voice };
    },
    cleanup: () => {
      const page = read();
      return {
        settings: page.settings,
        cleanup: page.cleanup,
        keys: page.keys,
        daemon: page.daemon,
        fetchImpl: page.fetchImpl,
        readContext: page.readContext,
      };
    },
    // Ports are built when Live starts, so the meter is the one the page has then.
    meter: read().meter,
  });
}
