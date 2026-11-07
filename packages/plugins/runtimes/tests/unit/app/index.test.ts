import { describe, expect, it } from 'bun:test';
import type { PluginClient } from '@ferretry/kernel/manifest';
import half from '../../../app/index.ts';
import manifest from '../../../manifest.ts';

describe('the app half', () => {
  it('implements every settings tab and panel the manifest declares, and nothing else', () => {
    const client = { call: async () => ({}), subscribe: () => () => undefined } as unknown as PluginClient;
    const built = half.build?.({ manifest, client }) as unknown as {
      settings: Record<string, unknown>;
      panels: Record<string, unknown>;
    };
    expect(Object.keys(built.settings).sort()).toEqual((manifest.ui?.settings ?? []).map(tab => tab.id).sort());
    expect(Object.keys(built.panels).sort()).toEqual((manifest.ui?.panels ?? []).map(panel => panel.id).sort());
    expect(Object.keys(built)).toEqual(['settings', 'panels']);
    for (const component of [...Object.values(built.settings), ...Object.values(built.panels)])
      expect(typeof component).toBe('function');
  });

  it('is a real half, not the skeleton', () => {
    expect(half.skeleton).toBeUndefined();
    expect(half.half).toBe('app');
  });
});
