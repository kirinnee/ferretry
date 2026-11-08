import { describe, expect, it } from 'bun:test';
import half from '../../../app/index.ts';

describe('the Catalogs app half', () => {
  it('draws every screen the manifest declares (sharing, join, shared) and nothing it does not', () => {
    const built = half.build?.({ manifest: half.manifest, client: { call: async () => ({}) } as never });
    expect(Object.keys(built?.screens ?? {}).sort()).toEqual(['join', 'shared', 'sharing']);
    expect(half.skeleton).toBeUndefined();
  });
});
