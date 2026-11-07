import { describe, expect, it } from 'bun:test';
import type { AppContext } from '@ferretry/kernel/manifest';
import app from '../../../app/index.ts';
import manifest from '../../../manifest.ts';
import { scripted } from './support/client.ts';

const half = () => app.build?.({ manifest, client: scripted({}) } as unknown as AppContext<typeof manifest>);

describe('the logins app half', () => {
  it('is not the skeleton', () => {
    expect((app as { skeleton?: true }).skeleton).toBeUndefined();
  });

  it('draws the Logins settings tab and every panel the manifest declares, and nothing it does not', () => {
    const built = half();
    const declaredPanels = (manifest.ui?.panels ?? []).map(entry => entry.id);
    expect(Object.keys(built?.panels ?? {}).sort()).toEqual([...declaredPanels].sort());
    expect(Object.keys(built?.settings ?? {})).toEqual(['logins']);
  });
});
