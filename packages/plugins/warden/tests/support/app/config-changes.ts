/**
 * A machine whose configuration a test moves by hand: the hook the Warden card listens with, and `move`, which says
 * these kinds moved on a daemon exactly as one counted change on the machine would.
 */

import { useEffect, useRef } from 'react';
import { interact } from '@ferretry/app/testing';

interface Listener {
  readonly daemonId: string;
  readonly kinds: readonly string[];
  readonly run: () => void;
}

export function configChangeHarness(daemonId: string) {
  const listeners = new Set<Listener>();
  const useConfigChange = (id: string, kinds: readonly string[], onChange: () => void): void => {
    const latest = useRef(onChange);
    latest.current = onChange;
    useEffect(() => {
      const listener: Listener = { daemonId: id, kinds, run: () => latest.current() };
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }, [id, kinds]);
  };
  return {
    useConfigChange,
    move: async (kinds: readonly string[], on: string = daemonId): Promise<void> => {
      await interact(() => {
        for (const listener of [...listeners])
          if (listener.daemonId === on && listener.kinds.some(kind => kinds.includes(kind))) listener.run();
      });
    },
  };
}
