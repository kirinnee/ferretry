import { describe, expect, it } from 'bun:test';
import {
  type AccountCatalogRead,
  type UseAccountCatalog,
  useAccountCatalog,
} from '../../../../../../app/features/fleet/components/account-catalog.ts';
import type { LiveRuntimesClient } from '../../../../../../app/lib/client.ts';
import type { LayeredProfileCatalog } from '../../../../../../contract/index.ts';
import { interact, mount } from '../../../../support/dom.ts';
import { COMPONENTS, PROFILES, RUNTIMES, scripted } from '../account-support.ts';

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  });
};

const profilesNamed = (...names: readonly string[]): LayeredProfileCatalog => ({
  ...PROFILES,
  profiles: PROFILES.profiles.filter(profile => names.includes(profile.name)),
});

/**
 * A machine whose profiles a test swaps, whose catalogue reads it can hold or fail, and whose asks it counts: one
 * ask is one read of the profiles route. `move` is the daemon saying `runtimes.changed`.
 */
const machineFixture = () => {
  const state = {
    profiles: profilesNamed('Default'),
    asks: 0,
    failFrom: Number.POSITIVE_INFINITY,
    holds: new Map<number, Promise<void>>(),
  };
  const listeners = new Set<(payload: unknown) => void>();
  const base = scripted({
    'GET /v1/runtimes/components': COMPONENTS,
    'GET /v1/runtimes': RUNTIMES,
    'GET /v1/runtimes/profiles': async () => {
      state.asks += 1;
      const ask = state.asks;
      const answer = state.profiles;
      await state.holds.get(ask);
      if (ask >= state.failFrom) throw new Error('machine is unreachable');
      return answer;
    },
  });
  const client: LiveRuntimesClient = {
    call: base.call,
    subscribe: ((event: { name: string }, listener: (payload: unknown) => void) => {
      if (event.name !== 'runtimes.changed') return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    }) as unknown as NonNullable<LiveRuntimesClient['subscribe']>,
  };
  const move = (kinds: readonly ('profiles' | 'runtimes' | 'modelSets')[]) =>
    interact(async () => {
      const payload = { runtimes: [], profiles: [], modelSets: [], ...Object.fromEntries(kinds.map(k => [k, ['x']])) };
      for (const listener of [...listeners]) listener(payload);
    });
  return { state, client, move };
};

/** Mounts the hook and keeps its latest answer where a test can read it. */
const mountCatalog = async (fixture: ReturnType<typeof machineFixture>) => {
  const latest: { current?: UseAccountCatalog } = {};
  const Probe = () => {
    latest.current = useAccountCatalog(fixture.client);
    const read = latest.current.read;
    return <p>{read.kind === 'ready' ? read.catalog.profiles.profiles.map(p => p.name).join(',') : read.kind}</p>;
  };
  const view = await mount(<Probe />);
  await settle();
  const shown = (): string => view.container.textContent ?? '';
  const read = (): AccountCatalogRead => latest.current?.read ?? { kind: 'loading' };
  return { view, shown, read, reload: () => latest.current?.reload() };
};

describe('useAccountCatalog follows the machine', () => {
  it('shows the new catalogue when a profile changes elsewhere, without a reload', async () => {
    // Arrange — the page shows one profile
    const fixture = machineFixture();
    const page = await mountCatalog(fixture);
    expect(page.shown()).toBe('Default');
    expect(fixture.state.asks).toBe(1);

    // Act — another device adds a profile
    fixture.state.profiles = profilesNamed('Default', 'Review');
    await fixture.move(['profiles']);
    await settle();

    // Assert
    expect(fixture.state.asks).toBe(2);
    expect(page.shown()).toBe('Default,Review');
    await page.view.unmount();
  });

  it('keeps the catalogue on screen when the re-read fails', async () => {
    // Arrange
    const fixture = machineFixture();
    const page = await mountCatalog(fixture);
    fixture.state.failFrom = 2;

    // Act — the machine says it changed, then does not answer
    fixture.state.profiles = profilesNamed('Review');
    await fixture.move(['profiles']);
    await settle();

    // Assert — the page still shows what it last had, not an error
    expect(fixture.state.asks).toBe(2);
    expect(page.read().kind).toBe('ready');
    expect(page.shown()).toBe('Default');
    await page.view.unmount();
  });

  it('drops a re-read that a newer read has overtaken', async () => {
    // Arrange — the re-read after the change is held on the wire
    const fixture = machineFixture();
    const page = await mountCatalog(fixture);
    let release: () => void = () => undefined;
    fixture.state.holds.set(2, new Promise<void>(resolve => (release = resolve)));
    fixture.state.profiles = profilesNamed('Review');
    await fixture.move(['profiles']);

    // Act — a newer read starts and answers first, then the held one answers
    fixture.state.profiles = profilesNamed('Default', 'Review');
    await interact(() => page.reload());
    expect(page.shown()).toBe('Default,Review');
    release();
    await settle();

    // Assert — the older answer did not replace the newer one
    expect(fixture.state.asks).toBe(3);
    expect(page.shown()).toBe('Default,Review');
    await page.view.unmount();
  });
});
