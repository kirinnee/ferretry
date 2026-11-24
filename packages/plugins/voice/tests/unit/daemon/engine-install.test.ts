import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ENGINE_HOSTS, VoiceEngineError } from '../../../contract/index.ts';
import { ENGINE_FILES, type EngineFile } from '../../../daemon/lib/engine/catalog.ts';
import { download, installFiles } from '../../../daemon/lib/engine/installer.ts';
import type { EngineFilesPort, HttpPort } from '../../../daemon/lib/engine/ports.ts';
import { SHERPA_RUNTIME } from '../../../app/lib/stt/sherpa-models.ts';

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const pin = (role: EngineFile['role'], bytes: Uint8Array, url = `https://huggingface.co/x/${role}`): EngineFile => ({
  role,
  label: `The ${role}`,
  url,
  bytes: bytes.byteLength,
  sha256: sha(bytes),
});
const stream = (bytes: Uint8Array, chunk = 3): Response =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (let at = 0; at < bytes.byteLength; at += chunk) controller.enqueue(bytes.slice(at, at + chunk));
        controller.close();
      },
    }),
  );

class Files implements EngineFilesPort {
  readonly held = new Map<string, Uint8Array>();
  async size(file: { role: string }) {
    return this.held.get(file.role)?.byteLength;
  }
  async read(file: { role: string }) {
    return this.held.get(file.role);
  }
  async write(file: { role: string }, bytes: Uint8Array) {
    this.held.set(file.role, bytes);
  }
  async remove(file: { role: string }) {
    this.held.delete(file.role);
  }
}

const GOOD = new TextEncoder().encode('exactly the pinned bytes');

describe('the engine catalog pins what the app and the package ship', () => {
  test('the sherpa runtime is the very file the app pins, and the lockfile’s onnxruntime-web is the one pinned here', () => {
    const sherpa = ENGINE_FILES.find(file => file.role === 'sherpa-wasm');
    expect(sherpa).toMatchObject({ bytes: SHERPA_RUNTIME.file.bytes, sha256: SHERPA_RUNTIME.file.sha256 });
    const ort = ENGINE_FILES.find(file => file.role === 'ort-wasm');
    const installed = readFileSync(
      new URL('../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', import.meta.url),
    );
    expect(ort).toMatchObject({ bytes: installed.byteLength, sha256: sha(installed) });
    expect(ort?.url).toContain('onnxruntime-web@1.24.1');
  });

  test('every role the worker loads is pinned once, and every file is fetched from a host the manifest declares', () => {
    expect(ENGINE_FILES.map(file => String(file.role)).sort()).toEqual([
      'decoder',
      'encoder',
      'joiner',
      'ort-wasm',
      'sherpa-wasm',
      'tokens',
      'vad',
    ]);
    for (const file of ENGINE_FILES) {
      const host = new URL(file.url).hostname;
      expect(
        ENGINE_HOSTS.some(entry => entry === host || (entry.startsWith('*.') && host.endsWith(entry.slice(1)))),
      ).toBe(true);
      expect(file.url.startsWith('https://')).toBe(true);
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/u);
    }
  });
});

describe('download: only the pinned bytes are kept', () => {
  const file = pin('tokens', GOOD);

  test('the pinned bytes arrive intact and each chunk is counted', async () => {
    let seen = 0;
    const bytes = await download({ request: async () => stream(GOOD) }, file, n => {
      seen += n;
    });
    expect(new TextDecoder().decode(bytes)).toBe('exactly the pinned bytes');
    expect(seen).toBe(GOOD.byteLength);
  });

  test('a file with one flipped bit is refused as hash_mismatch', async () => {
    const tampered = GOOD.slice();
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    await expect(download({ request: async () => stream(tampered) }, file, () => undefined)).rejects.toMatchObject({
      code: 'hash_mismatch',
    });
  });

  test('a server that sends too much or too little is refused', async () => {
    const long = new Uint8Array([...GOOD, 1]);
    await expect(download({ request: async () => stream(long) }, file, () => undefined)).rejects.toMatchObject({
      code: 'hash_mismatch',
    });
    await expect(
      download({ request: async () => stream(GOOD.slice(0, 5)) }, file, () => undefined),
    ).rejects.toMatchObject({ code: 'hash_mismatch' });
  });

  test('a refusal or a dropped connection is download_failed, and a redirect loop is stopped', async () => {
    await expect(
      download({ request: async () => new Response('no', { status: 404 }) }, file, () => undefined),
    ).rejects.toMatchObject({
      code: 'download_failed',
    });
    await expect(
      download(
        {
          request: async () => {
            throw new Error('offline');
          },
        },
        file,
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: 'download_failed' });
    const loop: HttpPort = {
      request: async () => new Response(null, { status: 302, headers: { location: '/again' } }),
    };
    await expect(download(loop, file, () => undefined)).rejects.toBeInstanceOf(VoiceEngineError);
  });

  test('redirects are followed by hand, hop by hop, relative ones resolved against the hop', async () => {
    const asked: string[] = [];
    const http: HttpPort = {
      request: async url => {
        asked.push(url);
        if (url === file.url)
          return new Response(null, { status: 302, headers: { location: 'https://us.aws.cdn.hf.co/blob?x=1' } });
        return stream(GOOD);
      },
    };
    await download(http, file, () => undefined);
    expect(asked).toEqual([file.url, 'https://us.aws.cdn.hf.co/blob?x=1']);
  });
});

describe('installFiles', () => {
  test('writes a file only after it verified, and keeps nothing of one that did not', async () => {
    const files = new Files();
    const good = pin('encoder', GOOD);
    const bad = pin('tokens', new TextEncoder().encode('what the pin says'));
    const http: HttpPort = {
      request: async url => (url === good.url ? stream(GOOD) : stream(new TextEncoder().encode('SOMETHING ELSE!!!!'))),
    };
    await expect(installFiles(http, files, () => undefined, [good, bad])).rejects.toMatchObject({
      code: 'hash_mismatch',
    });
    expect([...files.held.keys()]).toEqual(['encoder']);
  });

  test('a file already present at its pinned size is not downloaded again, and still counts for progress', async () => {
    const files = new Files();
    const file = pin('encoder', GOOD);
    files.held.set('encoder', GOOD);
    let asked = 0;
    let counted = 0;
    await installFiles(
      {
        request: async () => {
          asked += 1;
          return stream(GOOD);
        },
      },
      files,
      n => {
        counted += n;
      },
      [file],
    );
    expect(asked).toBe(0);
    expect(counted).toBe(GOOD.byteLength);
  });

  test('a write that fails is write_failed', async () => {
    const files = new Files();
    files.write = async () => {
      throw new Error('disk full');
    };
    await expect(
      installFiles({ request: async () => stream(GOOD) }, files, () => undefined, [pin('encoder', GOOD)]),
    ).rejects.toMatchObject({ code: 'write_failed' });
  });
});
