import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { BrowsersConfigSchema } from '../../../../contract/index.ts';
import { browsersLoosens } from '../../../../contract/config-loosens.ts';
import {
  CLOAKBROWSER_REFUSAL,
  ENGINE_DOWNLOAD_HOSTS,
  type EnginePorts,
  EngineResolver,
  engineFlags,
  engineSeed,
  FINGERPRINT_CHROMIUM_RELEASE,
} from '../../../../daemon/worker/control/engines.ts';
import { agentBrowserArguments } from '../../../../daemon/worker/control/policy.ts';
import manifest from '../../../../manifest.ts';

const STATE = '/home/fy/state/browsers';
const BYTES = new TextEncoder().encode('a fake engine archive');
const RELEASE = {
  version: '1.2.3.4',
  url: 'https://github.com/example/engine/releases/download/1.2.3.4/engine.tar.xz',
  sha256: createHash('sha256').update(BYTES).digest('hex'),
  bytes: BYTES.length,
};
const ASSET = 'https://release-assets.githubusercontent.com/asset?token=short-lived';

function world(
  options: {
    readonly platform?: NodeJS.Platform;
    readonly arch?: string;
    readonly installed?: boolean;
    readonly served?: Uint8Array;
    readonly unpackExit?: number;
  } = {},
) {
  const requested: string[] = [];
  const written: string[] = [];
  const spawned: { program: string; args: readonly string[] }[] = [];
  const renamed: string[] = [];
  const removed: string[] = [];
  const logged: { message: string; fields: Readonly<Record<string, string | number>> }[] = [];
  const ports: EnginePorts = {
    platform: options.platform ?? 'linux',
    arch: options.arch ?? 'x64',
    stateDirectory: STATE,
    path: '/usr/bin',
    exists: path => options.installed === true && path === `${STATE}/engines/fingerprint-chromium/1.2.3.4/chrome`,
    fetch: {
      request: async url => {
        requested.push(String(url));
        // GitHub answers the release address with a redirect to the host that serves the asset.
        if (String(url) === RELEASE.url) return new Response(null, { status: 302, headers: { location: ASSET } });
        return new Response((options.served ?? BYTES).slice().buffer, { status: 200 });
      },
    },
    spawn: {
      run: async (program, args) => {
        spawned.push({ program, args });
        return { exitCode: options.unpackExit ?? 0, signal: null, stdout: '', stderr: '' };
      },
    },
    writeFile: async path => void written.push(path),
    rename: async (from, to) => void renamed.push(`${from} -> ${to}`),
    remove: async path => void removed.push(path),
    info: (message, fields) => void logged.push({ message, fields }),
  };
  return { resolver: new EngineResolver(ports, RELEASE), requested, written, spawned, renamed, removed, logged };
}

describe('an engine’s switches', () => {
  test('are none for the machine’s own Chromium, and a seed plus an honest platform for fingerprint-chromium', () => {
    expect(engineFlags('chromium', 7, 'linux')).toEqual([]);
    expect(engineFlags('cloakbrowser', 7, 'linux')).toEqual([]);
    expect(engineFlags('fingerprint-chromium', 7, 'linux')).toEqual([
      '--fingerprint=7',
      '--fingerprint-platform=linux',
    ]);
    expect(engineFlags('fingerprint-chromium', 7, 'darwin')).toEqual([
      '--fingerprint=7',
      '--fingerprint-platform=macos',
    ]);
  });

  test('take a seed that is the same every time for one place and another for a different one, always a positive 31-bit integer', () => {
    expect(engineSeed(STATE)).toBe(engineSeed(STATE));
    expect(engineSeed(STATE)).not.toBe(engineSeed('/home/other/state/browsers'));
    for (const key of [STATE, '', '/a', '/b/c']) {
      expect(engineSeed(key)).toBeGreaterThan(0);
      expect(engineSeed(key)).toBeLessThanOrEqual(0x7fffffff);
    }
  });

  test('reach the agent browser’s command line only when an engine brings some', () => {
    const view = { width: 800, height: 600 };
    const plain = agentBrowserArguments('/e/chrome', '/p', { kind: 'port', port: 9 }, view, 'linux', 'window');
    const patched = agentBrowserArguments('/e/chrome', '/p', { kind: 'port', port: 9 }, view, 'linux', 'window', {
      engineFlags: ['--fingerprint=7', '--fingerprint-platform=linux'],
    });
    expect(plain.some(argument => argument.startsWith('--fingerprint'))).toBe(false);
    expect(patched).toContain('--fingerprint=7');
    expect(patched).toContain('--fingerprint-platform=linux');
    expect(patched.filter(argument => !argument.startsWith('--fingerprint'))).toEqual([...plain]);
  });
});

describe('resolving an engine', () => {
  test('leaves the machine’s Chromium alone: nothing fetched, nothing written', async () => {
    const w = world();
    expect(await w.resolver.resolve('chromium')).toBeUndefined();
    expect(w.requested).toEqual([]);
  });

  test('refuses cloakbrowser with one plain sentence, fetching and starting nothing', async () => {
    const w = world();
    await expect(w.resolver.resolve('cloakbrowser')).rejects.toThrow(CLOAKBROWSER_REFUSAL);
    expect(CLOAKBROWSER_REFUSAL).toContain('proprietary');
    expect(w.requested).toEqual([]);
    expect(w.spawned).toEqual([]);
  });

  test('uses fingerprint-chromium where it is already installed, without a single request', async () => {
    const w = world({ installed: true });
    const launch = await w.resolver.resolve('fingerprint-chromium');
    expect(launch?.executable).toBe(`${STATE}/engines/fingerprint-chromium/1.2.3.4/chrome`);
    expect(launch?.flags).toEqual([`--fingerprint=${engineSeed(STATE)}`, '--fingerprint-platform=linux']);
    expect(w.requested).toEqual([]);
    expect(w.logged).toEqual([]);
  });

  test('fetches it on first use: says so first, follows the redirect hop by hop, unpacks beside it and moves it into place', async () => {
    const w = world();
    const launch = await w.resolver.resolve('fingerprint-chromium');
    expect(w.logged).toHaveLength(1);
    expect(w.logged[0]?.fields).toMatchObject({ url: RELEASE.url, sha256: RELEASE.sha256 });
    expect(w.requested).toEqual([RELEASE.url, ASSET]);
    expect(w.spawned).toEqual([
      {
        program: 'tar',
        args: [
          '-xJf',
          `${STATE}/engines/fingerprint-chromium/1.2.3.4.tar.xz.part`,
          '--strip-components=1',
          `--one-top-level=${STATE}/engines/fingerprint-chromium/1.2.3.4.staging`,
        ],
      },
    ]);
    expect(w.renamed).toEqual([
      `${STATE}/engines/fingerprint-chromium/1.2.3.4.staging -> ${STATE}/engines/fingerprint-chromium/1.2.3.4`,
    ]);
    expect(w.removed).toContain(`${STATE}/engines/fingerprint-chromium/1.2.3.4.tar.xz.part`);
    expect(launch?.executable).toBe(`${STATE}/engines/fingerprint-chromium/1.2.3.4/chrome`);
  });

  test('throws away a download of the wrong size or the wrong hash, unpacking nothing', async () => {
    for (const served of [new TextEncoder().encode('short'), new TextEncoder().encode('a fake engine archivX')]) {
      const w = world({ served });
      await expect(w.resolver.resolve('fingerprint-chromium')).rejects.toThrow(
        /Could not fetch the fingerprint-chromium engine/u,
      );
      expect(w.written).toEqual([]);
      expect(w.spawned).toEqual([]);
      expect(w.renamed).toEqual([]);
    }
  });

  test('says why when the archive cannot be unpacked, and leaves no half-installed folder', async () => {
    const w = world({ unpackExit: 2 });
    await expect(w.resolver.resolve('fingerprint-chromium')).rejects.toThrow(/tar exited with code 2/u);
    expect(w.renamed).toEqual([]);
    expect(w.removed).toContain(`${STATE}/engines/fingerprint-chromium/1.2.3.4.staging`);
  });

  test('is fetched for Linux on x86-64 only, and says so elsewhere', async () => {
    for (const where of [{ platform: 'darwin' as const }, { arch: 'arm64' }]) {
      const w = world(where);
      await expect(w.resolver.resolve('fingerprint-chromium')).rejects.toThrow(/Linux on x86-64 only/u);
      expect(w.requested).toEqual([]);
    }
  });
});

describe('the engine as a machine setting', () => {
  test('defaults to chromium, and the one pinned release is fetched only from the hosts the manifest declares', () => {
    expect(BrowsersConfigSchema.parse({}).engine).toBe('chromium');
    expect(BrowsersConfigSchema.safeParse({ engine: 'camoufox' }).success).toBe(false);
    for (const host of ENGINE_DOWNLOAD_HOSTS) expect(manifest.permissions.network).toContain(host);
    expect(new URL(FINGERPRINT_CHROMIUM_RELEASE.url).hostname).toBe(ENGINE_DOWNLOAD_HOSTS[0]);
    expect(FINGERPRINT_CHROMIUM_RELEASE.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  test('is held for the owner when it moves off chromium, and applies at once on the way back', () => {
    const chromium = BrowsersConfigSchema.parse({});
    const patched = BrowsersConfigSchema.parse({ engine: 'fingerprint-chromium' });
    expect(browsersLoosens(chromium, patched)).toEqual([
      "the agent browser now runs the fingerprint-chromium engine instead of the machine's Chromium",
    ]);
    expect(browsersLoosens(patched, patched)).toEqual([]);
    expect(browsersLoosens(patched, chromium)).toEqual([]);
    expect(browsersLoosens(undefined, chromium)).toEqual([]);
  });
});
