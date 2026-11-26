import { afterEach, describe, expect, it } from 'bun:test';
import { LayeredProfileCatalogSchema, type MachineView } from '../../../../../../contract/index.ts';
import { AddRuntime } from '../../../../../../app/features/fleet/runtimes/add-runtime.tsx';
import type { MachineData } from '../../../../../../app/features/fleet/runtimes/machine-data.ts';
import { useAccountChanges } from '../../../../../../app/features/fleet/shell/apply-change-panel.tsx';
import { interact, type Mounted, mount as mountView } from '../../../../support/dom.ts';
import { credential, DATA, machine, PROFILES, profile, READS, scripted } from '../account-support.ts';
import { credentialsOf } from './support-b.ts';

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount();
});

/** A DeepSeek key that only OpenCode drives, and the one profile the machine has: pinned to a model set. */
const FRESH_LOGIN: MachineData = {
  ...DATA,
  credentials: credentialsOf(credential({ id: 'deepseek-key', harnesses: ['opencode'], store: 'environment' })),
  runtimes: { ...DATA.runtimes, runtimes: [] },
  profiles: LayeredProfileCatalogSchema.parse({
    ...PROFILES,
    profiles: [profile({ name: 'pinned', layers: ['modelSets/Claude models'], harnesses: [] })],
  }),
};

/** The machine with OpenCode registered, and what the daemon read for this login from OpenCode's own descriptor. */
const withNativeModels = (models: readonly string[]): MachineView =>
  machine({
    tools: [
      { harness: 'claude-code', label: 'Claude Code', installed: true, command: '/usr/local/bin/claude' },
      { harness: 'opencode', label: 'OpenCode', installed: true, command: '/usr/local/bin/opencode' },
    ],
    nativeModels: [{ login: 'deepseek-key', harness: 'opencode', models }],
  });

const mountFor = async (view: MachineView) => {
  const client = scripted(READS(FRESH_LOGIN));
  function Host() {
    const changes = useAccountChanges({ client });
    return (
      <AddRuntime
        data={FRESH_LOGIN}
        reload={async () => FRESH_LOGIN}
        changes={changes}
        machine={view}
        machineName="studio-mac"
        online
        onFinish={() => undefined}
      />
    );
  }
  const mountedView = await mountView(<Host />);
  mounted.push(mountedView);
  await interact(async () => {
    for (let turn = 0; turn < 6; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
  return mountedView;
};

describe('Add runtime: a first runtime on a native login (the daemon’s own eligibility)', () => {
  it('offers the existing profile when its pinned model is one the login offers, with no runtime on the login yet', async () => {
    const view = await mountFor(withNativeModels(['Sonnet 5.5']));
    expect(view.container.querySelector('[data-native-plain-profile]')).toBeNull();
    expect(view.container.querySelector('[data-add-runtime-no-profiles]')).toBeNull();
    expect(view.container.querySelector('[data-add-runtime-profile-select]')?.textContent).toContain('pinned');
  });

  it('offers a plain profile instead when the pinned model is not one the login offers', async () => {
    const view = await mountFor(withNativeModels(['deepseek/deepseek-v4-pro']));
    expect(view.container.querySelector('[data-native-plain-profile]')).not.toBeNull();
    expect(view.container.querySelector('[data-add-runtime-profile-select]')).toBeNull();
  });
});
