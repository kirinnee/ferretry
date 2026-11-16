import { describe, expect, test } from 'bun:test';
import { ApiError, type Log } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import { createConfigFiles } from '../../../../../core/kernel/host/config/service.ts';
import { createMemoryHostFs } from '../../../../../core/kernel/host/state/memory-fs.ts';
import { PACKS_CONFIG, type ReplacedRouting } from '../../../contract/index.ts';
import { ConfigGuideWriter } from '../../../daemon/adapters/guide-config.ts';
import { GuideFileService } from '../../../daemon/lib/cleanup/file.ts';

/**
 * Accept and Undo against the REAL config service: a save made on disk that the daemon has not yet reloaded (no
 * watcher event) must be what an accept keeps and an undo restores, never the older prompt the cache still holds.
 */
const HOME = '/fixture/guide-snapshot';
const PATH = `${HOME}/config/packs.yaml`;
const SUGGESTED = { by: 'model', via: 'runtime', mode: 'clean-up', at: '2026-11-14T00:00:00.000Z' as Instant } as const;

const silentLog: Log = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLog,
};

async function world(text: string) {
  const fs = createMemoryHostFs();
  fs.seed(PATH, text);
  const files = createConfigFiles({
    home: HOME,
    fs,
    clock: { nowMs: () => 1_000_000, after: () => () => undefined, every: () => () => undefined } as never,
    log: silentLog,
    binary: 'fy',
    defs: [{ plugin: 'packs', def: PACKS_CONFIG }],
  });
  await files.reload();
  const config = files.port('packs');
  const writer = new ConfigGuideWriter(config);
  let replaced: ReplacedRouting | undefined;
  const guide = new GuideFileService({
    read: async () => await writer.read(),
    write: async (routing, etag) => await writer.write(routing, etag),
    replaced: {
      read: async () => replaced,
      write: async value => {
        replaced = value;
      },
    },
    now: () => '2026-11-14T00:00:00.000Z',
  });
  return { fs, config, writer, guide, replaced: () => replaced };
}

describe('guide accept and undo over a file saved since the last reload', () => {
  test('an external save before accept is the prompt Undo restores, not the older cached one', async () => {
    const { fs, config, guide, replaced } = await world('routing:\n  prompt: Previously loaded prompt.\n');
    // The owner saves on disk; the daemon has had no watcher reload since.
    fs.seed(PATH, 'routing:\n  prompt: Owner latest saved prompt.\n');

    const accepted = await guide.accept({ prompt: 'Accepted suggestion.', suggested: SUGGESTED });

    expect(accepted.outcome).toBe('applied');
    expect(replaced()?.text).toBe('Owner latest saved prompt.');
    expect(config.file(PACKS_CONFIG)?.routing?.prompt).toBe('Accepted suggestion.');
    await guide.undo();
    expect(config.file(PACKS_CONFIG)?.routing?.prompt).toBe('Owner latest saved prompt.');
  });

  test('a save that lands between the read and the write is refused as a conflict and the prompt is untouched', async () => {
    const { fs, config, writer } = await world('routing:\n  prompt: Previously loaded prompt.\n');
    const read = await writer.read();
    fs.seed(PATH, 'routing:\n  prompt: Owner latest saved prompt.\n');

    const refused = await writer.write({ prompt: 'Accepted suggestion.' }, read.etag).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).status).toBe(409);
    expect(await fs.readText(PATH)).toBe('routing:\n  prompt: Owner latest saved prompt.\n');
    expect(config.file(PACKS_CONFIG)?.routing?.prompt).not.toBe('Accepted suggestion.');
  });
});
