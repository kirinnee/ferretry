import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineConfig, type LoosensWithRemoval, neverLoosens } from '../../../contract/index.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { captureLog, configHarness, HOME, loginsDef, manualClock, updatesDef } from './support.ts';

function judged(verdict: boolean) {
  const fs = createMemoryHostFs();
  const asked: { plugin: string; path: string; removal: boolean; sentences: readonly string[] }[] = [];
  const files = createConfigFiles({
    home: HOME,
    fs,
    clock: manualClock(),
    log: captureLog(),
    binary: 'fy',
    defs: [
      { plugin: 'updates', def: updatesDef },
      { plugin: 'logins', def: loginsDef },
    ],
    judge: input => (asked.push(input), verdict),
  });
  return { fs, files, asked, path: (relative: string) => `${HOME}/config/${relative}` };
}

describe('ConfigPort.fileState: absent, valid, invalid and held are told apart', () => {
  test('absent: no file and nothing in effect', async () => {
    const h = configHarness();
    await h.files.reload();
    expect(h.files.port('updates').fileState(updatesDef)).toEqual({ state: 'absent', inEffect: false, sentences: [] });
  });

  test('a FIRST file that is invalid is damage, not defaults: invalid with nothing in effect', async () => {
    const h = configHarness();
    h.fs.seed(h.path('updates.yaml'), 'limit: [');
    await h.files.reload();
    const status = h.files.port('updates').fileState(updatesDef);
    expect(status.state).toBe('invalid');
    expect(status.inEffect).toBe(false);
    expect(status.sentences.length).toBeGreaterThan(0);
    expect(h.files.port('updates').file(updatesDef)).toBeUndefined();
  });

  test('an invalid edit of a good file keeps the last good version: invalid, in effect', async () => {
    const h = configHarness();
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    expect(h.files.port('updates').fileState(updatesDef)).toEqual({ state: 'valid', inEffect: true, sentences: [] });
    h.fs.seed(h.path('updates.yaml'), 'limit: many\n');
    await h.files.reload();
    expect(h.files.port('updates').fileState(updatesDef)).toMatchObject({ state: 'invalid', inEffect: true });
  });

  test('a collection item is named; a held loosening reads held with its sentence', async () => {
    const h = configHarness();
    await h.files.write('logins', loginsDef, 'work', 'budget: 5\n');
    await h.files.write('logins', loginsDef, 'work', 'budget: 50\n');
    expect(h.files.port('logins').fileState(loginsDef, 'work')).toEqual({
      state: 'held',
      inEffect: true,
      sentences: ['raises or removes the budget'],
    });
    expect(h.files.port('logins').fileState(loginsDef, 'home').state).toBe('absent');
  });
});

describe('ConfigPort.write / remove: a plugin writes its own files through the one writer', () => {
  test('remove checks ifMatch inside its serialized mutation when a write races it', async () => {
    const h = configHarness();
    await h.files.write('updates', updatesDef, undefined, 'limit: 20\n', { confirmedLoosening: true });
    const view = await h.files.read('updates', updatesDef);
    if (view === undefined) throw new Error('expected the initial config view');
    const port = h.files.port('updates');
    const [removed, written] = await Promise.all([
      port.remove(updatesDef, undefined, { ifMatch: view.etag }),
      port.write(updatesDef, undefined, 'limit: 15\n'),
    ]);
    expect(removed.kind).toBe('written');
    expect(written.kind).toBe('held');
    // The removal queued first: a later write must survive it (and be judged against defaults).
    expect(h.fs.snapshot().get(h.path('updates.yaml'))).toBe('limit: 15\n');

    const stale = await port.remove(updatesDef, undefined, { ifMatch: view.etag });
    expect(stale).toEqual({ kind: 'conflict' });
    expect(h.fs.snapshot().get(h.path('updates.yaml'))).toBe('limit: 15\n');
    await h.fs.remove(h.path('updates.yaml'));
    expect(await port.remove(updatesDef, undefined, { ifMatch: view.etag })).toEqual({ kind: 'conflict' });
  });

  test('its own def is written; a patch edits only the changed keys and keeps comments', async () => {
    const h = configHarness();
    await h.files.write('updates', updatesDef, undefined, '# kept\nlimit: 5\nnote: hi\n');
    const outcome = await h.files.port('updates').write(updatesDef, undefined, { patch: { limit: 3 } });
    expect(outcome.kind).toBe('written');
    const text = h.fs.snapshot().get(h.path('updates.yaml'));
    expect(String(text)).toContain('# kept');
    expect(String(text)).toContain('limit: 3');
    expect(h.files.port('updates').file(updatesDef)).toMatchObject({ limit: 3, note: 'hi' });
  });

  test('another plugin’s def is refused not_declared and nothing is written', async () => {
    const h = configHarness();
    const outcome = await h.files.port('logins').write(updatesDef, undefined, 'limit: 1\n');
    expect(outcome).toEqual({ kind: 'refused', reason: 'not_declared', issues: [] });
    expect(h.fs.snapshot().has(h.path('updates.yaml'))).toBe(false);
  });

  test('a loosening edit with no judge returns held; the tighter version stays in effect', async () => {
    const h = configHarness();
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    const outcome = await h.files.port('updates').write(updatesDef, undefined, { patch: { limit: 50 } });
    expect(outcome.kind).toBe('held');
    if (outcome.kind === 'held') expect(outcome.sentences).toEqual(['raises the limit from 5 to 50']);
    expect(h.files.port('updates').file(updatesDef)).toMatchObject({ limit: 5 });
  });

  test('Gate’s judge decides a loosening: hold keeps it held, apply puts it into effect; a tightening never asks', async () => {
    const holding = judged(false);
    await holding.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    expect((await holding.files.port('updates').write(updatesDef, undefined, 'limit: 9\n')).kind).toBe('held');
    expect(holding.asked).toEqual([
      { plugin: 'updates', path: 'updates.yaml', removal: false, sentences: ['raises the limit from 5 to 9'] },
    ]);
    const applying = judged(true);
    await applying.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    const applied = await applying.files.port('updates').write(updatesDef, undefined, 'limit: 9\n');
    expect(applied).toMatchObject({ kind: 'written', loosened: ['raises the limit from 5 to 9'] });
    expect(applying.files.port('updates').file(updatesDef)).toMatchObject({ limit: 9 });
    await applying.files.port('updates').write(updatesDef, undefined, 'limit: 2\n');
    expect(applying.asked).toHaveLength(1);
  });

  test('a raw secret is refused, a stale ifMatch is a conflict, and remove of a loosening is held', async () => {
    const h = configHarness();
    await h.files.write('logins', loginsDef, 'work', 'budget: 5\n');
    const port = h.files.port('logins');
    expect((await port.write(loginsDef, 'work', 'budget: 4\n', { ifMatch: 'stale' })).kind).toBe('conflict');
    expect((await port.remove(loginsDef, 'work')).kind).toBe('held');
    expect(port.collection(loginsDef).get('work')).toMatchObject({ budget: 5 });
    const updates = h.files.port('updates');
    const secret = await updates.write(
      updatesDef,
      undefined,
      'apiKey: sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n',
    );
    expect(secret).toMatchObject({ kind: 'refused', reason: 'raw_secret' });
  });
});

describe('EE a deletion with no schema defaults is judged too (K5)', () => {
  const Budget = z.strictObject({ cap: z.number() });
  const removalAware: LoosensWithRemoval<{ cap: number }> = (before, after) =>
    before !== undefined && after === undefined ? ['removes the spending cap'] : [];
  const capDef = defineConfig({ file: 'cap.yaml', schema: Budget, axis: 'configure', loosens: removalAware });
  const oldStyle = defineConfig({
    file: 'old.yaml',
    schema: Budget,
    axis: 'configure',
    loosens: (_before, after) => (after.cap > 10 ? ['raises the cap'] : []),
  });
  const quiet = defineConfig({ file: 'quiet.yaml', schema: Budget, axis: 'configure', loosens: neverLoosens });

  function harness() {
    const fs = createMemoryHostFs();
    const files = createConfigFiles({
      home: HOME,
      fs,
      clock: manualClock(),
      log: captureLog(),
      binary: 'fy',
      defs: [
        { plugin: 'budget', def: capDef },
        { plugin: 'budget', def: oldStyle },
        { plugin: 'budget', def: quiet },
      ],
      judge: () => false,
    });
    return { files, port: files.port('budget') };
  }

  test('a removal its loosens names is held; a judgement that throws on the deletion is held too', async () => {
    const { port } = harness();
    await port.write(capDef, undefined, 'cap: 5\n');
    expect(await port.remove(capDef, undefined)).toMatchObject({
      kind: 'held',
      sentences: ['removes the spending cap'],
    });
    await port.write(oldStyle, undefined, 'cap: 5\n');
    expect(await port.remove(oldStyle, undefined)).toMatchObject({
      kind: 'held',
      sentences: ['Removing this file could not be judged, so it waits for the owner.'],
    });
  });

  test('a removal that loosens nothing applies', async () => {
    const { port } = harness();
    await port.write(quiet, undefined, 'cap: 5\n');
    expect(await port.remove(quiet, undefined)).toMatchObject({ kind: 'written' });
  });
});

describe('NN2 only the OWNER adds a ${secret:NAME} reference', () => {
  test('a plugin self-write adding a reference is held even when Gate would allow it, and names nothing yet', async () => {
    const h = judged(true);
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    const result = await h.files
      .port('updates')
      .write(updatesDef, undefined, 'limit: 5\napiKey: ${secret:UPDATES_KEY}\n');
    expect(result.kind).toBe('held');
    expect(result.kind === 'held' && result.sentences).toEqual([
      'names the secret UPDATES_KEY, which only the owner may add to a configuration',
    ]);
    expect(h.files.secretReferences('updates').has('UPDATES_KEY')).toBe(false);
    // a restart does not apply it either: the reference is judged against what is in effect, not remembered
    const again = createConfigFiles({
      home: HOME,
      fs: h.fs,
      clock: manualClock(),
      log: captureLog(),
      binary: 'fy',
      defs: [{ plugin: 'updates', def: updatesDef }],
      judge: () => true,
    });
    await again.reload();
    expect(again.secretReferences('updates').has('UPDATES_KEY')).toBe(false);
  });

  test('the same edit by the owner is written, and the reference counts', async () => {
    const h = judged(false);
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    const result = await h.files
      .writer()
      .write(
        { plugin: 'updates', def: updatesDef, name: undefined } as never,
        'limit: 5\napiKey: ${secret:UPDATES_KEY}\n',
      );
    expect(result.kind).toBe('written');
    expect(h.files.secretReferences('updates').has('UPDATES_KEY')).toBe(true);
  });

  test('a plugin self-write that keeps a reference already in effect is written', async () => {
    const h = judged(false);
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\napiKey: ${secret:UPDATES_KEY}\n');
    const result = await h.files
      .port('updates')
      .write(updatesDef, undefined, 'limit: 3\napiKey: ${secret:UPDATES_KEY}\n');
    expect(result.kind).toBe('written');
    expect(h.files.secretReferences('updates').has('UPDATES_KEY')).toBe(true);
  });
});
