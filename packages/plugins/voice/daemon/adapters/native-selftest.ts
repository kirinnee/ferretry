import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SelftestEnvironment, SelftestProbe } from '@ferretry/kernel/manifest';
import { ENGINE_DIR } from '../lib/engine/catalog.ts';
import { NATIVE_ADDON_ROLE, type NativeTarget, nativeTargetFor, NATIVE_VERSION } from '../lib/native/catalog.ts';
import { reasonOf } from '../lib/native/install.ts';
import { unverified } from '../lib/native/verify.ts';
import { REPLY_DIR } from '../lib/reply/catalog.ts';
import { startChildThread } from './child-speech-thread.ts';
import { nativeHostCommand } from './worker-speech-thread.ts';
import type { SpeechCall, SpeechReply } from '../lib/engine/protocol.ts';

/**
 * THE `voice` LINE OF `fyd --check` (docs/design/voice-modes.md §2.3): whether the native speech engine, once Install has
 * fetched it, STARTS in THIS binary. It looks in the two folders the engines keep their files in (`state/voice/models/`),
 * and reports:
 *   - nothing installed: said as the plain fact it is, not a failure (a machine that never installs voice mode has none);
 *   - installed and verified and loaded: "native engine ready" with its version, loaded by path from the compiled binary;
 *   - installed but not the pinned bytes, or would not load: said in one line with what runs instead (WebAssembly).
 * It loads the library in the check process and runs nothing of it: the engines' own self-test, at Install, is the proof
 * of a model speaking. It reads the state folder as text (the probe is handed `stateDir`) and writes nothing.
 */
export interface NativeSelftestDeps {
  readonly platform: string;
  readonly arch: string;
  /** Loads the addon at a path and says its version; a throwaway child process by default (see {@link loadInChild}). */
  readonly load: (path: string, environment: SelftestEnvironment) => string | Promise<string>;
  /** The pinned files of a platform; the shipped catalog by default (a suite names tiny ones). */
  readonly targetFor?: (platform: string, arch: string) => NativeTarget | undefined;
}

export function voiceNativeSelftest(
  deps: NativeSelftestDeps = {
    platform: process.platform,
    arch: process.arch,
    load: loadInChild,
  },
): SelftestProbe {
  return {
    label: 'voice',
    host: true,
    run: async environment => {
      const { stateDir } = environment;
      const target = (deps.targetFor ?? nativeTargetFor)(deps.platform, deps.arch);
      if (target === undefined)
        return `no native speech engine for ${deps.platform}-${deps.arch}: voice mode runs on the slower WebAssembly engine`;
      if (stateDir === undefined) return 'state folder not given: the native speech engine was not looked for';
      for (const dir of [REPLY_DIR, ENGINE_DIR]) {
        const at = (role: string): string => join(stateDir, 'models', dir, role);
        const present = await Promise.all(
          target.files.map(async file => (await stat(at(file.role)).catch(() => undefined))?.size === file.bytes),
        );
        if (!present.every(Boolean)) continue;
        const bad = await unverified(
          { read: async file => await readFile(at(file.role)).catch(() => undefined) },
          target.files,
        );
        if (bad.length > 0)
          return `! the saved native speech engine in ${dir} is not the pinned ${NATIVE_VERSION} (${bad.map(file => file.role).join(', ')}): it is not loaded; voice mode runs on WebAssembly until Install is run again`;
        try {
          const version = await deps.load(at(NATIVE_ADDON_ROLE), environment);
          return `native engine ready (sherpa-onnx ${version}, ${target.key}, pinned files verified, loaded from ${dir})`;
        } catch (error) {
          return `! the saved native speech engine in ${dir} would not start (${reasonOf(error)}): voice mode runs on the slower WebAssembly engine`;
        }
      }
      return `native engine not installed (it is fetched with the voice-mode models: ${target.key})`;
    },
  };
}

/**
 * Loads the library in a THROWAWAY CHILD, as the daemon does: `fyd --check` never `dlopen`s it in its own process, so a
 * library that crashes on this machine ends the child (and says so on the `voice` line), not the check. The child is the
 * daemon's own executable (`$daemon`), asked once to load the addon and to say its version, and ended again.
 */
async function loadInChild(path: string, environment: SelftestEnvironment): Promise<string> {
  if (environment.spawn === undefined) throw new Error('this check cannot start a child process');
  const host = startChildThread<SpeechCall, SpeechReply & { readonly ok: true }>({
    spawn: environment.spawn,
    clock: environment.clock,
    command: nativeHostCommand('speech'),
    words: 'native speech engine',
  });
  try {
    const reply = await host.call({ kind: 'probe', addon: path });
    if (reply.kind !== 'probe') throw new Error('it answered something else');
    return reply.version;
  } finally {
    await host.terminate();
  }
}
