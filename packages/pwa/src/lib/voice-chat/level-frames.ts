/**
 * THE MICROPHONE'S LOUDNESS, 20 ms at a time, for the endpointer — from a meter-only stream Live opens
 * for itself (`level-monitor.ts`): a read-only `AnalyserNode` that records nothing and plays nothing,
 * released the moment the microphone closes. One source for every engine, so a pause is judged the same
 * whichever engine transcribes (docs/voice.md › Pause detection).
 *
 * The loop is a chain of short timers on the injected clock, not `requestAnimationFrame`: a hidden tab
 * throttles both, and the endpointer already treats frames far apart as a stall. A frame that cannot be
 * read is skipped, never faked.
 */

import { FRAME_MS, rms } from '../stt/energy.ts';
import type { MicMeterPort } from '../stt/level-monitor.ts';
import type { ClockPort, LevelFramesPort } from './ports.ts';

interface AnalyserLike {
  fftSize: number;
  getFloatTimeDomainData(buffer: Float32Array<ArrayBuffer>): void;
}

/** About 20 ms of audio at 44.1–48 kHz. */
const WINDOW_SAMPLES = 1_024;
/** The room's recent levels kept for a new endpointer's noise floor: 10 s of frames. */
const RECENT_FRAMES = 500;

export function meterLevelFrames(meters: MicMeterPort | null, clock: ClockPort): LevelFramesPort {
  return {
    open: async onFrame => {
      if (meters === null) return null;
      const meter = await meters.open();
      if (meter === null) return null;
      const tap = meter.monitor.createAnalyser();
      if (tap === null) {
        meter.release();
        return null;
      }
      const analyser = tap.analyser as AnalyserLike;
      analyser.fftSize = WINDOW_SAMPLES;
      const samples = new Float32Array(new ArrayBuffer(WINDOW_SAMPLES * Float32Array.BYTES_PER_ELEMENT));
      let recent: number[] = [];
      let stopped = false;
      let cancel: (() => void) | null = null;

      const tick = (): void => {
        if (stopped) return;
        try {
          analyser.getFloatTimeDomainData(samples);
          const level = rms(samples, 0, samples.length);
          recent = [...recent.slice(1 - RECENT_FRAMES), level];
          onFrame({ atMs: clock.now(), rms: level });
        } catch {
          // An analyser that cannot be read this time: no frame, the next tick tries again.
        }
        if (!stopped) cancel = clock.after(FRAME_MS, tick);
      };
      cancel = clock.after(FRAME_MS, tick);

      return {
        recent: () => recent,
        release: () => {
          stopped = true;
          cancel?.();
          cancel = null;
          tap.disconnect();
          meter.release();
        },
      };
    },
  };
}
