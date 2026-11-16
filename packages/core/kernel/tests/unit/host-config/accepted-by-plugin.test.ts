import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { acceptedConfigFile, acceptedName } from '../../../contract/index.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { createStatePort } from '../../../host/state/state-port.ts';
import { captureLog, HOME, manualClock, updatesDef } from './support.ts';

/** The same fs, the same file, claimed by whichever plugin the test names. */
function claimedBy(fs: ReturnType<typeof createMemoryHostFs>, plugin: string) {
  return createConfigFiles({
    home: HOME,
    fs,
    clock: manualClock(),
    log: captureLog(),
    binary: 'fy',
    defs: [{ plugin, def: updatesDef }],
  });
}

const limitOf = (files: ReturnType<typeof claimedBy>, plugin: string) =>
  (files.port(plugin).file(updatesDef) as { limit: number } | undefined)?.limit;

/** A file whose owner-confirmed version loosens (50 against the default 10), in effect for plugin A. */
async function acceptedForA() {
  const fs = createMemoryHostFs();
  const a = claimedBy(fs, 'plugin-a');
  const written = await a.write('plugin-a', updatesDef, undefined, 'limit: 50\n', { confirmedLoosening: true });
  expect(written.kind).toBe('applied');
  expect(limitOf(a, 'plugin-a')).toBe(50);
  return fs;
}

describe('NN2 an accepted config record is in effect for the plugin it was accepted for, and no other', () => {
  test('NN2 a record accepted for plugin A is not inherited by plugin B claiming the same path: B is held', async () => {
    const fs = await acceptedForA();
    const b = claimedBy(fs, 'plugin-b');
    await b.reload();
    expect(limitOf(b, 'plugin-b')).toBeUndefined();
    expect(b.held()).toMatchObject([{ plugin: 'plugin-b', path: 'updates.yaml', removal: false }]);
    expect(b.status().files).toContainEqual({ path: 'updates.yaml', plugin: 'plugin-b', state: 'pending' });
  });

  test('NN2 plugin A is still in effect after B was held, and B did not erase A’s record', async () => {
    const fs = await acceptedForA();
    const b = claimedBy(fs, 'plugin-b');
    await b.reload();
    const a = claimedBy(fs, 'plugin-a');
    await a.reload();
    expect(limitOf(a, 'plugin-a')).toBe(50);
    expect(a.held()).toEqual([]);
  });

  test('NN2 a stored record with no plugin id is accepted for nobody: the file is held', async () => {
    const fs = createMemoryHostFs();
    const text = 'limit: 50\n';
    fs.seed(`${HOME}/config/updates.yaml`, text);
    const state = createStatePort({ home: HOME, pluginId: 'kernel', files: [acceptedConfigFile], fs });
    await state.write(
      acceptedConfigFile,
      { etag: createHash('sha256').update(text).digest('hex'), text },
      acceptedName('updates.yaml'),
    );
    const files = claimedBy(fs, 'plugin-a');
    await files.reload();
    expect(limitOf(files, 'plugin-a')).toBeUndefined();
    expect(files.held()).toHaveLength(1);
  });

  test('NN2 confirming records the confirming plugin, and the record is then in effect for that plugin only', async () => {
    const fs = await acceptedForA();
    const b = claimedBy(fs, 'plugin-b');
    await b.reload();
    const [held] = b.held();
    if (held === undefined) throw new Error('expected a held edit for plugin-b');
    expect(await b.confirm(held.id)).toBe(true);
    expect(limitOf(b, 'plugin-b')).toBe(50);
    const state = createStatePort({ home: HOME, pluginId: 'kernel', files: [acceptedConfigFile], fs });
    const stored = await state.read(acceptedConfigFile, acceptedName('updates.yaml'));
    expect(stored.ok && stored.value?.plugin).toBe('plugin-b');
    const again = claimedBy(fs, 'plugin-b');
    await again.reload();
    expect(limitOf(again, 'plugin-b')).toBe(50);
    const a = claimedBy(fs, 'plugin-a');
    await a.reload();
    expect(limitOf(a, 'plugin-a')).toBeUndefined();
    expect(a.held()).toHaveLength(1);
  });
});
