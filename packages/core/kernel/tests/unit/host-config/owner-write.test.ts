import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineConfig } from '../../../contract/index.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { captureLog, HOME, manualClock } from './support.ts';

/** Two independent caps: raising either loosens, lowering never does. */
const capsDef = defineConfig({
  file: 'caps.yaml',
  schema: z.strictObject({ capA: z.number().int().default(10), capB: z.number().int().default(10) }),
  axis: 'configure',
  loosens: (before, after) =>
    (['capA', 'capB'] as const).flatMap(key =>
      after[key] > (before?.[key] ?? 10) ? [`raises ${key} from ${before?.[key] ?? 10} to ${after[key]}`] : [],
    ),
});

const PATH = `${HOME}/config/caps.yaml`;

function harness(verdict = true) {
  const fs = createMemoryHostFs();
  const asked: { plugin: string; path: string; removal: boolean; sentences: readonly string[] }[] = [];
  const files = createConfigFiles({
    home: HOME,
    fs,
    clock: manualClock(),
    log: captureLog(),
    binary: 'fy',
    defs: [{ plugin: 'caps', def: capsDef }],
    judge: input => (asked.push(input), verdict),
  });
  const port = files.port('caps');
  /** Both caps at 5, in effect. */
  const start = async () => {
    await files.reload();
    expect((await port.write(capsDef, undefined, 'capA: 5\ncapB: 5\n')).kind).toBe('written');
  };
  /** A hand edit raising capA to 50, held for the owner. */
  const holdRaise = async () => {
    fs.seed(PATH, 'capA: 50\ncapB: 5\n');
    await files.reload();
    expect(port.fileState(capsDef).state).toBe('held');
  };
  return { fs, files, port, asked, start, holdRaise, disk: () => String(fs.snapshot().get(PATH)) };
}

describe('ConfigPort.writeAsOwner: the owner’s patch is made to BOTH versions of a file with a held edit', () => {
  test('a tightening is in effect at once, and the held loosening stays held (with the patch applied to it too)', async () => {
    const h = harness();
    await h.start();
    await h.holdRaise();
    const outcome = await h.port.writeAsOwner(capsDef, undefined, { patch: { capB: 1 } });
    expect(outcome.kind).toBe('written');
    if (outcome.kind === 'written') expect(outcome.stillHeld?.sentences).toEqual(['raises capA from 5 to 50']);
    // the tightening is what is in effect; the loosening still is not
    expect(h.port.file(capsDef)).toEqual({ capA: 5, capB: 1 });
    // the held edit, changed, is still in the file and still held
    expect(h.disk()).toContain('capA: 50');
    expect(h.disk()).toContain('capB: 1');
    expect(h.port.fileState(capsDef)).toEqual({
      state: 'held',
      inEffect: true,
      sentences: ['raises capA from 5 to 50'],
    });
    // a tightening never asks the judge
    expect(h.asked).toEqual([]);
  });

  test('a save never discards the held edit, and confirming it later puts it into effect WITH the owner’s change', async () => {
    const h = harness();
    await h.start();
    await h.holdRaise();
    await h.port.writeAsOwner(capsDef, undefined, { patch: { capB: 1 } });
    const held = h.files.held();
    expect(held).toHaveLength(1);
    expect(await h.files.confirm(held[0]?.id as string)).toBe(true);
    expect(h.port.file(capsDef)).toEqual({ capA: 50, capB: 1 });
    expect(h.port.fileState(capsDef).state).toBe('valid');
  });

  test('the judge is asked ONLY about the owner’s own patch, never the held edit that rode along; apply puts it into effect', async () => {
    const h = harness(true);
    await h.start();
    await h.holdRaise();
    const outcome = await h.port.writeAsOwner(capsDef, undefined, { patch: { capB: 7 } });
    expect(h.asked).toEqual([
      { plugin: 'caps', path: 'caps.yaml', removal: false, sentences: ['raises capB from 5 to 7'] },
    ]);
    expect(outcome).toMatchObject({ kind: 'written', loosened: ['raises capB from 5 to 7'] });
    expect(h.port.file(capsDef)).toEqual({ capA: 5, capB: 7 });
    // the unrelated held edit was not put into effect by the owner's save
    expect(h.port.fileState(capsDef).state).toBe('held');
    expect(h.disk()).toContain('capA: 50');
  });

  test('when the judge holds the owner’s loosening, the version in effect is untouched and the patch waits with the held edit', async () => {
    const h = harness(false);
    await h.start();
    await h.holdRaise();
    const outcome = await h.port.writeAsOwner(capsDef, undefined, { patch: { capB: 7 } });
    expect(outcome.kind).toBe('held');
    expect(h.port.file(capsDef)).toEqual({ capA: 5, capB: 5 });
    expect(h.disk()).toContain('capB: 7');
    expect(h.disk()).toContain('capA: 50');
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.sentences).toEqual(['raises capB from 5 to 7']);
  });

  test('with no edit held it is a write of the patch: judged, applied or held like any plugin write', async () => {
    const h = harness(false);
    await h.start();
    expect((await h.port.writeAsOwner(capsDef, undefined, { patch: { capA: 2 } })).kind).toBe('written');
    expect(h.port.file(capsDef)).toEqual({ capA: 2, capB: 5 });
    const raised = await h.port.writeAsOwner(capsDef, undefined, { patch: { capA: 9 } });
    expect(raised.kind).toBe('held');
    expect(h.port.file(capsDef)).toEqual({ capA: 2, capB: 5 });
  });

  test('a held REMOVAL carries no text: the patch changes the version in effect and the removal stays held', async () => {
    const h = harness(true);
    await h.start();
    await h.fs.remove(PATH);
    await h.files.reload();
    expect(h.port.fileState(capsDef).state).toBe('held');
    const outcome = await h.port.writeAsOwner(capsDef, undefined, { patch: { capB: 1 } });
    expect(outcome.kind).toBe('written');
    expect(h.port.file(capsDef)).toEqual({ capA: 5, capB: 1 });
    expect(h.fs.snapshot().has(PATH)).toBe(false);
    expect(h.port.fileState(capsDef).state).toBe('held');
  });

  test('a raw secret in the patch is refused whole, and the held edit is untouched', async () => {
    const h = harness();
    await h.start();
    await h.holdRaise();
    const before = h.disk();
    const outcome = await h.port.writeAsOwner(capsDef, undefined, {
      patch: {
        capB: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      },
    });
    expect(outcome.kind).toBe('refused');
    expect(h.disk()).toBe(before);
  });
});

describe('a write over a disk that moved since the last reload is a conflict (never apply an edit nobody has seen)', () => {
  test('a hand edit the watcher has not reloaded yet: write answers conflict and the file is as the editor left it', async () => {
    const h = harness();
    await h.start();
    h.fs.seed(PATH, '# hand edit\ncapA: 4\ncapB: 5\n');
    const outcome = await h.port.write(capsDef, undefined, { patch: { capB: 1 } });
    expect(outcome).toEqual({ kind: 'conflict' });
    expect(h.disk()).toBe('# hand edit\ncapA: 4\ncapB: 5\n');
    expect(h.port.file(capsDef)).toEqual({ capA: 5, capB: 5 });
    // once the reload has seen it, the next write goes through and is made from it
    await h.files.reload();
    expect((await h.port.write(capsDef, undefined, { patch: { capB: 1 } })).kind).toBe('written');
    expect(h.port.file(capsDef)).toEqual({ capA: 4, capB: 1 });
  });

  test('the owner’s both-versions write is refused the same way, with an edit held', async () => {
    const h = harness();
    await h.start();
    await h.holdRaise();
    h.fs.seed(PATH, 'capA: 60\ncapB: 5\n');
    expect(await h.port.writeAsOwner(capsDef, undefined, { patch: { capB: 1 } })).toEqual({ kind: 'conflict' });
    expect(h.disk()).toBe('capA: 60\ncapB: 5\n');
  });

  test('a file that appeared on disk since the last reload conflicts too; a whole-text write as well', async () => {
    const h = harness();
    await h.files.reload();
    h.fs.seed(PATH, 'capA: 3\n');
    expect(await h.port.write(capsDef, undefined, 'capA: 1\n')).toEqual({ kind: 'conflict' });
    expect(h.disk()).toBe('capA: 3\n');
  });

  test('a stale ifMatch is still a conflict, and an unmoved disk is not', async () => {
    const h = harness();
    await h.start();
    expect(await h.port.write(capsDef, undefined, { patch: { capA: 1 } }, { ifMatch: 'stale' })).toEqual({
      kind: 'conflict',
    });
    expect((await h.port.write(capsDef, undefined, { patch: { capA: 1 } })).kind).toBe('written');
  });
});
