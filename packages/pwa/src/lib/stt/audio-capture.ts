/**
 * The microphone, for the on-device engine: record one utterance, hand back 16 kHz mono samples.
 *
 * Parakeet needs PCM, so unlike browser speech (which owns its own microphone) this opens one.
 * It deliberately uses the two most widely supported pieces of the platform rather than an
 * AudioWorklet: `MediaRecorder` records the utterance, and `decodeAudioData` on a 16 kHz
 * `OfflineAudioContext` decodes AND resamples it on the way out. No worklet module to load (so no
 * second script for the page's policy to allow) and nothing runs per audio frame on the main thread.
 *
 * The recording stays in this page's memory and is handed to the speech worker in the same page.
 * Nothing here has a network path.
 */

/** The sample rate Parakeet was trained on. */
export const PARAKEET_SAMPLE_RATE = 16_000;

interface MediaTrackLike {
  stop(): void;
}

export interface MediaStreamLike {
  getTracks(): readonly MediaTrackLike[];
}

interface BlobEventLike {
  readonly data: Blob;
}

export interface MediaRecorderLike {
  readonly mimeType: string;
  ondataavailable: ((event: BlobEventLike) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
  start(): void;
  stop(): void;
  /** Flush what is recorded so far to `ondataavailable` without stopping. */
  requestData(): void;
}

interface AudioBufferLike {
  readonly numberOfChannels: number;
  readonly length: number;
  getChannelData(channel: number): Float32Array;
}

interface OfflineAudioContextLike {
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike>;
}

/** The slice of the page this module needs, so a test supplies plain objects. */
export interface AudioCaptureGlobalLike {
  readonly navigator?: {
    readonly mediaDevices?: { getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStreamLike> };
  };
  readonly MediaRecorder?: new (stream: MediaStreamLike) => MediaRecorderLike;
  readonly OfflineAudioContext?: new (channels: number, length: number, sampleRate: number) => OfflineAudioContextLike;
}

/** One recording in progress. */
export interface AudioRecording {
  /**
   * Everything recorded so far, decoded to 16 kHz mono, while recording carries on. Near-live words
   * (`near-live.ts`) read it about once a second; it decodes the whole take each time, which costs
   * far less than the speech model it feeds.
   */
  peek(): Promise<Float32Array>;
  /** Stop, release the microphone, and decode to 16 kHz mono. */
  stop(): Promise<Float32Array>;
  /** Release the microphone and drop what was recorded. Safe to call more than once. */
  cancel(): void;
}

export interface AudioCapturePort {
  /** Ask for the microphone and start recording. Rejects with the browser's own error. */
  start(): Promise<AudioRecording>;
}

/** Average every channel into one. */
export const mixToMono = (buffer: AudioBufferLike): Float32Array => {
  const mono = new Float32Array(buffer.length);
  const channels = Math.max(1, buffer.numberOfChannels);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < mono.length; index += 1)
      mono[index] = (mono[index] as number) + (data[index] ?? 0) / channels;
  }
  return mono;
};

/** Whether this page can record for the on-device engine. */
export const canCaptureAudio = (global: AudioCaptureGlobalLike): boolean =>
  typeof global.navigator?.mediaDevices?.getUserMedia === 'function' &&
  typeof global.MediaRecorder === 'function' &&
  typeof global.OfflineAudioContext === 'function';

/** The production capture over the page's own microphone APIs. */
export function browserAudioCapture(global: AudioCaptureGlobalLike): AudioCapturePort {
  return {
    start: async () => {
      const devices = global.navigator?.mediaDevices;
      const Recorder = global.MediaRecorder;
      const Offline = global.OfflineAudioContext;
      if (devices === undefined || Recorder === undefined || Offline === undefined)
        throw Object.assign(new Error('This browser cannot record audio for on-device dictation.'), {
          name: 'NotSupportedError',
        });
      const stream = await devices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const release = (): void => {
        for (const track of stream.getTracks()) track.stop();
      };
      let recorder: MediaRecorderLike;
      try {
        recorder = new Recorder(stream);
      } catch (error) {
        release();
        throw error;
      }
      const chunks: Blob[] = [];
      let settle: { resolve(blob: Blob): void; reject(error: unknown): void } | null = null;
      /** Peeks waiting for the flush they asked for. */
      let flushed: (() => void)[] = [];
      recorder.ondataavailable = event => {
        if (event.data.size > 0) chunks.push(event.data);
        const waiting = flushed;
        flushed = [];
        for (const resolve of waiting) resolve();
      };
      const decode = async (blob: Blob): Promise<Float32Array> => {
        if (blob.size === 0) return new Float32Array();
        const context = new Offline(1, PARAKEET_SAMPLE_RATE, PARAKEET_SAMPLE_RATE);
        return mixToMono(await context.decodeAudioData(await blob.arrayBuffer()));
      };
      recorder.onstop = () => {
        release();
        settle?.resolve(new Blob(chunks, { type: recorder.mimeType }));
      };
      recorder.onerror = event => {
        release();
        settle?.reject((event as { error?: unknown } | null)?.error ?? event);
      };
      recorder.start();
      let done = false;
      return {
        peek: async () => {
          if (done) return new Float32Array();
          await new Promise<void>(resolve => {
            flushed.push(resolve);
            recorder.requestData();
          });
          // The first part carries the container header, so every prefix of the parts decodes.
          return await decode(new Blob(chunks, { type: recorder.mimeType }));
        },
        stop: async () => {
          if (done) return new Float32Array();
          done = true;
          const blob = await new Promise<Blob>((resolve, reject) => {
            settle = { resolve, reject };
            recorder.stop();
          });
          return await decode(blob);
        },
        cancel: () => {
          if (done) return;
          done = true;
          recorder.onstop = release;
          try {
            recorder.stop();
          } catch {
            release();
          }
        },
      };
    },
  };
}
