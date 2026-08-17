import type { DoctorReport } from '@ferretry/protocol';
import { CircleAlert, CircleCheck, CircleMinus, Stethoscope } from 'lucide-react';
import { useEffect, useState } from 'react';
import { defaultFleetHarness } from '../fleet/fleet-model.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';

export type DoctorReportReader = (connection: DaemonConnection) => Promise<DoctorReport>;

export function DoctorSettings({
  connection,
  read,
}: {
  readonly connection: DaemonConnection;
  readonly read: DoctorReportReader;
}) {
  const [held, setHeld] = useState<{ readonly daemonId: string; readonly report: DoctorReport | null }>({
    daemonId: String(connection.daemonId),
    report: null,
  });
  useEffect(() => {
    let cancelled = false;
    setHeld({ daemonId: String(connection.daemonId), report: null });
    void read(connection).then(
      report => {
        if (!cancelled) setHeld({ daemonId: String(connection.daemonId), report });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [connection, read]);
  const report = held.daemonId === String(connection.daemonId) ? held.report : null;
  if (report === null)
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Doctor report unavailable">
        <h3 className="m-0 text-title font-semibold text-fg">Host checks unavailable</h3>
        <p className="mb-0 mt-1 text-ui leading-base text-muted">
          This daemon did not provide a dependency report. No missing evidence is treated as a healthy host.
        </p>
      </section>
    );
  const preferred = defaultFleetHarness(report.harnesses);
  return (
    <section
      className="kt-panel p-panel"
      aria-labelledby="doctor-settings-heading"
      data-doctor-daemon={String(connection.daemonId)}
    >
      <div className="flex items-center gap-2">
        <Stethoscope size={17} className="text-accent" aria-hidden="true" />
        <h3 id="doctor-settings-heading" className="m-0 text-title font-semibold text-fg">
          Host checks
        </h3>
      </div>
      <p className="mb-3 mt-1 text-ui leading-base text-muted">
        {report.ready
          ? 'Required dependencies are present.'
          : 'A required dependency is missing; sessions will not work yet.'}
        {preferred ? ` ${preferred === 'claude' ? 'Claude' : 'Codex'} is the preferred ready harness.` : ''}
      </p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Host dependency checks">
        {report.checks.map(check => {
          const Icon =
            check.status === 'present' ? CircleCheck : check.status === 'missing' ? CircleAlert : CircleMinus;
          const tone = check.status === 'missing' ? 'text-err' : check.status === 'present' ? 'text-ok' : 'text-muted';
          return (
            // `border-strong`, not `border-soft`: this row sits on `surface-2`, where the soft hairline
            // is invisible and the list reads as one undifferentiated block.
            <li key={check.name} className="rounded-control border border-border-strong bg-surface-2 px-3 py-2">
              <div className={`flex min-w-0 flex-wrap items-center gap-2 text-ui font-semibold ${tone}`}>
                <Icon size={15} className="shrink-0" aria-hidden="true" /> {check.name}
                <span className="ml-auto text-meta font-normal text-faint">{check.requirement}</span>
              </div>
              {/* `break-words` because a summary now carries an absolute path — `/opt/homebrew/bin/claude`
                  is one unbreakable token, and at 390px an unbroken one scrolls the whole page sideways. */}
              <p className="mb-0 mt-1 break-words text-meta leading-base text-muted">
                {check.summary}. {check.impact}
              </p>
            </li>
          );
        })}
      </ul>
      <p className="mb-0 mt-3 text-meta leading-base text-faint">{report.limitation}</p>
    </section>
  );
}
