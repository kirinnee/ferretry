import { describe, expect, it } from 'bun:test';
import { installedNames } from '../../../../src/features/shared/shared-installs.ts';
import { installRecord } from '../../../support/catalog-views.ts';

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
