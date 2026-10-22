/**
 * The Vosk runtime as it really ships: `@lichess-org/vosk-browser`'s glue after the build-time
 * rewrite (`voskEvalFreeGlue` in `vite.config.ts`), compiling the package's real `vosk.wasm`, with the `Function`
 * constructor POISONED — the same thing the app's policy (no `'unsafe-eval'`) does in a browser.
 *
 * It proves the two rewritten pieces actually work rather than merely being gone: the module starts
 * and binds Kaldi's classes (every bound method goes through the eval-free invoker), and the runtime's
 * own unpacker answers through the eval-free JavaScript-method caller. It then drives
 * `voskRuntime` (`src/lib/stt/vosk-runtime.ts`) over the real module with an archive that is not a
 * model, which must fail and leave nothing unpacked behind. No network: the binary comes from
 * `node_modules`, and the archive is built here. The real model is `harness/vosk-smoke.ts`'s job.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { evalFreeVoskGlue } from '../../../vite.config.ts';
import { VOSK_MODEL_ROLE, VOSK_RUNTIME_ROLE } from '../../../src/lib/stt/vosk-model.ts';
import { type VoskModule, voskRuntime } from '../../../src/lib/stt/vosk-runtime.ts';

const PWA_DIR = join(import.meta.dir, '..', '..', '..');
const PACKAGE_DIR = dirname(Bun.resolveSync('@lichess-org/vosk-browser/package.json', PWA_DIR));

type LoadVosk = (options: {
  wasmBinary: Uint8Array;
  print: (message: string) => void;
  printErr: (message: string) => void;
}) => Promise<
  VoskModule & { FS: VoskModule['FS'] & { readFile(path: string, options: { encoding: 'utf8' }): string } }
>;

/** A store-only zip of `files`, every one under a top-level `model/` folder like Vosk's own zips. */
const zipOf = (files: Readonly<Record<string, string>>): Uint8Array => {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const name = new TextEncoder().encode(`model/${path}`);
    const data = new TextEncoder().encode(text);
    const crc = Bun.hash.crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), name, data);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const centralSize = central.reduce((total, part) => total + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(files).length, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Uint8Array(Buffer.concat([...parts, ...central, new Uint8Array(end.buffer)]));
};

const scope = globalThis as unknown as { Function: FunctionConstructor; self?: { location?: { href: string } } };
const realFunction = scope.Function;
const hadSelf = 'self' in globalThis;
let directory = '';
let LoadVosk: LoadVosk;
let wasmBinary: Uint8Array;
const errors: string[] = [];

beforeAll(async () => {
  // Under tests/, which no coverage ledger counts: the rewritten glue is the package's code, not ours.
  directory = await mkdtemp(join(import.meta.dir, '.vosk-glue-'));
  const glue = join(directory, 'vosk-glue.mjs');
  await writeFile(glue, evalFreeVoskGlue(await readFile(join(PACKAGE_DIR, 'dist', 'vosk.worker.js'), 'utf8')));
  wasmBinary = new Uint8Array(await readFile(join(PACKAGE_DIR, 'dist', 'vosk.wasm')));
  // The glue is built for a worker and reads the worker's own address once, to resolve nothing.
  if (!hadSelf) Object.assign(globalThis, { self: globalThis });
  scope.self ??= {};
  scope.self.location ??= { href: 'http://127.0.0.1/assets/vosk-worker.js' };
  LoadVosk = ((await import(glue)) as { default: LoadVosk }).default;
  // From here on, code built from a string throws — as it does under the app's policy.
  scope.Function = new Proxy(realFunction, {
    apply: () => {
      throw new EvalError('the Function constructor is refused');
    },
    construct: () => {
      throw new EvalError('the Function constructor is refused');
    },
  });
});

afterAll(async () => {
  scope.Function = realFunction;
  if (!hadSelf) Reflect.deleteProperty(globalThis, 'self');
  await rm(directory, { recursive: true, force: true });
});

const start = () =>
  LoadVosk({ wasmBinary: wasmBinary.slice(), print: () => undefined, printErr: message => errors.push(message) });

describe('the rewritten Vosk glue on the real runtime, with no Function constructor', () => {
  test('starts, binds Kaldi, and unpacks a zip through the runtime’s own unpacker', async () => {
    const module = await start();
    module.SetLogLevel(-1);
    module.FS.mkdirTree('/in');
    module.FS.writeFile('/in/model.zip', zipOf({ 'conf/hello.txt': 'hello vosk' }));
    await new Promise<void>((resolve, reject) => {
      const helper = module.ArchiveHelper.implement({ onsuccess: resolve, onerror: reject });
      helper.Extract('/in/model.zip', '/out', true);
    });
    expect(module.FS.readFile('/out/conf/hello.txt', { encoding: 'utf8' })).toBe('hello vosk');
  }, 60_000);

  test('answers an archive it cannot read through the error callback', async () => {
    const module = await start();
    module.FS.mkdirTree('/in');
    module.FS.writeFile('/in/model.zip', new Uint8Array([1, 2, 3]));
    const failure = await new Promise<unknown>((resolve, reject) => {
      const helper = module.ArchiveHelper.implement({
        onsuccess: () => reject(new Error('unpacked noise')),
        onerror: resolve,
      });
      helper.Extract('/in/model.zip', '/out', true);
    });
    expect(String(failure)).toContain('Unrecognized archive format');
  }, 60_000);

  test('voskRuntime refuses an archive that is not a model and leaves nothing unpacked', async () => {
    let module: Awaited<ReturnType<LoadVosk>> | null = null;
    const runtime = voskRuntime(async binary => {
      module = await LoadVosk({
        wasmBinary: binary,
        print: () => undefined,
        printErr: message => errors.push(message),
      });
      return module;
    });
    const bytes = new Map([
      [VOSK_RUNTIME_ROLE, wasmBinary.slice()],
      [VOSK_MODEL_ROLE, zipOf({ README: 'not a model' })],
    ]);
    let refused = false;
    await runtime.load(bytes).catch(() => {
      refused = true;
    });
    expect(refused).toBe(true);
    expect(errors.some(message => message.includes('does not contain model files'))).toBe(true);
    const loaded = module as Awaited<ReturnType<LoadVosk>> | null;
    expect(loaded?.FS.readdir('/vosk')).toEqual(['.', '..', 'model']);
    expect(loaded?.FS.readdir('/vosk/model')).toEqual(['.', '..']);
  }, 60_000);
});
