/**
 * SETTINGS › DOCTOR: the daemon's host checks (today's `DoctorSettings`, headed "Host checks" there; here "Doctor", so it is
 * not the tab beside it), read from `GET /v1/doctor` — the SAME report
 * `fy doctor` prints, so the two can never disagree about what is wrong. A daemon that did not answer says so; no
 * missing evidence is treated as a healthy host. The report never carries a secret and never claims a harness is signed
 * in (its `limitation` says so, last).
 */
import { CircleAlert, CircleCheck, CircleMinus, Stethoscope } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type DoctorReport, DoctorReportSchema, notBuiltCheck } from '../../contract/doctor.ts';
import { SettingGroup, SettingRow } from '@ferretry/app';
import { Loading } from '@ferretry/app/ui';
import type { KernelClient } from '../lib/client.ts';

type Held =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly report: DoctorReport }
  | { readonly status: 'unavailable' };

/** The headline: whether a required dependency is missing. */
export const doctorHeadline = (report: DoctorReport): string =>
  report.ready ? 'Required dependencies are present.' : 'A required dependency is missing; sessions will not work yet.';

/** A sentence's text without its last full stop, so "summary. impact" never doubles the stop. */
const withoutFinalStop = (text: string): string => text.replace(/\.+$/u, '');

/** The report, drawn from plain values so every state can be rendered without a daemon. */
export function DoctorReportView({ report }: { readonly report: DoctorReport }) {
  // Checks a plugin declared and nobody has built yet all say the same sentence: they are one line, not a wall of rows
  // that reads like failures on a healthy host (the same grouping `fy doctor` makes).
  // Only an OPTIONAL check that is missing may fold (the CLI's 'warn'): a required or failing one is never hidden.
  const unbuiltName = (check: DoctorReport['checks'][number]): string | undefined =>
    check.status === 'missing' && check.requirement !== 'required' ? notBuiltCheck(check.summary) : undefined;
  const unbuilt = report.checks.flatMap(check => {
    const name = unbuiltName(check);
    return name === undefined ? [] : [name];
  });
  const checks = report.checks.filter(check => unbuiltName(check) === undefined);
  return (
    <section className="flex min-w-0 flex-col" aria-labelledby="doctor-settings-heading" data-doctor-report="">
      <div className="mb-6 flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-2">
          <Stethoscope size={17} className="text-accent" aria-hidden="true" />
          <h3 id="doctor-settings-heading" className="m-0 text-row font-semibold text-fg">
            Doctor
          </h3>
        </div>
        <p className="m-0 text-cell leading-base text-muted" data-doctor-headline="">
          {doctorHeadline(report)}
        </p>
      </div>
      <SettingGroup label="Host dependency checks">
        {checks.map(check => {
          const Icon =
            check.status === 'present' ? CircleCheck : check.status === 'missing' ? CircleAlert : CircleMinus;
          const tone = check.status === 'missing' ? 'text-err' : check.status === 'present' ? 'text-ok' : 'text-muted';
          return (
            <SettingRow
              key={check.name}
              name={check.name}
              // What a miss breaks is said only where there is a miss: a row that passes, or does not apply here, says
              // what it found, once. The whole sentence is the title; the (i) holds the consequence.
              hint={check.status === 'missing' ? `${withoutFinalStop(check.summary)}. ${check.impact}` : check.summary}
              dataAttributes={{ 'data-doctor-check': check.name, 'data-doctor-status': check.status }}
              control={() => (
                <span className={`inline-flex min-w-0 items-center gap-1.5 text-meta font-semibold ${tone}`}>
                  <Icon size={15} className="shrink-0" aria-hidden="true" />
                  <span className="font-normal text-faint">{check.requirement}</span>
                </span>
              )}
            />
          );
        })}
      </SettingGroup>
      {unbuilt.length === 0 ? null : (
        <details className="text-meta leading-base text-muted" data-doctor-unbuilt="">
          <summary className="min-h-[44px] cursor-pointer py-3 text-faint">
            {unbuilt.length} {unbuilt.length === 1 ? 'check is' : 'checks are'} not built yet in this build, so nothing
            was checked
          </summary>
          <p className="mb-0 mt-1 break-words">{unbuilt.join(', ')}</p>
        </details>
      )}
      <p className="m-0 text-meta leading-base text-faint">{report.limitation}</p>
    </section>
  );
}

export function DoctorSettings({ client }: { readonly client: KernelClient }) {
  const [held, setHeld] = useState<Held>({ status: 'loading' });
  const [reads, setReads] = useState(0);
  // Set by the "Try again" press and spent by the read it causes: that read is the person's own, so it may ask for the
  // passkey again after a Cancel; the page's own read never does (A555 r7).
  const pressed = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `reads` is the re-read trigger
  useEffect(() => {
    let current = true;
    const press = pressed.current;
    pressed.current = false;
    client.call('GET /v1/doctor', press ? { quiet: false } : {}).then(
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
  const again = useCallback(() => {
    pressed.current = true;
    setReads(count => count + 1);
  }, []);
  if (held.status === 'ready') return <DoctorReportView report={held.report} />;
  if (held.status === 'loading') return <Loading kind="page" label="Reading the host checks…" />;
  return (
    <section className="kt-panel p-panel" role="status" aria-label="Doctor report unavailable">
      <h3 className="m-0 text-row font-semibold text-fg">Doctor unavailable</h3>
      <p className="mb-0 mt-1 text-cell leading-base text-muted">
        This daemon did not provide a dependency report. No missing evidence is treated as a healthy host.
      </p>
      <button type="button" className="kt-btn mt-2 min-h-[44px]" data-doctor-retry="" onClick={again}>
        Try again
      </button>
    </section>
  );
}
