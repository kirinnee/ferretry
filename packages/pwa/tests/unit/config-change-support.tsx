import type { ConfigChangeKind } from '@ferretry/protocol';
import type { ReactElement } from 'react';
import { DaemonConfigChangeStore } from '../../src/lib/config-changes.ts';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import { type AppStore, StoreProvider } from '../../src/lib/store.tsx';
import { interact } from '../support/dom.ts';

/**
 * A machine whose configuration a test moves by hand: a real change store under a store provider, fed
 * the frames the daemon's configuration stream would send. `wrap` puts a screen inside it; `move` says
 * these kinds moved, exactly as one counted change on the machine would.
 */
export function configChangeHarness(daemonId: DaemonId, extra: Partial<AppStore> = {}) {
  const configChanges = new DaemonConfigChangeStore();
  configChanges.observe(daemonId, { kind: 'config', epoch: 'boot', revision: 0, kinds: [] });
  let revision = 0;
  const store = { ...extra, configChanges } as AppStore;
  return {
    configChanges,
    store,
    wrap: (element: ReactElement): ReactElement => <StoreProvider store={store}>{element}</StoreProvider>,
    move: async (kinds: readonly ConfigChangeKind[]): Promise<void> => {
      revision += 1;
      await interact(() =>
        configChanges.observe(daemonId, { kind: 'config', epoch: 'boot', revision, kinds: [...kinds] }),
      );
    },
  };
}
