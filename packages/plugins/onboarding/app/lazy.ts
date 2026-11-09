/**
 * A component that loads its module on first use, written without React so the half stays loadable by anything that
 * only inspects it (the registry generator, `manifest-match`) before the app shell, which owns React, is in place.
 *
 * The first call starts the load and SUSPENDS by throwing the loading promise, which is the protocol a React
 * `<Suspense>` boundary understands; the shell wraps every plugin view in one (S10), so only this plugin's own box
 * shows "Loading Onboarding…" until the chunk arrives. A load that fails throws the failure for the shell's error
 * boundary.
 */

import type { AppComponent } from '@ferretry/kernel/manifest';

export function lazyComponent<Props>(load: () => Promise<AppComponent<Props>>): AppComponent<Props> {
  let loaded: AppComponent<Props> | undefined;
  let failure: { readonly error: unknown } | undefined;
  let loading: Promise<void> | undefined;
  return props => {
    if (failure !== undefined) throw failure.error;
    if (loaded !== undefined) return loaded(props);
    loading ??= load().then(
      component => {
        loaded = component;
      },
      error => {
        failure = { error };
      },
    );
    throw loading;
  };
}
