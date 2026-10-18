import { describe, expect, it } from 'bun:test';
import type { FleetLayeredProfileCatalog } from '@ferretry/protocol';
import {
  type AccountCatalogRead,
  type UseAccountCatalog,
  useAccountCatalog,
} from '../../../../../src/features/fleet/components/account-catalog.ts';
import type { FleetClientFactory } from '../../../../../src/features/fleet/fleet-client.ts';
import { interact, mount } from '../../../../support/dom.ts';
import { configChangeHarness } from '../../../config-change-support.tsx';
import { COMPONENTS, PROFILES, RUNTIMES, scripted, STUDIO } from '../account-support.ts';

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  });
};

const profilesNamed = (...names: readonly string[]): FleetLayeredProfileCatalog => ({
  ...PROFILES,
  profiles: PROFILES.profiles.filter(profile => names.includes(profile.name)),
});

/** A machine whose profiles a test swaps, whose reads it can hold or fail, and whose asks it counts. */
const machineFixture = () => {
  const state = {
    profiles: profilesNamed('Default'),
    asks: 0,
    failFrom: Number.POSITIVE_INFINITY,
    holds: new Map<number, Promise<void>>(),
  };
  const createClient: FleetClientFactory = async () => {
    state.asks += 1;
    const ask = state.asks;
    const client = scripted({
      'GET /v1/fleet/components': COMPONENTS,
      'GET /v1/fleet/profiles': state.profiles,
      'GET /v1/fleet/runtimes': RUNTIMES,
    });
    await state.holds.get(ask);
    if (ask >= state.failFrom) throw new Error('machine is unreachable');
    return client;
  };
  return { state, createClient };
};

/** Mounts the hook and keeps its latest answer where a test can read it. */
const mountCatalog = async (fixture: ReturnType<typeof machineFixture>) => {
  const harness = configChangeHarness(STUDIO.daemonId);
  const latest: { current?: UseAccountCatalog } = {};
  const Probe = () => {
    latest.current = useAccountCatalog(STUDIO, fixture.createClient);
    const read = latest.current.read;
    return <p>{read.kind === 'ready' ? read.catalog.profiles.profiles.map(p => p.name).join(',') : read.kind}</p>;
  };
  const view = await mount(harness.wrap(<Probe />));
  await settle();
  const shown = (): string => view.container.textContent ?? '';
  const read = (): AccountCatalogRead => latest.current?.read ?? { kind: 'loading' };
  return { harness, view, shown, read, reload: () => latest.current?.reload() };
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
    await page.harness.move(['profiles']);
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
    await page.harness.move(['profiles']);
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
    await page.harness.move(['profiles']);

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
