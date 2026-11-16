/** Re-read when this machine says its runtimes, profiles, model sets or logins moved. */

import { useEffect, useRef } from 'react';
import { LoginChanged } from '@ferretry/plugin-logins/contract';
import { RuntimesChanged, RuntimesDefaultChanged } from '../../contract/index.ts';
import type { LiveRuntimesClient } from '../lib/client.ts';

/**
 * Calls `onChange` the moment the machine says what a catalogue screen shows moved — from another device, `fy`, a
 * hand edit or a sign-in that finished on its own — and never on a timer. A client with no `subscribe` hears nothing.
 *
 * `kinds` narrows it: `runtimes` (runtimes and their default), `catalogue` (profiles and model sets) and `logins`.
 */
export type MachineChangeKind = 'runtimes' | 'catalogue' | 'logins';

export function useMachineChanges(
  client: LiveRuntimesClient,
  kinds: readonly MachineChangeKind[],
  onChange: () => void,
): void {
  const latest = useRef(onChange);
  latest.current = onChange;
  const key = kinds.join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the kinds' identity
  useEffect(() => {
    if (client.subscribe === undefined) return;
    const fire = (): void => latest.current();
    const stops = [
      client.subscribe(RuntimesChanged, changed => {
        const wants =
          (kinds.includes('runtimes') && changed.runtimes.length > 0) ||
          (kinds.includes('catalogue') && (changed.profiles.length > 0 || changed.modelSets.length > 0));
        if (wants) fire();
      }),
    ];
    if (kinds.includes('runtimes')) stops.push(client.subscribe(RuntimesDefaultChanged, fire));
    if (kinds.includes('logins')) stops.push(client.subscribe(LoginChanged, fire));
    return () => {
      for (const stop of stops) stop();
    };
  }, [client, key]);
}
