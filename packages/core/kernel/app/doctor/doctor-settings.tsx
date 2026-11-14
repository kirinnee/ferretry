/**
 * SETTINGS › DOCTOR: the daemon's host checks (today's `DoctorSettings`, headed "Host checks" there; here "Doctor", so it is
 * not the tab beside it), read from `GET /v1/doctor` — the SAME report
 * `fy doctor` prints, so the two can never disagree about what is wrong. A daemon that did not answer says so; no
 * missing evidence is treated as a healthy host. The report never carries a secret and never claims a harness is signed
 * in (its `limitation` says so, last).
 */
import { CircleAlert, CircleCheck, CircleMinus, Stethoscope } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { type DoctorReport, DoctorReportSchema } from '../../contract/doctor.ts';
import type { KernelClient } from '../lib/client.ts';

type Held =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly report: DoctorReport }
  | { readonly status: 'unavailable' };

/** The headline: whether a required dependency is missing. */
export const doctorHeadline = (report: DoctorReport): string =>
  report.ready ? 'Required dependencies are present.' : 'A required dependency is missing; sessions will not work yet.';

/** The report, drawn from plain values so every state can be rendered without a daemon. */
export function DoctorReportView({ report }: { readonly report: DoctorReport }) {
  return (
    <section className="kt-panel p-panel" aria-labelledby="doctor-settings-heading" data-doctor-report="">
      <div className="flex items-center gap-2">
        <Stethoscope size={17} className="text-accent" aria-hidden="true" />
        <h3 id="doctor-settings-heading" className="m-0 text-row font-semibold text-fg">
          Doctor
        </h3>
      </div>
      <p className="mb-3 mt-1 text-cell leading-base text-muted" data-doctor-headline="">
        {doctorHeadline(report)}
      </p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Host dependency checks">
        {report.checks.map(check => {
          const Icon =
            check.status === 'present' ? CircleCheck : check.status === 'missing' ? CircleAlert : CircleMinus;
          const tone = check.status === 'missing' ? 'text-err' : check.status === 'present' ? 'text-ok' : 'text-muted';
          return (
            // `border-strong`, not `border-soft`: this row sits on `surface-2`, where the soft hairline is invisible.
            <li
              key={check.name}
              className="rounded-control border border-border-strong bg-surface-2 px-3 py-2"
              data-doctor-check={check.name}
              data-doctor-status={check.status}
            >
              <div className={`flex min-w-0 flex-wrap items-center gap-2 text-ui font-semibold ${tone}`}>
                <Icon size={15} className="shrink-0" aria-hidden="true" /> {check.name}
                <span className="ml-auto text-meta font-normal text-faint">{check.requirement}</span>
              </div>
              {/* `break-words`: a summary can carry an absolute path, one unbreakable token that would scroll a phone sideways. */}
              <p className="mb-0 mt-1 break-words text-meta leading-base text-muted">
                {/* What a miss breaks is said only where there is a miss: a row that passes, or does not apply here, says
                    what it found, once. */}
                {check.status === 'missing' ? `${check.summary}. ${check.impact}` : check.summary}
              </p>
            </li>
          );
        })}
      </ul>
      <p className="mb-0 mt-3 text-meta leading-base text-faint">{report.limitation}</p>
    </section>
  );
}

export function DoctorSettings({ client }: { readonly client: KernelClient }) {
  const [held, setHeld] = useState<Held>({ status: 'loading' });
  const [reads, setReads] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `reads` is the re-read trigger
  useEffect(() => {
    let current = true;
    client.call('GET /v1/doctor').then(
      body => {
        const parsed = DoctorReportSchema.safeParse(body);
        if (current) setHeld(parsed.success ? { status: 'ready', report: parsed.data } : { status: 'unavailable' });
      },
      () => {
        if (current) setHeld({ status: 'unavailable' });
      },
    );
    return () => {
      current = false;
    };
  }, [client, reads]);
  const again = useCallback(() => setReads(count => count + 1), []);
  if (held.status === 'ready') return <DoctorReportView report={held.report} />;
  return (
    <section className="kt-panel p-panel" role="status" aria-label="Doctor report unavailable">
      <h3 className="m-0 text-row font-semibold text-fg">
        {held.status === 'loading' ? 'Reading the host checks…' : 'Doctor unavailable'}
      </h3>
      {held.status === 'unavailable' ? (
        <>
          <p className="mb-0 mt-1 text-cell leading-base text-muted">
            This daemon did not provide a dependency report. No missing evidence is treated as a healthy host.
          </p>
          <button type="button" className="kt-btn mt-2 min-h-[44px]" data-doctor-retry="" onClick={again}>
            Try again
          </button>
        </>
      ) : null}
    </section>
  );
}
