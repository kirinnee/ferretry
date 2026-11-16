import { describe, expect, test } from 'bun:test';
import { createConfigFiles } from '../../../host/config/service.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { captureLog, HOME, loginsDef, manualClock, updatesDef } from './support.ts';

/**
 * `ConfigPort.remove(def, name, { refuseIfHeld: true })`: a removal that would be held is refused `would_hold`
 * instead — file untouched, nothing held — decided by the SAME one judgement the removal asks (asked once, so a
 * judge that claims a one-shot proof claims it at most once).
 */
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

describe('ConfigPort.remove with refuseIfHeld', () => {
  test('a loosening removal the judge does not confirm is refused would_hold: file in effect, nothing held', async () => {
    const h = judged(false);
    await h.files.write('logins', loginsDef, 'work', 'budget: 5\n');
    const port = h.files.port('logins');
    const outcome = await port.remove(loginsDef, 'work', { refuseIfHeld: true });
    expect(outcome).toEqual({
      kind: 'refused',
      reason: 'would_hold',
      issues: [],
      sentences: ['raises or removes the budget'],
    });
    expect(h.fs.snapshot().get(h.path('logins/work.yaml'))).toBe('budget: 5\n');
    expect(port.collection(loginsDef).get('work')).toMatchObject({ budget: 5 });
    expect(port.fileState(loginsDef, 'work').state).toBe('valid');
    expect(h.files.held()).toEqual([]);
    expect(h.asked).toEqual([
      { plugin: 'logins', path: 'logins/work.yaml', removal: true, sentences: ['raises or removes the budget'] },
    ]);
  });

  test('a loosening removal the judge confirms is removed as today, the judge asked exactly once', async () => {
    const h = judged(true);
    await h.files.write('logins', loginsDef, 'work', 'budget: 5\n');
    const port = h.files.port('logins');
    const outcome = await port.remove(loginsDef, 'work', { refuseIfHeld: true });
    expect(outcome).toMatchObject({ kind: 'written', loosened: ['raises or removes the budget'] });
    expect(h.fs.snapshot().has(h.path('logins/work.yaml'))).toBe(false);
    expect(port.collection(loginsDef).has('work')).toBe(false);
    expect(h.files.held()).toEqual([]);
    expect(h.asked).toHaveLength(1);
  });

  test('a removal that loosens nothing is removed without asking the judge', async () => {
    const h = judged(false);
    await h.files.write('logins', loginsDef, 'home', 'model: y\n');
    const outcome = await h.files.port('logins').remove(loginsDef, 'home', { refuseIfHeld: true });
    expect(outcome.kind).toBe('written');
    expect(h.fs.snapshot().has(h.path('logins/home.yaml'))).toBe(false);
    expect(h.asked).toEqual([]);
  });

  test('without refuseIfHeld the same removal is still held, as today', async () => {
    const h = judged(false);
    await h.files.write('logins', loginsDef, 'work', 'budget: 5\n');
    expect((await h.files.port('logins').remove(loginsDef, 'work')).kind).toBe('held');
    expect(h.files.held()).toHaveLength(1);
  });

  test('a stale ifMatch is still a conflict, before any judgement', async () => {
    const h = judged(false);
    await h.files.write('logins', loginsDef, 'work', 'budget: 5\n');
    const outcome = await h.files.port('logins').remove(loginsDef, 'work', { ifMatch: 'stale', refuseIfHeld: true });
    expect(outcome).toEqual({ kind: 'conflict' });
    expect(h.asked).toEqual([]);
  });
});
