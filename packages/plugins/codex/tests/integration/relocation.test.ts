/**
 * Packing a Codex conversation on one machine and unpacking it into a new ferret's home on another: the REAL kernel roots
 * over a temp folder and the real harness. Proved: the unpacked conversation reads as identical turns through the
 * transcript reader; nothing of the source's folder or home is left in it; an untested writer is refused with nothing
 * written; and the source is never touched.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FerretId } from '@ferretry/kernel/contract';
import {
  SOURCE_FOLDER,
  SOURCE_ID,
  TARGET_FOLDER,
  relocationWorld,
  rolloutPath,
  syntheticRollout,
} from '../support/relocation-world.ts';

const worlds: { cleanup(): Promise<void> }[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup();
});
const build = async (options: Parameters<typeof relocationWorld>[0] = {}) => {
  const world = await relocationWorld(options);
  worlds.push(world);
  return world;
};
const f2 = 'f2' as FerretId;
const allFiles = async (folder: string): Promise<string[]> =>
  (await readdir(folder, { recursive: true }).catch(() => [])).sort();

/** Both machines' view of one conversation: its turns as the transcript reader shows them. */
const turns = async (world: Awaited<ReturnType<typeof build>>, ferret: FerretId, id: string) => {
  await world.harness.resume(
    world.specOf(ferret, ferret === f2 ? TARGET_FOLDER : SOURCE_FOLDER),
    world.runner,
    {} as never,
    id,
  );
  const read = await world.harness.transcript.read(ferret);
  // `data.source` names the file on THIS machine, which differs by machine and is not a turn.
  return read.map(entry => ({ ...entry, data: { ...(entry.data as object), source: undefined } }));
};

describe('packing and unpacking a Codex conversation', () => {
  test('pack gives the rollout byte for byte and the path it is filed under, and writes nothing', async () => {
    const w = await build();
    const { file } = await w.source();
    const before = { bytes: await readFile(file), stat: await stat(file), tree: await allFiles(w.home) };

    const packed = await w.harness.packConversation?.('f1' as FerretId);

    if (packed?.ok !== true) throw new Error(JSON.stringify(packed));
    expect(packed.value.relPath).toBe(rolloutPath(SOURCE_ID));
    expect(Buffer.from(packed.value.bytes).equals(before.bytes)).toBe(true);
    expect(await readFile(file)).toEqual(before.bytes);
    expect((await stat(file)).ino).toBe(before.stat.ino);
    expect(await allFiles(w.home)).toEqual(before.tree);
  });

  test('pack then unpack on another machine gives identical turns, keeps the id, and proves hasConversation', async () => {
    const a = await build();
    const w = await build();
    await a.source();
    const packed = await a.harness.packConversation?.('f1' as FerretId);
    if (packed?.ok !== true) throw new Error(JSON.stringify(packed));
    const before = await turns(a, 'f1' as FerretId, SOURCE_ID);
    expect(before.map(entry => entry.text).filter(Boolean)).toContain('SYNTHETIC_ANSWER_2');

    const spec = w.specOf('f2', TARGET_FOLDER);
    const unpacked = await w.harness.unpackConversation?.(spec, packed.value);

    expect(unpacked).toEqual({ ok: true, value: { conversation: SOURCE_ID } });
    expect(await w.harness.hasConversation?.(spec, SOURCE_ID)).toBe(true);
    const after = await turns(w, f2, SOURCE_ID);
    // The same turns, the same words and the same moments; only the work folder is the new one.
    expect(JSON.stringify(after)).toBe(JSON.stringify(before).replaceAll(SOURCE_FOLDER, TARGET_FOLDER));
    expect(after.length).toBe(before.length);
  });

  test('no source folder, source home or source marker is left anywhere in the unpacked file', async () => {
    const a = await build();
    const w = await build();
    await a.source();
    const packed = await a.harness.packConversation?.('f1' as FerretId);
    if (packed?.ok !== true) throw new Error(JSON.stringify(packed));
    await w.harness.unpackConversation?.(w.specOf('f2', TARGET_FOLDER), packed.value);

    const text = await readFile(join(w.agent('f2'), rolloutPath(SOURCE_ID)), 'utf8');
    expect(text).not.toContain(SOURCE_FOLDER);
    expect(text).not.toContain(a.agent('f1'));
    expect(text).not.toContain('codex-correlation/unreachable');
    expect(text).toContain(`"cwd":"${TARGET_FOLDER}"`);
    expect(text).toContain(`${w.agent('f2')}/codex-correlation/relocated`);
    // The file is in the shared pool, reached through the new ferret's own `sessions` link.
    expect(await readFile(w.pool(rolloutPath(SOURCE_ID)), 'utf8')).toBe(text);
  });

  test.each(['0.144.0', '0.167.0'])(
    'a Codex %s conversation is refused on both sides and nothing is written',
    async version => {
      const w = await build();
      await w.source((id, home) => syntheticRollout({ id, folder: SOURCE_FOLDER, home, version }));
      const sourceSide = await w.harness.packConversation?.('f1' as FerretId);
      expect(sourceSide).toEqual({ ok: false, error: { reason: expect.stringContaining(`Codex ${version}`) } });

      // The other machine judges for itself, whatever the source let through.
      const text = syntheticRollout({ id: SOURCE_ID, folder: SOURCE_FOLDER, home: w.agent('f1'), version });
      const beforeHome = await allFiles(w.home);
      const unpacked = await w.harness.unpackConversation?.(w.specOf('f2', TARGET_FOLDER), {
        bytes: new TextEncoder().encode(text),
        relPath: rolloutPath(SOURCE_ID),
      });
      expect(unpacked).toEqual({ ok: false, error: { reason: expect.stringContaining(`Codex ${version}`) } });
      expect(await allFiles(w.home)).toEqual(beforeHome);
    },
  );

  test('a conversation with no turn yet is refused on both sides, with nothing written', async () => {
    const w = await build();
    const bare = (id: string, home: string) =>
      syntheticRollout({ id, folder: SOURCE_FOLDER, home })
        .split('\n')
        .filter(row => !row.includes('SYNTHETIC_QUESTION'))
        .join('\n');
    await w.source(bare);
    expect(await w.harness.packConversation?.('f1' as FerretId)).toMatchObject({
      ok: false,
      error: { reason: expect.stringContaining('no turn yet') },
    });
    const beforeHome = await allFiles(w.home);
    const unpacked = await w.harness.unpackConversation?.(w.specOf('f2', TARGET_FOLDER), {
      bytes: new TextEncoder().encode(bare(SOURCE_ID, w.agent('f1'))),
      relPath: rolloutPath(SOURCE_ID),
    });
    expect(unpacked).toMatchObject({ ok: false, error: { reason: expect.stringContaining('no turn yet') } });
    expect(await allFiles(w.home)).toEqual(beforeHome);
  });

  test('a conversation that uses a subagent is refused with nothing written', async () => {
    const w = await build();
    const spawn = JSON.stringify({
      type: 'response_item',
      payload: { type: 'function_call', name: 'spawn_agent', call_id: 'c1', arguments: '{}' },
    });
    await w.source((id, home) => syntheticRollout({ id, folder: SOURCE_FOLDER, home, extra: [spawn] }));
    const beforeHome = await allFiles(w.home);
    const unpacked = await w.harness.unpackConversation?.(w.specOf('f2', TARGET_FOLDER), {
      bytes: new TextEncoder().encode(
        syntheticRollout({ id: SOURCE_ID, folder: SOURCE_FOLDER, home: w.agent('f1'), extra: [spawn] }),
      ),
      relPath: rolloutPath(SOURCE_ID),
    });
    expect(unpacked).toMatchObject({ ok: false, error: { reason: expect.stringContaining('subagent') } });
    expect(await allFiles(w.home)).toEqual(beforeHome);
    expect(await w.harness.packConversation?.('f1' as FerretId)).toMatchObject({ ok: false });
  });

  test.each([
    ['a path that climbs out', '../../outside.jsonl'],
    ['the sign-in file', 'auth.json'],
    ['a path naming another conversation', rolloutPath('019fab95-0000-7000-8000-000000000009')],
  ])('%s is refused with nothing written', async (_label, relPath) => {
    const w = await build();
    await w.source();
    const beforeHome = await allFiles(w.home);
    const text = syntheticRollout({ id: SOURCE_ID, folder: SOURCE_FOLDER, home: w.agent('f1') });
    const unpacked = await w.harness.unpackConversation?.(w.specOf('f2', TARGET_FOLDER), {
      bytes: new TextEncoder().encode(text),
      relPath,
    });
    expect(unpacked?.ok).toBe(false);
    expect(await allFiles(w.home)).toEqual(beforeHome);
  });

  test('a machine that already holds a conversation of that id files the move under a new one, with the old id nowhere', async () => {
    const w = await build();
    const { file } = await w.source();
    const original = await readFile(file);
    const packed = await w.harness.packConversation?.('f1' as FerretId);
    if (packed?.ok !== true) throw new Error(JSON.stringify(packed));

    const unpacked = await w.harness.unpackConversation?.(w.specOf('f2', TARGET_FOLDER), packed.value);

    if (unpacked?.ok !== true) throw new Error(JSON.stringify(unpacked));
    const id = unpacked.value.conversation;
    expect(id).not.toBe(SOURCE_ID);
    expect(await w.harness.hasConversation?.(w.specOf('f2', TARGET_FOLDER), id)).toBe(true);
    const text = await readFile(join(w.agent('f2'), rolloutPath(id)), 'utf8').catch(
      async () =>
        await readFile(
          join(
            w.pool('sessions/2026/11/16'),
            (await readdir(w.pool('sessions/2026/11/16'))).find(name => name.endsWith(`${id}.jsonl`)) ?? '',
          ),
          'utf8',
        ),
    );
    expect(text).not.toContain(SOURCE_ID);
    expect(text).not.toContain(SOURCE_FOLDER);
    expect(text).toContain(`"id":"${id}"`);
    // The conversation that was already here is exactly as it was.
    expect(await readFile(file)).toEqual(original);
    expect(await turns(w, f2, id)).toHaveLength((await turns(w, 'f1' as FerretId, SOURCE_ID)).length);
  });

  test('a machine with no shared pool files the conversation into the ferret’s own sessions, and still proves it', async () => {
    const source = await build();
    await source.source();
    const packed = await source.harness.packConversation?.('f1' as FerretId);
    if (packed?.ok !== true) throw new Error(JSON.stringify(packed));
    const w = await build({ pooled: false });
    await mkdir(w.agent('f2'), { recursive: true, mode: 0o700 });

    const spec = w.specOf('f2', TARGET_FOLDER);
    const unpacked = await w.harness.unpackConversation?.(spec, packed.value);

    expect(unpacked).toEqual({ ok: true, value: { conversation: SOURCE_ID } });
    expect(await w.harness.hasConversation?.(spec, SOURCE_ID)).toBe(true);
    expect(await readFile(join(w.agent('f2'), rolloutPath(SOURCE_ID)), 'utf8')).toContain(`"cwd":"${TARGET_FOLDER}"`);
  });

  test('a ferret with no conversation of its own has nothing to pack', async () => {
    const w = await build();
    await writeFile(join(w.parent, 'unused'), '');
    expect(await w.harness.packConversation?.('f1' as FerretId)).toMatchObject({ ok: false });
  });
});
