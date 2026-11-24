/**
 * THE NATIVE ENGINE, as a worker holds it: sherpa-onnx's Node addon, loaded BY ABSOLUTE PATH from the folder Install put it
 * in (`process.dlopen`; the two libraries it links sit beside it, and its run-path finds them there). It is not imported,
 * so nothing of it is in the compiled `fyd`: a machine that never installs it never has it, and a worker that fails to load
 * it says so in one sentence (the reply and speech engines then run on WebAssembly).
 *
 * Only the raw functions the workers call are typed here. They are the addon's own exports, which sherpa-onnx's JavaScript
 * wrapper (`sherpa-onnx-node`) forwards to unchanged; the version is pinned, so the names cannot move under us.
 */

/** An opaque handle the addon returns; only the addon reads it. */
export type Handle = object;

export interface NativeAddon {
  readonly version: string;
  createOfflineTts(config: unknown): Handle;
  getOfflineTtsSampleRate(tts: Handle): number;
  offlineTtsGenerate(
    tts: Handle,
    request: { text: string; sid: number; speed: number },
  ): { samples: Float32Array; sampleRate: number };
  createOfflineRecognizer(config: unknown): Handle;
  createOfflineStream(recognizer: Handle): Handle;
  acceptWaveformOffline(stream: Handle, wave: { sampleRate: number; samples: Float32Array }): void;
  decodeOfflineStream(recognizer: Handle, stream: Handle): void;
  getOfflineStreamResultAsJson(stream: Handle): string;
}

const loaded = new Map<string, NativeAddon>();

/** Loads the addon at `path` once per worker. Throws the loader's own message (a missing library, a wrong architecture). */
export function loadAddon(path: string): NativeAddon {
  const known = loaded.get(path);
  if (known !== undefined) return known;
  const holder: { exports: unknown } = { exports: {} };
  process.dlopen(holder as NodeJS.Module, path);
  const addon = holder.exports as NativeAddon;
  if (typeof addon.createOfflineTts !== 'function' || typeof addon.createOfflineRecognizer !== 'function')
    throw new Error('the native speech engine does not have the functions this version needs');
  loaded.set(path, addon);
  return addon;
}

/** What this worker loaded natively and has not yet seen collected: weakly held, so holding it here frees nothing. */
const tracked = new Set<WeakRef<object>>();

/** Records a native handle the worker is about to drop, so {@link collectNative} knows when it is really gone. */
export function track<T extends object>(handle: T): T {
  tracked.add(new WeakRef(handle));
  return handle;
}

/**
 * Runs the collector until every native handle recorded with {@link track} has been collected, then twice more. Bun frees a
 * native handle in its finalizer, which runs on a LATER turn of the event loop than the collection that found it
 * unreachable, and a collector that scans the stack conservatively may still see the handle for a pass or two: so this takes
 * passes, with a turn between each, and waits on the handle itself rather than on memory (the allocator may keep what was
 * freed, so memory is no witness). Measured: a worker that was only terminated kept all of it, and each load and unload
 * added 0.5-0.7 GB to the daemon; a fixed number of passes freed it most times but not every time.
 */
export async function collectNative(): Promise<void> {
  let settled = 0;
  for (let pass = 0; pass < COLLECT_MAX_PASSES && settled < COLLECT_EXTRA_PASSES; pass += 1) {
    Bun.gc(true);
    await Bun.sleep(COLLECT_PAUSE_MS);
    for (const ref of tracked) if (ref.deref() === undefined) tracked.delete(ref);
    if (tracked.size === 0) settled += 1;
  }
}

const COLLECT_MAX_PASSES = 60;
const COLLECT_PAUSE_MS = 100;
/** Passes after the last handle is seen collected, for its finalizer (a turn later) to have run. */
const COLLECT_EXTRA_PASSES = 2;
