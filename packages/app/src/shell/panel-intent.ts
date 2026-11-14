/**
 * A PANEL ANSWERS A REQUEST FROM ITS HOST (`PanelIntent`, `@ferretry/kernel/manifest`): the ferret page's "+" asks the
 * Terminals panel for a new terminal and the Browser panel for a new page, and neither the page nor the panel imports the
 * other. The panel acts once per request id, on the action it owns, and never on the request it mounted with (a panel that
 * remounts while an old request is still held must not start a second terminal).
 */

import type { PanelIntent } from '@ferretry/kernel/manifest';
import { useEffect, useRef } from 'react';

export function usePanelIntent(intent: PanelIntent | undefined, action: string, run: () => void): void {
  const handled = useRef<number | undefined>(intent?.id);
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    if (intent === undefined || intent.id === handled.current) return;
    handled.current = intent.id;
    if (intent.action === action) latest.current();
  }, [intent, action]);
}
