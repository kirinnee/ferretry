/**
 * The runtime picker the composer shows above its input (`composer.tools` › `runtime-picker`): the model and the
 * reasoning-level switches of the ferret the panel is shown for. The ferret is the panel's `subject`.
 */

import type { AppComponent, PanelProps } from '@ferretry/kernel/manifest';
import { useEffect, useMemo, useState } from 'react';
import { RuntimeEffortControls, RuntimeModelControls } from '../components/runtime-controls.tsx';
import type { RuntimesClient } from '../lib/client.ts';
import { DaemonRuntimeModelCatalogStore } from '../lib/runtime-models.ts';
import { readRuntimeSessionView, runtimeControlApi } from '../lib/runtime-switch.ts';
import type { RuntimeSessionView } from '../lib/session-view.ts';

const noop = (): void => undefined;

export const createRuntimePicker = (client: RuntimesClient): AppComponent<PanelProps> => {
  const api = runtimeControlApi(client);
  const store = new DaemonRuntimeModelCatalogStore();
  const catalogs = { load: (sessionId: string) => store.load(client, sessionId) };
  return function RuntimePicker({ subject }: PanelProps) {
    const [view, setView] = useState<RuntimeSessionView | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    useEffect(() => {
      if (subject === undefined) return;
      let live = true;
      setView(null);
      setFailure(null);
      readRuntimeSessionView(client, subject).then(
        read => {
          if (live) setView(read);
        },
        cause => {
          if (live) setFailure(cause instanceof Error ? cause.message : String(cause));
        },
      );
      return () => {
        live = false;
      };
    }, [subject]);
    const common = useMemo(() => ({ api, catalogs, canControl: true, onClose: noop }), []);
    if (subject === undefined) return null;
    if (failure !== null) return <p role="alert">{failure}</p>;
    if (view === null) return null;
    return (
      <div data-runtime-picker={subject}>
        <RuntimeModelControls {...common} open presentation="popover" view={view} />
        <RuntimeEffortControls {...common} presentation="popover" view={view} />
      </div>
    );
  };
};
