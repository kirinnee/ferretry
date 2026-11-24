import { VoiceEngineError } from '../../../contract/index.ts';

/** Which engine an install ended on. */
export type RuntimeKind = 'native' | 'wasm';

/**
 * The native engine would not start on this machine: its message is what a person is told (a missing library, a wrong
 * architecture). It is the ONE failure that sends an install to the WebAssembly engine; a download that failed, a file that
 * was not the pinned one or a disk that is full is the person's to see, never quietly turned into the slower engine.
 */
export class NativeUnavailable extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'NativeUnavailable';
  }
}

/** The one line a person is shown for why the native engine did not start: the loader's own words, trimmed. */
export function reasonOf(error: unknown): string {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const message = String((cause as Error | undefined)?.message ?? (error as Error | undefined)?.message ?? error);
  return message
    .replace(/^The (?:reply voice|speech engine) could not (?:load|probe): /u, '')
    .replace(/\s+/gu, ' ')
    .replace(/\.$/u, '')
    .trim()
    .slice(0, 160);
}

/** Turns what a native start threw into {@link NativeUnavailable}, except the refusals that are not about the library. */
export function asUnavailable(error: unknown): never {
  if (error instanceof NativeUnavailable) throw error;
  if (error instanceof VoiceEngineError && (error.code === 'no_memory' || error.code === 'not_ready')) throw error;
  throw new NativeUnavailable(reasonOf(error));
}

export interface NativeInstallSteps {
  /** The native files of this machine's package, downloaded and hash-checked (the library alone, the smallest part). */
  readonly fetchAddon: () => Promise<void>;
  /** Loads the addon alone in a worker. Throws {@link NativeUnavailable} when this machine cannot run it. */
  readonly probe: () => Promise<void>;
  /** The files the engine needs besides the library, for this kind of engine. */
  readonly fetchRest: (kind: RuntimeKind) => Promise<void>;
  /** Proves the engine works by using it once; the install ends only when it did. Throws {@link NativeUnavailable} for native. */
  readonly prove: (kind: RuntimeKind) => Promise<void>;
  /** The native engine did not start: its files are deleted, so a restart does not try them again. */
  readonly dropNative: () => Promise<void>;
  /** The native engine runs: the WebAssembly engine's own files are dead weight and are deleted. */
  readonly dropWasm: () => Promise<void>;
}

export interface NativeInstallResult {
  readonly kind: RuntimeKind;
  /** Why the native engine is not the one running, when it was tried and did not start. */
  readonly reason?: string;
}

/**
 * Install, native first. The library is fetched alone first and loaded before the big model is downloaded, so a machine
 * that cannot run it learns that in seconds and downloads the WebAssembly engine's files instead of both. Then the model
 * is fetched and the engine proves itself by speaking or decoding once. A native engine that fails EITHER test ends on the
 * WebAssembly engine, with the reason kept to be said; anything else that fails is thrown to the caller untouched.
 */
export async function installNativeFirst(steps: NativeInstallSteps): Promise<NativeInstallResult> {
  await steps.fetchAddon();
  try {
    await steps.probe();
    await steps.fetchRest('native');
    await steps.prove('native');
  } catch (error) {
    if (!(error instanceof NativeUnavailable)) throw error;
    await steps.dropNative();
    await steps.fetchRest('wasm');
    await steps.prove('wasm');
    return { kind: 'wasm', reason: error.reason };
  }
  await steps.dropWasm();
  return { kind: 'native' };
}
