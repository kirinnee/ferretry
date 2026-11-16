/** The `behind` notice on the daemon-status panel: shown only while this daemon is older than the newest release. */

import type { AppComponent, PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { useEffect, useState } from 'react';
import { type DaemonUpdateView, DaemonUpdateViewSchema } from '../../contract/index.ts';
import { behindSentence } from '../lib/behind.ts';

export const createPanel = (client: PluginClient): AppComponent<PanelProps> =>
  function BehindPanel() {
    const [view, setView] = useState<DaemonUpdateView | null>(null);
    useEffect(() => {
      client
        .call('GET /v1/daemon/update')
        .then(raw => setView(DaemonUpdateViewSchema.parse(raw)))
        .catch(() => setView(null));
    }, []);
    const sentence = view === null ? undefined : behindSentence(view);
    return sentence === undefined ? null : <p role="status">{sentence}</p>;
  };
