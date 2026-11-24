/**
 * WHETHER THE MACHINE HAS A RUNTIME THAT CAN START, for the closing summary. The Runtimes row of the summary is the "Start fresh or copy"
 * page (`runtimes.start`), and that page is answered by choosing, whatever came of it: a tool whose sign-in was left for
 * later ends with "No runtime was made", and the row must not tick then. So the end of the run asks the machine's own
 * runtime list (the same read the "<Tool> is ready" pages make) and a machine with none, or none that can start (every
 * one answers `launch.available: false`), shows the row as left for later.
 * A read that fails changes nothing: the summary then says only what the pages answered.
 */
import type { PluginClient } from '@ferretry/kernel/manifest';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import type { SummaryStep } from '../../views/steps-screen.tsx';

/** The plugin whose pages make the Runtimes row. */
const RUNTIMES_PLUGIN = 'runtimes';

/** reading: asked, not answered · made: at least one runtime can start · none: no runtime can start · unread: the read failed. */
export type RuntimesRead = 'reading' | 'made' | 'none' | 'unread';

const RuntimeListSchema = z.object({ runtimes: z.array(z.object({ launch: z.object({ available: z.boolean() }) })) });

/** Reads the machine's runtimes once `active` (the run reached its end); asked again for a new run. */
export function useRuntimesRead(client: Pick<PluginClient, 'call'> | undefined, active: boolean): RuntimesRead {
  const [read, setRead] = useState<RuntimesRead>('reading');
  useEffect(() => {
    if (!active || client === undefined) {
      setRead('reading');
      return;
    }
    let live = true;
    client.call('GET /v1/runtimes', { quiet: true }).then(
      answer => {
        const parsed = RuntimeListSchema.safeParse(answer);
        if (live)
          setRead(
            parsed.success
              ? parsed.data.runtimes.some(runtime => runtime.launch.available)
                ? 'made'
                : 'none'
              : 'unread',
          );
      },
      () => live && setRead('unread'),
    );
    return () => {
      live = false;
    };
  }, [client, active]);
  return read;
}

/**
 * The summary as the machine's runtimes leave it: with none made, Runtimes' set-up pages count as left for later; while the
 * read is out they are pending (the summary waits for the answer, so a tick never shows and then goes).
 */
export const withRuntimesRead = (summary: readonly SummaryStep[], read: RuntimesRead): readonly SummaryStep[] =>
  read === 'made' || read === 'unread'
    ? summary
    : summary.map(step =>
        step.plugin === RUNTIMES_PLUGIN && (step.state === 'done' || step.state === 'found')
          ? { ...step, state: read === 'none' ? 'later' : 'pending' }
          : step,
      );
