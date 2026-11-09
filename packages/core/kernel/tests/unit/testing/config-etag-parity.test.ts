/**
 * `ConfigPort.etag`: a plugin asks the etag of ONE of its OWN declared files, so a change can be pinned (`ifMatch`) to
 * what a caller read without the plugin ever being handed the file. The real config service and the testing host answer
 * it the same way — the same refusals, `'absent'` for no file, an etag the writer takes as `ifMatch` — on one shared
 * table. (The etag itself differs by host: the real one hashes the file's text, the testing host's world holds values
 * and answers their JSON, as its writes do.)
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineConfig } from '../../../contract/index.ts';
import type { ConfigPort } from '../../../contract/ports.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { createMemoryHostFs, type MemoryHostFs } from '../../../host/state/memory-fs.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { testHost } from '../../../testing/index.ts';
import { captureLog, HOME, manualClock } from '../host-config/support.ts';

const limitsDef = defineConfig({
  file: 'limits.yaml',
  schema: z.strictObject({ limit: z.number().int().default(10), note: z.string().optional() }),
  axis: 'configure',
  loosens: () => [],
});
const itemsDef = defineConfig({
  collection: 'items',
  name: /^[a-z]{1,10}$/,
  schema: z.strictObject({ budget: z.number().optional() }),
  axis: 'configure',
  loosens: () => [],
});
const strangerDef = defineConfig({
  file: 'stranger.yaml',
  schema: z.strictObject({}),
  axis: 'configure',
  loosens: () => [],
});

const own = definePlugin({
  id: 'runtimes',
  title: 'Runtimes',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  data: { config: [limitsDef, itemsDef] },
});
const other = definePlugin({
  id: 'stranger',
  title: 'Stranger',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  data: { config: [strangerDef] },
});

interface Side {
  readonly config: ConfigPort;
  stop(): Promise<void>;
  /** Only the real service has a disk to edit behind the kernel's back. */
  readonly disk?: { edit(path: string, text: string): void };
}

async function testing(): Promise<Side> {
  let config: ConfigPort | undefined;
  const half = implementDaemon(own, {
    build: ctx => {
      config = ctx.kernel.config;
      return {};
    },
  });
  const host = await testHost({
    plugins: [half, implementDaemon(other, { build: () => ({}) })],
    gate: { judgeConfigWrite: () => 'hold' } as never,
  });
  if (config === undefined) throw new Error('the half was not built');
  return { config, stop: () => host.stop() };
}

async function real(): Promise<Side & { readonly fs: MemoryHostFs }> {
  const fs = createMemoryHostFs();
  const files = createConfigFiles({
    home: HOME,
    fs,
    clock: manualClock(),
    log: captureLog(),
    binary: 'fy',
    defs: [
      { plugin: 'runtimes', def: limitsDef },
      { plugin: 'runtimes', def: itemsDef },
      { plugin: 'stranger', def: strangerDef },
    ],
  });
  await files.reload();
  return {
    config: files.port('runtimes'),
    fs,
    stop: async () => undefined,
    disk: { edit: (path, text) => fs.seed(`${HOME}/config/${path}`, text) },
  };
}

describe.each([
  ['the testing host', testing],
  ['the real config service', real],
] as const)('ConfigPort.etag — %s', (_label, make) => {
  test('an own file that is not there has the absent etag; a collection item too', async () => {
    const side = await make();
    expect(await side.config.etag(limitsDef)).toBe('absent');
    expect(await side.config.etag(itemsDef, 'alpha')).toBe('absent');
    await side.stop();
  });

  test('an own file that is there has an etag, a string that changes when the file does', async () => {
    const side = await make();
    await side.config.write(limitsDef, undefined, { patch: { limit: 3 } });
    const first = await side.config.etag(limitsDef);
    expect(typeof first).toBe('string');
    expect(first).not.toBe('absent');
    await side.config.write(limitsDef, undefined, { patch: { limit: 4 } });
    expect(await side.config.etag(limitsDef)).not.toBe(first);
    await side.stop();
  });

  test('the etag is the one the writer takes as ifMatch, and a stale one is a conflict', async () => {
    const side = await make();
    await side.config.write(itemsDef, 'alpha', { patch: { budget: 1 } });
    const read = await side.config.etag(itemsDef, 'alpha');

    const pinned = await side.config.write(itemsDef, 'alpha', { patch: { budget: 2 } }, { ifMatch: read });
    const stale = await side.config.write(itemsDef, 'alpha', { patch: { budget: 3 } }, { ifMatch: read });

    expect(pinned.kind).toBe('written');
    expect(stale.kind).toBe('conflict');
    await side.stop();
  });

  test('the absent etag is accepted as ifMatch for a file that is not there yet', async () => {
    const side = await make();
    const written = await side.config.write(itemsDef, 'beta', { patch: { budget: 1 } }, { ifMatch: 'absent' });
    expect(written.kind).toBe('written');
    await side.stop();
  });

  test('another plugin’s file is refused', async () => {
    const side = await make();
    await expect(side.config.etag(strangerDef)).rejects.toThrow();
    await side.stop();
  });

  test('a name that is no file of the def is refused: one for a single file, none or a bad one for a collection', async () => {
    const side = await make();
    await expect(side.config.etag(limitsDef, 'alpha')).rejects.toThrow();
    await expect(side.config.etag(itemsDef)).rejects.toThrow();
    await expect(side.config.etag(itemsDef, 'NOT_A_NAME')).rejects.toThrow();
    await expect(side.config.etag(itemsDef, '../limits')).rejects.toThrow();
    await side.stop();
  });
});

describe('ConfigPort.etag — the real config service only', () => {
  test('it is read from the disk when asked, and is the etag the service reads the file at', async () => {
    const side = await real();
    await side.config.write(limitsDef, undefined, { patch: { limit: 3 } });
    const before = await side.config.etag(limitsDef);

    side.disk?.edit('limits.yaml', 'limit: 8\n');
    const after = await side.config.etag(limitsDef);

    expect(after).not.toBe(before);
    // sha256 of the TEXT, as every write reckons it
    expect(after).toBe(new Bun.CryptoHasher('sha256').update('limit: 8\n').digest('hex'));
  });

  test('it hands back the etag and nothing of the file: no text, value or planted secret', async () => {
    const side = await real();
    const planted = 'sk-live-PLANTEDplantedPLANTED0123456789';
    side.disk?.edit('limits.yaml', `limit: 5\nnote: ${planted}\n`);

    const answer = await side.config.etag(limitsDef);

    expect(typeof answer).toBe('string');
    expect(answer).toMatch(/^[0-9a-f]{64}$/u);
    expect(answer).not.toContain(planted);
    expect(answer).not.toContain('limit');
  });
});
