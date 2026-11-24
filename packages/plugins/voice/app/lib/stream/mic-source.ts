import { STREAM_SAMPLE_RATE, UNIT_SAMPLES } from '../../../contract/index.ts';
import type { MicSource } from './voice-stream.ts';

/** What the browser gives, narrowed to what this file touches so a suite can stand one in. */
export interface MicEnvironment {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createContext(sampleRate: number): AudioContext;
}

/**
 * Linear resampling of one block, with the fractional position carried across blocks so no sample is repeated or lost.
 * A browser that honours `sampleRate: 16000` never needs it; Safari may not.
 */
export function resampler(from: number, to: number): (block: Float32Array) => Float32Array {
  if (from === to) return block => block;
  const step = from / to;
  // Where the next output sample sits, in input samples from the start of the block (negative: between the last block's end and this one's start).
  let position = 0;
  let previous = 0;
  return block => {
    const sample = (index: number): number => (index < 0 ? previous : (block[index] ?? 0));
    const out: number[] = [];
    while (Math.floor(position) + 1 < block.length) {
      const base = Math.floor(position);
      const a = sample(base);
      out.push(a + (sample(base + 1) - a) * (position - base));
      position += step;
    }
    position -= block.length;
    previous = block[block.length - 1] ?? previous;
    return Float32Array.from(out);
  };
}

/**
 * The real microphone: echo cancellation on (voice mode keeps the mic open while the machine speaks), 16 kHz mono, in
 * 640-sample units. A ScriptProcessor, not an AudioWorklet, on purpose: a worklet is a second script the page policy would
 * have to allow, and this one runs on the same schedule the whole time the mic is open, which is what the stream needs.
 */
export function browserMic(environment: MicEnvironment = browserEnvironment()): MicSource {
  let stream: MediaStream | undefined;
  let context: AudioContext | undefined;
  let node: ScriptProcessorNode | undefined;
  return {
    async start(onUnit) {
      stream = await environment.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      context = environment.createContext(STREAM_SAMPLE_RATE);
      const source = context.createMediaStreamSource(stream);
      node = context.createScriptProcessor(2048, 1, 1);
      const resample = resampler(context.sampleRate, STREAM_SAMPLE_RATE);
      let queue = new Float32Array(0);
      node.onaudioprocess = event => {
        const fresh = resample(event.inputBuffer.getChannelData(0));
        const joined = new Float32Array(queue.length + fresh.length);
        joined.set(queue, 0);
        joined.set(fresh, queue.length);
        let at = 0;
        for (; at + UNIT_SAMPLES <= joined.length; at += UNIT_SAMPLES) {
          const pcm = new Int16Array(UNIT_SAMPLES);
          for (let index = 0; index < UNIT_SAMPLES; index += 1)
            pcm[index] = Math.max(-32768, Math.min(32767, Math.round((joined[at + index] ?? 0) * 32768)));
          onUnit(pcm);
        }
        queue = joined.slice(at);
      };
      // The node only runs while it is connected to an output; a gain of zero keeps the person from hearing themselves.
      const silent = context.createGain();
      silent.gain.value = 0;
      source.connect(node);
      node.connect(silent);
      silent.connect(context.destination);
    },
    stop() {
      if (node !== undefined) node.onaudioprocess = null;
      node?.disconnect();
      for (const track of stream?.getTracks() ?? []) track.stop();
      void context?.close();
      node = undefined;
      stream = undefined;
      context = undefined;
    },
  };
}

function browserEnvironment(): MicEnvironment {
  return {
    getUserMedia: async constraints => await navigator.mediaDevices.getUserMedia(constraints),
    createContext: sampleRate => new AudioContext({ sampleRate }),
  };
}

/**
 * A microphone that hears nothing: one unit of zeros every 40 ms, on a timer. A stream that only LISTENS TO the machine
 * (the reply voice's sample) still has to send its 40 ms units, because the machine ends a stream that goes quiet, and it
 * must not open the real microphone for it: nothing of the room leaves the device.
 */
export function silentMic(): MicSource {
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    async start(onUnit) {
      timer = setInterval(() => onUnit(new Int16Array(UNIT_SAMPLES)), 40);
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
