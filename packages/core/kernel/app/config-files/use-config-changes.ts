import { useEffect, useRef } from 'react';
import { ConfigChanged } from '../../contract/index.ts';
import type { KernelClient } from '../lib/client.ts';

/**
 * Calls `onChange` when the kernel's `kernel.config-changed` frame (over the kernel's event bus socket) says a declared
 * file moved: written, held for the owner, confirmed, discarded, broken, fixed or removed. The frame carries the path,
 * the state and the disk etag — never the text — so the caller reads again to see it. With `path`, only that file's
 * frames count. A client with no `subscribe` hears nothing (a screen under test).
 */
export function useConfigChanges(client: KernelClient, onChange: () => void, path?: string): void {
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    if (client.subscribe === undefined) return;
    return client.subscribe(ConfigChanged, frame => {
      if (path === undefined || frame.path === path) latest.current();
    });
  }, [client, path]);
}
