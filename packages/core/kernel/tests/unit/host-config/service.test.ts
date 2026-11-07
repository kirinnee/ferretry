import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineConfig } from '../../../contract/index.ts';
import { type AnyConfigDef, ConfigPathClaimError } from '../../../host/config/claims.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { configHarness, HOME, loginsDef, manualClock, captureLog, updatesDef } from './support.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';

const limitOf = (h: ReturnType<typeof configHarness>) =>
  (h.files.port('updates').file(updatesDef) as { limit: number } | undefined)?.limit;

describe('config files: last good', () => {
  test('a file that does not parse keeps its last good version in effect, and the issue is located', async () => {
    const h = configHarness();
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    expect(limitOf(h)).toBe(5);
    h.fs.seed(h.path('updates.yaml'), 'limit: 5\n  bad: [unclosed\n');
    await h.files.reload();
    expect(limitOf(h)).toBe(5);
    const issue = h.files.status().issues.find(i => i.path === 'updates.yaml');
    expect(issue?.severity).toBe('error');
    expect(issue?.line).toBeGreaterThan(0);
    expect(h.files.status().files).toContainEqual({ path: 'updates.yaml', plugin: 'updates', state: 'invalid' });
  });

  test('a file that breaks its schema keeps the last good version; fixing it puts the fix into effect', async () => {
    const h = configHarness();
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    h.fs.seed(h.path('updates.yaml'), 'limit: many\n');
    await h.files.reload();
    expect(limitOf(h)).toBe(5);
    expect(h.files.status().issues[0]?.message).toContain('limit');
    h.fs.seed(h.path('updates.yaml'), 'limit: 4\n');
    await h.files.reload();
    expect(limitOf(h)).toBe(4);
    expect(h.files.status().issues).toEqual([]);
  });

  test('the last good version survives a restart: the accepted record is in state/kernel/accepted-config/', async () => {
    const h = configHarness();
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    expect([...h.fs.snapshot().keys()].some(p => p.startsWith(`${HOME}/state/kernel/accepted-config/`))).toBe(true);
    h.fs.seed(h.path('updates.yaml'), '{ broken');
    const again = h.restart();
    await again.reload();
    expect((again.port('updates').file(updatesDef) as { limit: number }).limit).toBe(5);
  });

  test('a file that is a link or too large is not read, and its last good version stays', async () => {
    const h = configHarness();
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    h.fs.seed(h.path('updates.yaml'), `limit: 3\n# ${'x'.repeat(300 * 1024)}\n`);
    await h.files.reload();
    expect(limitOf(h)).toBe(5);
    expect(h.files.status().issues[0]?.message).toContain('not read');
  });

  test('a file nobody has accepted yet and that is broken is not in effect at all', async () => {
    const h = configHarness();
    h.fs.seed(h.path('updates.yaml'), 'limit: [');
    await h.files.reload();
    expect(limitOf(h)).toBeUndefined();
  });
});

describe('config files: held loosening', () => {
  test('a write that loosens is written and held, the tighter version stays in effect, and confirming it applies it', async () => {
    const h = configHarness();
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    const result = await h.files.write('updates', updatesDef, undefined, 'limit: 50\n');
    expect(result.kind).toBe('held');
    if (result.kind !== 'held') return;
    expect(result.sentences).toEqual(['raises the limit from 5 to 50']);
    expect(limitOf(h)).toBe(5);
    expect(h.fs.snapshot().get(h.path('updates.yaml'))).toBe('limit: 50\n');
    expect(h.files.held()).toMatchObject([{ id: result.id, plugin: 'updates', path: 'updates.yaml', removal: false }]);
    expect(await h.files.confirm(result.id)).toBe(true);
    expect(limitOf(h)).toBe(50);
    expect(h.files.held()).toEqual([]);
  });

  test('a confirmed loosening is not asked about again after a restart', async () => {
    const h = configHarness();
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    const held = await h.files.write('updates', updatesDef, undefined, 'limit: 50\n');
    if (held.kind === 'held') await h.files.confirm(held.id);
    const again = h.restart();
    await again.reload();
    expect((again.port('updates').file(updatesDef) as { limit: number }).limit).toBe(50);
    expect(again.held()).toEqual([]);
  });

  test('a write the caller may confirm in the same act is applied, and says what it loosened', async () => {
    const h = configHarness();
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    const result = await h.files.write('updates', updatesDef, undefined, 'limit: 50\n', { confirmedLoosening: true });
    expect(result).toMatchObject({ kind: 'applied', loosened: ['raises the limit from 5 to 50'] });
    expect(limitOf(h)).toBe(50);
  });

  test('tightening applies at once and asks nobody', async () => {
    const h = configHarness();
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    expect(await h.files.write('updates', updatesDef, undefined, 'limit: 2\n')).toMatchObject({
      kind: 'applied',
      loosened: [],
    });
    expect(limitOf(h)).toBe(2);
  });

  test('a hand edit on disk that loosens is held on the next reload', async () => {
    const h = configHarness();
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    h.fs.seed(h.path('updates.yaml'), 'limit: 99\n');
    await h.files.reload();
    expect(limitOf(h)).toBe(5);
    expect(h.files.held()).toHaveLength(1);
    expect(h.files.status().files).toContainEqual({ path: 'updates.yaml', plugin: 'updates', state: 'pending' });
  });

  test('a first file is judged against nothing in effect: loosens(undefined, after) decides', async () => {
    const h = configHarness();
    h.fs.seed(h.path('updates.yaml'), 'limit: 99\n');
    await h.files.reload();
    expect(h.files.held()).toHaveLength(1);
    expect(limitOf(h)).toBeUndefined();
  });

  test('confirm and discard name ONE reviewed edit: a stale id touches nothing', async () => {
    const h = configHarness();
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    const held = await h.files.write('updates', updatesDef, undefined, 'limit: 50\n');
    if (held.kind !== 'held') throw new Error('expected held');
    await h.files.write('updates', updatesDef, undefined, 'limit: 60\n');
    expect(await h.files.confirm(held.id)).toBe(false);
    expect(await h.files.discard(held.id)).toBe(false);
    expect(limitOf(h)).toBe(5);
    expect(await h.files.confirm('nothing@000')).toBe(false);
  });

  test('discarding a held edit puts the version in effect back on disk', async () => {
    const h = configHarness();
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    const held = await h.files.write('updates', updatesDef, undefined, 'limit: 50\n');
    if (held.kind !== 'held') throw new Error('expected held');
    expect(await h.files.discard(held.id)).toBe(true);
    expect(h.fs.snapshot().get(h.path('updates.yaml'))).toBe('limit: 5\n');
    expect(limitOf(h)).toBe(5);
    expect(h.files.held()).toEqual([]);
  });

  test('deleting a file is an edit to its defaults, judged the same way', async () => {
    const h = configHarness();
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    const removed = await h.files.remove('updates', updatesDef, undefined);
    expect(removed.kind).toBe('held');
    expect(limitOf(h)).toBe(5);
    expect(h.files.held()[0]?.removal).toBe(true);
    const confirmed = h.files.held()[0];
    if (confirmed !== undefined) expect(await h.files.confirm(confirmed.id)).toBe(true);
    expect(limitOf(h)).toBeUndefined();
  });

  test('deleting a file whose defaults are no looser applies at once', async () => {
    const h = configHarness();
    await h.files.write('updates', updatesDef, undefined, 'limit: 20\n', { confirmedLoosening: true });
    expect(await h.files.remove('updates', updatesDef, undefined)).toMatchObject({ kind: 'applied' });
    expect(limitOf(h)).toBeUndefined();
  });
});

describe('config files: no raw secret', () => {
  const KEY = `sk-${'a1B2c3D4'.repeat(4)}`;

  test('a write holding a raw secret is refused whole, the file is not written, and the value is never repeated', async () => {
    const h = configHarness();
    const result = await h.files.write('updates', updatesDef, undefined, `limit: 3\napiKey: ${KEY}\n`);
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.reason).toBe('raw_secret');
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(h.fs.snapshot().has(h.path('updates.yaml'))).toBe(false);
  });

  test('a ${secret:NAME} placeholder is allowed', async () => {
    const h = configHarness();
    const result = await h.files.write('updates', updatesDef, undefined, 'limit: 3\napiKey: ${secret:UPDATES_KEY}\n');
    expect(result.kind).toBe('applied');
  });

  test('a file on disk that holds a raw secret keeps its last good version, and the log never carries the value', async () => {
    const h = configHarness();
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    h.fs.seed(h.path('updates.yaml'), `limit: 1\napiKey: ${KEY}\n`);
    await h.files.reload();
    expect(limitOf(h)).toBe(5);
    expect(h.log.lines.join('\n')).not.toContain(KEY);
    expect(JSON.stringify(h.files.status())).not.toContain(KEY);
    expect(h.files.status().issues[0]?.fix).toContain('fy secret set NAME');
  });
});

describe('config files: comment-keeping writes', () => {
  const COMMENTED =
    '# yaml-language-server: $schema=.schema/updates.json\n# how many we keep\nlimit: 5 # five is plenty\n\n# owner note\nnote: hello\n';

  test('a patch changes only the changed key; comments and order survive', async () => {
    const h = configHarness();
    h.fs.seed(h.path('updates.yaml'), COMMENTED);
    await h.files.reload();
    const result = await h.files.write('updates', updatesDef, undefined, { patch: { note: 'goodbye' } });
    expect(result.kind).toBe('applied');
    const text = h.fs.snapshot().get(h.path('updates.yaml')) ?? '';
    expect(text).toContain('# how many we keep');
    expect(text).toContain('limit: 5 # five is plenty');
    expect(text).toContain('# owner note');
    expect(text).toContain('note: goodbye');
    expect(text).not.toContain('hello');
  });

  test('a patch that sets a key to undefined removes it, and a default is not written in', async () => {
    const h = configHarness();
    h.fs.seed(h.path('updates.yaml'), COMMENTED);
    await h.files.reload();
    await h.files.write('updates', updatesDef, undefined, { patch: { note: undefined } });
    const text = h.fs.snapshot().get(h.path('updates.yaml')) ?? '';
    expect(text).not.toContain('note');
    expect(text).toContain('# how many we keep');
  });

  test('a patch to a new file begins with the schema modeline', async () => {
    const h = configHarness();
    await h.files.write('logins', loginsDef, 'work', { patch: { model: 'fast' } });
    const text = h.fs.snapshot().get(h.path('logins/work.yaml')) ?? '';
    expect(text.split('\n')[0]).toBe('# yaml-language-server: $schema=../.schema/logins.json');
    expect(text).toContain('model: fast');
  });

  test('a patch that makes the file fail its schema is refused and the file is untouched', async () => {
    const h = configHarness();
    h.fs.seed(h.path('updates.yaml'), COMMENTED);
    await h.files.reload();
    const result = await h.files.write('updates', updatesDef, undefined, { patch: { limit: 'lots' } });
    expect(result).toMatchObject({ kind: 'refused', reason: 'schema' });
    expect(h.fs.snapshot().get(h.path('updates.yaml'))).toBe(COMMENTED);
  });
});

describe('config files: collections, claims and refusals', () => {
  test('a collection reads <name>.yaml files whose name matches the def, and reports the rest', async () => {
    const h = configHarness();
    h.fs.seed(h.path('logins/work.yaml'), 'model: a\n');
    h.fs.seed(h.path('logins/Bad_Name.yaml'), 'model: b\n');
    await h.files.reload();
    const map = h.files.port('logins').collection(loginsDef) as ReadonlyMap<string, { model: string }>;
    expect([...map.keys()]).toEqual(['work']);
    expect(h.files.status().issues.some(i => i.path === 'logins/Bad_Name.yaml' && i.severity === 'warning')).toBe(true);
  });

  test('a collection item removed from disk goes out of effect; one whose removal loosens is held', async () => {
    const h = configHarness();
    await h.files.write('logins', loginsDef, 'a', 'budget: 5\n');
    await h.files.write('logins', loginsDef, 'b', 'model: z\n');
    await h.fs.remove(h.path('logins/a.yaml'));
    await h.fs.remove(h.path('logins/b.yaml'));
    await h.files.reload();
    const map = h.files.port('logins').collection(loginsDef) as ReadonlyMap<string, unknown>;
    expect([...map.keys()]).toEqual(['a']);
    expect(h.files.held().map(i => i.name)).toEqual(['a']);
  });

  test('a write names a def the plugin declared, and a name the def allows', async () => {
    const h = configHarness();
    const other = defineConfig({ file: 'other.yaml', schema: z.object({}), axis: 'use', loosens: () => [] });
    expect(await h.files.write('logins', other, undefined, 'a: 1\n')).toMatchObject({
      kind: 'refused',
      reason: 'not_declared',
    });
    expect(await h.files.write('updates', loginsDef, 'x', 'model: a\n')).toMatchObject({
      kind: 'refused',
      reason: 'not_declared',
    });
    expect(await h.files.write('logins', loginsDef, 'Bad Name', 'model: a\n')).toMatchObject({
      kind: 'refused',
      reason: 'bad_name',
    });
    expect(await h.files.write('logins', loginsDef, undefined, 'model: a\n')).toMatchObject({
      kind: 'refused',
      reason: 'bad_name',
    });
    expect(await h.files.write('updates', updatesDef, 'name', 'limit: 1\n')).toMatchObject({
      kind: 'refused',
      reason: 'bad_name',
    });
  });

  test('invalid YAML and a schema failure are refused with the reason', async () => {
    const h = configHarness();
    expect(await h.files.write('updates', updatesDef, undefined, 'limit: [')).toMatchObject({
      kind: 'refused',
      reason: 'yaml',
    });
    expect(await h.files.write('updates', updatesDef, undefined, 'bogus: 1\n')).toMatchObject({
      kind: 'refused',
      reason: 'schema',
    });
  });

  test('a plugin reads only its own defs', () => {
    const h = configHarness();
    expect(() => h.files.port('logins').file(updatesDef)).toThrow('did not declare');
    expect(() => h.files.port('updates').watch(loginsDef as never, () => undefined)).toThrow('did not declare');
  });

  test('a write whose etag moved since it was read is refused as a conflict', async () => {
    const h = configHarness();
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    const view = await h.files.read('updates', updatesDef);
    h.fs.seed(h.path('updates.yaml'), 'limit: 4\n');
    const result = await h.files.write('updates', updatesDef, undefined, 'limit: 3\n', { ifMatch: view?.etag });
    expect(result).toMatchObject({ kind: 'refused', reason: 'conflict' });
  });

  const claim = (plugin: string, def: AnyConfigDef) => ({ plugin, def });
  const build = (...defs: ReturnType<typeof claim>[]) =>
    createConfigFiles({
      home: HOME,
      fs: createMemoryHostFs(),
      clock: manualClock(),
      log: captureLog(),
      binary: 'fy',
      defs,
    });
  const schema = z.object({}).passthrough();

  test('two defs that claim one path are refused', () => {
    const file = (name: string) => defineConfig({ file: name, schema, axis: 'use', loosens: () => [] });
    const folder = (name: string) =>
      defineConfig({ collection: name, name: /^[a-z]+$/, schema, axis: 'use', loosens: () => [] });
    expect(() => build(claim('a', file('x.yaml')), claim('b', file('x.yaml')))).toThrow(ConfigPathClaimError);
    expect(() => build(claim('a', file('x.yaml')), claim('a', file('x.yaml')))).toThrow(ConfigPathClaimError);
    expect(() => build(claim('a', folder('logins')), claim('b', folder('logins')))).toThrow(ConfigPathClaimError);
    expect(() => build(claim('a', folder('logins')), claim('b', file('logins/x.yaml')))).toThrow(ConfigPathClaimError);
    expect(() => build(claim('a', folder('claude')), claim('b', folder('claude/hooks')))).toThrow(ConfigPathClaimError);
    expect(() => build(claim('a', file('x.yaml')), claim('b', folder('x.yaml')))).toThrow(ConfigPathClaimError);
    expect(() => build(claim('a', file('x.yaml')), claim('b', file('y.yaml')), claim('c', folder('z')))).not.toThrow();
  });

  test('a path that leaves config/ or hides is refused', () => {
    const file = (name: string) => defineConfig({ file: name, schema, axis: 'use', loosens: () => [] });
    for (const bad of ['../x.yaml', '/x.yaml', '.schema/x.yaml', 'a//b.yaml', 'x.json'])
      expect(() => build(claim('a', file(bad)))).toThrow(ConfigPathClaimError);
  });
});

describe('config files: live reading and watching', () => {
  test('a listener hears a reload that moved its file, and not the first reload', async () => {
    const h = configHarness();
    h.fs.seed(h.path('updates.yaml'), 'limit: 5\n');
    let heard = 0;
    h.files.port('updates').watch(updatesDef as never, () => void (heard += 1));
    await h.files.reload();
    expect(heard).toBe(0);
    await h.files.reload();
    expect(heard).toBe(0);
    h.fs.seed(h.path('updates.yaml'), 'limit: 4\n');
    await h.files.reload();
    expect(heard).toBe(1);
    const cancel = h.files.port('updates').watch(updatesDef as never, () => void (heard += 10));
    cancel();
    h.fs.seed(h.path('updates.yaml'), 'limit: 3\n');
    await h.files.reload();
    expect(heard).toBe(2);
  });

  test('a listener is not told about an edit that is held: nothing moved in effect', async () => {
    const h = configHarness();
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    let heard = 0;
    h.files.port('updates').watch(updatesDef as never, () => void (heard += 1));
    await h.files.write('updates', updatesDef, undefined, 'limit: 50\n');
    expect(heard).toBe(0);
  });

  test('a failing listener does not stop the others or the reload', async () => {
    const h = configHarness();
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    let heard = 0;
    h.files.port('updates').watch(updatesDef as never, () => {
      throw new Error('listener bug');
    });
    h.files.port('updates').watch(updatesDef as never, () => void (heard += 1));
    h.fs.seed(h.path('updates.yaml'), 'limit: 4\n');
    await h.files.reload();
    expect(heard).toBe(1);
    expect(h.log.lines.some(line => line.includes('listener bug'))).toBe(true);
  });

  test('startWatching reloads after the tree has been quiet, and stops when told', async () => {
    const h = configHarness();
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    const stop = h.files.startWatching();
    await new Promise(resolve => setTimeout(resolve, 5));
    h.clock.advance(100);
    h.fs.seed(h.path('updates.yaml'), 'limit: 4\n');
    h.clock.advance(1_000);
    await new Promise(resolve => setTimeout(resolve, 5));
    h.clock.advance(400);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(limitOf(h)).toBe(4);
    stop();
  });

  test('publishSchemas writes one JSON Schema per def, only when it changed', async () => {
    const h = configHarness();
    await h.files.publishSchemas();
    expect([...h.fs.snapshot().keys()].filter(p => p.includes('/.schema/')).toSorted()).toEqual([
      h.path('.schema/logins.json'),
      h.path('.schema/updates.json'),
    ]);
    const before = h.fs.snapshot().get(h.path('.schema/updates.json'));
    expect(before).toContain('"limit"');
    await h.files.publishSchemas();
    expect(h.fs.snapshot().get(h.path('.schema/updates.json'))).toBe(before);
  });
});
