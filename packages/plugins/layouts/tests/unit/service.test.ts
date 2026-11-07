import { describe, expect, test } from 'bun:test';
import { createLayoutsService } from '../../daemon/lib/service.ts';
import { COMPACT_LAYOUT, DEFAULT_LAYOUT, LayoutSchema } from '../../contract/index.ts';
import { configTree } from './support.ts';

const make = (initial: Record<string, Record<string, unknown>> = {}, refuse?: string) => {
  const tree = configTree(initial, refuse);
  return { tree, service: createLayoutsService(tree.port, tree.door) };
};

describe('layouts service', () => {
  test('list names the built-ins, saved items, and what is in use', () => {
    const { service } = make({
      'layouts/mine': { ...DEFAULT_LAYOUT, id: 'mine' },
      'layout.yaml': { layout: 'compact' },
    });
    const list = service.list();
    expect(list.layouts).toEqual([
      { id: 'mine', origin: 'saved' },
      { id: 'default', origin: 'built-in' },
      { id: 'compact', origin: 'built-in' },
    ]);
    expect(list.current).toEqual({ layout: 'compact', theme: 'default' });
  });

  test('fy layout set writes only the changed keys to config/layout.yaml and serves the result', async () => {
    const { service, tree } = make();
    const result = await service.set([{ path: 'nav.side', value: 'right' }]);
    expect(result.ok && result.value.nav.side).toBe('right');
    expect(tree.calls).toEqual([
      { op: 'write', where: 'layout.yaml', edit: { patch: { overrides: { nav: { side: 'right' } } } } },
    ]);
    expect(service.current().layout.nav.side).toBe('right');
    expect(service.current().layout.nav.items).toEqual(DEFAULT_LAYOUT.nav.items);
  });

  test('a refused set writes nothing', async () => {
    const { service, tree } = make();
    const result = await service.set([{ path: 'nav.side', value: 'diagonal' }]);
    expect(!result.ok && result.refusal.kind).toBe('invalid');
    expect(tree.calls).toEqual([]);
  });

  test('fy layout use switches layouts and starts the overrides again', async () => {
    const { service, tree } = make({ 'layout.yaml': { layout: 'default', overrides: { density: 'compact' } } });
    const result = await service.use('compact');
    expect(result.ok && result.value).toEqual(COMPACT_LAYOUT);
    expect(tree.documents.get('layout.yaml')).toEqual({ layout: 'compact' });
    expect(service.current().layout.id).toBe('compact');
  });

  test('use of a layout that is not installed is unknown, and writes nothing', async () => {
    const { service, tree } = make();
    const result = await service.use('nope');
    expect(!result.ok && result.refusal.kind).toBe('unknown');
    expect(tree.calls).toEqual([]);
  });

  test('fy theme use refuses a theme that is not installed and switches to one that is', async () => {
    const { service, tree } = make({ 'themes/dusk': { id: 'dusk', label: 'Dusk', base: 'neo', light: {}, dark: {} } });
    expect((await service.useTheme('nope')).ok).toBe(false);
    expect((await service.useTheme('dusk')).ok).toBe(true);
    expect(tree.documents.get('layout.yaml')).toEqual({ theme: 'dusk' });
    expect(service.current().theme.base).toBe('neo');
    expect(service.themes()).toEqual({
      themes: [
        { id: 'dusk', origin: 'saved' },
        { id: 'default', origin: 'built-in' },
      ],
      current: 'dusk',
    });
  });

  test('fy layout reset drops the overrides and uses the default again', async () => {
    const { service, tree } = make({
      'layout.yaml': { layout: 'compact', theme: 'default', overrides: { density: 'comfortable' } },
    });
    await service.reset();
    expect(tree.documents.get('layout.yaml')).toEqual({ layout: 'default', theme: 'default' });
    expect(service.current().layout).toEqual(DEFAULT_LAYOUT);
  });

  test('fy layout save writes the layout in use, overrides applied, as a new item with its own id', async () => {
    const { service, tree } = make({ 'layout.yaml': { overrides: { nav: { side: 'bottom' } } } });
    const result = await service.save('mine');
    expect(result.ok && result.value).toEqual({ id: 'mine', origin: 'saved' });
    const call = tree.calls[0];
    expect(call?.where).toBe('layouts/mine');
    const saved = LayoutSchema.parse(Bun.YAML.parse(call?.edit as string));
    expect(saved.id).toBe('mine');
    expect(saved.nav.side).toBe('bottom');
  });

  test('save refuses a name already taken, built-in or saved', async () => {
    const { service } = make({ 'layouts/mine': { ...DEFAULT_LAYOUT, id: 'mine' } });
    for (const id of ['default', 'mine']) {
      const result = await service.save(id);
      expect(!result.ok && result.refusal.kind).toBe('conflict');
    }
  });

  test('a built-in cannot be removed; a saved one can, and the app falls back when it was in use', async () => {
    const { service, tree } = make({
      'layouts/mine': { ...DEFAULT_LAYOUT, id: 'mine', density: 'compact' },
      'layout.yaml': { layout: 'mine' },
    });
    expect(service.current().layout.density).toBe('compact');
    const builtIn = await service.remove('compact');
    expect(!builtIn.ok && builtIn.refusal.kind).toBe('conflict');
    expect((await service.remove('mine')).ok).toBe(true);
    expect(tree.calls.at(-1)).toEqual({ op: 'remove', where: 'layouts/mine' });
    expect(service.current().layout.id).toBe('default');
    const gone = await service.remove('mine');
    expect(!gone.ok && gone.refusal.kind).toBe('unknown');
  });

  test('a saved layout cannot shadow a built-in one', () => {
    const { service } = make({ 'layouts/default': { ...DEFAULT_LAYOUT, density: 'compact' } });
    expect(service.layout('default')?.density).toBe('comfortable');
  });

  test('without a config door every write is unavailable and every read still works', async () => {
    const tree = configTree();
    const service = createLayoutsService(tree.port, undefined);
    for (const result of [
      await service.set([{ path: 'density', value: 'compact' }]),
      await service.use('compact'),
      await service.useTheme('default'),
      await service.reset(),
      await service.save('mine'),
    ])
      expect(!result.ok && result.refusal.kind).toBe('unavailable');
    expect(service.current().layout.id).toBe('default');
  });

  test('a write the config door refuses is reported as an invalid layout', async () => {
    const { service } = make({}, 'overrides: not a mapping');
    const result = await service.set([{ path: 'density', value: 'compact' }]);
    expect(!result.ok && result.refusal.kind).toBe('invalid');
  });
});

test('selecting a saved theme the app cannot read is refused before changing the selection', async () => {
  for (const light of [{ accent: 'red' }, { unknown: '#123456' }, { accent: '#123456; color: red' }]) {
    const tree = configTree();
    // Even if a port hands the service an unchecked item, selection still checks the wire contract.
    const port: import('@ferretry/kernel/contract').ConfigPort = {
      ...tree.port,
      collection: () => new Map([['dusk', { id: 'dusk', label: 'Dusk', base: 'neo', light, dark: {} }]]) as never,
    };
    const service = createLayoutsService(port, tree.door);
    const result = await service.useTheme('dusk');
    expect(!result.ok && result.refusal.kind).toBe('invalid');
    expect(tree.calls).toEqual([]);
  }
});
