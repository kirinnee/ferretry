import { describe, expect, test } from 'bun:test';
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
