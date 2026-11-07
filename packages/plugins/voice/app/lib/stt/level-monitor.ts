/**
 * The tap that lets the dictation panel show the microphone's level.
 *
 * A tap is a read-only `AnalyserNode` hung off a `MediaStream` that something else already owns. It
 * is never connected to a destination, so it cannot play anything back, and disconnecting it never
 * touches the stream's tracks: whoever opened the microphone remains the only one who closes it.
 *
 * Two owners hand a stream to `streamMonitor`:
 *
 *   - Parakeet records the stream itself (`audio-capture.ts`), so the meter taps THAT stream. No
 *     second `getUserMedia`, no second permission, and the bars move for exactly the audio that is
 *     being transcribed.
 *   - Browser speech recognition owns its own microphone and exposes no amplitude, so there is no
 *     stream to tap. `openMicMeter` opens a meter-only stream beside it. It records nothing, it is
 *     released the moment dictation ends, and a refusal is silent: the meter is a visual aid, so
 *     failing to open it must never cost the reader their dictation.
 */

/** A visual-only branch off an already-running audio graph. */
export interface CaptureAnalyserTap {
  readonly analyser: unknown;
  /** Disconnect this branch without touching the stream or its tracks. */
  disconnect(): void;
}

/** The read-only analyser factory handed to the meter. */
export interface CaptureMonitor {
  createAnalyser(): CaptureAnalyserTap | null;
}

interface MeterTrackLike {
  stop(): void;
}

/** A stream a tap can be hung off. The real `MediaStream` satisfies it. */
export interface MeterStreamLike {
  getTracks(): readonly MeterTrackLike[];
}

interface MeterNodeLike {
  connect(destination: unknown): unknown;
  disconnect(): void;
}

interface MeterAudioContextLike {
  createMediaStreamSource(stream: never): MeterNodeLike;
  createAnalyser(): unknown;
  resume?(): Promise<void>;
  close(): Promise<void>;
}

/** The slice of the page the tap needs, so a test supplies plain objects. */
export interface MeterAudioGlobalLike {
  readonly AudioContext?: new () => MeterAudioContextLike;
}

const quietly = (action: () => unknown): void => {
  try {
    const result = action();
    if (result instanceof Promise) result.catch(() => undefined);
  } catch {
    // Already torn down, or the context refused: a tap going away is never an error.
  }
};

type MeterAudioContextConstructor = new () => MeterAudioContextLike;

/** Each `createAnalyser` makes its own context and its `disconnect` closes it, so two meters never share a graph. */
const monitorOver = (stream: MeterStreamLike, Context: MeterAudioContextConstructor): CaptureMonitor => {
  return {
    createAnalyser: () => {
      let context: MeterAudioContextLike;
      try {
        context = new Context();
      } catch {
        return null;
      }
      try {
        const source = context.createMediaStreamSource(stream as never);
        const analyser = context.createAnalyser();
        source.connect(analyser);
        // A context born outside a gesture starts suspended, and a suspended one reads silence.
        quietly(() => context.resume?.());
        return {
          analyser,
          disconnect: () => {
            quietly(() => source.disconnect());
            quietly(() => context.close());
          },
        };
      } catch {
        quietly(() => context.close());
        return null;
      }
    },
  };
};

/** A monitor over `stream`, or `null` when this page has no Web Audio. */
export function streamMonitor(stream: MeterStreamLike, global: MeterAudioGlobalLike): CaptureMonitor | null {
  const Context = global.AudioContext;
  return Context === undefined ? null : monitorOver(stream, Context);
}

/** A meter-only microphone, released with `release`. */
export interface MicMeter {
  readonly monitor: CaptureMonitor;
  release(): void;
}

/** Opens a `MicMeter`; rejects or resolves `null` when this page cannot. */
export interface MicMeterPort {
  open(): Promise<MicMeter | null>;
}

export interface MicMeterGlobalLike extends MeterAudioGlobalLike {
  readonly navigator?: {
    readonly mediaDevices?: { getUserMedia(constraints: MediaStreamConstraints): Promise<MeterStreamLike> };
  };
}

/** The production meter-only microphone. `null` when the page has no microphone API or no Web Audio. */
export function browserMicMeter(global: MicMeterGlobalLike): MicMeterPort | null {
  const devices = global.navigator?.mediaDevices;
  const Context = global.AudioContext;
  if (devices === undefined || typeof devices.getUserMedia !== 'function' || Context === undefined) return null;
  return {
    open: async () => {
      let stream: MeterStreamLike;
      try {
        stream = await devices.getUserMedia({ audio: true });
      } catch {
        return null;
      }
      return {
        monitor: monitorOver(stream, Context),
        release: () => {
          for (const track of stream.getTracks()) quietly(() => track.stop());
        },
      };
    },
  };
}
