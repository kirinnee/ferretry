import { useCallback, useEffect, useState } from 'react';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { type ScratchPlanView, type ScratchSweepView, SCRATCH_PATH } from '../contract/index.ts';
import { TidyView } from './view.tsx';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Settings › Tidy: reads the plan once, and clears on the owner's word (a sweep that ignores the automatic switch). */
export function tidySettings(client: PluginClient) {
  return function TidySettings() {
    const [plan, setPlan] = useState<readonly ScratchPlanView[] | undefined>(undefined);
    const [error, setError] = useState<string | undefined>(undefined);
    const [sweeping, setSweeping] = useState(false);
    const [last, setLast] = useState<ScratchSweepView | undefined>(undefined);

    const read = useCallback(async () => {
      try {
        setPlan(await client.call<readonly ScratchPlanView[]>(`GET ${SCRATCH_PATH}`));
        setError(undefined);
      } catch (cause) {
        setError(messageOf(cause));
      }
    }, []);
    useEffect(() => void read(), [read]);

    const sweep = useCallback(async () => {
      setSweeping(true);
      try {
        setLast(await client.call<ScratchSweepView>(`POST ${SCRATCH_PATH}`, { body: { force: true } }));
        await read();
      } catch (cause) {
        setError(messageOf(cause));
      } finally {
        setSweeping(false);
      }
    }, [read]);

    return <TidyView plan={plan} error={error} sweeping={sweeping} last={last} onSweep={() => void sweep()} />;
  };
}
