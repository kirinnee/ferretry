/**
 * Proves the Vosk runtime adapter over a fake Emscripten module: loading hands the runtime its binary
 * as bytes, writes the verified archive into the in-memory file system, unpacks it with the runtime's
 * own unpacker, and deletes both the archive and the unpacked folder whatever happens; a recognizer
 * scales samples to Kaldi's 16-bit range into one reusable heap buffer, answers committed text at an
 * endpoint and interim text otherwise, and frees itself exactly once.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import { VOSK_MODEL_ROLE, VOSK_RUNTIME_ROLE } from '../../../src/lib/stt/vosk-model.ts';
import { type VoskKaldiRecognizer, type VoskModule, voskRuntime, voskText } from '../../../src/lib/stt/vosk-runtime.ts';

interface Extraction {
  readonly archive: string;
  readonly into: string;
  readonly strip: boolean;
}

class FakeRecognizer implements VoskKaldiRecognizer {
  readonly fed: number[][] = [];
  endpoints: boolean[] = [];
  result = '{"text": " the committed words "}';
  partial = '{"partial": "words so far"}';
  final = '{"text": "the last words"}';
  deleted = 0;
  constructor(
    readonly module: FakeModule,
    readonly sampleRate: number,
  ) {}
  AcceptWaveform(pointer: number, length: number): boolean {
    const start = pointer / 4;
    this.fed.push([...this.module.HEAPF32.subarray(start, start + length)]);
    return this.endpoints.shift() ?? false;
  }
  Result(): string {
    return this.result;
  }
  PartialResult(): string {
    return this.partial;
  }
  FinalResult(): string {
    return this.final;
  }
  delete(): void {
    this.deleted += 1;
  }
}

class FakeModule implements VoskModule {
  readonly files = new Map<string, Uint8Array>();
  readonly directories = new Set<string>();
  readonly extractions: Extraction[] = [];
  readonly recognizers: FakeRecognizer[] = [];
  readonly models: string[] = [];
  readonly frees: number[] = [];
  readonly mallocs: number[] = [];
  helpersDeleted = 0;
  logLevel: number | null = null;
  HEAPF32 = new Float32Array(64);
  /** What the unpacker does: write these files and succeed, or fail with this message, or throw. */
  unpacker: { files: Record<string, string> } | { error: string } | { throws: Error } = {
    files: { 'am/final.mdl': 'mdl', 'graph/HCLr.fst': 'fst' },
  };
  modelThrows: unknown = null;
  #next = 16;

  readonly FS = {
    mkdirTree: (path: string) => {
      this.directories.add(path);
    },
    writeFile: (path: string, data: Uint8Array) => {
      this.files.set(path, data);
    },
    readdir: (path: string) => [
      '.',
      '..',
      ...new Set(
        [...this.files.keys(), ...this.directories]
          .filter(entry => entry.startsWith(`${path}/`))
          .map(entry => entry.slice(path.length + 1).split('/')[0] as string),
      ),
    ],
    stat: (path: string) => ({ mode: this.directories.has(path) ? 1 : 0 }),
    isDir: (mode: number) => mode === 1,
    unlink: (path: string) => {
      this.files.delete(path);
    },
    rmdir: (path: string) => {
      this.directories.delete(path);
    },
  };

  readonly ArchiveHelper = {
    implement: (callbacks: { onsuccess(): void; onerror(message: unknown): void }) => ({
      Extract: (archive: string, into: string, strip: boolean) => {
        this.extractions.push({ archive, into, strip });
        const unpacker = this.unpacker;
        if ('throws' in unpacker) throw unpacker.throws;
        if ('error' in unpacker) {
          callbacks.onerror(unpacker.error);
          return;
        }
        for (const [path, text] of Object.entries(unpacker.files)) {
          const full = `${into}/${path}`;
          const parts = full.split('/');
          for (let index = 2; index < parts.length; index += 1) this.directories.add(parts.slice(0, index).join('/'));
          this.files.set(full, new TextEncoder().encode(text));
        }
        callbacks.onsuccess();
      },
      delete: () => {
        this.helpersDeleted += 1;
      },
    }),
  };

  readonly Model = (() => {
    const module = this;
    return class {
      constructor(path: string) {
        if (module.modelThrows !== null) throw module.modelThrows;
        module.models.push(path);
      }
      delete(): void {}
    };
  })();

  readonly Recognizer = (() => {
    const module = this;
    return class extends FakeRecognizer {
      constructor(_model: unknown, sampleRate: number) {
        super(module, sampleRate);
        module.recognizers.push(this);
      }
    };
  })();

  SetLogLevel(level: number): void {
    this.logLevel = level;
  }

  _malloc(bytes: number): number {
    this.mallocs.push(bytes);
    const pointer = this.#next;
    this.#next += bytes;
    // Growing memory replaces the heap view, as Emscripten does.
    if (this.#next / 4 > this.HEAPF32.length) this.HEAPF32 = new Float32Array(this.#next / 4 + 64);
    return pointer;
  }

  _free(pointer: number): void {
    this.frees.push(pointer);
  }
}

const RUNTIME = new Uint8Array([0, 97, 115, 109]);
const ARCHIVE = new Uint8Array([80, 75, 3, 4]);
const installed = (): Map<string, Uint8Array> =>
  new Map([
    [VOSK_RUNTIME_ROLE, RUNTIME],
    [VOSK_MODEL_ROLE, ARCHIVE],
  ]);

const loaded = async (module = new FakeModule()) => {
  const started: Uint8Array[] = [];
  const runtime = voskRuntime(async binary => {
    started.push(binary);
    return module;
  });
  return { model: await runtime.load(installed()), module, started };
};

describe('voskText', () => {
  it('reads one field of a Vosk result, trimmed, and nothing from anything else', () => {
    should(voskText('{"text": " hello there "}', 'text')).equal('hello there');
    should(voskText('{"partial": "hel"}', 'partial')).equal('hel');
    should(voskText('{"partial": "hel"}', 'text')).equal('');
    should(voskText('{"text": 4}', 'text')).equal('');
    should(voskText('null', 'text')).equal('');
    should(voskText('not json', 'text')).equal('');
  });
});

describe('voskRuntime.load', () => {
  it('starts the runtime from its bytes and unpacks the archive in memory, keeping neither copy', async () => {
    const { module, started } = await loaded();
    should(started).eql([RUNTIME]);
    should(module.logLevel).equal(-1);
    should(module.directories.has('/vosk')).be.true();
    should(module.extractions).eql([{ archive: '/vosk/model.zip', into: '/vosk/model', strip: true }]);
    should(module.helpersDeleted).equal(1);
    should(module.models).eql(['/vosk/model']);
    should([...module.files.keys()]).eql([]);
    should([...module.directories]).eql(['/vosk', '/vosk/model']);
  });

  it('refuses an install that is missing its runtime or its model', async () => {
    const runtime = voskRuntime(() => Promise.reject(new Error('never started')));
    await should(runtime.load(new Map([[VOSK_MODEL_ROLE, ARCHIVE]]))).be.rejectedWith(
      'The speech model is incomplete.',
    );
    await should(runtime.load(new Map([[VOSK_RUNTIME_ROLE, RUNTIME]]))).be.rejectedWith(
      'The speech model is incomplete.',
    );
  });

  it('says the archive could not be unpacked, and still drops it', async () => {
    const module = new FakeModule();
    module.unpacker = { error: 'Unrecognized archive format' };
    await should(loaded(module)).be.rejectedWith('The speech model could not be unpacked: Unrecognized archive format');
    should(module.files.has('/vosk/model.zip')).be.false();
    should(module.helpersDeleted).equal(1);
    should(module.models).eql([]);
  });

  it('passes on an unpacker that throws, and still drops the archive', async () => {
    const module = new FakeModule();
    module.unpacker = { throws: new Error('out of memory') };
    await should(loaded(module)).be.rejectedWith('out of memory');
    should(module.files.has('/vosk/model.zip')).be.false();
    should(module.helpersDeleted).equal(1);
  });

  it('drops the unpacked folder when Kaldi refuses the model', async () => {
    const module = new FakeModule();
    module.modelThrows = 524_928;
    let thrown: unknown;
    await loaded(module).catch((error: unknown) => {
      thrown = error;
    });
    should(thrown).equal(524_928);
    should([...module.files.keys()]).eql([]);
  });
});

describe('a Vosk recognizer', () => {
  it('scales samples to 16-bit values in one buffer that only grows when it must', async () => {
    const { model, module } = await loaded();
    const recognizer = model.recognizer(16_000);
    const kaldi = module.recognizers[0] as FakeRecognizer;
    should(kaldi.sampleRate).equal(16_000);
    should(recognizer.accept(new Float32Array([0.5, -0.25]))).eql({ endpoint: false, text: 'words so far' });
    should(kaldi.fed).eql([[16_384, -8_192]]);
    recognizer.accept(new Float32Array([1]));
    should(module.mallocs).eql([8]);
    recognizer.accept(new Float32Array(100).fill(0.5));
    should(module.mallocs).eql([8, 400]);
    should(module.frees).eql([16]);
    should(kaldi.fed[2]?.length).equal(100);
    should(kaldi.fed[2]?.[99]).equal(16_384);
  });

  it('answers the committed words at an endpoint', async () => {
    const { model, module } = await loaded();
    const recognizer = model.recognizer(16_000);
    const kaldi = module.recognizers[0] as FakeRecognizer;
    kaldi.endpoints = [true];
    should(recognizer.accept(new Float32Array([0.1]))).eql({ endpoint: true, text: 'the committed words' });
  });

  it('finishes with the last words and frees itself once', async () => {
    const { model, module } = await loaded();
    const recognizer = model.recognizer(16_000);
    const kaldi = module.recognizers[0] as FakeRecognizer;
    recognizer.accept(new Float32Array([0.1]));
    should(recognizer.finish()).equal('the last words');
    should(kaldi.deleted).equal(1);
    should(module.frees).eql([16]);
    recognizer.free();
    should(kaldi.deleted).equal(1);
    should(() => recognizer.accept(new Float32Array([0.1]))).throw('The recognizer was already finished.');
    should(() => recognizer.finish()).throw('The recognizer was already finished.');
  });

  it('frees a recognizer that never heard anything without freeing a buffer it never had', async () => {
    const { model, module } = await loaded();
    model.recognizer(16_000).free();
    should((module.recognizers[0] as FakeRecognizer).deleted).equal(1);
    should(module.frees).eql([]);
  });
});
