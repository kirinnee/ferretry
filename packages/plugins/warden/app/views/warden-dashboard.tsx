/**
 * The Warden's two rows on the ferrets dashboard (today's `session-dashboard.tsx`), as `daemon.status` panels: the
 * pack-health strip and the recent verdicts, each bound to the daemon the dashboard is on, with the report dialog the
 * verdicts open.
 */

import type { PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { WardenReportDialog, type WardenReportDialogRequest } from '../features/warden/warden-report-dialog.tsx';
import { WardenStrip } from '../features/warden/warden-strip.tsx';
import { WardenVerdicts } from '../features/warden/warden-verdicts.tsx';
import { useWardenStatus } from '../hooks/use-warden-status.ts';
import { useCurrentDaemon } from '../hooks/use-warden-daemons.ts';
import type { DaemonConnection } from '../lib/machine.ts';
import { homeClientFactory } from '../lib/warden-clients.ts';
import type { WardenVerdict } from '../wire.ts';

export function createWardenStripPanel(client: PluginClient) {
  return function WardenStripPanel(_props: PanelProps) {
    const connection = useCurrentDaemon(client);
    const factory = useMemo(() => homeClientFactory(client), []);
    const read = useCallback(async (daemon: DaemonConnection) => await (await factory(daemon)).status(), [factory]);
    return <WardenStrip status={useWardenStatus(connection, read)} />;
  };
}

export function createWardenVerdictsPanel(client: PluginClient) {
  return function WardenVerdictsPanel(_props: PanelProps) {
    const connection = useCurrentDaemon(client);
    const factory = useMemo(() => homeClientFactory(client), []);
    const [verdicts, setVerdicts] = useState<readonly WardenVerdict[]>([]);
    const [report, setReport] = useState<WardenReportDialogRequest | null>(null);
    useEffect(() => {
      let current = true;
      void factory(connection)
        .then(async warden => await warden.verdicts())
        .then(
          read => {
            if (current) setVerdicts(read);
          },
          () => undefined,
        );
      return () => {
        current = false;
      };
    }, [connection, factory]);
    const readReport = useCallback(
      async (daemon: DaemonConnection, reportPath: string) => await (await factory(daemon)).report(reportPath),
      [factory],
    );
    return (
      <>
        <WardenVerdicts connection={connection} verdicts={verdicts} onOpenReport={setReport} />
        <WardenReportDialog request={report} read={readReport} onClose={() => setReport(null)} />
      </>
    );
  };
}
