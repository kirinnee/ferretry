/**
 * `ConfigPort.watchState` (kernel batch item #6): a plugin hears each of its OWN files move on disk or in state —
 * written, held for the owner, confirmed, discarded, broken, fixed, removed — which `watch` (the version in effect)
 * does not hear for a held edit or a broken file. The change carries a state and the disk etag, never a value.
 */
import { describe, expect, test } from 'bun:test';
import type { ConfigStateChange } from '../../../contract/ports.ts';
import { ABSENT_STAMP, configChangedPayload, configFileMoves } from '../../../host/config/state-change.ts';
import { configHarness, loginsDef, updatesDef } from './support.ts';

/** A planted value that must never reach a listener: it looks like a credential and sits in the file's text. */
const PLANTED = 'sk-live-PLANTEDplantedPLANTED0123456789';

async function watched() {
  const h = configHarness();
  await h.files.reload();
  const changes: ConfigStateChange[] = [];
  let inEffect = 0;
  const port = h.files.port('updates');
  const cancel = port.watchState(updatesDef, change => void changes.push(change));
  port.watch(updatesDef, () => void inEffect++);
  return { h, port, changes, cancel, inEffect: () => inEffect };
}

describe('ConfigPort.watchState', () => {
  test('a held edit is heard as held, while watch (the version in effect) stays silent', async () => {
    const { h, changes, inEffect } = await watched();
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    expect(changes.map(change => change.state)).toEqual(['valid']);
    expect(inEffect()).toBe(1);
    const held = await h.files.write('updates', updatesDef, undefined, 'limit: 50\n');
    expect(held.kind).toBe('held');
    expect(changes.map(change => change.state)).toEqual(['valid', 'held']);
    // the etag a listener hears is the one the write answered
    expect(changes[1]?.etag).toBe(held.kind === 'held' ? held.etag : '');
    expect(inEffect()).toBe(1);
  });

  test('a discarded held edit is heard as valid, at the etag of the version in effect', async () => {
    const { h, changes } = await watched();
    const first = await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    await h.files.write('updates', updatesDef, undefined, 'limit: 50\n');
    const [edit] = h.files.held();
    expect(await h.files.discard(edit?.id ?? '')).toBe(true);
    expect(changes.map(change => change.state)).toEqual(['valid', 'held', 'valid']);
    expect(changes[2]?.etag).toBe(first.kind === 'applied' ? first.etag : '');
  });

  test('a confirmed held edit is heard as valid at the held etag', async () => {
    const { h, changes } = await watched();
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    const held = await h.files.write('updates', updatesDef, undefined, 'limit: 50\n');
    const [edit] = h.files.held();
    expect(await h.files.confirm(edit?.id ?? '')).toBe(true);
    expect(changes.map(change => change.state)).toEqual(['valid', 'held', 'valid']);
    expect(changes[2]?.etag).toBe(held.kind === 'held' ? held.etag : '');
  });

  test('a file that breaks is heard as invalid (watch silent, its last good version stays); fixed, valid', async () => {
    const { h, changes, inEffect } = await watched();
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    h.fs.seed(h.path('updates.yaml'), 'limit: [\n');
    await h.files.reload();
    expect(changes.map(change => change.state)).toEqual(['valid', 'invalid']);
    expect(inEffect()).toBe(1);
    h.fs.seed(h.path('updates.yaml'), 'limit: 4\n');
    await h.files.reload();
    expect(changes.map(change => change.state)).toEqual(['valid', 'invalid', 'valid']);
  });

  test('a removed file is heard as absent at the absent etag', async () => {
    const { h, changes } = await watched();
    await h.files.write('updates', updatesDef, undefined, 'limit: 15\n', { confirmedLoosening: true });
    // back to the default 10: a tightening, so the removal takes effect
    expect((await h.files.remove('updates', updatesDef, undefined)).kind).toBe('applied');
    expect(changes.at(-1)).toEqual({ state: 'absent', etag: ABSENT_STAMP.etag });
  });

  test('a removal that loosens is held: heard as held at the absent etag', async () => {
    const { h, changes } = await watched();
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    expect((await h.files.remove('updates', updatesDef, undefined)).kind).toBe('held');
    expect(changes.at(-1)).toEqual({ state: 'held', etag: ABSENT_STAMP.etag });
  });

  test('a reload that moves nothing tells nobody; the first load is the baseline', async () => {
    const h = configHarness();
    h.fs.seed(h.path('updates.yaml'), 'limit: 5\n');
    const changes: ConfigStateChange[] = [];
    h.files.port('updates').watchState(updatesDef, change => void changes.push(change));
    await h.files.reload();
    await h.files.reload();
    expect(changes).toEqual([]);
  });

  test('a collection item is named; another item of the same def is its own change', async () => {
    const h = configHarness();
    await h.files.reload();
    const changes: ConfigStateChange[] = [];
    h.files.port('logins').watchState(loginsDef, change => void changes.push(change));
    await h.files.write('logins', loginsDef, 'alpha', 'model: x\n');
    await h.files.write('logins', loginsDef, 'beta', 'model: y\n');
    await h.files.remove('logins', loginsDef, 'alpha');
    expect(changes.map(({ name, state }) => ({ name, state }))).toEqual([
      { name: 'alpha', state: 'valid' },
      { name: 'beta', state: 'valid' },
      { name: 'alpha', state: 'absent' },
    ]);
  });

  test("another plugin's def throws, as watch does; a plugin hears only its own files", async () => {
    const h = configHarness();
    await h.files.reload();
    expect(() => h.files.port('logins').watchState(updatesDef, () => {})).toThrow('did not declare');
    const logins: ConfigStateChange[] = [];
    h.files.port('logins').watchState(loginsDef, change => void logins.push(change));
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    expect(logins).toEqual([]);
  });

  test('no change carries text: a planted credential in a broken file reaches no listener and no feed', async () => {
    const { h, changes } = await watched();
    const feed: unknown[] = [];
    h.files.onStateChange((plugin, move) => void feed.push(configChangedPayload(plugin, move)));
    h.fs.seed(h.path('updates.yaml'), `limit: 5\nnote: ${PLANTED}\napiKey: ${PLANTED}\n`);
    await h.files.reload();
    expect(changes).toHaveLength(1);
    for (const change of changes) expect(Object.keys(change).toSorted()).toEqual(['etag', 'state']);
    expect(feed).toEqual([
      { plugin: 'updates', path: 'updates.yaml', state: changes[0]?.state, etag: changes[0]?.etag },
    ]);
    expect(JSON.stringify([changes, feed])).not.toContain(PLANTED);
    expect(JSON.stringify([changes, feed])).not.toContain('PLANTED');
  });

  test('the cancel stops one subscription; a throwing listener is logged and never reaches the writer', async () => {
    const { h, port, changes, cancel } = await watched();
    const second: ConfigStateChange[] = [];
    port.watchState(updatesDef, () => {
      throw new Error('listener broke');
    });
    port.watchState(updatesDef, change => void second.push(change));
    const written = await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    expect(written.kind).toBe('applied');
    expect(second).toHaveLength(1);
    expect(h.log.lines.some(line => line.includes('listener broke'))).toBe(true);
    cancel();
    await h.files.write('updates', updatesDef, undefined, 'limit: 4\n');
    expect(changes).toHaveLength(1);
    expect(second).toHaveLength(2);
  });

  test("the host's feed names every plugin's move with its plugin and path, and its cancel stops it", async () => {
    const h = configHarness();
    await h.files.reload();
    const feed: { plugin: string; path: string; state: string }[] = [];
    const stop = h.files.onStateChange((plugin, move) =>
      feed.push({ plugin, path: move.path, state: move.change.state }),
    );
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    await h.files.write('logins', loginsDef, 'alpha', 'model: x\n');
    stop();
    await h.files.write('updates', updatesDef, undefined, 'limit: 4\n');
    expect(feed).toEqual([
      { plugin: 'updates', path: 'updates.yaml', state: 'valid' },
      { plugin: 'logins', path: 'logins/alpha.yaml', state: 'valid' },
    ]);
  });
});

describe('the move rule (host/config/state-change.ts)', () => {
  const at = (state: 'absent' | 'valid' | 'invalid' | 'held', etag: string, name?: string) => ({
    ...(name === undefined ? {} : { name }),
    stamp: { state, etag },
  });

  test('a state move, an etag move, an appearance and a disappearance each count once, in path order', () => {
    const before = new Map([
      ['a.yaml', at('valid', 'e1')],
      ['b.yaml', at('valid', 'e2')],
      ['c/x.yaml', at('valid', 'e3', 'x')],
      ['d.yaml', at('valid', 'e4')],
    ]);
    const after = new Map([
      ['a.yaml', at('held', 'e1')],
      ['b.yaml', at('valid', 'e9')],
      ['d.yaml', at('valid', 'e4')],
      ['e.yaml', at('invalid', 'e5')],
    ]);
    expect(configFileMoves(before, after)).toEqual([
      { path: 'a.yaml', change: { state: 'held', etag: 'e1' } },
      { path: 'b.yaml', change: { state: 'valid', etag: 'e9' } },
      { path: 'c/x.yaml', change: { name: 'x', state: 'absent', etag: 'absent' } },
      { path: 'e.yaml', change: { state: 'invalid', etag: 'e5' } },
    ]);
  });

  test('a path that is absent on both sides is no move', () => {
    expect(configFileMoves(new Map([['a.yaml', at('absent', 'absent')]]), new Map())).toEqual([]);
  });

  test('the payload is built field by field: nothing else on the move rides along', () => {
    const move = {
      path: 'a.yaml',
      change: { state: 'valid', etag: 'e1', sentences: [PLANTED] },
    } as unknown as Parameters<typeof configChangedPayload>[1];
    expect(configChangedPayload('updates', move)).toEqual({
      plugin: 'updates',
      path: 'a.yaml',
      state: 'valid',
      etag: 'e1',
    });
  });
});
