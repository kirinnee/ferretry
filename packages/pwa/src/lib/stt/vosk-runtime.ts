/**
 * VOSK ON ITS WEBASSEMBLY RUNTIME — verified bytes in, a streaming recognizer out.
 *
 * The worker's composition root (`src/worker/vosk-worker.ts`) starts the Emscripten module
 * (`LoadVosk`, made eval-free by `voskEvalFreeGlue` in `vite.config.ts`) and hands it here. Everything that touches the
 * module's API is in this file, behind {@link VoskModule}, so a test drives it with a fake:
 *
 *   - THE RUNTIME NEVER FETCHES. Its binary is given as bytes (`wasmBinary`), so Emscripten neither
 *     locates nor downloads one, and the model archive is written into the module's IN-MEMORY file
 *     system from the bytes the store has just verified. Nothing is mounted on IndexedDB.
 *   - THE ARCHIVE IS UNPACKED BY THE RUNTIME ITSELF (its `ArchiveHelper`), then deleted, and the
 *     unpacked folder is deleted too once Kaldi has read it into the model: the files are only the
 *     way in, and keeping them would hold a second copy of the model in memory for nothing.
 *   - SAMPLES ARE SCALED to the 16-bit range Kaldi's features expect (what `vosk-browser` does with an
 *     `AudioBuffer`), and copied into one reusable buffer on the module's heap.
 */

import { VOSK_MODEL_ROLE, VOSK_RUNTIME_ROLE } from './vosk-model.ts';

/** Kaldi's object handles: freed explicitly, because WebAssembly memory is not garbage-collected. */
interface VoskHandle {
  delete(): void;
}

export interface VoskKaldiRecognizer extends VoskHandle {
  /** True at an endpoint: the utterance so far is final, and `Result` returns it. */
  AcceptWaveform(pointer: number, length: number): boolean;
  /** `{"text": "…"}` for the utterance an endpoint just closed. */
  Result(): string;
  /** `{"partial": "…"}` for the words since the last endpoint. */
  PartialResult(): string;
  /** `{"text": "…"}` for whatever is left, ending the stream. */
  FinalResult(): string;
}

interface VoskArchiveHelper extends VoskHandle {
  Extract(archive: string, into: string, stripFirstComponent: boolean): void;
}

/** The slice of the Emscripten module this file uses. */
export interface VoskModule {
  readonly FS: {
    mkdirTree(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
    readdir(path: string): string[];
    stat(path: string): { readonly mode: number };
    isDir(mode: number): boolean;
    unlink(path: string): void;
    rmdir(path: string): void;
  };
  readonly ArchiveHelper: {
    implement(callbacks: { onsuccess(): void; onerror(message: unknown): void }): VoskArchiveHelper;
  };
  readonly Model: new (path: string) => VoskHandle;
  readonly Recognizer: new (model: VoskHandle, sampleRate: number) => VoskKaldiRecognizer;
  /** The current view of the heap; it is replaced when memory grows, so read it after allocating. */
  readonly HEAPF32: Float32Array;
  SetLogLevel(level: number): void;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
}

/** What one chunk of audio did: the words heard, and whether an endpoint closed them. */
export interface VoskHeard {
  readonly endpoint: boolean;
  readonly text: string;
}

/** One utterance's recognizer: fed as the person speaks, finished once on Stop. */
export interface VoskStreamingRecognizer {
  accept(samples: Float32Array): VoskHeard;
  /** The words after the last endpoint, and the recognizer freed. */
  finish(): string;
  /** Free it without a result. Safe after `finish`. */
  free(): void;
}

export interface VoskLoadedModel {
  recognizer(sampleRate: number): VoskStreamingRecognizer;
}

/** Turns verified bytes, by role, into a model. */
export interface VoskRuntime {
  load(bytes: ReadonlyMap<string, Uint8Array>): Promise<VoskLoadedModel>;
}

/** Kaldi's quietest log level: errors only. */
const QUIET = -1;
const ROOT = '/vosk';
const ARCHIVE = `${ROOT}/model.zip`;
const MODEL = `${ROOT}/model`;
/** Kaldi's features are computed on 16-bit sample values. */
const PCM_SCALE = 32_768;

/** One field of a Vosk JSON result, or `''` for anything else. */
export const voskText = (json: string, field: 'text' | 'partial'): string => {
  try {
    const value: unknown = (JSON.parse(json) as Record<string, unknown> | null)?.[field];
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
};

const removeTree = (fs: VoskModule['FS'], path: string): void => {
  for (const name of fs.readdir(path)) {
    if (name === '.' || name === '..') continue;
    const child = `${path}/${name}`;
    if (fs.isDir(fs.stat(child).mode)) {
      removeTree(fs, child);
      fs.rmdir(child);
    } else fs.unlink(child);
  }
};

/** Unpack the archive with the runtime's own unpacker, dropping the folder it holds the model in. */
const unpack = async (module: VoskModule, archive: string, into: string): Promise<void> => {
  let helper: VoskArchiveHelper | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      helper = module.ArchiveHelper.implement({
        onsuccess: resolve,
        onerror: message => reject(new Error(`The speech model could not be unpacked: ${String(message)}`)),
      });
      helper.Extract(archive, into, true);
    });
  } finally {
    helper?.delete();
  }
};

class Recognizer implements VoskStreamingRecognizer {
  readonly #module: VoskModule;
  readonly #recognizer: VoskKaldiRecognizer;
  #pointer = 0;
  #capacity = 0;
  #freed = false;

  constructor(module: VoskModule, recognizer: VoskKaldiRecognizer) {
    this.#module = module;
    this.#recognizer = recognizer;
  }

  accept(samples: Float32Array): VoskHeard {
    if (this.#freed) throw new Error('The recognizer was already finished.');
    if (samples.length > this.#capacity) {
      if (this.#pointer !== 0) this.#module._free(this.#pointer);
      this.#pointer = this.#module._malloc(samples.length * Float32Array.BYTES_PER_ELEMENT);
      this.#capacity = samples.length;
    }
    const heap = this.#module.HEAPF32;
    const start = this.#pointer / Float32Array.BYTES_PER_ELEMENT;
    for (let index = 0; index < samples.length; index += 1)
      heap[start + index] = (samples[index] as number) * PCM_SCALE;
    return this.#recognizer.AcceptWaveform(this.#pointer, samples.length)
      ? { endpoint: true, text: voskText(this.#recognizer.Result(), 'text') }
      : { endpoint: false, text: voskText(this.#recognizer.PartialResult(), 'partial') };
  }

  finish(): string {
    if (this.#freed) throw new Error('The recognizer was already finished.');
    const text = voskText(this.#recognizer.FinalResult(), 'text');
    this.free();
    return text;
  }

  free(): void {
    if (this.#freed) return;
    this.#freed = true;
    if (this.#pointer !== 0) this.#module._free(this.#pointer);
    this.#recognizer.delete();
  }
}

/** The production runtime: `start` compiles the binary it is given and resolves the module. */
export function voskRuntime(start: (wasmBinary: Uint8Array) => Promise<VoskModule>): VoskRuntime {
  return {
    load: async bytes => {
      const runtime = bytes.get(VOSK_RUNTIME_ROLE);
      const archive = bytes.get(VOSK_MODEL_ROLE);
      if (runtime === undefined || archive === undefined) throw new Error('The speech model is incomplete.');
      const module = await start(runtime);
      module.SetLogLevel(QUIET);
      module.FS.mkdirTree(ROOT);
      module.FS.writeFile(ARCHIVE, archive);
      try {
        await unpack(module, ARCHIVE, MODEL);
      } finally {
        module.FS.unlink(ARCHIVE);
      }
      let model: VoskHandle;
      try {
        model = new module.Model(MODEL);
      } finally {
        removeTree(module.FS, MODEL);
      }
      return { recognizer: sampleRate => new Recognizer(module, new module.Recognizer(model, sampleRate)) };
    },
  };
}
