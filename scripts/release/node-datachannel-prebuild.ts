/**
 * WHICH `node-datachannel` PREBUILD EACH COMPILE TARGET EMBEDS (`docs/relay-protocol.md` §16, "The engine").
 *
 * The WebRTC engine is a native addon, and its loader picks `@node-datachannel/<platform>` with a COMPUTED path the
 * bundler cannot see, so `compile-executable.ts` replaces the loader with an import of the prebuild named here. EVERY
 * TARGET EMBEDS ITS OWN, AND THE BUILD FAILS WHEN ONE IS MISSING: a target with no mapping, or whose prebuild is not
 * installed, throws here rather than shipping a daemon whose peer-to-peer carrier can never start (R688).
 *
 * It is a module of its own, apart from the compile step's top-level program, so the decision is testable on any
 * machine: which target takes which prebuild needs no macOS, only the running of the binary does.
 */
import { dirname } from 'node:path';

/**
 * Every Bun compile target this repository ships, and its prebuild. glibc for Linux: every Linux target shipped here is
 * a glibc one, and a musl target is mapped explicitly rather than guessed.
 */
export const NODE_DATACHANNEL_PREBUILDS: Readonly<Record<string, string>> = Object.freeze({
  'bun-linux-x64': 'linux-x64-gnu',
  'bun-linux-arm64': 'linux-arm64-gnu',
  'bun-linux-x64-musl': 'linux-x64-musl',
  'bun-linux-arm64-musl': 'linux-arm64-musl',
  'bun-darwin-arm64': 'darwin-arm64',
  'bun-darwin-x64': 'darwin-x64',
});

/**
 * The `@node-datachannel/*` prebuild for a Bun compile target, or for the machine running the compile (`host`, spelled
 * as a Bun target) when there is no target — the Nix build compiles natively. The `-baseline` and `-modern` CPU
 * variants of a target take the prebuild of the target itself.
 */
export function nodeDataChannelPrebuild(target: string | undefined, host: string): string {
  const named = (target ?? host).replace(/-(baseline|modern)$/u, '');
  const prebuild = NODE_DATACHANNEL_PREBUILDS[named];
  if (prebuild === undefined) {
    throw new Error(
      `no node-datachannel prebuild is mapped for ${target ?? host}; add it to scripts/release/node-datachannel-prebuild.ts`,
    );
  }
  return `@node-datachannel/${prebuild}/node_datachannel.node`;
}

/**
 * The installed file for `specifier`, resolved the way the loader being replaced would resolve it. A prebuild that is
 * not installed fails the build, naming how to install every target's.
 */
export function installedPrebuild(specifier: string, loader: string, resolve: (specifier: string) => string): string {
  try {
    return resolve(specifier);
  } catch {
    throw new Error(
      `${specifier} is not installed beside ${dirname(loader)}; a cross-compile needs every target's prebuild (scripts/release/compile.sh installs them)`,
    );
  }
}
