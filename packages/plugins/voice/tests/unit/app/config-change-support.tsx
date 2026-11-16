import type { ReactElement } from 'react';
import {
  type ConfigChanges,
  ConfigChangesProvider,
  StoreProvider,
  type AppStore,
} from '../../../app/lib/voice-store.tsx';
import type { DaemonId } from '../../../app/shell-voice.ts';
import { interact } from '../../support/app/dom.ts';

/** A change feed the shell's configuration stream would normally be: counts, per kind, that a test moves by hand. */
class HandChanges implements ConfigChanges {
  readonly #listeners = new Set<() => void>();
  readonly #counts = new Map<string, number>();

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  counter(_daemonId: DaemonId, kinds: readonly string[]): number {
    return kinds.reduce((total, kind) => total + (this.#counts.get(kind) ?? 0), 0);
  }

  move(kinds: readonly string[]): void {
    for (const kind of kinds) this.#counts.set(kind, (this.#counts.get(kind) ?? 0) + 1);
    for (const listener of [...this.#listeners]) listener();
  }
}

/** A machine whose configuration a test moves by hand: `wrap` puts a screen inside it; `move` says these kinds moved. */
export function configChangeHarness(_daemonId: DaemonId, extra: Partial<AppStore> = {}) {
  const configChanges = new HandChanges();
  const store = { ...extra } as AppStore;
  return {
    configChanges,
    store,
    wrap: (element: ReactElement): ReactElement => (
      <ConfigChangesProvider changes={configChanges}>
        <StoreProvider store={store}>{element}</StoreProvider>
      </ConfigChangesProvider>
    ),
    move: async (kinds: readonly string[]): Promise<void> => {
      await interact(() => configChanges.move(kinds));
    },
  };
}
