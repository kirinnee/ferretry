import { describe, expect, it } from 'bun:test';
import { type DaemonlessPorts, registeredDaemonless, type SurfaceEntry } from '@ferretry/app';
import half from '../../../app/index.ts';
import { JOIN_PATH } from '../../../app/lib/routes.ts';
import manifest from '../../../manifest.ts';

describe('the Catalogs app half', () => {
  it('draws every screen the manifest declares (sharing, join, shared) and nothing it does not', () => {
    const built = half.build?.({ manifest: half.manifest, client: { call: async () => ({}) } as never });
    expect(Object.keys(built?.screens ?? {}).sort()).toEqual(['join', 'shared', 'sharing']);
    expect(half.skeleton).toBeUndefined();
  });

  it('R2-B1 the shell mounts /join and /shared from the daemon-less factory, and only those', () => {
    expect(manifest.ui?.screens?.filter(screen => screen.daemonless === true).map(screen => screen.id)).toEqual([
      'join',
      'shared',
    ]);
    const entry = { id: 'catalogs', title: 'Catalogs', core: false, contract: 'h', consumes: [], manifest, app: half };
    const registered = registeredDaemonless([entry as unknown as SurfaceEntry], {} as DaemonlessPorts);
    expect(registered.failures).toEqual([]);
    expect([...registered.views.keys()].sort()).toEqual(['catalogs.join', 'catalogs.shared']);
  });

  it('R4-S1 the hold is armed on the join screen’s declared path, so it strips where the router draws that screen', () => {
    expect(manifest.ui?.screens?.find(screen => screen.id === 'join')?.path).toBe(JOIN_PATH);
  });

  it('the daemon-less factory takes the shell’s ports and builds no client from them', () => {
    const make = (half as unknown as { shell: { daemonless: (ports: unknown) => Record<string, unknown> } }).shell
      .daemonless;
    // Handed nothing at all, it still builds both views: it reads nothing of the ports and has no client to build.
    expect(Object.keys(make({})).sort()).toEqual(['join', 'shared']);
  });
});
