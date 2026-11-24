/**
 * THE MACHINE'S REPLY VOICE AS A SPEAKER. A `SpeakerPort` over the voice stream: the reading controller hands it the
 * captions of a reply (the `<voice>` lines), each is sent to the machine to be spoken in Kokoro, and the sound comes back
 * down the same stream into the player. Voice mode attaches it to the page's read-aloud controller for as long as it is on,
 * so Auto-read, the chip and "stop" all work on it as they do on the device's own voice.
 *
 * WHAT IT TELLS THE CONTROLLER
 *
 *   - `unavailable` BEFORE any sound was heard, whether the machine has no reply voice or it failed on the first line: the
 *     controller then reads the same words in the device's own voice, so a reply is never silent and never said twice.
 *   - `failed` AFTER sound was heard: the person heard its start, so it is not read again by another voice.
 *   - `segment` when a caption's first sound arrives, `end` once all of it has arrived AND been played, `stopped` after
 *     `stop()` (the person's own "stop", or barge-in).
 *
 * `stop()` silences the player and tells the machine to drop what it has not yet spoken. Nothing here keeps the words.
 */
import type { ReplyState } from '../../../contract/index.ts';
import type { SpeakerEvent, SpeakerPort, SpeakRequest } from '../voice-chat/ports.ts';
import type { ReplyPlayer, SpeechLineEvent, VoiceStreamHandle } from '../stream/voice-stream.ts';

export interface MachineSpeakerDeps {
  /** The open stream, once there is one. */
  readonly stream: () => Pick<VoiceStreamHandle, 'speak' | 'hush'> | undefined;
  /** Where the machine's reply voice is; `undefined` before the stream said. */
  readonly replyState: () => ReplyState | undefined;
  readonly player: Pick<ReplyPlayer, 'remainingMs'>;
  /** Told when the machine's voice starts and stops being the one reading, so the panel knows whose sound is on. */
  readonly onActive?: (active: boolean) => void;
  /** Runs `tick` every `ms` until the returned function is called. A suite supplies its own clock. */
  readonly every?: (tick: () => void, ms: number) => () => void;
}

export interface MachineSpeaker extends SpeakerPort {
  /** Feed every `onSpeech` event of the stream here. */
  onSpeech(event: SpeechLineEvent): void;
}

/** How often a finished line is checked for having been heard to its end. */
const DRAIN_CHECK_MS = 100;

interface Reading {
  readonly onEvent: (event: SpeakerEvent) => void;
  /** Stream line id → the caption it belongs to. */
  readonly captions: ReadonlyMap<number, number>;
  readonly pending: Set<number>;
  heard: boolean;
  caption: number;
  stopDrain: (() => void) | null;
}

const setIntervalClock = (tick: () => void, ms: number): (() => void) => {
  const timer = setInterval(tick, ms);
  return () => clearInterval(timer);
};

export function createMachineSpeaker(deps: MachineSpeakerDeps): MachineSpeaker {
  const every = deps.every ?? setIntervalClock;
  let current: Reading | null = null;

  const finish = (reading: Reading, event: SpeakerEvent, hush: boolean): void => {
    if (current !== reading) return;
    current = null;
    reading.stopDrain?.();
    if (hush) deps.stream()?.hush();
    deps.onActive?.(false);
    reading.onEvent(event);
  };

  return {
    supported: true,
    voices: () => [],
    unlock: () => undefined,
    speak(request: SpeakRequest, onEvent) {
      if (current !== null) finish(current, { type: 'stopped' }, true);
      const stream = deps.stream();
      if (stream === undefined || deps.replyState() === 'absent') {
        onEvent({ type: 'error', reason: 'unavailable' });
        return;
      }
      const captions = new Map<number, number>();
      request.segments.forEach((segment, index) => {
        for (const line of stream.speak(segment)) captions.set(line.id, index);
      });
      if (captions.size === 0) {
        onEvent({ type: 'error', reason: 'unavailable' });
        return;
      }
      current = { onEvent, captions, pending: new Set(captions.keys()), heard: false, caption: -1, stopDrain: null };
      deps.onActive?.(true);
    },
    stop() {
      if (current !== null) finish(current, { type: 'stopped' }, true);
    },
    onSpeech(event) {
      const reading = current;
      const caption = reading?.captions.get(event.id);
      if (reading === null || caption === undefined) return;
      if (event.event === 'started') {
        reading.heard = true;
        if (caption !== reading.caption) {
          reading.caption = caption;
          reading.onEvent({ type: 'segment', index: caption });
        }
      } else if (event.event === 'failed') {
        // Nothing was heard: another voice may read it all. Something was: the rest is dropped, never read again.
        finish(reading, { type: 'error', reason: reading.heard ? 'failed' : 'unavailable' }, true);
      } else {
        reading.pending.delete(event.id);
        if (reading.pending.size === 0) {
          // All the sound is here; the reading ends when it has been heard.
          reading.stopDrain = every(() => {
            if (deps.player.remainingMs() <= 0) finish(reading, { type: 'end' }, false);
          }, DRAIN_CHECK_MS);
        }
      }
    },
  };
}
