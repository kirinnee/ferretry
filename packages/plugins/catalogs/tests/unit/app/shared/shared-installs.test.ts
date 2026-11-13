import { describe, expect, it } from 'bun:test';
import { installedItems, installedNames, itemNames } from '../../../../app/features/shared/shared-installs.ts';
import { installRecord } from '../support/catalog-views.ts';

describe('installedNames', () => {
  const base = installRecord('skill', 'pdf-tools');
  const from = (publisher: string, itemId: string, name: string) => ({
    ...base,
    provenance: { ...base.provenance, publisher, itemId, name },
  });

  it('maps item id to the name the machine recorded, for one publisher only', () => {
    const names = installedNames(
      [from('fy_daemon_a', 'item_1', 'one'), from('fy_daemon_b', 'item_2', 'two')],
      'fy_daemon_a',
    );
    expect([...names]).toEqual([['item_1', 'one']]);
  });

  it('is empty when nothing came from that publisher', () => {
    expect(installedNames([from('fy_daemon_b', 'item_2', 'two')], 'fy_daemon_a').size).toBe(0);
  });
});

describe('installedItems and itemNames', () => {
  const base = installRecord('skill', 'pdf-tools');
  const at = (publisher: string, itemId: string, version: number) => ({
    ...base,
    provenance: { ...base.provenance, publisher, itemId, version, name: `name-${itemId}` },
  });
  const machine = (name: string) => ({ connection: {} as never, name });

  it('keeps one install per item of the publisher, the oldest copy, the first machine on a tie', () => {
    const items = installedItems(
      [
        { machine: machine('one'), installs: [at('fy_daemon_a', 'item_1', 3), at('fy_daemon_b', 'item_2', 1)] },
        { machine: machine('two'), installs: [at('fy_daemon_a', 'item_1', 2), at('fy_daemon_a', 'item_3', 4)] },
        { machine: machine('three'), installs: [at('fy_daemon_a', 'item_1', 2)] },
      ],
      'fy_daemon_a',
    );
    expect([...items.keys()]).toEqual(['item_1', 'item_3']);
    expect(items.get('item_1')?.version).toBe(2);
    expect(items.get('item_1')?.machine.name).toBe('two');
    expect(items.get('item_3')?.machine.name).toBe('two');
  });

  it('names each item from its own record', () => {
    const items = installedItems(
      [{ machine: machine('one'), installs: [at('fy_daemon_a', 'item_1', 1)] }],
      'fy_daemon_a',
    );
    expect([...itemNames(items)]).toEqual([['item_1', 'name-item_1']]);
  });
});
