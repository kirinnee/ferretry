import { describe, expect, test } from 'bun:test';
import type { FencedPath } from '../../../contract/bound.ts';
import { MAX_ROOT_WINDOW_BYTES, type RootHandle } from '../../../contract/ports.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { testHost } from '../../../testing/index.ts';

const manifest = definePlugin({
  id: 'codex',
  title: 'Codex',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  permissions: { roots: ['downloads'] },
});

describe('WW the test host mirrors bounded root reads', () => {
  test('a window, a tail with its size, and the cap', async () => {
    let root: RootHandle | undefined;
    const half = implementDaemon(manifest, {
      build: ({ kernel }) => {
        root = kernel.roots.root('downloads');
        return {};
      },
    });
    const host = await testHost({ plugins: [half] });
    if (root === undefined) throw new Error('not built');
    const resolved = root.resolve('rollout.jsonl');
    if (!resolved.ok) throw new Error(resolved.error);
    const path: FencedPath = resolved.value;
    await root.writeText(path, '0123456789');
    const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
    expect(text(await root.readBytes(path, { offset: 2, length: 3 }))).toBe('234');
    const tail = await root.readTail(path, 4);
    expect({ text: text(tail.bytes), size: tail.size }).toEqual({ text: '6789', size: 10 });
    await expect(root.readTail(path, MAX_ROOT_WINDOW_BYTES + 1)).rejects.toThrow();
    await host.stop();
  });
});
