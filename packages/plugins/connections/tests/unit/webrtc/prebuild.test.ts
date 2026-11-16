/**
 * R688: every release target embeds its own `node-datachannel` prebuild, and the build fails when one is missing
 * (`docs/relay-protocol.md` §16, "The engine"; `scripts/release/node-datachannel-prebuild.ts`).
 *
 * WHICH HALF RUNS WHERE. The decision (which target takes which prebuild, and that a target with none or a prebuild that
 * is not installed fails the compile) is proved here on any machine, from the targets `compile.sh` really ships. That a
 * darwin binary STARTS with its addon needs a macOS runner, and is the release smoke's (`fyd --check`), not this test's.
 */
import { describe, expect, test } from 'bun:test';
import {
  installedPrebuild,
  NODE_DATACHANNEL_PREBUILDS,
  nodeDataChannelPrebuild,
} from '../../../../../../scripts/release/node-datachannel-prebuild.ts';

const read = async (relative: string): Promise<string> => await Bun.file(new URL(relative, import.meta.url)).text();

/** The release targets `compile.sh` compiles: bun target, artifact suffix, os, cpu. */
async function releaseTargets(): Promise<
  ReadonlyArray<{ readonly target: string; readonly os: string; readonly cpu: string }>
> {
  const script = await read('../../../../../../scripts/release/compile.sh');
  const block = script.match(/all_targets="([^"]*)"/u)?.[1];
  if (block === undefined) throw new Error('compile.sh no longer lists its release targets');
  return block
    .split('\n')
    .filter(row => row.trim() !== '')
    .map(row => {
      const [target, , os, cpu] = row.split('\t');
      if (target === undefined || os === undefined || cpu === undefined)
        throw new Error(`malformed target row: ${row}`);
      return { target, os, cpu };
    });
}

describe('the prebuild every compile target embeds', () => {
  test('R688 every release target compile.sh ships takes a prebuild for its own platform and CPU', async () => {
    const targets = await releaseTargets();

    expect(targets.length).toBeGreaterThanOrEqual(3);
    for (const { target, os, cpu } of targets) {
      const specifier = nodeDataChannelPrebuild(target, 'bun-linux-x64');
      const platform = specifier.match(/^@node-datachannel\/([a-z0-9-]+)\/node_datachannel\.node$/u)?.[1];
      // The prebuild is named for the target's own operating system and CPU, never the machine compiling it.
      expect(platform).toBeDefined();
      expect(platform?.startsWith(`${os}-${cpu}`)).toBe(true);
    }
  });

  test('R688 a cross-compile takes the target’s prebuild, not the compiling machine’s', () => {
    expect(nodeDataChannelPrebuild('bun-darwin-arm64', 'bun-linux-x64')).toBe(
      '@node-datachannel/darwin-arm64/node_datachannel.node',
    );
    expect(nodeDataChannelPrebuild('bun-linux-arm64', 'bun-darwin-arm64')).toBe(
      '@node-datachannel/linux-arm64-gnu/node_datachannel.node',
    );
    // Its CPU variants take the prebuild of the target itself.
    expect(nodeDataChannelPrebuild('bun-linux-x64-baseline', 'bun-darwin-arm64')).toBe(
      '@node-datachannel/linux-x64-gnu/node_datachannel.node',
    );
    expect(nodeDataChannelPrebuild('bun-linux-x64-modern', 'bun-darwin-arm64')).toBe(
      '@node-datachannel/linux-x64-gnu/node_datachannel.node',
    );
  });

  test('R688 with no target the native build takes the compiling machine’s own prebuild', () => {
    expect(nodeDataChannelPrebuild(undefined, 'bun-linux-x64')).toBe(
      '@node-datachannel/linux-x64-gnu/node_datachannel.node',
    );
    expect(nodeDataChannelPrebuild(undefined, 'bun-darwin-x64')).toBe(
      '@node-datachannel/darwin-x64/node_datachannel.node',
    );
  });

  test('R688 a target with no mapped prebuild fails the build, naming the target and where to add it', () => {
    expect(() => nodeDataChannelPrebuild('bun-windows-x64', 'bun-linux-x64')).toThrow(
      'no node-datachannel prebuild is mapped for bun-windows-x64; add it to scripts/release/node-datachannel-prebuild.ts',
    );
    // With no target, it is the compiling machine that has none.
    expect(() => nodeDataChannelPrebuild(undefined, 'bun-freebsd-x64')).toThrow('bun-freebsd-x64');
  });

  test('R688 a mapped prebuild that is not installed fails the build, saying how to install every target’s', () => {
    const specifier = nodeDataChannelPrebuild('bun-darwin-arm64', 'bun-linux-x64');
    const missing = (): never => {
      throw new Error('Cannot find module');
    };

    expect(() =>
      installedPrebuild(specifier, '/repo/node_modules/node-datachannel/dist/esm/lib/node-datachannel.mjs', missing),
    ).toThrow(
      `${specifier} is not installed beside /repo/node_modules/node-datachannel/dist/esm/lib; a cross-compile needs every target's prebuild (scripts/release/compile.sh installs them)`,
    );
    expect(installedPrebuild(specifier, '/loader.mjs', name => `/installed/${name}`)).toBe(`/installed/${specifier}`);
  });

  test('R688 every mapped prebuild is a package the lockfile pins, so an install fetches it', async () => {
    const lock = await read('../../../../../../bun.lock');
    for (const prebuild of Object.values(NODE_DATACHANNEL_PREBUILDS))
      expect(lock).toContain(`"@node-datachannel/${prebuild}"`);
  });

  test('R688 compile.sh installs the prebuilds for every platform being compiled, and the compile step takes its table from here', async () => {
    const script = await read('../../../../../../scripts/release/compile.sh');
    const compile = await read('../../../../../../scripts/release/compile-executable.ts');

    expect(script).toContain('bun install --frozen-lockfile "${install_os[@]}" "${install_cpu[@]}"');
    expect(compile).toContain("from './node-datachannel-prebuild.ts'");
    // One table: the compile step carries no second spelling of a target.
    expect(compile).not.toMatch(/'bun-(linux|darwin)-[a-z0-9-]+':/u);
  });
});
