/** The processor's registered name, shared with audio capture. */
export const PCM16_WORKLET_NAME = 'kteam-pcm16-capture';

/** Frames per posted message. */
export const WORKLET_BATCH_FRAMES = 4096;

/**
 * The AudioWorklet program as plain JavaScript. AudioWorklets evaluate a
 * classic script in their own realm, so the program intentionally remains a
 * string rather than importing this TypeScript module directly.
 */
export const PCM16_WORKLET_SOURCE = `
class KteamPcm16Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this._batch = new Float32Array(${WORKLET_BATCH_FRAMES});
    this._filled = 0;
    this._stopped = false;
    this.port.onmessage = event => {
      const data = event && event.data;
      if (!data) return;
      if (data.type !== 'flush' && data.type !== 'stop') return;
      this._flush();
      this.port.postMessage({ type: 'flushed' });
      if (data.type === 'stop') this._stopped = true;
    };
  }

  _flush() {
    if (this._filled === 0) return;
    const chunk = this._batch.slice(0, this._filled);
    this._filled = 0;
    this.port.postMessage({ type: 'audio', samples: chunk, sampleRate: sampleRate }, [chunk.buffer]);
  }

  process(inputs) {
    if (this._stopped) return false;
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;
    for (let i = 0; i < channel.length; i += 1) {
      this._batch[this._filled] = channel[i];
      this._filled += 1;
      if (this._filled === this._batch.length) this._flush();
    }
    return true;
  }
}

registerProcessor(${JSON.stringify(PCM16_WORKLET_NAME)}, KteamPcm16Capture);
`;

/** Creates a temporary module URL. Revoke it after `audioWorklet.addModule`. */
export function createPcm16WorkletUrl(): string {
  const blob = new Blob([PCM16_WORKLET_SOURCE], { type: 'application/javascript' });
  return URL.createObjectURL(blob);
}
