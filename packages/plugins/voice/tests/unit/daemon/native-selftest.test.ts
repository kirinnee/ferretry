import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { voiceNativeSelftest } from '../../../daemon/adapters/native-selftest.ts';
import { ENGINE_DIR } from '../../../daemon/lib/engine/catalog.ts';
import { NATIVE_ADDON_ROLE, type NativeTarget } from '../../../daemon/lib/native/catalog.ts';
import { REPLY_DIR } from '../../../daemon/lib/reply/catalog.ts';

/** `fyd --check`'s `voice` line, for every state a machine can be in. The real library is proved by the compiled binary's smoke. */
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const file = (role: string, text: string) => ({
  role,
  label: role,
  url: `https://cdn.jsdelivr.net/npm/x/${role}`,
  bytes: bytes(text).byteLength,
  sha256: createHash('sha256').update(bytes(text)).digest('hex'),
});
const TARGET: NativeTarget = {
  key: 'test-x64',
  files: [
    file(NATIVE_ADDON_ROLE, 'addon'),
    file('libsherpa-onnx-c-api.so', 'c api'),
    file('libonnxruntime.so', 'runtime'),
  ],
};
const TEXT: Record<string, string> = {
  [NATIVE_ADDON_ROLE]: 'addon',
  'libsherpa-onnx-c-api.so': 'c api',
  'libonnxruntime.so': 'runtime',
};

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function state(folder: string | undefined, overrides: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ferretry-voice-selftest-'));
  dirs.push(root);
  if (folder !== undefined) {
    await mkdir(join(root, 'models', folder), { recursive: true });
    for (const role of Object.keys(TEXT))
      await writeFile(join(root, 'models', folder, role), overrides[role] ?? (TEXT[role] as string));
  }
  return root;
}

const run = async (stateDir: string | undefined, load: (path: string) => string = () => '2.0.3', platform = 'test') =>
  await voiceNativeSelftest({
    platform,
    arch: 'x64',
    load,
    targetFor: () => (platform === 'test' ? TARGET : undefined),
  }).run({
    ...(stateDir === undefined ? {} : { stateDir }),
    tempDir: tmpdir(),
    signal: new AbortController().signal,
    clock: { nowMs: () => 0, after: () => () => undefined },
  });

describe('the voice line of fyd --check', () => {
  test('is a host probe labelled `voice`, a label the kernel lets a plugin print', () => {
    const probe = voiceNativeSelftest();
    expect(probe.label).toBe('voice');
    expect(probe.host).toBe(true);
    expect(probe.label.length).toBeLessThanOrEqual(11);
  });

  test('says there is no native engine for a platform with none, and that voice runs on WebAssembly', async () => {
    expect(await run(await state(undefined), undefined, 'plan9')).toContain('no native speech engine for plan9-x64');
  });

  test('says "not installed" as a plain fact, not a failure, when no engine has fetched it', async () => {
    const text = await run(await state(undefined));
    expect(text).toContain('native engine not installed');
    expect(text.startsWith('!')).toBe(false);
  });

  test('loads the pinned files from the reply voice’s folder or the speech engine’s, and names the version', async () => {
    for (const folder of [REPLY_DIR, ENGINE_DIR]) {
      const loaded: string[] = [];
      const text = await run(await state(folder), path => {
        loaded.push(path);
        return '2.0.3';
      });
      expect(text).toBe(
        `native engine ready (sherpa-onnx 2.0.3, test-x64, pinned files verified, loaded from ${folder})`,
      );
      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.endsWith(`/${folder}/${NATIVE_ADDON_ROLE}`)).toBe(true);
    }
  });

  test('a saved file that is not the pinned bytes is reported and never loaded', async () => {
    let loads = 0;
    const text = await run(await state(REPLY_DIR, { 'libonnxruntime.so': 'runtimX' }), () => {
      loads += 1;
      return '2.0.3';
    });
    expect(text.startsWith('! ')).toBe(true);
    expect(text).toContain('libonnxruntime.so');
    expect(loads).toBe(0);
  });

  test('a saved library that would not start says why and what runs instead', async () => {
    const text = await run(await state(REPLY_DIR), () => {
      throw new Error('libstdc++.so.6: cannot open shared object file');
    });
    expect(text.startsWith('! ')).toBe(true);
    expect(text).toContain('libstdc++.so.6');
    expect(text).toContain('WebAssembly');
  });
});
