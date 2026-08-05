import { describe, expect, it } from 'bun:test';

import type { AccountPickerCatalog } from '../../src/components/picker-catalog.ts';
import { useAccountPickerSlice } from '../../src/hooks/use-account-picker.ts';
import { DaemonAccountPickerStore } from '../../src/lib/account-picker-store.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { mount } from '../support/dom.ts';

const laptop = daemonConnection({
  daemonId: 'daemon/laptop',
  baseUrl: 'https://laptop.example.test',
  deviceToken: 'token-laptop',
});
const workstation = daemonConnection({
  daemonId: 'daemon/workstation',
  baseUrl: 'https://workstation.example.test',
  deviceToken: 'token-workstation',
});

const catalog = (wrapper: string): AccountPickerCatalog => ({
  accounts: [],
  accountsError: wrapper,
  usage: new Map(),
  usageError: null,
  health: new Map(),
  healthError: null,
});

function Status({ store, daemon }: { readonly store: DaemonAccountPickerStore; readonly daemon: typeof laptop }) {
  const slice = useAccountPickerSlice(store, daemon);
  return <output>{`${slice.status}:${slice.catalog?.accountsError ?? slice.error ?? '—'}`}</output>;
}

describe('useAccountPickerSlice', () => {
  it('hydrates the selected daemon and replaces it without leaking the previous roster', async () => {
    const reads: string[] = [];
    const store = new DaemonAccountPickerStore({
      catalog: async daemon => {
        reads.push(daemon.daemonId);
        return catalog(daemon.daemonId);
      },
    });
    const mounted = await mount(<Status store={store} daemon={laptop} />);
    expect(mounted.container.textContent).toBe('ready:daemon/laptop');

    await mounted.render(<Status store={store} daemon={workstation} />);
    expect(mounted.container.textContent).toBe('ready:daemon/workstation');
    expect(reads).toEqual([laptop.daemonId, workstation.daemonId]);
    await mounted.unmount();
  });

  it('renders a failed read as state instead of throwing from the component', async () => {
    const store = new DaemonAccountPickerStore({
      catalog: async () => {
        throw new Error('fleet unavailable');
      },
    });
    const mounted = await mount(<Status store={store} daemon={laptop} />);
    expect(mounted.container.textContent).toBe('error:fleet unavailable');
    await mounted.unmount();
  });
});
