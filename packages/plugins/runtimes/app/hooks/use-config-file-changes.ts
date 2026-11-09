/** Re-read one configuration file the moment the kernel says it moved on disk or in state. */

import { useEffect, useRef } from 'react';
import { ConfigChanged } from '@ferretry/kernel/contract';
import type { LiveRuntimesClient } from '../lib/client.ts';

/**
 * Calls `onChange` when the kernel's `kernel.config-changed` frame (over `GET /v1/bus`) names THIS plugin's file at
 * `path` (under `config/`): written, held for the owner, confirmed, discarded, broken or fixed or removed. The frame
 * carries the path, the state and the disk etag — never the text — so the caller reads the file again to see it.
 *
 * It hears what `runtimes.changed` cannot: that event names a profile only when its PARSED value in effect moved, so an
 * edit held for the owner and a newly broken file (the last good version stays in effect) said nothing to an open
 * editor. A client with no `subscribe` hears nothing; a frame for another file or plugin is ignored.
 */
export function useConfigFileChanges(client: LiveRuntimesClient, path: string, onChange: () => void): void {
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    if (client.subscribe === undefined) return;
    return client.subscribe(ConfigChanged, frame => {
      if (frame.plugin === 'runtimes' && frame.path === path) latest.current();
    });
  }, [client, path]);
}
