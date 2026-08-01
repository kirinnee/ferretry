/**
 * A truthful microphone indicator.
 *
 * The recorder hands this component a read-only analyser branch off the exact
 * stream and audio graph it is already using; this file never asks for device
 * access and never creates a second audio graph. The Web Audio objects and the
 * paint loop live entirely behind refs, so a 20 fps waveform is not 20 React
 * renders (which would wake the composer and the transcript with it).
 *
 * WHAT CHANGED FROM kteam (`ui/src/components/InputWaveform.tsx`). There, the
 * analyser arrived as a real `AnalyserNode` because capture built its Web Audio
 * graph inline. Here capture's graph is a PORT (`lib/stt/audio-capture.ts`), so
 * `CaptureAnalyserTap.analyser` is `unknown` — anything at all. It is therefore
 * PARSED at this boundary rather than cast: `waveformAnalyser` returns null for
 * a tap that cannot answer `getFloatTimeDomainData`, and the component says the
 * meter is unavailable instead of throwing inside a rAF callback. That is the
 * one behavioural difference, and it only fires where kteam would have crashed.
 */

import { useEffect, useRef } from 'react';
import type { CaptureAnalyserTap } from '../lib/stt/audio-capture.ts';

const INPUT_WAVEFORM_FPS = 20;
export const NO_SIGNAL_AFTER_MS = 3_000;
/** Roughly -42 dBFS: below ordinary speech, above numerical/self-noise. */
const NO_SIGNAL_RMS_FLOOR = 0.008;

const FRAME_INTERVAL_MS = 1_000 / INPUT_WAVEFORM_FPS;
const SPEECH_RMS_REFERENCE = 0.12;
const ANALYSER_FFT_SIZE = 512;
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** The analyser slice this meter uses. Nothing about Web Audio nodes leaks in. */
export interface WaveformAnalyser {
  fftSize: number;
  smoothingTimeConstant: number;
  minDecibels: number;
  maxDecibels: number;
  getFloatTimeDomainData(target: Float32Array): void;
}

/** The read-only analyser factory shared with the recorder's live capture. */
export interface CaptureMonitor {
  createAnalyser(): CaptureAnalyserTap | null;
}

/**
 * Parse the port's `unknown` analyser. A host that hands back something that
 * cannot report time-domain samples has no meter to offer, and saying so is
 * better than a `TypeError` raised inside an animation frame.
 */
export const waveformAnalyser = (value: unknown): WaveformAnalyser | null => {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { getFloatTimeDomainData?: unknown };
  return typeof candidate.getFloatTimeDomainData === 'function' ? (value as WaveformAnalyser) : null;
};

export interface NoSignalReading {
  silentSince: number | null;
  noSignal: boolean;
}

/** RMS is the actual energy in the analyser's time-domain samples. */
export function inputRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let squares = 0;
  for (const sample of samples) {
    const finite = Number.isFinite(sample) ? sample : 0;
    squares += finite * finite;
  }
  return Math.sqrt(squares / samples.length);
}

/**
 * Map real input energy to a legible 0..1 display level. The noise gate keeps
 * silence flat; the square root makes conversational speech visible without
 * pretending a tiny noise floor is a loud voice.
 */
export function displayLevel(rms: number): number {
  if (!Number.isFinite(rms) || rms <= NO_SIGNAL_RMS_FLOOR) return 0;
  const linear = Math.min(1, (rms - NO_SIGNAL_RMS_FLOOR) / (SPEECH_RMS_REFERENCE - NO_SIGNAL_RMS_FLOOR));
  return Math.sqrt(linear);
}

/**
 * A transition-only signal detector. Callers keep `silentSince` in a local
 * variable, not React state, and only reveal or hide the status node when the
 * boolean changes.
 */
export function nextNoSignalReading(
  silentSince: number | null,
  rms: number,
  now: number,
  delayMs = NO_SIGNAL_AFTER_MS,
  floor = NO_SIGNAL_RMS_FLOOR,
): NoSignalReading {
  if (rms > floor) return { silentSince: null, noSignal: false };
  const since = silentSince === null || now < silentSince ? now : silentSince;
  return { silentSince: since, noSignal: now - since >= delayMs };
}

interface PaintOptions {
  samples: Float32Array;
  level: number;
  reducedMotion: boolean;
  color: string;
  pixelRatio: number;
}

/**
 * Paint either the live waveform or the reduced-motion level meter. Exported so
 * both modes can be verified without pretending a test has a microphone.
 */
export function paintInputLevel(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  { samples, level, reducedMotion, color, pixelRatio }: PaintOptions,
): void {
  const bounds = canvas.getBoundingClientRect();
  const width = Math.max(1, bounds.width || canvas.clientWidth || 320);
  const height = Math.max(1, bounds.height || canvas.clientHeight || 56);
  const scale = Math.min(2, Math.max(1, Number.isFinite(pixelRatio) ? pixelRatio : 1));
  const bitmapWidth = Math.max(1, Math.round(width * scale));
  const bitmapHeight = Math.max(1, Math.round(height * scale));
  if (canvas.width !== bitmapWidth) canvas.width = bitmapWidth;
  if (canvas.height !== bitmapHeight) canvas.height = bitmapHeight;

  // Width/height assignments reset canvas state, so establish the CSS-pixel
  // coordinate system every frame even when no resize happened.
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, width, height);
  context.save();
  context.fillStyle = color;
  context.strokeStyle = color;

  if (reducedMotion) {
    const meterHeight = Math.max(4, Math.min(8, height * 0.16));
    const top = (height - meterHeight) / 2;
    context.globalAlpha = 0.18;
    context.fillRect(0, top, width, meterHeight);
    context.globalAlpha = 0.95;
    context.fillRect(0, top, width * Math.min(1, Math.max(0, level)), meterHeight);
    context.restore();
    return;
  }

  // Silence has a quiet centre line rather than an animated-looking minimum.
  context.globalAlpha = 0.22;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, height / 2);
  context.lineTo(width, height / 2);
  context.stroke();

  if (level > 0 && samples.length > 1) {
    let peak = 0;
    for (const sample of samples) peak = Math.max(peak, Math.abs(Number.isFinite(sample) ? sample : 0));
    if (peak > 0) {
      const amplitude = height * 0.42 * Math.min(1, Math.max(0, level));
      context.globalAlpha = 0.95;
      context.lineWidth = 1.5;
      context.beginPath();
      for (let index = 0; index < samples.length; index += 1) {
        const x = (index / (samples.length - 1)) * width;
        const sample = Number.isFinite(samples[index]) ? (samples[index] as number) : 0;
        const y = height / 2 - (sample / peak) * amplitude;
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.stroke();
    }
  }
  context.restore();
}

/** The browser facts the paint loop needs, so a test supplies a plain object. */
export interface InputWaveformRuntime {
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(handle: number): void;
  reducedMotion: MediaQueryList | null;
  pixelRatio: number;
  color: string;
}

interface StartInputWaveformOptions {
  monitor: CaptureMonitor;
  canvas: HTMLCanvasElement;
  noSignalElement: HTMLElement;
  runtime: InputWaveformRuntime;
}

/**
 * Stand up the analyser and the rAF loop. The analyser is a disposable branch of
 * the recorder's graph; the recorder remains the sole owner of its context,
 * source and tracks. The returned cleanup is synchronous and idempotent.
 */
export function startInputWaveform({
  monitor,
  canvas,
  noSignalElement,
  runtime,
}: StartInputWaveformOptions): () => void {
  const drawing = canvas.getContext('2d');
  if (!drawing) return () => undefined;

  const tap = monitor.createAnalyser();
  if (!tap) throw new Error('The recorder audio graph cannot provide an analyser.');
  const analyser = waveformAnalyser(tap.analyser);
  if (analyser === null) {
    // The branch exists but cannot report samples. Give it straight back rather
    // than holding a node this meter can do nothing with.
    try {
      tap.disconnect();
    } catch {
      /* capture release may already have disconnected the branch */
    }
    throw new Error('The recorder audio graph cannot report input levels.');
  }
  let frameHandle: number | null = null;
  let disposed = false;
  let graphClosed = false;
  let reducedMotion = runtime.reducedMotion?.matches === true;
  let lastPaintAt = Number.NEGATIVE_INFINITY;
  let silentSince: number | null = null;
  let noSignalVisible = false;

  const closeGraph = (): void => {
    if (graphClosed) return;
    graphClosed = true;
    try {
      tap.disconnect();
    } catch {
      /* capture release may already have disconnected the branch */
    }
  };

  try {
    analyser.fftSize = ANALYSER_FFT_SIZE;
    analyser.smoothingTimeConstant = 0.5;
    analyser.minDecibels = -90;
    analyser.maxDecibels = -10;
  } catch (error) {
    closeGraph();
    throw error;
  }

  const samples = new Float32Array(analyser.fftSize);
  const onReducedMotion = (event: MediaQueryListEvent): void => {
    reducedMotion = event.matches;
    lastPaintAt = Number.NEGATIVE_INFINITY;
  };
  const reducedQuery = runtime.reducedMotion;
  let removeReducedMotionListener = (): void => undefined;
  try {
    if (reducedQuery) {
      // Older WebKit exposes only addListener/removeListener. Feature-detecting
      // avoids turning a compatibility nicety into a leaked analyser branch.
      if (typeof reducedQuery.addEventListener === 'function') {
        reducedQuery.addEventListener('change', onReducedMotion);
        removeReducedMotionListener = () => reducedQuery.removeEventListener('change', onReducedMotion);
      } else if (typeof reducedQuery.addListener === 'function') {
        reducedQuery.addListener(onReducedMotion);
        removeReducedMotionListener = () => reducedQuery.removeListener(onReducedMotion);
      }
    }
  } catch (error) {
    closeGraph();
    throw error;
  }

  const cleanup = (): void => {
    if (disposed) return;
    disposed = true;
    if (frameHandle !== null) {
      try {
        runtime.cancelFrame(frameHandle);
      } catch {
        /* the document may already be tearing down */
      }
    }
    try {
      removeReducedMotionListener();
    } catch {
      /* the media query object may already be detached */
    }
    closeGraph();
  };

  const draw = (now: number): void => {
    if (disposed) return;
    // This handle has fired. Keeping it would make cleanup cancel a stale id if
    // a canvas or analyser call below failed before the next frame was queued.
    frameHandle = null;
    try {
      if (now < lastPaintAt || now - lastPaintAt >= FRAME_INTERVAL_MS) {
        lastPaintAt = now;
        analyser.getFloatTimeDomainData(samples);
        const rms = inputRms(samples);
        const reading = nextNoSignalReading(silentSince, rms, now);
        silentSince = reading.silentSince;
        if (reading.noSignal !== noSignalVisible) {
          noSignalVisible = reading.noSignal;
          noSignalElement.hidden = !reading.noSignal;
        }
        paintInputLevel(canvas, drawing, {
          samples,
          level: displayLevel(rms),
          reducedMotion,
          color: runtime.color,
          pixelRatio: runtime.pixelRatio,
        });
      }
      frameHandle = runtime.requestFrame(draw);
    } catch {
      // A detached canvas or document should end the monitor, not strand its
      // analyser branch after rAF stops calling us.
      cleanup();
    }
  };
  try {
    frameHandle = runtime.requestFrame(draw);
  } catch (error) {
    cleanup();
    throw error;
  }

  return cleanup;
}

/** The real browser runtime. Built here, never reached for inside the loop. */
export function browserWaveformRuntime(canvas: HTMLCanvasElement): InputWaveformRuntime | null {
  if (typeof window === 'undefined') return null;
  return {
    requestFrame: callback => window.requestAnimationFrame(callback),
    cancelFrame: handle => window.cancelAnimationFrame(handle),
    reducedMotion: window.matchMedia?.(REDUCED_MOTION_QUERY) ?? null,
    pixelRatio: window.devicePixelRatio || 1,
    color: window.getComputedStyle(canvas).color || '#3b82f6',
  };
}

export interface InputWaveformProps {
  readonly monitor: CaptureMonitor | null;
  /** Injected by tests and the visual harness; the browser runtime otherwise. */
  readonly runtime?: (canvas: HTMLCanvasElement) => InputWaveformRuntime | null;
}

export function InputWaveform({ monitor, runtime = browserWaveformRuntime }: InputWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const noSignalRef = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const noSignalElement = noSignalRef.current;
    if (!monitor || !canvas || !noSignalElement) return;
    const host = runtime(canvas);
    if (!host) return;
    try {
      return startInputWaveform({ monitor, canvas, noSignalElement, runtime: host });
    } catch {
      // Recording can still succeed if the browser refuses an analyser branch.
      // Name the unavailable meter without misreporting it as a dead mic.
      noSignalElement.textContent = 'Microphone level monitor unavailable.';
      noSignalElement.hidden = false;
      return;
    }
  }, [monitor, runtime]);

  return (
    <div className="flex flex-col gap-xs">
      {/* The meter is decorative: the spoken equivalent is the status line
          below. `aria-hidden` sits on the wrapper because biome treats a
          `<canvas>` as focusable, and hiding a focusable element is the trap
          `noAriaHiddenOnFocusable` exists to catch. */}
      <div
        aria-hidden="true"
        className="overflow-hidden rounded-control border border-border-soft bg-surface-2 px-2 text-accent"
      >
        <canvas ref={canvasRef} width={640} height={112} className="block h-14 w-full" />
      </div>
      <p ref={noSignalRef} hidden role="status" aria-live="polite" className="text-meta text-warn">
        No microphone signal yet. Check that your mic is unmuted and the right input is selected.
      </p>
    </div>
  );
}
