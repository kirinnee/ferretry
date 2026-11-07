/**
 * Run `reread` when this page comes back into view after being hidden.
 *
 * The shell offers a half no stream of configuration changes yet, so the Warden's settings card cannot hear another
 * editor (the CLI, a file edit, a confirmed held change in another tab) while it is open. What it can do is look
 * again when the owner returns to the tab, which is when they would otherwise be reading a stale card. The card
 * also reads on mount and after its own save. The daemon id and kinds are the parameters of the stream this stands in
 * for; this stand-in does not use them.
 */

import { useDocumentVisible } from '@ferretry/app';
import { useEffect, useRef } from 'react';

export function useConfigChangeEffect(_daemonId: string, _kinds: readonly string[], reread: () => void): void {
  const visible = useDocumentVisible();
  const latest = useRef(reread);
  latest.current = reread;
  const wasVisible = useRef(visible);
  useEffect(() => {
    const returned = visible && !wasVisible.current;
    wasVisible.current = visible;
    if (returned) latest.current();
  }, [visible]);
}
