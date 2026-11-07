import { describe, expect, it } from 'bun:test';
import app from '../../../app/index.ts';
import manifest from '../../../manifest.ts';
import { scripted } from './skills-support.ts';

describe('Skills’ app half', () => {
  it('is built, not a skeleton, and draws exactly the surfaces the manifest declares', () => {
    expect(app.skeleton).toBeUndefined();
    const half = app.build?.({ manifest, client: scripted({}).client });
    expect(Object.keys(half?.panels ?? {})).toEqual(['skills']);
    expect(Object.keys(half?.settings ?? {})).toEqual(['skills']);
    expect(Object.keys(half?.renderers ?? {}).sort()).toEqual(['reference:$', 'reference:/']);
    expect(manifest.ui?.panels?.map(panel => panel.id)).toEqual(['skills']);
  });

  it('loads no view module until a surface is first drawn, and never touches the daemon building', () => {
    const { client, calls } = scripted({});
    app.build?.({ manifest, client });
    expect(calls).toEqual([]);
  });
});
